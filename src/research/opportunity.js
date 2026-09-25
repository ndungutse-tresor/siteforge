'use strict';

// Sorts audited prospects into what we would sell them:
//   new    - they have no working website: build one
//   update - their site works but is outdated or broken in places: rebuild / refresh it
//   ok     - healthy site, nothing to sell
//   check  - we could not look (firewall, robots.txt, not audited): look in a browser
const NEW_STATUSES = new Set(['none', 'dns-dead', 'taken-over', 'parked', 'social-only', 'invalid-url', 'ssl-error', 'timeout', 'unreachable']);
const CHECK_STATUSES = new Set(['blocked', 'robots-blocked']);

const NEW_REASONS = {
  none: 'No website',
  'dns-dead': 'Domain has expired / stopped working',
  'taken-over': 'Domain now shows someone else\'s (spam) site',
  parked: 'Domain shows a parked or placeholder page',
  'social-only': 'Only a social media page',
  'invalid-url': 'Listed website is not a real address',
  'ssl-error': 'Browsers show a security warning',
  timeout: 'Site does not load',
  unreachable: 'Site does not load'
};

// Signals that make a working site worth updating, in the order a customer would care.
const UPDATE_REASONS = {
  not_mobile: 'Not mobile-friendly',
  no_https: 'No secure HTTPS',
  no_contact: 'No phone / WhatsApp / email link',
  slow: 'Very slow',
  old_copyright: 'Looks abandoned (old copyright year)',
  obsolete_tech: 'Built on outdated technology'
};

function classify(p) {
  const status = p.website_status;
  if (!status || p.score == null) return { kind: 'check', reasons: ['Not audited yet'] };
  if (CHECK_STATUSES.has(status)) return { kind: 'check', reasons: ['We could not inspect the site; open it in a browser'] };
  if (NEW_STATUSES.has(status)) return { kind: 'new', reasons: [NEW_REASONS[status]] };
  if (/^http-\d+$/.test(status)) return { kind: 'new', reasons: [`Site shows an error (${status.slice(5)})`] };
  let signals = [];
  try {
    const b = typeof p.score_breakdown === 'string' ? JSON.parse(p.score_breakdown) : p.score_breakdown;
    signals = (b?.breakdown || []).map((x) => x.signal);
  } catch (e) { /* no breakdown */ }
  const reasons = Object.keys(UPDATE_REASONS).filter((k) => signals.includes(k)).map((k) => UPDATE_REASONS[k]);
  return reasons.length ? { kind: 'update', reasons } : { kind: 'ok', reasons: [] };
}

// SQL for each kind, so lists and counts can be filtered in the database.
const KIND_SQL = {
  new: `(website_status IN (${[...NEW_STATUSES].map((s) => `'${s}'`).join(',')}) OR website_status LIKE 'http-%')`,
  update: `(website_status = 'live' AND score > 0)`,
  check: `(website_status IS NULL OR score IS NULL OR website_status IN (${[...CHECK_STATUSES].map((s) => `'${s}'`).join(',')}))`
};

module.exports = { classify, KIND_SQL, UPDATE_REASONS, NEW_REASONS };
