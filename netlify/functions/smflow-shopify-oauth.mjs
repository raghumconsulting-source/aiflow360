import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-shopify-oauth.mjs
// Initiates the Shopify OAuth install flow for a tenant's own store.
// GET ?tenant_id=&shop_domain=&redirect_back=
//
// Unlike smflow-oauth.mjs (Facebook/LinkedIn/YouTube), Shopify's authorize
// URL is per-shop, not a single fixed provider URL — the merchant's own
// *.myshopify.com domain is part of the URL itself. That's the main reason
// this is a separate function rather than another branch in smflow-oauth.mjs.

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SITE_URL          = 'https://aiflow360.com';
const CALLBACK_URL       = `${SITE_URL}/.netlify/functions/smflow-shopify-callback`;

// Minimum-privilege scope — read_products alone covers both Product and
// Collection objects in the GraphQL Admin API (confirmed by validating a
// real collections+products query against the schema and running it
// against a live store before this function was written). No write scope,
// no order/customer access.
const SHOPIFY_SCOPES = 'read_products';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function normalizeShopDomain(input) {
  let domain = (input || '').trim().toLowerCase();
  // Accept either "my-store" or "my-store.myshopify.com" or a full URL —
  // be forgiving here, since this is a field a merchant types by hand and
  // will not reliably know the exact expected format.
  domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain.endsWith('.myshopify.com')) {
    domain = `${domain}.myshopify.com`;
  }
  return domain;
}

// Validates the shop domain looks like a real myshopify.com subdomain
// before we ever redirect there — a malformed value here would otherwise
// silently send the merchant to a broken/non-existent Shopify URL.
function isValidShopDomain(domain) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (!SHOPIFY_CLIENT_ID) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'SHOPIFY_CLIENT_ID not configured' }) };
  }

  const params       = event.queryStringParameters || {};
  const tenantId      = params.tenant_id;
  const shopDomainRaw = params.shop_domain;
  const redirectBack  = params.redirect_back || `${SITE_URL}/smflow-app/dashboard.html`;

  if (!tenantId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  }
  if (!shopDomainRaw) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'shop_domain required' }) };
  }

  const shopDomain = normalizeShopDomain(shopDomainRaw);
  if (!isValidShopDomain(shopDomain)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: `"${shopDomainRaw}" doesn't look like a valid Shopify store domain. Try just your store name, e.g. "my-store" or "my-store.myshopify.com".` }),
    };
  }

  // state carries tenant_id + redirect_back through the OAuth round trip,
  // the same pattern smflow-oauth.mjs uses for the other platforms — base64
  // rather than a raw query string, so it survives being passed through as
  // a single opaque `state` parameter without escaping issues.
  const state = Buffer.from(JSON.stringify({ tenant_id: tenantId, redirect_back: redirectBack, shop_domain: shopDomain })).toString('base64');

  const authUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id',    SHOPIFY_CLIENT_ID);
  authUrl.searchParams.set('scope',        SHOPIFY_SCOPES);
  authUrl.searchParams.set('redirect_uri', CALLBACK_URL);
  authUrl.searchParams.set('state',        state);

  return {
    statusCode: 302,
    headers: { ...HEADERS, Location: authUrl.toString() },
    body: '',
  };
};

export default withLambda(handler);
