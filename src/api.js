'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, STAGES } = require('./core/db');
const { HttpError, sendJson, readJson } = require('./core/http');
const { verifySecret, burnTime, hashSecret, signToken, verifyToken, parseCookies, cookie, Limiter } = require('./core/auth');
const { SECTORS } = require('./prospecting/sectors');
const { importProspects } = require('./prospecting/importer');
const { fetchOsm } = require('./prospecting/osm');
const { parseRdbCsv } = require('./prospecting/rdb');
const places = require('./prospecting/places');
const { auditProspect } = require('./scoring/auditor');
const queue = require('./jobs/queue');
const { generateSite, saveEditedContent } = require('./generation/generate');
const { buildBrief } = require('./generation/brief');
const { THEMES } = require('./generation/templates/themes');
const { photoDir, PHOTO_RE } = require('./generation/build');
const ai = require('./generation/ai');
const publish = require('./hosting/publish');
const billing = require('./hosting/billing');
const vercel = require('./hosting/vercel');
const outreach = require('./outreach/outreach');
const purge = require('./compliance/purge');
const { exportProspect, eraseProspect } = require('./compliance/export');
const { collectForProspect, getResearch } = require('./research/collect');
const { problemReport } = require('./outreach/problems');
const { classify, KIND_SQL } = require('./research/opportunity');
const accounts = require('./portal/accounts');
const portalServices = require('./portal/services');
const orders = require('./portal/orders');
const { BRAND_NAME, MOMO_PAY_NUMBER, MOMO_PAY_NAME, MOMO_MERCHANT_CODE, MOMO_MERCHANT_NAME, ADVANCE_PERCENT } = require('./core/config');
const { merchantUssd, ussdTelUri, qrSvg } = require('./portal/qr');

const ADMIN_COOKIE = 'sf_a';
const ADMIN_HOURS = 12;
const loginByIp = new Limiter(5, 15 * 60 * 1000);
const CLIENT_COOKIE = 'sf_c';
const CLIENT_DAYS = 14;
const clientLoginByIp = new Limiter(20, 15 * 60 * 1000);
const clientLoginById = new Limiter(5, 15 * 60 * 1000);
const signupByIp = new Limiter(10, 60 * 60 * 1000);
const SENT = Symbol('response already sent');

// ---------- routing ----------
const routes = [];
// open: no login needed. client: a client-portal login is needed. Otherwise: an admin login.
function route(method, pattern, handler, { open = false, client = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, open, client });
}

function requireClient(ctx) {
  const p = verifyToken(ctx.cookies[CLIENT_COOKIE]);
  const u = p && p.role === 'client' ? accounts.getUser(p.uid) : null;
  if (!u || u.token_version !== p.v) throw new HttpError(401, 'login_required', 'Please log in.');
  return u;
}

function requireAdmin(ctx) {
  const p = verifyToken(ctx.cookies[ADMIN_COOKIE]);
  const a = p && p.role === 'admin' ? db.prepare('SELECT * FROM admins WHERE id = ?').get(p.aid) : null;
  if (!a || a.token_version !== p.v) throw new HttpError(401, 'login_required', 'Please log in.');
  return a;
}

async function handle(req, res, url, { ip, secure }) {
  if (!url.pathname.startsWith('/api/')) return false;
  const ctx = { req, res, url, ip, secure, params: {}, cookies: parseCookies(req.headers.cookie), setCookies: [] };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpError(403, 'forbidden', 'Forbidden.');
    }
    let match = null, allowed = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      allowed = true;
      if (r.method !== req.method) continue;
      match = r;
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
    if (!match) throw allowed ? new HttpError(405, 'method', 'Method not allowed.') : new HttpError(404, 'not_found', 'Not found.');
    if (match.client) ctx.client = requireClient(ctx);
    else if (!match.open) ctx.admin = requireAdmin(ctx);
    const out = await match.handler(ctx);
    if (out === SENT) return true;
    sendJson(res, 200, out === undefined ? { ok: true } : out, ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : undefined);
  } catch (e) {
    if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, message: e.message });
    else if (e.status) sendJson(res, e.status, { error: 'failed', message: e.message });
    else {
      console.error(e);
      sendJson(res, 500, { error: 'server', message: e.message || 'Something went wrong.' });
    }
  }
  return true;
}

