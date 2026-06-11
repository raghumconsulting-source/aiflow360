import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/get-tenant.js
// Looks up tenant by auth user_id or email using service key
// Called from dashboard.html after Google OAuth login

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Safe Supabase fetch — always returns array or throws ──
async function sb(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  console.log('sb fetch:', url);
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
  });
  const text = await res.text();
  console.log(`sb response [${res.status}]:`, text.slice(0, 200));

  if (!res.ok) {
    throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 120)}`);
  }
  if (!text || text === 'null') return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

const handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const { user_id, email } = event.queryStringParameters || {};
  console.log('get-tenant called — user_id:', user_id, '| email:', email);

  if (!user_id && !email) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'user_id or email required' }),
    };
  }

  try {
    let tenant = null;

    // ── Method 1: users table by auth user_id ─────────────
    if (user_id) {
      console.log('Method 1: lookup by user_id');
      const rows = await sb(`users?id=eq.${user_id}&select=tenant_id&limit=1`);
      console.log('Method 1 users rows:', JSON.stringify(rows));
      if (rows[0]?.tenant_id) {
        const tenants = await sb(`tenants?id=eq.${rows[0].tenant_id}&limit=1`);
        tenant = tenants[0] || null;
        console.log('Method 1 tenant found:', tenant?.id);
      }
    }

    // ── Method 2: users table by email ────────────────────
    if (!tenant && email) {
      console.log('Method 2: lookup by email in users table');
      const rows = await sb(`users?email=eq.${encodeURIComponent(email)}&select=tenant_id&limit=1`);
      console.log('Method 2 users rows:', JSON.stringify(rows));
      if (rows[0]?.tenant_id) {
        const tenants = await sb(`tenants?id=eq.${rows[0].tenant_id}&limit=1`);
        tenant = tenants[0] || null;
        console.log('Method 2 tenant found:', tenant?.id);
      }
    }

    // ── Method 3: tenants.contact_email ───────────────────
    if (!tenant && email) {
      console.log('Method 3: lookup by contact_email in tenants');
      const tenants = await sb(`tenants?contact_email=eq.${encodeURIComponent(email)}&limit=1`);
      tenant = tenants[0] || null;
      console.log('Method 3 tenant found:', tenant?.id);
    }

    if (!tenant) {
      console.log('No tenant found for user_id:', user_id, '| email:', email);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ tenant: null, venues: [] }),
      };
    }

    console.log('Fetching venues for tenant_id:', tenant.id);

    // ── FIX: Query venues without status filter ───────────
    // The status column filter was causing venues=[] for tenants
    // whose venues don't have status set. Filter client-side only.
    let venues = [];
    try {
      venues = await sb(`venues?tenant_id=eq.${tenant.id}&is_active=eq.true&order=name`);
      console.log('Venues raw count:', venues.length);
    } catch (venueErr) {
      // is_active filter failed — fall back to unfiltered
      console.warn('venues query with is_active filter failed, trying without:', venueErr.message);
      try {
        venues = await sb(`venues?tenant_id=eq.${tenant.id}&order=name`);
        console.log('Venues fallback count:', venues.length);
      } catch (fallbackErr) {
        console.error('venues fallback also failed:', fallbackErr.message);
        venues = [];
      }
    }

    // Client-side safety filters
    venues = venues.filter(v => !v.deleted_at);
    console.log('Venues after filter:', venues.length, venues.map(v => v.name));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ tenant, venues }),
    };

  } catch (err) {
    console.error('get-tenant error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
