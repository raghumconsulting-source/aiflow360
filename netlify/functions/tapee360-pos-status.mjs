// netlify/functions/tapee360-pos-status.mjs
// Returns POS connection status for a venue — no tokens exposed to browser.
//
// GET ?venue_id=X&tenant_id=Y
//   Header: Authorization: Bearer <supabase_jwt>
//   → Returns { connected, pos_type, merchant_id, location_id }
//   → Never returns access_token or refresh_token
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

async function sbService(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  const text = await res.text();
  if (!text || text === 'null') return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

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
  if (!user?.id) throw new Error('Could not resolve user');
  return user.id;
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  try {
    const params   = event.queryStringParameters || {};
    const venueId  = params.venue_id;
    const tenantId = params.tenant_id;

    if (!venueId || !tenantId) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'venue_id and tenant_id required' }),
      };
    }

    // Verify JWT
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    await verifyJWT(authHeader);

    // Fetch only safe fields — never access_token or refresh_token
    const venues = await sbService(
      `venues?id=eq.${venueId}&tenant_id=eq.${tenantId}&select=pos_type,square_merchant_id,square_location_id,square_access_token&limit=1`
    );

    const venue = venues[0];
    if (!venue) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: 'Venue not found' }),
      };
    }

    // Return status — token existence only, never the value
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        connected:   !!(venue.square_access_token && venue.square_location_id),
        pos_type:    venue.pos_type || 'none',
        merchant_id: venue.square_merchant_id || null,
        location_id: venue.square_location_id || null,
      }),
    };

  } catch (err) {
    console.error('POS status error:', err.message);
    return {
      statusCode: err.message.includes('session') ? 401 : 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
