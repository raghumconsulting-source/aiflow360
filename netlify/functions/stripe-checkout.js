// netlify/functions/stripe-checkout.js
// POST { tenantId, stripeCustomerId, product, tier, interval, adminCoupon? }
// Returns { checkoutUrl }
// Called by onboarding.html Step 6 after onboarding-complete creates the tenant + Stripe customer

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Price ID matrix ─────────────────────────────────────
// Resolved from env vars — never hardcoded
const PRICE_MAP = {
  xpscore360: {
    essentials: { m: 'STRIPE_PRICE_XP_ESSENTIALS_M', a: 'STRIPE_PRICE_XP_ESSENTIALS_A' },
    pro:        { m: 'STRIPE_PRICE_XP_PRO_M',        a: 'STRIPE_PRICE_XP_PRO_A'        },
    multisite:  { m: 'STRIPE_PRICE_XP_MULTISITE_M',  a: 'STRIPE_PRICE_XP_MULTISITE_A'  },
  },
  tapee360: {
    starter:    { m: 'STRIPE_PRICE_TAPEE_STARTER_M',    a: 'STRIPE_PRICE_TAPEE_STARTER_A'    },
    growth:     { m: 'STRIPE_PRICE_TAPEE_GROWTH_M',     a: 'STRIPE_PRICE_TAPEE_GROWTH_A'     },
    enterprise: { m: 'STRIPE_PRICE_TAPEE_ENTERPRISE_M', a: 'STRIPE_PRICE_TAPEE_ENTERPRISE_A' },
  },
  smflow: {
    grow:     { m: 'STRIPE_PRICE_SMFLOW_GROW_M',     a: 'STRIPE_PRICE_SMFLOW_GROW_A'     },
    scale:    { m: 'STRIPE_PRICE_SMFLOW_SCALE_M',    a: 'STRIPE_PRICE_SMFLOW_SCALE_A'    },
    dominate: { m: 'STRIPE_PRICE_SMFLOW_DOMINATE_M', a: 'STRIPE_PRICE_SMFLOW_DOMINATE_A' },
  },
  aiflow360: {
    basic:    { m: 'STRIPE_PRICE_AIFLOW_BASIC_M',    a: 'STRIPE_PRICE_AIFLOW_BASIC_A'    },
    business: { m: 'STRIPE_PRICE_AIFLOW_BUSINESS_M', a: 'STRIPE_PRICE_AIFLOW_BUSINESS_A' },
    team:     { m: 'STRIPE_PRICE_AIFLOW_TEAM_M',     a: 'STRIPE_PRICE_AIFLOW_TEAM_A'     },
  },
};

function resolvePriceId(product, tier, interval) {
  const productMap = PRICE_MAP[product];
  if (!productMap) return null;
  const tierMap = productMap[tier];
  if (!tierMap) return null;
  const envKey = interval === 'annual' ? tierMap.a : tierMap.m;
  return process.env[envKey] || null;
}

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

  // ── Resolve price ID ──────────────────────────────────
  const priceId = resolvePriceId(product, tier, interval || 'monthly');
  if (!priceId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: `No price found for ${product} / ${tier} / ${interval || 'monthly'}` }),
    };
  }

  // ── Build Stripe Checkout Session ─────────────────────
  // Admin coupon pre-applied → discounts param, promo box off
  // No admin coupon → allow_promotion_codes on so client can enter one
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
    // Admin pre-applied discount — no promo code box shown
    sessionParams.discounts = [{ coupon: adminCoupon.trim() }];
  } else {
    // Allow client to enter their own promo code at checkout
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
