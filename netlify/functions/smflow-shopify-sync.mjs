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

async function syncCollectionsAndProducts(tenantId, shopDomain, accessToken) {
  let collectionsSynced = 0;
  let productsSynced    = 0;
  let after = null;

  do {
    const data = await shopifyGraphQL(shopDomain, accessToken, COLLECTIONS_QUERY, { first: 50, after });
    const edges = data.collections.edges;

    for (const { node: col } of edges) {
      const shopifyCollectionId = col.id;

      // Upsert the collection itself
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
      collectionsSynced++;

      // Pull every product in this collection, paginated
      let productAfter = null;
      do {
        const prodData = await shopifyGraphQL(shopDomain, accessToken, PRODUCTS_QUERY, { id: shopifyCollectionId, first: 50, after: productAfter });
        const prodEdges = prodData.collection?.products?.edges || [];

        for (const { node: prod } of prodEdges) {
          // Real edge case found while validating this query against a
          // live store: a product can have featuredMedia: null when it
          // has no image at all. Every downstream consumer of image_url
          // must already handle null/missing images gracefully (same as
          // Drive-synced assets can also lack a thumbnail) — this is not
          // a new failure mode we're introducing.
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
      } while (productAfter);
    }

    after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (after);

  return { collectionsSynced, productsSynced };
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

        const { collectionsSynced, productsSynced } = await syncCollectionsAndProducts(tenant_id, cfg.shop_domain, cfg.access_token);

        await sb(`smflow_shopify_config?tenant_id=eq.${tenant_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            last_synced_at:      new Date().toISOString(),
            collections_synced:  collectionsSynced,
            products_synced:     productsSynced,
            updated_at:          new Date().toISOString(),
          },
        });

        return {
          statusCode: 200, headers: HEADERS,
          body: JSON.stringify({ success: true, collections_synced: collectionsSynced, products_synced: productsSynced }),
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
