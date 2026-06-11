import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-aria.js
// POST { tenant_id, system, messages }
// Proxies ARIA chat requests through Netlify so ANTHROPIC_API_KEY
// stays server-side and never exposed to the browser.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL             = 'claude-haiku-4-5-20251001';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { system, messages } = body;

  if (!messages?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'messages required' }) };
  }

  try {
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
        system:     system || 'You are ARIA, an expert AI marketing agent for Australian SMBs.',
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

export default withLambda(handler);
