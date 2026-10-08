'use strict';
process.env.DATABASE_URL = 'pglite:memory';
process.env.ANTHROPIC_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/core/db');
const R = require('../src/research/collect');
const { classify } = require('../src/research/opportunity');
const { buildBrief } = require('../src/generation/brief');
const { exportProspect, eraseProspect } = require('../src/compliance/export');

test.after(() => db.close());

const PAGE = `<!doctype html><html><head><title>Hotel Umucyo | Kigali</title>
<meta name="description" content="Family hotel in Kimihurura with 20 rooms &amp; a garden restaurant.">
<meta property="og:image" content="https://umucyo.rw/front.jpg"></head><body>
<nav><h2>Menu</h2><a href="/about">About</a></nav>
<h2>Conference hall</h2><h2>Airport pickup</h2><h3>Contact us</h3>
<p>Hotel Umucyo has welcomed guests in Kimihurura since the family opened its doors, with quiet rooms, a garden and fresh Rwandan coffee every morning.</p>
<p>Short line.</p>
<p>Find us at KG 7 Ave, Kimihurura. Reception: Monday - Sunday 7:00 - 22:00.</p>
<a href="tel:+250788123456">Call</a> <a href="mailto:info@umucyo.rw">Email</a> or 0722 555 666.
<a href="https://www.facebook.com/umucyohotel">Facebook</a> <a href="https://www.facebook.com/sharer.php?u=x">Share</a>
<footer><p>© 2019 Hotel Umucyo. All rights reserved. Designed by someone with a long footer text that should not be read as about.</p></footer>
<script>var x = "noreply@sentry.io";</script></body></html>`;

test('a website page yields description, services, contacts, hours and a Kigali address', () => {
  const x = R.extractFromHtml(PAGE, 'https://umucyo.rw/');
  assert.equal(x.title, 'Hotel Umucyo | Kigali');
  assert.equal(x.description, 'Family hotel in Kimihurura with 20 rooms & a garden restaurant.');
  assert.deepEqual(x.services, ['Conference hall', 'Airport pickup']);
  assert.equal(x.about.length, 1);
  assert.match(x.about[0], /^Hotel Umucyo has welcomed/);
  assert.deepEqual(x.phones, ['+250 788 123 456', '+250 722 555 666']);
  assert.deepEqual(x.emails, ['info@umucyo.rw']);
  assert.equal(x.address, 'KG 7 Ave, Kimihurura');
  assert.deepEqual(x.hours, ['Monday - Sunday 7:00 - 22:00']);
  assert.equal(x.socials.facebook, 'https://www.facebook.com/umucyohotel');
  assert.equal(x.image, 'https://umucyo.rw/front.jpg');
});

test('OSM tags become plain facts', () => {
  assert.deepEqual(R.factsFromOsmTags({ tourism: 'hotel', stars: '3', rooms: '15', internet_access: 'yes', cuisine: 'regional;pizza', 'payment:mobile_money': 'yes' }),
    ['3-star hotel', '15 rooms', 'Cuisine: regional, pizza', 'Free Wi-Fi', 'Accepts MoMo']);
});

test('emails on an expired domain are left out', () => {
  const dead = { website_status: 'dns-dead', website_url: 'https://www.iwawehotel.com/' };
  assert.deepEqual(R.usableEmails(['reservations@iwawehotel.com', 'iwawe@gmail.com'], dead), ['iwawe@gmail.com']);
  assert.deepEqual(R.usableEmails(['info@x.co.rw'], { website_status: 'dns-dead', website_url: 'x.co.rw' }), []);
  assert.deepEqual(R.usableEmails(['info@x.rw'], { website_status: 'live', website_url: 'x.rw' }), ['info@x.rw']);
});

