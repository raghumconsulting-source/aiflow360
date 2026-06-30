import { withLambda } from '@netlify/aws-lambda-compat';
import { createClient } from '@supabase/supabase-js';

// netlify/functions/smflow-canva-design.mjs
// Uploads a photo to the tenant's connected Canva account, creates a design
// with it already placed in, and returns an edit_url the frontend opens in
// a new window/tab. correlation_state = post_id is appended so the Return
// Navigation flow (handled separately, by reading the correlation_jwt
// Canva appends when the person clicks "Back to SMflow") knows which post
// to update once they're done editing.
//
// POST { tenant_id, post_id, image_url }

const CANVA_CLIENT_ID     = process.env.CANVA_CLIENT_ID;
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;

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

// Refreshes the stored access token if it's expired or about to expire
// (60s buffer), persisting the new token + a fresh refresh_token (Canva
// rotates refresh tokens on every use, per their docs — the old one must
// not be reused).
async function getValidAccessToken(supabase, tenantId) {
  const { data: config, error } = await supabase
    .from('smflow_canva_config')
    .select('access_token, refresh_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .is('uninstalled_at', null)
    .single();

  if (error || !config) {
    throw new Error('No Canva account connected for this tenant — connect Canva in Settings first');
  }

  const expiresAt = config.token_expires_at ? new Date(config.token_expires_at).getTime() : 0;
  const isExpiredOrExpiringSoon = Date.now() > expiresAt - 60_000;

  if (!isExpiredOrExpiringSoon) {
    return config.access_token;
  }

  if (!config.refresh_token) {
    throw new Error('Canva connection has expired and cannot be automatically renewed — please reconnect Canva in Settings');
  }

  const basicAuth = Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: config.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Could not refresh Canva access — please reconnect Canva in Settings: ${JSON.stringify(data)}`);
  }

  const newExpiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : null;

  await supabase
    .from('smflow_canva_config')
    .update({
      access_token:     data.access_token,
      refresh_token:    data.refresh_token || config.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at:        new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);

  return data.access_token;
}

// Uploads a photo to Canva's asset library. Deliberately uses the STABLE
// /v1/asset-uploads endpoint (raw bytes + metadata header) rather than the
// /v1/url-asset-uploads endpoint, even though the latter would be simpler
// (just pass a URL) — url-asset-uploads is explicitly marked Preview in
// Canva's own OpenAPI spec, and "Public integrations that use preview APIs
// will not pass the review process". Since this integration needs to pass
// review to be usable by any client beyond our own org, the preview
// endpoint is not an option here regardless of convenience.
async function uploadAssetFromUrl(accessToken, imageUrl, displayName) {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Could not fetch the source photo to upload to Canva (status ${imageRes.status})`);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  const nameBase64 = Buffer.from(displayName.slice(0, 50)).toString('base64');
  const createRes = await fetch('https://api.canva.com/rest/v1/asset-uploads', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Asset-Upload-Metadata': JSON.stringify({ name_base64: nameBase64 }),
    },
    body: imageBuffer,
  });
  const createData = await createRes.json();
  const jobId = createData.job?.id;
  if (!jobId) throw new Error(`Canva asset upload could not start: ${JSON.stringify(createData)}`);

  // Job polling: short interval, generous attempt count, matching the same
  // time-budgeted pattern already used elsewhere in this codebase for other
  // async provider jobs (e.g. the Shopify sync's resumable batching).
  const maxAttempts = 15;
  const delayMs = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, delayMs));
    const pollRes = await fetch(`https://api.canva.com/rest/v1/asset-uploads/${jobId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const pollData = await pollRes.json();
    const status = pollData.job?.status;
    if (status === 'success') {
      const assetId = pollData.job?.asset?.id;
      if (!assetId) throw new Error('Canva reported the upload succeeded but did not return an asset ID');
      return assetId;
    }
    if (status === 'failed') {
      throw new Error(`Canva asset upload failed: ${pollData.job?.error?.message || 'unknown error'}`);
    }
    // status === 'in_progress' — keep polling
  }
  throw new Error('Canva asset upload took too long — please try again');
}

// Canva's `preset` design type only supports doc/email/presentation/
// whiteboard — there is no social-media-post preset at all, confirmed
// directly against the API's own error response. Social-sized designs use
// `type: custom` with explicit pixel dimensions instead. These match the
// same aspect ratios already used for the platform preview in
// dashboard.html's PLATFORM_PREVIEW config, sized at a sensible resolution
// for actual export quality (not just the small preview-card size).
const PLATFORM_DESIGN_DIMENSIONS = {
  Instagram:  { width: 1080, height: 1080 }, // 1:1
  Facebook:   { width: 1200, height: 628  }, // 1.91:1
  LinkedIn:   { width: 1200, height: 628  }, // 1.91:1
  'Twitter/X': { width: 1200, height: 675 }, // 16:9
  YouTube:    { width: 1280, height: 720  }, // 16:9
  WhatsApp:   { width: 1080, height: 1080 }, // 1:1, same as Instagram
};
const DEFAULT_DESIGN_DIMENSIONS = { width: 1080, height: 1080 };

async function createDesignWithAsset(accessToken, assetId, title, platform) {
  const dimensions = PLATFORM_DESIGN_DIMENSIONS[platform] || DEFAULT_DESIGN_DIMENSIONS;
  const res = await fetch('https://api.canva.com/rest/v1/designs', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      design_type: { type: 'custom', width: dimensions.width, height: dimensions.height },
      asset_id: assetId,
      title: title.slice(0, 50),
    }),
  });
  const data = await res.json();
  if (!data.design?.urls?.edit_url) {
    throw new Error(`Canva design creation failed: ${JSON.stringify(data)}`);
  }
  return data.design;
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

  const { tenant_id, post_id, image_url, platform } = body;
  if (!tenant_id || !post_id || !image_url) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id, post_id, and image_url are all required' }) };
  }
  // correlation_state is capped at 50 chars by Canva — post_id (a uuid,
  // 36 chars) comfortably fits with no encoding needed.
  if (String(post_id).length > 50) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id is too long to use as Canva correlation_state' }) };
  }

  const supabase = getSupabase();

  let accessToken;
  try {
    accessToken = await getValidAccessToken(supabase, tenant_id);
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }

  let assetId, design;
  try {
    assetId = await uploadAssetFromUrl(accessToken, image_url, `SMflow photo ${post_id}`);
    design  = await createDesignWithAsset(accessToken, assetId, `SMflow — ${post_id}`, platform);
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }

  const editUrl = new URL(design.urls.edit_url);
  editUrl.searchParams.set('correlation_state', String(post_id));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      design_id: design.id,
      edit_url: editUrl.toString(),
    }),
  };
};

export default withLambda(handler);
