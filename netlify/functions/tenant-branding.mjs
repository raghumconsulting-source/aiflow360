// netlify/functions/tenant-branding.mjs
// Saves venue branding: primary_color, brand_color, logo, bg image
// + tapee_venue_config: font_pairing, font_heading_color, font_body_color, theme
//
// POST body:
//   tenant_id, venue_id
//   primary_color, brand_color, widget_theme
//   logo_base64, logo_mime, logo_ext  (optional — new upload)
//   existing_logo_url                 (optional — keep existing)
//   bg_base64, bg_mime, bg_ext        (optional — new upload)
//   existing_bg_url                   (optional — keep existing)
//   font_pairing, font_heading_color, font_body_color (optional)
//   display_name                      (optional)
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = 'tenant-assets';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

// ── Supabase REST helper ─────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!text || text === 'null') return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Supabase Storage upload ──────────────────────────
async function uploadFile(path, base64, mime) {
  const bytes  = Buffer.from(base64, 'base64');
  const res    = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  mime,
        'x-upsert':      'true',
      },
      body: bytes,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload failed: ${err}`);
  }
  // Return public URL
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      tenant_id, venue_id,
      primary_color, brand_color, widget_theme,
      logo_base64, logo_mime, logo_ext,
      existing_logo_url,
      bg_base64, bg_mime, bg_ext,
      existing_bg_url,
      font_pairing, font_heading_color, font_body_color,
      display_name,
    } = body;

    if (!tenant_id || !venue_id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'tenant_id and venue_id required' }) };
    }

    // ── Verify venue belongs to tenant ──────────────
    const venues = await sb(`venues?id=eq.${venue_id}&tenant_id=eq.${tenant_id}&select=id&limit=1`);
    if (!venues.length) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Venue not found or access denied' }) };
    }

    // ── Upload logo if provided ──────────────────────
    let finalLogoUrl = existing_logo_url || null;
    if (logo_base64 && logo_mime) {
      const ext  = logo_ext || 'png';
      const path = `venues/${venue_id}/logo.${ext}`;
      finalLogoUrl = await uploadFile(path, logo_base64, logo_mime);
    }

    // ── Upload background image if provided ──────────
    let finalBgUrl = existing_bg_url || null;
    if (bg_base64 && bg_mime) {
      const ext  = bg_ext || 'jpg';
      const path = `venues/${venue_id}/bg.${ext}`;
      finalBgUrl = await uploadFile(path, bg_base64, bg_mime);
    }

    // ── Patch venues table ───────────────────────────
    const venueUpdate = {
      updated_at: new Date().toISOString(),
    };
    if (primary_color  !== undefined) venueUpdate.primary_color = primary_color;
    if (brand_color    !== undefined) venueUpdate.brand_color   = brand_color;
    if (finalLogoUrl   !== null)      venueUpdate.logo_url      = finalLogoUrl;
    if (finalBgUrl     !== null)      venueUpdate.bg_image_url  = finalBgUrl;
    if (display_name && display_name.trim()) venueUpdate.name   = display_name.trim();

    await sb(`venues?id=eq.${venue_id}`, {
      method:  'PATCH',
      prefer:  'return=minimal',
      body:    JSON.stringify(venueUpdate),
    });

    // ── Upsert tapee_venue_config ────────────────────
    const configUpdate = {
      venue_id,
      updated_at: new Date().toISOString(),
    };
    if (widget_theme      !== undefined) configUpdate.theme              = widget_theme;
    if (font_pairing      !== undefined) configUpdate.font_pairing       = font_pairing;
    if (font_heading_color !== undefined) configUpdate.font_heading_color = font_heading_color;
    if (font_body_color   !== undefined) configUpdate.font_body_color    = font_body_color;

    if (Object.keys(configUpdate).length > 2) {
      await sb('tapee_venue_config', {
        method:  'POST',
        prefer:  'resolution=merge-duplicates,return=minimal',
        body:    JSON.stringify(configUpdate),
      });
    }

    console.log(`Branding saved for venue ${venue_id}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success:      true,
        logo_url:     finalLogoUrl,
        bg_image_url: finalBgUrl,
        primary_color,
        brand_color,
      }),
    };

  } catch (err) {
    console.error('tenant-branding error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
