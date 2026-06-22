// netlify/functions/smflow-meta-deauthorize.js
//
// Meta calls this URL (POST, application/x-www-form-urlencoded) whenever a
// person deauthorizes SMflow from their Facebook/Instagram account — e.g.
// by removing it directly from their Facebook Settings, NOT through our own
// "Disconnect" button. Without this, SMflow would keep believing the
// account is still connected and keep trying (and failing) to publish to it.
//
// Required by Meta App Review: Settings → Facebook Login for Business →
// "Deauthorize callback URL".
// Docs: https://developers.facebook.com/docs/facebook-login/web/deauthorization-callback/
//
// Meta sends a single field, `signed_request`, containing the user_id and
// algorithm, signed with our App Secret — we verify the signature before
// trusting anything in it, so a forged request can't deactivate someone
// else's account data.

const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const META_APP_SECRET      = process.env.META_APP_SECRET;

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

// Base64url decode (Meta's signed_request uses URL-safe base64, no padding)
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
    console.error('META_APP_SECRET not configured — cannot verify deauthorize request');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  try {
    // Meta posts this as application/x-www-form-urlencoded: signed_request=...
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
    const confirmationCode = `smflow_deauth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let accountsAffected = 0;
    let logStatus = 'completed';
    let logError = null;

    if (facebookUserId) {
      // Deactivate every social account row tied to this Facebook user ID,
      // across both 'facebook' and 'instagram' platforms (a single FB login
      // can have connected both, across multiple tenants if the same person
      // manages Pages for more than one SMflow client). fb_user_id — not
      // platform_account_id — is what matches here: platform_account_id
      // stores the Page/IG Business Account id, but Meta's deauthorize
      // webhook only ever sends the person's own Facebook user id.
      //
      // Prefer: return=representation (not the usual return=minimal) so we
      // get back the affected rows and can log a real count below, rather
      // than just trusting the call "probably worked".
      try {
        const affected = await sb(`smflow_social_accounts?fb_user_id=eq.${facebookUserId}&platform=in.(facebook,instagram)`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: { is_active: false, updated_at: new Date().toISOString() },
        });
        accountsAffected = Array.isArray(affected) ? affected.length : 0;
      } catch (err) {
        // Log but don't fail the response — Meta expects a 200 regardless,
        // and we'd rather have a quiet DB inconsistency than have Meta
        // retry-storm this endpoint or flag it as broken.
        console.error('Failed to deactivate account after deauthorize:', err.message);
        logStatus = 'failed';
        logError  = err.message.slice(0, 500);
      }
    }

    // Audit trail: every deauthorization event gets a durable record,
    // regardless of whether the account-deactivation step succeeded — if
    // someone (the client, or Meta support) later asks "did SMflow actually
    // process this", there's a real row to point to, not just a log line
    // that scrolled away.
    await sb('smflow_deauthorize_log', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        confirmation_code: confirmationCode,
        fb_user_id:        facebookUserId || null,
        accounts_affected: accountsAffected,
        status:            logStatus,
        error_message:     logError,
      },
    }).catch(err => console.error('Failed to write deauthorize audit log:', err.message));

    // Meta's docs: respond with a JSON object containing a confirmation_code.
    // It can be any string we choose to log against, used only if the person
    // contacts Meta support referencing this deauthorization.
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ confirmation_code: confirmationCode }),
    };
  } catch (err) {
    console.error('Deauthorize callback error:', err.message);
    // Still return 200 — Meta doesn't need our internal errors, and the
    // alternative (4xx/5xx) just causes Meta to retry this same ping.
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ confirmation_code: 'error_logged' }) };
  }
};
