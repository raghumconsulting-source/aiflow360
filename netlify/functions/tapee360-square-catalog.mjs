// netlify/functions/tapee360-square-catalog.mjs
// Syncs a venue's Square catalog into tapee_menu_items.
//
// GET ?venue_id=X  → pull catalog from Square, upsert into tapee_menu_items
//
import { withLambda } from '@netlify/aws-lambda-compat';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SQUARE_ENV   = process.env.SQUARE_ENV || 'sandbox';

const SQUARE_API = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Supabase helper ──────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  } catch (e) {
    if (!res.ok) throw new Error(text);
    return [];
  }
}

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const venueId = (event.queryStringParameters || {}).venue_id;
  if (!venueId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'venue_id required' }),
    };
  }

  try {
    // 1. Get venue's Square credentials
    const venues = await sb(`venues?id=eq.${venueId}&select=square_access_token,square_location_id&limit=1`);
    const venue = venues[0];

    if (!venue || !venue.square_access_token) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({ error: 'Square not connected for this venue' }),
      };
    }

    const token = venue.square_access_token;
    const locationId = venue.square_location_id;

    // 2. Fetch catalog from Square (ITEM type)
    let allItems = [];
    let cursor = null;

    do {
      const url = new URL(`${SQUARE_API}/v2/catalog/list`);
      url.searchParams.set('types', 'ITEM');
      if (cursor) url.searchParams.set('cursor', cursor);

      const catRes = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!catRes.ok) {
        const err = await catRes.json().catch(() => ({}));
        throw new Error(err.errors?.[0]?.detail || `Square API ${catRes.status}`);
      }

      const catData = await catRes.json();
      if (catData.objects) allItems.push(...catData.objects);
      cursor = catData.cursor || null;
    } while (cursor);

    console.log(`Square catalog: ${allItems.length} items for venue ${venueId}`);

    // 3. Transform Square items into tapee_menu_items rows
    const menuRows = [];
    let sortIdx = 0;

    for (const item of allItems) {
      if (item.type !== 'ITEM' || !item.item_data) continue;
      const d = item.item_data;

      // Each item can have multiple variations (sizes/options)
      // For v1, take the first variation's price
      const variation = d.variations?.[0];
      const varData = variation?.item_variation_data || {};
      // price_money.amount is in smallest currency unit (cents for AUD)
      // Try location overrides first, then default price
      const locationPrices = varData.location_overrides || [];
      const locOverride = locationPrices.find(o => o.location_id === locationId);
      const priceCents = locOverride?.price_money?.amount
        || varData.price_money?.amount
        || 0;
      const variationId = variation?.id || null;

      // Category name — Square uses category_id, but reporting_category has the name
      const category = d.reporting_category?.name || d.category?.name || 'Uncategorised';

      // Image — Square stores image URLs on the item or its image_ids
      let imageUrl = null;
      if (d.image_ids && d.image_ids.length > 0) {
        // Would need a separate catalog/object call to resolve image URL
        // For v1, skip — venue can add images manually or we resolve later
      }

      menuRows.push({
        venue_id:            venueId,
        name:                d.name || 'Unnamed item',
        description:         d.description || null,
        price_cents:         priceCents,
        category:            category,
        image_url:           imageUrl,
        is_popular:          false,
        is_featured:         false,
        available:           !d.is_deleted,
        sort_order:          sortIdx++,
        square_catalog_id:   item.id,
        square_variation_id: variationId,
      });
    }

    // 4. Get current DB count before any changes
    const existing = await sb(`tapee_menu_items?venue_id=eq.${venueId}&select=id,name,category`);
    const existingCount = Array.isArray(existing) ? existing.length : 0;

    // Build category summary from existing items
    const buildSummary = (rows) => {
      const cats = {};
      rows.forEach(r => { cats[r.category || 'Uncategorised'] = (cats[r.category || 'Uncategorised'] || 0) + 1; });
      return cats;
    };

    if (menuRows.length === 0) {
      // Square catalog is empty — return what's in the DB already
      const existingSummary = buildSummary(Array.isArray(existing) ? existing : []);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          synced:    0,
          existing:  existingCount,
          total:     existingCount,
          categories: existingSummary,
          message:   existingCount > 0
            ? `Square catalog is empty — ${existingCount} previously synced items retained`
            : 'No items found in Square catalog',
        }),
      };
    }

    // 5. Upsert: delete existing Square-synced items then insert fresh
    // Handles renamed/deleted items cleanly
    await sb(`tapee_menu_items?venue_id=eq.${venueId}&square_catalog_id=not.is.null`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });

    // Insert in batches of 50
    const BATCH = 50;
    for (let i = 0; i < menuRows.length; i += BATCH) {
      const batch = menuRows.slice(i, i + BATCH);
      await sb('tapee_menu_items', {
        method: 'POST',
        body: JSON.stringify(batch),
      });
    }

    // Build category breakdown
    const catSummary = buildSummary(menuRows);
    const synced_at = new Date().toISOString();

    console.log(`Synced ${menuRows.length} menu items for venue ${venueId}:`, JSON.stringify(catSummary));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        synced:     menuRows.length,
        existing:   existingCount,
        total:      menuRows.length,
        categories: catSummary,
        synced_at:  synced_at,
      }),
    };

  } catch (err) {
    console.error('Catalog sync error:', err);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

export default withLambda(handler);
