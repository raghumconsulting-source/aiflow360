// netlify/functions/tapee360-square-oauth.mjs
// Secure Square OAuth flow for Tapee360.
//
// POST { action:'initiate', venue_id, tenant_id }
//   Header: Authorization: Bearer <supabase_jwt>
//   → Verifies JWT, verifies venue ownership, creates nonce, returns Square redirect URL
//
// GET ?code=X&state=<nonce_uuid>
//   → Square callback: validates nonce, exchanges code for token, writes to venues
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_APP_ID     = process.env.SQUARE_APP_ID;
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET;
const SQUARE_ENV        = process.env.SQUARE_ENV || 'sandbox';
const SITE_URL          = process.env.URL || 'https://aiflow360.com';

const SQUARE_AUTH_BASE = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Token exchange ALWAYS uses production endpoint even in sandbox
const SQUARE_TOKEN_URL = 'https://connect.squareup.com/oauth2/token';

const SQUARE_API_BASE = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const SCOPES = [
  'MERCHANT_PROFILE_READ',
  'ITEMS_READ',
  'ORDERS_WRITE',
  'ORDERS_READ',
  'PAYMENTS_WRITE',
  'PAYMENTS_READ',
].join('+');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Supabase service-key fetch ───────────────────────
async function sbService(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!text || text === 'null') return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Verify Supabase JWT → return user ───────────────
async function verifyJWT(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing Authorization header');
  }
  const token = authHeader.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error('Invalid or expired session');
  const user = await res.json();
  if (!user?.id) throw new Error('Could not resolve user from token');
  return user.id;
}

// ── Verify user owns the venue ───────────────────────
async function verifyVenueOwnership(userId, venueId, tenantId) {
  const users = await sbService(
    `users?id=eq.${userId}&tenant_id=eq.${tenantId}&limit=1&select=id`
  );
  if (!users.length) throw new Error('User does not belong to this tenant');

  const venues = await sbService(
    `venues?id=eq.${venueId}&tenant_id=eq.${tenantId}&limit=1&select=id`
  );
  if (!venues.length) throw new Error('Venue does not belong to this tenant');
}

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ── POST: Initiate OAuth ─────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { action, venue_id: venueId, tenant_id: tenantId } = body;

      if (action !== 'initiate') {
        return {
          statusCode: 400,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Unknown action' }),
        };
      }

      if (!venueId || !tenantId) {
        return {
          statusCode: 400,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'venue_id and tenant_id required' }),
        };
      }

      // 1. Verify JWT
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const userId = await verifyJWT(authHeader);

      // 2. Verify venue ownership
      await verifyVenueOwnership(userId, venueId, tenantId);

      // 3. Create nonce
      const nonces = await sbService('tapee_oauth_nonces', {
        method: 'POST',
        body:   JSON.stringify({ venue_id: venueId, tenant_id: tenantId }),
      });
      const nonce = Array.isArray(nonces) ? nonces[0] : nonces;
      if (!nonce?.id) throw new Error('Failed to create nonce');

      // 4. Return Square authorize URL — state = nonce UUID only
      const authorizeUrl = `${SQUARE_AUTH_BASE}/oauth2/authorize`
        + `?client_id=${SQUARE_APP_ID}`
        + `&scope=${SCOPES}`
        + `&session=false`
        + `&state=${nonce.id}`;

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_url: authorizeUrl }),
      };

    } catch (err) {
      console.error('OAuth initiate error:', err.message);
      return {
        statusCode: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ── GET: Square callback ─────────────────────────────
  if (event.httpMethod === 'GET') {
    const params  = event.queryStringParameters || {};
    const failUrl = `${SITE_URL}/settings.html`;

    // Square denied
    if (params.error) {
      return redirect(`${failUrl}?pos_error=${encodeURIComponent(params.error_description || params.error)}`);
    }

    if (!params.code || !params.state) {
      return {
        statusCode: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing code or state param' }),
      };
    }

    const authCode = params.code;
    const nonceId  = params.state;

    try {
      // 1. Look up nonce
      const nonces = await sbService(`tapee_oauth_nonces?id=eq.${nonceId}&limit=1`);
      const nonce  = nonces[0];

      if (!nonce) {
        console.error('Nonce not found:', nonceId);
        return redirect(`${failUrl}?pos_error=Invalid+session`);
      }
      if (nonce.used) {
        console.error('Nonce already used:', nonceId);
        return redirect(`${failUrl}?pos_error=Session+already+used`);
      }
      if (new Date(nonce.expires_at) < new Date()) {
        console.error('Nonce expired:', nonceId);
        return redirect(`${failUrl}?pos_error=Session+expired`);
      }

      const venueId  = nonce.venue_id;
      const tenantId = nonce.tenant_id;

      // 2. Mark nonce used immediately
      await sbService(`tapee_oauth_nonces?id=eq.${nonceId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body:   JSON.stringify({ used: true }),
      });

      // 3. Exchange auth code for token
      console.log('Exchanging code — venue:', venueId);
      const tokenRes = await fetch(SQUARE_TOKEN_URL, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          client_id:     SQUARE_APP_ID,
          client_secret: SQUARE_APP_SECRET,
          code:          authCode,
          grant_type:    'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();
      console.log('Square token status:', tokenRes.status);

      if (!tokenRes.ok || !tokenData.access_token) {
        const errDetail = tokenData.errors?.[0]?.detail
          || tokenData.message
          || 'Token exchange failed';
        console.error('Token exchange failed:', JSON.stringify(tokenData));
        return redirect(`${failUrl}?pos_error=${encodeURIComponent(errDetail)}`);
      }

      const accessToken  = tokenData.access_token;
      const refreshToken = tokenData.refresh_token || null;
      const merchantId   = tokenData.merchant_id   || null;

      // 4. Fetch primary location
      let locationId = null;
      try {
        const locRes = await fetch(`${SQUARE_API_BASE}/v2/locations`, {
          headers: {
            'Authorization':  `Bearer ${accessToken}`,
            'Square-Version': '2024-01-18',
          },
        });
        const locData = await locRes.json();
        if (locData.locations?.length) {
          const active = locData.locations.find(l => l.status === 'ACTIVE');
          locationId = (active || locData.locations[0]).id;
        }
        console.log('Location resolved:', locationId);
      } catch (locErr) {
        console.warn('Location fetch failed (non-fatal):', locErr.message);
      }

      // 5. Write tokens — server-side only, service key
      await sbService(`venues?id=eq.${venueId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          pos_type:             'square',
          square_access_token:  accessToken,
          square_refresh_token: refreshToken,
          square_merchant_id:   merchantId,
          square_location_id:   locationId,
          updated_at:           new Date().toISOString(),
        }),
      });

      console.log(`Connected: venue=${venueId} merchant=${merchantId} location=${locationId}`);

      // 6. Redirect — no tokens in URL, just venue context for tab restore
      return redirect(
        `${SITE_URL}/settings.html?pos_connected=square&venue_id=${venueId}&tenant_id=${tenantId}`
      );

    } catch (err) {
      console.error('OAuth callback error:', err.message);
      return redirect(`${failUrl}?pos_error=${encodeURIComponent(err.message)}`);
    }
  }

  return {
    statusCode: 405,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
};

export default withLambda(handler);
