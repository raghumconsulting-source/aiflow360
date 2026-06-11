import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-config.js
// GET  ?tenant_id=  → returns smflow_brand_config (seeds if first time)
// POST { action:'save', tenant_id, ...fields } → upsert brand config

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

  // ── GET: return config (seed if missing) ─────────────
  if (event.httpMethod === 'GET') {
    if (!tenantId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      let rows = await sb(`smflow_brand_config?tenant_id=eq.${tenantId}&limit=1`);

      // First time — seed defaults then re-fetch
      if (!rows.length) {
        console.log(`Seeding smflow defaults for tenant ${tenantId}`);
        try {
          await rpc('seed_smflow_defaults', { p_tenant_id: tenantId });
        } catch (seedErr) {
          console.warn('seed_smflow_defaults non-fatal:', seedErr.message);
        }
        rows = await sb(`smflow_brand_config?tenant_id=eq.${tenantId}&limit=1`);
      }

      // Also pull tenant branding so dashboard can use it
      const tenantRows = await sb(
        `tenants?id=eq.${tenantId}&select=display_name,logo_url,primary_color,industry_code,business_type_code,products&limit=1`
      );

      // Optionally include social accounts — uses service key server-side, bypasses RLS anon restriction
      let socialAccounts;
      if (params.include === 'social_accounts') {
        socialAccounts = await sb(
          `smflow_social_accounts?tenant_id=eq.${tenantId}&is_active=eq.true` +
          `&select=platform,account_name,is_verified,connected_at&order=connected_at.asc`
        );
      }

      return {
        statusCode: 200,
        headers:    HEADERS,
        body:       JSON.stringify({
          config:  rows[0] || null,
          tenant:  tenantRows[0] || null,
          ...(socialAccounts !== undefined && { social_accounts: socialAccounts }),
        }),
      };
    } catch (err) {
      console.error('smflow-config GET error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: save config ─────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, tenant_id } = body;
    if (!tenant_id) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    if (action === 'save') {
      try {
        const {
          brand_voice, target_audience, extra_context,
          default_guru, active_platforms,
          flavor_excludes, jab_hook_ratio,
          canva_design_type, enabled_features,
        } = body;

        // Check if row exists
        const existing = await sb(`smflow_brand_config?tenant_id=eq.${tenant_id}&select=id&limit=1`);

        const payload = {
          tenant_id,
          ...(brand_voice       !== undefined && { brand_voice }),
          ...(target_audience   !== undefined && { target_audience }),
          ...(extra_context     !== undefined && { extra_context }),
          ...(default_guru      !== undefined && { default_guru }),
          ...(active_platforms  !== undefined && { active_platforms }),
          ...(flavor_excludes   !== undefined && { flavor_excludes }),
          ...(jab_hook_ratio    !== undefined && { jab_hook_ratio }),
          ...(canva_design_type !== undefined && { canva_design_type }),
          ...(enabled_features  !== undefined && { enabled_features }),
          updated_at: new Date().toISOString(),
        };

        if (existing.length) {
          // Update
          await sb(`smflow_brand_config?tenant_id=eq.${tenant_id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body:   payload,
          });
        } else {
          // Insert
          await sb('smflow_brand_config', {
            method: 'POST',
            prefer: 'return=minimal',
            body:   payload,
          });
        }

        // Audit log
        await sb('audit_logs', {
          method: 'POST',
          prefer: 'return=minimal',
          body: {
            tenant_id,
            action:        'update',
            resource_type: 'smflow_brand_config',
            metadata:      { source: 'settings' },
          },
        }).catch(e => console.warn('audit log non-fatal:', e.message));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      } catch (err) {
        console.error('smflow-config save error:', err.message);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
      }
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

export default withLambda(handler);
