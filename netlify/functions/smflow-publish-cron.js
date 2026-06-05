// netlify/functions/smflow-publish-cron.js
// Scheduled function — runs every 15 minutes via netlify.toml cron
// Finds all posts with status='scheduled' AND scheduled_at <= now()
// Publishes each to their scheduled platforms
// Logs results to smflow_publish_log

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0,200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

async function publishToFacebook(post, account) {
  const pageToken = account.access_token;
  const pageId    = account.platform_account_id;
  const message   = post.content;

  let body = { message, access_token: pageToken };

  if (post.image_url) {
    // Post with image
    const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: post.image_url, caption: message, access_token: pageToken }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`FB photo error: ${data.error.message}`);
    return data.id;
  } else {
    const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(`FB feed error: ${data.error.message}`);
    return data.id;
  }
}

async function publishToInstagram(post, account) {
  const igUserId = account.platform_account_id;
  const token    = account.access_token;
  const caption  = post.content;

  if (!post.image_url) throw new Error('Instagram requires an image');

  // Step 1: create container
  const containerRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: post.image_url, caption, access_token: token }),
  });
  const container = await containerRes.json();
  if (container.error) throw new Error(`IG container error: ${container.error.message}`);

  // Step 2: publish container
  const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: token }),
  });
  const published = await publishRes.json();
  if (published.error) throw new Error(`IG publish error: ${published.error.message}`);
  return published.id;
}

exports.handler = async () => {
  console.log('smflow-publish-cron: firing at', new Date().toISOString());

  try {
    // Get all scheduled posts due now (across all tenants)
    const duePosts = await sb(
      `smflow_posts?status=eq.scheduled&scheduled_at=lte.${new Date().toISOString()}&select=*`,
      { prefer: 'return=representation' }
    );

    console.log(`Found ${duePosts.length} due posts`);

    let totalPublished = 0;
    let totalFailed    = 0;

    for (const post of duePosts) {
      const platforms = post.scheduled_platforms || [];
      if (!platforms.length) {
        console.log(`Post ${post.id} has no scheduled_platforms — skipping`);
        continue;
      }

      // Get social accounts for this tenant
      const accounts = await sb(
        `smflow_social_accounts?tenant_id=eq.${post.tenant_id}&is_active=eq.true&select=*`
      );

      for (const platform of platforms) {
        const account = accounts.find(a => a.platform === platform);
        if (!account) {
          console.log(`No active account for platform ${platform} on tenant ${post.tenant_id}`);
          continue;
        }

        let publishedId = null;
        let errorMsg    = null;

        try {
          if (platform === 'facebook') {
            publishedId = await publishToFacebook(post, account);
          } else if (platform === 'instagram') {
            publishedId = await publishToInstagram(post, account);
          } else {
            console.log(`Platform ${platform} not yet supported in cron`);
            continue;
          }

          // Log success
          await sb('smflow_publish_log', {
            method: 'POST',
            body: {
              tenant_id:    post.tenant_id,
              post_id:      post.id,
              platform,
              status:       'success',
              error_message: null,
            }
          });

          totalPublished++;
          console.log(`Published post ${post.id} to ${platform}: ${publishedId}`);

        } catch (err) {
          errorMsg = err.message;
          console.error(`Failed post ${post.id} to ${platform}:`, errorMsg);

          // Log failure
          await sb('smflow_publish_log', {
            method: 'POST',
            body: {
              tenant_id:     post.tenant_id,
              post_id:       post.id,
              platform,
              status:        'failed',
              error_message: errorMsg,
            }
          });

          totalFailed++;
        }
      }

      // Update post status to published (or failed if all failed)
      const newStatus = totalFailed === platforms.length ? 'failed' : 'published';
      await sb(`smflow_posts?id=eq.${post.id}`, {
        method: 'PATCH',
        body: {
          status:       newStatus,
          published_at: new Date().toISOString(),
          publish_error: totalFailed > 0 ? 'One or more platforms failed' : null,
        }
      });
    }

    console.log(`Cron complete: ${totalPublished} published, ${totalFailed} failed`);
    return {
      statusCode: 200,
      body: JSON.stringify({ published: totalPublished, failed: totalFailed }),
    };

  } catch(err) {
    console.error('smflow-publish-cron error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
