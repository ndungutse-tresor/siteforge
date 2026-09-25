'use strict';
const { db } = require('../core/db');
const { BASE_URL } = require('../core/config');
const { buildBrief } = require('./brief');
const ai = require('./ai');
const { fallbackContent } = require('./fallback');
const { validate } = require('./schema');
const { buildFiles, writeFiles, slugify } = require('./build');

function slugFor(prospect) {
  const existing = db.prepare('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1').get(prospect.id);
  if (existing) return existing.slug;
  const base = slugify(prospect.name);
  const taken = db.prepare('SELECT 1 FROM generated_sites WHERE slug = ? AND prospect_id != ? LIMIT 1');
  let slug = base, n = 2;
  while (taken.get(slug, prospect.id)) slug = `${base}-${n++}`;
  return slug;
}

function saveVersion(prospect, brief, content, source) {
  const slug = slugFor(prospect);
  const version = (db.prepare('SELECT MAX(version) AS v FROM generated_sites WHERE prospect_id = ?').get(prospect.id).v || 0) + 1;
  writeFiles('previews', slug, buildFiles({ prospectId: prospect.id, brief, content, preview: true }));
  const preview_url = `${BASE_URL}/preview/${slug}/`;
  const row = db.prepare(`INSERT INTO generated_sites (prospect_id, slug, template_key, brief, content, content_source, preview_url, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(prospect.id, slug, brief.template, JSON.stringify(brief),
    JSON.stringify(content), source, preview_url, version);
  db.prepare(`UPDATE prospects SET stage = CASE WHEN stage IN ('discovered', 'audited') THEN 'generated' ELSE stage END,
    updated_at = datetime('now') WHERE id = ?`).run(prospect.id);
  return row;
}

// brief -> content (Claude, or placeholder copy without a key) -> template -> preview files.
async function generateSite(prospectId, briefOverrides = {}) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!prospect) throw new Error('Prospect not found');
  const brief = buildBrief(prospect, briefOverrides);
  const result = ai.enabled() ? await ai.generateContent(brief) : fallbackContent(brief);
  return saveVersion(prospect, brief, result.content, result.source);
}

// Admin hand-edited the copy: validate, re-render, save as a new version. No AI call.
function saveEditedContent(prospectId, content, briefOverrides = {}) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!prospect) throw new Error('Prospect not found');
  const brief = buildBrief(prospect, briefOverrides);
  const problems = validate(content, brief.languages);
  if (problems.length) {
    const e = new Error(problems.join('; '));
    e.status = 400;
    throw e;
  }
  return saveVersion(prospect, brief, content, 'edited');
}

module.exports = { generateSite, saveEditedContent };