test('prospects are sorted into build-new, needs-update, ok and check', () => {
  const live = (signals) => ({ website_status: 'live', score: 30, score_breakdown: JSON.stringify({ breakdown: signals.map((signal) => ({ signal })) }) });
  assert.deepEqual(classify({ website_status: 'none', score: 40 }), { kind: 'new', reasons: ['No website'] });
  assert.equal(classify({ website_status: 'http-404', score: 30 }).kind, 'new');
  assert.deepEqual(classify(live(['old_copyright', 'not_mobile'])),
    { kind: 'update', reasons: ['Not mobile-friendly', 'Looks abandoned (old copyright year)'] });
  assert.equal(classify(live([])).kind, 'ok');
  assert.equal(classify({ website_status: 'blocked', score: 0 }).kind, 'check');
  assert.equal(classify({ website_status: null, score: null }).kind, 'check');
});

test('collected info pre-fills the brief, is exported and is erased', async () => {
  const { id } = await db.get(`INSERT INTO prospects (name, sector, district, website_url, website_status, contact_email)
    VALUES ('Iwawe Hotel', 'hotel', 'Gasabo', 'https://www.iwawehotel.com/', 'dns-dead', 'reservations@iwawehotel.com') RETURNING id`);
  const found = R.combine(await db.get('SELECT * FROM prospects WHERE id = ?', id),
    { found: { description: 'Hotel on Boulevard de l\'Umuganda.', facts: ['3-star hotel'], hours: ['Open 24 hours'], phones: ['+250 733 304 142'], emails: ['reservations@iwawehotel.com'], address: 'KG 7 Av', socials: {} } },
    null);
  assert.deepEqual(found.emails, []);
  assert.deepEqual(found.dropped_emails, ['reservations@iwawehotel.com']);
  await db.run('INSERT INTO research (prospect_id, collected_at, data) VALUES (?, now(), ?)',
    id, JSON.stringify({ found, sources: [], completeness: R.completeness(found) }));

  const brief = await buildBrief(await db.get('SELECT * FROM prospects WHERE id = ?', id));
  assert.deepEqual(brief.facts, ['Hotel on Boulevard de l\'Umuganda.', '3-star hotel']);
  assert.deepEqual(brief.hours, ['Open 24 hours']);
  assert.equal(brief.address, 'KG 7 Av');
  assert.equal(brief.phone, '+250 733 304 142');
  assert.equal(brief.email, '', 'the dead-domain email from the prospect record is not used either');

  assert.equal((await exportProspect(id)).research.data.found.address, 'KG 7 Av');
  await eraseProspect(id);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM research WHERE prospect_id = ?', id)).n, 0);
});

test('a lost domain now showing spam is recognised; a real site is not', () => {
  const S = require('../src/scoring/signals');
  const spam = '<title>中国·2003网站太阳集团(股份)有限公司</title><p>2003网站太阳集团拥有真人、体育、电子、彩票、棋牌等娱乐游戏,提供免费试玩账号和最新手机客户端下载</p>';
  assert.ok(S.looksTakenOver(spam, 'Corina K'));
  assert.ok(!S.looksTakenOver('<h1>Welcome to Corina K Guest House</h1>', 'Corina K'));
  assert.ok(!S.looksTakenOver('<h1>Our rooms</h1><p>Quiet rooms near the airport.</p>', 'Corina K'), 'not naming them is not enough on its own');
  assert.ok(S.mentionsName('<h1>HOTEL CHEZ LANDO</h1>', 'Hôtel Chez Lando'));
  assert.deepEqual(S.nameTokens('Hôtel Chez Lando Ltd'), ['chez', 'lando']);
});

test('page furniture and the business name are not taken as services', () => {
  const html = '<h2>Welcome To</h2><h2>World Mission High School</h2><h2>Watch Our Videos</h2><h2>School News & Updates</h2>'
    + '<h2>TalkFile_2025-Summer-Camp</h2><h2>Boarding section</h2><h2>Computer lab</h2>';
  assert.deepEqual(R.extractFromHtml(html, 'https://wm.org/', 'World Mission High School(WMHS)').services, ['Boarding section', 'Computer lab']);
});
