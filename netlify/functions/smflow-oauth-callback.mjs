import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/smflow-oauth-callback.js
// Handles OAuth redirect for all platforms:
// Facebook/Instagram, LinkedIn, YouTube
//
// Flow:
// 1. Verify state param (tenant_id + platform)
// 2. Exchange code for access token
// 3. Fetch account/page details
// 4. Save to smflow_social_accounts (scoped to tenant_id)
// 5. Redirect back to dashboard with success/error message

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const META_APP_ID           = process.env.META_APP_ID;
const META_APP_SECRET       = process.env.META_APP_SECRET;
const LINKEDIN_CLIENT_ID    = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET= process.env.LINKEDIN_CLIENT_SECRET;
const YOUTUBE_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const SITE_URL              = 'https://aiflow360.com';
const CALLBACK_URL          = `${SITE_URL}/.netlify/functions/smflow-oauth-callback`;

// ── Supabase helper ────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

// ── Upsert social account ──────────────────────────────────
async function upsertAccount(tenantId, platform, accountData) {
  const now = new Date().toISOString();
  // Check if account already exists for this tenant + platform + account_id
  const existing = await sb(
    `smflow_social_accounts?tenant_id=eq.${tenantId}&platform=eq.${platform}&platform_account_id=eq.${accountData.platform_account_id}&select=id&limit=1`
  );

  const payload = {
    tenant_id:           tenantId,
    platform,
    ...accountData,
    is_active:           true,
    is_verified:         true,
    updated_at:          now,
  };

  if (existing.length) {
    await sb(
      `smflow_social_accounts?tenant_id=eq.${tenantId}&platform=eq.${platform}&platform_account_id=eq.${accountData.platform_account_id}`,
      { method: 'PATCH', prefer: 'return=minimal', body: payload }
    );
  } else {
    await sb('smflow_social_accounts', {
      method: 'POST', prefer: 'return=minimal',
      body: { ...payload, connected_at: now },
    });
  }
}

// ══════════════════════════════════════════════════════════
// FACEBOOK + INSTAGRAM HANDLER
// ══════════════════════════════════════════════════════════
async function handleFacebook(code, tenantId) {
  // 1. Exchange code for short-lived token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
    `client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&code=${code}`
  );
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`Meta token exchange failed: ${JSON.stringify(tokenData)}`);

  // 2. Upgrade to long-lived token (60 days)
  const llRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
    `grant_type=fb_exchange_token&client_id=${META_APP_ID}` +
    `&client_secret=${META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
  );
  const llData = await llRes.json();
  const longToken = llData.access_token || tokenData.access_token;
  const expiresAt = llData.expires_in
    ? new Date(Date.now() + llData.expires_in * 1000).toISOString()
    : null;

  // 3. Get all Facebook Pages the user manages
  const pagesRes = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}&fields=id,name,access_token,category`
  );
  const pagesData = await pagesRes.json();
  const pages = pagesData.data || [];

  let fbCount = 0, igCount = 0;

  for (const page of pages) {
    // Save Facebook Page
    await upsertAccount(tenantId, 'Facebook', {
      platform_account_id: page.id,
      account_name:        page.name,
      account_type:        'page',
      access_token:        page.access_token,
      token_expires_at:    expiresAt,
      meta_page_id:        page.id,
    });
    fbCount++;

    // Check for linked Instagram Business account
    const igRes = await fetch(
      `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
    );
    const igData = await igRes.json();
    if (igData.instagram_business_account?.id) {
      const igId = igData.instagram_business_account.id;
      // Get Instagram username
      const igInfoRes = await fetch(
        `https://graph.facebook.com/v19.0/${igId}?fields=username,name&access_token=${page.access_token}`
      );
      const igInfo = await igInfoRes.json();
      await upsertAccount(tenantId, 'Instagram', {
        platform_account_id: igId,
        account_name:        igInfo.username || igInfo.name || igId,
        account_type:        'business',
        access_token:        page.access_token,
        token_expires_at:    expiresAt,
        meta_page_id:        page.id,
        meta_ig_account_id:  igId,
      });
      igCount++;
    }
  }

  const parts = [];
  if (fbCount) parts.push(`Facebook (${fbCount} page${fbCount > 1 ? 's' : ''})`);
  if (igCount) parts.push(`Instagram (${igCount} account${igCount > 1 ? 's' : ''})`);
  return parts.join(' + ') || 'Facebook connected';
}

