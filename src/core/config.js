'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Minimal .env loader: KEY=value per line, # comments. Real environment variables win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => process.env[k] || d;

module.exports = {
  ROOT,
  PORT: Number(env('PORT', '3100')),
  BASE_URL: env('BASE_URL', `http://localhost:${env('PORT', '3100')}`).replace(/\/$/, ''),
  BRAND_NAME: env('BRAND_NAME', 'SiteForge'),
  OPT_OUT_CONTACT: env('OPT_OUT_CONTACT', 'reply STOP'),
  GOOGLE_PLACES_API_KEY: env('GOOGLE_PLACES_API_KEY'),
  ANTHROPIC_API_KEY: env('ANTHROPIC_API_KEY'),
  VERCEL_TOKEN: env('VERCEL_TOKEN'),
  VERCEL_TEAM_ID: env('VERCEL_TEAM_ID'),
  VERCEL_PROJECT: env('VERCEL_PROJECT', 'siteforge-sites'),
  OUT_DIR: env('OUT_DIR', path.join(ROOT, 'out', 'sites')),
  PROD: env('NODE_ENV') === 'production',
  TRUST_PROXY: env('TRUST_PROXY') === '1'
};
