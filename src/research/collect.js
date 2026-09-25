'use strict';
const { db } = require('../core/db');
const { robotsAllows, UA } = require('../scoring/robots');
const { normalizeUrl } = require('../scoring/auditor');
const { mentionsName, nameTokens } = require('../scoring/signals');

// Collects what we need to build a business its site, from sources we may store:
// its OpenStreetMap entry (ODbL) and its own website. Never from Google (see places.js).

const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const TIMEOUT_MS = 20000;
const MAX_BODY = 1024 * 1024;
const MAX_EXTRA_PAGES = 2;
const EXTRA_PAGE_RE = /about|services?|what-we-do|menu|rooms?|contact|abo-turi-bo|serivisi|ibyerekeye|a-propos|nous-contacter/i;

// ---------- small helpers ----------
const uniq = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

const text = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function withoutBoilerplate(html) {
  return String(html).replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

// Rwandan numbers: +250 7xx xxx xxx, 07xx xxx xxx, and landlines +250 25x / 0252.
function findPhones(str) {
  const out = [];
  for (const m of String(str).matchAll(/(?:\+?250[\s.-]?|\b0)(7[2389]\d|25\d)[\s.-]?\d{3}[\s.-]?\d{3}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    const local = digits.startsWith('250') ? digits.slice(3) : digits.slice(1);
    if (local.length === 9) out.push(`+250 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`);
  }
  return uniq(out);
}

const JUNK_EMAIL = /example\.|sentry|wixpress|@2x|\.(png|jpe?g|gif|webp|svg)$|domain\.com|yourdomain|email\.com/i;
function findEmails(str) {
  const found = String(str).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq(found.map((e) => e.toLowerCase()).filter((e) => !JUNK_EMAIL.test(e)));
}

const SOCIAL = { facebook: /facebook\.com|fb\.com/i, instagram: /instagram\.com/i, whatsapp: /wa\.me|api\.whatsapp\.com/i,
  tiktok: /tiktok\.com/i, x: /(?:^|\/\/)(?:www\.)?(?:twitter|x)\.com/i, youtube: /youtube\.com/i, linkedin: /linkedin\.com/i, tripadvisor: /tripadvisor\./i };
function findSocials(html) {
  const out = {};
  for (const m of String(html).matchAll(/href=["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1]);
    for (const [k, re] of Object.entries(SOCIAL)) {
      if (!out[k] && re.test(href) && !/sharer|\/share\b|share\?|intent\/tweet|\/plugins\//i.test(href)) out[k] = href;
    }
  }
  return out;
}

// Kigali street addresses: KG 7 Ave, KN 3 Rd, KK 15 St ...
function findStreetAddress(str) {
  const m = String(str).match(/\b(?:\d{1,4}\s*,?\s*)?K[GNK]\s?\d{1,4}\s?(?:Ave(?:nue)?|Av|Rd|Road|St(?:reet)?)\b[^.<\n]{0,40}/i);
  return m ? m[0].replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim() : '';
}

const DAY = '(?:mon|tue|wed|thu|fri|sat|sun|lun|mar|mer|jeu|ven|sam|dim|kuwa)[a-z]*';
function findHours(str) {
  const re = new RegExp(`\\b${DAY}\\b[^.|\\n]{0,40}?\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|h)?\\s*[-–to]+\\s*\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|h)?`, 'gi');
  const out = (String(str).match(re) || []).map((s) => s.replace(/\s+/g, ' ').trim());
  if (/\b(24\/7|24 hours|open 24|24h\/24)\b/i.test(str)) out.push('Open 24 hours');
  return uniq(out).slice(0, 7);
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = String(html).match(re)?.[0];
  const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? text(c) : '';
}

// ---------- OpenStreetMap ----------
const YES = (v) => v && v !== 'no';

// OSM tags -> brief facts, written plainly so Claude (or a human) can reuse them.
function factsFromOsmTags(t) {
  const facts = [];
  if (t.stars) facts.push(`${t.stars}-star ${t.tourism === 'guest_house' ? 'guest house' : 'hotel'}`);
  if (t.rooms) facts.push(`${t.rooms} rooms`);
  if (t.beds) facts.push(`${t.beds} beds`);
  if (t.cuisine) facts.push(`Cuisine: ${t.cuisine.replace(/_/g, ' ').replace(/;/g, ', ')}`);
  if (t['healthcare:speciality']) facts.push(`Specialities: ${t['healthcare:speciality'].replace(/_/g, ' ').replace(/;/g, ', ')}`);
  if (YES(t.internet_access)) facts.push(t.internet_access === 'wlan' || t.internet_access === 'yes' ? 'Free Wi-Fi' : `Internet: ${t.internet_access}`);
  if (YES(t.delivery)) facts.push('Delivery available');
  if (YES(t.takeaway)) facts.push('Takeaway available');
  if (YES(t.outdoor_seating)) facts.push('Outdoor seating');
  if (t.wheelchair === 'yes') facts.push('Wheelchair accessible');
  if (YES(t['payment:mobile_money']) || YES(t['payment:mtn_mobile_money']) || YES(t['payment:momo'])) facts.push('Accepts MoMo');
  if (YES(t['payment:cards']) || YES(t['payment:visa'])) facts.push('Accepts cards');
  if (t.level && /^\d+$/.test(t.level)) facts.push(`Floor ${t.level}`);
  return facts;
}

// Tags saved at import (osm_tags table); the OSM API is only asked for a single business
// that was imported before tags were saved.
async function fromOsm(osmId, prospectId) {
  if (!/^(node|way|relation)\/\d+$/.test(osmId || '')) return null;
  const saved = db.prepare('SELECT tags FROM osm_tags WHERE prospect_id = ?').get(prospectId);
  return osmFound(saved ? JSON.parse(saved.tags) : await fetchOsmTags(osmId));
}

async function fetchOsmTags(osmId) {
  const res = await fetch(`${OSM_API}/${osmId}.json`, {
    headers: { 'User-Agent': 'siteforge-prospecting/0.1' }, signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (res.status === 404 || res.status === 410) throw new Error('Deleted from OpenStreetMap');
  if (!res.ok) throw new Error(`OpenStreetMap API returned ${res.status}`);
  return (await res.json()).elements?.[0]?.tags || {};
}

function osmFound(t) {
  // In Kigali addr:housenumber often repeats the street code ("KG07 Av"); only prefix real numbers.
  const num = t['addr:housenumber'] || '';
  const street = t['addr:street'] ? [/^\d+[a-z]?$/i.test(num) ? num : '', t['addr:street']].filter(Boolean).join(' ') : num;
  const socials = {};
  if (t['contact:facebook'] || t.facebook) socials.facebook = t['contact:facebook'] || t.facebook;
  if (t['contact:instagram'] || t.instagram) socials.instagram = t['contact:instagram'] || t.instagram;
  if (t['contact:whatsapp']) socials.whatsapp = t['contact:whatsapp'];
  return {
    found: {
      description: t.description || '',
      facts: factsFromOsmTags(t),
      hours: t.opening_hours ? [t.opening_hours === '24/7' ? 'Open 24 hours' : t.opening_hours] : [],
      phones: findPhones([t.phone, t['contact:phone'], t.mobile, t['contact:mobile']].filter(Boolean).join(' ')),
      emails: findEmails([t.email, t['contact:email']].filter(Boolean).join(' ')),
      address: street || findStreetAddress(t['addr:full'] || ''),
      socials
    }
  };
}

// ---------- the business's own website ----------
async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/html/i.test(res.headers.get('content-type') || 'text/html')) throw new Error('Not an HTML page');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    if ((size += value.length) > MAX_BODY) { reader.cancel().catch(() => {}); break; }
  }
  return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url };
}

// Headings that are page furniture, not something the business offers.
const NOT_A_SERVICE = /^(home|menu|contact|about|welcome|services?|our services|what we do|gallery|photos?|videos?|watch|news|blog|events?|updates?|latest|upcoming|testimonials?|reviews?|faqs?|follow|subscribe|newsletter|get in touch|quick links|useful links|categories|search|read more|learn more|why choose|principal|message|our (team|teachers|staff|clients|partners|story|history|mission|vision|students)|meet )|\b(news|updates|events|message|videos?)\b|[_]|\d{4}[-.]/i;

// Pure: one page of HTML -> what it tells us. Exported for tests.
function extractFromHtml(html, pageUrl = '', name = '') {
  const body = withoutBoilerplate(html);
  const all = text(html);
  const own = nameTokens(name);
  const headings = [...body.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)].map((m) => text(m[1]))
    .filter((s) => s.length >= 3 && s.length <= 60 && s.split(' ').length <= 6 && !NOT_A_SERVICE.test(s)
      && !own.some((w) => s.toLowerCase().includes(w)));
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => text(m[1]))
    .filter((s) => s.length >= 80 && s.length <= 700 && !/cookie|copyright|©|all rights reserved|lorem ipsum/i.test(s));
  const listItems = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => text(m[1]))
    .filter((s) => s.length >= 4 && s.length <= 60);
  const onServicesPage = /service|serivisi|what-we-do|menu|rooms?/i.test(pageUrl);
  const hrefs = [...String(html).matchAll(/href=["'](tel:|mailto:)([^"']+)["']/gi)].map((m) => decodeEntities(m[2]));
  return {
    title: text(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    description: meta(html, 'description') || meta(html, 'og:description'),
    about: uniq(paragraphs).slice(0, 3),
    services: uniq([...headings, ...(onServicesPage ? listItems : [])]).slice(0, 12),
    phones: findPhones(hrefs.join(' ') + ' ' + all), // tel: links first: the number the business chose to make tappable
    emails: findEmails(hrefs.join(' ') + ' ' + all),
    hours: findHours(all),
    address: findStreetAddress(all),
    socials: findSocials(html),
    image: meta(html, 'og:image') || ''
  };
}

// robots.txt is fetched once per site per collection (`cache`: origin -> text).
async function robotsOk(u, cache) {
  if (!cache.has(u.origin)) {
    let txt = '';
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
      if (r.ok) txt = await r.text();
    } catch (e) { /* unreachable robots.txt = allowed */ }
    cache.set(u.origin, txt);
  }
  return robotsAllows(cache.get(u.origin), u.pathname);
}

