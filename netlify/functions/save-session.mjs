import { withLambda } from '@netlify/aws-lambda-compat';

// netlify/functions/save-session.js
// POST — saves or updates a guest review session
// Called by the widget — no API key needed in browser

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    id, tenant_id, venue_id, table_ref, mode,
    overall_score, sentiment, topics, highlights,
    google_draft, duration_seconds, conversation_history,
    manager_alert, completed_at,
  } = body;

  if (!id || !tenant_id || !venue_id) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'id, tenant_id and venue_id required' }),
    };
  }

  try {
    const { error } = await supabase
      .from('review_sessions')
      .upsert({
        id,
        tenant_id,
        venue_id,
        table_ref:            table_ref || null,
        mode:                 (mode === 'quick' ? 'quick' : 'chat'),
        overall_score:        overall_score || null,
        sentiment:            sentiment || 'unknown',
        topics:               topics || [],
        highlights:           highlights || [],
        google_draft:         google_draft || null,
        duration_seconds:     duration_seconds || 0,
        conversation_history: conversation_history || [],
        manager_alert:        manager_alert || false,
        completed_at:         completed_at || null,
      }, { onConflict: 'id' });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error('save-session error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
