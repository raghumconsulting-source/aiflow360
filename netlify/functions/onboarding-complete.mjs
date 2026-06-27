import { withLambda } from '@netlify/aws-lambda-compat';
import Stripe from 'stripe';

// netlify/functions/onboarding-complete.js
// Handles the final onboarding form submission.
// Creates: tenant, user (via Supabase Auth), venue, Stripe customer.
// Does NOT create Stripe subscription — that is handled by stripe-checkout.js
// Called by: onboarding.html step 6 submit.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role — bypasses RLS for setup
);

// ── Stripe (only initialise if key present) ────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Plan limits per product + tier ─────────────────────
// These gate feature access inside each product's dashboard
const PLAN_LIMITS = {
  xpscore360: {
    essentials: { seats: 1,  venues: 1,   nfc_points: 3,   sessions_pm: 500,   analytics_days: 30  },
    pro:        { seats: 3,  venues: 5,   nfc_points: 999, sessions_pm: 5000,  analytics_days: 90  },
    multisite:  { seats: 10, venues: 999, nfc_points: 999, sessions_pm: 99999, analytics_days: 365 },
  },
  tapee360: {
    starter:    { seats: 1,  venues: 1,   tables: 20,  menu_items: 50,  sessions_pm: 1000  },
    growth:     { seats: 3,  venues: 1,   tables: 999, menu_items: 999, sessions_pm: 10000 },
    enterprise: { seats: 10, venues: 999, tables: 999, menu_items: 999, sessions_pm: 99999 },
  },
  smflow: {
    grow:     { seats: 1,  brands: 1,   posts_pm: 50,    images_pm: 50,    flavors: 12, gurus: 3 },
    scale:    { seats: 3,  brands: 5,   posts_pm: 99999, images_pm: 500,   flavors: 19, gurus: 5 },
    dominate: { seats: 10, brands: 999, posts_pm: 99999, images_pm: 99999, flavors: 19, gurus: 5 },
  },
  aiflow360: {
    basic:    { seats: 1,   agents: 1,   runs_pm: 999,   api_access: false },
    business: { seats: 5,   agents: 15,  runs_pm: 99999, api_access: true  },
    team:     { seats: 999, agents: 999, runs_pm: 99999, api_access: true  },
  },
};

// ── Monthly amounts in cents per product+tier ──────────
// Used only for subscription_history initial record
// Webhook will overwrite with real Stripe amounts on checkout.session.completed
const MONTHLY_AMOUNTS = {
  xpscore360: { essentials: 4900,  pro: 9900,  multisite: 19900 },
  tapee360:   { starter: 9900,     growth: 19900, enterprise: 29900 },
  smflow:     { grow: 19900,       scale: 49900,  dominate: 75000  },
  aiflow360:  { basic: 9900,       business: 19900, team: 29900    },
};

