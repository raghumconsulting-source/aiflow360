// netlify/functions/smflow-imagegen.js
// SMART MULTI-PROVIDER IMAGE ENGINE
// 
// Prompt architecture (5 layers):
//   1. Role assignment — industry-specific creative director persona
//   2. Guru principle — Ogilvy/GaryVee/Godin/Kotler/Patel visual strategy
//   3. Industry context — specific visual language for the business type
//   4. Content extraction — parse post to drive the actual visual concept
//   5. Provider formatting — GPT Image 2 (complex), ImagineArt (structured), Gemini (direct)
//
// Provider routing by tenant plan:
//   starter  → Gemini Flash (free, good)
//   pro      → ImagineArt API — Seedream v4.5 (~$30/mo, excellent)
//   business → GPT Image 2 via OpenAI (~$15/mo, outstanding)
//   fallback → always falls back to next tier if provider fails

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY       = process.env.Gemini_SMflow_API_Key;
const IMAGINE_ART_API_KEY  = process.env.IMAGINE_ART_API_KEY;
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
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
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 200)}`);
  if (!text || text === 'null') return method === 'GET' ? [] : null;
  return JSON.parse(text);
}

// ══════════════════════════════════════════════════════════
// LAYER 1 — ROLE ASSIGNMENT
// Industry + audience specific creative director persona
// ══════════════════════════════════════════════════════════
const INDUSTRY_ROLES = {
  accommodation_food:     'You are a Cannes Lions-winning food and hospitality photographer and creative director. Your images make people hungry and drive restaurant bookings. You shoot for Broadsheet, Time Out, and Gourmet Traveller.',
  beauty:                 'You are a leading beauty and lifestyle visual director whose work appears in Vogue, Harper\'s Bazaar, and Mecca campaigns. Your images inspire confidence and drive product sales.',
  arts_recreation:        'You are an elite fitness and lifestyle photographer. Your images have been featured in Men\'s Health, Women\'s Health, and Nike campaigns. Your work motivates action.',
  retail_trade:           'You are a retail and product photography specialist whose work drives conversion for Australia\'s top brands. Your images make products irresistible.',
  healthcare:             'You are a healthcare communications visual director. Your images build trust, convey expertise, and make professional services feel approachable and credible.',
  professional_technical: 'You are a corporate visual communications director whose work positions B2B brands as market leaders. Your images convey authority, innovation, and trustworthiness.',
  financial_insurance:    'You are a financial services visual director. Your images convey security, growth, and expertise while remaining human and approachable.',
  real_estate:            'You are an architectural and real estate photographer whose work sells properties above asking price. Your images make spaces feel aspirational and liveable.',
  information_media:      'You are a technology brand visual director whose work positions tech companies as innovative leaders. Your images are clean, forward-thinking, and conversion-driven.',
  education_training:     'You are an education marketing visual director. Your images inspire learning, convey opportunity, and make education feel accessible and transformative.',
  construction_trade:     'You are a trade and construction marketing specialist. Your images showcase craftsmanship, quality, and the transformation of spaces.',
  admin_support:          'You are a professional services visual director. Your images position service businesses as organised, efficient, and trustworthy.',
  personal_services:      'You are a community and lifestyle photographer. Your images make local businesses feel warm, trusted, and essential to daily life.',
  automotive:             'You are an automotive visual director whose work appears in Drive, Car Advice, and major dealership campaigns. Your images convey power, precision, and desire.',
  transport:              'You are a logistics and transport visual director. Your images convey reliability, scale, and professional excellence.',
  tourism:                'You are a destination and travel photographer whose work appears in Lonely Planet and Tourism Australia campaigns. Your images inspire wanderlust and drive bookings.',
  agriculture:            'You are an agricultural and food provenance visual director. Your images connect consumers to the land, convey freshness, and build brand trust.',
  manufacturing:          'You are an industrial and manufacturing visual director. Your images showcase precision, quality, and the pride of Australian making.',
  ecommerce:              'You are an e-commerce conversion specialist. Your images are designed to drive add-to-cart and reduce purchase hesitation.',
  _default:               'You are a world-class commercial photographer and creative director specialising in small business marketing across Australia.',
};

// ══════════════════════════════════════════════════════════
// LAYER 2 — GURU VISUAL PRINCIPLES
// Each marketing guru maps to a specific visual strategy
// ══════════════════════════════════════════════════════════
const GURU_VISUAL_PRINCIPLES = {
  ogilvy: {
    name:      'Ogilvy',
    principle: 'The image IS the ad. One dominant visual hero. The benefit must be immediately visible within 1.5 seconds of scrolling. No confusion, no clutter. The eye goes straight to the product promise.',
    composition: 'Single hero element. Rule of thirds. Clear foreground/background separation. The viewer\'s eye should have one obvious entry point.',
  },
  garyvee: {
    name:      'GaryVee',
    principle: 'Native-feel content. Looks organic, not like an ad. Thumb-stopping in the first half-second. Raw authenticity beats polished perfection. Context is everything.',
    composition: 'Candid, in-the-moment aesthetic. Real environments, real people, genuine moments. Looks like something a friend posted, not a brand.',
  },
  godin: {
    name:      'Godin',
    principle: 'Purple cow. Remarkable. Makes the viewer stop and think "I\'ve never seen that before." Distinctive, memorable, worth sharing. Safe is risky — boring kills engagement.',
    composition: 'Unexpected angle or perspective. Something visually surprising. The image should make someone want to show it to a friend.',
  },
  kotler: {
    name:      'Kotler',
    principle: 'Benefit-led. Shows the transformation or outcome, not just the product. The customer is the hero. What does their life look like after using this? Show that.',
    composition: 'Before/after implied. The outcome is visible. Customer transformation as the visual story. Product in context of use.',
  },
  patel: {
    name:      'Patel',
    principle: 'Data-driven high-CTR composition. Strong visual hierarchy. Clear focal point. Warm colours outperform cool colours for engagement. Faces drive 38% more engagement.',
    composition: 'Strong contrast between subject and background. Warm color grading. If human subjects: direct eye contact with camera. Bold, clear, scannable.',
  },
  all: {
    name:      'Combined',
    principle: 'Apply ALL principles: Ogilvy\'s single hero, GaryVee\'s authentic feel, Godin\'s remarkable quality, Kotler\'s benefit focus, and Patel\'s CTR-optimised composition.',
    composition: 'One clear hero visual. Authentic feel. Visually surprising yet credible. Shows the benefit or transformation. Warm, high-contrast, thumb-stopping.',
  },
};

// ══════════════════════════════════════════════════════════
// LAYER 3 — FLAVOR VISUAL STRATEGY
// What type of image drives each content flavor
// ══════════════════════════════════════════════════════════
const FLAVOR_VISUAL_STRATEGY = {
  education: {
    visual:   'Clean, organised informational aesthetic. Think magazine feature spread. Clear visual hierarchy. Diagrams or organised flat-lays that communicate a concept at a glance.',
    emotion:  'Trustworthy, clear, expert. "I can learn from this image."',
    avoid:    'Clutter, busy backgrounds, confusing compositions.',
  },
  awareness: {
    visual:   'Problem-focused imagery. Show the pain point or the gap. High contrast, slightly urgent. The viewer should recognise themselves in the problem.',
    emotion:  'Recognition, slight tension, "yes, that\'s me." Creates desire for the solution.',
    avoid:    'Happy cheerful imagery — this is about identifying the problem first.',
  },
  urgency: {
    visual:   'Time-pressure visual language. Clock, calendar, limited quantity visual metaphors. Red-orange accent colors. Bold, action-driven composition. Strong CTA visual energy.',
    emotion:  'FOMO, action, "I need to do this now."',
    avoid:    'Calm, muted colors. Slow, contemplative imagery.',
  },
  fomo: {
    visual:   'Aspirational lifestyle imagery. Other people experiencing the benefit. Exclusivity and in-group visual language. "You could be here" composition.',
    emotion:  'Desire, exclusivity, "I want what they have."',
    avoid:    'Product-only shots. Missing the human element.',
  },
  trending: {
    visual:   'Current design trends. Fresh, contemporary, social-native aesthetic. Feels like it was made today, not last year. Colour palettes from current design trends.',
    emotion:  'Relevant, current, "this brand gets it."',
    avoid:    'Dated design aesthetics, stock photo feel.',
  },
  humor: {
    visual:   'Bright, playful, slightly unexpected. A relatable everyday scene with a twist. Warm colors, approachable composition. The image should make you smile before you read the caption.',
    emotion:  'Delight, warmth, "I want to share this."',
    avoid:    'Dark or moody tones. Overly corporate or serious compositions.',
  },
  inspiration: {
    visual:   'Uplifting, aspirational. Golden hour lighting. Upward movement, expansive spaces, achievement visual metaphors. Sunrise, open horizons, people succeeding.',
    emotion:  'Hope, motivation, "I can do this."',
    avoid:    'Closed spaces, downward angles, problem-focused imagery.',
  },
  social_proof: {
    visual:   'Real people, authentic moments. Testimonial aesthetic — candid not posed. Community and belonging visual language. Reviews, ratings, crowds enjoying something.',
    emotion:  'Trust, social validation, "if they love it, I will too."',
    avoid:    'Overly staged or stock-photo-feeling imagery. Model-perfect unrealistic scenes.',
  },
  myth_bust: {
    visual:   'Visual contrast — the myth vs. the truth. Split composition or before/after implied. The truth should look beautiful, desirable, and credible. Hero ingredients or proof elements.',
    emotion:  'Revelation, "I didn\'t know that." Curiosity and education.',
    avoid:    'Generic food/product shots with no conceptual hook.',
  },
  how_to: {
    visual:   'Step-implied process. Clean, organised flat-lay or sequence. The tools, ingredients, or elements of the process laid out elegantly. Instructional but beautiful.',
    emotion:  '"I could do that." Accessible, empowering, clear.',
    avoid:    'Messy, chaotic compositions. Busy or confusing imagery.',
  },
  behind_scenes: {
    visual:   'Authentic, candid, unposed. The real work, real people, real environment. Behind-the-curtain aesthetic. Slightly imperfect is perfect here.',
    emotion:  'Trust, transparency, "I know the people behind this brand."',
    avoid:    'Overly polished or staged shots. Anything that looks like it was set up for the camera.',
  },
  challenge: {
    visual:   'Community energy, competition, achievement. Bold, energetic, inclusive. People doing the challenge. Trophy, achievement, celebration visual elements.',
    emotion:  'Excitement, belonging, "I want to join."',
    avoid:    'Solo, quiet, or introspective imagery.',
  },
  _default: {
    visual:   'Professional, engaging, brand-aligned. Clear focal point. High quality.',
    emotion:  'Trust and credibility.',
    avoid:    'Generic stock photography feel.',
  },
};

// ══════════════════════════════════════════════════════════
// LAYER 4 — CONTENT EXTRACTOR
// Pulls the real visual concepts from the post text
// ══════════════════════════════════════════════════════════
function extractVisualConcepts(postContent, flavor, industryCode) {
  if (!postContent) return null;

  const clean = postContent
    .replace(/[#@]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 400);

  // Extract capitalized key concepts (likely product/topic names)
  const concepts = [];

  // Food/ingredient extraction for accommodation_food
  const foodKeywords = clean.match(/\b(avocado|salmon|olive oil|nuts|coffee|tea|bread|pasta|wine|beer|pizza|cake|salad|chicken|beef|fish|dosa|biryani|curry|chai|matcha|smoothie|bowl|plate|dish|meal|breakfast|lunch|dinner|brunch)\b/gi);
  if (foodKeywords) concepts.push(...[...new Set(foodKeywords.map(k => k.toLowerCase()))]);

  // Generic noun extraction — words after MYTH:, TRUTH:, or key phrases
  const mythMatch = clean.match(/TRUTH[:\s]+([^.!?]+)/i);
  const keyPhraseMatch = clean.match(/^([^.!?\n]{10,60})/);
  const actionMatch = clean.match(/\b(discover|try|learn|get|start|stop|avoid|use|choose|switch|join|book|call|visit|see|feel|taste|experience)\b[^.!?]{5,40}/gi);

  if (mythMatch) concepts.push(mythMatch[1].trim().slice(0, 80));
  if (actionMatch) concepts.push(...actionMatch.slice(0, 2).map(m => m.trim()));

  const coreMessage = clean.slice(0, 120);

  return {
    coreMessage,
    concepts: concepts.slice(0, 5),
    rawText: clean.slice(0, 300),
  };
}

// ══════════════════════════════════════════════════════════
// LAYER 5 — PLATFORM SPECS
// ══════════════════════════════════════════════════════════
const PLATFORM_SPECS = {
  Instagram:   { format: '1:1 square (1080x1080px)', thumbTest: 'Must be bold and clear at 150x150px thumbnail size. Primary subject centered.', feel: 'Visually stunning, scroll-stopping, share-worthy.' },
  Facebook:    { format: '1.91:1 landscape (1200x628px)', thumbTest: 'Clear at 470px wide on desktop feed.', feel: 'Engaging, community-oriented, shareable.' },
  LinkedIn:    { format: '1.91:1 landscape (1200x628px)', thumbTest: 'Professional on desktop and mobile.', feel: 'Professional, credible, industry-relevant.' },
  'Twitter/X': { format: '16:9 landscape (1600x900px)', thumbTest: 'Clear at 506px wide. Strong contrast.', feel: 'Bold, current, conversation-starting.' },
  WhatsApp:    { format: '1:1 square (800x800px)', thumbTest: 'Clear at full screen on mobile. Simple composition.', feel: 'Personal, direct, mobile-native.' },
  YouTube:     { format: '16:9 (1280x720px)', thumbTest: 'Readable at 240px wide. Bold contrast.', feel: 'High energy, clickable, preview-worthy.' },
  _default:    { format: '1:1 square', thumbTest: 'Clear at small sizes.', feel: 'Clean and professional.' },
};

const PLATFORM_ASPECT_RATIO = {
  Instagram: '1:1', Facebook: '16:9', LinkedIn: '16:9',
  'Twitter/X': '16:9', WhatsApp: '1:1', YouTube: '16:9', _default: '1:1',
};

// ══════════════════════════════════════════════════════════
// MASTER PROMPT BUILDER
// Assembles all 5 layers into a provider-optimised prompt
// ══════════════════════════════════════════════════════════
function buildSmartPrompt({ post_content, flavor, industry_code, brand_voice, target_audience, platform, tenant_name, guru, provider }) {

  // Layer 1: Role
  const role = INDUSTRY_ROLES[industry_code] || INDUSTRY_ROLES._default;

  // Layer 2: Guru principle
  const guruKey = (guru === 'all' || !guru) ? 'all' : guru.toLowerCase();
  const guruPrinciple = GURU_VISUAL_PRINCIPLES[guruKey] || GURU_VISUAL_PRINCIPLES.all;

  // Layer 3: Industry visual language
  const INDUSTRY_VISUAL = {
    accommodation_food:     'Warm food photography. Natural window light. Shallow depth of field. Appetizing plating. Real ingredients, not artificial. Warm color grade: deep greens, rich ambers, natural whites.',
    beauty:                 'Clean editorial. Soft diffused light. Skincare/cosmetics as art objects. White or marble surfaces. Pastel or neutral palette. Aspirational but attainable.',
    arts_recreation:        'Dynamic motion. Strong bodies. Gym or outdoor environment. High contrast. Bold colors. Energy and movement visible in every frame.',
    retail_trade:           'Product as hero. Clean backgrounds or lifestyle context. Natural light or professional studio. Aspirational but relatable consumer scenes.',
    healthcare:             'Clean, clinical but warm. Soft blue-white tones. Professional environment. Trust signals: stethoscope, clipboard, caring gestures. Never cold or sterile.',
    professional_technical: 'Modern office or workspace. Clean desk aesthetic. Technology present but not overwhelming. Confident professionals. Blue or neutral palette.',
    financial_insurance:    'Upward graphs or growth imagery. Solid, stable visual metaphors. Blue and gold palette. Professional, trust-building.',
    real_estate:            'Wide-angle interiors. Golden hour exteriors. Aspirational spaces. Clean, bright, airy. Properties at their absolute best.',
    information_media:      'Digital interfaces. Clean workspaces. Blue-purple tech palette. Innovation visual metaphors. Screens and data as art.',
    education_training:     'Bright, collaborative spaces. Diverse learners. Books, tools, progress. Warm and encouraging palette.',
    construction_trade:     'Strong craftsmanship. Before/after potential. Quality materials. Skilled hands at work. Bold, masculine palette.',
    admin_support:          'Organised workspace. Clean desk. Efficiency visual metaphors. Professional but approachable.',
    personal_services:      'Warm community scenes. Smiling faces. Local neighbourhood feel. Approachable and human.',
    automotive:             'Dynamic vehicle shots. Dramatic lighting. Speed and precision. Bold contrast.',
    transport:              'Fleet vehicles. Professional drivers. Efficient operations. Reliable, trustworthy aesthetic.',
    tourism:                'Stunning landscapes. Golden hour. Adventure and wonder. Vibrant colors. Wanderlust-inducing.',
    agriculture:            'Farm scenes. Harvest abundance. Natural earthy tones. Sustainable and authentic.',
    manufacturing:          'Precision machinery. Quality craftspeople. Clean factory. Australian-made pride.',
    ecommerce:              'Clean product flatlay. White or minimal background. Lifestyle context. Conversion-optimised composition.',
    _default:               'Professional Australian business aesthetic. Clean, modern, high quality.',
  };

  // Layer 4: Content extraction
  const extracted = extractVisualConcepts(post_content, flavor, industry_code);

  // Layer 5: Platform spec
  const platSpec = PLATFORM_SPECS[platform] || PLATFORM_SPECS._default;
  const industryVisual = INDUSTRY_VISUAL[industry_code] || INDUSTRY_VISUAL._default;

  // Flavor strategy
  const flavorStrategy = FLAVOR_VISUAL_STRATEGY[flavor] || FLAVOR_VISUAL_STRATEGY._default;

  // Target audience context
  const audienceContext = target_audience && target_audience !== 'Everyone (all audiences)'
    ? `Target audience: ${target_audience}. The image should resonate specifically with this group.`
    : '';

  // Build provider-specific prompt
  if (provider === 'gpt-image-2') {
    // GPT Image 2: Highly detailed, multi-paragraph, conversational instructions
    return `${role}