const id = (ctx, k = 'id') => {
  const n = Number(ctx.params[k]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_id', 'Bad id.');
  return n;
};

function prospectOr404(pid) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(pid);
  if (!p) throw new HttpError(404, 'not_found', 'Prospect not found.');
  return p;
}

const parseJson = (s) => (s ? JSON.parse(s) : null);

// ---------- auth ----------
route('POST', '/api/login', async (ctx) => {
  const b = await readJson(ctx.req);
  if (loginByIp.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Too many attempts. Wait 15 minutes.');
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(b.username || '').trim());
  const ok = a ? await verifySecret(String(b.password || ''), a.pass_hash) : await burnTime(String(b.password || ''));
  if (!ok) {
    loginByIp.hit(ctx.ip);
    throw new HttpError(401, 'bad_login', 'Wrong username or password.');
  }
  loginByIp.clear(ctx.ip);
  const token = signToken({ role: 'admin', aid: a.id, v: a.token_version, exp: Date.now() + ADMIN_HOURS * 3600e3 });
  ctx.setCookies.push(cookie(ADMIN_COOKIE, token, { maxAgeSec: ADMIN_HOURS * 3600, path: '/api', secure: ctx.secure }));
  return { username: a.username };
}, { open: true });

route('POST', '/api/logout', async (ctx) => {
  await readJson(ctx.req);
  ctx.setCookies.push(cookie(ADMIN_COOKIE, '', { maxAgeSec: 0, path: '/api', secure: ctx.secure }));
}, { open: true });

route('GET', '/api/me', (ctx) => {
  try { ctx.admin = requireAdmin(ctx); } catch (e) { return { username: null }; }
  return meFor(ctx);
}, { open: true });

const meFor = (ctx) => ({
  username: ctx.admin.username,
  features: { places: places.enabled(), ai: ai.enabled(), ai_model: ai.MODEL, vercel: vercel.enabled() },
  sectors: Object.fromEntries(Object.entries(SECTORS).map(([k, v]) => [k, v.label])),
  templates: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label])),
  stages: STAGES
});

route('POST', '/api/password', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!(await verifySecret(String(b.current || ''), ctx.admin.pass_hash))) throw new HttpError(400, 'bad_password', 'Current password is wrong.');
  if (String(b.next || '').length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');
  db.prepare('UPDATE admins SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await hashSecret(String(b.next)), ctx.admin.id);
  ctx.setCookies.push(cookie(ADMIN_COOKIE, '', { maxAgeSec: 0, path: '/api', secure: ctx.secure }));
});

// ---------- dashboard ----------
route('GET', '/api/stats', () => {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage').all()) byStage[r.stage] = r.n;
  const one = (sql) => db.prepare(sql).get();
  return {
    byStage,
    total: one('SELECT COUNT(*) AS n FROM prospects').n,
    unaudited: one("SELECT COUNT(*) AS n FROM prospects WHERE score IS NULL AND do_not_contact = 0").n,
    clients: one("SELECT COUNT(*) AS n, COALESCE(SUM(monthly_fee), 0) AS mrr FROM clients WHERE status IN ('active', 'overdue')"),
    overdue: one("SELECT COUNT(*) AS n FROM clients WHERE status IN ('overdue', 'suspended')").n,
    revenueMonth: one("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE paid_at >= date('now', 'start of month')").n,
    jobs: queue.counts()
  };
});

// ---------- prospects ----------
const SORTS = { score: 'score IS NULL, score DESC', name: 'name COLLATE NOCASE', updated: 'updated_at DESC', created: 'created_at DESC' };

