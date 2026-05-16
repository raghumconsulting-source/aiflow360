/**
 * Netlify Function: ai-review
 * Proxies requests to Anthropic API — API key NEVER touches the browser.
 */
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { system, messages, venueId, tenantId } = body;

    if (!system || !messages) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', err);
      return { statusCode: anthropicRes.status, headers, body: JSON.stringify({ error: 'AI service error', detail: err?.error?.message }) };
    }

    const data = await anthropicRes.json();

    // Optional: log token usage to Supabase
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
            model: 'claude-sonnet-4-5',
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0,
            feature: 'guest_review_chat',
          }),
        });
      } catch (logErr) {
        console.warn('Token log failed (non-fatal):', logErr);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};