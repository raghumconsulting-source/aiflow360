/**
 * Netlify Function: ai-review
 * Proxies requests to Anthropic API — API key NEVER touches the browser.
 *
 * Deploy path: netlify/functions/ai-review.js
 * Called via:  POST /.netlify/functions/ai-review
 *
 * Required Netlify environment variables:
 *   ANTHROPIC_API_KEY   = sk-ant-...
 *   SUPABASE_URL        = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY= eyJ...  (service role — only used server-side)
 */

export default async function handler(req) {
  /* CORS — allow only your domain in production */
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const body = await req.json();
    const { system, messages, venueId, tenantId } = body;

    if (!system || !messages) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers });
    }

    /* ── Call Anthropic ── */
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', err);
      return new Response(JSON.stringify({ error: 'AI service error', detail: err?.error?.message }), {
        status: anthropicRes.status, headers
      });
    }

    const data = await anthropicRes.json();

    /* ── Optional: log token usage to Supabase ── */
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && venueId) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/token_usage_log`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            tenant_id: tenantId || null,
            venue_id: venueId || null,
            model: 'claude-sonnet-4-20250514',
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0,
            feature: 'guest_review_chat',
          }),
        });
      } catch (logErr) {
        console.warn('Token log failed (non-fatal):', logErr);
      }
    }

    return new Response(JSON.stringify(data), { status: 200, headers });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}

export const config = { path: '/api/ai-review' };
