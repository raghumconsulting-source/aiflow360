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

console.log('Injection complete.');
