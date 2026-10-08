'use strict';
const { db } = require('../core/db');
const { BASE_URL, BRAND_NAME, OPT_OUT_CONTACT } = require('../core/config');
const { buildFiles, renderSitePage } = require('../generation/build');
const { renderSuspended } = require('../generation/templates/layout');
const photos = require('../storage/photos');
const vercel = require('./vercel');

async function getSite(siteId) {
  const s = await db.get('SELECT * FROM generated_sites WHERE id = ?', siteId);
  if (!s) throw Object.assign(new Error('Site version not found'), { status: 404 });
  return s;
}

// The human gate: nothing is published until an admin approves a version.
async function approveSite(siteId, adminName) {
  const s = await getSite(siteId);
  await db.run('UPDATE generated_sites SET approved_by_admin = ?, approved_at = now() WHERE id = ?', adminName, s.id);
  return getSite(s.id);
}

// Publishes an approved version: it is served at /sites/<slug>/, and also deployed to Vercel
// as the client's own project when VERCEL_TOKEN is set.
async function deploySite(siteId) {
  const site = await getSite(siteId);
  if (!site.approved_by_admin) throw Object.assign(new Error('Approve this version before deploying it.'), { status: 409 });

  let deployId = null, url = `${BASE_URL}/sites/${site.slug}/`;
  if (vercel.enabled()) {
    const files = await buildFiles({ prospectId: site.prospect_id, brief: JSON.parse(site.brief), content: JSON.parse(site.content), preview: false });
    const d = await vercel.deployStatic(site.slug, files);
    deployId = d.id;
    url = d.url;
  }
  await db.run('UPDATE generated_sites SET deploy_id = ?, published_at = now() WHERE id = ?', deployId, site.id);
  const client = await db.get('SELECT * FROM clients WHERE prospect_id = ?', site.prospect_id);
  if (client && !client.domain) await db.run('UPDATE clients SET live_url = ? WHERE id = ?', url, client.id);
  return { site_id: site.id, deploy_id: deployId, url, target: vercel.enabled() ? 'vercel' : 'local' };
}

// Latest version that has been published for a prospect.
async function liveSite(prospectId) {
  return db.get(`SELECT * FROM generated_sites WHERE prospect_id = ? AND approved_by_admin IS NOT NULL
    ORDER BY (published_at IS NOT NULL) DESC, published_at DESC NULLS LAST, version DESC LIMIT 1`, prospectId);
}

// A suspended client's site shows a "renewing" page. /sites/ checks the client's status on
// every request; a Vercel-hosted copy has to be redeployed.
async function suspendSite(client) {
  if (!vercel.enabled()) return;
  const site = await liveSite(client.prospect_id);
  if (site) await vercel.deployStatic(site.slug, { 'index.html': renderSuspended({ business_name: client.business_name, brand: BRAND_NAME, contact: OPT_OUT_CONTACT }) });
}

async function restoreSite(client) {
  const site = await liveSite(client.prospect_id);
  if (site && vercel.enabled()) await deploySite(site.id);
}

// Answers GET /preview/<slug>/<rest> and /sites/<slug>/<rest> from the database.
// kind: 'preview' (latest version, with the "sample" banner) or 'sites' (the published version).
// Returns { status, type, body, cache } or null for "not found".
async function siteResponse(kind, slug, rest) {
  const site = kind === 'preview'
    ? await db.get('SELECT * FROM generated_sites WHERE slug = ? ORDER BY version DESC LIMIT 1', slug)
    : await db.get(`SELECT * FROM generated_sites WHERE slug = ? AND approved_by_admin IS NOT NULL AND published_at IS NOT NULL
        ORDER BY published_at DESC, version DESC LIMIT 1`, slug);
  if (!site) return null;
  const cache = kind === 'preview' ? 'no-cache' : 'public, max-age=60';

  if (rest === 'robots.txt') {
    return { status: 200, type: 'text/plain; charset=utf-8', cache, body: kind === 'preview' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n' };
  }
  const img = rest.match(/^img\/([^/]+)$/);
  if (img) {
    const photo = await photos.readPhoto(site.prospect_id, decodeURIComponent(img[1]));
    return photo ? { status: 200, type: photo.type, body: photo.buffer, cache: 'public, max-age=86400' } : null;
  }

  const brief = JSON.parse(site.brief);
  const lang = rest === '' || rest === 'index.html' ? brief.languages[0] : (rest.match(/^([a-z]{2})\/(index\.html)?$/) || [])[1];
  if (!lang || !brief.languages.includes(lang)) return null;

  if (kind === 'sites') {
    const client = await db.get('SELECT business_name, status FROM clients WHERE prospect_id = ?', site.prospect_id);
    if (client?.status === 'suspended') {
      return { status: 200, type: 'text/html; charset=utf-8', cache: 'no-cache',
        body: renderSuspended({ business_name: client.business_name, brand: BRAND_NAME, contact: OPT_OUT_CONTACT }) };
    }
  }
  return { status: 200, type: 'text/html; charset=utf-8', cache,
    body: renderSitePage({ brief, content: JSON.parse(site.content), lang, preview: kind === 'preview' }) };
}

module.exports = { approveSite, deploySite, suspendSite, restoreSite, liveSite, siteResponse };