route('GET', '/api/prospects', (ctx) => {
  const q = ctx.url.searchParams;
  const where = [], vals = [];
  if (q.get('stage')) { where.push('stage = ?'); vals.push(q.get('stage')); }
  if (q.get('sector')) { where.push('sector = ?'); vals.push(q.get('sector')); }
  if (q.get('district')) { where.push('district = ?'); vals.push(q.get('district')); }
  if (q.get('q')) { where.push('(name LIKE ? OR notes LIKE ?)'); vals.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  if (q.get('hide_dnc') === '1') where.push('do_not_contact = 0');
  const sql = `SELECT id, name, sector, district, website_url, website_status, score, stage, do_not_contact, contact_phone, updated_at
    FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[q.get('sort')] || SORTS.score}
    LIMIT ? OFFSET ?`;
  const limit = Math.min(500, Number(q.get('limit')) || 200);
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  return {
    rows: db.prepare(sql).all(...vals, limit, offset),
    total: db.prepare(`SELECT COUNT(*) AS n FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...vals).n,
    districts: db.prepare('SELECT DISTINCT district FROM prospects WHERE district IS NOT NULL ORDER BY district').all().map((r) => r.district)
  };
});

const EDITABLE = ['name', 'sector', 'district', 'sector_admin', 'website_url', 'contact_phone', 'contact_email', 'contact_source', 'notes', 'stage'];

function cleanFields(b) {
  const out = {};
  for (const k of EDITABLE) {
    if (b[k] === undefined) continue;
    const v = b[k] === null ? null : String(b[k]).trim().slice(0, k === 'notes' ? 5000 : 300);
    if (k === 'stage' && !STAGES.includes(v)) throw new HttpError(400, 'bad_stage', 'Unknown stage.');
    if (k === 'sector' && !SECTORS[v]) throw new HttpError(400, 'bad_sector', 'Unknown sector.');
    if (k === 'name' && !v) throw new HttpError(400, 'name_required', 'Name is required.');
    out[k] = v === '' ? null : v;
  }
  if (out.notes === null) out.notes = '';
  return out;
}

route('POST', '/api/prospects', async (ctx) => {
  const f = cleanFields(await readJson(ctx.req));
  if (!f.name) throw new HttpError(400, 'name_required', 'Name is required.');
  const r = importProspects([{ ...f, contact_source: f.contact_source || 'manual' }]);
  const row = db.prepare('SELECT id FROM prospects WHERE name = ? ORDER BY id DESC LIMIT 1').get(f.name);
  return { ...r, id: row?.id };
});

route('GET', '/api/prospects/:id', (ctx) => {
  const p = prospectOr404(id(ctx));
  p.score_breakdown = parseJson(p.score_breakdown);
  const sites = db.prepare(`SELECT id, slug, version, template_key, content_source, preview_url, deploy_id, generated_at, approved_by_admin, approved_at
    FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC`).all(p.id);
  const latest = db.prepare('SELECT brief, content FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC LIMIT 1').get(p.id);
  const dir = photoDir(p.id);
  return {
    prospect: p,
    audits: db.prepare('SELECT * FROM audits WHERE prospect_id = ? ORDER BY checked_at DESC LIMIT 10').all(p.id)
      .map((a) => ({ ...a, signals: parseJson(a.signals) })),
    sites,
    brief: latest ? parseJson(latest.brief) : buildBrief(p),
    content: latest ? parseJson(latest.content) : null,
    research: getResearch(p.id),
    photos: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PHOTO_RE.test(f)) : [],
    outreach: db.prepare('SELECT * FROM outreach_log WHERE prospect_id = ? ORDER BY sent_at DESC').all(p.id),
    client: db.prepare('SELECT * FROM clients WHERE prospect_id = ?').get(p.id) || null
  };
});

route('PATCH', '/api/prospects/:id', async (ctx) => {
  const p = prospectOr404(id(ctx));
  const f = cleanFields(await readJson(ctx.req));
  const keys = Object.keys(f);
  if (!keys.length) return p;
  db.prepare(`UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => f[k]), p.id);
  return prospectOr404(p.id);
});

// ---------- Google Places (live only) ----------
route('GET', '/api/prospects/:id/places', async (ctx) => {
  const p = prospectOr404(id(ctx));
  if (!places.enabled()) throw new HttpError(400, 'no_key', 'Set GOOGLE_PLACES_API_KEY to use Google lookups.');
  if (p.place_id) return { details: await places.placeDetails(p.place_id) };
  return { candidates: await places.findCandidates(p.name, p.district) };
});

route('POST', '/api/prospects/:id/places', async (ctx) => {
  const p = prospectOr404(id(ctx));
  const b = await readJson(ctx.req);
  if (!b.place_id) {
    db.prepare("UPDATE prospects SET place_id = NULL, updated_at = datetime('now') WHERE id = ?").run(p.id);
    return { linked: null };
  }
  const details = await places.placeDetails(String(b.place_id));
  places.linkPlace(p.id, details.place_id, details.location);
  return { linked: details.place_id, details };
});

// ---------- audit ----------
route('POST', '/api/prospects/:id/audit', async (ctx) => {
  await readJson(ctx.req);
  return auditProspect(prospectOr404(id(ctx)).id);
});

route('POST', '/api/audit-queue', async (ctx) => {
  const b = await readJson(ctx.req);
  const limit = Math.min(1000, Number(b.limit) || 100);
  const rows = db.prepare(`SELECT id FROM prospects WHERE do_not_contact = 0 AND (score IS NULL OR ? = 1)
    AND id NOT IN (SELECT json_extract(payload, '$.prospect_id') FROM jobs WHERE kind = 'audit' AND status IN ('queued', 'running'))
    ORDER BY id LIMIT ?`).all(b.reaudit ? 1 : 0, limit);
  for (const r of rows) queue.enqueue('audit', { prospect_id: r.id });
  return { queued: rows.length };
});

// ---------- opportunities & collected info ----------
// Filters shared by the list, the CSV export and "collect for all of these".
function opportunityFilter(q) {
  const kind = KIND_SQL[q.get('kind')] ? q.get('kind') : 'new';
  const where = [KIND_SQL[kind], 'p.do_not_contact = 0', "p.stage NOT IN ('won', 'lost')"], vals = [];
  if (q.get('sector')) { where.push('p.sector = ?'); vals.push(q.get('sector')); }
  if (q.get('district')) { where.push('p.district = ?'); vals.push(q.get('district')); }
  if (q.get('has_phone') === '1') where.push("(p.contact_phone IS NOT NULL OR json_array_length(r.data, '$.found.phones') > 0)");
  if (q.get('collected') === '1') where.push('r.prospect_id IS NOT NULL');
  if (q.get('collected') === '0') where.push('r.prospect_id IS NULL');
  return { kind, sql: `FROM prospects p LEFT JOIN research r ON r.prospect_id = p.id WHERE ${where.join(' AND ')}`, vals };
}

function opportunityRows(q, limit, offset) {
  const f = opportunityFilter(q);
  return db.prepare(`SELECT p.id, p.name, p.sector, p.district, p.website_url, p.website_status, p.score, p.score_breakdown,
      p.stage, p.contact_phone, p.contact_email, r.collected_at, r.data AS research
    ${f.sql} ORDER BY p.score DESC, p.name LIMIT ? OFFSET ?`).all(...f.vals, limit, offset).map((row) => {
    const research = parseJson(row.research);
    const { kind, reasons } = classify(row);
    return { ...row, score_breakdown: undefined, research: undefined, kind, reasons,
      completeness: research?.completeness || null, found: research?.found || null };
  });
}

route('GET', '/api/opportunities', (ctx) => {
  const q = ctx.url.searchParams;
  const f = opportunityFilter(q);
  const count = (kind) => db.prepare(`SELECT COUNT(*) AS n FROM prospects p WHERE ${KIND_SQL[kind]} AND p.do_not_contact = 0 AND p.stage NOT IN ('won', 'lost')`).get().n;
  const limit = Math.min(500, Number(q.get('limit')) || 200);
  return {
    kind: f.kind,
    counts: { new: count('new'), update: count('update'), check: count('check') },
    total: db.prepare(`SELECT COUNT(*) AS n ${f.sql}`).get(...f.vals).n,
    rows: opportunityRows(q, limit, Math.max(0, Number(q.get('offset')) || 0)).map(({ found, ...r }) => ({
      ...r, phone: r.contact_phone || found?.phones?.[0] || null
    })),
    districts: db.prepare('SELECT DISTINCT district FROM prospects WHERE district IS NOT NULL ORDER BY district').all().map((r) => r.district),
    queued: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'research' AND status IN ('queued', 'running')").get().n
  };
});

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // stop spreadsheet formula injection
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

route('GET', '/api/opportunities.csv', (ctx) => {
  const q = ctx.url.searchParams;
  const rows = opportunityRows(q, 5000, 0);
  const cols = ['id', 'name', 'sector', 'district', 'score', 'kind', 'reasons', 'website_url', 'website_status', 'phone', 'email',
    'address', 'hours', 'description', 'services', 'facts', 'facebook', 'instagram', 'info_percent', 'collected_at'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    const f = r.found || {};
    const v = { ...r, phone: r.contact_phone || f.phones?.[0], email: f.emails?.[0] || r.contact_email, address: f.address, hours: f.hours,
      description: f.description || f.about?.[0], services: f.services, facts: f.facts, facebook: f.socials?.facebook,
      instagram: f.socials?.instagram, info_percent: r.completeness?.percent };
    lines.push(cols.map((c) => csvCell(v[c])).join(','));
  }
  const kind = KIND_SQL[q.get('kind')] ? q.get('kind') : 'new';
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="siteforge-${kind}-${new Date().toISOString().slice(0, 10)}.csv"` });
  ctx.res.end('﻿' + lines.join('\r\n')); // BOM so Excel reads Kinyarwanda / French accents correctly
  return SENT;
});

route('POST', '/api/prospects/:id/research', async (ctx) => {
  await readJson(ctx.req);
  return collectForProspect(prospectOr404(id(ctx)).id);
});

route('POST', '/api/research-queue', async (ctx) => {
  const b = await readJson(ctx.req);
  const q = new URLSearchParams(Object.entries(b).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  const f = opportunityFilter(q);
  const rows = db.prepare(`SELECT p.id ${f.sql}
    AND p.id NOT IN (SELECT json_extract(payload, '$.prospect_id') FROM jobs WHERE kind = 'research' AND status IN ('queued', 'running'))
    ORDER BY p.score DESC LIMIT ?`).all(...f.vals, Math.min(1000, Number(b.limit) || 100));
  for (const r of rows) queue.enqueue('research', { prospect_id: r.id });
  return { queued: rows.length };
});

// ---------- photos ----------
route('POST', '/api/prospects/:id/photos', async (ctx) => {
  const p = prospectOr404(id(ctx));
  const b = await readJson(ctx.req, 8 * 1024 * 1024);
  const m = String(b.data || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) throw new HttpError(400, 'bad_image', 'Send a JPEG, PNG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Keep photos under 5 MB.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const base = String(b.name || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  const dir = photoDir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.${ext}`, n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name };
});

