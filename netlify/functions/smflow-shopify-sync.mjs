import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-shopify-sync.mjs
// POST { action: 'sync', tenant_id }   → pull all collections + products
// GET  ?action=status&tenant_id=       → connection/sync status for Settings
//
// Unlike Drive sync, Shopify's CDN URLs are public, stable, and don't need
// CORS-driven re-hosting into Supabase Storage — we store the URL directly
// in smflow_shopify_products.image_url and reference it from there. This
// keeps storage cost proportional to what's actually used in content, not
// "every photo of every product in the catalog," which was a real concern
// raised earlier when this feature was first being scoped.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function sb(path, options = {}) {
  const url    = `${SUPABASE_URL}/rest/v1/${path}`;
  const method = options.method || 'GET';
  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        options.prefer || (method === 'GET' ? '' : 'return=representation'),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

// This exact query was validated against Shopify's live GraphQL schema
// and test-run against a real connected store before this function was
// written — including discovering the real, current replacement for the
// deprecated Product.featuredImage field, and the real null-image edge
// case (a product with no photo at all returns featuredMedia: null, not
// an empty object).
const COLLECTIONS_QUERY = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          productsCount { count }
          image { url altText }
          updatedAt
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCTS_QUERY = `
  query GetCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            featuredMedia { preview { image { url } } }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            variantsCount { count }
            status
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

async function shopifyGraphQL(shopDomain, accessToken, query, variables) {
  const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  // A 401/expired-token response from Shopify still comes back as JSON
  // without a GraphQL "errors" array in some cases — checking res.ok
  // separately catches that, so an expired/revoked token surfaces as a
  // clear error instead of silently returning no data.
  if (!res.ok) {
    throw new Error(`Shopify API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data.data;
}

// Netlify's synchronous function limit is 60 seconds. Rather than convert
// this to a Background Function (which changes the response contract —
// background functions return an empty 202 immediately and the actual
// result has to be delivered somewhere else, which is a bigger redesign),
// this stays a normal synchronous function but processes work in
// time-bounded batches. Each call does as much as it safely can within
// TIME_BUDGET_MS, then returns a resume cursor — the caller (the Settings
// UI) loops, calling again with that cursor, until done:true. This was
// discovered to be necessary after a real catalog (100+ products in a
// single collection) caused an actual 504 Inactivity Timeout in
// production — not a theoretical concern.
// Netlify's documented Pro-plan synchronous limit is 60 seconds, but
// direct, timed test calls against the real live deployment measured an
// actual cutoff close to 30 seconds, AND a real batch with an 18-second
// internal budget still took 36.4 seconds wall-clock to return — meaning
// the gap between "when we stop fetching from Shopify" and "when the
// response actually leaves this function" is itself substantial (likely
// from the sequential check-then-write Supabase pattern: every single
// product does a SELECT followed by an INSERT or PATCH, each a real
// network round-trip, and those happen AFTER the last timeIsUp() check
// for that page). Cut hard, to a fraction of the measured real ceiling,
// rather than trust either the documented limit or the first "fix."
const TIME_BUDGET_MS = 8000;

