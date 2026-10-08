'use strict';
process.env.DATABASE_URL = 'pglite:memory';
process.env.OPT_OUT_CONTACT = 'WhatsApp 0788 111 222';
process.env.BRAND_NAME = 'SiteForge';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/core/db');
const { problemReport, composeProblemMessage } = require('../src/outreach/problems');

test.after(() => db.close());

async function prospect(fields, audit) {
  const cols = Object.keys(fields);
  const { id } = await db.get(`INSERT INTO prospects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`, ...Object.values(fields));
  if (audit) {
    await db.run(`INSERT INTO audits (prospect_id, http_status, final_url, load_ms, last_copyright_year, signals, score)
      VALUES (?, ?, ?, ?, ?, ?, 0)`, id, audit.http_status ?? null, audit.final_url ?? null, audit.load_ms ?? null,
      audit.year ?? null, JSON.stringify(audit.signals || {}));
  }
  return id;
}

test('a dead domain: the address and its email are both reported, the dead email is not offered as a contact', async () => {
  const id = await prospect({ name: 'Iwawe Hotel', sector: 'hotel', website_url: 'https://www.iwawehotel.com/', website_status: 'dns-dead',
    contact_phone: '+250 733 304 142', contact_email: 'reservations@iwawehotel.com', score: 45 },
  { signals: { dns_dead: true, notes: ['DNS: ENOTFOUND'] } });
  const r = await problemReport(id);
  assert.deepEqual(r.issues.map((x) => x.key), ['dns-dead', 'dead_email']);
  assert.equal(r.issues[0].problem, 'Your web address iwawehotel.com no longer works');
  assert.equal(r.issues[0].evidence, 'DNS: ENOTFOUND');
  assert.match(r.issues[1].problem, /reservations@iwawehotel\.com/);
  assert.deepEqual(r.contacts, { phone: '+250 733 304 142', whatsapp: '250733304142', email: '' });

  const en = r.messages.en;
  assert.match(en.subject, /2 problems/);
  assert.match(en.body, /^Hello Iwawe Hotel,/);
  assert.match(en.body, /1\. Your web address iwawehotel\.com no longer works\. Anyone who types it/);
  assert.ok(en.full.endsWith('To stop receiving messages from SiteForge: WhatsApp 0788 111 222.'), 'the stop line is always there');
  assert.match(r.messages.rw.body, /ibibazo 2 bishobora/);
});

test('a live site: problems come most serious first, with evidence from the audit', async () => {
  const id = await prospect({ name: 'Fixit Hardware', sector: 'retail', website_url: 'http://www.fixit.rw/', website_status: 'live', score: 44 },
    { http_status: 200, final_url: 'http://www.fixit.rw/', load_ms: 4200, year: 2017,
      signals: { no_https: true, not_mobile: true, old_copyright: true, obsolete_tech: true, slow: true, notes: ['TLS: ERR_TLS_CERT_ALTNAME_INVALID', 'Obsolete: jquery 1.8'] } });
  const r = await problemReport(id);
  assert.deepEqual(r.issues.map((x) => x.severity), ['high', 'high', 'medium', 'medium', 'medium']);
  const byKey = Object.fromEntries(r.issues.map((x) => [x.key, x]));
  assert.equal(byKey.slow.problem, 'Your website takes 4.2 seconds to start loading');
  assert.equal(byKey.old_copyright.problem, 'Your website looks abandoned (last dated 2017)');
  assert.equal(byKey.obsolete_tech.problem, 'Your website is built on outdated technology (jquery 1.8)');
  assert.equal(byKey.no_https.evidence, 'TLS: ERR_TLS_CERT_ALTNAME_INVALID');
  assert.match(r.messages.en.body, /5 problems that may be costing you customers/);
});

test('no website but an email on their own domain: the admin is warned to check first', async () => {
  const id = await prospect({ name: 'Great apartment hotel', sector: 'hotel', website_status: 'none', contact_email: 'info@great-apartment.rw',
    contact_phone: '+250 782 626 582', score: 40 }, { signals: { no_website: true } });
  const r = await problemReport(id);
  assert.deepEqual(r.issues.map((x) => x.key), ['none']);
  assert.match(r.messages.en.subject, /customers can't find you online/);
  assert.ok(r.warnings.some((w) => w.includes('https://great-apartment.rw/')));
  assert.ok(!r.messages.en.full.includes('great-apartment.rw'), 'warnings are for the admin only');

  const gmail = await prospect({ name: 'Kiosk', sector: 'kiosk', website_status: 'none', contact_email: 'kiosk@gmail.com', score: 6 }, { signals: {} });
  assert.ok(!(await problemReport(gmail)).warnings.some((w) => /Check it before/.test(w)));
});

test('blocked sites, healthy sites and do-not-contact businesses', async () => {
  const blocked = await prospect({ name: 'Big Hotel', website_url: 'https://big.example', website_status: 'blocked', score: 0 }, { http_status: 403, signals: {} });
  const rb = await problemReport(blocked);
  assert.equal(rb.issues.length, 0);
  assert.match(rb.unchecked, /blocks automatic checks/);

  const healthy = await prospect({ name: 'Good Clinic', website_url: 'https://good.rw', website_status: 'live', score: 0 }, { http_status: 200, signals: {} });
  assert.equal((await problemReport(healthy)).issues.length, 0);
  assert.equal((await problemReport(healthy)).messages, null);

  const dnc = await prospect({ name: 'Private Shop', website_status: 'none', do_not_contact: 1, score: 20 }, { signals: {} });
  const rd = await problemReport(dnc);
  assert.equal(rd.issues.length, 1, 'the admin can still read the problems');
  assert.equal(rd.messages, null, 'but no message is prepared');
  const row = await db.get('SELECT * FROM prospects WHERE id = ?', dnc);
  assert.throws(() => composeProblemMessage(row, rd.issues, 'en'), /asked not to be contacted/);
});
