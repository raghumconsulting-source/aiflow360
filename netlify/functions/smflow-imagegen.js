// netlify/functions/smflow-imagegen.js
// ImagineArt API — realistic style
// POST { tenant_id, post_id, post_content, flavor, industry_code, brand_voice, target_audience, platform, tenant_name }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.Gemini_SMflow_API_Key;
const STORAGE_BUCKET       = 'tenant-assets';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0,200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

const PLATFORM_ASPECT_RATIO = {
  Instagram: '1:1', Facebook: '16:9', LinkedIn: '16:9',
  'Twitter/X': '16:9', WhatsApp: '1:1', YouTube: '16:9', _default: '1:1',
};

const INDUSTRY_STYLE = {
  accommodation_food:     'warm inviting food photography, vibrant colors, shallow depth of field, appetizing plating, natural window light',
  beauty:                 'clean editorial beauty photography, soft natural light, minimalist aesthetic, high-end salon feel',
  arts_recreation:        'dynamic fitness photography, energetic composition, strong athletic aesthetic, motivational lighting',
  retail_trade:           'clean product photography, lifestyle retail aesthetic, bright natural light, aspirational consumer feel',
  healthcare:             'clean professional medical aesthetic, soft blue-white tones, trust-building imagery, modern clinic',
  professional_technical: 'modern corporate photography, clean office environment, confident business imagery',
  real_estate:            'bright architectural photography, wide-angle interiors, golden hour exteriors, aspirational spaces',
  _default:               'professional business photography, clean modern aesthetic, natural light, high quality composition',
};

const FLAVOR_MOOD = {
  education:    'clean informational aesthetic, professional and trustworthy mood',
  awareness:    'bold attention-grabbing composition, high contrast, problem-focused mood',
  urgency:      'bold red-orange accent colors, high contrast, action-driving composition',
  fomo:         'aspirational lifestyle imagery, exclusivity visual language',
  trending:     'modern contemporary aesthetic, current design trends, fresh visual language',
  humor:        'bright playful colors, lighthearted fun mood, warm inviting composition',
  inspiration:  'uplifting aspirational imagery, warm golden tones, sunrise success aesthetic',
  social_proof: 'authentic testimonial aesthetic, real people smiling, trust-building visual',
  myth_bust:    'contrast composition, revealing aesthetic, educational visual language',
  how_to:       'clean process visualization, helpful educational mood, instructional aesthetic',
  behind_scenes:'authentic candid photography, genuine real-world tones, transparent mood',
  challenge:    'community energy, bold motivational composition, achievement aesthetic',
  _default:     'professional engaging composition, clear visual hierarchy',
};

function buildPrompt({ post_content, flavor, industry_code, platform, tenant_name }) {
  const style = {
    accommodation_food: 'appetizing food photography, restaurant setting, warm lighting',
    beauty: 'beauty product photography, clean aesthetic, soft lighting',
    arts_recreation: 'fitness photography, active lifestyle, energetic',
    retail_trade: 'product photography, clean background, professional',
    _default: 'professional business photography, clean modern setting',
  }[industry_code] || 'professional business photography, clean modern setting';

  const content = (post_content || '').replace(/[#@*]/g, '').trim().slice(0, 80);
  return `A professional marketing photo: ${style}. ${content ? 'Theme: ' + content + '.' : ''} High quality, photorealistic, no text, no logos.`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenant_id, post_id, post_content, flavor, industry_code, brand_voice, target_audience, platform, tenant_name } = body;

  if (!tenant_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  if (!GEMINI_API_KEY) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };

  try {
    const prompt      = buildPrompt({ post_content, flavor, industry_code, platform, tenant_name });
    const aspectRatio = PLATFORM_ASPECT_RATIO[platform] || PLATFORM_ASPECT_RATIO._default;

    console.log('Gemini prompt:', prompt.slice(0, 200));

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_API_KEY}`;
    const res = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspectRatio || '1:1' },
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`Imagen error (${res.status}): ${JSON.stringify(data).slice(0,300)}`);

    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      console.error('Imagen response:', JSON.stringify(data).slice(0, 500));
      throw new Error('Imagen returned no image data');
    }

    const base64   = prediction.bytesBase64Encoded;
    const mimeType = prediction.mimeType || 'image/png';
    console.log('Imagen image received successfully');

    // Save to Supabase Storage
    const ext       = mimeType === 'image/png' ? 'png' : 'jpg';
    const path      = `${tenant_id}/smflow/ai-generated/${post_id || 'nopost'}_${Date.now()}.${ext}`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;

    const uploadRes = await fetch(uploadUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  mimeType,
        'x-upsert':      'true',
      },
      body: Buffer.from(base64, 'base64'),
    });

    if (!uploadRes.ok) {
      const txt = await uploadRes.text();
      throw new Error(`Storage upload failed (${uploadRes.status}): ${txt.slice(0,200)}`);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
    const now       = new Date().toISOString();

    // Update post image_url
    if (post_id) {
      await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body:   { image_url: publicUrl, updated_at: now },
      }).catch(e => console.warn('post update non-fatal:', e.message));
    }

    // Save to smflow_assets
    await sb('smflow_assets', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        tenant_id,
        file_url:      publicUrl,
        thumbnail_url: publicUrl,
        storage_path:  path,
        file_name:     `ai-imagineArt-${flavor}-${platform}.${ext}`,
        file_type:     mimeType,
        source:        'ai_generated',
        topic_tags:    [flavor, industry_code].filter(Boolean),
        flavor_tags:   [flavor].filter(Boolean),
        platform_tags: platform ? [platform] : ['Instagram','Facebook'],
        alt_text:      `AI generated ${flavor} image`,
        is_active:     true,
        created_at:    now,
        updated_at:    now,
      },
    }).catch(e => console.warn('asset insert non-fatal:', e.message));

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({ success: true, image_url: publicUrl, storage_path: path, provider: 'gemini-flash' }),
    };

  } catch (err) {
    console.error('smflow-imagegen error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
