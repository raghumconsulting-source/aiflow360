// netlify/functions/tapee360-square-seed.mjs
// Sandbox-only Square token seeding function.
//
// PURPOSE: Allows sandbox testing without fighting Square's consent screen.
// Accepts a Square access token directly, verifies it against Square's API,
// then writes it to the venues row — identical code path as the OAuth callback.
//
// SECURITY:
//   - Returns 404 in production (SQUARE_ENV !== 'sandbox')
//   - Requires valid Supabase JWT
//   - Requires user to own the venue (same ownership check as OAuth)
//   - Verifies token against Square API before writing (proves it's real)
//   - Never logs the full token value
//
// USAGE (POST):
//   Authorization: Bearer <supabase_jwt>
//   Body: { venue_id, tenant_id, access_token }
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_ENV        = process.env.SQUARE_ENV || 'sandbox';

// Square API base — sandbox only
const SQUARE_API = 'https://connect.squareupsandbox.com';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
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

// ── Verify Supabase JWT ──────────────────────────────
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
    `users?id=eq.${userId}&select=id,tenant_id,role&limit=1`
  );
  if (!users.length) throw new Error('User account not found');
  if (users[0].tenant_id !== tenantId) throw new Error('Tenant mismatch');

  const venues = await sbService(
    `venues?id=eq.${venueId}&tenant_id=eq.${tenantId}&limit=1&select=id`
  );
  if (!venues.length) throw new Error('Venue does not belong to this tenant');
}

// ── Verify Square token is real + fetch location ─────
async function verifySquareToken(accessToken) {
  // Call Square merchant profile — proves token is valid
  const merchantRes = await fetch(`${SQUARE_API}/v2/merchants/me`, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Square-Version': '2024-01-18',
    },
  });

  if (!merchantRes.ok) {
    const err = await merchantRes.json().catch(() => ({}));
    const detail = err.errors?.[0]?.detail || 'Token verification failed';
    throw new Error(`Square rejected token: ${detail}`);
  }

  const merchantData = await merchantRes.json();
  const merchantId = merchantData.merchant?.id || null;

  // Fetch locations
  let locationId = null;
  const locRes = await fetch(`${SQUARE_API}/v2/locations`, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Square-Version': '2024-01-18',
    },
  });

  if (locRes.ok) {
    const locData = await locRes.json();
    if (locData.locations?.length) {
      const active = locData.locations.find(l => l.status === 'ACTIVE');
      locationId = (active || locData.locations[0]).id;
    }
  }

  return { merchantId, locationId };
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ── SANDBOX ONLY ────────────────────────────────────
  if (SQUARE_ENV !== 'sandbox') {
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { venue_id: venueId, tenant_id: tenantId, access_token: accessToken } = body;

    // ── Input validation ─────────────────────────────
    if (!venueId || !tenantId || !accessToken) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'venue_id, tenant_id and access_token required' }),
      };
    }

    // access_token must look like a Square token
    if (!accessToken.startsWith('EAAA') && !accessToken.startsWith('EAAAl')) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Invalid token format — must be a Square access token' }),
      };
    }

    // ── Auth checks ──────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const userId = await verifyJWT(authHeader);
    await verifyVenueOwnership(userId, venueId, tenantId);

    // ── Verify token against Square ──────────────────
    console.log('Verifying Square token for venue:', venueId);
    const { merchantId, locationId } = await verifySquareToken(accessToken);
    console.log(`Token verified: merchant=${merchantId} location=${locationId}`);

    // ── Write to venues — same path as OAuth callback ─
    await sbService(`venues?id=eq.${venueId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({
        pos_type:             'square',
        square_access_token:  accessToken,
        square_refresh_token: null,
        square_merchant_id:   merchantId,
        square_location_id:   locationId,
        updated_at:           new Date().toISOString(),
      }),
    });

    console.log(`Square seeded for venue ${venueId}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success:     true,
        merchant_id: merchantId,
        location_id: locationId,
        message:     'Square connected successfully — token verified and saved',
      }),
    };

  } catch (err) {
    console.error('Seed error:', err.message);
    return {
      statusCode: err.message.includes('session') || err.message.includes('mismatch') ? 401 : 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
