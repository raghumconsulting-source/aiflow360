import { withLambda } from '@netlify/aws-lambda-compat';

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

// Facebook Login for Business config_id — SMFLOW is a Business-type Meta
// app, which requires logins to go through a saved Configuration rather
// than a raw `scope` list. Meta's own docs say not to mix scope with
// config_id for Business-type apps, so FB_SCOPES (above) is now unused for
// this platform — kept only as a comment of which permissions the
// configuration itself grants, for reference:
//   pages_show_list, pages_manage_posts, pages_read_engagement,
//   business_management, instagram_basic, instagram_content_publish
// Configuration name: "SMflow Page and Instagram Publishing"
// Created via App Dashboard → Facebook Login for Business → Configurations
const META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID || '2182293842534897';

// ── LinkedIn scopes ────────────────────────────────────────
// Phase 1: Only OpenID scopes (always available) for initial connect
// Phase 2: Add w_member_social after enabling "Share on LinkedIn" product
//          in LinkedIn Developer Portal → Products tab
const LINKEDIN_SCOPES = [
  'openid',   // basic identity — always available
  'profile',  // name, photo — always available
  'email',    // email address — always available
].join(' ');

// Extended scopes for posting — requires "Share on LinkedIn" product enabled
// Once enabled in LinkedIn Developer Portal, change above to include 'w_member_social'
const LINKEDIN_POST_SCOPES = [
  'openid', 'profile', 'email', 'w_member_social',
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

// ── Google Drive scopes ─────────────────────────────────────
// drive.file: app can only see/manage files IT creates — not the client's
// whole Drive. This is the minimum-privilege scope for "create a folder
// for this client, under their own storage quota" and is what lets the
// consent screen avoid Google's sensitive-scope verification review that
// the full 'drive' scope would require.
const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
].join(' ');

const handler = async function (event) {
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
    // config_id replaces scope for Business-type apps (SMFLOW is one) — see
    // note above META_LOGIN_CONFIG_ID. Meta's docs explicitly say not to
    // include scope alongside config_id, so it's intentionally omitted here.
    oauthUrl.searchParams.set('config_id',     META_LOGIN_CONFIG_ID);
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
    // Use post scopes if 'Share on LinkedIn' product is enabled in LinkedIn Developer Portal
    oauthUrl.searchParams.set('scope', LINKEDIN_POST_SCOPES);
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

  // ── Google Drive ───────────────────────────────────────
  // Reuses the same Google OAuth client as YouTube — Google OAuth clients
  // are not platform-specific, only the requested scope differs. Kept as a
  // separate platform value (not bundled into the youtube connect button)
  // so a client can connect one without the other.
  else if (platform === 'google_drive') {
    if (!YOUTUBE_CLIENT_ID) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'YOUTUBE_CLIENT_ID not configured' }) };
    oauthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    oauthUrl.searchParams.set('client_id',      YOUTUBE_CLIENT_ID);
    oauthUrl.searchParams.set('redirect_uri',   CALLBACK_URL);
    oauthUrl.searchParams.set('response_type',  'code');
    oauthUrl.searchParams.set('scope',          GOOGLE_DRIVE_SCOPES);
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

export default withLambda(handler);
