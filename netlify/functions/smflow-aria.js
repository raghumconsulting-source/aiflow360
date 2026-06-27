// netlify/functions/smflow-aria.js
// POST { tenant_id, system, messages }
// Proxies ARIA chat requests through Netlify so ANTHROPIC_API_KEY
// stays server-side and never exposed to the browser.
// If tenant_id is provided, fetches real tenant + brand context and
// prepends it to the system prompt so ARIA's marketing-guru personas are
// grounded in the actual business, not operating in a vacuum.

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MODEL                = 'claude-haiku-4-5-20251001';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return [];
  try { return await res.json(); } catch { return []; }
}

// Fetches tenant + brand config in parallel and builds a short context block
// to prepend to the system prompt. Never throws -- any lookup failure (bad
// tenant_id, missing brand config row, network hiccup) just means ARIA falls
// back to its existing generic behavior, since this is a chat assistant, not
// a critical path.
async function buildTenantContext(tenantId) {
  if (!tenantId) return '';
  try {
    const [tenants, brandConfigs] = await Promise.all([
      sb(`tenants?id=eq.${tenantId}&select=name,industry_code,business_type_code&limit=1`),
      sb(`smflow_brand_config?tenant_id=eq.${tenantId}&select=brand_voice,target_audience,extra_context&limit=1`),
    ]);
    const tenant = tenants[0];
    if (!tenant) return '';

    const lines = [`BUSINESS CONTEXT (use this to ground your advice -- do not ignore it):`];
    lines.push(`- Business name: ${tenant.name}`);
    if (tenant.industry_code) lines.push(`- Industry: ${tenant.industry_code}${tenant.business_type_code ? ` / ${tenant.business_type_code}` : ''}`);

    const brand = brandConfigs[0];
    if (brand) {
      if (brand.brand_voice) lines.push(`- Brand voice: ${brand.brand_voice}`);
      if (brand.target_audience) lines.push(`- Target audience: ${brand.target_audience}`);
      if (brand.extra_context) lines.push(`- Additional context: ${brand.extra_context}`);
    }
    return lines.join('\n') + '\n\n';
  } catch (err) {
    console.warn('buildTenantContext failed (non-fatal):', err.message);
    return '';
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenant_id, system, messages } = body;

  if (!messages?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'messages required' }) };
  }

  try {
    const baseSystem = system || 'You are ARIA, an expert AI marketing agent for Australian SMBs.';
    const contextBlock = await buildTenantContext(tenant_id);
    const finalSystem = contextBlock + baseSystem;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 1000,
        system:     finalSystem,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Claude API ${res.status}: ${err?.error?.message || 'unknown error'}`);
    }

    const data  = await res.json();
    const reply = data.content?.[0]?.text?.trim() || '';

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        reply,
        input_tokens:  data.usage?.input_tokens  || 0,
        output_tokens: data.usage?.output_tokens || 0,
      }),
    };
  } catch (err) {
    console.error('smflow-aria error:', err.message);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: err.message }),
    };
  }
};
