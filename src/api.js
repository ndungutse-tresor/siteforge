'use strict';
const crypto = require('node:crypto');
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
const worker = require('./jobs/worker');
const { generateSite, saveEditedContent } = require('./generation/generate');
const { buildBrief } = require('./generation/brief');
const { THEMES } = require('./generation/templates/themes');
const photos = require('./storage/photos');
const ai = require('./generation/ai');
const publish = require('./hosting/publish');
const billing = require('./hosting/billing');
const vercel = require('./hosting/vercel');
const outreach = require('./outreach/outreach');
const purge = require('./compliance/purge');
const { exportProspect, eraseProspect } = require('./compliance/export');
const { collectForProspect, getResearch } = require('./research/collect');
const { problemReport } = require('./outreach/problems');
const aiAnalysis = require('./research/ai-analysis');
const { classify, KIND_SQL } = require('./research/opportunity');
const accounts = require('./portal/accounts');
const portalServices = require('./portal/services');
const orders = require('./portal/orders');
const { BRAND_NAME, MOMO_PAY_NUMBER, MOMO_PAY_NAME, MOMO_MERCHANT_CODE, MOMO_MERCHANT_NAME, ADVANCE_PERCENT } = require('./core/config');
const { merchantUssd, ussdTelUri, qrSvg } = require('./portal/qr');

const ADMIN_COOKIE = 'sf_a';
const ADMIN_HOURS = 12;
const loginByIp = new Limiter('admin-login-ip', 5, 15 * 60 * 1000);
const CLIENT_COOKIE = 'sf_c';
const CLIENT_DAYS = 14;
const clientLoginByIp = new Limiter('client-login-ip', 20, 15 * 60 * 1000);
const clientLoginById = new Limiter('client-login-id', 5, 15 * 60 * 1000);
const signupByIp = new Limiter('signup-ip', 10, 60 * 60 * 1000);
const SENT = Symbol('response already sent');
// Vercel refuses request bodies over 4.5 MB.
const MAX_UPLOAD = 4 * 1024 * 1024;

// ---------- routing ----------
const routes = [];
// open: no login needed. client: a client-portal login is needed. Otherwise: an admin login.
function route(method, pattern, handler, { open = false, client = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, open, client });
}

async function requireClient(ctx) {
  const p = verifyToken(ctx.cookies[CLIENT_COOKIE]);
  const u = p && p.role === 'client' ? await accounts.getUser(p.uid) : null;
  if (!u || u.token_version !== p.v) throw new HttpError(401, 'login_required', 'Please log in.');
  return u;
}

async function requireAdmin(ctx) {
  const p = verifyToken(ctx.cookies[ADMIN_COOKIE]);
  const a = p && p.role === 'admin' ? await db.get('SELECT * FROM admins WHERE id = ?', p.aid) : null;
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
    if (match.client) ctx.client = await requireClient(ctx);
    else if (!match.open) ctx.admin = await requireAdmin(ctx);
    const out = await match.handler(ctx);
    if (out === SENT) return true;
    sendJson(res, 200, out === undefined ? { ok: true } : out, ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : undefined);
  } catch (e) {
    if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, message: e.message });
    else if (e.status) sendJson(res, e.status, { error: 'failed', message: e.message });
    else {
      console.error(e);
      sendJson(res, 500, { error: 'server', message: 'Something went wrong on the server. Try again; if it keeps happening, check the server logs.' });
    }
  }
  return true;
}

