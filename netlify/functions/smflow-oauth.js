// netlify/functions/smflow-oauth.js
// Initiates OAuth flow for all supported platforms
// GET ?tenant_id=&platform=facebook|linkedin|youtube&redirect_back=
//
// Each platform redirects to its own OAuth dialog.
// All platforms share the same callback: smflow-oauth-callback.js

const META_APP_ID       = process.env.META_APP_ID;
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const YOUTUBE_CLIENT_ID  = process.env.YOUTUBE_CLIENT_ID;
const SITE_URL           = 'https://aiflow360.com';
const CALLBACK_URL       = `${SITE_URL}/.netlify/functions/smflow-oauth-callback`;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Facebook + Instagram scopes ────────────────────────────
const FB_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
].join(',');

// ── LinkedIn scopes ────────────────────────────────────────
const LINKEDIN_SCOPES = [
  'openid',
  'profile',
  'email',
  'w_member_social',       // post on behalf of member
  'r_organization_social', // read org posts
  'w_organization_social', // post on behalf of org/page
  'rw_organization_admin', // manage org
].join(' ');

// ── YouTube / Google scopes ────────────────────────────────
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'openid',
  'email',
  'profile',
].join(' ');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params       = event.queryStringParameters || {};
  const tenantId     = params.tenant_id;
  const platform     = (params.platform || 'facebook').toLowerCase();
  const redirectBack = params.redirect_back || `${SITE_URL}/smflow-app/dashboard.html`;

  if (!tenantId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  }

  // Encode state — passed through OAuth, verified in callback
  const state = Buffer.from(JSON.stringify({
    tenant_id:     tenantId,
    platform,
    redirect_back: redirectBack,
    ts:            Date.now(),
  })).toString('base64');

  let oauthUrl;

  // ── Facebook / Instagram ───────────────────────────────
  if (platform === 'facebook' || platform === 'instagram') {
    if (!META_APP_ID) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'META_APP_ID not configured' }) };
    oauthUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    oauthUrl.searchParams.set('client_id',     META_APP_ID);
    oauthUrl.searchParams.set('redirect_uri',  CALLBACK_URL);
    oauthUrl.searchParams.set('scope',         FB_SCOPES);
    oauthUrl.searchParams.set('response_type', 'code');
    oauthUrl.searchParams.set('state',         state);
  }

  // ── LinkedIn ───────────────────────────────────────────
  else if (platform === 'linkedin') {
    if (!LINKEDIN_CLIENT_ID) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'LINKEDIN_CLIENT_ID not configured' }) };
    oauthUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
    oauthUrl.searchParams.set('response_type', 'code');
    oauthUrl.searchParams.set('client_id',     LINKEDIN_CLIENT_ID);
    oauthUrl.searchParams.set('redirect_uri',  CALLBACK_URL);
    oauthUrl.searchParams.set('scope',         LINKEDIN_SCOPES);
    oauthUrl.searchParams.set('state',         state);
  }

  // ── YouTube / Google ───────────────────────────────────
  else if (platform === 'youtube') {
    if (!YOUTUBE_CLIENT_ID) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'YOUTUBE_CLIENT_ID not configured' }) };
    oauthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    oauthUrl.searchParams.set('client_id',      YOUTUBE_CLIENT_ID);
    oauthUrl.searchParams.set('redirect_uri',   CALLBACK_URL);
    oauthUrl.searchParams.set('response_type',  'code');
    oauthUrl.searchParams.set('scope',          YOUTUBE_SCOPES);
    oauthUrl.searchParams.set('state',          state);
    oauthUrl.searchParams.set('access_type',    'offline');  // get refresh token
    oauthUrl.searchParams.set('prompt',         'consent');  // always show consent to ensure refresh token
  }

  else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unsupported platform: ${platform}` }) };
  }

  return {
    statusCode: 302,
    headers: { ...HEADERS, Location: oauthUrl.toString() },
    body: '',
  };
};
