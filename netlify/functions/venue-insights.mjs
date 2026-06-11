import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/venue-insights.js
// GET  — returns cached AI insights for a venue
// GET with refresh=true — regenerates insights via Claude then caches
//
// Reads last N days of review_sessions for the venue,
// calls Claude Haiku to produce structured recommendations,
// saves to venue_ai_insights table, returns JSON.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL                = 'claude-haiku-4-5-20251001';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

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
    throw new Error(`Supabase ${path}: ${JSON.stringify(err)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

const handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const p       = event.queryStringParameters || {};
  const venueId = p.venue_id;
  const tenantId= p.tenant_id;
  const days    = parseInt(p.days) || 30;
  const refresh = p.refresh === 'true';

  if (!venueId || !tenantId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'venue_id and tenant_id required' }) };
  }

  try {
    // ── 1. Return cached insights if fresh enough ──────
    if (!refresh) {
      const cached = await sb(
        `venue_ai_insights?venue_id=eq.${venueId}&order=generated_at.desc&limit=1`
      );
      if (cached[0]) {
        const age = (Date.now() - new Date(cached[0].generated_at)) / 3600000;
        if (age < 6) { // cache for 6 hours
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached[0]) };
        }
      }
    }

    // ── 2. Fetch venue + recent sessions ──────────────
    const [venueRows, sessions] = await Promise.all([
      sb(`venues?id=eq.${venueId}&select=name,display_name,venue_type,known_for,specialties&limit=1`),
      sb(`review_sessions?venue_id=eq.${venueId}&tenant_id=eq.${tenantId}&created_at=gte.${new Date(Date.now()-days*86400000).toISOString()}&select=sentiment,overall_score,topics,highlights,manager_alert,manager_alert_reason,table_ref&order=created_at.desc&limit=200`),
    ]);

    const venue  = venueRows[0];
    const total  = sessions.length;

    if (!venue || total < 3) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          venue_id: venueId,
          generated_at: new Date().toISOString(),
          session_count: total,
          insights: {
            summary: total < 3
              ? 'Not enough data yet — you need at least 3 reviews to generate insights. Keep collecting feedback!'
              : 'Generating insights...',
            top_issues: [],
            strengths: [],
            action_items: [],
          },
        }),
      };
    }

    // ── 3. Build analysis payload for Claude ──────────
    const positive = sessions.filter(s=>s.sentiment==='positive').length;
    const neutral  = sessions.filter(s=>s.sentiment==='neutral').length;
    const negative = sessions.filter(s=>s.sentiment==='negative').length;
    const scores   = sessions.filter(s=>s.overall_score).map(s=>s.overall_score);
    const avgScore = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(2) : 'N/A';
    const alerts   = sessions.filter(s=>s.manager_alert);

    // Topic frequency
    const topicCounts = {};
    sessions.forEach(s => (s.topics||[]).forEach(t => { topicCounts[t]=(topicCounts[t]||0)+1; }));
    const topTopics = Object.entries(topicCounts).sort((a,b)=>b[1]-a[1]).slice(0,10)
      .map(([t,n])=>`${t}: ${n} mentions`).join(', ');

    // Negative session topics
    const negTopics = {};
    sessions.filter(s=>s.sentiment==='negative').forEach(s =>
      (s.topics||[]).forEach(t => { negTopics[t]=(negTopics[t]||0)+1; })
    );
    const topNegTopics = Object.entries(negTopics).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([t,n])=>`${t}: ${n} mentions`).join(', ');

    // Sample highlights
    const highlights = sessions
      .filter(s=>s.highlights?.length)
      .flatMap(s=>s.highlights)
      .slice(0,10)
      .join('; ');

    const prompt = `You are a hospitality business analyst. Analyse this guest feedback data and produce actionable recommendations.

VENUE: ${venue.display_name||venue.name} (${venue.venue_type||'hospitality'})
KNOWN FOR: ${venue.known_for||'quality service'}
PERIOD: Last ${days} days
TOTAL REVIEWS: ${total}

SENTIMENT BREAKDOWN:
- Positive: ${positive} (${Math.round(positive/total*100)}%)
- Neutral:  ${neutral}  (${Math.round(neutral/total*100)}%)
- Negative: ${negative} (${Math.round(negative/total*100)}%)
AVG SCORE: ${avgScore}/5

TOP TOPICS (all reviews): ${topTopics||'none'}
TOP NEGATIVE TOPICS: ${topNegTopics||'none'}
OPEN ALERTS: ${alerts.length}
SAMPLE HIGHLIGHTS: ${highlights||'none'}

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "summary": "2-3 sentence executive summary of the venue's current performance and biggest opportunity",
  "score_trend": "up|down|stable",
  "top_issues": [
    {
      "topic": "topic name",
      "severity": "high|medium|low",
      "mention_count": 12,
      "recommendation": "Specific, actionable recommendation in 1-2 sentences"
    }
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "action_items": [
    "Specific action item 1",
    "Specific action item 2",
    "Specific action item 3"
  ]
}

Rules:
- top_issues: max 3, ranked by severity then mention_count
- strengths: max 3, based on positive topics
- action_items: max 4, specific and immediately actionable
- Recommendations must be specific to hospitality operations, not generic
- If negative reviews are low (<15%), focus on maintaining strengths`;

    // ── 4. Call Claude ────────────────────────────────
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 800,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) throw new Error('Claude API error: ' + aiRes.status);
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    const clean   = rawText.replace(/```json\n?/,'').replace(/\n?```/,'').trim();
    const insights = JSON.parse(clean);

    // ── 5. Save to venue_ai_insights ──────────────────
    const record = {
      tenant_id:     tenantId,
      venue_id:      venueId,
      generated_at:  new Date().toISOString(),
      period_days:   days,
      session_count: total,
      insights,
    };

    // Upsert — one row per venue (delete old, insert new)
    await sb(`venue_ai_insights?venue_id=eq.${venueId}`, {
      method: 'DELETE',
      prefer: '',
    }).catch(() => {}); // non-fatal if table doesn't exist yet

    const saved = await sb('venue_ai_insights', {
      method: 'POST',
      prefer: 'return=representation',
      body:   JSON.stringify(record),
    });

    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify(saved[0] || record),
    };

  } catch (err) {
    console.error('venue-insights error:', err.message);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
