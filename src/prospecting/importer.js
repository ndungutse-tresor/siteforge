'use strict';
const { db, tx } = require('../core/db');

const FIELDS = ['name', 'sector', 'district', 'sector_admin', 'website_url', 'contact_phone', 'contact_email', 'contact_source'];

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ltd|limited|sarl|co|company|the|rwanda)\b/g, '').replace(/\s+/g, ' ').trim();
}

// Sources sometimes put an email address in the website field.
function moveEmailOutOfWebsite(r) {
  const m = String(r.website_url || '').trim().replace(/^(https?:\/\/|mailto:)/i, '').match(/^([^\s/@]+@[^\s/@]+\.[a-z]{2,})\/?$/i);
  if (!m) return;
  r.contact_email ||= m[1].toLowerCase();
  r.website_url = null;
}

// Upserts records from any source. Matches by source id first, then by name + district,
// so the same business from RDB and OSM ends up as one prospect.
// Everything is read once and written in batches: over the network to Supabase, one query
// per business would take minutes for a Kigali-sized import.
const COLS = ['osm_id', 'rdb_number', 'name', 'sector', 'district', 'sector_admin', 'website_url',
  'contact_phone', 'contact_email', 'contact_source', 'lat', 'lng', 'coords_source', 'coords_fetched_at'];
const BATCH = 300;

async function importProspects(records) {
  let added = 0, merged = 0, skipped = 0;
  const existing = await db.all(`SELECT id, ${FIELDS.join(', ')}, osm_id, rdb_number, lat FROM prospects`);
  const byOsm = new Map(), byRdb = new Map(), byPlace = new Map();
  const placeKey = (district, name) => `${district || ''}|${normName(name)}`;
  const remember = (p) => {
    if (p.osm_id) byOsm.set(p.osm_id, p);
    if (p.rdb_number) byRdb.set(p.rdb_number, p);
    const k = placeKey(p.district, p.name);
    if (!byPlace.has(k)) byPlace.set(k, p);
  };
  existing.forEach(remember);

  const inserts = [];            // new prospects, in import order
  const updates = new Map();     // existing id -> { field: value }
  const tags = new Map();        // prospect (row or pending insert) -> OSM tags

  for (const r of records) {
    if (!r.name) { skipped++; continue; }
    moveEmailOutOfWebsite(r);
    const match = (r.osm_id && byOsm.get(r.osm_id)) || (r.rdb_number && byRdb.get(r.rdb_number)) || byPlace.get(placeKey(r.district, r.name)) || null;

    if (match) {
      // Fill gaps only; never overwrite what an admin has already set.
      const set = match.id ? (updates.get(match.id) || {}) : match;
      let changed = false;
      for (const f of [...FIELDS, 'osm_id', 'rdb_number']) {
        if (r[f] && !match[f]) { set[f] = r[f]; match[f] = r[f]; changed = true; }
      }
      if (r.lat != null && match.lat == null) {
        Object.assign(set, { lat: r.lat, lng: r.lng, coords_source: r.contact_source || 'import', coords_fetched_at: new Date().toISOString() });
        match.lat = r.lat;
        changed = true;
      }
      if (match.id && changed) updates.set(match.id, set);
      if (match.osm_id && byOsm.get(match.osm_id) !== match) byOsm.set(match.osm_id, match);
      // Keep OSM tags fresh; they are source data, not admin edits.
      if (r.osm_tags && (!match.osm_id || match.osm_id === r.osm_id)) tags.set(match, r.osm_tags);
      if (changed) merged++; else skipped++;
      continue;
    }

    const row = {
      osm_id: r.osm_id || null, rdb_number: r.rdb_number || null, name: r.name, sector: r.sector || 'generic',
      district: r.district || null, sector_admin: r.sector_admin || null, website_url: r.website_url || null,
      contact_phone: r.contact_phone || null, contact_email: r.contact_email || null, contact_source: r.contact_source || 'manual',
      lat: r.lat ?? null, lng: r.lng ?? null,
      coords_source: r.lat != null ? (r.contact_source || 'import') : null,
      coords_fetched_at: r.lat != null ? new Date().toISOString() : null
    };
    inserts.push(row);
    remember(row);
    if (r.osm_tags) tags.set(row, r.osm_tags);
    added++;
  }

  await tx(async () => {
    for (let i = 0; i < inserts.length; i += BATCH) {
      const chunk = inserts.slice(i, i + BATCH);
      const values = chunk.map(() => `(${COLS.map(() => '?').join(', ')})`).join(', ');
      const ids = await db.all(`INSERT INTO prospects (${COLS.join(', ')}) VALUES ${values} RETURNING id`,
        ...chunk.flatMap((row) => COLS.map((c) => row[c])));
      chunk.forEach((row, k) => { row.id = ids[k].id; }); // RETURNING keeps VALUES order
    }
    for (const [id, set] of updates) {
      const keys = Object.keys(set).filter((k) => k !== 'id');
      if (!keys.length) continue;
      await db.run(`UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`,
        ...keys.map((k) => set[k]), id);
    }
    const tagRows = [...tags].filter(([p]) => p.id);
    for (let i = 0; i < tagRows.length; i += BATCH) {
      const chunk = tagRows.slice(i, i + BATCH);
      await db.run(`INSERT INTO osm_tags (prospect_id, tags) VALUES ${chunk.map(() => '(?, ?)').join(', ')}
        ON CONFLICT (prospect_id) DO UPDATE SET tags = excluded.tags, fetched_at = now()`,
      ...chunk.flatMap(([p, t]) => [p.id, JSON.stringify(t)]));
    }
  });
  return { added, merged, skipped };
}

module.exports = { importProspects, normName, moveEmailOutOfWebsite };
