// netlify/functions/tapee-config-save.mjs
// Saves Tapee360 ordering + config settings via service key
// All writes authenticated via JWT — no direct client writes
//
// POST body:
//   tenant_id, venue_id  (required)
//   dine_in_enabled, takeaway_enabled  (ordering)
//   loyalty_enabled, loyalty_points_per_dollar
//   theme, timezone (optional config fields)
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

// ── Supabase REST via service key ─────────────────────
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
  if (!res.ok) throw new Error(text);
  return text ? JSON.parse(text) : [];
}

// ── Verify JWT via Supabase auth ───────────────────────
async function verifySession(authHeader) {
  if (!authHeader?.startsWith('Bearer '))
    throw new Error('Missing Authorization header');
  const token = authHeader.slice(7);
  const res   = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Invalid or expired session');
  const user = await res.json();
  if (!user?.id) throw new Error('Could not resolve user');
  return user.id;
}

// ── Verify venue belongs to tenant ────────────────────
async function verifyOwnership(venueId, tenantId) {
  const rows = await sb(
    `venues?id=eq.${venueId}&tenant_id=eq.${tenantId}&select=id&limit=1`
  );
  if (!rows.length) throw new Error('Venue not found or access denied');
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // Auth
    const userId = await verifySession(
      event.headers.authorization || event.headers.Authorization
    );

    const body = JSON.parse(event.body || '{}');
    const { tenant_id, venue_id } = body;

    if (!tenant_id || !venue_id)
      return { statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'tenant_id and venue_id required' }) };

    // Ownership check — user must belong to tenant
    const users = await sb(
      `users?id=eq.${userId}&tenant_id=eq.${tenant_id}&select=id&limit=1`
    );
    if (!users.length)
      return { statusCode: 403, headers: CORS,
        body: JSON.stringify({ error: 'Access denied' }) };

    await verifyOwnership(venue_id, tenant_id);

    // Build config update — only include provided fields
    const configUpdate = { venue_id, updated_at: new Date().toISOString() };

    const ALLOWED_FIELDS = [
      'dine_in_enabled', 'takeaway_enabled',
      'loyalty_enabled', 'loyalty_points_per_dollar',
      'theme', 'timezone',
      'show_calories', 'show_allergens',
      'voice_enabled', 'category_images',
      'dine_in_prepayment', 'takeaway_payment_method',
    ];

    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) configUpdate[field] = body[field];
    }

    // Upsert tapee_venue_config
    await sb('tapee_venue_config', {
      method:  'POST',
      prefer:  'resolution=merge-duplicates,return=minimal',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(configUpdate),
    });

    console.log(`Tapee config saved for venue ${venue_id}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true }),
    };

  } catch(e) {
    console.error('tapee-config-save error:', e.message);
    const status = e.message.includes('Access denied') ? 403 : 500;
    return { statusCode: status, headers: CORS,
      body: JSON.stringify({ error: e.message }) };
  }
};

export default withLambda(handler);
