'use strict';
const { BRAND_NAME } = require('../core/config');
const { renderPage } = require('./templates/layout');
const photos = require('../storage/photos');

// Sites are drawn from the database when someone opens them (see hosting/publish.js siteResponse),
// so nothing is written to disk. buildFiles gathers the full file set only for a Vercel deploy.

// URL path of each language: the first language is at the root, the others under /<lang>/.
const pageFor = (brief, lang) => (lang === brief.languages[0] ? 'index.html' : `${lang}/index.html`);

function renderSitePage({ brief, content, lang, preview }) {
  return renderPage({ brief, content, lang, preview, brand: BRAND_NAME });
}

// Returns { 'index.html': html, 'en/index.html': html, 'img/x.jpg': Buffer, 'robots.txt': … }
async function buildFiles({ prospectId, brief, content, preview }) {
  const files = {};
  for (const lang of brief.languages) files[pageFor(brief, lang)] = renderSitePage({ brief, content, lang, preview });
  for (const p of brief.photos || []) {
    const img = await photos.readPhoto(prospectId, p);
    if (img) files[`img/${p}`] = img.buffer;
  }
  if (!preview) files['robots.txt'] = 'User-agent: *\nAllow: /\n';
  return files;
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ltd|limited|sarl|co)\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

module.exports = { buildFiles, renderSitePage, pageFor, slugify, PHOTO_RE: photos.PHOTO_RE };