MARKETING PRINCIPLE (${guruPrinciple.name}): ${guruPrinciple.principle}
COMPOSITION RULE: ${guruPrinciple.composition}

MISSION: Create a single thumb-stopping ${platform || 'social media'} image for ${tenant_name || 'an Australian small business'} that drives engagement and achieves the marketing goal below.

CONTENT CONTEXT: The post this image supports says: "${extracted?.coreMessage || post_content?.slice(0, 150) || ''}"
${extracted?.concepts?.length ? `KEY VISUAL ELEMENTS TO INCLUDE: ${extracted.concepts.join(', ')}` : ''}

VISUAL STRATEGY (${flavor} content): ${flavorStrategy.visual}
EMOTIONAL TARGET: ${flavorStrategy.emotion}
AVOID: ${flavorStrategy.avoid}

INDUSTRY VISUAL LANGUAGE: ${industryVisual}
${audienceContext}

PLATFORM REQUIREMENT: ${platSpec.format}. ${platSpec.thumbTest} Feel: ${platSpec.feel}

TECHNICAL REQUIREMENTS:
- Photorealistic photography or premium graphic design
- NO text overlays, NO watermarks, NO logos, NO borders
- NO people with distorted features or unrealistic proportions
- Shot quality equivalent to a professional DSLR at f/2.8
- Color grade: rich, warm, platform-native

