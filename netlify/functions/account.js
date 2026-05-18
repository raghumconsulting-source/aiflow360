// netlify/functions/account.js
// Handles profile + business updates, plan cancellation, account deletion
// GET  ?action=payment&tenant_id=   → returns card details
// GET  ?action=billing_portal&tenant_id= → returns Stripe portal URL
// POST { action, ...payload }       → update_user | update_tenant | cancel | delete_account

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function stripe(path, method = 'GET', body = null) {
  if (!STRIPE_SECRET_KEY) throw new Error('Stripe not configured');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  return res.json();
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const p = event.queryStringParameters || {};

  try {
    // ── GET actions ──────────────────────────────────
    if (event.httpMethod === 'GET') {
      const { action, tenant_id } = p;

      if (action === 'payment' && tenant_id) {
        const rows = await sb(`payment_methods?tenant_id=eq.${tenant_id}&is_default=eq.true&is_active=eq.true&limit=1`);
        const pm   = rows[0];
        return {
          statusCode: 200, headers: HEADERS,
          body: JSON.stringify({ card: pm ? {
            brand: pm.card_brand, last4: pm.card_last4,
            exp_month: pm.card_exp_month, exp_year: pm.card_exp_year,
          } : null }),
        };
      }

      if (action === 'billing_portal' && tenant_id) {
        const tenants = await sb(`tenants?id=eq.${tenant_id}&select=stripe_customer_id&limit=1`);
        const customerId = tenants[0]?.stripe_customer_id;
        if (!customerId) {
          return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url: null }) };
        }
        const session = await stripe('billing_portal/sessions', 'POST', {
          customer:   customerId,
          return_url: 'https://aiflow360.com/xpscore360-app/profile.html',
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url: session.url || null }) };
      }

      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // ── POST actions ─────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      // Update user personal details
      if (action === 'update_user') {
        const { user_id, full_name, phone, job_title } = body;
        if (!user_id) throw new Error('user_id required');
        await sb(`users?id=eq.${user_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ full_name, phone, job_title, updated_at: new Date().toISOString() }),
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // Update tenant business details
      if (action === 'update_tenant') {
        const { tenant_id, name, abn, business_type, website_url, contact_email, address_line1, suburb, state } = body;
        if (!tenant_id) throw new Error('tenant_id required');
        await sb(`tenants?id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ name, abn, business_type, website_url, contact_email, address_line1, suburb, state, updated_at: new Date().toISOString() }),
        });
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // Cancel subscription
      if (action === 'cancel') {
        const { tenant_id } = body;
        const tenants = await sb(`tenants?id=eq.${tenant_id}&select=stripe_subscription_id&limit=1`);
        const subId   = tenants[0]?.stripe_subscription_id;

        if (subId && STRIPE_SECRET_KEY) {
          await stripe(`subscriptions/${subId}/cancel`, 'DELETE');
        }

        await sb(`tenants?id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
        });

        await sb('audit_logs', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({ tenant_id, action: 'cancel', resource_type: 'subscription', metadata: { source: 'profile_page' } }),
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      // Delete account
      if (action === 'delete_account') {
        const { tenant_id, user_id } = body;
        if (!tenant_id || !user_id) throw new Error('tenant_id and user_id required');

        // Soft delete — set deleted_at on tenant
        await sb(`tenants?id=eq.${tenant_id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ deleted_at: new Date().toISOString(), status: 'deleted' }),
        });

        // Delete from auth.users via admin API
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
          method: 'DELETE',
          headers: {
            'apikey':        SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
      }

      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch(err) {
    console.error('account error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
