'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, BRAND_NAME } = require('../core/config');
const { DATA_DIR } = require('../core/db');
const { renderPage } = require('./templates/layout');

const OUT = process.env.OUT_ROOT || path.join(ROOT, 'out');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PHOTO_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(jpe?g|png|webp)$/i;

function photoDir(prospectId) {
  return path.join(PHOTO_DIR, String(Number(prospectId)));
}

// Returns { 'index.html': html, 'en/index.html': html, 'img/x.jpg': Buffer, ... }
function buildFiles({ prospectId, brief, content, preview }) {
  const files = {};
  brief.languages.forEach((lang, i) => {
    files[i === 0 ? 'index.html' : `${lang}/index.html`] = renderPage({ brief, content, lang, preview, brand: BRAND_NAME });
  });
  for (const p of brief.photos) {
    if (!PHOTO_RE.test(p)) continue;
    const src = path.join(photoDir(prospectId), p);
    if (fs.existsSync(src)) files[`img/${p}`] = fs.readFileSync(src);
  }
  if (!preview) files['robots.txt'] = 'User-agent: *\nAllow: /\n';
  return files;
}

// Writes files to out/<kind>/<slug>/, replacing what was there.
function writeFiles(kind, slug, files) {
  const dir = path.join(OUT, kind, slug);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return dir;
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ltd|limited|sarl|co)\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

module.exports = { buildFiles, writeFiles, slugify, photoDir, PHOTO_RE, OUT };
