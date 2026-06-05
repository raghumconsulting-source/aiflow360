// netlify/functions/smflow-publish.js
// Publishes approved/scheduled posts to social platforms.
// Called by: scheduled cron OR manual trigger from dashboard.
//
// POST { action:'publish_post',  tenant_id, post_id }
//      → publish single post immediately
// POST { action:'publish_batch', tenant_id }
//      → publish all 'scheduled' posts due now
// POST { action:'connect_account', tenant_id, platform, ...tokens }
//      → save OAuth tokens for a social platform
// GET  ?tenant_id=&action=accounts
//      → list connected social accounts (no tokens in response)
//
// Sprint 5 covers: Facebook + Instagram (Meta Graph API)
// Sprint 6 covers: LinkedIn + Twitter/X + WhatsApp + YouTube

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Social API keys (add to Netlify env when connecting each platform)
const META_APP_ID          = process.env.META_APP_ID;
const META_APP_SECRET      = process.env.META_APP_SECRET;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ── Log publish attempt ────────────────────────────────────
async function logPublish({ tenant_id, post_id, social_account_id, platform, status, platform_post_id, platform_post_url, error_code, error_message }) {
  await sb('smflow_publish_log', {
    method: 'POST',
    prefer: 'return=minimal',
    body: {
      tenant_id,
      post_id,
      social_account_id: social_account_id || null,
      platform,
      status,
      platform_post_id:  platform_post_id  || null,
      platform_post_url: platform_post_url || null,
      error_code:        error_code        || null,
      error_message:     error_message     || null,
      attempted_at:      new Date().toISOString(),
      completed_at:      new Date().toISOString(),
    },
  }).catch(e => console.warn('publish_log non-fatal:', e.message));
}

// ── Facebook / Instagram publisher ────────────────────────
async function publishToFacebook({ account, post }) {
  const { meta_page_id, access_token } = account;
  if (!meta_page_id || !access_token) throw new Error('Meta page_id or access_token missing');

  // Get page-specific access token
  const pageTokenRes = await fetch(
    `https://graph.facebook.com/v19.0/${meta_page_id}?fields=access_token&access_token=${access_token}`
  );
  const pageTokenData = await pageTokenRes.json();
  const pageToken = pageTokenData.access_token || access_token;

  // Post to Facebook Page
  const body = new URLSearchParams({
    message:      post.content,
    access_token: pageToken,
  });
  if (post.image_url) body.set('url', post.image_url); // photo post

  const endpoint = post.image_url
    ? `https://graph.facebook.com/v19.0/${meta_page_id}/photos`
    : `https://graph.facebook.com/v19.0/${meta_page_id}/feed`;

  const res  = await fetch(endpoint, { method: 'POST', body });
  const data = await res.json();

  if (data.error) throw new Error(`Facebook API: ${data.error.message}`);
  return {
    platform_post_id:  data.id || data.post_id,
    platform_post_url: `https://www.facebook.com/${meta_page_id}/posts/${(data.id || '').split('_')[1] || ''}`,
  };
}

async function publishToInstagram({ account, post }) {
  const { meta_ig_account_id, access_token } = account;
  if (!meta_ig_account_id) throw new Error('Instagram Business Account ID missing');

  if (!post.image_url) {
    throw new Error('Instagram requires an image_url. Generate a Canva design first.');
  }

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v19.0/${meta_ig_account_id}/media`, {
      method: 'POST',
      body: new URLSearchParams({
        image_url:    post.image_url,
        caption:      post.content,
        access_token,
      }),
    }
  );
  const container = await containerRes.json();
  if (container.error) throw new Error(`Instagram container: ${container.error.message}`);

  // Step 2: Publish the container
  const publishRes = await fetch(
    `https://graph.facebook.com/v19.0/${meta_ig_account_id}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({
        creation_id:  container.id,
        access_token,
      }),
    }
  );
  const published = await publishRes.json();
  if (published.error) throw new Error(`Instagram publish: ${published.error.message}`);

  return {
    platform_post_id:  published.id,
    platform_post_url: `https://www.instagram.com/p/${published.id}/`,
  };
}