async function fromWebsite(rawUrl, name) {
  const start = normalizeUrl(rawUrl);
  if (!start) return null;
  const robots = new Map();
  if (!(await robotsOk(start, robots))) return { found: {}, note: 'robots.txt asks us not to read this site' };
  let home;
  try {
    home = await fetchPage(start.href);
  } catch (e) {
    const http = new URL(start.href); http.protocol = 'http:';
    home = await fetchPage(http.href); // throws if the site is really down
  }
  if (name && !mentionsName(home.html, name)) {
    return { found: {}, pages: [home.finalUrl], note: `Page does not mention "${name}", so nothing was taken from it` };
  }
  const pages = [{ url: home.finalUrl, ...extractFromHtml(home.html, home.finalUrl, name) }];

  // A couple of same-site pages that usually hold the useful facts.
  const origin = new URL(home.finalUrl).origin;
  const links = uniq([...home.html.matchAll(/href=["']([^"'#?]+)["']/gi)].map((m) => {
    try { return new URL(decodeEntities(m[1]), home.finalUrl).href; } catch (e) { return ''; }
  })).filter((u) => u.startsWith(origin) && u !== home.finalUrl && EXTRA_PAGE_RE.test(new URL(u).pathname) && !/\.(pdf|jpe?g|png|zip|docx?)$/i.test(u));
  for (const link of links.slice(0, MAX_EXTRA_PAGES)) {
    const u = new URL(link);
    if (!(await robotsOk(u, robots))) continue;
    try {
      const p = await fetchPage(link);
      pages.push({ url: p.finalUrl, ...extractFromHtml(p.html, p.finalUrl, name) });
    } catch (e) { /* skip pages that fail */ }
  }

  const merged = { socials: {} };
  for (const p of pages) {
    for (const k of ['about', 'services', 'phones', 'emails', 'hours']) merged[k] = uniq([...(merged[k] || []), ...p[k]]);
    for (const k of ['title', 'description', 'address', 'image']) merged[k] ||= p[k];
    merged.socials = { ...p.socials, ...merged.socials };
  }
  merged.services = merged.services.slice(0, 12);
  merged.about = merged.about.slice(0, 3);
  return { found: merged, pages: pages.map((p) => p.url) };
}

