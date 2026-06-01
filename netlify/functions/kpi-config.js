// netlify/functions/kpi-config.js
// GET  — returns venue_kpis list with joined kpi_definitions data
// POST — toggle, reorder, update_label, add_custom, delete, recalculate

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Supabase REST helper ──────────────────────────────────
async function sb(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
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

// ── RPC helper ───────────────────────────────────────────
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

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const params   = event.queryStringParameters || {};
  const venueId  = params.venue_id;
  const tenantId = params.tenant_id;

  if (!venueId || !tenantId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'venue_id and tenant_id required' }),
    };
  }

  // ── GET: list venue_kpis with definition data ─────────
  if (event.httpMethod === 'GET') {
    try {
      // Fetch venue_kpis joined with kpi_definitions
      const [venueKpis, venue] = await Promise.all([
        sb(
          `venue_kpis?venue_id=eq.${venueId}&is_active=neq.false` +
          `&select=*,kpi_definition:kpi_definitions(kpi_name,description,kpi_category,` +
          `measurement_method,icon_name,color_hex,weight)` +
          `&order=sort_order`
        ),
        sb(`venues?id=eq.${venueId}&select=industry_code,business_type_code&limit=1`),
      ]);

      // ── Auto-seed if no KPIs exist but venue has industry codes ──
      let finalKpis = venueKpis;
      if (venueKpis.length === 0 && venue[0]?.industry_code && venue[0]?.business_type_code) {
        console.log(`Auto-seeding KPIs for venue ${venueId}: ${venue[0].industry_code}/${venue[0].business_type_code}`);
        try {
          await rpc('seed_venue_kpis', {
            p_tenant_id: tenantId,
            p_venue_id:  venueId,
            p_industry:  venue[0].industry_code,
            p_biz_type:  venue[0].business_type_code,
          });
          // Re-fetch after seeding
          finalKpis = await sb(
            `venue_kpis?venue_id=eq.${venueId}&is_active=neq.false` +
            `&select=*,kpi_definition:kpi_definitions(kpi_name,description,kpi_category,` +
            `measurement_method,icon_name,color_hex,weight)` +
            `&order=sort_order`
          );
        } catch (seedErr) {
          console.warn('Auto-seed failed (non-fatal):', seedErr.message);
        }
      }

      // Flatten the join for easy consumption by frontend
      const kpis = finalKpis.map(vk => ({
        id:                 vk.id,
        kpi_definition_id:  vk.kpi_definition_id,
        kpi_name:           vk.custom_label || vk.kpi_definition?.kpi_name || 'Custom KPI',
        custom_label:       vk.custom_label,
        description:        vk.custom_description || vk.kpi_definition?.description || '',
        kpi_category:       vk.kpi_definition?.kpi_category || 'Custom',
        measurement_method: vk.kpi_definition?.measurement_method || '1-5 rating',
        icon_name:          vk.custom_icon || vk.kpi_definition?.icon_name || 'ti-star',
        color_hex:          vk.kpi_definition?.color_hex || '#5F5E5A',
        weight:             vk.kpi_definition?.weight || 5,
        is_active:          vk.is_active,
        sort_order:         vk.sort_order,
        target_score:       vk.target_score,
        current_avg:        vk.current_avg,
        total_responses:    vk.total_responses,
        trend:              vk.trend,
        is_custom:          vk.is_custom,
        source:             vk.source,
      }));

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          kpis,
          industry_code:  venue[0]?.industry_code || null,
          business_type:  venue[0]?.business_type_code || null,
        }),
      };
    } catch (err) {
      console.error('kpi-config GET error:', err.message);
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ── POST: actions ─────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { action } = body;

    try {

      // ── toggle: enable / disable a KPI tile ──────────
      if (action === 'toggle') {
        const { venue_kpi_id, is_active } = body;
        await sb(
          `venue_kpis?id=eq.${venue_kpi_id}&venue_id=eq.${venueId}`,
          { method: 'PATCH', body: { is_active, updated_at: new Date().toISOString() } }
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── reorder: update sort position ────────────────
      if (action === 'reorder') {
        const { venue_kpi_id, sort_order } = body;
        await sb(
          `venue_kpis?id=eq.${venue_kpi_id}&venue_id=eq.${venueId}`,
          { method: 'PATCH', body: { sort_order, updated_at: new Date().toISOString() } }
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── update_label: owner rename of a KPI tile ─────
      if (action === 'update_label') {
        const { venue_kpi_id, custom_label } = body;
        await sb(
          `venue_kpis?id=eq.${venue_kpi_id}&venue_id=eq.${venueId}`,
          { method: 'PATCH', body: { custom_label, updated_at: new Date().toISOString() } }
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── add_custom: owner-created KPI tile ───────────
      if (action === 'add_custom') {
        const { kpi_name, description, icon_name, color_hex, target_score } = body;
        if (!kpi_name) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'kpi_name required' }) };
        }

        // Get current max sort_order
        const existing = await sb(`venue_kpis?venue_id=eq.${venueId}&select=sort_order&order=sort_order.desc&limit=1`);
        const nextOrder = (existing[0]?.sort_order ?? -1) + 1;

        const inserted = await sb('venue_kpis', {
          method: 'POST',
          prefer: 'return=representation',
          body: {
            venue_id:           venueId,
            tenant_id:          tenantId,
            kpi_definition_id:  null,
            is_active:          true,
            is_custom:          true,
            source:             'owner',
            sort_order:         nextOrder,
            custom_label:       kpi_name,
            custom_description: description || null,
            custom_icon:        icon_name   || 'ti-star',
            target_score:       target_score || 4.0,
            created_at:         new Date().toISOString(),
            updated_at:         new Date().toISOString(),
          },
        });

        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify({ success: true, venue_kpi_id: inserted?.[0]?.id }),
        };
      }

      // ── delete: remove a CUSTOM KPI tile only ────────
      if (action === 'delete') {
        const { venue_kpi_id } = body;

        // Safety: only allow deleting custom (owner-created) tiles
        const check = await sb(`venue_kpis?id=eq.${venue_kpi_id}&venue_id=eq.${venueId}&select=is_custom&limit=1`);
        if (!check[0]) {
          return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'KPI not found' }) };
        }
        if (!check[0].is_custom) {
          return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Only custom KPIs can be deleted. Toggle off to hide seeded KPIs.' }) };
        }

        await sb(
          `venue_kpis?id=eq.${venue_kpi_id}&venue_id=eq.${venueId}`,
          { method: 'DELETE' }
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── recalculate: trigger score aggregation ────────
      if (action === 'recalculate') {
        await rpc('calculate_venue_kpi_scores', { p_venue_id: venueId });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('kpi-config POST error:', err.message);
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
