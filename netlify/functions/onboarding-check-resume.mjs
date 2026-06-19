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

    if (!tenant.stripe_customer_id) {
      // Defensive: never hand back a resume response with no Stripe
      // customer to attach Checkout to — treat as not resumable rather
      // than letting the client crash on an undefined value downstream.
      return NOT_RESUMABLE;
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        resumable:        true,
        tenantId:          tenant.id,
        stripeCustomerId:  tenant.stripe_customer_id,
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
