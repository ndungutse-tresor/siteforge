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
function importProspects(records) {
  const byId = {
    osm_id: db.prepare('SELECT * FROM prospects WHERE osm_id = ?'),
    rdb_number: db.prepare('SELECT * FROM prospects WHERE rdb_number = ?')
  };
  const byDistrict = db.prepare("SELECT * FROM prospects WHERE IFNULL(district, '') = IFNULL(?, '')");
  let added = 0, merged = 0, skipped = 0;

  tx(() => {
    const cache = new Map();
    const candidates = (district) => {
      const key = district || '';
      if (!cache.has(key)) cache.set(key, byDistrict.all(district || null));
      return cache.get(key);
    };

    const saveTags = db.prepare(`INSERT INTO osm_tags (prospect_id, tags) VALUES (?, ?)
      ON CONFLICT(prospect_id) DO UPDATE SET tags = excluded.tags, fetched_at = datetime('now')`);
    for (const r of records) {
      if (!r.name) { skipped++; continue; }
      moveEmailOutOfWebsite(r);
      let existing = null;
      for (const k of ['osm_id', 'rdb_number']) if (!existing && r[k]) existing = byId[k].get(r[k]);
      if (!existing) {
        const n = normName(r.name);
        existing = candidates(r.district).find((p) => normName(p.name) === n) || null;
      }

      if (existing) {
        // Fill gaps only; never overwrite what an admin has already set.
        const sets = [], vals = [];
        for (const f of [...FIELDS, 'osm_id', 'rdb_number']) {
          if (r[f] && !existing[f]) { sets.push(`${f} = ?`); vals.push(r[f]); }
        }
        if (r.lat != null && existing.lat == null) {
          sets.push('lat = ?', 'lng = ?', 'coords_source = ?', "coords_fetched_at = datetime('now')");
          vals.push(r.lat, r.lng, r.contact_source || 'import');
        }
        // Keep OSM tags fresh; they are source data, not admin edits.
        if (r.osm_tags && (!existing.osm_id || existing.osm_id === r.osm_id)) saveTags.run(existing.id, JSON.stringify(r.osm_tags));
        if (sets.length) {
          db.prepare(`UPDATE prospects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, existing.id);
          merged++;
        } else skipped++;
        continue;
      }

      const row = db.prepare(`INSERT INTO prospects (osm_id, rdb_number, name, sector, district, sector_admin,
          website_url, contact_phone, contact_email, contact_source, lat, lng, coords_source, coords_fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
        r.osm_id || null, r.rdb_number || null, r.name, r.sector || 'generic', r.district || null,
        r.sector_admin || null, r.website_url || null, r.contact_phone || null, r.contact_email || null,
        r.contact_source || 'manual', r.lat ?? null, r.lng ?? null,
        r.lat != null ? (r.contact_source || 'import') : null, r.lat != null ? new Date().toISOString() : null);
      if (r.osm_tags) saveTags.run(row.id, JSON.stringify(r.osm_tags));
      candidates(r.district).push(row);
      added++;
    }
  });
  return { added, merged, skipped };
}

module.exports = { importProspects, normName, moveEmailOutOfWebsite };
