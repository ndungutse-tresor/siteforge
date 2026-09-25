'use strict';
const { db } = require('../core/db');

// Google Maps Platform terms: lat/lng from Google may be cached for at most 30 days.
// Coordinates from OSM or our own visits are not affected.
function purgeGoogleCoords(days = 30) {
  const r = db.prepare(`UPDATE prospects SET lat = NULL, lng = NULL, coords_fetched_at = NULL, coords_source = NULL
    WHERE coords_source = 'google' AND coords_fetched_at < datetime('now', ?)`).run(`-${Number(days)} days`);
  return { cleared: Number(r.changes) };
}

function status() {
  const q = (sql) => db.prepare(sql).get().n;
  return {
    google_coords: q("SELECT COUNT(*) AS n FROM prospects WHERE coords_source = 'google'"),
    google_coords_expiring_7d: q("SELECT COUNT(*) AS n FROM prospects WHERE coords_source = 'google' AND coords_fetched_at < datetime('now', '-23 days')"),
    do_not_contact: q('SELECT COUNT(*) AS n FROM prospects WHERE do_not_contact = 1'),
    with_personal_contact: q("SELECT COUNT(*) AS n FROM prospects WHERE contact_phone IS NOT NULL OR contact_email IS NOT NULL")
  };
}

module.exports = { purgeGoogleCoords, status };
