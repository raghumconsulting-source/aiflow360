// netlify/functions/stripe-webhook.js
// Handles Stripe billing events and writes state back to Supabase
// Events: checkout.session.completed, customer.subscription.updated,
//         customer.subscription.deleted, invoice.payment_succeeded, invoice.payment_failed

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET       = process.env.STRIPE_WEBHOOK_SECRET;

// ── Supabase REST helper ───────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        opts.prefer || 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function updateTenant(tenantId, fields) {
  return sb(`tenants?id=eq.${tenantId}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
}

async function logSubscription(record) {
  return sb('subscription_history', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify(record),
  });
}

// ── Tier lookup from price ID env vars ─────────────────
// Builds a reverse map: priceId → { product, tier, interval }
function buildPriceIndex() {
  const map = {};
  const entries = [
    ['xpscore360','essentials','monthly','STRIPE_PRICE_XP_ESSENTIALS_M'],
    ['xpscore360','essentials','annual', 'STRIPE_PRICE_XP_ESSENTIALS_A'],
    ['xpscore360','pro',       'monthly','STRIPE_PRICE_XP_PRO_M'],
    ['xpscore360','pro',       'annual', 'STRIPE_PRICE_XP_PRO_A'],
    ['xpscore360','multisite', 'monthly','STRIPE_PRICE_XP_MULTISITE_M'],
    ['xpscore360','multisite', 'annual', 'STRIPE_PRICE_XP_MULTISITE_A'],
    ['tapee360',  'starter',   'monthly','STRIPE_PRICE_TAPEE_STARTER_M'],
    ['tapee360',  'starter',   'annual', 'STRIPE_PRICE_TAPEE_STARTER_A'],
    ['tapee360',  'growth',    'monthly','STRIPE_PRICE_TAPEE_GROWTH_M'],
    ['tapee360',  'growth',    'annual', 'STRIPE_PRICE_TAPEE_GROWTH_A'],
    ['tapee360',  'enterprise','monthly','STRIPE_PRICE_TAPEE_ENTERPRISE_M'],
    ['tapee360',  'enterprise','annual', 'STRIPE_PRICE_TAPEE_ENTERPRISE_A'],
    ['smflow',    'grow',      'monthly','STRIPE_PRICE_SMFLOW_GROW_M'],
    ['smflow',    'grow',      'annual', 'STRIPE_PRICE_SMFLOW_GROW_A'],
    ['smflow',    'scale',     'monthly','STRIPE_PRICE_SMFLOW_SCALE_M'],
    ['smflow',    'scale',     'annual', 'STRIPE_PRICE_SMFLOW_SCALE_A'],
    ['smflow',    'dominate',  'monthly','STRIPE_PRICE_SMFLOW_DOMINATE_M'],
    ['smflow',    'dominate',  'annual', 'STRIPE_PRICE_SMFLOW_DOMINATE_A'],
    ['aiflow360', 'basic',     'monthly','STRIPE_PRICE_AIFLOW_BASIC_M'],
    ['aiflow360', 'basic',     'annual', 'STRIPE_PRICE_AIFLOW_BASIC_A'],
    ['aiflow360', 'business',  'monthly','STRIPE_PRICE_AIFLOW_BUSINESS_M'],
    ['aiflow360', 'business',  'annual', 'STRIPE_PRICE_AIFLOW_BUSINESS_A'],
    ['aiflow360', 'team',      'monthly','STRIPE_PRICE_AIFLOW_TEAM_M'],
    ['aiflow360', 'team',      'annual', 'STRIPE_PRICE_AIFLOW_TEAM_A'],
  ];
  for (const [product, tier, interval, envKey] of entries) {
    const priceId = process.env[envKey];
    if (priceId) map[priceId] = { product, tier, interval };
  }
  return map;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // ── Verify Stripe signature ───────────────────────────
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const PRICE_INDEX = buildPriceIndex();

  try {
    switch (stripeEvent.type) {

      // ── Checkout completed → activate subscription ────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const tenantId = session.metadata?.tenant_id;
        if (!tenantId) { console.warn('checkout.session.completed: no tenant_id in metadata'); break; }

        const subscriptionId = session.subscription;
        const customerId     = session.customer;

        // Retrieve subscription to get price details
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0]?.price?.id;
        const priceInfo = PRICE_INDEX[priceId] || {};
        const amountCents = sub.items.data[0]?.price?.unit_amount || 0;

        await updateTenant(tenantId, {
          stripe_customer_id:     customerId,
          stripe_subscription_id: subscriptionId,
          current_plan:           priceInfo.tier    || session.metadata?.tier    || 'unknown',
          current_product:        priceInfo.product || session.metadata?.product || 'unknown',
          current_interval:       priceInfo.interval|| session.metadata?.interval|| 'monthly',
          subscription_status:    'active',
          status:                 'active',
        });

        await logSubscription({
          tenant_id:    tenantId,
          plan:         priceInfo.tier || 'unknown',
          status:       'active',
          amount_cents: amountCents,
          currency:     'AUD',
          interval:     priceInfo.interval || 'monthly',
          period_start: new Date(sub.current_period_start * 1000).toISOString(),
          period_end:   new Date(sub.current_period_end   * 1000).toISOString(),
          change_reason:'checkout_completed',
        });

        console.log(`Tenant ${tenantId} activated: ${priceInfo.product}/${priceInfo.tier}/${priceInfo.interval}`);
        break;
      }

      // ── Subscription updated (plan change, renewal) ───
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const tenantId = sub.metadata?.tenant_id;
        if (!tenantId) { console.warn('subscription.updated: no tenant_id in metadata'); break; }

        const priceId   = sub.items.data[0]?.price?.id;
        const priceInfo = PRICE_INDEX[priceId] || {};
        const amountCents = sub.items.data[0]?.price?.unit_amount || 0;

        await updateTenant(tenantId, {
          stripe_subscription_id: sub.id,
          current_plan:           priceInfo.tier     || 'unknown',
          current_product:        priceInfo.product  || 'unknown',
          current_interval:       priceInfo.interval || 'monthly',
          subscription_status:    sub.status,
          status:                 sub.status === 'active' ? 'active' : 'past_due',
        });

        await logSubscription({
          tenant_id:    tenantId,
          plan:         priceInfo.tier || 'unknown',
          status:       sub.status,
          amount_cents: amountCents,
          currency:     'AUD',
          interval:     priceInfo.interval || 'monthly',
          period_start: new Date(sub.current_period_start * 1000).toISOString(),
          period_end:   new Date(sub.current_period_end   * 1000).toISOString(),
          change_reason:'subscription_updated',
        });

        console.log(`Tenant ${tenantId} subscription updated: ${sub.status}`);
        break;
      }

      // ── Subscription deleted (cancelled) ─────────────
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const tenantId = sub.metadata?.tenant_id;
        if (!tenantId) { console.warn('subscription.deleted: no tenant_id in metadata'); break; }

        // Matches same field names as account.js cancel action
        await updateTenant(tenantId, {
          subscription_status: 'cancelled',
          status:              'cancelled',
        });

        await logSubscription({
          tenant_id:    tenantId,
          plan:         'cancelled',
          status:       'cancelled',
          amount_cents: 0,
          currency:     'AUD',
          interval:     'month',
          period_start: new Date().toISOString(),
          period_end:   new Date().toISOString(),
          change_reason:'subscription_deleted',
        });

        console.log(`Tenant ${tenantId} subscription cancelled`);
        break;
      }

      // ── Invoice paid ──────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        const tenantId = invoice.subscription_details?.metadata?.tenant_id
                      || invoice.metadata?.tenant_id;
        if (!tenantId) { console.warn('invoice.payment_succeeded: no tenant_id'); break; }

        // Ensure status is active on renewal
        await updateTenant(tenantId, {
          subscription_status: 'active',
          status:              'active',
        });

        console.log(`Tenant ${tenantId} invoice paid: ${invoice.amount_paid} ${invoice.currency}`);
        break;
      }

      // ── Invoice failed ────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const tenantId = invoice.subscription_details?.metadata?.tenant_id
                      || invoice.metadata?.tenant_id;
        if (!tenantId) { console.warn('invoice.payment_failed: no tenant_id'); break; }

        await updateTenant(tenantId, {
          subscription_status: 'past_due',
          status:              'past_due',
        });

        console.log(`Tenant ${tenantId} payment failed — marked past_due`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
