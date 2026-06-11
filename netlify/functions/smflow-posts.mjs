import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-posts.js
// GET  ?tenant_id=&limit=40&offset=0&platform=&flavor=&guru=&status=
//      → paginated post history with filters
// POST { action:'delete', tenant_id, post_id }
//      → soft delete (is_saved=false)
// POST { action:'stats', tenant_id }
//      → calls get_smflow_usage() for dashboard stats

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

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  // ── GET: list posts with filters ─────────────────────
  if (event.httpMethod === 'GET') {
    if (!tenantId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      const limit    = Math.min(parseInt(params.limit)  || 40, 100);
      const offset   = parseInt(params.offset) || 0;
      const platform = params.platform || '';
      const flavor   = params.flavor   || '';
      const guru     = params.guru     || '';
      const status   = params.status   || '';

      // Build query with optional filters
      let query = `smflow_posts?tenant_id=eq.${tenantId}&is_saved=eq.true`;
      if (platform) query += `&platform=eq.${encodeURIComponent(platform)}`;
      if (flavor)   query += `&flavor=eq.${encodeURIComponent(flavor)}`;
      if (guru)     query += `&guru=eq.${encodeURIComponent(guru)}`;
      if (status)   query += `&status=eq.${encodeURIComponent(status)}`;
      query += `&order=created_at.desc&limit=${limit}&offset=${offset}`;

      // Get total count for pagination
      const countQuery = query.replace(`&limit=${limit}&offset=${offset}`, '');
      const [posts, countRes] = await Promise.all([
        sb(query),
        fetch(`${SUPABASE_URL}/rest/v1/${countQuery}`, {
          headers: {
            'apikey':        SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Prefer':        'count=exact',
          },
        }),
      ]);

      const total = parseInt(countRes.headers.get('content-range')?.split('/')[1]) || posts.length;

      return {
        statusCode: 200,
        headers:    HEADERS,
        body:       JSON.stringify({ posts, total, limit, offset }),
      };
    } catch (err) {
      console.error('smflow-posts GET error:', err.message);
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

      // ── delete: soft delete a post ────────────────────
      if (action === 'delete') {
        const { post_id } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        // Verify ownership before deleting
        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) {
          return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };
        }

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body:   { is_saved: false },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── stats: usage analytics for dashboard ──────────
      if (action === 'stats') {
        const usage = await rpc('get_smflow_usage', { p_tenant_id: tenant_id });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ usage }) };
      }

      // ── update_image: save image URL back to post ──────
      if (action === 'update_image') {
        const { post_id, image_url } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        const check = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            image_url:  image_url || null,
            updated_at: new Date().toISOString(),
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── update_canva: save Canva URL back to post ─────
      if (action === 'update_canva') {
        const { post_id, canva_url, image_url } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            ...(canva_url !== undefined && { canva_url }),
            ...(image_url !== undefined && { image_url }),
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return {
        statusCode: 400,
        headers:    HEADERS,
        body:       JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('smflow-posts POST error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

export default withLambda(handler);
