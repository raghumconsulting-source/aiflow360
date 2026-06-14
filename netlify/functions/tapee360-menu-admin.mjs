// netlify/functions/tapee360-menu-admin.mjs
// Menu scheduling admin — JWT-verified, venue-ownership-checked
//
// Actions:
//   GET    ?action=schedules&venue_id=X          list schedules for venue
//   GET    ?action=item_assignments&venue_id=X   list item→schedule mappings
//   POST   {action:'create_schedule', ...}       create service period
//   PUT    {action:'update_schedule', id, ...}   edit schedule
//   DELETE {action:'delete_schedule', id, venue_id, tenant_id}  soft delete
//   POST   {action:'assign_item', item_id, schedule_id, ...}    assign item
//   DELETE {action:'unassign_item', item_id, schedule_id, venue_id, tenant_id}
//   PUT    {action:'item_override', item_id, schedule_id, ...}  price/avail override
//   PUT    {action:'set_menu_type', item_id, menu_type, venue_id, tenant_id}
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

// ── Supabase REST ────────────────────────────────────
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
  if (!text || text === 'null') return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── JWT verify ───────────────────────────────────────
async function verifyJWT(authHeader) {
  if (!authHeader?.startsWith('Bearer '))
    throw new Error('Missing Authorization header');
  const token = authHeader.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Invalid or expired session');
  const user = await res.json();
  if (!user?.id) throw new Error('Could not resolve user');
  return user.id;
}

// ── Venue ownership ──────────────────────────────────
async function verifyOwnership(userId, venueId, tenantId) {
  const users = await sb(`users?id=eq.${userId}&select=id,tenant_id&limit=1`);
  if (!users.length) throw new Error('User account not found');
  if (users[0].tenant_id !== tenantId) throw new Error('Tenant mismatch');
  const venues = await sb(`venues?id=eq.${venueId}&tenant_id=eq.${tenantId}&select=id&limit=1`);
  if (!venues.length) throw new Error('Venue not found or access denied');
}

// ── Validate schedule fields ─────────────────────────
function validateSchedule(body) {
  const { name, days_of_week, start_time, end_time } = body;
  if (!name?.trim()) throw new Error('Schedule name is required');
  if (!Array.isArray(days_of_week) || !days_of_week.length)
    throw new Error('At least one day of week required');
  if (!start_time || !end_time)
    throw new Error('start_time and end_time required');
  // Validate time format HH:MM
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timeRe.test(start_time)) throw new Error('Invalid start_time format (HH:MM)');
  if (!timeRe.test(end_time))   throw new Error('Invalid end_time format (HH:MM)');
  if (end_time <= start_time)   throw new Error('end_time must be after start_time');
  // Valid days 0-6
  if (!days_of_week.every(d => Number.isInteger(d) && d >= 0 && d <= 6))
    throw new Error('days_of_week must be integers 0-6');
}

