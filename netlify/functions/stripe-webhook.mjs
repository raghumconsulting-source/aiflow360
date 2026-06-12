// netlify/functions/stripe-webhook.mjs
// Handles Stripe billing events and writes state back to Supabase

import Stripe from 'stripe';
import { buildPriceIndex } from '../lib/stripe-prices.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET       = process.env.STRIPE_WEBHOOK_SECRET;

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

const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const PRICE_INDEX = buildPriceIndex();

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session   = stripeEvent.data.object;
        const tenantId  = session.metadata?.tenant_id;
        if (!tenantId) { console.warn('checkout.session.completed: no tenant_id'); break; }

        const sub       = await stripe.subscriptions.retrieve(session.subscription);
        const priceId   = sub.items.data[0]?.price?.id;
        const priceInfo = PRICE_INDEX[priceId] || {};
        const amountCents = sub.items.data[0]?.price?.unit_amount || 0;

        await updateTenant(tenantId, {
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          current_plan:           priceInfo.tier     || session.metadata?.tier     || 'unknown',
          current_product:        priceInfo.product  || session.metadata?.product  || 'unknown',
          current_interval:       priceInfo.interval || session.metadata?.interval || 'monthly',
          subscription_status:    'active',
          status:                 'active',
          onboarding_completed:   true,
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

      case 'customer.subscription.updated': {
        const sub       = stripeEvent.data.object;
        const tenantId  = sub.metadata?.tenant_id;
        if (!tenantId) break;
        const priceId   = sub.items.data[0]?.price?.id;
        const priceInfo = PRICE_INDEX[priceId] || {};

        await updateTenant(tenantId, {
          stripe_subscription_id: sub.id,
          current_plan:           priceInfo.tier     || 'unknown',
          current_product:        priceInfo.product  || 'unknown',
          current_interval:       priceInfo.interval || 'monthly',
          subscription_status:    sub.status,
          status:                 sub.status === 'active' ? 'active' : 'past_due',
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub      = stripeEvent.data.object;
        const tenantId = sub.metadata?.tenant_id;
        if (!tenantId) break;
        await updateTenant(tenantId, { subscription_status: 'cancelled', status: 'cancelled' });
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice  = stripeEvent.data.object;
        const tenantId = invoice.subscription_details?.metadata?.tenant_id || invoice.metadata?.tenant_id;
        if (!tenantId) break;
        await updateTenant(tenantId, { subscription_status: 'active', status: 'active' });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice  = stripeEvent.data.object;
        const tenantId = invoice.subscription_details?.metadata?.tenant_id || invoice.metadata?.tenant_id;
        if (!tenantId) break;
        await updateTenant(tenantId, { subscription_status: 'past_due', status: 'past_due' });
        break;
      }

      default:
        console.log(`Unhandled event: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

export default handler;
