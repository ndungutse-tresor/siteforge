'use strict';
const { sectorInfo } = require('../prospecting/sectors');

// Higher = better prospect (worse web presence).
// A dead, broken or parked site ranks above no site at all: that business has already
// paid for a website once, so it is the warmest lead.
const WEIGHTS = {
  dns_dead: 45,
  taken_over: 45,
  http_error: 43,
  parked: 42,
  no_website: 40,
  no_https: 25,
  not_mobile: 22,
  facebook_only: 20,
  old_copyright: 18,
  slow: 15,
  obsolete_tech: 12,
  no_contact: 10
};

const LABELS = {
  no_website: 'No website at all',
  dns_dead: 'Domain dead (DNS fails)',
  taken_over: 'Domain now shows someone else\'s content (spam)',
  http_error: 'Site returns an error',
  parked: 'Parked / for-sale page',
  no_https: 'No HTTPS or bad certificate',
  not_mobile: 'Not mobile-friendly',
  facebook_only: 'Facebook page used as website',
  old_copyright: 'Copyright year 3+ years old',
  slow: 'Very slow (> 3 s to first byte)',
  obsolete_tech: 'Obsolete tech (Flash, old jQuery, tables)',
  no_contact: 'No phone / email / WhatsApp link',
  robots_blocked: 'robots.txt disallows us (page not inspected)'
};

// signals: { name: true|false } -> { raw, wtp, score, breakdown[] }
function score(signals, sector) {
  const breakdown = [];
  let raw = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    if (signals[name]) {
      raw += weight;
      breakdown.push({ signal: name, label: LABELS[name], points: weight });
    }
  }
  raw = Math.min(100, raw);
  const wtp = sectorInfo(sector).wtp;
  return { raw, wtp, score: Math.round(raw * wtp), breakdown };
}

module.exports = { WEIGHTS, LABELS, score };
