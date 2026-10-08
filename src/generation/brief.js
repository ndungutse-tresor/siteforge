'use strict';
const { db } = require('../core/db');
const { sectorInfo } = require('../prospecting/sectors');
const { LANGS } = require('./schema');
const { getResearch, usableEmails } = require('../research/collect');

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n|;/))
  .map((s) => String(s).trim()).filter(Boolean);

function whatsappDigits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('07') && d.length === 10) d = '250' + d.slice(1);
  return d.length >= 11 ? d : '';
}

// First draft of a brief from collected info (research/collect.js), used until a site is generated.
async function briefFromResearch(prospect) {
  const r = (await getResearch(prospect.id))?.found;
  if (!r) return {};
  const out = {};
  const facts = [r.description || r.about?.[0], ...(r.facts || [])].filter(Boolean);
  if (facts.length) out.facts = facts;
  if (r.services?.length) out.services = r.services.slice(0, 6);
  if (r.hours?.length) out.hours = r.hours;
  if (r.address) out.address = r.address;
  if (r.phones?.[0] && !prospect.contact_phone) out.phone = r.phones[0];
  if (r.emails?.[0]) out.email = r.emails[0];
  return out;
}

// The brief is everything the model and the template may use. Nothing else gets on the site.
// Starts from the prospect and collected info, then the last brief used for it, then the admin's edits.
async function buildBrief(prospect, overrides = {}) {
  const last = await db.get('SELECT brief FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC LIMIT 1', prospect.id);
  const prev = last ? JSON.parse(last.brief) : await briefFromResearch(prospect);
  const o = { ...prev, ...overrides };
  const languages = list(o.languages || ['rw', 'en']).filter((l) => LANGS[l]);
  const phone = o.phone ?? prospect.contact_phone ?? '';
  // Never put an address from an expired domain on the site: mail to it bounces.
  const defaultEmail = usableEmails(prospect.contact_email ? [prospect.contact_email] : [], prospect)[0] || '';
  return {
    business_name: String(o.business_name || prospect.name).trim(),
    sector: o.sector || prospect.sector,
    sector_label: sectorInfo(o.sector || prospect.sector).label,
    template: o.template || sectorInfo(o.sector || prospect.sector).template,
    services: list(o.services),
    facts: list(o.facts),
    district: o.district ?? prospect.district ?? '',
    area: o.area ?? prospect.sector_admin ?? '',
    address: o.address || '',
    hours: list(o.hours),
    phone,
    whatsapp: whatsappDigits(o.whatsapp || phone),
    email: o.email ?? defaultEmail,
    photos: list(o.photos),
    languages: languages.length ? languages : ['rw', 'en'],
    tone: o.tone || 'warm, professional, plain',
    map_query: o.map_query || `${o.business_name || prospect.name}, ${o.district ?? prospect.district ?? ''}, Kigali`
  };
}

module.exports = { buildBrief, briefFromResearch, whatsappDigits };
