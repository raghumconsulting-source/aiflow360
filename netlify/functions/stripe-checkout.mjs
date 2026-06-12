// netlify/functions/stripe-checkout.js
// POST { tenantId, stripeCustomerId, product, tier, interval, adminCoupon? }
// Returns { checkoutUrl }
// Called by onboarding.html Step 6 after onboarding-complete creates the tenant + Stripe customer

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { resolvePriceId } = require('./stripe-prices');

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { tenantId, stripeCustomerId, product, tier, interval, adminCoupon } = body;

  // ── Validate required fields ──────────────────────────
  if (!tenantId || !stripeCustomerId || !product || !tier) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: 'tenantId, stripeCustomerId, product, and tier are required' }),
    };
  }

  // ── Resolve price ID from config file (not env vars) ──
  const priceId = resolvePriceId(product, tier, interval || 'monthly');
  if (!priceId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: `No price found for ${product} / ${tier} / ${interval || 'monthly'}` }),
    };
  }

  // ── Build Stripe Checkout Session ─────────────────────
  const sessionParams = {
    customer:    stripeCustomerId,
    mode:        'subscription',
    line_items:  [{ price: priceId, quantity: 1 }],
    success_url: `https://aiflow360.com/xpscore360-app/onboarding.html?checkout=success&tenant=${tenantId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `https://aiflow360.com/xpscore360-app/onboarding.html?checkout=cancel&tenant=${tenantId}`,
    metadata: {
      tenant_id: tenantId,
      product,
      tier,
      interval: interval || 'monthly',
    },
    subscription_data: {
      metadata: {
        tenant_id: tenantId,
        product,
        tier,
      },
    },
    billing_address_collection: 'auto',
    tax_id_collection:          { enabled: true },
  };

  if (adminCoupon && adminCoupon.trim()) {
    sessionParams.discounts = [{ coupon: adminCoupon.trim() }];
  } else {
    sessionParams.allow_promotion_codes = true;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ checkoutUrl: session.url }),
    };
  } catch (err) {
    console.error('stripe-checkout error:', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
