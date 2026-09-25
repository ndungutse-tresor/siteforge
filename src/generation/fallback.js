'use strict';
const { LIMITS } = require('./schema');

// Plain placeholder copy used when no Claude API key is set, so the pipeline still runs.
// It is deliberately generic; rewrite it in the brief editor before showing a client.
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const T = {
  en: {
    head: (b) => b.business_name,
    sub: (b, where) => `${b.sector_label} in ${where}.`,
    about: (b, where) => `${b.business_name} serves customers in ${where}. Visit us, call us, or send a WhatsApp message and we will help you.`,
    svc: 'Contact us for details about this service.',
    why: ['Friendly, reliable service', 'Easy to reach by phone and WhatsApp', `Based in Kigali`],
    cta: 'Contact us',
    defaults: ['Our main service', 'Advice and support', 'Orders and bookings']
  },
  rw: {
    head: (b) => b.business_name,
    sub: (b, where) => `Murakaza neza! Turi i ${where}.`,
    about: (b, where) => `${b.business_name} ikorera abakiriya i ${where}. Ngwino udusure, uduhamagare cyangwa utwandikire kuri WhatsApp tugufashe.`,
    svc: 'Twandikire umenye byinshi kuri iyi serivisi.',
    why: ['Serivisi nziza kandi yizewe', 'Utubona byoroshye kuri telefoni na WhatsApp', 'Turi i Kigali'],
    cta: 'Twandikire',
    defaults: ['Serivisi yacu nyamukuru', 'Inama n\'ubufasha', 'Gutumiza no kubika umwanya']
  },
  fr: {
    head: (b) => b.business_name,
    sub: (b, where) => `${b.sector_label} à ${where}.`,
    about: (b, where) => `${b.business_name} accueille ses clients à ${where}. Passez nous voir, appelez-nous ou écrivez-nous sur WhatsApp.`,
    svc: 'Contactez-nous pour en savoir plus sur ce service.',
    why: ['Un service fiable et chaleureux', 'Joignable par téléphone et WhatsApp', 'Basé à Kigali'],
    cta: 'Contactez-nous',
    defaults: ['Notre service principal', 'Conseil et accompagnement', 'Commandes et réservations']
  }
};

function fallbackContent(brief) {
  const where = [brief.area, brief.district, 'Kigali'].filter(Boolean).join(', ');
  const content = {};
  for (const l of brief.languages) {
    const t = T[l];
    // Admin-entered service names are kept as written in every language.
    const names = (brief.services.length >= 3 ? brief.services : [...brief.services, ...t.defaults]).slice(0, 6);
    content[l] = {
      hero_headline: cut(t.head(brief), LIMITS.hero_headline),
      hero_sub: cut(t.sub(brief, where), LIMITS.hero_sub),
      about_paragraph: cut(t.about(brief, where), LIMITS.about_paragraph),
      services: names.slice(0, Math.max(3, names.length)).map((n) => ({ title: cut(n, LIMITS.service_title), description: t.svc })),
      why_us: t.why,
      cta_text: t.cta,
      meta_description: cut(`${brief.business_name} – ${t.sub(brief, where)}`, LIMITS.meta_description)
    };
  }
  return { content, source: 'fallback', attempts: 0 };
}

module.exports = { fallbackContent };
