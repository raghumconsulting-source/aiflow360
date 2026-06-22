// netlify/functions/smflow-meta-deletion-status.js
//
// Public status page for a data-deletion request, linked from the `url`
// field SMflow returns to Meta in smflow-meta-data-deletion.js. A real
// person may open this directly in their browser, so it returns simple
// HTML, not JSON — there's no Meta signature to verify here since this is
// a plain GET a person clicks, not a server-to-server webhook.
//
// Deliberately read-only and minimal: the confirmation_code is the only
// input, and it's just used to look up a status string — nothing
// sensitive (fb_user_id, error details) is ever rendered back to the page.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderPage(statusLabel, detail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Data Deletion Status — SMflow</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#11141D;color:rgba(248,249,250,0.9);display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:480px;background:#0D1017;border:1px solid rgba(255,255,255,0.11);border-radius:14px;padding:40px;text-align:center}
  h1{font-size:20px;font-weight:600;margin:0 0 12px}
  p{font-size:14px;color:rgba(255,255,255,0.55);line-height:1.7;margin:0}
  .status{display:inline-block;padding:6px 16px;border-radius:9999px;font-size:13px;font-weight:600;margin-bottom:20px}
  .status.completed{background:rgba(34,197,94,0.12);color:#22C55E}
  .status.pending{background:rgba(212,168,67,0.12);color:#D4A843}
  .status.notfound{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5)}
</style>
</head>
<body>
  <div class="card">
    <div class="status ${statusLabel}">${statusLabel.toUpperCase()}</div>
    <h1>Data Deletion Request</h1>
    <p>${detail}</p>
  </div>
</body>
</html>`;
}

exports.handler = async function (event) {
  const id = (event.queryStringParameters || {}).id;

  if (!id) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: renderPage('notfound', 'No confirmation code was provided.'),
    };
  }

  const safeId = escapeHtml(id);
  const rows = await sb(`smflow_data_deletion_requests?confirmation_code=eq.${encodeURIComponent(id)}&select=status,requested_at,completed_at&limit=1`);

  if (!rows.length) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html' },
      body: renderPage('notfound', `We couldn't find a request matching confirmation code ${safeId}.`),
    };
  }

  const r = rows[0];
  const label = r.status === 'completed' ? 'completed' : (r.status === 'failed' ? 'pending' : 'pending');
  const detail = r.status === 'completed'
    ? `Your data deletion request (${safeId}) was completed on ${escapeHtml(new Date(r.completed_at).toLocaleString('en-AU'))}.`
    : `Your data deletion request (${safeId}) was received on ${escapeHtml(new Date(r.requested_at).toLocaleString('en-AU'))} and is being processed.`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: renderPage(label, detail),
  };
};
