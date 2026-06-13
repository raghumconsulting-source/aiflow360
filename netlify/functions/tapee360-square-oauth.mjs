// netlify/functions/tapee360-square-oauth.mjs
// Square OAuth flow for Tapee360 POS integration.
//
// Two modes (via query params):
//   ?action=authorize&venue_id=X  → redirect user to Square consent screen
//   ?code=X&state=venue_id        → callback from Square, exchange code for token
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_APP_ID = process.env.SQUARE_APP_ID;
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET;
const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';

const SQUARE_BASE = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const SQUARE_API = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const SITE_URL = process.env.URL || 'https://aiflow360.com';

const SCOPES = [
  'MERCHANT_PROFILE_READ',
  'ITEMS_READ',
  'ORDERS_WRITE',
  'ORDERS_READ',
  'PAYMENTS_WRITE',
  'PAYMENTS_READ',
].join('+');

// ── Supabase helper ──────────────────────────────────
async function sb(path, opts = {}) {
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
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  } catch (e) {
    if (!res.ok) throw new Error(text);
    return [];
  }
}

const handler = async (event) => {
  const params = event.queryStringParameters || {};

  // ── MODE 1: Initiate OAuth → redirect to Square ────
  if (params.action === 'authorize') {
    const venueId = params.venue_id;
    if (!venueId) {
      return { statusCode: 400, body: 'venue_id required' };
    }

    // Encode venue_id + return_url in state so callback knows where to redirect back
    const returnUrl = params.return_url || `${SITE_URL}/settings.html`;
    const statePayload = btoa(unescape(encodeURIComponent(JSON.stringify({ venueId, returnUrl }))));

    const authorizeUrl = `${SQUARE_BASE}/oauth2/authorize`
      + `?client_id=${SQUARE_APP_ID}`
      + `&scope=${SCOPES}`
      + `&session=false`
      + `&state=${encodeURIComponent(statePayload)}`;

    return {
      statusCode: 302,
      headers: { Location: authorizeUrl },
      body: '',
    };
  }

  // ── MODE 2: Callback from Square ───────────────────
  if (params.code) {
    const authCode = params.code;

    // Decode state — supports both legacy plain venue_id and new base64 JSON
    let venueId, returnUrl;
    try {
      const decoded = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(params.state)))));
      venueId  = decoded.venueId;
      returnUrl = decoded.returnUrl || `${SITE_URL}/settings.html`;
    } catch(e) {
      // Legacy fallback: state is plain venue_id
      venueId   = params.state;
      returnUrl = `${SITE_URL}/settings.html`;
    }

    if (!venueId) {
      return { statusCode: 400, body: 'Missing state (venue_id)' };
    }

    try {
      // 1. Exchange auth code for access token
      // NOTE: Square OAuth token endpoint is always connect.squareup.com even in sandbox
      const SQUARE_TOKEN_URL = 'https://connect.squareup.com/oauth2/token';
      const tokenRes = await fetch(SQUARE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     SQUARE_APP_ID,
          client_secret: SQUARE_APP_SECRET,
          code:          authCode,
          grant_type:    'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();

      console.log('Square token response status:', tokenRes.status);
      console.log('Square token response body:', JSON.stringify(tokenData));
      console.log('Square APP_ID used:', SQUARE_APP_ID ? SQUARE_APP_ID.slice(0,20) + '...' : 'NOT SET');
      console.log('Square APP_SECRET set:', SQUARE_APP_SECRET ? 'YES (' + SQUARE_APP_SECRET.slice(0,15) + '...)' : 'NOT SET');
      console.log('Auth code used:', authCode ? authCode.slice(0,20) + '...' : 'MISSING');

      if (!tokenRes.ok || !tokenData.access_token) {
        // Return full Square error detail in pos_error for debugging
        const squareErrors = tokenData.errors ? JSON.stringify(tokenData.errors) : '';
        const errorMsg = tokenData.message || tokenData.error || squareErrors || 'Token exchange failed';
        const errBase = (returnUrl || SITE_URL + '/settings.html').split('?')[0];
        return {
          statusCode: 302,
          headers: {
            Location: `${errBase}?venue_id=${venueId}&pos_error=${encodeURIComponent(errorMsg)}`,
          },
          body: '',
        };
      }

      const accessToken  = tokenData.access_token;
      const refreshToken = tokenData.refresh_token || null;
      const merchantId   = tokenData.merchant_id || null;

      // 2. Fetch locations to get the primary location_id
      let locationId = null;
      try {
        const locRes = await fetch(`${SQUARE_API}/v2/locations`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        const locData = await locRes.json();
        if (locData.locations && locData.locations.length > 0) {
          // Pick first active location, or just the first one
          const active = locData.locations.find(l => l.status === 'ACTIVE');
          locationId = (active || locData.locations[0]).id;
        }
      } catch (locErr) {
        console.warn('Failed to fetch locations (non-fatal):', locErr.message);
      }

      // 3. Write tokens to venues table
      await sb(`venues?id=eq.${venueId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          pos_type:             'square',
          square_access_token:  accessToken,
          square_refresh_token: refreshToken,
          square_merchant_id:   merchantId,
          square_location_id:   locationId,
          updated_at:           new Date().toISOString(),
        }),
      });

      console.log(`Square connected for venue ${venueId}: merchant=${merchantId}, location=${locationId}`);

      // 4. Redirect back to settings with success
      // Look up tenant_id for the redirect URL
      let tenantId = '';
      try {
        const venues = await sb(`venues?id=eq.${venueId}&select=tenant_id&limit=1`);
        if (venues[0]) tenantId = venues[0].tenant_id;
      } catch (e) { /* non-fatal */ }

      // Build return URL — append pos_connected to whatever URL was passed in
      const redirectBase = returnUrl.split('?')[0];
      const existingParams = new URLSearchParams(returnUrl.split('?')[1] || '');
      existingParams.set('pos_connected', 'square');
      if (tenantId) existingParams.set('tenant_id', tenantId);
      existingParams.set('venue_id', venueId);

      return {
        statusCode: 302,
        headers: {
          Location: `${redirectBase}?${existingParams.toString()}`,
        },
        body: '',
      };

    } catch (err) {
      console.error('Square OAuth callback error:', err);
      return {
        statusCode: 302,
        headers: {
          Location: `${SITE_URL}/settings.html?venue_id=${venueId}&pos_error=${encodeURIComponent(err.message)}`,
        },
        body: '',
      };
    }
  }

  // ── Debug mode: test token exchange directly ────────
  // ?action=debug&code=X&venue_id=Y → returns full Square response as JSON
  if (params.action === 'debug' && params.code) {
    const SQUARE_TOKEN_URL = 'https://connect.squareup.com/oauth2/token';
    const debugRes = await fetch(SQUARE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     SQUARE_APP_ID,
        client_secret: SQUARE_APP_SECRET,
        code:          params.code,
        grant_type:    'authorization_code',
      }),
    });
    const debugData = await debugRes.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status:       debugRes.status,
        square_response: debugData,
        env_check: {
          app_id_set:     !!SQUARE_APP_ID,
          app_id_prefix:  SQUARE_APP_ID ? SQUARE_APP_ID.slice(0, 20) : 'NOT SET',
          secret_set:     !!SQUARE_APP_SECRET,
          secret_prefix:  SQUARE_APP_SECRET ? SQUARE_APP_SECRET.slice(0, 15) : 'NOT SET',
          square_env:     SQUARE_ENV,
          site_url:       SITE_URL,
        },
      }, null, 2),
    };
  }

  // ── No valid action ────────────────────────────────
  return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Provide ?action=authorize&venue_id=X or Square will redirect with ?code=X&state=Y' }),
  };
};

export default withLambda(handler);
