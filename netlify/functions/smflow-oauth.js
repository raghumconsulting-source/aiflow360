// netlify/functions/smflow-oauth.js
// Initiates Meta OAuth flow for Facebook Pages + Instagram
// GET ?tenant_id=&platform=facebook|instagram&redirect_back=
//
// Redirects user to Meta's OAuth dialog.
// On return, Meta calls smflow-oauth-callback with the code.

const META_APP_ID     = process.env.META_APP_ID;
const SITE_URL        = 'https://aiflow360.com';
const CALLBACK_URL    = `${SITE_URL}/.netlify/functions/smflow-oauth-callback`;

// Scopes needed for Facebook Pages + Instagram publishing
const FB_SCOPES = [
  'pages_show_list',          // list pages the user manages
  'pages_manage_posts',       // publish to Facebook Page
  'pages_read_engagement',    // read page engagement data
  'instagram_basic',          // access Instagram account info
  'instagram_content_publish',// publish to Instagram
  'business_management',      // read business accounts
].join(',');

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params      = event.queryStringParameters || {};
  const tenantId    = params.tenant_id;
  const platform    = params.platform || 'facebook'; // facebook | instagram
  const redirectBack= params.redirect_back || `${SITE_URL}/smflow-app/dashboard.html`;

  if (!tenantId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  }
  if (!META_APP_ID) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'META_APP_ID not configured' }) };
  }

  // Encode state — passed through OAuth flow, verified in callback
  // Contains: tenant_id, platform, redirect_back URL
  const state = Buffer.from(JSON.stringify({
    tenant_id:     tenantId,
    platform,
    redirect_back: redirectBack,
    ts:            Date.now(), // basic replay protection
  })).toString('base64');

  // Build Meta OAuth URL
  const oauthUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  oauthUrl.searchParams.set('client_id',     META_APP_ID);
  oauthUrl.searchParams.set('redirect_uri',  CALLBACK_URL);
  oauthUrl.searchParams.set('scope',         FB_SCOPES);
  oauthUrl.searchParams.set('response_type', 'code');
  oauthUrl.searchParams.set('state',         state);

  // Redirect to Meta OAuth
  return {
    statusCode: 302,
    headers: {
      ...HEADERS,
      Location: oauthUrl.toString(),
    },
    body: '',
  };
};