// ── LinkedIn publisher (Sprint 6) ─────────────────────────
async function publishToLinkedIn({ account, post }) {
  // LinkedIn UGC Posts API v2
  // Requires w_member_social scope + "Share on LinkedIn" product enabled
  const token     = account.access_token;
  const authorUrn = account.account_type === 'organization'
    ? `urn:li:organization:${account.platform_account_id.replace('org_','')}`
    : `urn:li:person:${account.platform_account_id}`;

  const body = {
    author:         authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary:    { text: post.content || '' },
        shareMediaCategory: post.image_url ? 'IMAGE' : 'NONE',
        ...(post.image_url ? {
          media: [{
            status:      'READY',
            description: { text: (post.content||'').slice(0,200) },
            originalUrl: post.image_url,
          }],
        } : {}),
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`LinkedIn publish failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  }

  return {
    platform_post_id:  data.id || data.value,
    platform_post_url: data.id ? `https://www.linkedin.com/feed/update/${data.id}` : null,
  };
}

// ── Twitter/X publisher (Sprint 6) ────────────────────────
async function publishToTwitter({ account, post }) {
  // TODO Sprint 6 — X API v2
  // Requires: X Developer account, paid API tier for posting
  throw new Error('Twitter/X publishing coming in Sprint 6');
}

// ── YouTube publisher (Sprint 6) ──────────────────────────
async function publishToYouTube({ account, post }) {
  // TODO Sprint 6 — YouTube Data API v3 community posts
  throw new Error('YouTube publishing coming in Sprint 6');
}

// ── WhatsApp publisher (Sprint 6) ─────────────────────────
async function publishToWhatsApp({ account, post }) {
  // TODO Sprint 6 — Meta WhatsApp Business API via 360dialog
  throw new Error('WhatsApp Channel publishing coming in Sprint 6');
}

