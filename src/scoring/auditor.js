'use strict';
const dns = require('node:dns').promises;
const { Resolver } = dns;
const { db, tx } = require('../core/db');
const { resolveWebsite } = require('../prospecting/places');
const S = require('./signals');
const { score } = require('./score');
const { robotsAllows, UA } = require('./robots');

// Some small Rwandan hosts take 10+ s to answer; 20 s avoids calling a slow site dead.
const PAGE_TIMEOUT_MS = 20000;
const MAX_BODY = 1.5 * 1024 * 1024;
const SLOW_MS = 3000;
const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|SSL/i;
const MAX_PAGE_REDIRECTS = 2;
// Firewalls (Cloudflare, Imunify360, mod_security) answer bots with these. The site exists,
// we just can't look at it, so they are not scored as broken.
const BOT_BLOCK_STATUSES = new Set([401, 403, 406, 409, 429]);
// Answers from a resolver that mean the name really does not work for visitors.
const DNS_DEAD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ENONAME']);

// A check that failed on our side (network blip). The prospect stays unscored and is retried.
class TransientAuditError extends Error {}

function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const url = new URL(s);
    // "name@gmail.com" typed into the website field parses as user "name" on gmail.com.
    if (url.username || url.password || !url.hostname.includes('.')) return null;
    return url;
  } catch (e) { return null; }
}

function errCode(e) {
  if (e?.name === 'TimeoutError') return 'timeout'; // DOMException code 23 is meaningless to a reader
  const code = e?.cause?.code || e?.code || e?.name || 'error';
  return code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connect-timeout' : String(code);
}

const isTimeout = (code) => /timeout/i.test(code);

// Resolves the host the way a visitor's browser would. Returns { host } for the host that works,
// { dead: code } when the name is broken, or throws TransientAuditError when we can't tell.
async function checkDns(hostname) {
  const hosts = [hostname];
  if (hostname.startsWith('www.')) hosts.push(hostname.slice(4));
  let firstCode = null;
  for (const host of hosts) {
    try {
      await dns.lookup(host);
      return { host };
    } catch (e) {
      firstCode ??= errCode(e);
      if (DNS_DEAD_CODES.has(errCode(e))) continue;
      // EAI_AGAIN etc: the local resolver gave up. Ask public resolvers before deciding.
      const r = new Resolver({ timeout: 5000, tries: 2 });
      r.setServers(['1.1.1.1', '8.8.8.8']);
      try {
        await r.resolve4(host);
        return { host };
      } catch (e2) {
        if (!DNS_DEAD_CODES.has(errCode(e2))) throw new TransientAuditError(`DNS lookup failed (${errCode(e2)}), retry later`);
        if (host === hostname) firstCode = errCode(e2); // the public resolver's answer is the telling one
      }
    }
  }
  return { dead: firstCode };
}

async function readLimited(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_BODY) { reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function get(url, timeout = PAGE_TIMEOUT_MS) {
  const start = Date.now();
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
    signal: AbortSignal.timeout(timeout)
  });
  const ttfb = Date.now() - start;
  const body = await readLimited(res);
  return { status: res.status, finalUrl: res.url, ttfb, body };
}

async function robotsFor(origin) {
  try {
    const r = await get(origin + '/robots.txt', 5000);
    return r.status < 400 ? r.body : '';
  } catch (e) {
    return '';
  }
}

