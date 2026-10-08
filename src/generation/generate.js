'use strict';
const { db } = require('../core/db');
const { BASE_URL } = require('../core/config');
const { buildBrief } = require('./brief');
const ai = require('./ai');
const { fallbackContent } = require('./fallback');
const { validate } = require('./schema');
const { slugify } = require('./build');

async function slugFor(prospect) {
  const existing = await db.get('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1', prospect.id);
  if (existing) return existing.slug;
  const base = slugify(prospect.name);
  let slug = base, n = 2;
  while (await db.get('SELECT 1 FROM generated_sites WHERE slug = ? AND prospect_id != ? LIMIT 1', slug, prospect.id)) slug = `${base}-${n++}`;
  return slug;
}

// A new version is only a database row: the preview is drawn from it at /preview/<slug>/.
async function saveVersion(prospect, brief, content, source) {
  const slug = await slugFor(prospect);
  const version = ((await db.get('SELECT MAX(version) AS v FROM generated_sites WHERE prospect_id = ?', prospect.id)).v || 0) + 1;
  const preview_url = `${BASE_URL}/preview/${slug}/`;
  const row = await db.get(`INSERT INTO generated_sites (prospect_id, slug, template_key, brief, content, content_source, preview_url, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, prospect.id, slug, brief.template, JSON.stringify(brief),
  JSON.stringify(content), source, preview_url, version);
  await db.run(`UPDATE prospects SET stage = CASE WHEN stage IN ('discovered', 'audited') THEN 'generated' ELSE stage END,
    updated_at = now() WHERE id = ?`, prospect.id);
  return row;
}

// brief -> content (Claude, or placeholder copy without a key) -> template -> preview files.
async function generateSite(prospectId, briefOverrides = {}) {
  const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!prospect) throw new Error('Prospect not found');
  const brief = await buildBrief(prospect, briefOverrides);
  const result = ai.enabled() ? await ai.generateContent(brief) : fallbackContent(brief);
  return saveVersion(prospect, brief, result.content, result.source);
}

// Admin hand-edited the copy: validate, re-render, save as a new version. No AI call.
async function saveEditedContent(prospectId, content, briefOverrides = {}) {
  const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!prospect) throw new Error('Prospect not found');
  const brief = await buildBrief(prospect, briefOverrides);
  const problems = validate(content, brief.languages);
  if (problems.length) {
    const e = new Error(problems.join('; '));
    e.status = 400;
    throw e;
  }
  return saveVersion(prospect, brief, content, 'edited');
}

module.exports = { generateSite, saveEditedContent };
