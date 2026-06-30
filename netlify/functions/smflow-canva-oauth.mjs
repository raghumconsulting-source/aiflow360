import { withLambda } from '@netlify/aws-lambda-compat';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

// netlify/functions/smflow-canva-oauth.mjs
// Initiates the Canva Connect API OAuth flow for a tenant.
// GET ?tenant_id=
//
// Canva's OAuth requires PKCE (Proof Key for Code Exchange) — mandatory,
// unlike every other OAuth integration in this codebase. This means a
// code_verifier must be generated here, persisted somewhere reachable by
// the callback step, and presented again there to complete the token
// exchange. Netlify functions are stateless between invocations, so the
// verifier is stored in smflow_canva_pkce, keyed by a random `state` value
// that round-trips through Canva's redirect.

const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID;
const SITE_URL         = 'https://aiflow360.com';
const CALLBACK_URL     = `${SITE_URL}/.netlify/functions/smflow-canva-callback`;

// Minimum scopes for: upload a photo as an asset, create a design that uses
// it, let the person edit, then read the design back to export it.
// No comment/folder/brand-template/admin scopes — none of those are used.
const CANVA_SCOPES = [
  'asset:read',
  'asset:write',
  'design:meta:read',
  'design:content:read',
  'design:content:write',
].join(' ');

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// PKCE code_verifier: high-entropy random string, 43-128 chars per spec.
// base64url alphabet, no padding.
function generateCodeVerifier() {
  return crypto.randomBytes(64).toString('base64url').slice(0, 128);
}

// code_challenge = base64url(sha256(code_verifier)) — Canva requires S256.
function deriveCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const tenantId = event.queryStringParameters?.tenant_id;
  if (!tenantId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id is required' }) };
  }
  if (!CANVA_CLIENT_ID) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'CANVA_CLIENT_ID is not configured' }) };
  }

  const supabase = getSupabase();
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  // state doubles as the PKCE row's primary key and Canva's CSRF-protection
  // value — must be unguessable, same entropy requirement either way.
  const state = crypto.randomBytes(24).toString('base64url');

  const { error: insertError } = await supabase
    .from('smflow_canva_pkce')
    .insert({ state, tenant_id: tenantId, code_verifier: codeVerifier });

  if (insertError) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Could not start Canva connection: ${insertError.message}` }) };
  }

  // Best-effort cleanup of abandoned flows older than 10 minutes — not load
  // bearing for this request, so failures here are swallowed rather than
  // blocking the actual redirect.
  try {
    await supabase
      .from('smflow_canva_pkce')
      .delete()
      .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  } catch (_) { /* non-fatal */ }

  const authUrl = new URL('https://www.canva.com/api/oauth/authorize');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 's256');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CANVA_CLIENT_ID);
  authUrl.searchParams.set('scope', CANVA_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', CALLBACK_URL);

  return {
    statusCode: 302,
    headers: { ...HEADERS, Location: authUrl.toString() },
    body: '',
  };
};

export default withLambda(handler);
