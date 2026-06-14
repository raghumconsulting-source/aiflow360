// netlify/functions/tapee360-venue-config.mjs
// Single fetch — returns everything the Tapee360 diner app needs on load.
//
// GET ?v={venue_slug}&t={table_number}
//
// Returns:
//   venue    — identity (name, logo, colors)
//   config   — app behaviour (theme, ordering modes, loyalty)
//   menu     — all available items grouped by category
//   table    — table number from URL param
//   mode     — 'dine_in' | 'takeaway' (derived from table param + config)
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function sbService(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  const text = await res.text();
  if (!text || text === 'null') return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const params  = event.queryStringParameters || {};
  const slug    = params.v;
  const tableNo = params.t || null;

  if (!slug) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'venue slug required (?v=slug)' }),
    };
  }

  try {
    // 1. Fetch venue by slug
    const venues = await sbService(
      `venues?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,logo_url,primary_color,brand_color,bg_image_url,pos_type&limit=1`
    );

    if (!venues.length) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: `Venue not found: ${slug}` }),
      };
    }

    const venue = venues[0];
    const venueId = venue.id;

    // 2. Fetch venue config (app behaviour)
    const configs = await sbService(
      `tapee_venue_config?venue_id=eq.${venueId}&select=theme,welcome_message,footer_text,currency_symbol,dine_in_enabled,takeaway_enabled,dine_in_prepayment,takeaway_payment_method,loyalty_enabled,loyalty_points_per_dollar,show_calories,show_allergens,category_images,voice_enabled,font_pairing,font_heading_color,font_body_color&limit=1`
    );

    // Use defaults if no config row yet
    const config = configs[0] || {
      theme:                    'dark',
      welcome_message:          null,
      footer_text:              null,
      currency_symbol:          '$',
      dine_in_enabled:          true,
      takeaway_enabled:         true,
      dine_in_prepayment:       false,
      takeaway_payment_method:  'card',
      loyalty_enabled:          true,
      loyalty_points_per_dollar: 10,
      show_calories:            false,
      show_allergens:           false,
      category_images:          {},
      voice_enabled:            false,
      font_pairing:             'modern',
      font_heading_color:       '#FFFFFF',
      font_body_color:          '#F5F5F5',
    };

    // 3. Fetch available menu items
    const menuItems = await sbService(
      `tapee_menu_items?venue_id=eq.${venueId}&available=eq.true&select=id,name,description,price_cents,category,image_url,is_popular,is_featured,spice_level,sort_order&order=sort_order.asc,name.asc`
    );

    // 4. Group menu by category
    const categories = {};
    const favorites  = [];

    for (const item of menuItems) {
      const cat = item.category || 'Other';

      // Favorites section — popular items
      if (item.is_popular) favorites.push(item);

      // Category grouping
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(item);
    }

    // 5. Derive order mode from table param + config
    let mode = 'dine_in';
    if (!tableNo || tableNo === 'takeaway') {
      mode = 'takeaway';
    } else if (!config.dine_in_enabled) {
      mode = 'takeaway';
    } else if (!config.takeaway_enabled) {
      mode = 'dine_in';
    }

    // Remove internal fields from venue response
    const { id: _id, ...venuePublic } = venue;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({
        venue: {
          id:            venueId,
          name:          venue.name,
          slug:          venue.slug,
          logo_url:      venue.logo_url     || null,
          primary_color: venue.primary_color || '#D4A843',
          brand_color:   venue.brand_color   || null,
          bg_image_url:  venue.bg_image_url  || null,
          pos_type:      venue.pos_type      || 'none',
        },
        config: {
          theme:                    config.theme,
          welcome_message:          config.welcome_message,
          footer_text:              config.footer_text,
          currency_symbol:          config.currency_symbol,
          dine_in_enabled:          config.dine_in_enabled,
          takeaway_enabled:         config.takeaway_enabled,
          dine_in_prepayment:       config.dine_in_prepayment,
          takeaway_payment_method:  config.takeaway_payment_method,
          loyalty_enabled:          config.loyalty_enabled,
          loyalty_points_per_dollar: config.loyalty_points_per_dollar,
          show_calories:            config.show_calories,
          show_allergens:           config.show_allergens,
          category_images:          config.category_images || {},
          voice_enabled:            config.voice_enabled,
          font_pairing:             config.font_pairing       || 'modern',
          font_heading_color:       config.font_heading_color || '#FFFFFF',
          font_body_color:          config.font_body_color    || '#F5F5F5',
        },
        menu: {
          favorites,
          categories,
          all: menuItems,
        },
        table:     tableNo,
        mode,
        item_count: menuItems.length,
      }),
    };

  } catch (err) {
    console.error('venue-config error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