// ── json response ────────────────────────────────────
const json = (statusCode, body) => ({
  statusCode, headers: CORS, body: JSON.stringify(body),
});

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 204, headers: CORS, body: '' };

  // ── Auth ──────────────────────────────────────────
  let userId;
  try {
    userId = await verifyJWT(
      event.headers.authorization || event.headers.Authorization || ''
    );
  } catch(e) {
    return json(401, { error: e.message });
  }

  const params = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    // ══ GET requests ══════════════════════════════════
    if (method === 'GET') {
      const action   = params.action;
      const venueId  = params.venue_id;
      const tenantId = params.tenant_id;
      if (!venueId || !tenantId) return json(400, { error: 'venue_id and tenant_id required' });
      await verifyOwnership(userId, venueId, tenantId);

      if (action === 'schedules') {
        const rows = await sb(
          `tapee_menu_schedules?venue_id=eq.${venueId}&deleted_at=is.null&order=sort_order.asc,name.asc`
        );
        return json(200, { schedules: rows });
      }

      if (action === 'item_assignments') {
        const rows = await sb(
          `tapee_menu_item_schedules?venue_id=eq.${venueId}&select=id,item_id,schedule_id,price_override_cents,available_override`
        );
        return json(200, { assignments: rows });
      }

      return json(400, { error: `Unknown action: ${action}` });
    }

    // ══ POST / PUT / DELETE ════════════════════════════
    const body = JSON.parse(event.body || '{}');
    const { action, venue_id: venueId, tenant_id: tenantId } = body;
    if (!venueId || !tenantId) return json(400, { error: 'venue_id and tenant_id required' });
    await verifyOwnership(userId, venueId, tenantId);

    // ── Create schedule ──────────────────────────────
    if (method === 'POST' && action === 'create_schedule') {
      validateSchedule(body);
      const rows = await sb('tapee_menu_schedules', {
        method: 'POST',
        body: JSON.stringify({
          venue_id:     venueId,
          name:         body.name.trim(),
          days_of_week: body.days_of_week,
          start_time:   body.start_time,
          end_time:     body.end_time,
          is_active:    body.is_active !== false,
          sort_order:   body.sort_order || 0,
        }),
      });
      return json(201, { schedule: rows[0] });
    }

    // ── Update schedule ──────────────────────────────
    if (method === 'PUT' && action === 'update_schedule') {
      if (!body.id) return json(400, { error: 'schedule id required' });
      validateSchedule(body);
      const rows = await sb(
        `tapee_menu_schedules?id=eq.${body.id}&venue_id=eq.${venueId}`,
        {
          method: 'PATCH',
          prefer: 'return=representation',
          body: JSON.stringify({
            name:         body.name.trim(),
            days_of_week: body.days_of_week,
            start_time:   body.start_time,
            end_time:     body.end_time,
            is_active:    body.is_active !== false,
            sort_order:   body.sort_order ?? 0,
            updated_at:   new Date().toISOString(),
          }),
        }
      );
      if (!rows.length) return json(404, { error: 'Schedule not found' });
      return json(200, { schedule: rows[0] });
    }

    // ── Soft delete schedule ──────────────────────────
    if (method === 'DELETE' && action === 'delete_schedule') {
      if (!body.id) return json(400, { error: 'schedule id required' });
      await sb(
        `tapee_menu_schedules?id=eq.${body.id}&venue_id=eq.${venueId}`,
        {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ deleted_at: new Date().toISOString() }),
        }
      );
      return json(200, { success: true });
    }

    // ── Assign item to schedule ───────────────────────
    if (method === 'POST' && action === 'assign_item') {
      const { item_id, schedule_id, price_override_cents, available_override } = body;
      if (!item_id || !schedule_id) return json(400, { error: 'item_id and schedule_id required' });
      const rows = await sb('tapee_menu_item_schedules', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          item_id, schedule_id,
          venue_id: venueId,
          price_override_cents: price_override_cents ?? null,
          available_override:   available_override   ?? null,
        }),
      });
      return json(201, { assignment: rows[0] });
    }

    // ── Unassign item from schedule ───────────────────
    if (method === 'DELETE' && action === 'unassign_item') {
      const { item_id, schedule_id } = body;
      if (!item_id || !schedule_id) return json(400, { error: 'item_id and schedule_id required' });
      await sb(
        `tapee_menu_item_schedules?item_id=eq.${item_id}&schedule_id=eq.${schedule_id}&venue_id=eq.${venueId}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      );
      return json(200, { success: true });
    }

    // ── Update item override per schedule ─────────────
    if (method === 'PUT' && action === 'item_override') {
      const { item_id, schedule_id, price_override_cents, available_override } = body;
      if (!item_id || !schedule_id) return json(400, { error: 'item_id and schedule_id required' });
      const rows = await sb(
        `tapee_menu_item_schedules?item_id=eq.${item_id}&schedule_id=eq.${schedule_id}&venue_id=eq.${venueId}`,
        {
          method: 'PATCH',
          prefer: 'return=representation',
          body: JSON.stringify({
            price_override_cents: price_override_cents ?? null,
            available_override:   available_override   ?? null,
          }),
        }
      );
      return json(200, { assignment: rows[0] });
    }

    // ── Set item menu_type (all_day vs scheduled) ─────
    if (method === 'PUT' && action === 'set_menu_type') {
      const { item_id, menu_type } = body;
      if (!item_id) return json(400, { error: 'item_id required' });
      if (!['all_day','scheduled'].includes(menu_type))
        return json(400, { error: 'menu_type must be all_day or scheduled' });
      await sb(
        `tapee_menu_items?id=eq.${item_id}&venue_id=eq.${venueId}`,
        {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ menu_type, updated_at: new Date().toISOString() }),
        }
      );
      return json(200, { success: true });
    }

    return json(400, { error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('menu-admin error:', e.message);
    const status = e.message.includes('not found') || e.message.includes('mismatch') ? 403 : 500;
    return json(status, { error: e.message });
  }
};

export default withLambda(handler);
