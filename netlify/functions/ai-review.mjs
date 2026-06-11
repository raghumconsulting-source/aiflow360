import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * Netlify Function: ai-review
 * Deploy path: netlify/functions/ai-review.js
 * Called via:  POST /.netlify/functions/ai-review
 */

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, opts = {}) {
  const method = opts.method || 'GET';
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        opts.prefer || '',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sb ${method} ${path}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed;
}

async function rpc(fn, params) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${fn}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { system, messages, venueId, tenantId, reviewSessionId, kpi_scores, saveReview } = body;

  if (!system || !messages) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing system or messages' }) };
  }

  try {
    // ── Fetch active venue KPIs ─────────────────────────
    let venueKpis     = [];
    let venueIndustry = null;
    let venueBizType  = null;

    if (venueId && SB_URL && SB_KEY) {
      try {
        const [rawKpis, venueRows] = await Promise.all([
          sb(
            `venue_kpis?venue_id=eq.${venueId}&is_active=neq.false` +
            `&select=id,custom_label,custom_description,target_score,` +
            `kpi_definition:kpi_definitions(kpi_name,description,icon_name,color_hex)` +
            `&order=sort_order`
          ),
          sb(`venues?id=eq.${venueId}&select=industry_code,business_type_code&limit=1`),
        ]);

        venueIndustry = venueRows[0]?.industry_code      || null;
        venueBizType  = venueRows[0]?.business_type_code || null;

        venueKpis = rawKpis.map(vk => ({
          id:          vk.id,
          kpi_name:    vk.custom_label || vk.kpi_definition?.kpi_name || 'KPI',
          description: vk.custom_description || vk.kpi_definition?.description || '',
          icon:        vk.kpi_definition?.icon_name || 'ti-star',
          color:       vk.kpi_definition?.color_hex || '#5F5E5A',
          targetScore: vk.target_score || 4.0,
        }));

        // Auto-seed KPIs if venue has industry/biz type but no tiles yet
        if (venueKpis.length === 0 && venueIndustry && venueBizType) {
          console.log(`Auto-seeding KPIs for ${venueId}: ${venueIndustry}/${venueBizType}`);
          try {
            await rpc('seed_venue_kpis', {
              p_tenant_id: tenantId,
              p_venue_id:  venueId,
              p_industry:  venueIndustry,
              p_biz_type:  venueBizType,
            });
            const reseeded = await sb(
              `venue_kpis?venue_id=eq.${venueId}&is_active=neq.false` +
              `&select=id,custom_label,custom_description,target_score,` +
              `kpi_definition:kpi_definitions(kpi_name,description,icon_name,color_hex)` +
              `&order=sort_order`
            );
            venueKpis = reseeded.map(vk => ({
              id:          vk.id,
              kpi_name:    vk.custom_label || vk.kpi_definition?.kpi_name || 'KPI',
              description: vk.custom_description || vk.kpi_definition?.description || '',
              icon:        vk.kpi_definition?.icon_name || 'ti-star',
              color:       vk.kpi_definition?.color_hex || '#5F5E5A',
              targetScore: vk.target_score || 4.0,
            }));
          } catch (seedErr) {
            console.warn('Auto-seed non-fatal:', seedErr.message);
          }
        }
      } catch (kpiErr) {
        console.warn('venue_kpis fetch non-fatal:', kpiErr.message);
      }
    }

    // ── Enrich system prompt with KPI names ───────────────
    let enrichedSystem = system;
    if (venueKpis.length > 0) {
      enrichedSystem = system +
        '\n\nACTIVE KPIs FOR THIS VENUE (weave into conversation naturally):\n' +
        venueKpis.map(k => `- ${k.kpi_name}${k.description ? ': ' + k.description : ''}`).join('\n') +
        '\n\nIn your final JSON, include "discovered_topics": [] — add any topics the guest raised ' +
        'NOT already in the KPI list. Max 3. Each: { "label": "...", "topic_key": "snake_case", ' +
        '"confidence": 0.0-1.0, "context": "brief quote" }';
    }

    // ── Call Anthropic ────────────────────────────────────
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:     enrichedSystem,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', JSON.stringify(errData));
      return {
        statusCode: anthropicRes.status,
        headers:    HEADERS,
        body:       JSON.stringify({ error: 'AI service error', detail: errData?.error?.message }),
      };
    }

    const data = await anthropicRes.json();

    // ── Parse Claude response for discovered_topics ───────
    let parsedResponse = null;
    try {
      const rawText   = data.content?.[0]?.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsedResponse = JSON.parse(jsonMatch[0]);
    } catch { /* plain text mid-conversation — not an error */ }

    // ── Process discovered_topics (non-blocking) ──────────
    if (parsedResponse?.discovered_topics?.length > 0 && venueId && tenantId) {
      const activeKeys = new Set(venueKpis.map(k => k.kpi_name.toLowerCase().replace(/\s+/g, '_')));
      for (const topic of parsedResponse.discovered_topics) {
        try {
          if (activeKeys.has(topic.topic_key)) continue;
          const existing = await sb(
            `discovered_topics?venue_id=eq.${venueId}&topic_key=eq.${encodeURIComponent(topic.topic_key)}&select=status&limit=1`
          );
          if (existing[0]?.status === 'rejected') continue;
          await rpc('upsert_discovered_topic', {
            p_venue_id: venueId, p_tenant_id: tenantId,
            p_industry_code: venueIndustry, p_business_type: venueBizType,
            p_label: topic.label, p_topic_key: topic.topic_key,
            p_confidence: topic.confidence || 0.7,
            p_context: topic.context || '',
            p_session_id: reviewSessionId || null,
          });
          const tagExists = await sb(
            `tag_bank?venue_id=eq.${venueId}&topic=eq.${encodeURIComponent(topic.topic_key)}&select=id&limit=1`
          );
          if (!tagExists[0]) {
            await sb('tag_bank', {
              method: 'POST', prefer: 'return=minimal',
              body: {
                venue_id: venueId, tenant_id: tenantId,
                label: topic.label, topic: topic.topic_key,
                is_active: false, is_default: false,
                is_ai_discovered: true,
                confidence: topic.confidence || 0.7,
                sort_order: 999,
              },
            });
          }
        } catch (topicErr) {
          console.warn('discovered_topic non-fatal:', topicErr.message);
        }
      }
    }

    // ── Save kpi_responses on final submit ────────────────
    if (saveReview && kpi_scores && venueId && tenantId && reviewSessionId) {
      try {
        const kpiRows = Object.entries(kpi_scores)
          .filter(([, score]) => score > 0)
          .map(([venue_kpi_id, score]) => ({
            review_session_id: reviewSessionId,
            venue_kpi_id,
            venue_id:    venueId,
            tenant_id:   tenantId,
            score:       parseFloat(score),
            collected_via: 'widget_tile',
            created_at:  new Date().toISOString(),
          }));
        if (kpiRows.length > 0) {
          await sb('kpi_responses', { method: 'POST', prefer: 'return=minimal', body: kpiRows });
        }
      } catch (kpiSaveErr) {
        console.warn('kpi_responses save non-fatal:', kpiSaveErr.message);
      }
    }

    // ── Log token usage (fire and forget) ────────────────
    if (venueId) {
      sb('token_usage_log', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          tenant_id: tenantId || null, venue_id: venueId,
          model: 'claude-haiku-4-5-20251001',
          input_tokens:  data.usage?.input_tokens  || 0,
          output_tokens: data.usage?.output_tokens || 0,
          call_type: 'guest_review_chat',
        },
      }).catch(e => console.warn('Token log non-fatal:', e.message));
    }

    // ── Return Claude response + activeKpis ──────────────
    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        ...data,
        activeKpis: venueKpis.map(k => ({
          id:          k.id,
          name:        k.kpi_name,
          icon:        k.icon,
          color:       k.color,
          targetScore: k.targetScore,
        })),
      }),
    };

  } catch (err) {
    console.error('ai-review error:', err.message);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: 'Internal error', detail: err.message }),
    };
  }
};

export default withLambda(handler);
