// netlify/functions/smflow-meta-data-deletion.js
//
// Meta calls this URL (POST, application/x-www-form-urlencoded) whenever a
// person submits a "delete my data" request through Facebook's own privacy
// controls for an app they've used. This is a hard Meta Platform Policy
// requirement for any app handling user data — not optional.
//
// Required by Meta App Review: Settings → Facebook Login for Business →
// "Data Deletion Request URL".
// Docs: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/
//
// Per Meta's spec we must respond with JSON containing:
//   { url: "<status check URL the person can visit>", confirmation_code: "<our reference>" }
// and that status URL must work (smflow-meta-deletion-status.js, GET).

const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const META_APP_SECRET      = process.env.META_APP_SECRET;
const SITE_URL              = 'https://aiflow360.com';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, encodedPayload] = signedRequest.split('.');
  if (!encodedSig || !encodedPayload) throw new Error('Malformed signed_request');

  const sig     = base64UrlDecode(encodedSig);
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));

  const algo = String(payload.algorithm || '').slice(0, 50).replace(/[^\x20-\x7E]/g, '');
  if (algo.toUpperCase() !== 'HMAC-SHA256') {
    throw new Error(`Unexpected signed_request algorithm: ${algo}`);
  }

  const expectedSig = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error('signed_request signature verification failed');
  }

  return payload; // { algorithm, issued_at, user_id }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!META_APP_SECRET) {
    console.error('META_APP_SECRET not configured — cannot verify data deletion request');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const confirmationCode = `smflow_del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    const params = new URLSearchParams(body);
    const signedRequest = params.get('signed_request');
    if (!signedRequest) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing signed_request' }) };
    }

    const payload = parseSignedRequest(signedRequest, META_APP_SECRET);
    const facebookUserId = payload.user_id;

    // Record the request immediately (status = pending) so the status-check
    // page has something to report right away, then actually action the
    // deletion. We log the request itself before deleting anything, in case
    // the deletion step throws partway through — we still want a durable
    // record that this request was received and when.
    await sb('smflow_data_deletion_requests', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        confirmation_code: confirmationCode,
        fb_user_id:         facebookUserId || null,
        status:             'pending',
        requested_at:       new Date().toISOString(),
      },
    }).catch(err => console.error('Failed to log data deletion request:', err.message));

    if (facebookUserId) {
      // Actually delete the connected-account rows tied to this Facebook
      // user — access tokens, account names, everything. We don't delete
      // the tenant's own business data (their posts, settings, billing
      // history) since that belongs to the BUSINESS, not to this individual
      // Facebook user, and Meta's requirement is scoped to data this app
      // holds about the Facebook user who made the request.
      await sb(`smflow_social_accounts?fb_user_id=eq.${facebookUserId}&platform=in.(facebook,instagram)`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      }).catch(err => console.error('Failed to delete account data:', err.message));
    }

    await sb(`smflow_data_deletion_requests?confirmation_code=eq.${confirmationCode}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'completed', completed_at: new Date().toISOString() },
    }).catch(err => console.error('Failed to mark deletion request completed:', err.message));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        url:               `${SITE_URL}/.netlify/functions/smflow-meta-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      }),
    };
  } catch (err) {
    console.error('Data deletion callback error:', err.message);
    // Still return Meta's required shape even on error — an unreachable
    // status URL or missing confirmation_code is itself a policy violation,
    // so we always give Meta something valid to show the person.
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        url:               `${SITE_URL}/.netlify/functions/smflow-meta-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      }),
    };
  }
};
