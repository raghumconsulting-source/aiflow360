// netlify/functions/onboarding-check-resume.mjs
//
// SECURITY MODEL (read before modifying):
//   This endpoint NEVER returns tenant/billing details on the basis of an
//   email address alone — that would let anyone enumerate other people's
//   signups and would let an attacker trigger a Stripe Checkout session
//   tied to a stranger's stripe_customer_id / mutate their pending plan.
//
//   Resume is only granted after the caller proves they know the account
//   PASSWORD, verified via a real Supabase sign-in (anon-key client, not
//   the service-role client used elsewhere in this file) — i.e. the same
//   proof-of-identity a normal login requires. No password = no resume.
//
//   If the tenant has no stripe_customer_id on file (e.g. an earlier
//   signup attempt hit a transient Stripe error, or an admin cleared a
//   stale test-mode id), this endpoint creates a fresh Stripe customer
//   on the spot and saves it — stripe-checkout.mjs requires an existing
//   customer id and will not create one itself, so this can't be left
//   to that step.
//
// POST { email, password }
//   → 200 { resumable:false }                                   (no match,
//                                                                  or wrong
//                                                                  password —
//                                                                  identical
//                                                                  response
//                                                                  shape so
//                                                                  callers
//                                                                  can't
//                                                                  distinguish
//                                                                  "no account"
//                                                                  from "wrong
//                                                                  password")
//   → 200 { resumable:true, tenantId, stripeCustomerId, product,
//           plan, interval, bizName }                            (verified)

import { withLambda } from '@netlify/aws-lambda-compat';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Stripe client — only used as a fallback when a resumable tenant has no
// stripe_customer_id yet (see step 3 below). Most resumable tenants will
// already have one from their original onboarding-complete.mjs run; this
// covers tenants where that ID was cleared (e.g. a stale test-mode id after
// a live-mode key switch) or never set due to an earlier Stripe API error.
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Service-role client — used only for DB reads after identity is proven.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Anon-key client — used ONLY to verify the password via a real sign-in.
// This must use the public anon key, not the service key, so Supabase
// applies normal password-grant semantics (rate limiting, lockouts, etc.
// already configured on the project apply here for free).
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const RESUMABLE_STATUSES = ['pending_payment', 'past_due', 'incomplete'];

// Generic, identical-shape failure response — deliberately does not
// reveal whether the email exists, the tenant exists, or the password
// was wrong. Prevents account/email enumeration.
const NOT_RESUMABLE = { statusCode: 200, headers: HEADERS, body: JSON.stringify({ resumable: false }) };

const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email    = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !password) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'email and password required' }) };
  }

  try {
    // ── 1. Verify identity FIRST, via a real Supabase sign-in. ──────
    // This is the proof-of-ownership gate. If this fails for any reason
    // (wrong password, account doesn't exist, account disabled), we must
    // return the exact same response as "nothing to resume" — never leak
    // which case it was.
    const { data: signInData, error: signInError } =
      await supabaseAuth.auth.signInWithPassword({ email, password });

    if (signInError || !signInData?.user) {
      return NOT_RESUMABLE;
    }

    const authUserId = signInData.user.id;

    // Immediately sign back out — this endpoint must not create a
    // lingering session; it only uses the sign-in as a one-shot identity
    // check. The wizard itself still issues no session token to the
    // browser from this call.
    await supabaseAuth.auth.signOut();

    // ── 2. Identity confirmed — now look up their tenant by user id, ──
    //      NOT by email, to avoid any risk of email/user mismatch.
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('tenant_id')
      .eq('id', authUserId)
      .maybeSingle();

    if (!userRow) return NOT_RESUMABLE;

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('id, name, display_name, subscription_status, stripe_customer_id, current_product, current_plan, current_interval')
      .eq('id', userRow.tenant_id)
      .maybeSingle();

    if (!tenant || !RESUMABLE_STATUSES.includes(tenant.subscription_status)) {
      return NOT_RESUMABLE;
    }

    let stripeCustomerId = tenant.stripe_customer_id;

    if (!stripeCustomerId) {
      // No Stripe customer on file — most commonly because the original
      // signup hit a transient Stripe error (onboarding-complete.mjs treats
      // that as non-fatal and continues without one), or because an admin
      // cleared a stale test-mode customer ID after a live-mode key switch
      // (a stale test-mode id is invisible to live mode and causes
      // "No such customer" errors at checkout if left in place).
      //
      // Earlier versions of this endpoint treated a missing customer id as
      // a dead end ("not resumable") on the assumption that stripe-checkout
      // would create one itself — it doesn't; it requires an existing
      // customer id and fails if none is given. So we create one here,
      // exactly like onboarding-complete.mjs's original signup path does.
      if (!stripe) {
        console.error('Cannot create Stripe customer during resume: STRIPE_SECRET_KEY not configured');
        return NOT_RESUMABLE;
      }

      // Re-check immediately before creating, to narrow (not eliminate —
      // a true row lock would be needed for that) the window where a
      // double-click or retried request could create two Stripe customers
      // for the same tenant. If another concurrent request already filled
      // this in between our first read and now, use that one instead of
      // creating a second.
      const { data: recheck } = await supabaseAdmin
        .from('tenants')
        .select('stripe_customer_id')
        .eq('id', tenant.id)
        .maybeSingle();

      if (recheck?.stripe_customer_id) {
        stripeCustomerId = recheck.stripe_customer_id;
      } else {
        try {
          const customer = await stripe.customers.create({
            email: email,
            name:  tenant.display_name || tenant.name,
            metadata: {
              tenant_id: tenant.id,
              product:   tenant.current_product || '',
              plan:      tenant.current_plan || '',
              source:    'onboarding-check-resume',
            },
          });
          stripeCustomerId = customer.id;

          console.log(`onboarding-check-resume: created Stripe customer ${stripeCustomerId} for tenant ${tenant.id} (had none on file)`);

          // Persist immediately so a second resume attempt (or the actual
          // checkout call right after this) doesn't need to recreate it —
          // and so this tenant doesn't trip the same dead end again later.
          await supabaseAdmin
            .from('tenants')
            .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
            .eq('id', tenant.id);
        } catch (stripeErr) {
          console.error('Failed to create Stripe customer during resume:', stripeErr.message);
          // Fail closed, same as every other error path in this function —
          // better to tell the person "try again" than hand back a resume
          // response with no customer to attach Checkout to.
          return NOT_RESUMABLE;
        }
      }
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        resumable:        true,
        tenantId:          tenant.id,
        stripeCustomerId:  stripeCustomerId,
        product:           tenant.current_product,
        plan:              tenant.current_plan,
        interval:          tenant.current_interval || 'monthly',
        bizName:           tenant.display_name || tenant.name,
      }),
    };

  } catch (err) {
    console.error('onboarding-check-resume error:', err.message);
    // Fail closed — any unexpected error results in "not resumable",
    // never in an error response that could hint at internal state.
    return NOT_RESUMABLE;
  }
};

export default withLambda(handler);
