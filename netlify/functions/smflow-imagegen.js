// netlify/functions/smflow-imagegen.js
// POST { tenant_id, post_id, post_content, flavor, industry_code,
//        brand_voice, target_audience, platform }
// → Builds industry + flavor aware prompt
// → Calls Gemini Imagen 3
// → Saves image to Supabase Storage (tenant-assets bucket)
// → Updates smflow_posts.image_url
// → Returns { success, image_url, storage_path }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY       = process.env.Gemini_SMflow_API_Key;
const STORAGE_BUCKET       = 'tenant-assets';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Supabase REST helper ───────────────────────────────────
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
  return JSON.parse(text);
}

// ── Industry visual style map ──────────────────────────────
// Each industry gets a specific photography/design style brief
// that produces high click-rate, platform-native imagery
const INDUSTRY_VISUAL_STYLE = {
  accommodation_food:     'warm inviting food photography, vibrant colors, shallow depth of field, professional restaurant aesthetic, appetizing plating, natural window light, Instagram-worthy composition',
  beauty:                 'clean editorial beauty photography, soft natural light, minimalist white background, professional cosmetics aesthetic, skincare flatlay, high-end salon feel',
  arts_recreation:        'dynamic fitness photography, energetic motion blur, strong athletic bodies, gym environment, motivational lighting, bold contrast, action-oriented composition',
  retail_trade:           'clean product photography, lifestyle retail aesthetic, bright natural light, modern store environment, aspirational consumer feel',
  healthcare:             'clean professional medical aesthetic, soft blue-white tones, trust-building imagery, modern clinic environment, caring professional feel',
  professional_technical: 'modern corporate photography, clean office environment, professional team aesthetic, technology-forward, confident business imagery',
  financial_insurance:    'sophisticated financial aesthetic, clean graphs and growth imagery, professional blue tones, trust and stability visual language',
  real_estate:            'bright architectural photography, wide-angle interiors, golden hour exteriors, aspirational property aesthetic, clean modern spaces',
  information_media:      'modern technology aesthetic, clean digital workspace, innovation-focused imagery, blue-purple tech tones, forward-thinking visual',
  education_training:     'bright engaging educational aesthetic, collaborative learning environment, diverse and inclusive, growth-focused imagery',
  construction_trade:     'bold trade photography, strong craftsmanship aesthetic, before-and-after transformation, quality materials, skilled worker imagery',
  admin_support:          'clean professional office aesthetic, organised workspace, efficiency-focused imagery, modern business environment',
  personal_services:      'warm community photography, friendly service aesthetic, local business feel, approachable and trustworthy',
  automotive:             'dynamic automotive photography, bold vehicle imagery, dramatic lighting, speed and precision aesthetic',
  transport:              'professional logistics photography, reliable fleet imagery, efficient operations aesthetic, trustworthy service feel',
  tourism:                'stunning destination photography, vibrant travel imagery, golden hour landscapes, wanderlust-inspiring composition',
  agriculture:            'authentic farm photography, natural earthy tones, harvest abundance aesthetic, sustainable farming imagery',
  manufacturing:          'precision industrial photography, clean factory aesthetic, quality craftsmanship, modern production environment',
  ecommerce:              'clean product flatlay photography, lifestyle e-commerce aesthetic, white background with accent colors, aspirational consumer imagery',
  _default:               'professional business photography, clean modern aesthetic, natural light, high quality composition',
};

// ── Flavor visual modifier map ─────────────────────────────
// Each content flavor adjusts the visual mood and composition
const FLAVOR_VISUAL_MODIFIER = {
  education:    'clean infographic-style layout, informative visual elements, professional and trustworthy mood, data visualization aesthetic',
  awareness:    'bold attention-grabbing composition, high contrast, problem-focused mood, urgent visual language',
  urgency:      'bold red-orange accent colors, clock or deadline visual elements, high contrast, action-driving composition',
  fomo:         'aspirational lifestyle imagery, other people enjoying the experience, exclusivity visual language, fear-of-missing-out mood',
  trending:     'modern contemporary aesthetic, current design trends, fresh and relevant visual language, social-media-native composition',
  humor:        'bright playful colors, lighthearted and fun mood, relatable everyday scene, warm and inviting composition',
  inspiration:  'uplifting aspirational imagery, warm golden tones, upward movement and growth, sunrise or success aesthetic',
  social_proof: 'authentic testimonial aesthetic, real people smiling, trust-building social proof visual, community feel',
  myth_bust:    'before-and-after split composition, contrast between myth and truth, educational visual language, revealing aesthetic',
  how_to:       'step-by-step instructional aesthetic, clean process visualization, helpful and educational mood, clarity-focused composition',
  behind_scenes: 'authentic candid photography, behind-the-curtain aesthetic, warm real-world tones, genuine and transparent mood',
  challenge:    'competitive achievement aesthetic, challenge and reward visual language, bold motivational composition, community participation feel',
  _default:     'professional engaging composition, clear visual hierarchy, brand-aligned aesthetic',
};

