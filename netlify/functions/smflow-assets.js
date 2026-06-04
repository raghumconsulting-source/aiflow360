// netlify/functions/smflow-assets.js
// Asset library management + Google Drive integration
//
// Actions:
//   GET  ?tenant_id=&source=&flavor=&topic=  → list assets
//   POST action='get_upload_url'             → signed upload URL
//   POST action='confirm_upload'             → save asset after upload
//   POST action='delete'                     → soft delete
//   POST action='tag'                        → update tags
//   POST action='create_drive_folder'        → create folder structure in Drive
//   POST action='gdrive_connect'             → save folder config
//   POST action='gdrive_sync'               → sync photos from Drive
//   POST action='gdrive_status'             → check connection status

const { createClient } = require('@supabase/supabase-js');
const { google }       = require('googleapis');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET       = 'tenant-assets';
const SA_EMAIL             = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY               = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

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

function getDriveClient() {
  if (!SA_EMAIL || !SA_KEY) throw new Error('Google service account credentials not configured');
  let keyData;
  try { keyData = JSON.parse(SA_KEY); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY must be full JSON file contents'); }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: keyData.client_email || SA_EMAIL, private_key: keyData.private_key },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

const FOLDER_TEMPLATES = {
  accommodation_food:     ['01-food-drinks','02-interior','03-exterior','04-team','05-behind-scenes','06-customers','07-events','08-specials-promos'],
  beauty:                 ['01-treatments-services','02-before-after-results','03-salon-interior','04-team','05-products','06-customers','07-events'],
  arts_recreation:        ['01-facilities-equipment','02-classes-in-action','03-trainers-coaches','04-member-results','05-events-competitions','06-behind-scenes'],
  retail_trade:           ['01-products-new-arrivals','02-store-interior','03-team','04-customers','05-events-sales','06-behind-scenes'],
  healthcare:             ['01-clinic-interior','02-team-practitioners','03-equipment-technology','04-community-events','05-awards-certificates'],
  professional_technical: ['01-office-workspace','02-team','03-work-in-action','04-events-seminars','05-awards-certificates','06-community'],
  financial_insurance:    ['01-office','02-team','03-events-seminars','04-awards-community','05-client-meetings'],
  information_media:      ['01-office-workspace','02-team','03-work-in-action','04-events-conferences','05-products-demos'],
  transport:              ['01-vehicles-fleet','02-team-drivers','03-operations','04-community'],
  admin_support:          ['01-team-at-work','02-before-after','03-equipment','04-customers','05-community'],
  personal_services:      ['01-services-in-action','02-results','03-team','04-customers','05-events'],
  tourism:                ['01-experiences','02-locations-scenery','03-team-guides','04-customers-guests','05-events','06-behind-scenes'],
  default:                ['01-business-photos','02-team','03-customers','04-products-services','05-events','06-behind-scenes'],
};

const FOLDER_TAG_MAP = {
  'food-drinks':          { topic:['food','drinks','menu','coffee'],        flavor:['social_proof','fomo','inspiration','humor'] },
  'interior':             { topic:['interior','venue','ambiance','decor'],   flavor:['inspiration','awareness','behind_scenes'] },
  'exterior':             { topic:['exterior','storefront','location'],      flavor:['awareness','social_proof','trending'] },
  'team':                 { topic:['team','staff','people','employee'],      flavor:['behind_scenes','social_proof','humor'] },
  'behind-scenes':        { topic:['behind scenes','process','kitchen'],     flavor:['behind_scenes','humor','inspiration'] },
  'customers':            { topic:['customers','clients','happy'],           flavor:['social_proof','fomo','challenge'] },
  'events':               { topic:['events','function','celebration'],       flavor:['fomo','urgency','inspiration'] },
  'specials-promos':      { topic:['specials','promotions','offers'],        flavor:['urgency','fomo','trending'] },
  'treatments-services':  { topic:['treatment','service','beauty'],          flavor:['education','social_proof','inspiration'] },
  'before-after-results': { topic:['results','transformation'],              flavor:['social_proof','inspiration','myth_bust'] },
  'salon-interior':       { topic:['salon','interior','space'],              flavor:['inspiration','awareness','social_proof'] },
  'products':             { topic:['products','items','range'],              flavor:['education','social_proof','fomo'] },
  'facilities-equipment': { topic:['facilities','equipment','gym'],          flavor:['awareness','education','social_proof'] },
  'classes-in-action':    { topic:['class','workout','training'],            flavor:['inspiration','social_proof','challenge'] },
  'trainers-coaches':     { topic:['trainer','coach','expert'],              flavor:['education','social_proof','inspiration'] },
  'member-results':       { topic:['results','transformation','member'],     flavor:['social_proof','inspiration','fomo'] },
  'products-new-arrivals':{ topic:['products','new arrivals','stock'],       flavor:['awareness','fomo','trending'] },
  'store-interior':       { topic:['store','shop','interior'],               flavor:['inspiration','awareness','social_proof'] },
  'clinic-interior':      { topic:['clinic','medical','interior'],           flavor:['awareness','social_proof','inspiration'] },
  'team-practitioners':   { topic:['team','doctor','practitioner'],          flavor:['social_proof','education','inspiration'] },
  'equipment-technology': { topic:['equipment','technology','modern'],       flavor:['education','awareness','social_proof'] },
  'office-workspace':     { topic:['office','workspace','professional'],     flavor:['behind_scenes','social_proof','inspiration'] },
  'work-in-action':       { topic:['work','consulting','meeting'],           flavor:['behind_scenes','social_proof','education'] },
  'events-seminars':      { topic:['events','seminar','conference'],         flavor:['fomo','inspiration','social_proof'] },
  'awards-certificates':  { topic:['awards','certificate','achievement'],    flavor:['social_proof','inspiration','education'] },
  'community':            { topic:['community','local','support'],           flavor:['inspiration','social_proof','behind_scenes'] },
  'vehicles-fleet':       { topic:['vehicles','fleet','transport'],          flavor:['awareness','social_proof','education'] },
  'experiences':          { topic:['experience','adventure','tour'],         flavor:['inspiration','fomo','social_proof'] },
  'locations-scenery':    { topic:['location','scenery','destination'],      flavor:['inspiration','fomo','awareness'] },
  'business-photos':      { topic:['business','professional'],               flavor:['awareness','social_proof','inspiration'] },
  'products-services':    { topic:['products','services','offering'],        flavor:['education','social_proof','fomo'] },
};

function getFolderKey(name) {
  return name.toLowerCase().replace(/^\d+-/, '').replace(/\s+/g, '-').trim();
}

function getTagsFromFolder(name) {
  const key  = getFolderKey(name);
  const tags = FOLDER_TAG_MAP[key];
  if (tags) return tags;
  const words = key.split('-').filter(w => w.length > 2);
  return { topic: words, flavor: ['social_proof','awareness','behind_scenes'] };
}

async function driveCreateFolder(drive, name, parentId) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const res = await drive.files.create({ requestBody: meta, fields: 'id,name,webViewLink' });
  return res.data;
}

async function driveShareFolder(drive, fileId, role = 'writer') {
  await drive.permissions.create({ fileId, requestBody: { role, type: 'anyone' } });
}

async function driveCreateReadme(drive, parentId, subFolders) {
  const lines = subFolders.map(f => `  ${f.padEnd(35)} → ${getTagsFromFolder(f).topic.slice(0,3).join(', ')}`).join('\n');
  const content = `SMflow Photo Library — Instructions\n=====================================\n\nDrop your photos into the right sub-folder:\n\n${lines}\n\nTIPS:\n- Aim for 5-10 photos per folder\n- Any format: JPG, PNG, HEIC, WEBP, MP4\n- Don't rename files — just drop them in\n- The more photos, the better the matching`;
  await drive.files.create({
    requestBody: { name: 'READ ME — How to add your photos.txt', mimeType: 'text/plain', parents: [parentId] },
    media: { mimeType: 'text/plain', body: content },
  });
}

async function driveListSubFolders(drive, folderId) {
  const res = await drive.files.list({
    q:        `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields:   'files(id,name)',
    pageSize: 50,
  });
  return res.data.files || [];
}

async function driveListFiles(drive, folderId) {
  const res = await drive.files.list({
    q:        `'${folderId}' in parents and trashed = false`,
    fields:   'files(id,name,mimeType,size,webContentLink,thumbnailLink,createdTime)',
    pageSize: 100,
  });
  return res.data.files || [];
}

const getDrivePublicUrl   = id => `https://drive.google.com/uc?export=view&id=${id}`;
const getDriveThumbnailUrl = id => `https://drive.google.com/thumbnail?id=${id}&sz=w400`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const params   = event.queryStringParameters || {};
  const tenantId = params.tenant_id;

  if (event.httpMethod === 'GET') {
    if (!tenantId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
    try {
      const limit  = Math.min(parseInt(params.limit) || 50, 200);
      const offset = parseInt(params.offset) || 0;
      let query = `smflow_assets?tenant_id=eq.${tenantId}&is_active=eq.true`;
      if (params.source) query += `&source=eq.${encodeURIComponent(params.source)}`;
      query += `&order=created_at.desc&limit=${limit}&offset=${offset}`;
      let assets = await sb(query);
      if (params.flavor) assets = assets.filter(a => a.flavor_tags?.includes(params.flavor));
      if (params.topic) {
        const tl = params.topic.toLowerCase();
        assets = assets.filter(a => a.topic_tags?.some(t => t.toLowerCase().includes(tl)) || a.file_name?.toLowerCase().includes(tl));
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ assets, total: assets.length }) };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, tenant_id } = body;
    if (!tenant_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };

    try {

      if (action === 'create_drive_folder') {
        const { tenant_name, industry_code } = body;
        if (!tenant_name) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_name required' }) };
        const drive      = getDriveClient();
        const subFolders = FOLDER_TEMPLATES[industry_code] || FOLDER_TEMPLATES.default;
        const rootFolder = await driveCreateFolder(drive, `SMflow — ${tenant_name}`, null);
        for (const f of subFolders) await driveCreateFolder(drive, f, rootFolder.id);
        await driveCreateReadme(drive, rootFolder.id, subFolders);
        await driveShareFolder(drive, rootFolder.id, 'writer');
        const folderUrl = `https://drive.google.com/drive/folders/${rootFolder.id}`;
        const existing  = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=id&limit=1`);
        const configPayload = {
          tenant_id, folder_id: rootFolder.id,
          folder_name:      `SMflow — ${tenant_name}`,
          folder_url:       folderUrl,
          folder_structure: industry_code || 'default',
          connected_by:     'aitechnic_admin',
          sync_enabled:     true,
          updated_at:       new Date().toISOString(),
        };
        if (existing.length) {
          await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, { method:'PATCH', prefer:'return=minimal', body: configPayload });
        } else {
          await sb('smflow_gdrive_config', { method:'POST', prefer:'return=minimal', body: { ...configPayload, created_at: new Date().toISOString() } });
        }
        return {
          statusCode: 200, headers: HEADERS,
          body: JSON.stringify({
            success:       true,
            folder_id:     rootFolder.id,
            folder_url:    folderUrl,
            sub_folders:   subFolders,
            share_message: `Hi! Your SMflow photo folder is ready.\n\n📁 ${folderUrl}\n\nYou'll find ${subFolders.length} folders inside. Drop your photos into the right folder. There's a READ ME file with full instructions.\n\nOnce done, let us know and we'll sync everything into SMflow for you.`,
          }),
        };
      }

      if (action === 'gdrive_sync') {
        const configs = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&limit=1`);
        if (!configs.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No Google Drive folder connected' }) };
        const config   = configs[0];
        const drive    = getDriveClient();
        const syncedAt = new Date().toISOString();
        const results  = { imported: 0, skipped: 0, errors: [] };
        const existing = await sb(`smflow_assets?tenant_id=eq.${tenant_id}&source=eq.gdrive&select=gdrive_file_id`);
        const existingIds = new Set(existing.map(a => a.gdrive_file_id).filter(Boolean));
        const subFolders  = await driveListSubFolders(drive, config.folder_id);
        const foldersToProcess = subFolders.length > 0
          ? subFolders.map(f => ({ ...f, tags: getTagsFromFolder(f.name) }))
          : [{ id: config.folder_id, name: 'root', tags: { topic:['business'], flavor:['social_proof','awareness'] } }];
        for (const folder of foldersToProcess) {
          const files = await driveListFiles(drive, folder.id);
          for (const file of files) {
            if (!file.mimeType?.startsWith('image/') && !file.mimeType?.startsWith('video/')) continue;
            if (existingIds.has(file.id)) { results.skipped++; continue; }
            try {
              await sb('smflow_assets', {
                method: 'POST', prefer: 'return=minimal',
                body: {
                  tenant_id,
                  file_url:       getDrivePublicUrl(file.id),
                  thumbnail_url:  getDriveThumbnailUrl(file.id),
                  file_name:      file.name,
                  file_type:      file.mimeType,
                  source:         'gdrive',
                  gdrive_file_id: file.id,
                  topic_tags:     folder.tags.topic,
                  flavor_tags:    folder.tags.flavor,
                  platform_tags:  ['Facebook','Instagram','WhatsApp'],
                  alt_text:       folder.name !== 'root' ? folder.name.replace(/^\d+-/,'') + ' photo' : null,
                  is_active:      true,
                  created_at:     syncedAt,
                  updated_at:     syncedAt,
                },
              });
              results.imported++;
            } catch (e) { results.errors.push({ file: file.name, error: e.message }); }
          }
        }
        await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { last_synced_at: syncedAt, files_synced: (config.files_synced||0) + results.imported, updated_at: syncedAt },
        });
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ success:true, ...results, message:`Synced ${results.imported} new photos from Google Drive` }) };
      }

      if (action === 'gdrive_status') {
        const configs = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&limit=1`);
        if (!configs.length) return { statusCode:200, headers:HEADERS, body: JSON.stringify({ connected:false }) };
        const c = configs[0];
        const count = await sb(`smflow_assets?tenant_id=eq.${tenant_id}&source=eq.gdrive&is_active=eq.true&select=id`);
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ connected:true, folder_url:c.folder_url, folder_name:c.folder_name, last_synced_at:c.last_synced_at, files_synced:c.files_synced||0, assets_in_db:count.length }) };
      }

      if (action === 'get_upload_url') {
        const { file_name, file_type = 'image/jpeg' } = body;
        if (!file_name) return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:'file_name required' }) };
        const ext      = file_type.split('/')[1]?.replace('jpeg','jpg') || 'jpg';
        const safeName = file_name.replace(/[^a-z0-9._-]/gi,'_').toLowerCase();
        const path     = `${tenant_id}/smflow/${Date.now()}_${safeName}`;
        const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUploadUrl(path);
        if (error) throw error;
        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ upload_url:data.signedUrl, public_url:publicUrl, path }) };
      }

      if (action === 'confirm_upload') {
        const { file_url, file_name, file_type, file_size_bytes, width_px, height_px, topic_tags=[], flavor_tags=[], platform_tags=[], alt_text, source='upload' } = body;
        if (!file_url) return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:'file_url required' }) };
        const inserted = await sb('smflow_assets', {
          method:'POST', prefer:'return=representation',
          body: { tenant_id, file_url, file_name:file_name||null, file_type:file_type||null, file_size_bytes:file_size_bytes||null, width_px:width_px||null, height_px:height_px||null, source, topic_tags, flavor_tags, platform_tags, alt_text:alt_text||null, is_active:true, created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
        });
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ success:true, asset:inserted?.[0]||null }) };
      }

      if (action === 'delete') {
        const { asset_id } = body;
        if (!asset_id) return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:'asset_id required' }) };
        const check = await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (!check.length) return { statusCode:404, headers:HEADERS, body: JSON.stringify({ error:'Asset not found' }) };
        await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}`, { method:'PATCH', prefer:'return=minimal', body:{ is_active:false, updated_at:new Date().toISOString() } });
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ success:true }) };
      }

      if (action === 'tag') {
        const { asset_id, topic_tags, flavor_tags, platform_tags, alt_text } = body;
        if (!asset_id) return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:'asset_id required' }) };
        await sb(`smflow_assets?id=eq.${asset_id}&tenant_id=eq.${tenant_id}`, {
          method:'PATCH', prefer:'return=minimal',
          body: { ...(topic_tags!==undefined&&{topic_tags}), ...(flavor_tags!==undefined&&{flavor_tags}), ...(platform_tags!==undefined&&{platform_tags}), ...(alt_text!==undefined&&{alt_text}), updated_at:new Date().toISOString() },
        });
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ success:true }) };
      }

      if (action === 'gdrive_connect') {
        const { folder_id, folder_name, folder_url, connected_by='tenant_owner' } = body;
        if (!folder_id) return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:'folder_id required' }) };
        const existing = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=id&limit=1`);
        if (existing.length) {
          await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, { method:'PATCH', prefer:'return=minimal', body:{ folder_id, folder_name:folder_name||null, folder_url:folder_url||null, sync_enabled:true, updated_at:new Date().toISOString() } });
        } else {
          await sb('smflow_gdrive_config', { method:'POST', prefer:'return=minimal', body:{ tenant_id, folder_id, folder_name:folder_name||null, folder_url:folder_url||null, connected_by, sync_enabled:true, created_at:new Date().toISOString(), updated_at:new Date().toISOString() } });
        }
        return { statusCode:200, headers:HEADERS, body: JSON.stringify({ success:true }) };
      }

      return { statusCode:400, headers:HEADERS, body: JSON.stringify({ error:`Unknown action: ${action}` }) };

    } catch (err) {
      console.error('smflow-assets error:', err.message);
      return { statusCode:500, headers:HEADERS, body: JSON.stringify({ error:err.message }) };
    }
  }

  return { statusCode:405, headers:HEADERS, body: JSON.stringify({ error:'Method not allowed' }) };
};