route('DELETE', '/api/prospects/:id/photos/:name', (ctx) => {
  const p = prospectOr404(id(ctx));
  const name = ctx.params.name;
  if (!PHOTO_RE.test(name)) throw new HttpError(400, 'bad_name', 'Bad file name.');
  fs.rmSync(path.join(photoDir(p.id), name), { force: true });
});

route('GET', '/api/prospects/:id/photos/:name', (ctx) => {
  const p = prospectOr404(id(ctx));
  const name = ctx.params.name;
  if (!PHOTO_RE.test(name)) throw new HttpError(400, 'bad_name', 'Bad file name.');
  const file = path.join(photoDir(p.id), name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'not_found', 'Not found.');
  const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=300' });
  ctx.res.end(fs.readFileSync(file));
  return SENT;
});

// ---------- generation ----------
route('POST', '/api/prospects/:id/generate', async (ctx) => {
  const b = await readJson(ctx.req);
  const p = prospectOr404(id(ctx));
  if (b.content) return saveEditedContent(p.id, b.content, b.brief || {});
  return generateSite(p.id, b.brief || {});
});

route('POST', '/api/sites/:id/approve', async (ctx) => {
  await readJson(ctx.req);
  return publish.approveSite(id(ctx), ctx.admin.username);
});

route('POST', '/api/sites/:id/deploy', async (ctx) => {
  await readJson(ctx.req);
  return publish.deploySite(id(ctx));
});

