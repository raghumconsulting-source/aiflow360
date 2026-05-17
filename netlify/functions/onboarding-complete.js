// netlify/functions/onboarding-complete.js
// Handles the final onboarding form submission.
// Creates: tenant, user (via Supabase Auth), venue, Stripe customer.
// Called by: onboarding.html step 6 submit.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role — bypasses RLS for setup
);

// ── Stripe (only initialise if key present) ────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Plan limits (must match platform_config in DB) ────
const PLAN_LIMITS = {
  free:     { seats: 1, venues: 1,   sessions: 100,   tokens: 50000  },
  pro:      { seats: 5, venues: 3,   sessions: 1000,  tokens: 500000 },
  business: { seats: 25,venues: 999, sessions: 10000, tokens: 0      }, // 0 = unlimited
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
exports.handler = async (event) => {

  // Handle CORS preflight
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
  const required = ['fullName', 'email', 'password', 'bizName', 'abn', 'plan'];
  for (const field of required) {
    if (!body[field]) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: `Missing required field: ${field}` }),
      };
    }
  }

  // ── 2. Check email not already registered ─────────────
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', body.email)
    .maybeSingle();

  if (existingUser) {
    return {
      statusCode: 409,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'An account with this email already exists. Please sign in.' }),
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
    // Append random suffix to ensure uniqueness
    slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── 4. Create Supabase Auth user ─────────────────────
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,  // auto-confirm — magic link sent separately
    user_metadata: {
      full_name: body.fullName,
    },
  });

  if (authError) {
    console.error('Auth create error:', authError);
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: authError.message }),
    };
  }

  const authUserId = authData.user.id;
  const limits = PLAN_LIMITS[body.plan] || PLAN_LIMITS.free;

  // ── 5. Create Stripe customer ─────────────────────────
  let stripeCustomerId = null;
  if (stripe && body.plan !== 'free') {
    try {
      const customer = await stripe.customers.create({
        email: body.email,
        name: body.bizName,
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
          plan:        body.plan,
          abn:         body.abn,
        },
      });
      stripeCustomerId = customer.id;
    } catch (stripeErr) {
      console.error('Stripe customer error:', stripeErr);
      // Don't fail onboarding if Stripe fails — we can retry
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
      contact_email:        body.contactEmail || body.email,
      contact_phone:        body.phone,
      website_url:          body.website,
      address_line1:        body.address?.line1,
      suburb:               body.address?.suburb,
      state:                body.address?.state,
      postcode:             body.address?.postcode,
      country:              'AU',
      primary_color:        body.primaryColor || '#C9A84C',
      widget_theme:         body.widgetTheme  || 'dark',
      status:               'active',
      onboarding_completed: true,
      onboarding_step:      6,
      terms_accepted_at:    body.termsAccepted ? new Date().toISOString() : null,
      terms_version:        body.termsVersion  || 'v1.0',
      privacy_accepted_at:  body.termsAccepted ? new Date().toISOString() : null,
      stripe_customer_id:   stripeCustomerId,
      current_plan:         body.plan,
      plan_seats:           limits.seats,
      plan_venues:          limits.venues,
      plan_sessions_pm:     limits.sessions,
      plan_tokens_pm:       limits.tokens,
    })
    .select('id')
    .single();

  if (tenantError) {
    console.error('Tenant create error:', tenantError);
    // Clean up auth user on failure
    await supabase.auth.admin.deleteUser(authUserId);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to create account. Please try again.' }),
    };
  }

  const tenantId = tenant.id;

  // ── 7. Create user record (extends Supabase Auth) ─────
  const { error: userError } = await supabase
    .from('users')
    .insert({
      id:               authUserId,
      tenant_id:        tenantId,
      full_name:        body.fullName,
      email:            body.email,
      phone:            body.phone,
      job_title:        body.jobTitle,
      role:             'tenant_owner',
      email_verified:   true,
      terms_accepted_at: new Date().toISOString(),
      terms_version:    body.termsVersion || 'v1.0',
    });

  if (userError) {
    console.error('User record error:', userError);
    // Non-fatal — auth user exists, just log it
  }

  // ── 8. Create first venue ─────────────────────────────
  let venueSlug = slugify(body.venue?.name || body.bizName);
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .insert({
      tenant_id:      tenantId,
      name:           body.venue?.name || body.bizName,
      slug:           venueSlug,
      status:         'active',
      address_line1:  body.venue?.address?.line1,
      suburb:         body.venue?.address?.suburb,
      state:          body.venue?.address?.state,
      postcode:       body.venue?.address?.postcode,
      country:        'AU',
      google_review_url: body.venue?.googlePlaceId || null,
      display_name:   body.displayName || body.bizName,
      venue_type:     body.venue?.type,
      specialties:    body.venue?.specialties || [],
      known_for:      body.venue?.knownFor,
      primary_color:  body.primaryColor || '#C9A84C',
      widget_theme:   body.widgetTheme  || 'dark',
    })
    .select('id')
    .single();

  if (venueError) {
    console.error('Venue create error:', venueError);
    // Non-fatal for onboarding
  }

  // ── 9. Seed subscription_history ─────────────────────
  await supabase.from('subscription_history').insert({
    tenant_id:    tenantId,
    plan:         body.plan,
    status:       'active',
    amount_cents: body.plan === 'free' ? 0 : body.plan === 'pro' ? 4900 : 14900,
    currency:     'AUD',
    interval:     'month',
    period_start: new Date().toISOString(),
    period_end:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    change_reason:'initial_signup',
  });

  // ── 10. Audit log ─────────────────────────────────────
  await supabase.from('audit_logs').insert({
    tenant_id:     tenantId,
    user_id:       authUserId,
    action:        'create',
    resource_type: 'tenant',
    resource_id:   tenantId,
    metadata: {
      plan:        body.plan,
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

    // Save logo URL back to tenant
    if (logoUploadUrl) {
      const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/tenant-assets/${logoPath}`;
      await supabase.from('tenants').update({ logo_url: publicUrl }).eq('id', tenantId);
    }
  }

  // ── 12. Respond ───────────────────────────────────────
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      success:      true,
      tenantId,
      venueId:      venue?.id || null,
      slug,
      plan:         body.plan,
      logoUploadUrl,
      dashboardUrl: '/dashboard',
      message:      'Account created successfully',
    }),
  };
};
