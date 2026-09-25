'use strict';
process.env.DB_FILE = ':memory:'; // auditor.js loads the database; keep tests off the real one
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/scoring/signals');
const { score, WEIGHTS } = require('../src/scoring/score');
const { robotsAllows } = require('../src/scoring/robots');
const { normalizeUrl } = require('../src/scoring/auditor');
const { moveEmailOutOfWebsite } = require('../src/prospecting/importer');

test('parked pages are detected', () => {
  assert.ok(S.isParked('<html><body>This domain is for sale! Contact sedo.com</body></html>'));
  assert.ok(S.isParked('<script>window.onload=function(){window.location.href="/lander"}</script>'));
  assert.ok(S.isParked('<META HTTP-EQUIV="refresh" CONTENT="0;URL=/cgi-sys/defaultwebpage.cgi">'));
  assert.ok(S.isParked('<h1>Welcome to nginx!</h1>'));
  assert.ok(!S.isParked('<h1>Hotel Mille Collines</h1><p>Rooms and conference</p>'));
});

test('mobile friendliness needs a device-width viewport', () => {
  assert.ok(S.isMobileFriendly('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(!S.isMobileFriendly('<html><body>no viewport</body></html>'));
  assert.ok(!S.isMobileFriendly('<meta name="viewport" content="width=device-width"><table width="980">'));
});

test('copyright year takes the latest year, including ranges and entities', () => {
  assert.equal(S.lastCopyrightYear('<footer>&copy; 2014 Acme</footer>'), 2014);
  assert.equal(S.lastCopyrightYear('<footer>Copyright © 2012 - 2019 Acme</footer>'), 2019);
  assert.equal(S.lastCopyrightYear('<footer>no year</footer>'), null);
});

test('obsolete tech', () => {
  assert.deepEqual(S.obsoleteTech('<script src="/js/jquery-1.7.2.min.js"></script>'), ['jquery 1.7']);
  assert.ok(S.obsoleteTech('<embed src="intro.swf">').includes('flash'));
  assert.deepEqual(S.obsoleteTech('<script src="jquery-3.7.1.min.js"></script><div class="x">'), []);
});

test('contact info: links or a Rwandan mobile number in the text', () => {
  assert.ok(S.hasContactInfo('<a href="tel:+250788000000">Call</a>'));
  assert.ok(S.hasContactInfo('<a href="https://wa.me/250788000000">WhatsApp</a>'));
  assert.ok(S.hasContactInfo('<p>Call 0788 123 456</p>'));
  assert.ok(!S.hasContactInfo('<p>Welcome</p>'));
});

test('social profiles and link pages count as social-only', () => {
  assert.ok(S.isSocialUrl('https://www.facebook.com/somehotel'));
  assert.ok(S.isSocialUrl('https://m.facebook.com/x'));
  assert.ok(S.isSocialUrl('https://linktr.ee/somebody'));
  assert.ok(!S.isSocialUrl('https://notfacebook.com.rw'));
});

test('forwarding pages are followed, real pages are not', () => {
  assert.equal(S.pageRedirect('<meta http-equiv="refresh" content="0;URL=http://x.rw/en/index.html"><title>X</title>'), 'http://x.rw/en/index.html');
  assert.equal(S.pageRedirect('<script>window.location.href="/home"</script>'), '/home');
  assert.equal(S.pageRedirect('<h1>Hotel</h1><p>' + 'Rooms and views. '.repeat(20) + '</p><script>location="/x"</script>'), null);
});

test('an email address is not a website', () => {
  assert.equal(normalizeUrl('https://pharma.continentale@gmail.com'), null);
  assert.equal(normalizeUrl('www.hotel.rw').href, 'https://www.hotel.rw/');
  const r = { website_url: 'https://pharma.continentale@gmail.com' };
  moveEmailOutOfWebsite(r);
  assert.deepEqual(r, { website_url: null, contact_email: 'pharma.continentale@gmail.com' });
  const keep = { website_url: 'https://hotel.rw/contact' };
  moveEmailOutOfWebsite(keep);
  assert.equal(keep.website_url, 'https://hotel.rw/contact');
});

test('score adds weights, caps at 100 and applies the sector factor', () => {
  const none = score({ no_website: true }, 'hotel');
  assert.equal(none.raw, WEIGHTS.no_website);
  assert.equal(none.score, 40);
  assert.equal(score({ no_website: true }, 'kiosk').score, 6);
  const many = score({ http_error: true, parked: true, no_https: true, not_mobile: true }, 'tours');
  assert.equal(many.raw, 100);
  assert.equal(many.score, 100);
  assert.equal(score({}, 'clinic').score, 0);
  // A business that once paid for a site outranks one that never had one.
  for (const k of ['dns_dead', 'http_error', 'parked']) assert.ok(WEIGHTS[k] > WEIGHTS.no_website, k);
});

test('robots.txt parsing', () => {
  assert.ok(robotsAllows('', '/'));
  assert.ok(!robotsAllows('User-agent: *\nDisallow: /', '/'));
  assert.ok(robotsAllows('User-agent: *\nDisallow: /admin', '/'));
  assert.ok(robotsAllows('User-agent: *\nDisallow:', '/'));
  assert.ok(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: SiteForgeAudit\nAllow: /', '/'));
  assert.ok(!robotsAllows('User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /', '/'));
});