// ---------- outreach ----------
route('GET', '/api/prospects/:id/message', (ctx) => {
  const lang = ctx.url.searchParams.get('lang') === 'en' ? 'en' : 'rw';
  const pid = id(ctx);
  const msg = outreach.composeMessage(pid, { lang });
  let whatsapp = null;
  try { whatsapp = outreach.whatsappLink(pid, { lang }).url; } catch (e) { /* no usable number */ }
  return { ...msg, whatsapp };
});

route('GET', '/api/prospects/:id/problems', (ctx) => problemReport(prospectOr404(id(ctx)).id));

route('POST', '/api/prospects/:id/outreach', async (ctx) => outreach.logOutreach(id(ctx), await readJson(ctx.req)));

route('POST', '/api/prospects/:id/opt-out', async (ctx) => {
  const b = await readJson(ctx.req);
  return outreach.optOut(id(ctx), b.note);
});

// ---------- clients & billing ----------
route('POST', '/api/prospects/:id/client', async (ctx) => billing.createClient(id(ctx), await readJson(ctx.req)));

route('GET', '/api/clients', () => ({
  rows: db.prepare(`SELECT c.*, (SELECT MAX(paid_at) FROM payments WHERE client_id = c.id) AS last_paid,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE client_id = c.id) AS total_paid
    FROM clients c ORDER BY c.status = 'active', c.next_invoice_at`).all()
}));