// ── Helpers ────────────────────────────────────────────
function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// ── Handler ────────────────────────────────────────────
const handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // ── 1. Validate required fields ──────────────────────
  // password is required UNLESS the person authenticated via Google
  // (googleAccessToken present) — that case is verified separately in
  // step 1a below, which establishes authUserId without ever needing a
  // password at all.
  const required = ['fullName', 'email', 'bizName', 'abn', 'plan', 'product'];
  if (!body.googleAccessToken && !body.password) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Missing required field: password' }),
    };
  }
  for (const field of required) {
    if (!body[field]) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: `Missing required field: ${field}` }),
      };
    }
  }

  // Validate product is known
  const validProducts = ['xpscore360', 'tapee360', 'smflow', 'aiflow360'];
  if (!validProducts.includes(body.product)) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: `Unknown product: ${body.product}` }),
    };
  }

  // ── 1a. If signing up via Google, verify the access token server-side ──
  // We never trust a client-supplied user id or email directly — that
  // would let anyone claim to be any existing user. Instead, the frontend
  // sends the real Supabase access token from the Google OAuth session it
  // already has, and we ask Supabase itself who that token actually
  // belongs to. This MUST run before the email-normalize/existing-user
  // check below, since it's what establishes the only email we trust for
  // a Google sign-up — body.email as typed by the client is not used in
  // that case.
  let googleAuthUserId = null;
  if (body.googleAccessToken) {
    const { data: googleUserData, error: googleAuthError } =
      await supabase.auth.getUser(body.googleAccessToken);
    if (googleAuthError || !googleUserData?.user) {
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Your Google session has expired. Please sign in with Google again.' }),
      };
    }
    body.email = googleUserData.user.email;
    googleAuthUserId = googleUserData.user.id;
  }

  // Normalize email once, up front — every downstream write (auth user,
  // users table, Stripe customer, contact_email fallback) and the lookup
  // just below must agree on casing, or the resume-by-email matching in
  // onboarding-check-resume.mjs can silently miss a real account.
  body.email = body.email.trim().toLowerCase();

  // ── 2. Check email not already registered ─────────────
  // NOTE: this is intentionally a hard block, not a resume path. Resuming
  // an abandoned/cancelled signup requires proof of identity (the account
  // password), which is verified separately by
  // netlify/functions/onboarding-check-resume.mjs BEFORE the wizard ever
  // reaches this function. Do not add an email-only resume branch here —
  // doing so would let an unauthenticated caller pull another tenant's
  // stripe_customer_id and rewrite their pending plan. See code review
  // notes (2026-06) for the incident this guards against.
  //
  // For a Google sign-up specifically: if this email is already
  // registered, it could be the same person re-attempting (their Google
  // identity matches an existing tenant) — but resuming still requires
  // going through onboarding-check-resume.mjs like any other resume, not
  // a silent bypass here just because Google already authenticated them.
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', body.email)
    .maybeSingle();

  if (existingUser) {
    return {
      statusCode: 409,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'An account with this email already exists. Please sign in to resume.' }),
    };
  }

  // ── 3. Generate unique tenant slug ───────────────────
  let slug = slugify(body.bizName);
  const { data: slugCheck } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (slugCheck) {
    slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── 4. Create Supabase Auth user (skipped for Google sign-ups — ──
  //      that identity already exists, verified above)
  let authUserId;
  if (googleAuthUserId) {
    authUserId = googleAuthUserId;
  } else {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.fullName },
    });

    if (authError) {
      console.error('Auth create error:', authError);
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: authError.message }),
      };
    }

    authUserId = authData.user.id;
  }

  // Resolve plan limits for this product + tier
  const productLimits = PLAN_LIMITS[body.product] || {};
  const limits = productLimits[body.plan] || {};

  // ── 5. Create Stripe customer ─────────────────────────
  let stripeCustomerId = null;
  if (stripe) {
    try {
      const customer = await stripe.customers.create({
        email: body.email,
        name:  body.bizName,
        phone: body.phone || undefined,
        address: body.address ? {
          line1:       body.address.line1,
          city:        body.address.suburb,
          state:       body.address.state,
          postal_code: body.address.postcode,
          country:     'AU',
        } : undefined,
        metadata: {
          tenant_slug: slug,
          product:     body.product,
          plan:        body.plan,
          abn:         body.abn,
        },
      });
      stripeCustomerId = customer.id;
    } catch (stripeErr) {
      console.error('Stripe customer error:', stripeErr);
      // Non-fatal — onboarding continues, checkout will create customer if needed
    }
  }

  // ── 6. Create tenant record ───────────────────────────
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .insert({
      name:                 body.bizName,
      slug,
      display_name:         body.displayName || body.bizName,
      abn:                  body.abn,
      business_type:        body.bizType,
      industry_code:        body.industry_code        || null,
      business_type_code:   body.business_type_code   || null,
      contact_email:        body.contactEmail         || body.email,
      contact_phone:        body.phone,
      website_url:          body.website,
      address_line1:        body.address?.line1,
      suburb:               body.address?.suburb,
      state:                body.address?.state,
      postcode:             body.address?.postcode,
      country:              'AU',
      primary_color:        body.primaryColor         || '#C9A84C',
      widget_theme:         body.widgetTheme          || 'dark',
      // Billing — subscription_status starts as pending until checkout completes
      status:               'pending_payment',
      onboarding_completed: false,   // set to true after checkout.session.completed
      onboarding_step:      6,
      terms_accepted_at:    body.termsAccepted ? new Date().toISOString() : null,
      terms_version:        body.termsVersion  || 'v1.0',
      privacy_accepted_at:  body.termsAccepted ? new Date().toISOString() : null,
      stripe_customer_id:   stripeCustomerId,
      current_plan:         body.plan,
      current_product:      body.product,
      current_interval:     body.interval             || 'monthly',
      subscription_status:  'pending_payment',
      // Limit columns — product-specific, extras ignored gracefully
      plan_seats:           limits.seats              || 1,
      plan_venues:          limits.venues             || 1,
      plan_sessions_pm:     limits.sessions_pm        || 0,
      plan_tokens_pm:       limits.tokens             || 0,
    })
    .select('id')
    .single();

  if (tenantError) {
    console.error('Tenant create error:', tenantError);
    // Only roll back the auth user if THIS request created it. A Google
    // sign-up reuses an identity that already existed before this call —
    // deleting it here would destroy someone's real login over an
    // unrelated tenant-insert failure, not just undo this attempt.
    if (!googleAuthUserId) {
      await supabase.auth.admin.deleteUser(authUserId);
    }
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to create account. Please try again.' }),
    };
  }

  const tenantId = tenant.id;

  // ── 7. Create user record ─────────────────────────────
  const { error: userError } = await supabase
    .from('users')
    .insert({
      id:                authUserId,
      tenant_id:         tenantId,
      full_name:         body.fullName,
      email:             body.email,
      phone:             body.phone,
      job_title:         body.jobTitle,
      role:              'tenant_owner',
      email_verified:    true,
      terms_accepted_at: new Date().toISOString(),
      terms_version:     body.termsVersion || 'v1.0',
    });

  if (userError) {
    console.error('User record error:', userError);
    // Non-fatal — auth user exists, log and continue
  }

  // ── 8. Create first venue ─────────────────────────────
  let venueSlug = slugify(body.venue?.name || body.bizName);
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .insert({
      tenant_id:          tenantId,
      name:               body.venue?.name          || body.bizName,
      slug:               venueSlug,
      status:             'active',
      address_line1:      body.venue?.address?.line1,
      suburb:             body.venue?.address?.suburb,
      state:              body.venue?.address?.state,
      postcode:           body.venue?.address?.postcode,
      country:            'AU',
      google_review_url:  body.venue?.googlePlaceId || null,
      display_name:       body.displayName          || body.bizName,
      venue_type:         body.venue?.type,
      industry_code:      body.industry_code        || null,
      business_type_code: body.business_type_code   || null,
      specialties:        body.venue?.specialties   || [],
      known_for:          body.venue?.knownFor,
      primary_color:      body.primaryColor         || '#C9A84C',
      widget_theme:       body.widgetTheme          || 'dark',
    })
    .select('id')
    .single();

  if (venueError) {
    console.error('Venue create error:', venueError);
    // Non-fatal for onboarding
  }

  // ── 8b. Seed KPI tiles for this venue ───────────────
  if (venue?.id && body.industry_code && body.business_type_code) {
    try {
      await supabase.rpc('seed_venue_kpis', {
        p_tenant_id: tenantId,
        p_venue_id:  venue.id,
        p_industry:  body.industry_code,
        p_biz_type:  body.business_type_code,
      });
      console.log(`Seeded KPI tiles for ${body.industry_code}/${body.business_type_code}`);
    } catch (kpiErr) {
      console.warn('KPI seed failed (non-fatal):', kpiErr.message);
    }
  }

  // ── 9. Seed subscription_history (pending record) ─────
  const amountCents = (MONTHLY_AMOUNTS[body.product] || {})[body.plan] || 0;
  await supabase.from('subscription_history').insert({
    tenant_id:    tenantId,
    plan:         body.plan,
    status:       'pending_payment',
    amount_cents: amountCents,
    currency:     'AUD',
    interval:     body.interval || 'month',
    period_start: new Date().toISOString(),
    period_end:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    change_reason:'initial_signup_pending',
  });

  // ── 10. Audit log ─────────────────────────────────────
  await supabase.from('audit_logs').insert({
    tenant_id:     tenantId,
    user_id:       authUserId,
    action:        'create',
    resource_type: 'tenant',
    resource_id:   tenantId,
    metadata: {
      product:     body.product,
      plan:        body.plan,
      interval:    body.interval || 'monthly',
      abn:         body.abn,
      venue_count: 1,
      source:      'onboarding_wizard',
    },
  });

  // ── 11. Generate Supabase Storage logo upload URL ─────
  let logoUploadUrl = null;
  if (body.hasLogo) {
    const logoPath = `${tenantId}/logo.png`;
    const { data: uploadData } = await supabase.storage
      .from('tenant-assets')
      .createSignedUploadUrl(logoPath);
    logoUploadUrl = uploadData?.signedUrl || null;

    if (logoUploadUrl) {
      const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/tenant-assets/${logoPath}`;
      await supabase.from('tenants').update({ logo_url: publicUrl }).eq('id', tenantId);
    }
  }

  // ── 12. Respond ───────────────────────────────────────
  // Return stripeCustomerId so onboarding.html can pass it to stripe-checkout
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      success:          true,
      tenantId,
      venueId:          venue?.id          || null,
      slug,
      product:          body.product,
      plan:             body.plan,
      interval:         body.interval      || 'monthly',
      stripeCustomerId,
      logoUploadUrl,
      message:          'Account created. Redirecting to payment...',
    }),
  };
};

export default withLambda(handler);
