import { withLambda } from '@netlify/aws-lambda-compat';
import googleapisPkg from 'googleapis';
import gsaBundled from './_gsa.json';

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

import { createClient } from '@supabase/supabase-js';
const { google } = googleapisPkg;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET       = 'tenant-assets';
const SA_EMAIL             = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SHARED_DRIVE_ID      = process.env.GOOGLE_SHARED_DRIVE_ID; // SMflow Clients folder ID

// Google service account key.
// The full JSON key is ~2 KB — too large to ship as a per-function environment
// variable (AWS Lambda caps a function's env at 4 KB, and Netlify injects every
// site variable into every function). Instead the build step (inject-env.js)
// writes it to _gsa.json, which esbuild bundles into this function only. We keep
// an env-var fallback so local dev keeps working.
function loadServiceAccountKey() {
  if (gsaBundled && gsaBundled.private_key) return gsaBundled;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY must be full JSON file contents'); }
  }
  return null;
}

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

// Service accounts have no storage quota of their own and can only create
// files inside a Google Workspace Shared Drive — never in anyone's "My
// Drive", not even their own (Google API error: "Service Accounts do not
// have storage quota"). Personal/free Gmail accounts can't have Shared
// Drives at all, so folder *creation* must happen under the client's own
// OAuth-authorised account instead. getDriveClient() below (service account)
// is still used for *reading* synced photos from a folder the client has
// separately shared — that doesn't touch storage quota, only writes do.
// Ported from smflow-assets.js (2026-06), where this was built but never
// carried over to this .mjs file — meaning create_drive_folder kept hitting
// the broken service-account path here even after the fix shipped.
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;     // same OAuth client used for Drive scope
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