async function syncCollectionsAndProducts(tenantId, shopDomain, accessToken, resumeCursor) {
  const startedAt = Date.now();
  const timeIsUp = () => (Date.now() - startedAt) > TIME_BUDGET_MS;

  let collectionsSynced = 0;
  let productsSynced    = 0;

  // resumeCursor carries us back to exactly where the previous call left
  // off: which page of collections we were on, and — if we stopped in the
  // middle of a large collection's product list — which collection and
  // which product-page cursor to resume from.
  let after          = resumeCursor?.collectionsAfter || null;
  let resumeInCollection = resumeCursor?.inProgressCollectionId || null;
  let resumeProductAfter = resumeCursor?.productsAfter || null;
  // Real bug found and fixed here: this MUST be the set of every
  // collection ID already fully completed within the CURRENT page, not
  // just "the one collection we paused inside of." The original code only
  // skipped a single matching ID, so any batch that paused with
  // inProgressCollectionId: null (finished collection N, ran out of time
  // before starting N+1) caused the next call to re-fetch the same page
  // and restart from collection #1 — an infinite loop that silently
  // reprocessed the same handful of collections forever while the
  // products_synced counter kept climbing on pure re-upserts, never
  // advancing to the rest of the real catalog. Confirmed live: a real
  // sync reported 500+ "products synced" while the database never grew
  // past the first 125 rows from the first 4 collections.
  const completedInThisPage = new Set(resumeCursor?.completedCollectionIds || []);

  do {
    const data = await shopifyGraphQL(shopDomain, accessToken, COLLECTIONS_QUERY, { first: 50, after });
    const edges = data.collections.edges;

    for (const { node: col } of edges) {
      const shopifyCollectionId = col.id;

      // Skip any collection already fully finished earlier in this same
      // page (whether in this call or a previous one we're resuming
      // from) — except the one we're explicitly resuming mid-product-page
      // into, which needs to continue rather than be skipped.
      if (shopifyCollectionId !== resumeInCollection && completedInThisPage.has(shopifyCollectionId)) {
        continue;
      }

      const collectionPayload = {
        tenant_id:             tenantId,
        shopify_collection_id: shopifyCollectionId,
        title:                 col.title,
        handle:                col.handle,
        image_url:             col.image?.url || null,
        product_count:         col.productsCount?.count || 0,
        last_synced_at:        new Date().toISOString(),
        updated_at:            new Date().toISOString(),
      };

      // True single-call upsert via on_conflict + merge-duplicates, instead
      // of a SELECT-then-INSERT-or-PATCH. The two-call pattern was a real,
      // measured contributor to this function blowing past its time
      // budget on a live catalog — every row was costing two sequential
      // network round-trips to Supabase instead of one.
      const upserted = await sb(
        `smflow_shopify_collections?on_conflict=tenant_id,shopify_collection_id`,
        { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: { ...collectionPayload, created_at: new Date().toISOString() } }
      );
      const collectionRowId = upserted[0].id;
      if (!resumeInCollection) collectionsSynced++; // don't double-count a collection we're resuming into

      // Pull every product in this collection, paginated. If we're
      // resuming mid-collection, start from where we left off instead of
      // page 1 — otherwise this would re-fetch (though not re-insert,
      // since upserts are idempotent) products we already have.
      let productAfter = (shopifyCollectionId === resumeInCollection) ? resumeProductAfter : null;
      resumeInCollection = null; // only the first matched collection resumes mid-page; clear so subsequent collections start fresh
      resumeProductAfter = null;

      do {
        const prodData = await shopifyGraphQL(shopDomain, accessToken, PRODUCTS_QUERY, { id: shopifyCollectionId, first: 50, after: productAfter });
        const prodEdges = prodData.collection?.products?.edges || [];

        for (const { node: prod } of prodEdges) {
          const imageUrl = prod.featuredMedia?.preview?.image?.url || null;
          const price    = prod.priceRangeV2?.minVariantPrice?.amount || null;
          const currency = prod.priceRangeV2?.minVariantPrice?.currencyCode || null;

          const productPayload = {
            tenant_id:           tenantId,
            collection_id:       collectionRowId,
            shopify_product_id:  prod.id,
            title:               prod.title,
            image_url:           imageUrl,
            price:               price,
            currency:            currency,
            variant_count:       prod.variantsCount?.count || 1,
            is_active:           prod.status === 'ACTIVE',
            last_synced_at:      new Date().toISOString(),
            updated_at:          new Date().toISOString(),
          };

          // Single-call upsert, same reasoning as the collection upsert
          // above — this is the higher-volume of the two (125 products vs
          // 4 collections in the real catalog this was tested against),
          // so it's the bigger share of the real, measured time savings.
          // return=representation here (not =minimal) because the row's
          // own id is needed immediately below to link the promoted
          // smflow_assets row back to it.
          const upsertedProduct = await sb(
            `smflow_shopify_products?on_conflict=tenant_id,shopify_product_id`,
            { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: { ...productPayload, created_at: new Date().toISOString() } }
          );
          productsSynced++;

          // Auto-promote every synced product with a real photo into the
          // shared Photo Library (smflow_assets), per the agreed design:
          // every synced product appears there automatically, organized
          // by collection, rather than requiring a separate manual step.
          // Products with no image at all (a real, confirmed edge case —
          // see the null-image handling note above) are skipped here,
          // since smflow_assets.file_url is NOT NULL — there's nothing
          // meaningful to show in a photo library for a product with no
          // photo.
          if (imageUrl) {
            const productRowId = upsertedProduct[0].id;
            await sb(
              `smflow_assets?on_conflict=tenant_id,shopify_product_id`,
              {
                method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
                body: {
                  tenant_id:           tenantId,
                  source:              'shopify',
                  shopify_product_id:  productRowId,
                  file_url:            imageUrl,
                  file_name:           prod.title,
                  caption_suggestion:  prod.title,
                  topic_tags:          [],
                  flavor_tags:         [],
                  platform_tags:       [],
                  is_active:           true,
                  is_ai_generated:     false,
                  usage_count:         0,
                  updated_at:          new Date().toISOString(),
                },
              }
            );
          }
        }

        productAfter = prodData.collection?.products?.pageInfo?.hasNextPage
          ? prodData.collection.products.pageInfo.endCursor
          : null;

        // Check the time budget after every page of products, not just
        // between collections — a single 100+ product collection can
        // itself take multiple pages and multiple round-trips, which is
        // exactly the scenario that caused the real timeout this batching
        // exists to fix.
        if (productAfter && timeIsUp()) {
          return {
            done: false, collectionsSynced, productsSynced,
            cursor: { collectionsAfter: after, inProgressCollectionId: shopifyCollectionId, productsAfter: productAfter, completedCollectionIds: [...completedInThisPage] },
          };
        }
      } while (productAfter);

      // This collection's entire product list is now done — record it so
      // a subsequent resume within this same page correctly skips it
      // instead of reprocessing it. This is the line that was missing
      // entirely before the fix above.
      completedInThisPage.add(shopifyCollectionId);

      if (timeIsUp()) {
        return {
          done: false, collectionsSynced, productsSynced,
          cursor: { collectionsAfter: after, inProgressCollectionId: null, productsAfter: null, completedCollectionIds: [...completedInThisPage] },
        };
      }
    }

    // The whole page is now fully done — clear the per-page completed-set
    // before moving to a genuinely new page of collections, since IDs
    // from a previous page are irrelevant (and Shopify's collection IDs
    // are globally unique anyway, but this keeps the set from growing
    // unboundedly across a sync with hundreds of collections).
    completedInThisPage.clear();
    after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (after);

  return { done: true, collectionsSynced, productsSynced, cursor: null };
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      const params   = event.queryStringParameters || {};
      const tenantId = params.tenant_id;
      const action   = params.action;
      if (!tenantId) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
      }

      if (action === 'collections') {
        const collections = await sb(`smflow_shopify_collections?tenant_id=eq.${tenantId}&select=id,title,handle,image_url,product_count&order=title.asc`);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ collections }) };
      }

      const configs = await sb(`smflow_shopify_config?tenant_id=eq.${tenantId}&select=*&limit=1`);
      if (!configs.length || !configs[0].access_token) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ connected: false }) };
      }
      const cfg = configs[0];
      return {
        statusCode: 200, headers: HEADERS,
        body: JSON.stringify({
          connected:          true,
          shop_domain:        cfg.shop_domain,
          last_synced_at:     cfg.last_synced_at,
          collections_synced: cfg.collections_synced,
          products_synced:    cfg.products_synced,
        }),
      };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body); }
      catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

      const { action, tenant_id } = body;
      if (!tenant_id) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
      }

      if (action === 'sync') {
        const configs = await sb(`smflow_shopify_config?tenant_id=eq.${tenant_id}&select=*&limit=1`);
        if (!configs.length || !configs[0].access_token) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No Shopify store connected for this tenant. Connect Shopify first under Settings.' }) };
        }
        const cfg = configs[0];

        // body.cursor is round-tripped from the previous call's response
        // when resuming a sync that didn't finish within one invocation's
        // time budget. Absent on the first call of a fresh sync.
        const result = await syncCollectionsAndProducts(tenant_id, cfg.shop_domain, cfg.access_token, body.cursor || null);

        const totalCollections = (body.cursor?.totalCollectionsSoFar || 0) + result.collectionsSynced;
        const totalProducts    = (body.cursor?.totalProductsSoFar || 0) + result.productsSynced;

        if (result.done) {
          await sb(`smflow_shopify_config?tenant_id=eq.${tenant_id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: {
              last_synced_at:      new Date().toISOString(),
              collections_synced:  totalCollections,
              products_synced:     totalProducts,
              updated_at:          new Date().toISOString(),
            },
          });
        }

        return {
          statusCode: 200, headers: HEADERS,
          body: JSON.stringify({
            success: true,
            done: result.done,
            // These two are the CUMULATIVE totals across every batch so
            // far this sync run, not just this one call's contribution —
            // the frontend can display this number directly without
            // needing to track its own running sum across repeated calls.
            collections_synced: totalCollections,
            products_synced:    totalProducts,
            cursor: result.done ? null : {
              ...result.cursor,
              totalCollectionsSoFar: totalCollections,
              totalProductsSoFar:    totalProducts,
            },
          }),
        };
      }

      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('smflow-shopify-sync error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Sync failed: ${err.message}. Please try again.` }) };
  }
};

export default withLambda(handler);
