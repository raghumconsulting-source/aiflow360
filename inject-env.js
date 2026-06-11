// inject-env.js
// Replaces placeholders in HTML files with real env vars at Netlify build time.
// Never put real keys in source code — set them in Netlify environment variables.

const fs = require('fs');
const path = require('path');

const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!ANON_KEY) {
  console.warn('⚠️  SUPABASE_ANON_KEY env var not set — widget DB calls will fail');
}

const FILES = [
  'XPscore360/index.html',
  'xpscore360-app/dashboard.html',
  'xpscore360-app/settings.html',
  'xpscore360-app/profile.html',
];

FILES.forEach(file => {
  if (!fs.existsSync(file)) {
    console.log(`Skipping ${file} — not found`);
    return;
  }
  let content = fs.readFileSync(file, 'utf8');
  const before = content;
  content = content.replaceAll('__SUPABASE_ANON_PLACEHOLDER__', ANON_KEY);
  fs.writeFileSync(file, content);
  const changed = content !== before;
  console.log(`${changed ? '✓' : '—'} ${file}`);
});

// ---------------------------------------------------------------------------
// Google service account key → bundled file (NOT a function env var)
//
// The full service-account JSON (~2 KB) is far too large to live in the
// per-function environment: AWS Lambda caps each function's environment
// variables at 4 KB total, and Netlify injects every site variable into every
// function. We keep GOOGLE_SERVICE_ACCOUNT_KEY scoped to the *build* only, read
// it here at build time, and write it to a file that esbuild bundles into the
// one function that needs it (smflow-assets). That removes ~2 KB from every
// function's environment so the whole site stays under the 4 KB limit.
//
// The file is git-ignored; the secret only ever exists in the deployed bundle.
// ---------------------------------------------------------------------------
const GSA_KEY  = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
const GSA_FILE = path.join(__dirname, 'netlify', 'functions', '_gsa.json');

let gsaPayload = {};
if (GSA_KEY) {
  try {
    gsaPayload = JSON.parse(GSA_KEY);
    console.log('✓ Google service account key written to bundled file');
  } catch (err) {
    console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON — Drive features will be disabled:', err.message);
  }
} else {
  console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_KEY not set at build time — Drive features will be disabled');
}
// Always write a valid JSON file so the function bundles cleanly even when the
// key is absent (e.g. local dev or previews without the secret).
fs.writeFileSync(GSA_FILE, JSON.stringify(gsaPayload));

console.log('Injection complete.');
