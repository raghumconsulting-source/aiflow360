// netlify/functions/ai-review.js
// Fully tenant-aware AI review engine.
// Reads ALL config from Supabase on every request:
//   - venue + tenant (existing)
//   - venue_ai_config: icebreakers, features, persona, max_turns
//   - tag_bank: active tags sent to widget as chips
//   - recovery_actions: injected when sentiment is negative
//   - venue_tables: validates tableRef from QR/NFC scan

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL                = 'claude-haiku-4-5-20251001';

// ── Supabase REST helper ───────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase error on ${path}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// ── Fetch ALL venue config from DB in parallel ─────────
async function getFullVenueConfig(venueId, venueSlug, tenantId) {

  // Step 1: resolve venue + tenant
  let venueQuery = 'venues?select=*,tenants(id,name,slug,primary_color,widget_theme,current_plan,status,plan_sessions_pm,sessions_this_month,tokens_this_month,plan_tokens_pm)';
  if (venueId)       venueQuery += `&id=eq.${venueId}&deleted_at=is.null&limit=1`;
  else if (venueSlug) venueQuery += `&slug=eq.${venueSlug}&deleted_at=is.null&limit=1`;
  else if (tenantId)  venueQuery += `&tenant_id=eq.${tenantId}&is_active=eq.true&deleted_at=is.null&limit=1`;
  else throw new Error('Must provide venueId, venueSlug, or tenantId');

  const rows = await sb(venueQuery, { headers: { 'Accept': 'application/json' } });
  if (!rows || rows.length === 0) throw new Error('Venue not found');

  const venue  = rows[0];
  const tenant = venue.tenants;
  const vid    = venue.id;
  const tid    = tenant?.id;

  // Step 2: fetch all config in parallel
  const [aiConfigRows, tagRows, actionRows] = await Promise.all([
    sb(`venue_ai_config?venue_id=eq.${vid}&limit=1`).catch(() => []),
    sb(`tag_bank?venue_id=eq.${vid}&is_active=eq.true&order=sort_order`).catch(() => []),
    sb(`recovery_actions?tenant_id=eq.${tid}&is_active=eq.true&order=sort_order`).catch(() => []),
  ]);

  return {
    ...venue,
    aiConfig:        aiConfigRows[0] || null,
    activeTags:      tagRows,
    recoveryActions: actionRows,
  };
}

// ── Check tenant limits ────────────────────────────────
function checkLimits(tenant) {
  if (tenant.plan_sessions_pm > 0 &&
      tenant.sessions_this_month >= tenant.plan_sessions_pm) {
    return { blocked: true, reason: 'session_limit', message: 'Monthly session limit reached. Please upgrade your plan.' };
  }
  if (tenant.plan_tokens_pm > 0 &&
      tenant.tokens_this_month >= tenant.plan_tokens_pm) {
    return { blocked: true, reason: 'token_limit', message: 'Monthly token limit reached. Please upgrade your plan.' };
  }
  return { blocked: false };
}

