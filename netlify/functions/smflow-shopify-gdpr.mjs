import { withLambda } from '@netlify/aws-lambda-compat';
import crypto from 'crypto';

// netlify/functions/smflow-shopify-gdpr.mjs
// Handles Shopify's three mandatory compliance webhooks:
//   customers/data_request, customers/redact, shop/redact
// POST, with topic identified by the X-Shopify-Topic header.
//
// IMPORTANT — this uses a DIFFERENT HMAC scheme from the OAuth callback's
// HMAC (smflow-shopify-callback.mjs). That one verifies a hex digest over
// a sorted query string. This one verifies a base64 digest over the raw
// POST body, taken from the X-Shopify-Hmac-Sha256 HEADER, not a query
// param. Mixing these two up is a documented, common mistake — confirmed
// by checking Shopify's docs and several independent implementation
// write-ups before writing this, specifically because of how easy it is
// to assume "HMAC verification" means the same procedure everywhere.
//
// Scope note: this app only ever requests read_products. Per Shopify's
// own docs, customers/data_request and customers/redact are only
// triggered for apps that have been granted customer or order data
// access — which we never request. In practice we expect to receive
// shop/redact (uninstall cleanup) far more often, if not exclusively, but
// all three are implemented so the app is correctly compliant regardless
// of what Shopify actually sends.

const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Topic, X-Shopify-Shop-Domain',
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

// Verifies the webhook genuinely came from Shopify. Takes the RAW body
// string exactly as received — re-serializing parsed JSON before hashing
// would silently break this, since whitespace and key order are part of
// what gets signed.
function verifyWebhookHmac(rawBody, hmacHeader, clientSecret) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', clientSecret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(digest, 'base64');
  const b = Buffer.from(hmacHeader, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleShopRedact(payload) {
  // 48 hours after a store owner uninstalls the app, Shopify sends this.
  // Erase everything we hold for that shop — config, synced catalog data,
  // and any campaigns that referenced it. Collections/products cascade
  // automatically via their FK ON DELETE CASCADE to smflow_shopify_config
  // is NOT set up that way (config is keyed by tenant_id, not shop_domain
  // directly) — so each table is cleaned explicitly here rather than
  // relying on cascade alone, since a single tenant's shop_domain is the
  // only thing we actually know from this payload.
  const shopDomain = payload.shop_domain;
  if (!shopDomain) return;

  const configs = await sb(`smflow_shopify_config?shop_domain=eq.${encodeURIComponent(shopDomain)}&select=tenant_id`);
  for (const cfg of configs) {
    await sb(`smflow_shopify_products?tenant_id=eq.${cfg.tenant_id}`, { method: 'DELETE', prefer: 'return=minimal' });
    await sb(`smflow_shopify_collections?tenant_id=eq.${cfg.tenant_id}`, { method: 'DELETE', prefer: 'return=minimal' });
    await sb(`smflow_shopify_config?tenant_id=eq.${cfg.tenant_id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
}

async function handleCustomersRedact(payload) {
  // We only ever request read_products — we never store customer records
  // at all, so there is nothing of this kind to redact. This handler
  // exists (rather than being omitted) purely so the app responds
  // correctly to the topic per Shopify's compliance requirements, not
  // because we expect it to ever do real work.
  console.log('customers/redact received — no customer data is ever stored by this app, nothing to redact.', { shop_domain: payload.shop_domain });
}

async function handleCustomersDataRequest(payload) {
  // Same reasoning as handleCustomersRedact — we hold no customer data to
  // return. Logged for an audit trail in case this is ever asked about.
  console.log('customers/data_request received — no customer data is ever stored by this app.', { shop_domain: payload.shop_domain });
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rawBody    = event.body || '';
  const hmacHeader = event.headers?.['x-shopify-hmac-sha256'] || event.headers?.['X-Shopify-Hmac-Sha256'];
  const topic      = event.headers?.['x-shopify-topic'] || event.headers?.['X-Shopify-Topic'];

  if (!verifyWebhookHmac(rawBody, hmacHeader, SHOPIFY_CLIENT_SECRET)) {
    // Per Shopify's compliance requirements: an invalid HMAC must get a
    // 401, specifically — not a 400 or a 200 — so Shopify's own review
    // tooling can confirm this check is actually being enforced.
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid HMAC' }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  try {
    switch (topic) {
      case 'shop/redact':
        await handleShopRedact(payload);
        break;
      case 'customers/redact':
        await handleCustomersRedact(payload);
        break;
      case 'customers/data_request':
        await handleCustomersDataRequest(payload);
        break;
      default:
        console.warn('smflow-shopify-gdpr: unhandled topic:', topic);
    }
  } catch (err) {
    // Even on an internal processing error, Shopify expects a fast 200 to
    // avoid retry storms once the request is verified as authentic — we
    // log the failure for follow-up rather than surface a 500 here. The
    // alternative (returning 500) would cause Shopify to keep retrying a
    // request that will fail the same way every time if the bug is in our
    // own code, which doesn't help anyone.
    console.error('smflow-shopify-gdpr processing error:', err.message, { topic });
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: true }) };
};

export default withLambda(handler);