route('GET', '/api/clients/:id/payments', (ctx) => ({
  rows: db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY paid_at DESC').all(id(ctx))
}));

route('POST', '/api/clients/:id/payments', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!(Number(b.amount) > 0)) throw new HttpError(400, 'bad_amount', 'Enter the amount paid.');
  try {
    return await billing.recordPayment(id(ctx), b);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'duplicate_txid', 'That MoMo transaction ID is already recorded.');
    throw e;
  }
});

route('PATCH', '/api/clients/:id', async (ctx) => {
  const b = await readJson(ctx.req);
  const cid = id(ctx);
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(cid);
  if (!c) throw new HttpError(404, 'not_found', 'Client not found.');
  if (b.domain !== undefined && b.domain !== c.domain) await billing.setDomain(cid, b.domain);
  const sets = [], vals = [];
  for (const k of ['contact_name', 'phone', 'monthly_fee', 'setup_fee', 'plan', 'status']) {
    if (b[k] === undefined) continue;
    if (k === 'plan' && !['monthly', 'annual'].includes(b[k])) throw new HttpError(400, 'bad_plan', 'Bad plan.');
    if (k === 'status' && !['active', 'cancelled'].includes(b[k])) throw new HttpError(400, 'bad_status', 'Status can be set to active or cancelled.');
    sets.push(`${k} = ?`);
    vals.push(k.endsWith('_fee') ? Number(b[k]) || 0 : b[k]);
  }
  if (sets.length) db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cid);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(cid);
});

route('POST', '/api/renewals/check', async (ctx) => {
  await readJson(ctx.req);
  return billing.checkRenewals();
});

// ---------- import ----------
route('POST', '/api/import', async (ctx) => {
  const b = await readJson(ctx.req, 20 * 1024 * 1024);
  let records;
  if (b.source === 'osm') records = await fetchOsm();
  else if (b.source === 'csv') records = parseRdbCsv(String(b.csv || ''));
  else throw new HttpError(400, 'bad_source', 'Choose OSM or CSV.');
  return { found: records.length, ...importProspects(records) };
});

// ---------- compliance ----------
route('GET', '/api/compliance', () => ({
  ...purge.status(),
  dnc: db.prepare(`SELECT p.id, p.name, p.district, MAX(o.opt_out_at) AS opt_out_at FROM prospects p
    LEFT JOIN outreach_log o ON o.prospect_id = p.id WHERE p.do_not_contact = 1 GROUP BY p.id ORDER BY opt_out_at DESC`).all()
}));

