'use strict';
const { db, tx } = require('../core/db');
const photos = require('../storage/photos');

// Everything held about one prospect, for a data-subject request under Law Nº 058/2021.
async function exportProspect(prospectId) {
  const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  const parse = (rows, ...keys) => rows.map((r) => {
    for (const k of keys) if (r[k]) r[k] = JSON.parse(r[k]);
    return r;
  });
  const client = await db.get('SELECT * FROM clients WHERE prospect_id = ?', prospect.id);
  return {
    exported_at: new Date().toISOString(),
    prospect: parse([prospect], 'score_breakdown')[0],
    audits: parse(await db.all('SELECT * FROM audits WHERE prospect_id = ? ORDER BY checked_at', prospect.id), 'signals'),
    research: parse(await db.all('SELECT * FROM research WHERE prospect_id = ?', prospect.id), 'data')[0] || null,
    osm_tags: parse(await db.all('SELECT * FROM osm_tags WHERE prospect_id = ?', prospect.id), 'tags')[0] || null,
    generated_sites: parse(await db.all('SELECT * FROM generated_sites WHERE prospect_id = ? ORDER BY version', prospect.id), 'brief', 'content'),
    ai_analyses: parse(await db.all('SELECT * FROM prospect_ai_analyses WHERE prospect_id = ? ORDER BY created_at, id', prospect.id), 'findings', 'report'),
    photos: await db.all('SELECT name, content_type, size, created_at FROM photos WHERE prospect_id = ? ORDER BY name', prospect.id),
    outreach: await db.all('SELECT * FROM outreach_log WHERE prospect_id = ? ORDER BY sent_at', prospect.id),
    client: client || null,
    payments: client ? await db.all('SELECT * FROM payments WHERE client_id = ? ORDER BY paid_at', client.id) : []
  };
}

// Erase a prospect who asked to be forgotten. Keeps a stub so they are never re-imported
// and contacted again. Paying clients must be cancelled first (invoices are kept by law).
async function eraseProspect(prospectId) {
  const p = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!p) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  if (await db.get('SELECT 1 FROM clients WHERE prospect_id = ?', p.id)) {
    throw Object.assign(new Error('This is a client. Cancel the client record before erasing.'), { status: 409 });
  }
  await photos.deleteAll(p.id);
  await tx(async () => {
    for (const t of ['audits', 'research', 'osm_tags', 'generated_sites', 'prospect_ai_analyses', 'outreach_log', 'photos']) {
      await db.run(`DELETE FROM ${t} WHERE prospect_id = ?`, p.id);
    }
    await db.run(`UPDATE prospects SET contact_phone = NULL, contact_email = NULL, contact_source = NULL, lat = NULL, lng = NULL,
      coords_fetched_at = NULL, coords_source = NULL, website_url = NULL, notes = 'Erased on request', score = NULL,
      score_breakdown = NULL, do_not_contact = 1, stage = 'lost', updated_at = now() WHERE id = ?`, p.id);
  });
  return { erased: p.id };
}

module.exports = { exportProspect, eraseProspect };
