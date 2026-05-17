// netlify/functions/venue-config.js
// GET  — returns full venue config (ai_config + tags + actions + tables)
// POST — saves venue config (called by settings.html save button)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const venueId  = params.venue_id;
  const tenantId = params.tenant_id;

  if (!venueId || !tenantId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'venue_id and tenant_id required' }),
    };
  }

  // ── GET: fetch full config ──────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const [venueRows, aiRows, tags, actions, tables] = await Promise.all([
        supabase.from('venues').select('name,display_name').eq('id', venueId).limit(1),
        supabase.from('venue_ai_config')
          .select('*')
          .eq('venue_id', venueId)
          .limit(1),
        supabase.from('tag_bank')
          .select('*')
          .eq('venue_id', venueId)
          .order('sort_order'),
        supabase.from('recovery_actions')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('sort_order'),
        supabase.from('venue_tables')
          .select('*')
          .eq('venue_id', venueId)
          .order('sort_order'),
      ]);

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          venueName:       venueRows.data?.[0]?.display_name || venueRows.data?.[0]?.name || 'Your venue',
          venueSlug:       venueRows.data?.[0]?.slug || '',
          aiConfig:        aiRows.data?.[0] || null,
          tags:            tags.data        || [],
          recoveryActions: actions.data     || [],
          tables:          tables.data      || [],
        }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ── POST: save config ───────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    try {
      const results = {};

      // 1. Save venue_tables (delete + re-insert)
      if (body.tables !== undefined) {
        await supabase.from('venue_tables').delete().eq('venue_id', venueId);

        if (body.tables.length > 0) {
          const { error } = await supabase.from('venue_tables').insert(
            body.tables.map((t, i) => ({
              tenant_id:   tenantId,
              venue_id:    venueId,
              table_ref:   t.ref || `T${i+1}`,
              label:       t.label || `Table ${i+1}`,
              nfc_enabled: t.nfc || false,
              is_active:   t.active !== false,
              sort_order:  i,
            }))
          );
          if (error) throw error;
        }
        results.tables = 'saved';
      }

      // 2. Upsert venue_ai_config
      if (body.aiConfig !== undefined) {
        const { error } = await supabase.from('venue_ai_config').upsert({
          tenant_id:            tenantId,
          venue_id:             venueId,
          icebreaker_questions: body.aiConfig.icebreakerQuestions || [],
          opener_style:         body.aiConfig.openerStyle         || 'product_first',
          ai_persona:           body.aiConfig.aiPersona           || 'warm_casual',
          max_turns:            body.aiConfig.maxTurns            || 4,
          enabled_features:     body.aiConfig.enabledFeatures     || {},
          updated_at:           new Date().toISOString(),
        }, { onConflict: 'venue_id' });
        if (error) throw error;
        results.aiConfig = 'saved';
      }

      // 3. Update tag_bank is_active
      if (body.tagUpdates !== undefined) {
        for (const update of body.tagUpdates) {
          if (update.isNew) {
            const { error } = await supabase.from('tag_bank').insert({
              tenant_id:  tenantId,
              venue_id:   venueId,
              label:      update.label,
              topic:      update.topic,
              is_active:  update.active,
              is_default: false,
            });
            if (error) throw error;
          } else {
            const { error } = await supabase.from('tag_bank')
              .update({ is_active: update.active })
              .eq('id', update.id);
            if (error) throw error;
          }
        }
        results.tags = 'saved';
      }

      // 4. Update recovery_actions is_active
      if (body.actionUpdates !== undefined) {
        for (const update of body.actionUpdates) {
          if (update.isNew) {
            const { error } = await supabase.from('recovery_actions').insert({
              tenant_id:   tenantId,
              venue_id:    null,
              label:       update.label,
              description: update.description,
              action_type: update.type,
              is_active:   update.active,
              is_default:  false,
            });
            if (error) throw error;
          } else {
            const { error } = await supabase.from('recovery_actions')
              .update({ is_active: update.active })
              .eq('id', update.id);
            if (error) throw error;
          }
        }
        results.actions = 'saved';
      }

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, results }),
      };

    } catch (err) {
      console.error('Save error:', err);
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