async function getClientDriveAuth(tenantId) {
  const accounts = await sb(`smflow_social_accounts?tenant_id=eq.${tenantId}&platform=eq.google_drive&is_active=eq.true&limit=1`);
  if (!accounts.length) {
    throw new Error('No Google Drive account connected for this tenant. Connect Google Drive first under Social accounts.');
  }
  const account = accounts[0];
  let accessToken = account.access_token;

  // Refresh if expired or expiring within the next 60 seconds
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (!account.refresh_token) {
    throw new Error('Google Drive connection is missing a refresh token — please reconnect Google Drive.');
  }
  if (Date.now() > expiresAt - 60000) {
    const refreshRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type:    'refresh_token',
      }),
    });
    const refreshData = await refreshRes.json();
    if (!refreshData.access_token) {
      throw new Error(`Could not refresh Google Drive access — please reconnect Google Drive. (${refreshData.error || 'unknown error'})`);
    }
    accessToken = refreshData.access_token;
    const newExpiresAt = refreshData.expires_in ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString() : null;
    await sb(`smflow_social_accounts?id=eq.${account.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { access_token: accessToken, token_expires_at: newExpiresAt, updated_at: new Date().toISOString() },
    });
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

async function getClientDriveClient(tenantId) {
  const auth = await getClientDriveAuth(tenantId);
  return google.drive({ version: 'v3', auth });
}

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
  // ── Backfilled — these folder keys were already used in FOLDER_TEMPLATES
  // above but had no entry here, so they silently fell through to the
  // generic word-split fallback in getTagsFromFolder() instead of getting
  // real curated tags. Found during the ecommerce/industry-gap audit (2026-06). ──
  'office':               { topic:['office','workspace','professional'],     flavor:['behind_scenes','social_proof','inspiration'] },
  'operations':           { topic:['operations','logistics','process'],      flavor:['behind_scenes','education','social_proof'] },
  'team-at-work':         { topic:['team','staff','working'],                flavor:['behind_scenes','social_proof','humor'] },
  'customers-guests':     { topic:['customers','guests','happy'],            flavor:['social_proof','fomo','inspiration'] },
  'events-sales':         { topic:['sale','promotion','event'],              flavor:['urgency','fomo','trending'] },
  'team-drivers':         { topic:['team','driver','staff'],                 flavor:['behind_scenes','social_proof','education'] },
  'team-guides':          { topic:['team','guide','host'],                   flavor:['social_proof','education','inspiration'] },
  'before-after':         { topic:['before','after','transformation'],       flavor:['social_proof','inspiration','myth_bust'] },
  'events-conferences':   { topic:['events','conference','seminar'],         flavor:['fomo','inspiration','social_proof'] },
  'services-in-action':   { topic:['service','process','action'],           flavor:['behind_scenes','education','social_proof'] },
  'events-competitions':  { topic:['events','competition','challenge'],      flavor:['fomo','urgency','social_proof'] },
  'community-events':     { topic:['community','event','local'],            flavor:['inspiration','social_proof','behind_scenes'] },
  'client-meetings':      { topic:['client','meeting','consultation'],       flavor:['behind_scenes','education','social_proof'] },
  'products-demos':       { topic:['product','demo','showcase'],            flavor:['education','awareness','social_proof'] },
  'results':              { topic:['results','outcome','success'],          flavor:['social_proof','inspiration','myth_bust'] },
  'equipment':             { topic:['equipment','tools','gear'],             flavor:['education','awareness','social_proof'] },
  'awards-community':     { topic:['awards','community','recognition'],      flavor:['social_proof','inspiration','education'] },
  // ── New folder keys introduced by the 7 newly-added industry templates below ──
  'menswear-womenswear':  { topic:['menswear','womenswear','apparel'],       flavor:['awareness','social_proof','fomo'] },
  'packaging-shipping':   { topic:['packaging','shipping','unboxing'],       flavor:['behind_scenes','social_proof','trending'] },
  'reviews-ugc':          { topic:['reviews','testimonial','customer photo'],flavor:['social_proof','myth_bust','fomo'] },
  'website-product-shots':{ topic:['product shot','online store','catalogue'],flavor:['awareness','education','fomo'] },
  'job-sites':            { topic:['job site','worksite','construction'],    flavor:['behind_scenes','social_proof','education'] },
  'tools-vehicles':       { topic:['tools','vehicle','equipment'],           flavor:['awareness','education','social_proof'] },
  'completed-projects':   { topic:['project','renovation','build'],         flavor:['social_proof','inspiration','myth_bust'] },
  'workshop-garage':      { topic:['workshop','garage','service bay'],       flavor:['behind_scenes','education','social_proof'] },
  'vehicles-in-service':  { topic:['vehicle','car','service'],              flavor:['social_proof','education','behind_scenes'] },
  'classroom-learning':   { topic:['classroom','lesson','learning'],         flavor:['education','social_proof','inspiration'] },
  'students-success':     { topic:['student','success','graduation'],       flavor:['social_proof','inspiration','fomo'] },
  'properties-listings':  { topic:['property','listing','real estate'],      flavor:['awareness','fomo','trending'] },
  'open-homes':           { topic:['open home','inspection','viewing'],     flavor:['urgency','fomo','awareness'] },
  'sold-leased':          { topic:['sold','leased','success'],              flavor:['social_proof','fomo','inspiration'] },
  'farm-produce':         { topic:['farm','produce','harvest'],             flavor:['behind_scenes','education','social_proof'] },
  'seasonal':             { topic:['seasonal','harvest','growing'],         flavor:['trending','awareness','inspiration'] },
  'production-line':      { topic:['production','manufacturing','factory'], flavor:['behind_scenes','education','social_proof'] },
  'finished-products':    { topic:['finished product','quality','craftsmanship'], flavor:['social_proof','education','awareness'] },
  'quality-control':      { topic:['quality control','inspection','standards'], flavor:['education','social_proof','myth_bust'] },
};

function getDriveClient() {
  const keyData = loadServiceAccountKey();
  if (!keyData || !keyData.private_key) throw new Error('Google service account credentials not configured');
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
  // ── Added 2026-06 — these 7 industries had no template at all and were
  // silently falling through to `default` (generic, not industry-shaped).
  // Found during the FEMIQN/ecommerce folder-creation audit. ──
  ecommerce:              ['01-products-new-arrivals','02-packaging-shipping','03-customers','04-reviews-ugc','05-behind-scenes','06-website-product-shots'],
  construction_trade:     ['01-job-sites','02-tools-vehicles','03-team','04-completed-projects','05-before-after'],
  automotive:              ['01-vehicles-fleet','02-workshop-garage','03-team','04-vehicles-in-service','05-customers'],
  education_training:      ['01-classroom-learning','02-team','03-students-success','04-events','05-behind-scenes'],
  real_estate:             ['01-properties-listings','02-open-homes','03-team','04-sold-leased','05-events'],
  agriculture:             ['01-farm-produce','02-team','03-seasonal','04-behind-scenes','05-customers'],
  manufacturing:           ['01-production-line','02-finished-products','03-team','04-behind-scenes','05-quality-control'],
  default:                ['01-business-photos','02-team','03-customers','04-products-services','05-events','06-behind-scenes'],
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
  // Use provided parentId, or fall back to shared SMflow Clients folder
  meta.parents = [parentId || SHARED_DRIVE_ID];
  const res = await drive.files.create({
    requestBody: meta,
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,  // required for shared drives
  });
  return res.data;
}

async function driveShareFolder(drive, fileId, role = 'writer') {
  // Only share if not inside a Shared Drive (shared drives inherit permissions)
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role, type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch(e) {
    // Non-fatal — shared drive folders inherit access from parent
    console.warn('driveShareFolder non-fatal:', e.message);
  }
}

async function driveCreateReadme(drive, parentId, subFolders) {
  const lines = subFolders.map(f => `  ${f.padEnd(35)} → ${getTagsFromFolder(f).topic.slice(0,3).join(', ')}`).join('\n');
  const content = `SMflow Photo Library — Instructions\n=====================================\n\nDrop your photos into the right sub-folder:\n\n${lines}\n\nTIPS:\n- Aim for 5-10 photos per folder\n- Any format: JPG, PNG, HEIC, WEBP, MP4\n- Don't rename files — just drop them in\n- The more photos, the better the matching`;
  await drive.files.create({
    requestBody: { name: 'READ ME — How to add your photos.txt', mimeType: 'text/plain', parents: [parentId] },
    media: { mimeType: 'text/plain', body: content },
    supportsAllDrives: true,
  });
}

