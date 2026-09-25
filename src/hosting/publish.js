'use strict';
const { db } = require('../core/db');
const { BASE_URL, BRAND_NAME, OPT_OUT_CONTACT } = require('../core/config');
const { buildFiles, writeFiles } = require('../generation/build');
const { renderSuspended } = require('../generation/templates/layout');
const vercel = require('./vercel');

function getSite(siteId) {
  const s = db.prepare('SELECT * FROM generated_sites WHERE id = ?').get(siteId);
  if (!s) throw Object.assign(new Error('Site version not found'), { status: 404 });
  return s;
}

// The human gate: nothing is built for publishing until an admin approves a version.
function approveSite(siteId, adminName) {
  const s = getSite(siteId);
  db.prepare("UPDATE generated_sites SET approved_by_admin = ?, approved_at = datetime('now') WHERE id = ?").run(adminName, s.id);
  return getSite(s.id);
}

function cleanFiles(site) {
  return buildFiles({ prospectId: site.prospect_id, brief: JSON.parse(site.brief), content: JSON.parse(site.content), preview: false });
}

// Publishes an approved version: to Vercel if configured, and always to out/sites/<slug>/.
async function deploySite(siteId) {
  const site = getSite(siteId);
  if (!site.approved_by_admin) throw Object.assign(new Error('Approve this version before deploying it.'), { status: 409 });
  const files = cleanFiles(site);
  writeFiles('sites', site.slug, files);

  let deployId = null, url = `${BASE_URL}/sites/${site.slug}/`;
  if (vercel.enabled()) {
    const d = await vercel.deployStatic(site.slug, files);
    deployId = d.id;
    url = d.url;
  }
  db.prepare('UPDATE generated_sites SET deploy_id = ? WHERE id = ?').run(deployId, site.id);
  const client = db.prepare('SELECT * FROM clients WHERE prospect_id = ?').get(site.prospect_id);
  if (client && !client.domain) db.prepare('UPDATE clients SET live_url = ? WHERE id = ?').run(url, client.id);
  return { site_id: site.id, deploy_id: deployId, url, target: vercel.enabled() ? 'vercel' : 'local' };
}

// Latest version that has been deployed for a prospect.
function liveSite(prospectId) {
  return db.prepare(`SELECT * FROM generated_sites WHERE prospect_id = ? AND approved_by_admin IS NOT NULL
    ORDER BY (deploy_id IS NOT NULL) DESC, version DESC LIMIT 1`).get(prospectId);
}

async function suspendSite(client) {
  const site = liveSite(client.prospect_id);
  if (!site) return;
  const files = { 'index.html': renderSuspended({ business_name: client.business_name, brand: BRAND_NAME, contact: OPT_OUT_CONTACT }) };
  writeFiles('sites', site.slug, files);
  if (vercel.enabled()) await vercel.deployStatic(site.slug, files);
}

async function restoreSite(client) {
  const site = liveSite(client.prospect_id);
  if (site) await deploySite(site.id);
}

module.exports = { approveSite, deploySite, suspendSite, restoreSite, liveSite };