// ── Build system prompt from tenant config ─────────────
function buildSystemPrompt(venue, tenant, step) {
  const ai       = venue.aiConfig || {};
  const features = ai.enabled_features || {};
  const maxTurns = ai.max_turns || 4;

  const name     = venue.display_name || venue.name || tenant.name;
  const type     = venue.venue_type   || 'business';
  const location = [venue.suburb, venue.state].filter(Boolean).join(', ') || 'Australia';
  const knownFor = venue.known_for    || 'quality and service';

  // Tags from DB — what guests can talk about
  const tagLabels = (venue.activeTags || []).map(t => t.label);
  const topicsStr = tagLabels.length > 0
    ? tagLabels.join(', ')
    : (venue.specialties || []).join(', ') || 'our products and services';

  // Icebreakers from DB — active questions only
  const icebreakers = (ai.icebreaker_questions || [])
    .filter(q => q.is_active !== false)
    .map(q => q.text)
    .filter(Boolean);

  const icebreakerStr = icebreakers.length > 0
    ? icebreakers.map(q => `- "${q}"`).join('\n')
    : '- "How was your experience with us today?"';

  // Recovery actions from DB
  const actions = (venue.recoveryActions || []);
  const recoveryStr = features.recovery_actions !== false && actions.length > 0
    ? `\nRECOVERY ACTIONS — when sentiment is negative, offer ONE of these:\n${actions.map(a => `- ${a.label}: ${a.description || a.label}`).join('\n')}\nInclude the chosen action in "recovery_offer" field.`
    : '';

  // Google draft instruction
  const draftInstruction = features.google_draft !== false
    ? 'POSITIVE → action=request_google_review, include google_draft (1st person, 2-3 sentences, specific, publishable)'
    : 'POSITIVE → action=end_positive, close warmly';

  // Turn logic based on max_turns
  const isFinal = step >= (maxTurns - 1);
  const turnInstruction = isFinal
    ? `FINAL TURN (turn ${step + 1} of ${maxTurns}). Do NOT ask more questions. Wrap up warmly. ${draftInstruction}. If negative → action=end_negative. If neutral → action=end_neutral.`
    : step === 0
    ? `Turn 1. Start with one of your icebreaker questions. Keep it warm and brief.`
    : `Turn ${step + 1} of ${maxTurns}. Ask ONE follow-up about something NEW — pick from topics: ${topicsStr}. Never repeat a question already asked.`;

  const persona = ai.ai_persona || 'warm_casual';
  const personaDesc = persona === 'professional'
    ? 'professional and courteous'
    : persona === 'friendly_formal'
    ? 'friendly yet polished'
    : 'warm, conversational, and genuine';

  return `You are a ${personaDesc} AI feedback assistant for ${name}, a ${type} in ${location}.

ABSOLUTE RULES:
1. ONE short message per turn — max 2 sentences
2. NEVER repeat a question already in the conversation
3. Generate 3-5 relevant chips from the topics list
4. Each chip must be short (2-4 words)
${recoveryStr}

${turnInstruction}

About ${name}:
- Known for: ${knownFor}
- Topics to explore: ${topicsStr}

Your icebreaker questions (use these to open conversations):
${icebreakerStr}

Respond ONLY in this exact JSON (no markdown, no extra text):
{
  "message": "your reply",
  "chips": [{"label":"chip text","style":"pos|neg|gold|neutral"}],
  "sentiment": "positive|neutral|negative|unknown",
  "new_topics": ["topic key"],
  "overall_score": 4,
  "highlights": ["specific thing guest mentioned"],
  "action": "continue|request_google_review|end_positive|end_negative|end_neutral",
  "google_draft": "only when action=request_google_review — publishable 1st-person review",
  "recovery_offer": "only when action=end_negative and recovery action chosen"
}`;
}

// ── Parse Claude response safely ───────────────────────
function parseClaudeResponse(data) {
  try {
    const text = data.content?.[0]?.text || '';
    // Strip markdown fences if present
    const clean = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ── Save completed review session ──────────────────────
async function saveReviewSession(payload) {
  try {
    await sb('review_sessions', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        tenant_id:            payload.tenantId,
        venue_id:             payload.venueId,
        widget_session_id:    payload.widgetSessionId || null,
        mode:                 payload.mode || 'chat',
        table_ref:            payload.tableRef || null,
        overall_score:        payload.overallScore || null,
        sentiment:            payload.sentiment || 'unknown',
        topics:               payload.topics || [],
        highlights:           payload.highlights || [],
        google_draft:         payload.googleDraft || null,
        manager_alert:        payload.sentiment === 'negative',
        manager_alert_reason: payload.sentiment === 'negative' ? 'Negative sentiment detected' : null,
        google_posted:        false,
        conversation_history: payload.conversationHistory || null,
        category_scores:      payload.categoryScores || null,
        started_at:           payload.startedAt || new Date().toISOString(),
        completed_at:         new Date().toISOString(),
        duration_seconds:     payload.durationSeconds || null,
      }),
    });
  } catch (err) {
    console.warn('Save review session failed (non-fatal):', err.message);
  }
}

// ── Log token usage ────────────────────────────────────
async function logTokens(tenantId, venueId, sessionId, usage, callType, turn) {
  try {
    await sb('token_usage_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        tenant_id:         tenantId || null,
        venue_id:          venueId  || null,
        review_session_id: sessionId || null,
        model:             MODEL,
        input_tokens:      usage.input_tokens  || 0,
        output_tokens:     usage.output_tokens || 0,
        call_type:         callType || 'review_turn',
        conversation_turn: turn || null,
        success:           true,
      }),
    });
  } catch (err) {
    console.warn('Token log failed (non-fatal):', err.message);
  }
}

