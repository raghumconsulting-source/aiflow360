import { withLambda } from '@netlify/aws-lambda-compat';
import { createClient } from '@supabase/supabase-js';

// netlify/functions/smflow-canva-callback.mjs
// Completes the Canva Connect API PKCE OAuth flow.
// GET ?code=&state=  (sent by Canva after the person approves access)

const CANVA_CLIENT_ID     = process.env.CANVA_CLIENT_ID;
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const SITE_URL            = 'https://aiflow360.com';
const CALLBACK_URL        = `${SITE_URL}/.netlify/functions/smflow-canva-callback`;
const DASHBOARD_URL       = `${SITE_URL}/smflow-app/dashboard.html`;

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

function redirectToDashboard(params) {
  const url = new URL(DASHBOARD_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { statusCode: 302, headers: { ...HEADERS, Location: url.toString() }, body: '' };
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const basicAuth = Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri:  CALLBACK_URL,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Canva token exchange failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getCanvaProfile(accessToken) {
  const res = await fetch('https://api.canva.com/rest/v1/users/me', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Non-fatal — the connection itself still works without a display name,
    // it just shows generically in the dashboard instead of by team/user id.
    return {};
  }
  return res.json();
}

const handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const code  = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  const error = event.queryStringParameters?.error;

  if (error) {
    return redirectToDashboard({ canva_error: `Canva access was not granted (${error})` });
  }
  if (!code || !state) {
    return redirectToDashboard({ canva_error: 'Canva did not return the expected authorization code' });
  }

  const supabase = getSupabase();

  // Retrieve the code_verifier we stored when the flow started, keyed by
  // the same `state` value Canva is now handing back to us.
  const { data: pkceRow, error: pkceError } = await supabase
    .from('smflow_canva_pkce')
    .select('tenant_id, code_verifier, created_at')
    .eq('state', state)
    .single();

  if (pkceError || !pkceRow) {
    return redirectToDashboard({ canva_error: 'This Canva connection request has expired or was already used — please try connecting again' });
  }

  // One-time use: delete immediately so a replayed/duplicated callback
  // request can't reuse the same verifier.
  await supabase.from('smflow_canva_pkce').delete().eq('state', state);

  const tenStateMinutesMs = 10 * 60 * 1000;
  if (Date.now() - new Date(pkceRow.created_at).getTime() > tenStateMinutesMs) {
    return redirectToDashboard({ canva_error: 'This Canva connection request took too long and expired — please try connecting again' });
  }

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens(code, pkceRow.code_verifier);
  } catch (e) {
    return redirectToDashboard({ canva_error: `Canva connection failed: ${e.message}` });
  }

  const profile = await getCanvaProfile(tokenData.access_token);
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  const { error: upsertError } = await supabase
    .from('smflow_canva_config')
    .upsert({
      tenant_id:        pkceRow.tenant_id,
      canva_user_id:    profile.team_user?.user_id || null,
      canva_team_id:    profile.team_user?.team_id || null,
      access_token:     tokenData.access_token,
      refresh_token:    tokenData.refresh_token || null,
      token_expires_at: expiresAt,
      scope:            tokenData.scope || null,
      connected_by:     'tenant_self_serve',
      uninstalled_at:   null,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'tenant_id' });

  if (upsertError) {
    return redirectToDashboard({ canva_error: `Canva connected, but saving the connection failed: ${upsertError.message}` });
  }

  return redirectToDashboard({ canva_connected: '1' });
};

export default withLambda(handler);