async function driveListSubFolders(drive, folderId) {
  const res = await drive.files.list({
    q:                `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields:           'files(id,name)',
    pageSize:         50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

async function driveListFiles(drive, folderId) {
  const res = await drive.files.list({
    q:                `'${folderId}' in parents and trashed = false`,
    fields:           'files(id,name,mimeType,size,webContentLink,thumbnailLink,createdTime)',
    pageSize:         100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

// Download a file from Google Drive and upload to Supabase Storage.
// Returns { file_url, thumbnail_url, storage_path } served from own domain — no CORS issues.
async function downloadAndStore(drive, fileId, fileName, mimeType, tenantId) {
  // 1. Download binary from Drive using service account
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.from(res.data);

  // 2. Build a safe storage path
  const safeName = fileName.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
  const path     = `${tenantId}/smflow/gdrive/${Date.now()}_${safeName}`;

  // 3. Upload to Supabase Storage via REST (service key, bypasses RLS)
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
  const uploadRes = await fetch(uploadUrl, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  mimeType || 'image/jpeg',
      'x-upsert':      'true',
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    throw new Error(`Storage upload failed (${uploadRes.status}): ${txt.slice(0, 200)}`);
  }

  // 4. Public URL — own domain, no CORS
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
  return { file_url: publicUrl, thumbnail_url: publicUrl, storage_path: path };
}

const handler = async function (event) {
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
        const { tenant_name, industry_code, connected_by } = body;
        if (!tenant_name) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_name required' }) };

        // Idempotency check: if this tenant already has a folder, return it instead of creating a duplicate.
        const existingConfig = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=*&limit=1`);
        if (existingConfig.length && existingConfig[0].folder_id) {
          const cfg = existingConfig[0];
          const subFolders = FOLDER_TEMPLATES[cfg.folder_structure] || FOLDER_TEMPLATES.default;
          return {
            statusCode: 200, headers: HEADERS,
            body: JSON.stringify({
              success:        true,
              already_exists: true,
              folder_id:      cfg.folder_id,
              folder_url:     cfg.folder_url,
              sub_folders:    subFolders,
              share_message:  `Your SMflow photo folder:\n\n📁 ${cfg.folder_url}\n\nDrop your photos into the matching folder. There's a READ ME file inside with instructions.`,
            }),
          };
        }

        // Claim the slot BEFORE touching Google Drive, not after. A unique constraint on
        // smflow_gdrive_config.tenant_id (required — see migration note below) makes this
        // insert fail for the second of two near-simultaneous requests, so only one request
        // ever proceeds to create a real Drive folder. The earlier "create folder then check
        // again" order had a window where two concurrent requests could both pass the read
        // check above and both create orphaned Drive folders before either write landed.
        const claimRow = {
          tenant_id,
          folder_id:        'pending',
          folder_name:      `SMflow — ${tenant_name}`,
          folder_url:       null,
          folder_structure: industry_code || 'default',
          connected_by:     connected_by || 'aitechnic_admin',
          sync_enabled:     false,
          created_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        };
        try {
          await sb('smflow_gdrive_config', { method: 'POST', prefer: 'return=minimal', body: claimRow });
        } catch (claimErr) {
          // Insert failed — most likely a concurrent request just won the race and claimed the
          // row first (unique constraint violation), or another genuine DB error. Either way,
          // re-read and return whatever now exists rather than risk creating a second folder.
          const recheck = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&select=*&limit=1`);
          if (recheck.length && recheck[0].folder_id && recheck[0].folder_id !== 'pending') {
            const cfg = recheck[0];
            const subFolders = FOLDER_TEMPLATES[cfg.folder_structure] || FOLDER_TEMPLATES.default;
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, already_exists: true, folder_id: cfg.folder_id, folder_url: cfg.folder_url, sub_folders: subFolders, share_message: `Your SMflow photo folder:\n\n📁 ${cfg.folder_url}\n\nDrop your photos into the matching folder.` }) };
          }
          throw new Error(`Could not claim folder creation slot: ${claimErr.message}`);
        }

        // From here on, Drive API calls can fail partway through. If they do, clear the
        // 'pending' claim so a retry can actually proceed instead of being permanently stuck
        // behind a row that claims a folder exists but doesn't.
        try {
          // Folders are created under the CLIENT's own Google Drive (via their OAuth
          // connection), not the AITECHNIC service account — service accounts have no
          // storage quota and can't create files outside a Workspace Shared Drive, which
          // personal Gmail accounts can't have. See getClientDriveClient() for details.
          const drive      = await getClientDriveClient(tenant_id);
          const subFolders = FOLDER_TEMPLATES[industry_code] || FOLDER_TEMPLATES.default;
          const rootFolder = await driveCreateFolder(drive, `SMflow — ${tenant_name}`, null);
          for (const f of subFolders) await driveCreateFolder(drive, f, rootFolder.id);
          await driveCreateReadme(drive, rootFolder.id, subFolders);
          // No driveShareFolder() call here — the client already owns this folder outright
          // (it's in their own Drive), so there's no one else to share it with at creation
          // time. They can share it themselves later if they want a teammate to drop photos in.
          const folderUrl = `https://drive.google.com/drive/folders/${rootFolder.id}`;

          await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { folder_id: rootFolder.id, folder_url: folderUrl, sync_enabled: true, updated_at: new Date().toISOString() },
          });

          return {
            statusCode: 200, headers: HEADERS,
            body: JSON.stringify({
              success:       true,
              already_exists: false,
              folder_id:     rootFolder.id,
              folder_url:    folderUrl,
              sub_folders:   subFolders,
              share_message: `Hi! Your SMflow photo folder is ready.\n\n📁 ${folderUrl}\n\nYou'll find ${subFolders.length} folders inside. Drop your photos into the right folder. There's a READ ME file with full instructions.\n\nOnce done, let us know and we'll sync everything into SMflow for you.`,
            }),
          };
        } catch (driveErr) {
          // Drive creation failed partway through (e.g. root folder created but a sub-folder
          // call failed). Release the claim so the client can retry cleanly instead of being
          // stuck behind a permanent 'pending' row that never resolves.
          await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}`, {
            method: 'DELETE', prefer: 'return=minimal',
          }).catch(() => {}); // best-effort cleanup; surfacing the original error matters more
          throw new Error(`Drive folder creation failed: ${driveErr.message}. Please try again.`);
        }
      }

      if (action === 'gdrive_sync') {
        const configs = await sb(`smflow_gdrive_config?tenant_id=eq.${tenant_id}&limit=1`);
        if (!configs.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No Google Drive folder connected' }) };
        const config   = configs[0];
        const drive    = getDriveClient();
        const syncedAt = new Date().toISOString();
        const results  = { imported: 0, skipped: 0, errors: [] };

        // re_sync=true: soft-delete all existing gdrive assets first so they are re-downloaded
        // and stored in Supabase Storage (fixes old broken Google Drive thumbnail URLs)
        if (body.re_sync) {
          await sb(`smflow_assets?tenant_id=eq.${tenant_id}&source=eq.gdrive`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { is_active: false, updated_at: syncedAt },
          });
        }

        // Only skip files already stored (active records with a storage_path = already in Supabase Storage)
        const existing = await sb(`smflow_assets?tenant_id=eq.${tenant_id}&source=eq.gdrive&is_active=eq.true&select=gdrive_file_id,storage_path`);
        const existingIds = new Set(
          existing.filter(a => a.storage_path).map(a => a.gdrive_file_id).filter(Boolean)
        );
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
              // Download from Drive → upload to Supabase Storage → store own-domain URL
              const stored = await downloadAndStore(drive, file.id, file.name, file.mimeType, tenant_id);
              await sb('smflow_assets', {
                method: 'POST', prefer: 'return=minimal',
                body: {
                  tenant_id,
                  file_url:       stored.file_url,
                  thumbnail_url:  stored.thumbnail_url,
                  storage_path:   stored.storage_path,
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

export default withLambda(handler);