// ══════════════════════════════════════════════════════════
// LINKEDIN HANDLER
// ══════════════════════════════════════════════════════════
async function handleLinkedIn(code, tenantId) {
  // 1. Exchange code for access token
  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  CALLBACK_URL,
      client_id:     LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`LinkedIn token exchange failed: ${JSON.stringify(tokenData)}`);

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || null;
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  // 2. Get member profile
  const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const profile = await profileRes.json();

  // 3. Save personal LinkedIn account
  await upsertAccount(tenantId, 'LinkedIn', {
    platform_account_id: profile.sub || profile.id,
    account_name:        profile.name || `${profile.given_name} ${profile.family_name}`,
    account_type:        'personal',
    access_token:        accessToken,
    refresh_token:       refreshToken,
    token_expires_at:    expiresAt,
    token_scopes:        ['w_member_social', 'r_organization_social', 'w_organization_social'],
  });

  // 4. Try to get LinkedIn Company Pages the member admins
  let pageCount = 0;
  try {
    const orgsRes = await fetch(
      `https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const orgsData = await orgsRes.json();
    const orgs = orgsData.elements || [];

    for (const org of orgs) {
      const orgId = org.organization?.split(':').pop();
      if (!orgId) continue;
      // Get org details
      const orgRes = await fetch(
        `https://api.linkedin.com/v2/organizations/${orgId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const orgData = await orgRes.json();
      await upsertAccount(tenantId, 'LinkedIn', {
        platform_account_id: `org_${orgId}`,
        account_name:        orgData.localizedName || `LinkedIn Page ${orgId}`,
        account_type:        'organization',
        access_token:        accessToken,
        refresh_token:       refreshToken,
        token_expires_at:    expiresAt,
        token_scopes:        ['w_organization_social'],
      });
      pageCount++;
    }
  } catch(e) {
    console.warn('LinkedIn org pages non-fatal:', e.message);
  }

  return pageCount
    ? `LinkedIn (profile + ${pageCount} company page${pageCount > 1 ? 's' : ''})`
    : `LinkedIn (${profile.name || 'profile'})`;
}

// ══════════════════════════════════════════════════════════
// YOUTUBE HANDLER
// ══════════════════════════════════════════════════════════
async function handleYouTube(code, tenantId) {
  // 1. Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      redirect_uri:  CALLBACK_URL,
      grant_type:    'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`YouTube token exchange failed: ${JSON.stringify(tokenData)}`);

  const accessToken  = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || null;
  const expiresAt    = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  // 2. Get YouTube channel info
  const channelRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const channelData = await channelRes.json();
  const channel = channelData.items?.[0];

  if (!channel) throw new Error('No YouTube channel found for this Google account');

  const channelId   = channel.id;
  const channelName = channel.snippet?.title || 'YouTube Channel';

  // 3. Save YouTube channel
  await upsertAccount(tenantId, 'YouTube', {
    platform_account_id: channelId,
    account_name:        channelName,
    account_type:        'channel',
    access_token:        accessToken,
    refresh_token:       refreshToken,
    token_expires_at:    expiresAt,
    token_scopes:        ['youtube.upload', 'youtube'],
  });

  return `YouTube (${channelName})`;
}

// ══════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════
const handler = async function (event) {
  const params = event.queryStringParameters || {};
  const code   = params.code;
  const error  = params.error;

  // Decode state
  let stateData = {};
  try {
    stateData = JSON.parse(Buffer.from(params.state || '', 'base64').toString('utf8'));
  } catch {
    return { statusCode: 400, body: 'Invalid state parameter' };
  }

  const { tenant_id, platform, redirect_back } = stateData;
  const dashboardReturn = redirect_back || `${SITE_URL}/smflow-app/dashboard.html`;

  // Handle user-denied / OAuth errors
  if (error || !code) {
    const msg = error === 'access_denied' ? 'Access denied — please try again' : (error || 'OAuth failed');
    return {
      statusCode: 302,
      headers: { Location: `${dashboardReturn}?tab=settings&connect_error=${encodeURIComponent(msg)}` },
      body: '',
    };
  }

  if (!tenant_id) {
    return {
      statusCode: 302,
      headers: { Location: `${dashboardReturn}?tab=settings&connect_error=${encodeURIComponent('Missing tenant_id')}` },
      body: '',
    };
  }

  try {
    let successMsg = '';

    if (platform === 'facebook' || platform === 'instagram') {
      successMsg = await handleFacebook(code, tenant_id);
    } else if (platform === 'linkedin') {
      successMsg = await handleLinkedIn(code, tenant_id);
    } else if (platform === 'youtube') {
      successMsg = await handleYouTube(code, tenant_id);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Audit log
    sb('audit_logs', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        tenant_id,
        action:        'connect',
        resource_type: 'smflow_social_accounts',
        metadata:      { platform, success: successMsg },
      },
    }).catch(e => console.warn('audit log non-fatal:', e.message));

    return {
      statusCode: 302,
      headers: { Location: `${dashboardReturn}?tab=settings&connect_success=${encodeURIComponent('✓ Connected: ' + successMsg)}` },
      body: '',
    };

  } catch (err) {
    console.error(`smflow-oauth-callback [${platform}] error:`, err.message);
    return {
      statusCode: 302,
      headers: { Location: `${dashboardReturn}?tab=settings&connect_error=${encodeURIComponent(err.message)}` },
      body: '',
    };
  }
};

export default withLambda(handler);
