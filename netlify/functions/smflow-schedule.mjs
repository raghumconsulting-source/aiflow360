import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-schedule.js
// GET  ?tenant_id= → returns 4-week rotation (seeds if missing)
// POST actions: update_slot | reset | bulk_update

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed;
}

async function rpc(fn, params) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const DAY_ORDER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  // ── GET: return full 4-week rotation ─────────────────
  if (event.httpMethod === 'GET') {
    if (!tenantId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      let rows = await sb(
        `smflow_schedule?tenant_id=eq.${tenantId}&order=week_number.asc`
      );

      // Seed if missing
      if (!rows.length) {
        console.log(`Seeding smflow schedule for tenant ${tenantId}`);
        try {
          await rpc('seed_smflow_defaults', { p_tenant_id: tenantId });
        } catch (seedErr) {
          console.warn('seed_smflow_defaults non-fatal:', seedErr.message);
        }
        rows = await sb(
          `smflow_schedule?tenant_id=eq.${tenantId}&order=week_number.asc`
        );
      }

      // Sort each week's days in order
      rows.sort((a, b) => {
        if (a.week_number !== b.week_number) return a.week_number - b.week_number;
        return (DAY_ORDER[a.day_of_week] || 0) - (DAY_ORDER[b.day_of_week] || 0);
      });

      // Group by week for easy rendering
      const byWeek = { 1: [], 2: [], 3: [], 4: [] };
      rows.forEach(row => {
        if (byWeek[row.week_number]) byWeek[row.week_number].push(row);
      });

      return {
        statusCode: 200,
        headers:    HEADERS,
        body:       JSON.stringify({ schedule: rows, by_week: byWeek }),
      };
    } catch (err) {
      console.error('smflow-schedule GET error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: actions ─────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, tenant_id } = body;
    if (!tenant_id) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {

      // ── update_slot: upsert a single day slot ─────────
      if (action === 'update_slot') {
        const { week_number, day_of_week, flavor_id, flavor_name, platforms, is_active, post_time, note } = body;
        if (!week_number || !day_of_week) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'week_number and day_of_week required' }) };
        }

        // Check if slot exists
        const existing = await sb(
          `smflow_schedule?tenant_id=eq.${tenant_id}&week_number=eq.${week_number}&day_of_week=eq.${day_of_week}&select=id&limit=1`
        );

        const payload = {
          tenant_id,
          week_number,
          day_of_week,
          ...(flavor_id   !== undefined && { flavor_id }),
          ...(flavor_name !== undefined && { flavor_name }),
          ...(platforms   !== undefined && { platforms }),
          ...(is_active   !== undefined && { is_active }),
          ...(post_time   !== undefined && { post_time }),
          ...(note        !== undefined && { note }),
          updated_at: new Date().toISOString(),
        };

        if (existing.length) {
          await sb(
            `smflow_schedule?tenant_id=eq.${tenant_id}&week_number=eq.${week_number}&day_of_week=eq.${day_of_week}`,
            { method: 'PATCH', prefer: 'return=minimal', body: payload }
          );
        } else {
          await sb('smflow_schedule', {
            method: 'POST',
            prefer: 'return=minimal',
            body:   payload,
          });
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── reset: delete all and re-seed defaults ────────
      if (action === 'reset') {
        await sb(`smflow_schedule?tenant_id=eq.${tenant_id}`, { method: 'DELETE', prefer: '' });
        await rpc('seed_smflow_defaults', { p_tenant_id: tenant_id });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── bulk_update: update multiple slots at once ────
      if (action === 'bulk_update') {
        const { slots } = body; // array of { week_number, day_of_week, flavor_id, ... }
        if (!Array.isArray(slots) || !slots.length) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'slots array required' }) };
        }

        const now = new Date().toISOString();
        for (const slot of slots) {
          const { week_number, day_of_week, ...rest } = slot;
          if (!week_number || !day_of_week) continue;

          const existing = await sb(
            `smflow_schedule?tenant_id=eq.${tenant_id}&week_number=eq.${week_number}&day_of_week=eq.${day_of_week}&select=id&limit=1`
          );

          if (existing.length) {
            await sb(
              `smflow_schedule?tenant_id=eq.${tenant_id}&week_number=eq.${week_number}&day_of_week=eq.${day_of_week}`,
              { method: 'PATCH', prefer: 'return=minimal', body: { ...rest, updated_at: now } }
            );
          } else {
            await sb('smflow_schedule', {
              method: 'POST',
              prefer: 'return=minimal',
              body:   { tenant_id, week_number, day_of_week, ...rest, updated_at: now },
            });
          }
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, updated: slots.length }) };
      }

      // ── get_approved_queue: posts approved, not yet scheduled ──
      if (action === 'get_approved_queue') {
        const posts = await sb(
          `smflow_posts?tenant_id=eq.${tenant_id}&status=eq.approved&scheduled_at=is.null` +
          `&select=id,platform,content,flavor,image_url,status,created_at&order=created_at.desc&limit=50`
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ posts }) };
      }

      // ── schedule_post: assign scheduled_at + platforms to a post ──
      if (action === 'schedule_post') {
        const { post_id, scheduled_at, scheduled_platforms } = body;
        if (!post_id || !scheduled_at) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id and scheduled_at required' }) };
        }
        // Verify post belongs to tenant
        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };
        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            scheduled_at,
            status:     'scheduled',
            updated_at: new Date().toISOString(),
            ...(scheduled_platforms && { scheduled_platforms }),
          },
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── unschedule_post: remove scheduled_at, revert to approved ──
      if (action === 'unschedule_post') {
        const { post_id } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };
        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };
        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { scheduled_at: null, status: 'approved', updated_at: new Date().toISOString() },
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── get_calendar: posts scheduled within a date range, grouped by day ──
      if (action === 'get_calendar') {
        const { date_from, date_to } = body;
        if (!date_from || !date_to) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'date_from and date_to required' }) };
        }
        const posts = await sb(
          `smflow_posts?tenant_id=eq.${tenant_id}&status=in.(scheduled,published)` +
          `&scheduled_at=gte.${date_from}&scheduled_at=lte.${date_to}` +
          `&select=id,platform,content,flavor,image_url,status,scheduled_at,scheduled_platforms,published_at&order=scheduled_at.asc`
        );
        // Group by date (YYYY-MM-DD)
        const byDay = {};
        posts.forEach(p => {
          const day = p.scheduled_at?.slice(0, 10);
          if (day) { if (!byDay[day]) byDay[day] = []; byDay[day].push(p); }
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ posts, by_day: byDay }) };
      }

      return {
        statusCode: 400,
        headers:    HEADERS,
        body:       JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('smflow-schedule POST error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

export default withLambda(handler);