FINAL TEST: Would this image stop a ${target_audience || 'small business owner'} mid-scroll and make them want to engage? If yes, proceed. If no, make it more remarkable.`.trim();

  } else if (provider === 'imagineArt') {
    // ImagineArt: Structured style tags, concise but rich
    const concepts = extracted?.concepts?.slice(0, 3).join(', ') || '';
    return `${guruPrinciple.name} principle commercial photography for ${tenant_name || 'Australian business'}. ${flavorStrategy.visual} ${industryVisual} ${concepts ? `Featuring: ${concepts}.` : ''} ${platSpec.format}. ${platSpec.feel} Photorealistic, professional, high-CTR composition. No text, no logos, no watermarks. ${audienceContext}`.trim();

  } else {
    // Gemini Flash: Direct, clear, not overly complex
    const concepts = extracted?.concepts?.slice(0, 2).join(' and ') || '';
    return `Professional ${platform || 'social media'} marketing image for ${tenant_name || 'an Australian cafe'}. ${industryVisual} ${flavorStrategy.visual} ${concepts ? `Show: ${concepts}.` : ''} ${platSpec.format}. ${audienceContext} Photorealistic. No text. No logos. High quality.`.trim();
  }
}

// ══════════════════════════════════════════════════════════
// PROVIDER 1 — Gemini Flash (Starter, free)
// ══════════════════════════════════════════════════════════
async function generateWithGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini error (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inline_data?.mime_type?.startsWith('image/'));
  if (!imagePart?.inline_data?.data) {
    console.error('Gemini response:', JSON.stringify(data).slice(0, 500));
    throw new Error('Gemini returned no image data');
  }
  return { base64: imagePart.inline_data.data, mimeType: 'image/png' };
}

// ══════════════════════════════════════════════════════════
// PROVIDER 2 — ImagineArt API (Pro, ~$30/mo)
// ══════════════════════════════════════════════════════════
async function generateWithImagineArt(prompt, platform) {
  const aspectRatio = PLATFORM_ASPECT_RATIO[platform] || PLATFORM_ASPECT_RATIO._default;
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('style_id', '33');
  formData.append('aspect_ratio', aspectRatio);
  formData.append('high_res_results', '1');
  formData.append('steps', '30');
  formData.append('cfg', '7.5');

  const res = await fetch('https://api.vyro.ai/v2/image/generations', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${IMAGINE_ART_API_KEY}` },
    body:    formData,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ImagineArt error (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.artifacts?.[0]?.base64) {
    return { base64: data.artifacts[0].base64, mimeType: 'image/jpeg' };
  }
  const imgUrl = data.artifacts?.[0]?.url || data.image_url;
  if (imgUrl) {
    const imgRes = await fetch(imgUrl);
    const buffer = await imgRes.arrayBuffer();
    return { base64: Buffer.from(buffer).toString('base64'), mimeType: 'image/jpeg' };
  }
  console.error('ImagineArt response:', JSON.stringify(data).slice(0, 500));
  throw new Error('ImagineArt returned no image data');
}

