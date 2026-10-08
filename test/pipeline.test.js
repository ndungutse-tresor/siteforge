'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// In-memory Postgres (PGlite); no API keys so nothing leaves the machine.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteforge-test-'));
process.env.DATABASE_URL = 'pglite:memory';
process.env.DATA_DIR = TMP;
process.env.ANTHROPIC_API_KEY = '';
process.env.GOOGLE_PLACES_API_KEY = '';
process.env.VERCEL_TOKEN = '';
process.env.SUPABASE_URL = '';

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
const photos = require('../src/storage/photos');
const { purgeGoogleCoords } = require('../src/compliance/purge');
const { exportProspect, eraseProspect } = require('../src/compliance/export');

test.after(async () => {
  await db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const CSV = `TIN,Company Name,Activity,District,Phone,Website
101,"Green Hills Lodge <script>alert(1)</script>",Hotel and lodging,Gasabo,0788123456,
102,Kigali Dental Care,Dental clinic,Kicukiro,0788000111,kigalidental.rw
,Mama Rose Kiosk,Retail kiosk,Nyarugenge,,
`;

const byRdb = (n) => db.get('SELECT * FROM prospects WHERE rdb_number = ?', n);
const page = async (kind, slug, rest = '') => (await publish.siteResponse(kind, slug, rest))?.body?.toString();

test('CSV import, then OSM merge by name and district', async () => {
  const rows = parseRdbCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sector, 'hotel');
  assert.equal(rows[1].sector, 'clinic');
  assert.deepEqual(await importProspects(rows), { added: 3, merged: 0, skipped: 0 });
  assert.deepEqual(await importProspects(rows), { added: 0, merged: 0, skipped: 3 }, 'importing again changes nothing');

  const osm = parseOsm({ elements: [{ type: 'node', id: 5, lat: -1.95, lon: 30.1, tags: { name: 'Kigali Dental Care Ltd', amenity: 'dentist', 'addr:district': 'Kicukiro', email: 'info@kdc.rw' } }] });
  assert.deepEqual(await importProspects(osm), { added: 0, merged: 1, skipped: 0 });
  const p = await byRdb('102');
  assert.equal(p.osm_id, 'node/5');
  assert.equal(p.contact_email, 'info@kdc.rw');
  assert.equal(p.coords_source, 'osm');
});

test('generate -> approve -> publish, with HTML escaped', async () => {
  const p = await byRdb('101');
  const v1 = await generateSite(p.id, { services: 'Rooms\nRestaurant\nAirport pickup', hours: 'Mon-Sun: 24 hours' });
  assert.equal(v1.version, 1);
  assert.equal(v1.content_source, 'fallback');
  assert.deepEqual(validate(JSON.parse(v1.content), ['rw', 'en']), []);
  assert.match(v1.preview_url, new RegExp(`/preview/${v1.slug}/$`));

  const html = await page('preview', v1.slug);
  assert.ok(!html.includes('<script>alert(1)'), 'business name must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('noindex'), 'previews are not indexed');
  assert.ok(html.includes('https://wa.me/250788123456'));
  assert.ok(await page('preview', v1.slug, 'en/'));
  assert.equal(await publish.siteResponse('preview', v1.slug, 'de/'), null, 'only the site languages exist');
  assert.match(await page('preview', v1.slug, 'robots.txt'), /Disallow: \//);
  assert.equal((await db.get('SELECT stage FROM prospects WHERE id = ?', p.id)).stage, 'generated');

  assert.equal(await publish.siteResponse('sites', v1.slug, ''), null, 'nothing is live before publishing');
  await assert.rejects(publish.deploySite(v1.id), /Approve/);
  await publish.approveSite(v1.id, 'tester');
  const d = await publish.deploySite(v1.id);
  assert.equal(d.target, 'local');
  const live = await page('sites', v1.slug);
  assert.ok(!live.includes('noindex'));
  assert.ok(!live.includes('class="preview"'));
  assert.match(await page('sites', v1.slug, 'robots.txt'), /Allow: \//);
});

test('photos are stored in the database and served with the site', async () => {
  const p = await byRdb('101');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const name = await photos.savePhoto(p.id, 'Front door.PNG', png, 'image/png');
  assert.match(name, /\.png$/);
  assert.deepEqual(await photos.listPhotos(p.id), [name]);
  const slug = (await db.get('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1', p.id)).slug;
  const r = await publish.siteResponse('preview', slug, `img/${name}`);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(Buffer.from(r.body), png);
  await assert.rejects(photos.savePhoto(p.id, 'x.gif', png, 'image/gif'));
  await photos.deletePhoto(p.id, name);
  assert.deepEqual(await photos.listPhotos(p.id), []);
  assert.equal(await publish.siteResponse('preview', slug, `img/${name}`), null);
});

test('hand-edited copy is validated', async () => {
  const p = await byRdb('101');
  const content = JSON.parse((await db.get('SELECT content FROM generated_sites WHERE prospect_id = ?', p.id)).content);
  content.en.hero_headline = 'x'.repeat(200);
  await assert.rejects(saveEditedContent(p.id, content), /hero_headline/);
  content.en.hero_headline = 'Rest well in Gasabo';
  assert.equal((await saveEditedContent(p.id, content)).version, 2);
  const slug = (await db.get('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1', p.id)).slug;
  assert.match(await page('preview', slug, 'en/'), /Rest well in Gasabo/, 'the preview shows the newest version');
  assert.doesNotMatch(await page('sites', slug, 'en/'), /Rest well in Gasabo/, 'the live site keeps the published version');
});

test('outreach always carries an opt-out, and opt-out blocks further contact', async () => {
  const p = await byRdb('101');
  const msg = await outreach.composeMessage(p.id, { lang: 'en' });
  assert.match(msg.full, /To stop receiving messages/);
  const wa = await outreach.whatsappLink(p.id, { lang: 'rw' });
  assert.ok(wa.url.startsWith('https://wa.me/250788123456?text='));

  const logged = await outreach.logOutreach(p.id, { channel: 'whatsapp', message: 'Hello' });
  assert.match(logged.message, /reply STOP|Niba udashaka/);

  const k = await db.get("SELECT * FROM prospects WHERE name = 'Mama Rose Kiosk'");
  await outreach.optOut(k.id);
  await assert.rejects(outreach.composeMessage(k.id), /asked not to be contacted/);
  await assert.rejects(outreach.logOutreach(k.id, { channel: 'visit' }), /asked not to be contacted/);
});

test('billing: payment extends, overdue, suspension after 30 days, restore on payment', async () => {
  const p = await byRdb('101');
  const c = await billing.createClient(p.id, { monthly_fee: 15000, setup_fee: 250000 });
  assert.equal((await db.get('SELECT stage FROM prospects WHERE id = ?', p.id)).stage, 'won');
  await assert.rejects(billing.createClient(p.id, {}), /already/);

  const paid = await billing.recordPayment(c.id, { amount: 265000, momo_txid: 'TX1', months: 1 });
  assert.equal(paid.next_invoice_at, billing.addMonths(new Date().toISOString().slice(0, 10), 1));

  await db.run('UPDATE clients SET next_invoice_at = current_date - 5 WHERE id = ?', c.id);
  assert.deepEqual(await billing.checkRenewals(), { newly_overdue: 1, suspended: 0 });
  await db.run('UPDATE clients SET next_invoice_at = current_date - 40 WHERE id = ?', c.id);
  assert.deepEqual(await billing.checkRenewals(), { newly_overdue: 0, suspended: 1 });

  const slug = (await db.get('SELECT slug FROM generated_sites WHERE prospect_id = ? LIMIT 1', p.id)).slug;
  assert.match(await page('sites', slug), /temporarily offline/);
  assert.doesNotMatch(await page('preview', slug), /temporarily offline/, 'the admin preview still works');

  const back = await billing.recordPayment(c.id, { amount: 15000, momo_txid: 'TX2' });
  assert.equal(back.status, 'active');
  assert.doesNotMatch(await page('sites', slug), /temporarily offline/);
  await assert.rejects(billing.recordPayment(c.id, { amount: 15000, momo_txid: 'TX2' }), (e) => e.code === '23505');
});

test('Google coordinates are purged after 30 days; OSM ones are kept', async () => {
  const p = await db.get("SELECT * FROM prospects WHERE name = 'Mama Rose Kiosk'");
  await db.run("UPDATE prospects SET lat = -1.9, lng = 30.0, coords_source = 'google', coords_fetched_at = now() - interval '31 days' WHERE id = ?", p.id);
  assert.deepEqual(await purgeGoogleCoords(), { cleared: 1 });
  assert.equal((await db.get('SELECT lat FROM prospects WHERE id = ?', p.id)).lat, null);
  assert.notEqual((await byRdb('102')).lat, null);
});

test('export and erase', async () => {
  const p = await byRdb('102');
  const x = await exportProspect(p.id);
  assert.equal(x.prospect.name, 'Kigali Dental Care');
  await eraseProspect(p.id);
  const after = await db.get('SELECT * FROM prospects WHERE id = ?', p.id);
  assert.equal(after.contact_email, null);
  assert.equal(after.do_not_contact, 1);
  const client = await db.get('SELECT prospect_id FROM clients LIMIT 1');
  await assert.rejects(eraseProspect(client.prospect_id), /client/);
});

test('a version that was never published is not put online', async () => {
  const row = await db.get('SELECT * FROM generated_sites WHERE published_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  assert.ok(row, 'a published site exists from the earlier test');
  assert.ok(await publish.siteResponse('sites', row.slug, ''));
  await db.run('UPDATE generated_sites SET published_at = NULL WHERE slug = ?', row.slug);
  assert.equal(await publish.siteResponse('sites', row.slug, ''), null);
  assert.ok(await publish.siteResponse('preview', row.slug, ''), 'the preview is still there');
  assert.equal(await publish.siteResponse('preview', 'no-such-site', ''), null);
});
