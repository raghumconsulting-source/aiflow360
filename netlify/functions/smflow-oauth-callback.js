// netlify/functions/smflow-oauth-callback.js
// Handles the Meta OAuth redirect after user grants permissions.
//
// Flow:
// 1. Meta redirects here with ?code=&state=
// 2. Exchange code for short-lived user access token
// 3. Exchange for long-lived user access token (60 days)
// 4. Get list of Facebook Pages the user manages
// 5. Get Page-specific long-lived token for each page
// 6. Get Instagram Business Account linked to each page
// 7. Save to smflow_social_accounts (one row per platform per tenant)
// 8. Redirect back to SMflow dashboard with success/error param

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const META_APP_ID          = process.env.META_APP_ID;
const META_APP_SECRET      = process.env.META_APP_SECRET;
const SITE_URL             = 'https://aiflow360.com';
const CALLBACK_URL         = `${SITE_URL}/.netlify/functions/smflow-oauth-callback`;
const DASHBOARD_URL        = `${SITE_URL}/smflow-app/dashboard.html`;
const GRAPH_URL            = 'https://graph.facebook.com/v19.0';

// ── Supabase REST helper ──────────────────────────────────
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
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed;
}

// ── Meta Graph API helper ─────────────────────────────────
async function graph(path, params = {}) {
  const url = new URL(`${GRAPH_URL}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res  = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Meta API ${path}: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// ── Save or update social account in DB ───────────────────
async function upsertAccount({
  tenant_id, platform, platform_account_id, account_name, account_type,
  access_token, refresh_token, token_expires_at, token_scopes,
  meta_page_id, meta_ig_account_id,
}) {
  // Deactivate existing account for this platform
  await sb(
    `smflow_social_accounts?tenant_id=eq.${tenant_id}&platform=eq.${encodeURIComponent(platform)}`,
    { method: 'PATCH', prefer: 'return=minimal', body: { is_active: false, updated_at: new Date().toISOString() } }
  ).catch(() => {}); // non-fatal if none exists

  // Insert new
  await sb('smflow_social_accounts', {
    method: 'POST',
    prefer: 'return=minimal',
    body: {
      tenant_id,
      platform,
      platform_account_id,
      account_name:       account_name       || null,
      account_type:       account_type       || 'page',
      access_token,
      refresh_token:      refresh_token      || null,
      token_expires_at:   token_expires_at   || null,
      token_scopes:       token_scopes       || [],
      meta_page_id:       meta_page_id       || null,
      meta_ig_account_id: meta_ig_account_id || null,
      is_active:          true,
      is_verified:        false,
      connected_at:       new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    },
  });
}

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const { code, state, error: oauthError, error_description } = params;

  // ── OAuth error from Meta ─────────────────────────────
  if (oauthError) {
    console.error('Meta OAuth error:', oauthError, error_description);
    return {
      statusCode: 302,
      headers: { Location: `${DASHBOARD_URL}?tab=settings&connect_error=${encodeURIComponent(error_description || oauthError)}` },
      body: '',
    };
  }

  if (!code || !state) {
    return {
      statusCode: 302,
      headers: { Location: `${DASHBOARD_URL}?tab=settings&connect_error=missing_code` },
      body: '',
    };
  }

  // ── Decode state ──────────────────────────────────────
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch (e) {
    return {
      statusCode: 302,
      headers: { Location: `${DASHBOARD_URL}?tab=settings&connect_error=invalid_state` },
      body: '',
    };
  }

  const { tenant_id, platform, redirect_back } = stateData;
  const dashboardReturn = redirect_back || DASHBOARD_URL;

  if (!tenant_id) {
    return {
      statusCode: 302,
      headers: { Location: `${dashboardReturn}?tab=settings&connect_error=missing_tenant` },
      body: '',
    };
  }

  try {
    // ── Step 1: Exchange code for short-lived user token ──
    const tokenRes = await fetch(`${GRAPH_URL}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri:  CALLBACK_URL,
        code,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(`Token exchange: ${tokenData.error.message}`);
    const shortLivedToken = tokenData.access_token;

    // ── Step 2: Exchange for long-lived user token (60d) ──
    const longTokenData = await graph('oauth/access_token', {
      grant_type:        'fb_exchange_token',
      client_id:         META_APP_ID,
      client_secret:     META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    });
    const userToken      = longTokenData.access_token;
    const tokenExpiresIn = longTokenData.expires_in || 5184000; // default 60 days
    const tokenExpiresAt = new Date(Date.now() + tokenExpiresIn * 1000).toISOString();

    // ── Step 3: Get user info ─────────────────────────────
    const userInfo = await graph('me', {
      fields:       'id,name,email',
      access_token: userToken,
    });

    // ── Step 4: Get Facebook Pages the user manages ───────
    const pagesData = await graph('me/accounts', {
      fields:       'id,name,access_token,instagram_business_account',
      access_token: userToken,
    });
    const pages = pagesData.data || [];

    if (!pages.length) {
      // No pages found — save user token at minimum
      console.warn('No Facebook Pages found for user:', userInfo.id);
      return {
        statusCode: 302,
        headers: { Location: `${dashboardReturn}?tab=settings&connect_error=no_pages&connect_hint=Please+ensure+you+have+a+Facebook+Page+and+are+an+admin` },
        body: '',
      };
    }

    let facebookConnected  = 0;
    let instagramConnected = 0;

    for (const page of pages) {
      const pageToken = page.access_token; // already long-lived when user token is long-lived
      const pageId    = page.id;
      const pageName  = page.name;

      // ── Step 5: Save Facebook Page account ───────────────
      await upsertAccount({
        tenant_id,
        platform:            'Facebook',
        platform_account_id: pageId,
        account_name:        pageName,
        account_type:        'page',
        access_token:        pageToken,
        token_expires_at:    tokenExpiresAt,
        token_scopes:        ['pages_manage_posts', 'pages_read_engagement'],
        meta_page_id:        pageId,
      });
      facebookConnected++;

      // ── Step 6: Check for linked Instagram Business Account
      let igAccountId = page.instagram_business_account?.id;

      if (!igAccountId) {
        // Try fetching it directly
        try {
          const igData = await graph(`${pageId}`, {
            fields:       'instagram_business_account',
            access_token: pageToken,
          });
          igAccountId = igData.instagram_business_account?.id;
        } catch (igErr) {
          console.warn(`No Instagram linked to page ${pageName}:`, igErr.message);
        }
      }

      if (igAccountId) {
        // Get Instagram account details
        try {
          const igInfo = await graph(igAccountId, {
            fields:       'id,name,username,profile_picture_url',
            access_token: pageToken,
          });

          // ── Step 7: Save Instagram account ───────────────
          await upsertAccount({
            tenant_id,
            platform:            'Instagram',
            platform_account_id: igAccountId,
            account_name:        igInfo.username || igInfo.name || pageName,
            account_type:        'business',
            access_token:        pageToken, // Page token is used for IG publishing
            token_expires_at:    tokenExpiresAt,
            token_scopes:        ['instagram_basic', 'instagram_content_publish'],
            meta_page_id:        pageId,
            meta_ig_account_id:  igAccountId,
          });
          instagramConnected++;
        } catch (igSaveErr) {
          console.warn('Instagram save error (non-fatal):', igSaveErr.message);
        }
      }
    }

    // ── Audit log ─────────────────────────────────────────
    await sb('audit_logs', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        tenant_id,
        action:        'create',
        resource_type: 'smflow_social_accounts',
        metadata: {
          platforms_connected: ['Facebook', instagramConnected > 0 ? 'Instagram' : null].filter(Boolean),
          pages_found:         pages.length,
          fb_connected:        facebookConnected,
          ig_connected:        instagramConnected,
          meta_user_id:        userInfo.id,
        },
      },
    }).catch(e => console.warn('audit log non-fatal:', e.message));

    // ── Build success message ─────────────────────────────
    const connected = [];
    if (facebookConnected  > 0) connected.push(`Facebook (${facebookConnected} page${facebookConnected > 1 ? 's' : ''})`);
    if (instagramConnected > 0) connected.push(`Instagram (${instagramConnected} account${instagramConnected > 1 ? 's' : ''})`);
    const successMsg = connected.length
      ? `Connected: ${connected.join(' + ')}`
      : 'Connected successfully';

    // ── Redirect back to dashboard with success ───────────
    return {
      statusCode: 302,
      headers: {
        Location: `${dashboardReturn}?tab=settings&connect_success=${encodeURIComponent(successMsg)}`,
      },
      body: '',
    };

  } catch (err) {
    console.error('smflow-oauth-callback error:', err.message);
    return {
      statusCode: 302,
      headers: {
        Location: `${dashboardReturn}?tab=settings&connect_error=${encodeURIComponent(err.message)}`,
      },
      body: '',
    };
  }
};
