// netlify/functions/smflow-assets.js
// GET  ?tenant_id=&source=&flavor=&topic= → list assets with filters
// POST actions: get_upload_url | confirm_upload | delete | tag | gdrive_connect | gdrive_sync

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET       = 'tenant-assets'; // reuse existing bucket

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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  // ── GET: list assets ──────────────────────────────────
  if (event.httpMethod === 'GET') {
    if (!tenantId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    }

    try {
      const source  = params.source  || '';
      const limit   = Math.min(parseInt(params.limit) || 50, 200);
      const offset  = parseInt(params.offset) || 0;

      let query = `smflow_assets?tenant_id=eq.${tenantId}&is_active=eq.true`;
      if (source) query += `&source=eq.${encodeURIComponent(source)}`;
      query += `&order=created_at.desc&limit=${limit}&offset=${offset}`;

      const assets = await sb(query);

      // Client-side filter by tag if requested (GIN index handles this efficiently in DB)
      let filtered = assets;
      if (params.flavor) {
        filtered = assets.filter(a => a.flavor_tags?.includes(params.flavor));
      }
      if (params.topic) {
        const topicLower = params.topic.toLowerCase();
        filtered = filtered.filter(a =>
          a.topic_tags?.some(t => t.toLowerCase().includes(topicLower)) ||
          a.file_name?.toLowerCase().includes(topicLower) ||
          a.alt_text?.toLowerCase().includes(topicLower)
        );
      }

      return {
        statusCode: 200,
        headers:    HEADERS,
        body:       JSON.stringify({ assets: filtered, total: filtered.length }),
      };
    } catch (err) {
      console.error('smflow-assets GET error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
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

      // ── get_upload_url: generate signed upload URL ────
      if (action === 'get_upload_url') {
        const { file_name, file_type = 'image/jpeg' } = body;
        if (!file_name) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'file_name required' }) };

        const ext      = file_type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        const safeName = file_name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
        const path     = `${tenant_id}/smflow/${Date.now()}_${safeName}`;

        const { data, error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .createSignedUploadUrl(path);

        if (error) throw error;

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;

        return {
          statusCode: 200,
          headers:    HEADERS,
          body:       JSON.stringify({
            upload_url: data.signedUrl,
            public_url: publicUrl,
            path,
          }),
        };
      }

      // ── confirm_upload: save asset record after upload ─
      if (action === 'confirm_upload') {
        const {
          file_url, file_name, file_type, file_size_bytes,
          width_px, height_px, topic_tags = [], flavor_tags = [],
          platform_tags = [], alt_text, caption_suggestion,
          source = 'upload',
        } = body;
        if (!file_url) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'file_url required' }) };

        const inserted = await sb('smflow_assets', {
          method: 'POST',
          prefer: 'return=representation',
          body: {
            tenant_id,
            file_url,
            file_name:          file_name          || null,
            file_type:          file_type          || null,
            file_size_bytes:    file_size_bytes    || null,
            width_px:           width_px           || null,
            height_px:          height_px          || null,
            source,
            topic_tags,
            flavor_tags,
            platform_tags,
            alt_text:           alt_text           || null,
            caption_suggestion: caption_suggestion || null,
            is_active:          true,
            created_at:         new Date().toISOString(),
            updated_at:         new Date().toISOString(),
          },
        });

        return {
          statusCode: 200,
          headers:    HEADERS,
          body:       JSON.stringify({ success: true, asset: inserted?.[0] || null }),
        };
      }

      // ── delete: soft delete an asset ─────────────────
      if (action === 'delete') {
        const { asset_id } = body;
        if (!asset_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'asset_id required' }) };

        const check = await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Asset not found' }) };

        await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body:   { is_active: false, updated_at: new Date().toISOString() },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── tag: update topic/flavor tags on an asset ─────
      if (action === 'tag') {
        const { asset_id, topic_tags, flavor_tags, platform_tags, alt_text } = body;
        if (!asset_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'asset_id required' }) };

        await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            ...(topic_tags    !== undefined && { topic_tags }),
            ...(flavor_tags   !== undefined && { flavor_tags }),
            ...(platform_tags !== undefined && { platform_tags }),
            ...(alt_text      !== undefined && { alt_text }),
            updated_at: new Date().toISOString(),
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── gdrive_connect: save Google Drive folder config ─
      if (action === 'gdrive_connect') {
        const { folder_id, folder_name, folder_url, connected_by = 'tenant_owner' } = body;
        if (!folder_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'folder_id required' }) };

        // Check if config exists
        const existing = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=id&limit=1`);

        if (existing.length) {
          await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: {
              folder_id, folder_name: folder_name || null,
              folder_url: folder_url || null,
              sync_enabled: true,
              updated_at: new Date().toISOString(),
            },
          });
        } else {
          await sb('smflow_gdrive_config', {
            method: 'POST',
            prefer: 'return=minimal',
            body: {
              tenant_id, folder_id,
              folder_name:   folder_name  || null,
              folder_url:    folder_url   || null,
              connected_by,
              sync_enabled:  true,
              created_at:    new Date().toISOString(),
              updated_at:    new Date().toISOString(),
            },
          });
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // ── gdrive_sync: import files from connected folder ─
      // NOTE: This is a placeholder — full Google Drive API
      // integration requires OAuth tokens per tenant.
      // For now, returns the configured folder URL so
      // AITECHNIC admin can manually sync.
      if (action === 'gdrive_sync') {
        const config = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=*&limit=1`);
        if (!config.length) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No Google Drive folder connected' }) };
        }

        // Update last_synced_at
        await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body:   { last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        });

        return {
          statusCode: 200,
          headers:    HEADERS,
          body:       JSON.stringify({
            success:    true,
            folder_url: config[0].folder_url,
            folder_id:  config[0].folder_id,
            message:    'Google Drive API sync — connect via OAuth to enable automatic import',
          }),
        };
      }

      return {
        statusCode: 400,
        headers:    HEADERS,
        body:       JSON.stringify({ error: `Unknown action: ${action}` }),
      };

    } catch (err) {
      console.error('smflow-assets POST error:', err.message);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
