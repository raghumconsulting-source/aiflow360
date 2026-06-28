import { withLambda } from '@netlify/aws-lambda-compat';
import crypto from 'crypto';

// netlify/functions/smflow-shopify-callback.mjs
// Handles Shopify's redirect back after a merchant approves the install.
// GET ?code=&shop=&state=&hmac=&timestamp=
//
// Security note: every request here MUST be verified before it's trusted.
// Anyone can craft a request to this URL — the hmac parameter is the only
// proof it genuinely came from Shopify, computed over the OTHER query
// params using our client secret as the HMAC key. This is a different
// verification procedure from Shopify's webhook HMAC (header, base64) —
// this one is a query-string hex digest, specific to the OAuth callback.

const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL              = 'https://aiflow360.com';
const CALLBACK_URL          = `${SITE_URL}/.netlify/functions/smflow-shopify-callback`;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'text/html',
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

// Shopify's documented shop-domain validation — confirms the value can
// only ever point at a real myshopify.com subdomain before we use it to
// build a URL or store it. Without this, a forged shop param could be
// used to make our server send the access-token request to an attacker's
// own endpoint instead of Shopify's.
function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop || '');
}

// HMAC verification for the OAuth callback specifically (NOT the same
// procedure as webhook HMAC verification, which uses a header and base64
// rather than a query param and hex). Per Shopify's docs: remove hmac from
// the query string, sort + join the remaining params, HMAC-SHA256 with the
// client secret, compare hex digest.
function verifyOAuthHmac(params, clientSecret) {
  const { hmac, ...rest } = params;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  // Constant-time comparison — a plain === here would leak timing
  // information about how many leading characters matched, which is
  // exactly the kind of side channel HMAC verification exists to avoid.
  const a = Buffer.from(digest, 'hex');
  const b = Buffer.from(hmac, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function errorPage(message) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Connection failed</h2><p>${message}</p>
    <a href="${SITE_URL}/smflow-app/dashboard.html?tab=settings">Return to SMflow</a>
  </body></html>`;
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const { code, shop, state, error } = params;

  if (error) {
    return { statusCode: 200, headers: HEADERS, body: errorPage(`Shopify reported: ${error}`) };
  }
  if (!code || !shop || !state) {
    return { statusCode: 400, headers: HEADERS, body: errorPage('Missing required parameters from Shopify.') };
  }
  if (!isValidShopDomain(shop)) {
    return { statusCode: 400, headers: HEADERS, body: errorPage('Invalid shop domain.') };
  }
  if (!verifyOAuthHmac(params, SHOPIFY_CLIENT_SECRET)) {
    return { statusCode: 401, headers: HEADERS, body: errorPage('Could not verify this request came from Shopify. Please try connecting again.') };
  }

  let tenantId, redirectBack;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    tenantId     = decoded.tenant_id;
    redirectBack = decoded.redirect_back || `${SITE_URL}/smflow-app/dashboard.html`;
    // The shop domain in `state` was the one the merchant typed before
    // being redirected to Shopify. It must match the shop Shopify is now
    // telling us they actually authorized — if they don't match, someone
    // could be trying to attach a different store's token to this tenant.
    if (decoded.shop_domain && decoded.shop_domain !== shop) {
      return { statusCode: 400, headers: HEADERS, body: errorPage('Shop domain mismatch — please try connecting again.') };
    }
  } catch {
    return { statusCode: 400, headers: HEADERS, body: errorPage('Invalid state parameter.') };
  }
  if (!tenantId) {
    return { statusCode: 400, headers: HEADERS, body: errorPage('Missing tenant reference.') };
  }

  try {
    // Exchange the authorization code for an offline access token. Offline
    // tokens don't expire (they're revoked only by uninstall), which is
    // what we want for a server-side background sync job — there's no
    // logged-in staff session driving this, so an "online" token tied to
    // a specific user session would be the wrong choice here.
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const existing = await sb(`smflow_shopify_config?tenant_id=eq.${tenantId}&select=id&limit=1`);
    const payload = {
      tenant_id:    tenantId,
      shop_domain:  shop,
      access_token: tokenData.access_token,
      scope:        tokenData.scope || null,
      sync_enabled: true,
      uninstalled_at: null,
      updated_at:   new Date().toISOString(),
    };

    if (existing.length) {
      await sb(`smflow_shopify_config?tenant_id=eq.${tenantId}`, { method: 'PATCH', prefer: 'return=minimal', body: payload });
    } else {
      // The unique constraint on smflow_shopify_config.tenant_id is the
      // real safety net here — if two OAuth completions for the same
      // tenant land within the same window (double-click, retry after a
      // flaky network response, etc.), the second INSERT throws a
      // constraint violation rather than creating a duplicate row. Catch
      // that specific case and fall back to an update with the token we
      // actually received, instead of surfacing it as an opaque 500 — the
      // person did successfully authorize, so this should still succeed
      // from their point of view.
      try {
        await sb('smflow_shopify_config', { method: 'POST', prefer: 'return=minimal', body: { ...payload, connected_by: 'tenant_self_serve', created_at: new Date().toISOString() } });
      } catch (insertErr) {
        if (/duplicate key|already exists|unique constraint/i.test(insertErr.message)) {
          await sb(`smflow_shopify_config?tenant_id=eq.${tenantId}`, { method: 'PATCH', prefer: 'return=minimal', body: payload });
        } else {
          throw insertErr;
        }
      }
    }

    const successMsg = encodeURIComponent(`✓ Connected: Shopify (${shop})`);
    return {
      statusCode: 302,
      headers: { ...HEADERS, Location: `${redirectBack}?tab=settings&connect_success=${successMsg}` },
      body: '',
    };
  } catch (err) {
    console.error('smflow-shopify-callback error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: errorPage('Something went wrong connecting your store. Please try again.') };
  }
};

export default withLambda(handler);