route('POST', '/api/compliance/purge', async (ctx) => {
  await readJson(ctx.req);
  return purge.purgeGoogleCoords();
});

route('GET', '/api/prospects/:id/export', (ctx) => exportProspect(id(ctx)));

route('POST', '/api/prospects/:id/erase', async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.confirm !== 'ERASE') throw new HttpError(400, 'confirm', 'Type ERASE to confirm.');
  return eraseProspect(id(ctx));
});

// ---------- client portal: accounts ----------
// Clients have their own cookie (path /api/portal) and token role; an admin token never opens
// these routes and a client token never opens admin routes.
function setClientCookie(ctx, u) {
  const token = signToken({ role: 'client', uid: u.id, v: u.token_version, exp: Date.now() + CLIENT_DAYS * 86400e3 });
  ctx.setCookies.push(cookie(CLIENT_COOKIE, token, { maxAgeSec: CLIENT_DAYS * 86400, path: '/api/portal', secure: ctx.secure }));
}

// How clients pay: a MoMo Pay merchant code (dial or scan the QR) and/or a MoMo number to send to.
const portalConfig = () => ({
  brand: BRAND_NAME,
  advance_percent: ADVANCE_PERCENT,
  momo: MOMO_PAY_NUMBER || MOMO_MERCHANT_CODE ? {
    number: MOMO_PAY_NUMBER || null,
    name: MOMO_PAY_NAME || BRAND_NAME,
    merchant: MOMO_MERCHANT_CODE ? {
      code: MOMO_MERCHANT_CODE, name: MOMO_MERCHANT_NAME || MOMO_PAY_NAME || BRAND_NAME,
      ussd: merchantUssd(MOMO_MERCHANT_CODE), tel: ussdTelUri(merchantUssd(MOMO_MERCHANT_CODE)), qr: '/api/portal/momo-qr.svg'
    } : null
  } : null
});

// Scanning it with a phone camera opens the dialer with the MoMo Pay code typed in.
route('GET', '/api/portal/momo-qr.svg', (ctx) => {
  if (!MOMO_MERCHANT_CODE) throw new HttpError(404, 'not_found', 'No merchant code set.');
  ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  ctx.res.end(qrSvg(ussdTelUri(merchantUssd(MOMO_MERCHANT_CODE))));
  return SENT;
}, { open: true });

route('GET', '/api/portal/services', () => ({ ...portalConfig(), services: portalServices.listActive() }), { open: true });

