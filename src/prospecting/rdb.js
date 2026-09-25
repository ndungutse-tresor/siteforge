'use strict';
const { sectorFromText } = require('./sectors');

// Reads a CSV export of the RDB business register (or any list you typed up yourself).
// Column names are matched loosely so small differences in the export don't matter.
const COLUMNS = {
  rdb_number: /^(tin|company.?code|reg(istration)?.?(no|number|code)|rdb.?(no|number))$/i,
  name: /^(name|company.?name|business.?name|enterprise.?name)$/i,
  activity: /^(activity|activities|business.?activity|sector|category|isic)$/i,
  district: /^district$/i,
  sector_admin: /^(sector|umurenge)$/i,
  contact_phone: /^(phone|telephone|tel|mobile|contact.?phone)$/i,
  contact_email: /^(email|e-mail|contact.?email)$/i,
  website_url: /^(website|web|url|site)$/i
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

function parseRdbCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) return [];
  const map = {};
  header.forEach((h, i) => {
    const name = h.trim();
    for (const [key, re] of Object.entries(COLUMNS)) {
      if (re.test(name) && map[key] === undefined) map[key] = i;
    }
  });
  // "Sector" is ambiguous in Rwanda (admin sector vs business sector); if only one
  // "sector" column exists and no district-level data, treat it as business activity.
  if (map.name === undefined) throw new Error('CSV needs a "name" column.');
  const get = (r, k) => (map[k] === undefined ? null : (r[map[k]] || '').trim() || null);
  return rows.map((r) => {
    const name = get(r, 'name');
    const activity = get(r, 'activity');
    return {
      rdb_number: get(r, 'rdb_number'),
      name,
      sector: sectorFromText(`${activity || ''} ${name || ''}`),
      district: get(r, 'district'),
      sector_admin: map.sector_admin !== map.activity ? get(r, 'sector_admin') : null,
      website_url: get(r, 'website_url'),
      contact_phone: get(r, 'contact_phone'),
      contact_email: get(r, 'contact_email'),
      contact_source: 'rdb'
    };
  }).filter((p) => p.name);
}

module.exports = { parseCsv, parseRdbCsv };
