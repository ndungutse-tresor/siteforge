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
  // Client portal: the MoMo number clients pay to, and the share paid before work starts.
  MOMO_PAY_NUMBER: env('MOMO_PAY_NUMBER'),
  MOMO_PAY_NAME: env('MOMO_PAY_NAME'),
  // MoMo Pay merchant code: clients dial *182*8*1*<code># (or scan the QR code) to pay.
  MOMO_MERCHANT_CODE: env('MOMO_MERCHANT_CODE').replace(/\D/g, ''),
  MOMO_MERCHANT_NAME: env('MOMO_MERCHANT_NAME'),
  ADVANCE_PERCENT: Math.min(100, Math.max(1, Number(env('ADVANCE_PERCENT', '50')) || 50)),
  GOOGLE_PLACES_API_KEY: env('GOOGLE_PLACES_API_KEY'),
  ANTHROPIC_API_KEY: env('ANTHROPIC_API_KEY'),
  VERCEL_TOKEN: env('VERCEL_TOKEN'),
  VERCEL_TEAM_ID: env('VERCEL_TEAM_ID'),
  VERCEL_PROJECT: env('VERCEL_PROJECT', 'siteforge-sites'),
  OUT_DIR: env('OUT_DIR', path.join(ROOT, 'out', 'sites')),
  PROD: env('NODE_ENV') === 'production',
  TRUST_PROXY: env('TRUST_PROXY') === '1'
};
