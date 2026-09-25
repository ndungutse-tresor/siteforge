'use strict';
const { db, tx } = require('../core/db');

// Everything held about one prospect, for a data-subject request under Law Nº 058/2021.
function exportProspect(prospectId) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  const parse = (rows, ...keys) => rows.map((r) => {
    for (const k of keys) if (r[k]) r[k] = JSON.parse(r[k]);
    return r;
  });
  const client = db.prepare('SELECT * FROM clients WHERE prospect_id = ?').get(prospect.id) || null;
  return {
    exported_at: new Date().toISOString(),
    prospect: parse([prospect], 'score_breakdown')[0],
    audits: parse(db.prepare('SELECT * FROM audits WHERE prospect_id = ? ORDER BY checked_at').all(prospect.id), 'signals'),
    research: parse(db.prepare('SELECT * FROM research WHERE prospect_id = ?').all(prospect.id), 'data')[0] || null,
    osm_tags: parse(db.prepare('SELECT * FROM osm_tags WHERE prospect_id = ?').all(prospect.id), 'tags')[0] || null,
    generated_sites: parse(db.prepare('SELECT * FROM generated_sites WHERE prospect_id = ? ORDER BY version').all(prospect.id), 'brief', 'content'),
    outreach: db.prepare('SELECT * FROM outreach_log WHERE prospect_id = ? ORDER BY sent_at').all(prospect.id),
    client,
    payments: client ? db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY paid_at').all(client.id) : []
  };
}

// Erase a prospect who asked to be forgotten. Keeps a stub so they are never re-imported
// and contacted again. Paying clients must be cancelled first (invoices are kept by law).
function eraseProspect(prospectId) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  if (db.prepare('SELECT 1 FROM clients WHERE prospect_id = ?').get(p.id)) {
    throw Object.assign(new Error('This is a client. Cancel the client record before erasing.'), { status: 409 });
  }
  tx(() => {
    for (const t of ['audits', 'research', 'osm_tags', 'generated_sites', 'outreach_log']) db.prepare(`DELETE FROM ${t} WHERE prospect_id = ?`).run(p.id);
    db.prepare(`UPDATE prospects SET contact_phone = NULL, contact_email = NULL, contact_source = NULL, lat = NULL, lng = NULL,
      coords_fetched_at = NULL, coords_source = NULL, website_url = NULL, notes = 'Erased on request', score = NULL,
      score_breakdown = NULL, do_not_contact = 1, stage = 'lost', updated_at = datetime('now') WHERE id = ?`).run(p.id);
  });
  return { erased: p.id };
}

module.exports = { exportProspect, eraseProspect };
