import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-approve.js
// GET  ?tenant_id=&week_start= → returns weekly batch for approval queue
// POST actions: approve | reject | edit | bulk_approve | submit_for_approval

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

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  // ── GET: approval queue for a week ───────────────────
  if (event.httpMethod === 'GET') {
    if (!tenantId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      // Default: current week's pending_approval posts
      // week_start = ISO date string e.g. '2025-01-06'
      const weekStart = params.week_start
        ? new Date(params.week_start)
        : getWeekStart(new Date());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      let query = `smflow_posts?tenant_id=eq.${tenantId}&is_saved=eq.true`;

      // Filter by week if scheduled_at exists, else by created_at
      query += `&created_at=gte.${weekStart.toISOString()}`;
      query += `&created_at=lt.${weekEnd.toISOString()}`;
      query += `&order=scheduled_at.asc.nullslast,created_at.asc`;

      const posts = await sb(query);

      // Group by day for the weekly view
      const byDay = {};
      const days  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      days.forEach(d => { byDay[d] = []; });

      posts.forEach(post => {
        const date = new Date(post.scheduled_at || post.created_at);
        const day  = days[date.getDay() === 0 ? 6 : date.getDay() - 1]; // Mon=0
        if (byDay[day]) byDay[day].push(post);
      });

      // Summary counts
      const summary = {
        total:            posts.length,
        pending_approval: posts.filter(p => p.status === 'pending_approval').length,
        approved:         posts.filter(p => p.status === 'approved').length,
        draft:            posts.filter(p => p.status === 'draft').length,
        rejected:         posts.filter(p => p.status === 'rejected').length,
        scheduled:        posts.filter(p => p.status === 'scheduled').length,
        published:        posts.filter(p => p.status === 'published').length,
      };

      return {
        statusCode: 200,
        headers:    HEADERS,
        body:       JSON.stringify({
          posts,
          by_day:     byDay,
          summary,
          week_start: weekStart.toISOString(),
          week_end:   weekEnd.toISOString(),
        }),
      };
    } catch (err) {
      console.error('smflow-approve GET error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: approval actions ────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, tenant_id, user_id } = body;
    if (!tenant_id) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      const now = new Date().toISOString();

      // ── approve: approve a single post ───────────────
      if (action === 'approve') {
        const { post_id, approval_note, scheduled_at } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id,status&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            status:       'approved',
            approved_at:  now,
            approved_by:  user_id || null,
            approval_note: approval_note || null,
            ...(scheduled_at && { scheduled_at, status: 'scheduled' }),
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, status: scheduled_at ? 'scheduled' : 'approved' }) };
      }

      // ── reject: reject a post with reason ────────────
      if (action === 'reject') {
        const { post_id, reject_reason } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            status:        'rejected',
            reject_reason: reject_reason || null,
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── edit: update post content inline ─────────────
      if (action === 'edit') {
        const { post_id, content, image_url, canva_url, scheduled_at } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            ...(content      !== undefined && { content }),
            ...(image_url    !== undefined && { image_url }),
            ...(canva_url    !== undefined && { canva_url }),
            ...(scheduled_at !== undefined && { scheduled_at }),
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── bulk_approve: approve all pending posts ───────
      if (action === 'bulk_approve') {
        const { post_ids } = body; // optional: array of IDs, else approve all pending

        let query = `smflow_posts?tenant_id=eq.${tenant_id}&is_saved=eq.true`;
        if (post_ids?.length) {
          query += `&id=in.(${post_ids.join(',')})`;
        } else {
          query += `&status=eq.pending_approval`;
        }

        await sb(query, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            status:      'approved',
            approved_at: now,
            approved_by: user_id || null,
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── submit_for_approval: move draft → pending ─────
      if (action === 'submit_for_approval') {
        const { post_ids } = body;

        let query = `smflow_posts?tenant_id=eq.${tenant_id}&is_saved=eq.true&status=eq.draft`;
        if (post_ids?.length) {
          query += `&id=in.(${post_ids.join(',')})`;
        }

        await sb(query, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body:   { status: 'pending_approval' },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return {
        statusCode: 400,
        headers:    HEADERS,
        body:       JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('smflow-approve POST error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

// ── Helper: get Monday of current week ────────────────────
function getWeekStart(date) {
  const d   = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Mon
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default withLambda(handler);