// ── Publisher router ──────────────────────────────────────
async function publishPost(post, account) {
  switch (post.platform) {
    case 'Facebook':    return publishToFacebook({ account, post });
    case 'Instagram':   return publishToInstagram({ account, post });
    case 'LinkedIn':    return publishToLinkedIn({ account, post });
    case 'Twitter/X':   return publishToTwitter({ account, post });
    case 'YouTube':     return publishToYouTube({ account, post });
    case 'WhatsApp':    return publishToWhatsApp({ account, post });
    default:
      throw new Error(`No publisher for platform: ${post.platform}`);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  // ── GET: list connected accounts (no tokens) ──────────
  if (event.httpMethod === 'GET') {
    if (params.action === 'accounts') {
      if (!tenantId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };

      try {
        const accounts = await sb(
          `smflow_social_accounts?tenant_id=eq.${tenantId}&is_active=eq.true` +
          `&select=id,platform,account_name,account_type,is_verified,last_post_at,error_count,connected_at`
        );
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ accounts }) };
      } catch (err) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
      }
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown GET action' }) };
  }

  // ── POST: actions ─────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, tenant_id } = body;
    if (!tenant_id) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {

      // ── connect_account: save OAuth tokens ───────────
      if (action === 'connect_account') {
        const {
          platform, platform_account_id, account_name, account_type,
          access_token, refresh_token, token_expires_at, token_scopes,
          meta_page_id, meta_ig_account_id,
        } = body;

        if (!platform || !platform_account_id || !access_token) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'platform, platform_account_id, access_token required' }) };
        }

        // Deactivate existing account for this platform
        await sb(
          `smflow_social_accounts?tenant_id=eq.${tenant_id}&platform=eq.${platform}`,
          { method: 'PATCH', prefer: 'return=minimal', body: { is_active: false, updated_at: new Date().toISOString() } }
        ).catch(() => {});

        // Insert new account
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

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── publish_post: publish a single post now ───────
      if (action === 'publish_post') {
        const { post_id } = body;
        if (!post_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post_id required' }) };

        // Fetch post
        const postRows = await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}&limit=1`);
        if (!postRows.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Post not found' }) };
        const post = postRows[0];

        if (!['approved', 'scheduled'].includes(post.status)) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Post status must be approved or scheduled, got: ${post.status}` }) };
        }

        // Get social account for this platform
        const accounts = await sb(
          `smflow_social_accounts?tenant_id=eq.${tenant_id}&platform=eq.${encodeURIComponent(post.platform)}&is_active=eq.true&limit=1`
        );
        if (!accounts.length) {
          return {
            statusCode: 400,
            headers:    HEADERS,
            body:       JSON.stringify({
              error: `No ${post.platform} account connected. Please connect your account in Settings → Social Accounts.`,
            }),
          };
        }
        const account = accounts[0];

        try {
          const result = await publishPost(post, account);

          // Mark as published
          await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: {
              status:       'published',
              published_at: new Date().toISOString(),
              publish_error: null,
            },
          });

          // Update account last_post_at
          await sb(`smflow_social_accounts?id=eq.${account.id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { last_post_at: new Date().toISOString(), error_count: 0, updated_at: new Date().toISOString() },
          }).catch(() => {});

          await logPublish({
            tenant_id, post_id, social_account_id: account.id,
            platform:         post.platform,
            status:           'success',
            platform_post_id: result.platform_post_id,
            platform_post_url: result.platform_post_url,
          });

          return {
            statusCode: 200,
            headers:    HEADERS,
            body:       JSON.stringify({
              success:           true,
              platform_post_id:  result.platform_post_id,
              platform_post_url: result.platform_post_url,
            }),
          };

        } catch (publishErr) {
          console.error(`Publish failed for ${post.platform}:`, publishErr.message);

          // Mark publish_error on post
          await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { publish_error: publishErr.message },
          }).catch(() => {});

          // Increment error_count on account
          await sb(`smflow_social_accounts?id=eq.${account.id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: {
              last_error:  publishErr.message,
              error_count: (account.error_count || 0) + 1,
              updated_at:  new Date().toISOString(),
            },
          }).catch(() => {});

          await logPublish({
            tenant_id, post_id,
            social_account_id: account.id,
            platform:          post.platform,
            status:            'failed',
            error_code:        publishErr.code || 'PUBLISH_ERROR',
            error_message:     publishErr.message,
          });

          return {
            statusCode: 500,
            headers:    HEADERS,
            body:       JSON.stringify({ error: publishErr.message }),
          };
        }
      }

      // ── publish_batch: publish all due scheduled posts ─
      if (action === 'publish_batch') {
        const now = new Date().toISOString();

        // Find all posts scheduled for now or earlier
        const duePosts = await sb(
          `smflow_posts?tenant_id=eq.${tenant_id}&status=eq.scheduled` +
          `&scheduled_at=lte.${now}` +
          `&order=scheduled_at.asc&limit=50`
        );

        if (!duePosts.length) {
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ published: 0, message: 'No posts due' }) };
        }

        const results = { success: [], failed: [] };

        for (const post of duePosts) {
          const accounts = await sb(
            `smflow_social_accounts?tenant_id=eq.${tenant_id}&platform=eq.${encodeURIComponent(post.platform)}&is_active=eq.true&limit=1`
          );
          if (!accounts.length) {
            results.failed.push({ post_id: post.id, platform: post.platform, error: 'No account connected' });
            continue;
          }

          try {
            const result = await publishPost(post, accounts[0]);
            await sb(`smflow_posts?id=eq.${post.id}&tenant_id=eq.${tenant_id}`, {
              method: 'PATCH',
              prefer: 'return=minimal',
              body: { status: 'published', published_at: now, publish_error: null },
            });
            await logPublish({
              tenant_id, post_id: post.id, social_account_id: accounts[0].id,
              platform: post.platform, status: 'success',
              platform_post_id: result.platform_post_id,
              platform_post_url: result.platform_post_url,
            });
            results.success.push({ post_id: post.id, platform: post.platform });
          } catch (err) {
            await sb(`smflow_posts?id=eq.${post.id}&tenant_id=eq.${tenant_id}`, {
              method: 'PATCH',
              prefer: 'return=minimal',
              body: { publish_error: err.message },
            });
            await logPublish({
              tenant_id, post_id: post.id, social_account_id: accounts[0].id,
              platform: post.platform, status: 'failed', error_message: err.message,
            });
            results.failed.push({ post_id: post.id, platform: post.platform, error: err.message });
          }
        }

        return {
          statusCode: 200,
          headers:    HEADERS,
          body:       JSON.stringify({
            published: results.success.length,
            failed:    results.failed.length,
            results,
          }),
        };
      }

      // ── disconnect_account: deactivate a social account ─
      if (action === 'disconnect_account') {
        const { platform } = body;
        if (!platform) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'platform required' }) };

        await sb(
          `smflow_social_accounts?tenant_id=eq.${tenant_id}&platform=eq.${platform}`,
          { method: 'PATCH', prefer: 'return=minimal', body: { is_active: false, updated_at: new Date().toISOString() } }
        );

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return {
        statusCode: 400,
        headers:    HEADERS,
        body:       JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('smflow-publish POST error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