// ══════════════════════════════════════════════════════════
// PROVIDER 3 — GPT Image 2 (Business, ~$15/mo)
// ══════════════════════════════════════════════════════════
async function generateWithGPTImage2(prompt, platform) {
  const sizeMap = {
    Instagram: '1024x1024', Facebook: '1536x864', LinkedIn: '1536x864',
    'Twitter/X': '1536x864', WhatsApp: '1024x1024', YouTube: '1536x864', _default: '1024x1024',
  };
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:         'gpt-image-2',
      prompt,
      n:             1,
      size:          sizeMap[platform] || sizeMap._default,
      quality:       'medium',
      output_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GPT Image 2 error (${res.status}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const base64 = data.data?.[0]?.b64_json;
  if (!base64) {
    console.error('GPT Image 2 response:', JSON.stringify(data).slice(0, 500));
    throw new Error('GPT Image 2 returned no image data');
  }
  return { base64, mimeType: 'image/png' };
}

// ══════════════════════════════════════════════════════════
// PROVIDER ROUTER
// ══════════════════════════════════════════════════════════
async function getTenantConfig(tenantId) {
  try {
    const rows = await sb(`smflow_brand_config?tenant_id=eq.${tenantId}&select=plan,default_guru&limit=1`);
    return { plan: rows?.[0]?.plan || 'starter', guru: rows?.[0]?.default_guru || 'all' };
  } catch (e) {
    console.warn('Could not fetch tenant config:', e.message);
    return { plan: 'starter', guru: 'all' };
  }
}

async function generateImage(promptParams, platform, plan, guru) {
  console.log(`Generating image — plan: ${plan}, guru: ${guru}, platform: ${platform}`);

  if (plan === 'business' && OPENAI_API_KEY) {
    try {
      const prompt = buildSmartPrompt({ ...promptParams, platform, guru, provider: 'gpt-image-2' });
      console.log('GPT Image 2 prompt:', prompt.slice(0, 150));
      const result = await generateWithGPTImage2(prompt, platform);
      return { ...result, provider: 'gpt-image-2', prompt };
    } catch (err) {
      console.warn('GPT Image 2 failed, falling back to ImagineArt:', err.message);
    }
  }

  if ((plan === 'pro' || plan === 'business') && IMAGINE_ART_API_KEY) {
    try {
      const prompt = buildSmartPrompt({ ...promptParams, platform, guru, provider: 'imagineArt' });
      console.log('ImagineArt prompt:', prompt.slice(0, 150));
      const result = await generateWithImagineArt(prompt, platform);
      return { ...result, provider: 'imagineArt', prompt };
    } catch (err) {
      console.warn('ImagineArt failed, falling back to Gemini:', err.message);
    }
  }

  const prompt = buildSmartPrompt({ ...promptParams, platform, guru, provider: 'gemini' });
  console.log('Gemini prompt:', prompt.slice(0, 150));
  const result = await generateWithGemini(prompt);
  return { ...result, provider: 'gemini-flash', prompt };
}

// ── Save image to Supabase Storage ────────────────────────
async function saveToStorage(base64Image, mimeType, tenantId, postId) {
  const ext       = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const buffer    = Buffer.from(base64Image, 'base64');
  const path      = `${tenantId}/smflow/ai-generated/${postId}_${Date.now()}.${ext}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
  const uploadRes = await fetch(uploadUrl, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': mimeType, 'x-upsert': 'true' },
    body:    buffer,
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

  const { tenant_id, post_id, post_content, flavor, industry_code,
          brand_voice, target_audience, platform, tenant_name } = body;

  if (!tenant_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id required' }) };
  }

  try {
    // Get tenant plan + default guru
    const { plan, guru } = await getTenantConfig(tenant_id);

    // Build prompt params
    const promptParams = { post_content, flavor, industry_code, brand_voice, target_audience, tenant_name };

    // Generate via correct provider with smart prompt
    const { base64, mimeType, provider, prompt } = await generateImage(promptParams, platform, plan, guru);
    console.log(`Generated via ${provider}`);

    // Save to Supabase Storage
    const { publicUrl, path: storagePath } = await saveToStorage(
      base64, mimeType, tenant_id, post_id || `nopost_${Date.now()}`
    );

    const now = new Date().toISOString();

    // Save asset record
    await sb('smflow_assets', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        tenant_id, file_url: publicUrl, thumbnail_url: publicUrl,
        storage_path: storagePath,
        file_name:    `ai-${provider}-${flavor}-${platform}.png`,
        file_type:    mimeType, source: 'ai_generated',
        topic_tags:   [flavor, industry_code].filter(Boolean),
        flavor_tags:  [flavor].filter(Boolean),
        platform_tags: platform ? [platform] : ['Instagram', 'Facebook'],
        alt_text:     `AI generated ${flavor} image for ${industry_code} business`,
        is_active: true, created_at: now, updated_at: now,
      },
    }).catch(e => console.warn('smflow_assets non-fatal:', e.message));

    // Update post image_url
    if (post_id) {
      await sb(`smflow_posts?id=eq.${post_id}&tenant_id=eq.${tenant_id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body:   { image_url: publicUrl, updated_at: now },
      }).catch(e => console.warn('smflow_posts update non-fatal:', e.message));
    }

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        success: true, image_url: publicUrl, storage_path: storagePath,
        provider, plan, guru, prompt_used: prompt?.slice(0, 500),
      }),
    };

  } catch (err) {
    console.error('smflow-imagegen error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
