// netlify/functions/ai-review.js
// Tenant-aware AI review engine.
// Reads venue config from Supabase on every request.
// Saves completed reviews to review_sessions table.
// Logs token usage to token_usage_log.

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

// ── Fetch venue + tenant config from DB ───────────────
async function getVenueConfig(venueId, venueSlug, tenantId) {
  let venueQuery = 'venues?select=*,tenants(id,name,slug,primary_color,widget_theme,current_plan,status,plan_sessions_pm,sessions_this_month,tokens_this_month,plan_tokens_pm)';

  if (venueId) {
    venueQuery += `&id=eq.${venueId}&deleted_at=is.null&limit=1`;
  } else if (venueSlug) {
    venueQuery += `&slug=eq.${venueSlug}&deleted_at=is.null&limit=1`;
  } else if (tenantId) {
    venueQuery += `&tenant_id=eq.${tenantId}&status=eq.active&deleted_at=is.null&limit=1`;
  } else {
    throw new Error('Must provide venueId, venueSlug, or tenantId');
  }

  const rows = await sb(venueQuery, { headers: { 'Accept': 'application/json' } });
  if (!rows || rows.length === 0) throw new Error('Venue not found');
  return rows[0];
}

// ── Check tenant limits ────────────────────────────────
function checkLimits(tenant) {
  // Session limit (0 = unlimited)
  if (tenant.plan_sessions_pm > 0 &&
      tenant.sessions_this_month >= tenant.plan_sessions_pm) {
    return { blocked: true, reason: 'session_limit', message: 'Monthly session limit reached. Please upgrade your plan.' };
  }
  // Token limit (0 = unlimited)
  if (tenant.plan_tokens_pm > 0 &&
      tenant.tokens_this_month >= tenant.plan_tokens_pm) {
    return { blocked: true, reason: 'token_limit', message: 'Monthly token limit reached. Please upgrade your plan.' };
  }
  return { blocked: false };
}

// ── Build system prompt from venue config ──────────────
function buildSystemPrompt(venue, tenant, step) {
  const name        = venue.display_name || venue.name || tenant.name;
  const type        = venue.venue_type   || 'business';
  const location    = [venue.suburb, venue.state].filter(Boolean).join(', ') || 'Australia';
  const specialties = (venue.specialties || []).slice(0, 6).join(', ') || 'our products and services';
  const knownFor    = venue.known_for    || 'quality and service';

  const turnInstruction = step <= 1
    ? `This is turn ${step + 1}. Ask ONE follow-up question about a DIFFERENT aspect of their visit. Do NOT ask what else they want to share.`
    : step === 2
    ? `This is turn 3. Ask ONE final specific question, then prepare to wrap up.`
    : `This is turn ${step + 1} — FINAL TURN. Do NOT ask more questions. Wrap up gracefully. If positive use action=request_google_review and include google_draft. If neutral use action=end_neutral. If negative use action=end_negative.`;

  return `You are a warm, concise AI feedback assistant for ${name}, a ${type} in ${location}.

ABSOLUTE RULES:
1. ONE short message per turn — max 2 sentences, conversational
2. NEVER repeat a question already asked in this conversation
3. Each turn MUST advance — ask about something NEW or wrap up
4. Generate 3-5 relevant response chips
5. POSITIVE sentiment → google_draft (1st person, 2-3 sentences, specific, publishable)
6. NEGATIVE sentiment → empathise, offer manager contact, NEVER ask for Google review
7. NEUTRAL → close gracefully, offer manager contact

${turnInstruction}

About ${name}:
- Known for: ${knownFor}
- Specialties: ${specialties}

Respond ONLY in this exact JSON (no markdown, no extra text):
{
  "message": "your reply",
  "chips": [{"label":"chip text","style":"pos|neg|gold|"}],
  "sentiment": "positive|neutral|negative|unknown",
  "new_topics": ["topic"],
  "overall_score": 4,
  "highlights": ["specific highlight from what they said"],
  "action": "continue|request_google_review|end_positive|end_negative|end_neutral",
  "google_draft": "only when action=request_google_review"
}`;
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
      // Venue identification — one of these must be provided
      venueId, venueSlug, tenantId,

      // Conversation
      messages,
      step = 0,             // which conversation turn (0-based)
      mode = 'chat',

      // Session tracking
      widgetSessionId,
      tableRef,
      reviewSessionId,      // if already created

      // For saving completed reviews
      saveReview = false,
      overallScore,
      sentiment,
      topics        = [],
      highlights    = [],
      googleDraft,
      conversationHistory,
      categoryScores,
      startedAt,
      durationSeconds,

      // Legacy: allow passing system prompt directly (fallback)
      system,
    } = body;

    // ── 1. Fetch venue config ────────────────────────────
    let venue = null;
    let tenant = null;

    if (SUPABASE_URL && SUPABASE_SERVICE_KEY && (venueId || venueSlug || tenantId)) {
      try {
        const config = await getVenueConfig(venueId, venueSlug, tenantId);
        venue  = config;
        tenant = config.tenants;

        // Check plan limits
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
        console.warn('Venue fetch failed, using fallback config:', err.message);
      }
    }

    // ── 2. Handle save-only requests (completed review) ──
    if (saveReview) {
      await saveReviewSession({
        tenantId:            tenant?.id || tenantId,
        venueId:             venue?.id  || venueId,
        widgetSessionId, mode, tableRef,
        overallScore, sentiment, topics, highlights, googleDraft,
        conversationHistory, categoryScores, startedAt, durationSeconds,
      });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ saved: true }) };
    }

    // ── 3. Build system prompt ───────────────────────────
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
        max_tokens: 600,
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
    console.log(`Tokens: ${data.usage?.input_tokens}in + ${data.usage?.output_tokens}out | venue: ${venue?.slug || venueSlug || 'unknown'} | step: ${step}`);

    // ── 5. Log tokens ────────────────────────────────────
    await logTokens(
      tenant?.id || tenantId,
      venue?.id  || venueId,
      reviewSessionId || null,
      data.usage || {},
      'review_turn',
      step,
    );

    // ── 6. Return response + venue config for widget ─────
    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({
        ...data,
        // Return venue config so widget can use it
        venueConfig: venue ? {
          id:              venue.id,
          name:            venue.display_name || venue.name,
          slug:            venue.slug,
          googleReviewUrl: venue.google_review_url || null,
          primaryColor:    venue.primary_color    || tenant?.primary_color || '#C9A84C',
          widgetTheme:     venue.widget_theme      || tenant?.widget_theme  || 'dark',
          specialties:     venue.specialties       || [],
          knownFor:        venue.known_for         || '',
          venueType:       venue.venue_type        || '',
          tenantId:        tenant?.id,
          tenantName:      tenant?.name,
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
