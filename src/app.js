'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, PROD, TRUST_PROXY } = require('./core/config');
const { db } = require('./core/db');
const { hashSecret } = require('./core/auth');
const { handle } = require('./api');
const { sendJson } = require('./core/http');
const { siteResponse } = require('./hosting/publish');

// One request handler for both hosts: server.js (local) and api/index.js (Vercel).
// On Vercel the static files in public/ are served by Vercel itself, with the same headers
// set in vercel.json; only /api/*, /preview/* and /sites/* reach this code.

const PUBLIC = path.join(ROOT, 'public');
const ON_VERCEL = Boolean(process.env.VERCEL);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};
if (PROD || ON_VERCEL) BASE_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

const ADMIN_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "connect-src 'self'", "frame-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
].join('; ');
// Generated sites carry their CSS inline and may be framed by the admin panel's preview.
const SITE_CSP = [
  "default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data: https:",
  "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'"
].join('; ');

function sendFile(req, res, root, rel, csp) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || rel.split('/').some((p) => p.startsWith('.'))) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Content-Security-Policy': csp
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end('Not found');
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

// Creates the first admin from ADMIN_USER / ADMIN_PASSWORD when there is none yet.
async function seedAdmin() {
  if ((await db.get('SELECT COUNT(*) AS n FROM admins')).n) return;
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (user && pass && pass.length >= 10) {
    await db.run('INSERT INTO admins (username, pass_hash) VALUES (?, ?) ON CONFLICT (username) DO NOTHING', user, await hashSecret(pass));
    console.log(`Admin "${user}" created from ADMIN_USER / ADMIN_PASSWORD.`);
  } else {
    console.log('No admin account yet. Create one with:  npm run create-admin -- <username>');
  }
}

let prepared = null;
const prepare = () => (prepared ||= db.ready().then(seedAdmin).catch((e) => { prepared = null; throw e; }));

async function app(req, res) {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  // Vercel sets x-forwarded-for to the real client address; elsewhere trust it only when told to.
  const proxied = TRUST_PROXY || ON_VERCEL;
  const proto = proxied ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const secure = PROD || ON_VERCEL || proto === 'https';
  const ip = (proxied && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return notFound(res); }

  try {
    await prepare();
    if (await handle(req, res, url, { ip, secure })) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' });
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return notFound(res); }

    // /preview/<slug>/... = sample with a banner; /sites/<slug>/... = the published version.
    const m = p.match(/^\/(preview|sites)\/([a-z0-9-]+)(\/.*)?$/);
    if (m) {
      if (!m[3]) return redirect(res, `/${m[1]}/${m[2]}/`);
      const r = await siteResponse(m[1], m[2], m[3].slice(1));
      if (!r) return notFound(res);
      res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': r.cache, 'Content-Security-Policy': SITE_CSP });
      return res.end(req.method === 'HEAD' ? undefined : r.body);
    }

    // Clients land on the portal; the admin panel stays at /admin/.
    if (p === '/' || p === '/portal') return redirect(res, '/portal/');
    if (p === '/admin') return redirect(res, '/admin/');
    // /assets/ holds what both apps share: fonts, base styles, icons.
    for (const dir of ['admin', 'portal', 'assets']) {
      if (p.startsWith(`/${dir}/`)) {
        res.setHeader('X-Frame-Options', 'DENY');
        return sendFile(req, res, PUBLIC, p === `/${dir}/` ? `${dir}/index.html` : p.slice(1), ADMIN_CSP);
      }
    }
    notFound(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server', message: 'Something went wrong on the server.' });
    else res.end();
  }
}

module.exports = { app, prepare, ADMIN_CSP, SITE_CSP, BASE_HEADERS };
