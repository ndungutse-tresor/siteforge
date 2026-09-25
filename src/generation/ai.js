'use strict';
const { Anthropic } = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('../core/config');
const { LIMITS, LANGS, SERVICES_MIN, SERVICES_MAX, WHY_MIN, WHY_MAX, jsonSchema, validate } = require('./schema');

const MODEL = 'claude-opus-5';
const MAX_ATTEMPTS = 3;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return client;
}

function enabled() {
  return Boolean(ANTHROPIC_API_KEY);
}

const SYSTEM = `You write website copy for small businesses in Rwanda. You return only the JSON content object requested; a fixed template turns it into a page.

Rules:
- Use only facts in the brief. Never invent prices, awards, certifications, years in business, staff names, number of clients, or services that are not listed or clearly implied by the sector. If the brief lists no services, describe the typical core services of that sector in general terms without specific claims.
- Keep within these character limits: hero_headline ${LIMITS.hero_headline}, hero_sub ${LIMITS.hero_sub}, about_paragraph ${LIMITS.about_paragraph}, each service title ${LIMITS.service_title}, each service description ${LIMITS.service_description}, each why_us item ${LIMITS.why_us_item}, cta_text ${LIMITS.cta_text}, meta_description ${LIMITS.meta_description}.
- services: ${SERVICES_MIN}-${SERVICES_MAX} items. why_us: ${WHY_MIN}-${WHY_MAX} short items.
- Write each language natively, not as a word-for-word translation. Kinyarwanda must be natural, everyday Kinyarwanda as used in Kigali; keep brand and place names unchanged.
- cta_text is a short action such as booking, calling, or visiting that fits the sector.
- Plain text only: no markdown, no emoji, no HTML.`;

function userPrompt(brief, problems) {
  const langs = brief.languages.map((l) => `${l} (${LANGS[l]})`).join(', ');
  const facts = {
    business_name: brief.business_name,
    sector: brief.sector_label,
    services: brief.services,
    facts: brief.facts,
    location: [brief.area, brief.district, 'Kigali, Rwanda'].filter(Boolean).join(', '),
    opening_hours: brief.hours,
    has_whatsapp: Boolean(brief.whatsapp),
    tone: brief.tone
  };
  let text = `Write the website content in these languages: ${langs}.\n\nBrief:\n${JSON.stringify(facts, null, 2)}`;
  if (problems?.length) text += `\n\nYour previous answer had these problems; fix them:\n- ${problems.join('\n- ')}`;
  return text;
}

// Calls Claude until the content passes validation. Returns { content, source, attempts }.
async function generateContent(brief) {
  let problems = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      // fallbacks: "default" re-runs a policy-declined request on Anthropic's recommended model.
      response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: jsonSchema(brief.languages) } },
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(brief, problems) }]
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude API key was rejected. Check ANTHROPIC_API_KEY.');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit hit. Try again in a minute.');
      if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude API rejected the request: ${e.message}`);
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
      throw e;
    }

    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined to write this content${response.stop_details?.explanation ? ': ' + response.stop_details.explanation : '.'}`);
    }
    if (response.stop_reason === 'max_tokens') {
      problems = ['The answer was cut off. Be more concise.'];
      continue;
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let content;
    try {
      content = JSON.parse(text);
    } catch (e) {
      problems = ['The answer was not valid JSON.'];
      continue;
    }
    problems = validate(content, brief.languages);
    if (!problems.length) return { content, source: `claude:${response.model}`, attempts: attempt };
  }
  throw new Error(`Generated content failed validation after ${MAX_ATTEMPTS} tries: ${problems.join('; ')}`);
}

module.exports = { enabled, generateContent, MODEL };