// ---------- combine and save ----------
function registrableDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  const n = /^(co|ac|gov|org|net)$/.test(parts.at(-2) || '') ? 3 : 2;
  return parts.slice(-n).join('.');
}

// An email on a domain that no longer resolves will bounce, so it must not go on a new site.
function usableEmails(emails, prospect) {
  if (prospect.website_status !== 'dns-dead' || !prospect.website_url) return emails;
  let dead;
  try { dead = registrableDomain(normalizeUrl(prospect.website_url)?.hostname); } catch (e) { return emails; }
  return emails.filter((e) => registrableDomain(e.split('@')[1]) !== dead);
}

function combine(prospect, osm, site) {
  const o = osm?.found || {}, w = site?.found || {};
  const emailsAll = uniq([...(w.emails || []), ...(o.emails || []), prospect.contact_email || '']);
  const emails = usableEmails(emailsAll, prospect);
  return {
    description: o.description || w.description || '',
    about: w.about || [],
    services: w.services || [],
    facts: o.facts || [],
    hours: uniq([...(o.hours || []), ...(w.hours || [])]).slice(0, 7),
    phones: uniq([prospect.contact_phone ? findPhones(prospect.contact_phone)[0] || prospect.contact_phone : '', ...(o.phones || []), ...(w.phones || [])]),
    emails,
    dropped_emails: emailsAll.filter((e) => !emails.includes(e)),
    address: o.address || w.address || '',
    socials: { ...(w.socials || {}), ...(o.socials || {}) },
    site_title: w.title || '',
    site_image: w.image || ''
  };
}

