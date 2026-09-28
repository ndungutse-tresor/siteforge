'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PORT, PROD, TRUST_PROXY } = require('./src/core/config');
const { db } = require('./src/core/db');
const { hashSecret } = require('./src/core/auth');
const { handle } = require('./src/api');
const { sendJson } = require('./src/core/http');
const { OUT } = require('./src/generation/build');
const { startWorker } = require('./src/jobs/worker');
const { restoreFiles } = require('./src/hosting/publish');

const PUBLIC = path.join(__dirname, 'public');

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
if (PROD) BASE_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

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
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  const proto = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const secure = PROD || proto === 'https';
  const ip = TRUST_PROXY
    ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return notFound(res); }

  try {
    if (await handle(req, res, url, { ip, secure })) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' });
    const p = decodeURIComponent(url.pathname);

    // Clients land on the portal; the admin panel stays at /admin/.
    if (p === '/' || p === '/portal') return redirect(res, '/portal/');
    if (p === '/admin') return redirect(res, '/admin/');
    // /assets/ holds what both apps share: fonts, base styles, icons.
    for (const app of ['admin', 'portal', 'assets']) {
      if (p.startsWith(`/${app}/`)) {
        res.setHeader('X-Frame-Options', 'DENY');
        return sendFile(req, res, PUBLIC, p === `/${app}/` ? `${app}/index.html` : p.slice(1), ADMIN_CSP);
      }
    }

    // /preview/<slug>/... = banner version; /sites/<slug>/... = published version (local hosting)
    const m = p.match(/^\/(preview|sites)\/([a-z0-9-]+)(\/.*)?$/);
    if (m) {
      if (!m[3]) return redirect(res, `/${m[1]}/${m[2]}/`);
      const kind = m[1] === 'preview' ? 'previews' : 'sites';
      if (!fs.existsSync(path.join(OUT, kind, m[2]))) {
        try { restoreFiles(kind, m[2]); } catch (e) { console.error(`Could not rebuild ${kind}/${m[2]}: ${e.message}`); }
      }
      const rel = m[3].endsWith('/') ? m[3] + 'index.html' : m[3];
      return sendFile(req, res, path.join(OUT, kind, m[2]), rel.slice(1), SITE_CSP);
    }
    notFound(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server' });
  }
});

async function seedAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n) return;
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (user && pass && pass.length >= 10) {
    db.prepare('INSERT INTO admins(username, pass_hash) VALUES(?, ?)').run(user, await hashSecret(pass));
    console.log(`Admin "${user}" created from ADMIN_USER / ADMIN_PASSWORD.`);
  } else {
    console.log('No admin account yet. Create one with:  npm run create-admin -- <username>');
  }
}

seedAdmin().then(() => {
  startWorker();
  server.listen(PORT, () => console.log(`SiteForge admin: http://localhost:${PORT}/admin/`));
});
