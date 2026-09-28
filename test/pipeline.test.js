'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated database and output folder; no API keys so nothing leaves the machine.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteforge-test-'));
process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = TMP;
process.env.OUT_ROOT = path.join(TMP, 'out');
process.env.ANTHROPIC_API_KEY = '';
process.env.GOOGLE_PLACES_API_KEY = '';
process.env.VERCEL_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/core/db');
const { parseRdbCsv } = require('../src/prospecting/rdb');
const { importProspects } = require('../src/prospecting/importer');
const { parseOsm } = require('../src/prospecting/osm');
const { generateSite, saveEditedContent } = require('../src/generation/generate');
const { validate } = require('../src/generation/schema');
const publish = require('../src/hosting/publish');
const billing = require('../src/hosting/billing');
const outreach = require('../src/outreach/outreach');
const { purgeGoogleCoords } = require('../src/compliance/purge');
const { exportProspect, eraseProspect } = require('../src/compliance/export');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CSV = `TIN,Company Name,Activity,District,Phone,Website
101,"Green Hills Lodge <script>alert(1)</script>",Hotel and lodging,Gasabo,0788123456,
102,Kigali Dental Care,Dental clinic,Kicukiro,0788000111,kigalidental.rw
,Mama Rose Kiosk,Retail kiosk,Nyarugenge,,
`;

test('CSV import, then OSM merge by name and district', () => {
  const rows = parseRdbCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sector, 'hotel');
  assert.equal(rows[1].sector, 'clinic');
  assert.deepEqual(importProspects(rows), { added: 3, merged: 0, skipped: 0 });

  const osm = parseOsm({ elements: [{ type: 'node', id: 5, lat: -1.95, lon: 30.1, tags: { name: 'Kigali Dental Care Ltd', amenity: 'dentist', 'addr:district': 'Kicukiro', email: 'info@kdc.rw' } }] });
  assert.deepEqual(importProspects(osm), { added: 0, merged: 1, skipped: 0 });
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '102'").get();
  assert.equal(p.osm_id, 'node/5');
  assert.equal(p.contact_email, 'info@kdc.rw');
  assert.equal(p.coords_source, 'osm');
});

test('generate -> approve -> deploy locally, with HTML escaped', async () => {
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '101'").get();
  const v1 = await generateSite(p.id, { services: 'Rooms\nRestaurant\nAirport pickup', hours: 'Mon-Sun: 24 hours' });
  assert.equal(v1.version, 1);
  assert.equal(v1.content_source, 'fallback');
  assert.deepEqual(validate(JSON.parse(v1.content), ['rw', 'en']), []);

  const previewDir = path.join(process.env.OUT_ROOT, 'previews', v1.slug);
  const html = fs.readFileSync(path.join(previewDir, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)'), 'business name must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('noindex'), 'previews are not indexed');
  assert.ok(html.includes('https://wa.me/250788123456'));
  assert.ok(fs.existsSync(path.join(previewDir, 'en', 'index.html')));
  assert.equal(db.prepare('SELECT stage FROM prospects WHERE id = ?').get(p.id).stage, 'generated');

  await assert.rejects(publish.deploySite(v1.id), /Approve/);
  publish.approveSite(v1.id, 'tester');
  const d = await publish.deploySite(v1.id);
  assert.equal(d.target, 'local');
  const live = fs.readFileSync(path.join(process.env.OUT_ROOT, 'sites', v1.slug, 'index.html'), 'utf8');
  assert.ok(!live.includes('noindex'));
  assert.ok(!live.includes('class="preview"'));
});

test('hand-edited copy is validated', () => {
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '101'").get();
  const content = JSON.parse(db.prepare('SELECT content FROM generated_sites WHERE prospect_id = ?').get(p.id).content);
  content.en.hero_headline = 'x'.repeat(200);
  assert.throws(() => saveEditedContent(p.id, content), /hero_headline/);
  content.en.hero_headline = 'Rest well in Gasabo';
  assert.equal(saveEditedContent(p.id, content).version, 2);
});

test('outreach always carries an opt-out, and opt-out blocks further contact', () => {
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '101'").get();
  const msg = outreach.composeMessage(p.id, { lang: 'en' });
  assert.match(msg.full, /To stop receiving messages/);
  const wa = outreach.whatsappLink(p.id, { lang: 'rw' });
  assert.ok(wa.url.startsWith('https://wa.me/250788123456?text='));

  const logged = outreach.logOutreach(p.id, { channel: 'whatsapp', message: 'Hello' });
  assert.match(logged.message, /reply STOP|Niba udashaka/);

  const k = db.prepare("SELECT * FROM prospects WHERE name = 'Mama Rose Kiosk'").get();
  outreach.optOut(k.id);
  assert.throws(() => outreach.composeMessage(k.id), /asked not to be contacted/);
  assert.throws(() => outreach.logOutreach(k.id, { channel: 'visit' }), /asked not to be contacted/);
});

