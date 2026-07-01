import { withLambda } from '@netlify/aws-lambda-compat';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

// netlify/functions/smflow-canva-return.mjs
// Called by the frontend right after the person clicks Canva's "Back to
// SMflow" button. Verifies the correlation_jwt Canva appended to the
// return URL, exports the now-edited design, and updates the post's
// image_url with the exported result.
//
// POST { tenant_id, correlation_jwt }

const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CANVA_KEYS_URL  = 'https://api.canva.com/rest/v1/connect/keys';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Verifies the correlation_jwt using Canva's JWKS endpoint and Node's native
// crypto module. Replaces the original jose-based implementation which failed
// because jose was never added to package.json, causing the deployed Lambda
// to crash on import before writing any response (manifested as a 502).
// Canva uses Ed25519/OKP keys (confirmed from their JWKS endpoint during
// the integration design phase), which Node's crypto.verify() handles
// natively since Node 15+ without any external library.
async function verifyCorrelationJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  // 1. Parse the header to get the key ID (kid) we need to verify with
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());

  // 2. Fetch Canva's public keys and find the matching one by kid
  const jwksRes = await fetch(CANVA_KEYS_URL);
  if (!jwksRes.ok) throw new Error(`Could not fetch Canva public keys (${jwksRes.status})`);
  const jwks = await jwksRes.json();
  const jwk = jwks.keys?.find(k => k.kid === header.kid);
  if (!jwk) throw new Error(`No matching key found for kid: ${header.kid}`);

  // 3. Import the JWK as a native CryptoKey and verify the signature
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  const signatureInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  const valid = await crypto.subtle.verify('Ed25519', key, signature, signatureInput);
  if (!valid) throw new Error('JWT signature verification failed — token may be forged or tampered');

  // 4. Parse and validate the payload
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

  // Expiry check
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT has expired');
  }
  // Audience check — must match our integration's client_id
  if (payload.aud !== CANVA_CLIENT_ID) {
    throw new Error(`JWT audience mismatch: expected ${CANVA_CLIENT_ID}, got ${payload.aud}`);
  }
  // Type check — must be a return-navigation token specifically
  if (payload.type !== 'rti') {
    throw new Error('Token is not a valid return-navigation token');
  }
  if (!payload.correlation_state) {
    throw new Error('Token did not include the expected correlation_state');
  }
  return payload;
}

async function getValidAccessToken(supabase, tenantId) {
  const { data: config, error } = await supabase
    .from('smflow_canva_config')
    .select('access_token, refresh_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .is('uninstalled_at', null)
    .single();

  if (error || !config) {
    throw new Error('No Canva account connected for this tenant');
  }

  const expiresAt = config.token_expires_at ? new Date(config.token_expires_at).getTime() : 0;
  if (Date.now() <= expiresAt - 60_000) {
    return config.access_token;
  }
  if (!config.refresh_token) {
    throw new Error('Canva connection has expired and cannot be automatically renewed — please reconnect Canva in Settings');
  }

  const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
  const basicAuth = Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refresh_token }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Could not refresh Canva access — please reconnect Canva in Settings');

  const newExpiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;
  await supabase
    .from('smflow_canva_config')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token || config.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  return data.access_token;
}

async function exportDesign(accessToken, designId) {
  const createRes = await fetch('https://api.canva.com/rest/v1/exports', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ design_id: designId, format: { type: 'png' } }),
  });
  const createData = await createRes.json();
  const jobId = createData.job?.id;
  if (!jobId) throw new Error(`Could not start the Canva export: ${JSON.stringify(createData)}`);

  const maxAttempts = 20;
  const delayMs = 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, delayMs));
    const pollRes = await fetch(`https://api.canva.com/rest/v1/exports/${jobId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const pollData = await pollRes.json();
    const status = pollData.job?.status;
    if (status === 'success') {
      const url = pollData.job?.urls?.[0];
      if (!url) throw new Error('Canva reported the export succeeded but did not return a download URL');
      return url;
    }
    if (status === 'failed') {
      throw new Error(`Canva export failed: ${pollData.job?.error?.message || 'unknown error'}`);
    }
  }
  throw new Error('Canva export took too long — please try exporting again from Canva directly');
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { tenant_id, correlation_jwt } = body;
  if (!tenant_id || !correlation_jwt) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id and correlation_jwt are required' }) };
  }

  let payload;
  try {
    payload = await verifyCorrelationJwt(correlation_jwt);
  } catch (e) {
    // A failed signature/audience check here means the token is either
    // forged, expired, or was never genuinely issued by Canva for this
    // integration — never trust an unverified correlation_state.
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: `Could not verify the return from Canva: ${e.message}` }) };
  }

  const postId = payload.correlation_state;
  const designId = payload.design_id;

  const supabase = getSupabase();
  let accessToken;
  try {
    accessToken = await getValidAccessToken(supabase, tenant_id);
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }

  let exportedUrl;
  try {
    exportedUrl = await exportDesign(accessToken, designId);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }

  const { error: updateError } = await supabase
    .from('smflow_posts')
    .update({ image_url: exportedUrl })
    .eq('id', postId)
    .eq('tenant_id', tenant_id); // belt-and-braces: never update a post outside this tenant

  if (updateError) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Export succeeded but saving it to the post failed: ${updateError.message}`, image_url: exportedUrl }) };
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ post_id: postId, image_url: exportedUrl }) };
};

export default withLambda(handler);