route('POST', '/api/portal/signup', async (ctx) => {
  const b = await readJson(ctx.req);
  if (signupByIp.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Too many new accounts from this connection. Try again later.');
  signupByIp.hit(ctx.ip);
  const u = await accounts.createAccount(b);
  setClientCookie(ctx, u);
  return { user: accounts.publicUser(u) };
}, { open: true });

route('POST', '/api/portal/login', async (ctx) => {
  const b = await readJson(ctx.req);
  const who = String(b.identifier || '').trim().toLowerCase();
  if (clientLoginByIp.blocked(ctx.ip) || clientLoginById.blocked(who)) {
    throw new HttpError(429, 'too_many', 'Too many attempts. Wait 15 minutes and try again.');
  }
  const u = await accounts.verifyLogin(b.identifier, b.password);
  if (!u) {
    clientLoginByIp.hit(ctx.ip);
    clientLoginById.hit(who);
    throw new HttpError(401, 'bad_login', 'Wrong phone number, email or password.');
  }
  clientLoginByIp.clear(ctx.ip);
  clientLoginById.clear(who);
  setClientCookie(ctx, u);
  return { user: accounts.publicUser(u) };
}, { open: true });

route('POST', '/api/portal/logout', async (ctx) => {
  await readJson(ctx.req);
  ctx.setCookies.push(cookie(CLIENT_COOKIE, '', { maxAgeSec: 0, path: '/api/portal', secure: ctx.secure }));
}, { open: true });

route('GET', '/api/portal/me', (ctx) => {
  try { ctx.client = requireClient(ctx); } catch (e) { return { user: null, ...portalConfig() }; }
  return { user: accounts.publicUser(ctx.client), ...portalConfig() };
}, { open: true });

route('POST', '/api/portal/lang', async (ctx) => {
  const b = await readJson(ctx.req);
  return { user: accounts.publicUser(accounts.setLang(ctx.client.id, b.lang)) };
}, { client: true });

route('POST', '/api/portal/password', async (ctx) => {
  const b = await readJson(ctx.req);
  const u = await accounts.changePassword(ctx.client.id, b.current, b.next);
  setClientCookie(ctx, u); // keep this device logged in; others are logged out
}, { client: true });

// ---------- client portal: orders ----------
route('GET', '/api/portal/orders', (ctx) => ({ rows: orders.listForClient(ctx.client.id) }), { client: true });

route('GET', '/api/portal/overview', (ctx) => orders.overviewForClient(ctx.client.id), { client: true });

route('POST', '/api/portal/orders', async (ctx) => {
  const o = orders.createOrder(ctx.client.id, await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, o.id);
}, { client: true });

route('GET', '/api/portal/orders/:id', (ctx) => orders.getForClient(ctx.client.id, id(ctx)), { client: true });

route('POST', '/api/portal/orders/:id/payments', async (ctx) => {
  orders.submitPayment(ctx.client.id, id(ctx), await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

route('POST', '/api/portal/orders/:id/messages', async (ctx) => {
  orders.clientMessage(ctx.client.id, id(ctx), await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

route('POST', '/api/portal/orders/:id/cancel', async (ctx) => {
  const b = await readJson(ctx.req);
  orders.cancelOrder('client', id(ctx), { userId: ctx.client.id, reason: b.reason });
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

// ---------- client portal: admin side ----------
route('GET', '/api/orders', (ctx) => {
  const summary = orders.adminSummary();
  if (ctx.url.searchParams.get('summary') === '1') return { summary }; // for the badge in the top bar
  return { summary, rows: orders.listForAdmin({ status: ctx.url.searchParams.get('status') || '' }), momo_configured: Boolean(MOMO_PAY_NUMBER || MOMO_MERCHANT_CODE), payment: portalConfig().momo };
});

route('GET', '/api/orders/:id', (ctx) => orders.getForAdmin(id(ctx)));

route('POST', '/api/orders/:id/updates', async (ctx) => {
  orders.postUpdate(ctx.admin.username, id(ctx), await readJson(ctx.req));
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/orders/:id/finish', async (ctx) => {
  orders.markFinished(ctx.admin.username, id(ctx), await readJson(ctx.req));
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/orders/:id/cancel', async (ctx) => {
  const b = await readJson(ctx.req);
  orders.cancelOrder('admin', id(ctx), { reason: b.reason });
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/order-payments/:id/review', async (ctx) => {
  const b = await readJson(ctx.req);
  const o = orders.reviewPayment(ctx.admin.username, id(ctx), { approve: b.approve === true, note: b.note });
  return orders.getForAdmin(o.id);
});

route('GET', '/api/services', () => ({ rows: portalServices.listAll(), advance_percent: ADVANCE_PERCENT }));

route('POST', '/api/services', async (ctx) => portalServices.saveService(null, await readJson(ctx.req)));

route('PATCH', '/api/services/:id', async (ctx) => portalServices.saveService(id(ctx), await readJson(ctx.req)));

route('GET', '/api/accounts', () => ({ rows: accounts.listAccounts() }));

route('POST', '/api/accounts/:id/reset-password', async (ctx) => {
  await readJson(ctx.req);
  return accounts.resetPassword(id(ctx));
});

route('GET', '/api/accounts/:id/export', (ctx) => accounts.exportAccount(id(ctx)));

route('POST', '/api/accounts/:id/erase', async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.confirm !== 'DELETE') throw new HttpError(400, 'confirm', 'Type DELETE to confirm.');
  return accounts.eraseAccount(id(ctx));
});

module.exports = { handle };
