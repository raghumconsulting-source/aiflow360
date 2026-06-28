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
// Netlify's documented Pro-plan synchronous limit is 60 seconds, but a
// direct, timed test call against the real live deployment measured an
// actual cutoff close to 30 seconds (confirmed: a real request returned a
// 504 Inactivity Timeout at ~30.2s elapsed). Rather than trust the
// documented number, this budget is set against what was actually
// measured in production, with real margin under THAT — not the
// platform's nominal limit, which evidently doesn't reflect what this
// specific site enforces. If this needs further tuning, re-measure with
// a timed direct fetch() call before changing this constant again.
const TIME_BUDGET_MS = 18000;

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

  do {
    const data = await shopifyGraphQL(shopDomain, accessToken, COLLECTIONS_QUERY, { first: 50, after });
    const edges = data.collections.edges;

    for (const { node: col } of edges) {
      const shopifyCollectionId = col.id;

      // Skip collections we already fully finished in an earlier call this
      // same sync run — only relevant when resuming mid-page.
      if (resumeInCollection && shopifyCollectionId !== resumeInCollection) {
        continue;
      }

      const existing = await sb(`smflow_shopify_collections?tenant_id=eq.${tenantId}&shopify_collection_id=eq.${encodeURIComponent(shopifyCollectionId)}&select=id&limit=1`);
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

      let collectionRowId;
      if (existing.length) {
        collectionRowId = existing[0].id;
        await sb(`smflow_shopify_collections?id=eq.${collectionRowId}`, { method: 'PATCH', prefer: 'return=minimal', body: collectionPayload });
      } else {
        const inserted = await sb('smflow_shopify_collections', { method: 'POST', prefer: 'return=representation', body: { ...collectionPayload, created_at: new Date().toISOString() } });
        collectionRowId = inserted[0].id;
      }
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

          const existingProduct = await sb(`smflow_shopify_products?tenant_id=eq.${tenantId}&shopify_product_id=eq.${encodeURIComponent(prod.id)}&select=id&limit=1`);
          if (existingProduct.length) {
            await sb(`smflow_shopify_products?id=eq.${existingProduct[0].id}`, { method: 'PATCH', prefer: 'return=minimal', body: productPayload });
          } else {
            await sb('smflow_shopify_products', { method: 'POST', prefer: 'return=minimal', body: { ...productPayload, created_at: new Date().toISOString() } });
          }
          productsSynced++;
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
            cursor: { collectionsAfter: after, inProgressCollectionId: shopifyCollectionId, productsAfter: productAfter },
          };
        }
      } while (productAfter);

      collectionsSynced += 0; // (collection itself already counted above; this line intentionally left for clarity of the loop structure)

      if (timeIsUp()) {
        return {
          done: false, collectionsSynced, productsSynced,
          cursor: { collectionsAfter: after, inProgressCollectionId: null, productsAfter: null },
        };
      }
    }

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