// Inspects one website. Pure network + parsing, no database. Returns audit fields + signals.
// `name` (optional) lets us notice a domain that now belongs to someone else.
async function inspect(rawUrl, { name } = {}) {
  const signals = {};
  const out = { signals, http_status: null, final_url: null, has_https: null, is_mobile_friendly: null,
    load_ms: null, last_copyright_year: null, cms_detected: null, has_ssl_error: 0, is_parked: 0, notes: [] };

  if (!rawUrl) { signals.no_website = true; out.website_status = 'none'; return out; }
  const url = normalizeUrl(rawUrl);
  if (!url) { signals.no_website = true; out.website_status = 'invalid-url'; out.notes.push(`Unusable URL: ${rawUrl}`); return out; }
  if (S.isSocialUrl(url.href)) {
    signals.facebook_only = true;
    out.final_url = url.href;
    out.website_status = 'social-only';
    return out;
  }

  const resolved = await checkDns(url.hostname);
  if (resolved.dead) {
    signals.dns_dead = true;
    out.website_status = 'dns-dead';
    out.notes.push(`DNS: ${resolved.dead}`);
    return out;
  }
  if (resolved.host !== url.hostname) {
    out.notes.push(`${url.hostname} does not resolve; checked ${resolved.host} instead.`);
    url.hostname = resolved.host;
  }

  // Try HTTPS first; fall back to HTTP if TLS is broken or the port is closed.
  let page = null;
  const httpsUrl = new URL(url.href); httpsUrl.protocol = 'https:';
  const httpUrl = new URL(url.href); httpUrl.protocol = 'http:';

  const allowed = robotsAllows(await robotsFor(httpsUrl.origin), httpsUrl.pathname);
  if (!allowed) {
    signals.robots_blocked = true;
    out.notes.push('robots.txt disallows the home page; only DNS/TLS were checked.');
  }

  const tryFetch = async (u) => (allowed ? get(u.href) : get(u.origin + '/robots.txt', 5000));
  try {
    page = await tryFetch(httpsUrl);
  } catch (e) {
    const code = errCode(e);
    if (CERT_ERRORS.test(code) || CERT_ERRORS.test(String(e.cause?.message || ''))) {
      out.has_ssl_error = 1;
      out.notes.push(`TLS: ${code}`);
    } else {
      out.notes.push(`HTTPS: ${code}`);
    }
    try {
      page = await tryFetch(httpUrl);
    } catch (e2) {
      const code2 = errCode(e2);
      signals.http_error = true;
      out.notes.push(`HTTP: ${code2}`);
      if (out.has_ssl_error || CERT_ERRORS.test(code2)) {
        // Typically HTTP redirects to HTTPS and the certificate is bad: visitors get a browser warning.
        out.has_ssl_error = 1;
        signals.no_https = true;
        out.website_status = 'ssl-error';
      } else {
        out.website_status = isTimeout(code2) ? 'timeout' : 'unreachable';
        if (isTimeout(code2)) out.notes.push('Some firewalls stall automated checks; open it in a browser to confirm.');
      }
      return out;
    }
  }

  out.final_url = page.finalUrl;
  out.has_https = page.finalUrl.startsWith('https:') && !out.has_ssl_error ? 1 : 0;
  if (!out.has_https) signals.no_https = true;
  out.load_ms = page.ttfb;
  if (page.ttfb > SLOW_MS) signals.slow = true;

  if (!allowed) { out.website_status = 'robots-blocked'; return out; }

  out.http_status = page.status;
  if (BOT_BLOCK_STATUSES.has(page.status)) {
    out.website_status = 'blocked';
    out.notes.push(`Answered ${page.status}: a firewall is probably refusing automated checks. Open it in a browser.`);
    return out;
  }
  if (page.status >= 400) {
    signals.http_error = true;
    out.website_status = `http-${page.status}`;
    return out;
  }

  // Follow <meta refresh> / window.location forwarding pages to the real site.
  for (let hop = 0; hop < MAX_PAGE_REDIRECTS && !S.isParked(page.body); hop++) {
    const target = S.pageRedirect(page.body);
    if (!target) break;
    let next;
    try { next = new URL(target, page.finalUrl); } catch (e) { break; }
    if (!/^https?:$/.test(next.protocol) || next.href === page.finalUrl) break;
    if (next.origin !== new URL(page.finalUrl).origin &&
        !robotsAllows(await robotsFor(next.origin), next.pathname)) break;
    try {
      const nextPage = await get(next.href);
      if (nextPage.status >= 400) break;
      out.notes.push(`Forwards to ${nextPage.finalUrl}`);
      page = nextPage;
      out.final_url = page.finalUrl;
    } catch (e) {
      break;
    }
  }

  const html = page.body;
  if (S.isParked(html) || html.replace(/<[^>]+>/g, '').trim().length < 200) {
    signals.parked = true;
    out.is_parked = 1;
    out.website_status = 'parked';
    return out;
  }

  if (name && S.looksTakenOver(html, name)) {
    signals.taken_over = true;
    out.website_status = 'taken-over';
    out.notes.push(`The page never mentions "${name}" and looks like spam: the domain was probably lost and bought by someone else.`);
    return out;
  }
  if (name && !S.mentionsName(html, name)) out.notes.push(`The page does not mention "${name}". Check it is really their site.`);

  out.is_mobile_friendly = S.isMobileFriendly(html) ? 1 : 0;
  if (!out.is_mobile_friendly) signals.not_mobile = true;
  out.last_copyright_year = S.lastCopyrightYear(html);
  if (out.last_copyright_year && out.last_copyright_year <= new Date().getFullYear() - 3) signals.old_copyright = true;
  const old = S.obsoleteTech(html);
  if (old.length) { signals.obsolete_tech = true; out.notes.push(`Obsolete: ${old.join(', ')}`); }
  if (!S.hasContactInfo(html)) signals.no_contact = true;
  out.cms_detected = S.detectCms(html);
  out.website_status = 'live';
  return out;
}

// Audits a prospect and saves the result. Only our own derived data is stored.
// Throws TransientAuditError when the result would be unreliable; nothing is saved then.
async function auditProspect(prospectId) {
  const p = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!p) throw new Error(`Prospect ${prospectId} not found`);
  const site = await resolveWebsite(p);
  const r = await inspect(site.url, { name: p.name });
  const s = score(r.signals, p.sector);
  const signals = { ...r.signals, website_source: site.source, notes: r.notes, raw: s.raw, wtp: s.wtp };

  await tx(async () => {
    await db.run(`INSERT INTO audits (prospect_id, http_status, final_url, has_https, is_mobile_friendly, load_ms,
        last_copyright_year, cms_detected, has_ssl_error, is_parked, signals, score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, r.http_status, r.final_url, r.has_https,
    r.is_mobile_friendly, r.load_ms, r.last_copyright_year, r.cms_detected, r.has_ssl_error, r.is_parked,
    JSON.stringify(signals), s.score);
    await db.run(`UPDATE prospects SET website_status = ?, score = ?, score_breakdown = ?,
        stage = CASE WHEN stage = 'discovered' THEN 'audited' ELSE stage END, updated_at = now()
      WHERE id = ?`, r.website_status, s.score, JSON.stringify(s), p.id);
  });
  return { prospect_id: p.id, website_status: r.website_status, ...s, notes: r.notes };
}

// Runs many audits with a concurrency cap so we don't hammer anyone.
async function auditMany(ids, { concurrency = 4, onDone } = {}) {
  const queue = [...ids];
  const results = [];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const r = await auditProspect(id);
        results.push(r);
        onDone?.(null, r);
      } catch (e) {
        results.push({ prospect_id: id, error: e.message });
        onDone?.(e, { prospect_id: id });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

module.exports = { inspect, auditProspect, auditMany, normalizeUrl, TransientAuditError };