test('billing: payment extends, overdue, suspension after 30 days, restore on payment', async () => {
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '101'").get();
  const c = billing.createClient(p.id, { monthly_fee: 15000, setup_fee: 250000 });
  assert.equal(db.prepare('SELECT stage FROM prospects WHERE id = ?').get(p.id).stage, 'won');

  const paid = await billing.recordPayment(c.id, { amount: 265000, momo_txid: 'TX1', months: 1 });
  assert.equal(paid.next_invoice_at, billing.addMonths(new Date().toISOString().slice(0, 10), 1));

  db.prepare("UPDATE clients SET next_invoice_at = date('now', '-5 days') WHERE id = ?").run(c.id);
  assert.deepEqual(await billing.checkRenewals(), { newly_overdue: 1, suspended: 0 });
  db.prepare("UPDATE clients SET next_invoice_at = date('now', '-40 days') WHERE id = ?").run(c.id);
  assert.deepEqual(await billing.checkRenewals(), { newly_overdue: 0, suspended: 1 });

  const slug = db.prepare('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1').get(p.id).slug;
  const sitePath = path.join(process.env.OUT_ROOT, 'sites', slug, 'index.html');
  assert.match(fs.readFileSync(sitePath, 'utf8'), /temporarily offline/);

  const back = await billing.recordPayment(c.id, { amount: 15000, momo_txid: 'TX2' });
  assert.equal(back.status, 'active');
  assert.doesNotMatch(fs.readFileSync(sitePath, 'utf8'), /temporarily offline/);
  await assert.rejects(billing.recordPayment(c.id, { amount: 15000, momo_txid: 'TX2' }), /UNIQUE/);
});

test('Google coordinates are purged after 30 days; OSM ones are kept', () => {
  const p = db.prepare("SELECT * FROM prospects WHERE name = 'Mama Rose Kiosk'").get();
  db.prepare("UPDATE prospects SET lat = -1.9, lng = 30.0, coords_source = 'google', coords_fetched_at = datetime('now', '-31 days') WHERE id = ?").run(p.id);
  assert.deepEqual(purgeGoogleCoords(), { cleared: 1 });
  assert.equal(db.prepare('SELECT lat FROM prospects WHERE id = ?').get(p.id).lat, null);
  assert.notEqual(db.prepare("SELECT lat FROM prospects WHERE rdb_number = '102'").get().lat, null);
});

test('export and erase', () => {
  const p = db.prepare("SELECT * FROM prospects WHERE rdb_number = '102'").get();
  const x = exportProspect(p.id);
  assert.equal(x.prospect.name, 'Kigali Dental Care');
  eraseProspect(p.id);
  const after = db.prepare('SELECT * FROM prospects WHERE id = ?').get(p.id);
  assert.equal(after.contact_email, null);
  assert.equal(after.do_not_contact, 1);
  const client = db.prepare("SELECT prospect_id FROM clients LIMIT 1").get();
  assert.throws(() => eraseProspect(client.prospect_id), /client/);
});

test('missing preview and site files are rebuilt from the database', async () => {
  const { restoreFiles } = require('../src/hosting/publish');
  const { OUT } = require('../src/generation/build');
  const row = db.prepare('SELECT * FROM generated_sites WHERE approved_by_admin IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  assert.ok(row, 'an approved site exists from the earlier test');
  fs.rmSync(path.join(OUT, 'previews', row.slug), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'sites', row.slug), { recursive: true, force: true });
  assert.equal(restoreFiles('previews', row.slug), true);
  assert.ok(fs.existsSync(path.join(OUT, 'previews', row.slug, 'index.html')));
  assert.equal(restoreFiles('sites', row.slug), true, 'it was published earlier, so it comes back');
  assert.ok(fs.existsSync(path.join(OUT, 'sites', row.slug, 'robots.txt')));
  assert.equal(restoreFiles('previews', 'no-such-site'), false);
  db.prepare('UPDATE generated_sites SET published_at = NULL WHERE slug = ?').run(row.slug);
  fs.rmSync(path.join(OUT, 'sites', row.slug), { recursive: true, force: true });
  assert.equal(restoreFiles('sites', row.slug), false, 'a version that was never published is not put online');
});
