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
    console.log('Function invoked. Body type:', typeof event.body);
    console.log('API Key present:', !!process.env.ANTHROPIC_API_KEY);

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    if (!body) {
      console.error('Empty body received');
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Empty request body' }) };
    }

    const { system, messages, venueId, tenantId } = body;

    console.log('system present:', !!system, '| messages present:', !!messages);

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', JSON.stringify(err));
      return { statusCode: anthropicRes.status, headers, body: JSON.stringify({ error: 'AI service error', detail: err?.error?.message }) };
    }

    const data = await anthropicRes.json();
    console.log('Anthropic success. Tokens used:', data.usage?.input_tokens, '+', data.usage?.output_tokens);

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
            model: 'claude-haiku-4-5-20251001',
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0,
            feature: 'guest_review_chat',
          }),
        });
      } catch (logErr) {
        console.warn('Token log failed (non-fatal):', logErr.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error', detail: err.message }) };
  }
};