// ── Platform dimension hints ───────────────────────────────
const PLATFORM_HINTS = {
  Instagram:   '1:1 square format, optimised for Instagram feed, bold and eye-catching at thumbnail size',
  Facebook:    '1.91:1 landscape format, Facebook feed optimised, clear at small size',
  LinkedIn:    '1.91:1 landscape format, professional LinkedIn aesthetic, corporate-appropriate',
  'Twitter/X': '16:9 landscape format, Twitter/X feed optimised, high contrast for small display',
  WhatsApp:    '1:1 square format, WhatsApp-friendly, clear and simple composition',
  YouTube:     '16:9 landscape format, YouTube thumbnail style, bold text-overlay-ready background',
  _default:    'square format, social media optimised',
};

// ── Build the image generation prompt ─────────────────────
function buildPrompt({ post_content, flavor, industry_code, brand_voice, target_audience, platform, tenant_name }) {
  const industryStyle  = INDUSTRY_VISUAL_STYLE[industry_code]  || INDUSTRY_VISUAL_STYLE._default;
  const flavorModifier = FLAVOR_VISUAL_MODIFIER[flavor]        || FLAVOR_VISUAL_MODIFIER._default;
  const platformHint   = PLATFORM_HINTS[platform]              || PLATFORM_HINTS._default;

  // Extract key visual concepts from post content (first 200 chars)
  const contentSummary = post_content?.slice(0, 200).replace(/[#@]/g, '').trim() || '';

  const prompt = [
    `Create a professional social media marketing image for ${tenant_name || 'an Australian small business'}.`,
    `Visual style: ${industryStyle}.`,
    `Mood and composition: ${flavorModifier}.`,
    `Platform optimisation: ${platformHint}.`,
    contentSummary ? `The image should visually represent: "${contentSummary}"` : '',
    `The image must be photorealistic or clean graphic design — no text overlays, no watermarks, no logos.`,
    `High quality, professional, designed to maximise engagement and click-through rate on social media.`,
    `Australian market context. Modern, clean, premium feel.`,
  ].filter(Boolean).join(' ');

  return prompt;
}

// ── Call Gemini 2.5 Flash Image (free tier, 500 images/day) ──
async function generateWithGemini(prompt) {
  // Uses gemini-2.5-flash-image-preview (Nano Banana) — free tier
  // Standard generateContent endpoint, returns inline base64 image
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }],
      }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        responseMimeType:   'text/plain',
      },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Extract base64 image from inline_data part
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inline_data?.mime_type?.startsWith('image/'));
  if (!imagePart?.inline_data?.data) {
    // Log full response for debugging
    console.error('Gemini response:', JSON.stringify(data).slice(0, 500));
    throw new Error('Gemini returned no image data. Check API key permissions.');
  }

  return imagePart.inline_data.data; // base64 string
}

// ── Save image to Supabase Storage ────────────────────────
async function saveToStorage(base64Image, tenantId, postId) {
  const buffer  = Buffer.from(base64Image, 'base64');
  const path    = `${tenantId}/smflow/ai-generated/${postId}_${Date.now()}.png`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;

  const uploadRes = await fetch(uploadUrl, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'image/png',
      'x-upsert':      'true',
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    throw new Error(`Storage upload failed (${uploadRes.status}): ${txt.slice(0, 200)}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
  return { publicUrl, path };
}

// ── Main handler ───────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    tenant_id, post_id, post_content, flavor,
    industry_code, brand_voice, target_audience,
    platform, tenant_name,
  } = body;

  if (!tenant_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  }
  if (!GEMINI_API_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
  }

  try {
    // 1. Build industry + flavor aware prompt
    const prompt = buildPrompt({ post_content, flavor, industry_code, brand_voice, target_audience, platform, tenant_name });
    console.log('Image prompt:', prompt.slice(0, 200));

    // 2. Generate image via Gemini Imagen 3
    const base64Image = await generateWithGemini(prompt);

    // 3. Save to Supabase Storage under tenant path
    const { publicUrl, path: storagePath } = await saveToStorage(base64Image, tenant_id, post_id || `nopost_${Date.now()}`);

    // 4. Save asset record to smflow_assets
    const now = new Date().toISOString();
    await sb('smflow_assets', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        tenant_id,
        file_url:      publicUrl,
        thumbnail_url: publicUrl,
        storage_path:  storagePath,
        file_name:     `ai-generated-${flavor}-${platform}.png`,
        file_type:     'image/png',
        source:        'ai_generated',
        topic_tags:    [flavor, industry_code].filter(Boolean),
        flavor_tags:   [flavor].filter(Boolean),
        platform_tags: platform ? [platform] : ['Instagram','Facebook'],
        alt_text:      `AI generated ${flavor} image for ${industry_code} business`,
        is_active:     true,
        created_at:    now,
        updated_at:    now,
      },
    }).catch(e => console.warn('smflow_assets insert non-fatal:', e.message));

    // 5. If post_id provided, update smflow_posts.image_url
    if (post_id) {
      await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { image_url: publicUrl, updated_at: now },
      }).catch(e => console.warn('smflow_posts image_url update non-fatal:', e.message));
    }

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        success:      true,
        image_url:    publicUrl,
        storage_path: storagePath,
        prompt_used:  prompt.slice(0, 300),
      }),
    };

  } catch (err) {
    console.error('smflow-imagegen error:', err.message);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: err.message }),
    };
  }
};
