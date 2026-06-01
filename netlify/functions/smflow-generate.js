// netlify/functions/smflow-generate.js
// POST — generates social media posts via Claude API
//        saves each post to smflow_posts (status='draft')
//        logs tokens to token_usage_log (billing infrastructure)
//
// Body: { tenant_id, topic, flavor, flavor_name, guru, content_type,
//         audience, brand_voice, extra_context, active_platforms,
//         canva_design_type, generate_canva_briefs }
//
// Returns: { posts: [{ platform, content, canva_brief, post_id }] }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL                = 'claude-sonnet-4-20250514';

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
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed;
}

async function callClaude(prompt, maxTokens = 1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude API error ${res.status}: ${err?.error?.message || 'unknown'}`);
  }
  return res.json();
}

// ── Guru framework system instructions ────────────────────
const GURU_SYSTEMS = {
  all: `Apply ALL five marketing guru frameworks:
1. KOTLER: STP targeting (Australian SMBs) + 4Ps + customer value creation
2. GODIN: Earn permission, be remarkable (Purple Cow test), build tribe identity
3. GARYVEE: Label JAB or RIGHT HOOK, platform-native format, authenticity over polish
4. OGILVY: Benefit-driven headline first, specific honest promise, product as hero
5. PATEL: SEO keywords woven in, research-backed hashtags, repurposable at scale`,
  kotler:  `Apply PHILIP KOTLER: STP every response. 4Ps lens. Customer value north star. Clear positioning vs alternatives.`,
  godin:   `Apply SETH GODIN: Purple Cow test — is this remarkable? Earn permission, never interrupt. Build tribe identity.`,
  garyvee: `Apply GARY VEE: Label [JAB] or [RIGHT HOOK]. Platform-native format. Authenticity beats polish. Day-trade attention.`,
  ogilvy:  `Apply DAVID OGILVY: Headline is everything (5x more read it). Specific honest promise. Product as hero. Research-backed.`,
  patel:   `Apply NEIL PATEL: Data-driven. SEO keywords in LinkedIn/YouTube. Research-backed hashtags. 70% evergreen / 30% topical.`,
};

// ── Flavor prompt instructions ─────────────────────────────
const FLAVOR_PROMPTS = {
  education:    'FLAVOR: EDUCATION — Teach something genuinely useful. Structure as "here\'s what most people don\'t know". Lead with Ogilvy benefit-headline. No selling — pure knowledge transfer. End with a thought-provoking question.',
  awareness:    'FLAVOR: AWARENESS — Reveal a hidden problem. Use startling stat or counter-intuitive insight. "Most SMB owners don\'t realise..." Create curiosity. Do not sell — illuminate the problem.',
  urgency:      'FLAVOR: URGENCY — Create genuine time pressure. Real reason to act now: trend accelerating, window closing, competitors moving. Clear CTA. Make cost of inaction vivid and specific.',
  fomo:         'FLAVOR: FOMO — Show what competitors and peers are already gaining. Social proof meets loss aversion. "Smart businesses are already..." Include subtle CTA. Motivating, not fear-mongering.',
  trending:     'FLAVOR: TRENDING — Connect to what\'s happening RIGHT NOW in Australian business/tech. Authentic connection — not forced. "With [trend] happening, here\'s what it means for your business..."',
  humor:        'FLAVOR: HUMOR — Genuinely funny content about SMB pain points. Relatable, dry wit or absurdist exaggeration. Platform-native: LinkedIn = wry professional, Instagram = playful. NO cringe corporate jokes.',
  inspiration:  'FLAVOR: INSPIRATION — Tell a transformation story or paint a bold vision. "Imagine your business 6 months from now..." Elevated language, hope, possibility. Empowering question at end.',
  social_proof: 'FLAVOR: SOCIAL PROOF — Use specific real or representative proof. Stats, mini case studies, or testimonial-style stories. Ogilvy: be SPECIFIC — "saves 8 hours" beats "saves time". Frame as story, not brag.',
  myth_bust:    'FLAVOR: MYTH BUST — Identify and destroy a common misconception. "MYTH: [belief]" then "TRUTH: [real situation]". Contrarian enough to earn the share. Specific verifiable counter-claim.',
  how_to:       'FLAVOR: HOW-TO — Give a practical numbered process. "How to [achieve X] in [timeframe]". 3-5 clear actionable steps. Patel: this is evergreen content — write it to be saved. "Start with step 1 today."',
  behind_scenes:'FLAVOR: BEHIND THE SCENES — Authentic peek into the business. First-person voice ("We discovered this week..."). Raw authenticity. Make audience feel like insiders. Invite engagement at end.',
  challenge:    'FLAVOR: CHALLENGE — Issue a direct actionable challenge. "This week, track how many hours your team spends on [task]. Reply with your number." Low bar to start. Collective momentum.',
};

// ── Platform rules ─────────────────────────────────────────
const PLATFORM_RULES = {
  LinkedIn:    'LinkedIn: 180-270 words. Ogilvy headline first. Professional. 3-5 hashtags. Engagement question at end. Line breaks.',
  Facebook:    'Facebook: 70-140 words. Story-style. Conversational. 1-2 hashtags. 1-2 emojis OK.',
  Instagram:   'Instagram: 50-85 words. Punchy hook as first line. 5-8 hashtags. 2-4 emojis. Visual-first writing.',
  WhatsApp:    'WhatsApp: 40-65 words. Direct value. No hashtags. Include business website URL if known. GaryVee pure JAB.',
  'Twitter/X': 'Twitter/X: MAX 230 chars total. One powerful hook. 1-2 hashtags. No fluff.',
  YouTube:     'YouTube: 60-85 words. Patel SEO-friendly language. Community question. 2-3 hashtags.',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    tenant_id, topic, flavor = 'education', flavor_name,
    guru = 'all', content_type, audience, brand_voice,
    extra_context, active_platforms = ['LinkedIn', 'Facebook', 'Instagram', 'WhatsApp', 'Twitter/X', 'YouTube'],
    canva_design_type = 'instagram_post', generate_canva_briefs = true,
  } = body;

  if (!tenant_id || !topic) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tenant_id and topic required' }) };
  }
  if (!active_platforms.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'At least one platform required' }) };
  }

  try {
    // ── Build generation prompt ──────────────────────────
    const guruInstruction  = GURU_SYSTEMS[guru] || GURU_SYSTEMS.all;
    const flavorInstruction = FLAVOR_PROMPTS[flavor] || FLAVOR_PROMPTS.education;
    const platformRules    = active_platforms.map(p => PLATFORM_RULES[p]).filter(Boolean).join('\n');
    const platformList     = active_platforms.join(', ');

    const prompt = `You are a world-class social media strategist for an Australian SMB.

GURU FRAMEWORK:
${guruInstruction}

${flavorInstruction}

Generate ONE post for EACH of these platforms: ${platformList}

Brief:
- Topic: "${topic}"
${content_type   ? `- Content type: ${content_type}` : ''}
${audience       ? `- Audience: ${audience}` : ''}
${brand_voice    ? `- Brand voice: ${brand_voice}` : ''}
${extra_context  ? `- Extra context: ${extra_context}` : ''}

PLATFORM RULES (strict):
${platformRules}

Return ONLY valid JSON (no markdown, no backticks, no extra text):
{${active_platforms.map(p => `"${p}":"..."`).join(',')}}`;

    // ── Call Claude for posts ────────────────────────────
    const postData = await callClaude(prompt, 1000);
    const rawText  = postData.content?.[0]?.text?.trim() || '{}';
    const clean    = rawText.replace(/```json\n?/g, '').replace(/\n?```/g, '').trim();

    let posts;
    try { posts = JSON.parse(clean); }
    catch (parseErr) {
      console.error('JSON parse error:', parseErr.message, '| raw:', rawText.slice(0, 300));
      throw new Error('Failed to parse Claude response as JSON');
    }

    const inputTokens  = postData.usage?.input_tokens  || 0;
    const outputTokens = postData.usage?.output_tokens || 0;
    const totalTokens  = inputTokens + outputTokens;

    // ── Generate Canva briefs (one small call per post) ──
    const canvaBriefs = {};
    if (generate_canva_briefs) {
      for (const platform of active_platforms) {
        if (!posts[platform]) continue;
        try {
          const briefData = await callClaude(
            `Write a Canva ${platform} graphic brief for: "${topic}". ` +
            `Content flavor: ${flavor_name || flavor}. Brand voice: ${brand_voice || 'Professional'}. ` +
            `Ogilvy principle: benefit as visual hero. Under 90 chars. No quotes. No markdown.`,
            150
          );
          canvaBriefs[platform] = briefData.content?.[0]?.text?.trim() || topic;
        } catch (briefErr) {
          console.warn(`Canva brief for ${platform} non-fatal:`, briefErr.message);
          canvaBriefs[platform] = topic;
        }
      }
    }

    // ── Save each post to smflow_posts ───────────────────
    const savedPosts = [];
    const now = new Date().toISOString();

    for (const platform of active_platforms) {
      const content = posts[platform];
      if (!content) continue;

      const canvaQuery = encodeURIComponent(`${canvaBriefs[platform] || topic} SMflow`);
      const canvaUrl   = `https://www.canva.com/design/new?type=${canva_design_type}&q=${canvaQuery}`;

      try {
        const inserted = await sb('smflow_posts', {
          method: 'POST',
          prefer: 'return=representation',
          body: {
            tenant_id,
            topic,
            platform,
            content,
            flavor,
            flavor_name:   flavor_name || flavor,
            guru,
            content_type:  content_type  || null,
            audience:      audience      || null,
            brand_voice:   brand_voice   || null,
            canva_brief:   canvaBriefs[platform] || null,
            canva_url:     canvaUrl,
            input_tokens:  Math.round(inputTokens  / active_platforms.length),
            output_tokens: Math.round(outputTokens / active_platforms.length),
            total_tokens:  Math.round(totalTokens  / active_platforms.length),
            status:        'draft',
            is_saved:      true,
            created_at:    now,
          },
        });

        savedPosts.push({
          post_id:      inserted?.[0]?.id || null,
          platform,
          content,
          canva_brief:  canvaBriefs[platform] || null,
          canva_url:    canvaUrl,
          status:       'draft',
        });
      } catch (saveErr) {
        console.error(`Save post for ${platform} failed:`, saveErr.message);
        // Still return the content even if save failed
        savedPosts.push({
          post_id:     null,
          platform,
          content,
          canva_brief: canvaBriefs[platform] || null,
          canva_url:   `https://www.canva.com/design/new?q=${encodeURIComponent(topic)}`,
          status:      'draft',
          save_error:  saveErr.message,
        });
      }
    }

    // ── Log tokens to existing billing infrastructure ────
    // Fires trg_token_usage_monthly automatically
    sb('token_usage_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        tenant_id,
        model:         MODEL,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        total_tokens:  totalTokens,
        call_type:     'smflow_generate',
        billing_month: new Date().toISOString().slice(0, 7) + '-01',
        success:       true,
      },
    }).catch(e => console.warn('token_usage_log non-fatal:', e.message));

    // ── Audit log ────────────────────────────────────────
    sb('audit_logs', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        tenant_id,
        action:        'generate',
        resource_type: 'smflow_posts',
        metadata: {
          topic, flavor, guru,
          platforms:    active_platforms,
          post_count:   savedPosts.length,
          total_tokens: totalTokens,
        },
      },
    }).catch(e => console.warn('audit_log non-fatal:', e.message));

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        posts:         savedPosts,
        total_tokens:  totalTokens,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        model:         MODEL,
      }),
    };

  } catch (err) {
    console.error('smflow-generate error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
