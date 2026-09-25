'use strict';

// The model fills this content schema, never a page. Templates turn it into HTML.
const LIMITS = {
  hero_headline: 70,
  hero_sub: 160,
  about_paragraph: 650,
  service_title: 40,
  service_description: 170,
  why_us_item: 100,
  cta_text: 30,
  meta_description: 155
};
const SERVICES_MIN = 3, SERVICES_MAX = 6, WHY_MIN = 3, WHY_MAX = 4;
const LANGS = { rw: 'Kinyarwanda', en: 'English', fr: 'French' };

const langSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hero_headline', 'hero_sub', 'about_paragraph', 'services', 'why_us', 'cta_text', 'meta_description'],
  properties: {
    hero_headline: { type: 'string' },
    hero_sub: { type: 'string' },
    about_paragraph: { type: 'string' },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description'],
        properties: { title: { type: 'string' }, description: { type: 'string' } }
      }
    },
    why_us: { type: 'array', items: { type: 'string' } },
    cta_text: { type: 'string' },
    meta_description: { type: 'string' }
  }
};

// JSON schema sent to the API: one object per requested language.
function jsonSchema(langs) {
  return {
    type: 'object',
    additionalProperties: false,
    required: langs,
    properties: Object.fromEntries(langs.map((l) => [l, langSchema]))
  };
}

function str(errors, where, v, max) {
  if (typeof v !== 'string' || !v.trim()) errors.push(`${where} is empty`);
  else if (v.length > max) errors.push(`${where} is ${v.length} chars (max ${max})`);
}

// Returns a list of problems; empty list = valid.
function validate(content, langs) {
  const errors = [];
  if (!content || typeof content !== 'object') return ['content is not an object'];
  for (const l of langs) {
    const c = content[l];
    if (!c || typeof c !== 'object') { errors.push(`${l}: missing`); continue; }
    str(errors, `${l}.hero_headline`, c.hero_headline, LIMITS.hero_headline);
    str(errors, `${l}.hero_sub`, c.hero_sub, LIMITS.hero_sub);
    str(errors, `${l}.about_paragraph`, c.about_paragraph, LIMITS.about_paragraph);
    str(errors, `${l}.cta_text`, c.cta_text, LIMITS.cta_text);
    str(errors, `${l}.meta_description`, c.meta_description, LIMITS.meta_description);
    if (!Array.isArray(c.services) || c.services.length < SERVICES_MIN || c.services.length > SERVICES_MAX) {
      errors.push(`${l}.services needs ${SERVICES_MIN}-${SERVICES_MAX} items`);
    } else {
      c.services.forEach((s, i) => {
        str(errors, `${l}.services[${i}].title`, s?.title, LIMITS.service_title);
        str(errors, `${l}.services[${i}].description`, s?.description, LIMITS.service_description);
      });
    }
    if (!Array.isArray(c.why_us) || c.why_us.length < WHY_MIN || c.why_us.length > WHY_MAX) {
      errors.push(`${l}.why_us needs ${WHY_MIN}-${WHY_MAX} items`);
    } else {
      c.why_us.forEach((w, i) => str(errors, `${l}.why_us[${i}]`, w, LIMITS.why_us_item));
    }
  }
  return errors;
}

module.exports = { LIMITS, LANGS, SERVICES_MIN, SERVICES_MAX, WHY_MIN, WHY_MAX, jsonSchema, validate };
