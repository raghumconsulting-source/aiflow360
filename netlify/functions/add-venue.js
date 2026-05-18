// netlify/functions/add-venue.js
// Creates a new venue for a tenant + seeds default config

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
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
  } catch(e) {
    if (!res.ok) throw new Error(text);
    return [];
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenant_id, name, slug, venue_type, suburb, state, google_review_url } = body;
  if (!tenant_id || !name) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id and name required' }) };
  }

  try {
    // 1. Check tenant plan limits
    const tenants = await sb(`tenants?id=eq.${tenant_id}&select=current_plan,plan_venues&limit=1`);
    const tenant  = tenants[0];
    if (!tenant) throw new Error('Tenant not found');

    const existingVenues = await sb(`venues?tenant_id=eq.${tenant_id}&select=id`);
    const maxVenues = tenant.plan_venues || 1;
    if (existingVenues.length >= maxVenues) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({
          error: 'venue_limit',
          message: `Your ${tenant.current_plan} plan allows ${maxVenues} venue(s). Please upgrade to add more.`,
        }),
      };
    }

    // 2. Generate unique slug
    let finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = await sb(`venues?slug=eq.${finalSlug}&select=id`);
    if (existing.length > 0) finalSlug = `${finalSlug}-${Date.now().toString(36)}`;

    // 3. Create venue
    const venues = await sb('venues', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id,
        name,
        slug:             finalSlug,
        display_name:     name,
        venue_type:       venue_type || 'restaurant',
        suburb:           suburb || null,
        state:            state  || null,
        google_review_url: google_review_url || null,
        is_active:        true,
        status:           'active',
      }),
    });
    const venue = venues[0];

    // 4. Seed defaults (tags, icebreakers, recovery actions)
    try {
      await sb('rpc/seed_venue_defaults', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({
          p_tenant_id:  tenant_id,
          p_venue_id:   venue.id,
          p_venue_type: venue_type || 'restaurant',
        }),
      });
    } catch(seedErr) {
      console.warn('Seed defaults failed (non-fatal):', seedErr.message);
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ venue }),
    };

  } catch (err) {
    console.error('add-venue error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