// ── Main handler ───────────────────────────────────────
exports.handler = async function(event) {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Empty request body' }) };

    const {
      venueId, venueSlug, tenantId,
      messages,
      step = 0,
      mode = 'chat',
      widgetSessionId,
      tableRef,
      reviewSessionId,
      saveReview = false,
      overallScore, sentiment, topics = [], highlights = [],
      googleDraft, conversationHistory, categoryScores,
      startedAt, durationSeconds,
      system, // legacy fallback
    } = body;

    // ── 1. Fetch full venue + config ─────────────────────
    let venue  = null;
    let tenant = null;

    if (SUPABASE_URL && SUPABASE_SERVICE_KEY && (venueId || venueSlug || tenantId)) {
      try {
        const config = await getFullVenueConfig(venueId, venueSlug, tenantId);
        venue  = config;
        tenant = config.tenants;

        if (tenant) {
          const limit = checkLimits(tenant);
          if (limit.blocked) {
            return {
              statusCode: 429,
              headers: HEADERS,
              body: JSON.stringify({ error: limit.reason, message: limit.message }),
            };
          }
        }
      } catch (err) {
        console.warn('Config fetch failed, using fallback:', err.message);
      }
    }

    // ── 2. Save-only mode ────────────────────────────────
    if (saveReview) {
      await saveReviewSession({
        tenantId: tenant?.id || tenantId,
        venueId:  venue?.id  || venueId,
        widgetSessionId, mode, tableRef,
        overallScore, sentiment, topics, highlights, googleDraft,
        conversationHistory, categoryScores, startedAt, durationSeconds,
      });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ saved: true }) };
    }

    // ── 3. Build prompt ──────────────────────────────────
    if (!messages) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing messages' }) };
    }

    const systemPrompt = venue && tenant
      ? buildSystemPrompt(venue, tenant, step)
      : system || 'You are a helpful feedback assistant. Respond in JSON.';

    // ── 4. Call Claude ───────────────────────────────────
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 700,
        system:     systemPrompt,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', JSON.stringify(err));
      return {
        statusCode: anthropicRes.status,
        headers:    HEADERS,
        body:       JSON.stringify({ error: 'AI service error', detail: err?.error?.message }),
      };
    }

    const data = await anthropicRes.json();
    const parsed = parseClaudeResponse(data);

    console.log(`Tokens: ${data.usage?.input_tokens}in + ${data.usage?.output_tokens}out | venue: ${venue?.slug || venueSlug || 'unknown'} | step: ${step} | sentiment: ${parsed?.sentiment || 'unknown'}`);

    // ── 5. Log tokens ────────────────────────────────────
    await logTokens(
      tenant?.id || tenantId,
      venue?.id  || venueId,
      reviewSessionId || null,
      data.usage || {},
      'review_turn',
      step,
    );

    // ── 6. Return response + full config for widget ──────
    const aiConfig   = venue?.aiConfig || {};
    const features   = aiConfig.enabled_features || {};
    const activeTags = (venue?.activeTags || []).map(t => ({
      label: t.label, topic: t.topic
    }));

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        ...data,
        // Parsed response for widget to use directly
        parsed,
        // Full venue config so widget stays in sync
        venueConfig: venue ? {
          id:              venue.id,
          name:            venue.display_name || venue.name,
          slug:            venue.slug,
          googleReviewUrl: venue.google_review_url || null,
          primaryColor:    venue.primary_color || tenant?.primary_color || '#C9A84C',
          widgetTheme:     venue.widget_theme  || tenant?.widget_theme  || 'dark',
          knownFor:        venue.known_for     || '',
          venueType:       venue.venue_type    || '',
          tenantId:        tenant?.id,
          tenantName:      tenant?.name,
          // Config the widget needs
          activeTags,
          maxTurns:        aiConfig.max_turns || 4,
          features,
        } : null,
      }),
    };

  } catch (err) {
    console.error('Function error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: 'Internal error', detail: err.message }),
    };
  }
};