// What a site brief needs, and which of it we have. Drives the "info" column.
const NEEDS = ['phone', 'description', 'services', 'hours', 'address', 'email'];
function completeness(found, prospect = {}) {
  const f = found || {};
  const have = {
    phone: Boolean(f.phones?.length || prospect.contact_phone),
    description: Boolean(f.description || f.about?.length),
    services: Boolean(f.services?.length || f.facts?.length),
    hours: Boolean(f.hours?.length),
    address: Boolean(f.address),
    email: Boolean(f.emails?.length)
  };
  return { have, percent: Math.round((NEEDS.filter((k) => have[k]).length / NEEDS.length) * 100) };
}

async function collectForProspect(prospectId) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p) throw new Error(`Prospect ${prospectId} not found`);
  if (p.do_not_contact) throw new Error('This business asked not to be contacted.');
  const sources = [];
  const attempt = async (name, url, fn) => {
    if (!url) return null;
    try {
      const r = await fn(url);
      sources.push({ name, url, ok: Boolean(r), note: r?.note || null, pages: r?.pages || undefined });
      return r;
    } catch (e) {
      sources.push({ name, url, ok: false, note: e.message });
      return null;
    }
  };
  const osm = await attempt('OpenStreetMap', p.osm_id, (osmId) => fromOsm(osmId, p.id));
  // Dead, parked and social-only sites have nothing to read.
  const readable = p.website_url && !['dns-dead', 'taken-over', 'parked', 'social-only', 'invalid-url', 'robots-blocked'].includes(p.website_status);
  const site = readable ? await attempt('Website', p.website_url, (u) => fromWebsite(u, p.name)) : null;

  const found = combine(p, osm, site);
  const data = { found, sources, completeness: completeness(found, p) };
  db.prepare(`INSERT INTO research (prospect_id, collected_at, data) VALUES (?, datetime('now'), ?)
    ON CONFLICT(prospect_id) DO UPDATE SET collected_at = excluded.collected_at, data = excluded.data`).run(p.id, JSON.stringify(data));
  return { prospect_id: p.id, ...data };
}

function getResearch(prospectId) {
  const r = db.prepare('SELECT collected_at, data FROM research WHERE prospect_id = ?').get(prospectId);
  return r ? { collected_at: r.collected_at, ...JSON.parse(r.data) } : null;
}

module.exports = {
  collectForProspect, getResearch, extractFromHtml, factsFromOsmTags, findPhones, findEmails, findHours,
  findStreetAddress, combine, completeness, usableEmails, NEEDS
};