const id = (ctx, k = 'id') => {
  const n = Number(ctx.params[k]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_id', 'Bad id.');
  return n;
};

async function prospectOr404(pid) {
  const p = await db.get('SELECT * FROM prospects WHERE id = ?', pid);
  if (!p) throw new HttpError(404, 'not_found', 'Prospect not found.');
  return p;
}

const parseJson = (s) => (s ? JSON.parse(s) : null);
const districts = async () => (await db.all('SELECT DISTINCT district FROM prospects WHERE district IS NOT NULL ORDER BY district')).map((r) => r.district);

// ---------- scheduled work (Supabase pg_cron calls these every minute / every day) ----------
function requireCron(ctx) {
  const secret = process.env.CRON_SECRET || '';
  const given = String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ok = secret.length >= 16 && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new HttpError(401, 'cron', 'Not allowed.');
}

route('POST', '/api/cron/work', async (ctx) => {
  requireCron(ctx);
  return worker.runFor(Number(process.env.WORK_SECONDS || 50) * 1000);
}, { open: true });

route('POST', '/api/cron/daily', async (ctx) => {
  requireCron(ctx);
  return worker.daily();
}, { open: true });

// ---------- auth ----------
route('POST', '/api/login', async (ctx) => {
  const b = await readJson(ctx.req);
  if (await loginByIp.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Too many attempts. Wait 15 minutes.');
  const a = await db.get('SELECT * FROM admins WHERE username = ?', String(b.username || '').trim());
  const ok = a ? await verifySecret(String(b.password || ''), a.pass_hash) : await burnTime(String(b.password || ''));
  if (!ok) {
    await loginByIp.hit(ctx.ip);
    throw new HttpError(401, 'bad_login', 'Wrong username or password.');
  }
  await loginByIp.clear(ctx.ip);
  const token = signToken({ role: 'admin', aid: a.id, v: a.token_version, exp: Date.now() + ADMIN_HOURS * 3600e3 });
  ctx.setCookies.push(cookie(ADMIN_COOKIE, token, { maxAgeSec: ADMIN_HOURS * 3600, path: '/api', secure: ctx.secure }));
  return { username: a.username };
}, { open: true });

route('POST', '/api/logout', async (ctx) => {
  await readJson(ctx.req);
  ctx.setCookies.push(cookie(ADMIN_COOKIE, '', { maxAgeSec: 0, path: '/api', secure: ctx.secure }));
}, { open: true });

const meFor = (ctx) => ({
  username: ctx.admin.username,
  features: { places: places.enabled(), ai: ai.enabled(), ai_model: ai.MODEL, deepseek: aiAnalysis.enabled(), deepseek_model: aiAnalysis.MODEL, vercel: vercel.enabled() },
  sectors: Object.fromEntries(Object.entries(SECTORS).map(([k, v]) => [k, v.label])),
  templates: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label])),
  stages: STAGES
});

// "Am I logged in?" answers normally either way, so the browser shows no error before login.
route('GET', '/api/me', async (ctx) => {
  try { ctx.admin = await requireAdmin(ctx); } catch (e) { return { username: null }; }
  return meFor(ctx);
}, { open: true });

route('POST', '/api/password', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!(await verifySecret(String(b.current || ''), ctx.admin.pass_hash))) throw new HttpError(400, 'bad_password', 'Current password is wrong.');
  if (String(b.next || '').length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');
  await db.run('UPDATE admins SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashSecret(String(b.next)), ctx.admin.id);
  ctx.setCookies.push(cookie(ADMIN_COOKIE, '', { maxAgeSec: 0, path: '/api', secure: ctx.secure }));
});

// ---------- dashboard ----------
route('GET', '/api/stats', async () => {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of await db.all('SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage')) byStage[r.stage] = r.n;
  const one = (sql) => db.get(sql);
  return {
    byStage,
    total: (await one('SELECT COUNT(*) AS n FROM prospects')).n,
    unaudited: (await one('SELECT COUNT(*) AS n FROM prospects WHERE score IS NULL AND do_not_contact = 0')).n,
    clients: await one("SELECT COUNT(*) AS n, COALESCE(SUM(monthly_fee), 0) AS mrr FROM clients WHERE status IN ('active', 'overdue')"),
    overdue: (await one("SELECT COUNT(*) AS n FROM clients WHERE status IN ('overdue', 'suspended')")).n,
    revenueMonth: (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE paid_at >= date_trunc('month', now())")).n,
    jobs: await queue.counts()
  };
});

