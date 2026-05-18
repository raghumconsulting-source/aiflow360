// netlify/functions/logo-upload.js
// Generates a signed upload URL for tenant/venue logo
// POST { tenant_id, venue_id, file_type }
// Returns { uploadUrl, publicUrl }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenant_id, venue_id, file_type = 'image/png' } = body;
  if (!tenant_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };

  try {
    // Build path: tenant-assets/tenant_id/venue_id/logo.ext OR tenant_id/logo.ext
    const ext = file_type.split('/')[1]?.replace('jpeg','jpg') || 'png';
    const logoPath = venue_id
      ? `${tenant_id}/${venue_id}/logo.${ext}`
      : `${tenant_id}/logo.${ext}`;

    // Generate signed upload URL (valid 60 seconds)
    const { data, error } = await supabase.storage
      .from('tenant-assets')
      .createSignedUploadUrl(logoPath);

    if (error) throw error;

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/tenant-assets/${logoPath}`;

    // Update venue or tenant logo_url immediately
    if (venue_id) {
      await supabase.from('venues').update({ logo_url: publicUrl }).eq('id', venue_id);
    } else {
      await supabase.from('tenants').update({ logo_url: publicUrl }).eq('id', tenant_id);
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ uploadUrl: data.signedUrl, publicUrl }),
    };
  } catch (err) {
    console.error('logo-upload error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