// ---------- prospects ----------
const SORTS = { score: 'score DESC NULLS LAST, id', name: 'lower(name), id', updated: 'updated_at DESC, id', created: 'created_at DESC, id' };

route('GET', '/api/prospects', async (ctx) => {
  const q = ctx.url.searchParams;
  const where = [], vals = [];
  if (q.get('stage')) { where.push('stage = ?'); vals.push(q.get('stage')); }
  if (q.get('sector')) { where.push('sector = ?'); vals.push(q.get('sector')); }
  if (q.get('district')) { where.push('district = ?'); vals.push(q.get('district')); }
  if (q.get('q')) { where.push('(name ILIKE ? OR notes ILIKE ?)'); vals.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  if (q.get('hide_dnc') === '1') where.push('do_not_contact = 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(500, Number(q.get('limit')) || 200);
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  return {
    rows: await db.all(`SELECT id, name, sector, district, website_url, website_status, score, stage, do_not_contact, contact_phone, updated_at
      FROM prospects ${w} ORDER BY ${SORTS[q.get('sort')] || SORTS.score} LIMIT ? OFFSET ?`, ...vals, limit, offset),
    total: (await db.get(`SELECT COUNT(*) AS n FROM prospects ${w}`, ...vals)).n,
    districts: await districts()
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
  const r = await importProspects([{ ...f, contact_source: f.contact_source || 'manual' }]);
  const row = await db.get('SELECT id FROM prospects WHERE name = ? ORDER BY id DESC LIMIT 1', f.name);
  return { ...r, id: row?.id };
});

route('GET', '/api/prospects/:id', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  p.score_breakdown = parseJson(p.score_breakdown);
  const sites = await db.all(`SELECT id, slug, version, template_key, content_source, preview_url, deploy_id, generated_at, approved_by_admin, approved_at, published_at
    FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC`, p.id);
  const latest = await db.get('SELECT brief, content FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC LIMIT 1', p.id);
  return {
    prospect: p,
    audits: (await db.all('SELECT * FROM audits WHERE prospect_id = ? ORDER BY checked_at DESC LIMIT 10', p.id))
      .map((a) => ({ ...a, signals: parseJson(a.signals) })),
    sites,
    brief: latest ? parseJson(latest.brief) : await buildBrief(p),
    content: latest ? parseJson(latest.content) : null,
    research: await getResearch(p.id),
    photos: await photos.listPhotos(p.id),
    outreach: await db.all('SELECT * FROM outreach_log WHERE prospect_id = ? ORDER BY sent_at DESC', p.id),
    client: await db.get('SELECT * FROM clients WHERE prospect_id = ?', p.id)
  };
});

route('PATCH', '/api/prospects/:id', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  const f = cleanFields(await readJson(ctx.req));
  const keys = Object.keys(f);
  if (!keys.length) return p;
  await db.run(`UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, ...keys.map((k) => f[k]), p.id);
  return prospectOr404(p.id);
});

// ---------- Google Places (live only) ----------
route('GET', '/api/prospects/:id/places', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  if (!places.enabled()) throw new HttpError(400, 'no_key', 'Set GOOGLE_PLACES_API_KEY to use Google lookups.');
  if (p.place_id) return { details: await places.placeDetails(p.place_id) };
  return { candidates: await places.findCandidates(p.name, p.district) };
});

route('POST', '/api/prospects/:id/places', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  const b = await readJson(ctx.req);
  if (!b.place_id) {
    await db.run('UPDATE prospects SET place_id = NULL, updated_at = now() WHERE id = ?', p.id);
    return { linked: null };
  }
  const details = await places.placeDetails(String(b.place_id));
  await places.linkPlace(p.id, details.place_id, details.location);
  return { linked: details.place_id, details };
});

// ---------- audit ----------
route('POST', '/api/prospects/:id/audit', async (ctx) => {
  await readJson(ctx.req);
  return auditProspect((await prospectOr404(id(ctx))).id);
});

const notQueued = (kind) => `p.id NOT IN (SELECT (payload::jsonb->>'prospect_id')::int FROM jobs WHERE kind = '${kind}' AND status IN ('queued', 'running'))`;

route('POST', '/api/audit-queue', async (ctx) => {
  const b = await readJson(ctx.req);
  const limit = Math.min(1000, Number(b.limit) || 100);
  const rows = await db.all(`SELECT p.id FROM prospects p WHERE p.do_not_contact = 0 AND (p.score IS NULL OR ? = 1)
    AND ${notQueued('audit')} ORDER BY p.id LIMIT ?`, b.reaudit ? 1 : 0, limit);
  for (const r of rows) await queue.enqueue('audit', { prospect_id: r.id });
  return { queued: rows.length };
});

// ---------- opportunities & collected info ----------
// Filters shared by the list, the CSV export and "collect for all of these".
function opportunityFilter(q) {
  const kind = KIND_SQL[q.get('kind')] ? q.get('kind') : 'new';
  const where = [KIND_SQL[kind], 'p.do_not_contact = 0', "p.stage NOT IN ('won', 'lost')"], vals = [];
  if (q.get('sector')) { where.push('p.sector = ?'); vals.push(q.get('sector')); }
  if (q.get('district')) { where.push('p.district = ?'); vals.push(q.get('district')); }
  if (q.get('has_phone') === '1') where.push("(p.contact_phone IS NOT NULL OR COALESCE(jsonb_array_length((r.data::jsonb)->'found'->'phones'), 0) > 0)");
  if (q.get('collected') === '1') where.push('r.prospect_id IS NOT NULL');
  if (q.get('collected') === '0') where.push('r.prospect_id IS NULL');
  return { kind, sql: `FROM prospects p LEFT JOIN research r ON r.prospect_id = p.id WHERE ${where.join(' AND ')}`, vals };
}

async function opportunityRows(q, limit, offset) {
  const f = opportunityFilter(q);
  const rows = await db.all(`SELECT p.id, p.name, p.sector, p.district, p.website_url, p.website_status, p.score, p.score_breakdown,
      p.stage, p.contact_phone, p.contact_email, r.collected_at, r.data AS research
    ${f.sql} ORDER BY p.score DESC NULLS LAST, p.name LIMIT ? OFFSET ?`, ...f.vals, limit, offset);
  return rows.map((row) => {
    const research = parseJson(row.research);
    const { kind, reasons } = classify(row);
    return { ...row, score_breakdown: undefined, research: undefined, kind, reasons,
      completeness: research?.completeness || null, found: research?.found || null };
  });
}

route('GET', '/api/opportunities', async (ctx) => {
  const q = ctx.url.searchParams;
  const f = opportunityFilter(q);
  const count = async (kind) => (await db.get(`SELECT COUNT(*) AS n FROM prospects p WHERE ${KIND_SQL[kind]} AND p.do_not_contact = 0 AND p.stage NOT IN ('won', 'lost')`)).n;
  const limit = Math.min(500, Number(q.get('limit')) || 200);
  return {
    kind: f.kind,
    counts: { new: await count('new'), update: await count('update'), check: await count('check') },
    total: (await db.get(`SELECT COUNT(*) AS n ${f.sql}`, ...f.vals)).n,
    rows: (await opportunityRows(q, limit, Math.max(0, Number(q.get('offset')) || 0))).map(({ found, ...r }) => ({
      ...r, phone: r.contact_phone || found?.phones?.[0] || null
    })),
    districts: await districts(),
    queued: await queue.pending('research')
  };
});

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // stop spreadsheet formula injection
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

route('GET', '/api/opportunities.csv', async (ctx) => {
  const q = ctx.url.searchParams;
  const rows = await opportunityRows(q, 5000, 0);
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
  ctx.res.end('\uFEFF' + lines.join('\r\n')); // BOM so Excel reads Kinyarwanda / French accents correctly
  return SENT;
});

route('POST', '/api/prospects/:id/research', async (ctx) => {
  await readJson(ctx.req);
  return collectForProspect((await prospectOr404(id(ctx))).id);
});

route('POST', '/api/research-queue', async (ctx) => {
  const b = await readJson(ctx.req);
  const q = new URLSearchParams(Object.entries(b).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  const f = opportunityFilter(q);
  const rows = await db.all(`SELECT p.id ${f.sql} AND ${notQueued('research')}
    ORDER BY p.score DESC NULLS LAST LIMIT ?`, ...f.vals, Math.min(1000, Number(b.limit) || 100));
  for (const r of rows) await queue.enqueue('research', { prospect_id: r.id });
  return { queued: rows.length };
});

// ---------- photos ----------
route('POST', '/api/prospects/:id/photos', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  const b = await readJson(ctx.req, MAX_UPLOAD);
  const m = String(b.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) throw new HttpError(400, 'bad_image', 'Send a JPEG, PNG or WebP image.');
  const name = await photos.savePhoto(p.id, b.name, Buffer.from(m[2], 'base64'), m[1]);
  return { name };
});

route('DELETE', '/api/prospects/:id/photos/:name', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  await photos.deletePhoto(p.id, ctx.params.name);
});

route('GET', '/api/prospects/:id/photos/:name', async (ctx) => {
  const p = await prospectOr404(id(ctx));
  const photo = await photos.readPhoto(p.id, ctx.params.name);
  if (!photo) throw new HttpError(404, 'not_found', 'Not found.');
  ctx.res.writeHead(200, { 'Content-Type': photo.type, 'Cache-Control': 'private, max-age=300' });
  ctx.res.end(photo.buffer);
  return SENT;
});

// ---------- generation ----------
route('POST', '/api/prospects/:id/generate', async (ctx) => {
  const b = await readJson(ctx.req);
  const p = await prospectOr404(id(ctx));
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
route('GET', '/api/prospects/:id/message', async (ctx) => {
  const lang = ctx.url.searchParams.get('lang') === 'en' ? 'en' : 'rw';
  const pid = id(ctx);
  const msg = await outreach.composeMessage(pid, { lang });
  let whatsapp = null;
  try { whatsapp = (await outreach.whatsappLink(pid, { lang })).url; } catch (e) { /* no usable number */ }
  return { ...msg, whatsapp };
});

route('GET', '/api/prospects/:id/problems', async (ctx) => {
  const prospectId = (await prospectOr404(id(ctx))).id;
  return { ...await problemReport(prospectId), analysis: await aiAnalysis.latestAnalysis(prospectId) };
});

route('POST', '/api/prospects/:id/analyze', async (ctx) => {
  await readJson(ctx.req);
  return aiAnalysis.analyzeProspect((await prospectOr404(id(ctx))).id);
});

route('POST', '/api/prospects/:id/outreach', async (ctx) => outreach.logOutreach(id(ctx), await readJson(ctx.req)));

route('POST', '/api/prospects/:id/opt-out', async (ctx) => {
  const b = await readJson(ctx.req);
  return outreach.optOut(id(ctx), b.note);
});

// ---------- clients & billing ----------
route('POST', '/api/prospects/:id/client', async (ctx) => billing.createClient(id(ctx), await readJson(ctx.req)));

route('GET', '/api/clients', async () => ({
  rows: await db.all(`SELECT c.*, (SELECT MAX(paid_at) FROM payments WHERE client_id = c.id) AS last_paid,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE client_id = c.id) AS total_paid
    FROM clients c ORDER BY c.status = 'active', c.next_invoice_at`)
}));

route('GET', '/api/clients/:id/payments', async (ctx) => ({
  rows: await db.all('SELECT * FROM payments WHERE client_id = ? ORDER BY paid_at DESC', id(ctx))
}));

route('POST', '/api/clients/:id/payments', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!(Number(b.amount) > 0)) throw new HttpError(400, 'bad_amount', 'Enter the amount paid.');
  try {
    return await billing.recordPayment(id(ctx), b);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'duplicate_txid', 'That MoMo transaction ID is already recorded.');
    throw e;
  }
});

route('PATCH', '/api/clients/:id', async (ctx) => {
  const b = await readJson(ctx.req);
  const cid = id(ctx);
  const c = await db.get('SELECT * FROM clients WHERE id = ?', cid);
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
  if (sets.length) await db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, ...vals, cid);
  return db.get('SELECT * FROM clients WHERE id = ?', cid);
});

route('POST', '/api/renewals/check', async (ctx) => {
  await readJson(ctx.req);
  return billing.checkRenewals();
});

// ---------- import ----------
route('POST', '/api/import', async (ctx) => {
  const b = await readJson(ctx.req, MAX_UPLOAD);
  let records;
  if (b.source === 'osm') records = await fetchOsm();
  else if (b.source === 'csv') records = parseRdbCsv(String(b.csv || ''));
  else throw new HttpError(400, 'bad_source', 'Choose OSM or CSV.');
  return { found: records.length, ...(await importProspects(records)) };
});

// ---------- compliance ----------
route('GET', '/api/compliance', async () => ({
  ...(await purge.status()),
  dnc: await db.all(`SELECT p.id, p.name, p.district, MAX(o.opt_out_at) AS opt_out_at FROM prospects p
    LEFT JOIN outreach_log o ON o.prospect_id = p.id WHERE p.do_not_contact = 1 GROUP BY p.id ORDER BY opt_out_at DESC NULLS LAST`)
}));

route('POST', '/api/compliance/purge', async (ctx) => {
  await readJson(ctx.req);
  return purge.purgeGoogleCoords();
});

route('GET', '/api/prospects/:id/export', async (ctx) => exportProspect(id(ctx)));

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

route('GET', '/api/portal/services', async () => ({ ...portalConfig(), services: await portalServices.listActive() }), { open: true });

route('POST', '/api/portal/signup', async (ctx) => {
  const b = await readJson(ctx.req);
  if (await signupByIp.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Too many new accounts from this connection. Try again later.');
  await signupByIp.hit(ctx.ip);
  const u = await accounts.createAccount(b);
  setClientCookie(ctx, u);
  return { user: accounts.publicUser(u) };
}, { open: true });

route('POST', '/api/portal/login', async (ctx) => {
  const b = await readJson(ctx.req);
  const who = String(b.identifier || '').trim().toLowerCase();
  if (await clientLoginByIp.blocked(ctx.ip) || await clientLoginById.blocked(who)) {
    throw new HttpError(429, 'too_many', 'Too many attempts. Wait 15 minutes and try again.');
  }
  const u = await accounts.verifyLogin(b.identifier, b.password);
  if (!u) {
    await clientLoginByIp.hit(ctx.ip);
    await clientLoginById.hit(who);
    throw new HttpError(401, 'bad_login', 'Wrong phone number, email or password.');
  }
  await clientLoginByIp.clear(ctx.ip);
  await clientLoginById.clear(who);
  setClientCookie(ctx, u);
  return { user: accounts.publicUser(u) };
}, { open: true });

route('POST', '/api/portal/logout', async (ctx) => {
  await readJson(ctx.req);
  ctx.setCookies.push(cookie(CLIENT_COOKIE, '', { maxAgeSec: 0, path: '/api/portal', secure: ctx.secure }));
}, { open: true });

route('GET', '/api/portal/me', async (ctx) => {
  try { ctx.client = await requireClient(ctx); } catch (e) { return { user: null, ...portalConfig() }; }
  return { user: accounts.publicUser(ctx.client), ...portalConfig() };
}, { open: true });

route('POST', '/api/portal/lang', async (ctx) => {
  const b = await readJson(ctx.req);
  return { user: accounts.publicUser(await accounts.setLang(ctx.client.id, b.lang)) };
}, { client: true });

route('POST', '/api/portal/password', async (ctx) => {
  const b = await readJson(ctx.req);
  const u = await accounts.changePassword(ctx.client.id, b.current, b.next);
  setClientCookie(ctx, u); // keep this device logged in; others are logged out
}, { client: true });

// ---------- client portal: orders ----------
route('GET', '/api/portal/orders', async (ctx) => ({ rows: await orders.listForClient(ctx.client.id) }), { client: true });

route('GET', '/api/portal/overview', async (ctx) => orders.overviewForClient(ctx.client.id), { client: true });

route('POST', '/api/portal/orders', async (ctx) => {
  const o = await orders.createOrder(ctx.client.id, await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, o.id);
}, { client: true });

route('GET', '/api/portal/orders/:id', async (ctx) => orders.getForClient(ctx.client.id, id(ctx)), { client: true });

route('POST', '/api/portal/orders/:id/payments', async (ctx) => {
  await orders.submitPayment(ctx.client.id, id(ctx), await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

route('POST', '/api/portal/orders/:id/messages', async (ctx) => {
  await orders.clientMessage(ctx.client.id, id(ctx), await readJson(ctx.req));
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

route('POST', '/api/portal/orders/:id/cancel', async (ctx) => {
  const b = await readJson(ctx.req);
  await orders.cancelOrder('client', id(ctx), { userId: ctx.client.id, reason: b.reason });
  return orders.getForClient(ctx.client.id, id(ctx));
}, { client: true });

// ---------- client portal: admin side ----------
route('GET', '/api/orders', async (ctx) => {
  const summary = await orders.adminSummary();
  if (ctx.url.searchParams.get('summary') === '1') return { summary }; // for the badge in the top bar
  return { summary, rows: await orders.listForAdmin({ status: ctx.url.searchParams.get('status') || '' }), momo_configured: Boolean(MOMO_PAY_NUMBER || MOMO_MERCHANT_CODE), payment: portalConfig().momo };
});

route('GET', '/api/orders/:id', async (ctx) => orders.getForAdmin(id(ctx)));

route('POST', '/api/orders/:id/updates', async (ctx) => {
  await orders.postUpdate(ctx.admin.username, id(ctx), await readJson(ctx.req));
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/orders/:id/finish', async (ctx) => {
  await orders.markFinished(ctx.admin.username, id(ctx), await readJson(ctx.req));
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/orders/:id/cancel', async (ctx) => {
  const b = await readJson(ctx.req);
  await orders.cancelOrder('admin', id(ctx), { reason: b.reason });
  return orders.getForAdmin(id(ctx));
});

route('POST', '/api/order-payments/:id/review', async (ctx) => {
  const b = await readJson(ctx.req);
  const o = await orders.reviewPayment(ctx.admin.username, id(ctx), { approve: b.approve === true, note: b.note });
  return orders.getForAdmin(o.id);
});

route('GET', '/api/services', async () => ({ rows: await portalServices.listAll(), advance_percent: ADVANCE_PERCENT }));

route('POST', '/api/services', async (ctx) => portalServices.saveService(null, await readJson(ctx.req)));

route('PATCH', '/api/services/:id', async (ctx) => portalServices.saveService(id(ctx), await readJson(ctx.req)));

route('GET', '/api/accounts', async () => ({ rows: await accounts.listAccounts() }));

route('POST', '/api/accounts/:id/reset-password', async (ctx) => {
  await readJson(ctx.req);
  return accounts.resetPassword(id(ctx));
});

route('GET', '/api/accounts/:id/export', async (ctx) => accounts.exportAccount(id(ctx)));

route('POST', '/api/accounts/:id/erase', async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.confirm !== 'DELETE') throw new HttpError(400, 'confirm', 'Type DELETE to confirm.');
  return accounts.eraseAccount(id(ctx));
});

module.exports = { handle };
