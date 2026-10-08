'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteforge-portal-'));
process.env.DATABASE_URL = 'pglite:memory';
process.env.DATA_DIR = TMP;
process.env.MOMO_PAY_NUMBER = '0784243475';
process.env.MOMO_PAY_NAME = 'Test Business';
process.env.MOMO_MERCHANT_CODE = '675148';
process.env.MOMO_MERCHANT_NAME = 'Tresor';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/core/db');
const { hashSecret } = require('../src/core/auth');
const accounts = require('../src/portal/accounts');
const services = require('../src/portal/services');
const orders = require('../src/portal/orders');
const { handle } = require('../src/api');
const { merchantUssd, ussdTelUri, qrSvg } = require('../src/portal/qr');

test.after(async () => {
  await db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const rejects = (promise, re) => assert.rejects(promise, (e) => re.test(e.message));
const findService = async (slug) => (await services.listAll()).find((s) => s.slug === slug);
const alineId = async () => (await db.get("SELECT id FROM portal_users WHERE phone = '+250781234567'")).id;

test('phone numbers and emails are normalised; login works with either', async () => {
  assert.equal(accounts.normalizePhone('078 123 4567'), '+250781234567');
  assert.equal(accounts.normalizePhone('+250 72-123-4567'), '+250721234567');
  assert.equal(accounts.normalizePhone('250731234567'), '+250731234567');
  assert.equal(accounts.normalizePhone('0712345678'), null, '071 is not a Rwandan mobile prefix');
  assert.equal(accounts.normalizeEmail(' Info@Hotel.RW '), 'info@hotel.rw');

  await accounts.createAccount({ name: 'Aline', company: 'Umucyo Hotel', phone: '0781234567', email: 'aline@umucyo.rw', password: 'kigali2026' });
  await assert.rejects(accounts.createAccount({ name: 'X', company: 'Other', phone: '+250781234567', password: 'longenough' }), /Enter your name/);
  await assert.rejects(accounts.createAccount({ name: 'Xavier', company: 'Other', phone: '+250781234567', password: 'longenough' }), /phone number already exists/);
  await assert.rejects(accounts.createAccount({ name: 'Xavier', company: 'Other', password: 'longenough' }), /phone number or an email/);
  await assert.rejects(accounts.createAccount({ name: 'Xavier', company: 'Other', email: 'x@y.rw', password: 'short' }), /at least 8/);

  assert.ok(await accounts.verifyLogin('0781234567', 'kigali2026'));
  assert.ok(await accounts.verifyLogin('ALINE@umucyo.rw', 'kigali2026'));
  assert.equal(await accounts.verifyLogin('0781234567', 'wrong-password'), null);
  assert.equal(await accounts.verifyLogin('0789999999', 'kigali2026'), null);
});

test('only priced, active services are offered', async () => {
  assert.equal((await services.listActive()).length, 0, 'seeded services start hidden until they have a price');
  assert.equal((await services.listAll()).length, services.SEED.length);
  const web = await findService('new-website');
  await rejects(services.saveService(web.id, { active: true }), /Set a price/);
  await services.saveService(web.id, { price: 300000, active: true });
  const added = await services.saveService(null, { name: 'Social media setup', price: 50000, active: true });
  assert.equal(added.slug, 'social-media-setup');
  assert.deepEqual((await services.listActive()).map((s) => s.name), ['New business website', 'Social media setup']);
});

test('order flow: 50% to start, work, 50% to receive the result', async () => {
  const uid = await alineId();
  const web = await findService('new-website');
  const hidden = await findService('chatbot');
  await rejects(orders.createOrder(uid, { service_id: hidden.id, details: 'A chatbot please, for our hotel' }), /services on offer/);

  const o = await orders.createOrder(uid, { service_id: web.id, details: 'A website for our hotel with rooms and photos.' });
  assert.equal(o.price, 300000);
  assert.equal(o.deposit, 150000);
  await services.saveService(web.id, { price: 400000 });
  assert.equal((await orders.getForClient(uid, o.id)).price, 300000, 'a later price change does not affect the order');

  let v = await orders.getForClient(uid, o.id);
  assert.deepEqual(v.due, { kind: 'deposit', amount: 150000 });
  await rejects(orders.postUpdate('tresor', o.id, { message: 'x', progress: 10 }), /only change while the work is in progress/);

  // Deposit: reported, rejected with a reason, sent again, confirmed.
  await rejects(orders.submitPayment(uid, o.id, { momo_txid: '12' }), /transaction ID/);
  const p1 = await orders.submitPayment(uid, o.id, { momo_txid: 'mp240928.1234.A', payer_phone: '0781234567' });
  assert.equal(p1.kind, 'deposit');
  assert.equal(p1.momo_txid, 'MP240928.1234.A');
  await rejects(orders.submitPayment(uid, o.id, { momo_txid: 'OTHER123456' }), /still checking/);
  await rejects(orders.reviewPayment('tresor', p1.id, { approve: false }), /Say why/);
  await orders.reviewPayment('tresor', p1.id, { approve: false, note: 'Not on our statement yet.' });
  const p2 = await orders.submitPayment(uid, o.id, { momo_txid: 'MP240928.1234.A' }); // the same ID may be sent again after a rejection
  await orders.reviewPayment('tresor', p2.id, { approve: true });
  v = await orders.getForClient(uid, o.id);
  assert.equal(v.status, 'in_progress');
  assert.equal(v.paid, 150000);
  assert.equal(v.due, null);
  await rejects(orders.cancelOrder('client', o.id, { userId: uid }), /payment is already recorded/);

  // Work, then finished: the result stays hidden until the balance is paid.
  await orders.postUpdate('tresor', o.id, { message: 'Design approved, building pages.', progress: 60 });
  await rejects(orders.markFinished('tresor', o.id, {}), /Describe what you are delivering/);
  await orders.markFinished('tresor', o.id, { result_url: 'https://umucyo.rw', delivery_note: 'Login: admin / sent by SMS' });
  v = await orders.getForClient(uid, o.id);
  assert.equal(v.status, 'awaiting_final');
  assert.deepEqual(v.due, { kind: 'final', amount: 150000 });
  assert.equal(v.delivery, null, 'nothing is handed over before the final payment');

  await rejects(orders.submitPayment(uid, o.id, { momo_txid: 'MP240928.1234.A' }), /already been used/);
  const p3 = await orders.submitPayment(uid, o.id, { momo_txid: 'MP241015.9999.B' });
  assert.equal(p3.kind, 'final');
  await orders.reviewPayment('tresor', p3.id, { approve: true });
  v = await orders.getForClient(uid, o.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.paid, 300000);
  assert.deepEqual(v.delivery, { note: 'Login: admin / sent by SMS', url: 'https://umucyo.rw' });
  assert.ok(v.updates.some((x) => /Design approved/.test(x.message)));
  await rejects(orders.submitPayment(uid, o.id, { momo_txid: 'MP241020.0000.C' }), /Nothing is due/);
});

test('a payment cannot be confirmed twice when two admins click at once', async () => {
  const uid = await alineId();
  const web = await findService('new-website');
  const o = await orders.createOrder(uid, { service_id: web.id, details: 'Race test: two admins, one payment.' });
  const p = await orders.submitPayment(uid, o.id, { momo_txid: 'MP260101.0001.R' });
  const results = await Promise.allSettled([
    orders.reviewPayment('tresor', p.id, { approve: true }),
    orders.reviewPayment('other', p.id, { approve: true })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const v = await orders.getForClient(uid, o.id);
  assert.equal(v.paid, o.deposit, 'the deposit is counted once');
  await orders.cancelOrder('admin', o.id, { reason: 'Test order.' });
});

test('a client can cancel only before paying; admins can cancel later', async () => {
  const uid = await alineId();
  const web = await findService('new-website');
  const a = await orders.createOrder(uid, { service_id: web.id, details: 'Second site for our restaurant.' });
  assert.equal((await orders.cancelOrder('client', a.id, { userId: uid })).status, 'cancelled');
  const b = await orders.createOrder(uid, { service_id: web.id, details: 'Third site for our shop please.' });
  await orders.submitPayment(uid, b.id, { momo_txid: 'MP241101.0001.D' });
  await rejects(orders.cancelOrder('client', b.id, { userId: uid }), /payment is already recorded/);
  await orders.cancelOrder('admin', b.id, { reason: 'Client changed their mind.' });
  const pay = await db.get("SELECT status FROM order_payments WHERE momo_txid = 'MP241101.0001.D'");
  assert.equal(pay.status, 'rejected', 'a pending payment on a cancelled order is closed');
});

test('deleting an account removes personal details but keeps orders', async () => {
  const u = await accounts.createAccount({ name: 'Jean', company: 'Jean Garage', email: 'jean@garage.rw', password: 'garage2026' });
  const web = await findService('new-website');
  const o = await orders.createOrder(u.id, { service_id: web.id, details: 'Website for the garage.' });
  await rejects(accounts.eraseAccount(u.id), /order in progress/);
  await orders.cancelOrder('client', o.id, { userId: u.id });
  const exp = await accounts.exportAccount(u.id);
  assert.equal(exp.account.email, 'jean@garage.rw');
  assert.equal(exp.orders.length, 1);
  await accounts.eraseAccount(u.id);
  const row = await db.get('SELECT * FROM portal_users WHERE id = ?', u.id);
  assert.equal(row.email, null);
  assert.equal(row.name, 'Deleted account');
  assert.equal(await accounts.verifyLogin('jean@garage.rw', 'garage2026'), null);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', u.id)).n, 1, 'the order record stays');
});

// ---------- over HTTP: logins are separate and orders are private ----------
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!(await handle(req, res, url, { ip: '127.0.0.1', secure: false }))) { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function client(base) {
  let jar = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar ? { Cookie: jar } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie();
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('HTTP: client and admin logins are separate; a client sees only their own orders', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await db.run('INSERT INTO admins (username, pass_hash) VALUES (?, ?)', 'tresor', await hashSecret('admin-password-1'));
    const admin = client(base), alice = client(base), bob = client(base), stranger = client(base);

    const pub = await stranger('GET', '/api/portal/services');
    assert.equal(pub.status, 200);
    assert.equal(pub.body.momo.number, '0788000000');
    assert.equal(pub.body.advance_percent, 50);
    assert.deepEqual(pub.body.momo.merchant, { code: '675148', name: 'Tresor', ussd: '*182*8*1*675148#', tel: 'tel:*182*8*1*675148%23', qr: '/api/portal/momo-qr.svg' });
    const qr = await fetch(base + '/api/portal/momo-qr.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg [^>]*viewBox="0 0 33 33"/, 'a 25-module code plus the quiet zone');
    assert.equal((await stranger('GET', '/api/portal/orders')).status, 401);
    assert.equal((await stranger('GET', '/api/portal/me')).body.user, null);
    assert.equal((await stranger('GET', '/api/me')).body.username, null, 'admin check: nobody logged in, no error');

    assert.equal((await alice('POST', '/api/portal/signup', { name: 'Alice', company: 'Alice Salon', phone: '0722000001', password: 'salon-2026' })).status, 200);
    assert.equal((await bob('POST', '/api/portal/signup', { name: 'Bob', company: 'Bob Shop', email: 'bob@shop.rw', password: 'shop-2026!' })).status, 200);
    const web = pub.body.services.find((s) => s.name === 'New business website');
    const order = await alice('POST', '/api/portal/orders', { service_id: web.id, details: 'A site for my salon with prices.' });
    assert.equal(order.status, 200);
    assert.equal(order.body.due.kind, 'deposit');

    // Bob cannot read, pay or cancel Alice's order: it looks like it does not exist.
    assert.equal((await bob('GET', `/api/portal/orders/${order.body.id}`)).status, 404);
    assert.equal((await bob('POST', `/api/portal/orders/${order.body.id}/payments`, { momo_txid: 'BOBTRIES123' })).status, 404);
    assert.equal((await bob('POST', `/api/portal/orders/${order.body.id}/cancel`, {})).status, 404);
    assert.equal((await bob('GET', '/api/portal/orders')).body.rows.length, 0);

    // A client login does not open admin routes, and an admin login does not open client routes.
    assert.equal((await alice('GET', '/api/orders')).status, 401);
    assert.equal((await alice('GET', '/api/prospects')).status, 401);
    assert.equal((await admin('POST', '/api/login', { username: 'tresor', password: 'admin-password-1' })).status, 200);
    assert.equal((await admin('GET', '/api/portal/orders')).status, 401);

    // Admin screens answer on Postgres.
    for (const p of ['/api/stats', '/api/prospects?q=salon&sort=name', '/api/opportunities?has_phone=1', '/api/clients', '/api/compliance', '/api/services', '/api/accounts']) {
      assert.equal((await admin('GET', p)).status, 200, p);
    }

    // The admin confirms Alice's deposit; Alice sees the work start.
    await alice('POST', `/api/portal/orders/${order.body.id}/payments`, { momo_txid: 'ALICEPAY001' });
    const adminOrder = await admin('GET', `/api/orders/${order.body.id}`);
    const pending = adminOrder.body.payments.find((p) => p.status === 'pending');
    assert.equal((await admin('POST', `/api/order-payments/${pending.id}/review`, { approve: true })).status, 200);
    assert.equal((await alice('GET', `/api/portal/orders/${order.body.id}`)).body.status, 'in_progress');

    // Changing the password logs other sessions out.
    const aliceOther = client(base);
    await aliceOther('POST', '/api/portal/login', { identifier: '0722000001', password: 'salon-2026' });
    assert.equal((await alice('POST', '/api/portal/password', { current: 'salon-2026', next: 'new-salon-pass' })).status, 200);
    assert.equal((await alice('GET', '/api/portal/me')).status, 200, 'the device that changed it stays logged in');
    const other = await aliceOther('GET', '/api/portal/me');
    assert.equal(other.status, 200, '"am I logged in?" answers normally, without an error in the browser console');
    assert.equal(other.body.user, null, 'the other device is logged out');

    // Too many wrong passwords from one address are refused for a while (kept in the database).
    const guesser = client(base);
    for (let i = 0; i < 5; i++) assert.equal((await guesser('POST', '/api/login', { username: 'tresor', password: 'wrong' })).status, 401);
    assert.equal((await guesser('POST', '/api/login', { username: 'tresor', password: 'admin-password-1' })).status, 429);
    await db.run('DELETE FROM rate_limits');

    // The scheduled-work routes need the cron secret.
    process.env.CRON_SECRET = 'test-cron-secret-0123456789';
    assert.equal((await stranger('POST', '/api/cron/work', {})).status, 401);
    assert.equal((await stranger('POST', '/api/cron/work', {}, { Authorization: 'Bearer wrong-secret-0123456789ab' })).status, 401);
    process.env.WORK_SECONDS = '16';
    const work = await stranger('POST', '/api/cron/work', {}, { Authorization: 'Bearer test-cron-secret-0123456789' });
    assert.equal(work.status, 200);
    assert.deepEqual(work.body, { ok: 0, failed: 0 });
    const daily = await stranger('POST', '/api/cron/daily', {}, { Authorization: 'Bearer test-cron-secret-0123456789' });
    assert.equal(daily.status, 200);
    assert.ok('renewals' in daily.body);
  } finally {
    server.close();
  }
});

test('MoMo Pay: the USSD code, its tel: link and the QR code', () => {
  assert.equal(merchantUssd('675148'), '*182*8*1*675148#');
  assert.equal(ussdTelUri('*182*8*1*675148#'), 'tel:*182*8*1*675148%23', '# must be escaped in a URI or the dialer drops it');
  const svg = qrSvg('tel:*182*8*1*675148%23');
  assert.match(svg, /<path d="M\d/);
  assert.ok(!/script/i.test(svg));
});

test('translations: services, stored update codes and the client language', async () => {
  const web = await findService('new-website');
  assert.equal(web.i18n.rw.name, "Urubuga rushya rw'ubucuruzi");
  assert.equal(web.i18n.fr.name, "Nouveau site web d'entreprise");
  const saved = await services.saveService(web.id, { i18n: { rw: { name: 'Urubuga rushya', description: '' }, fr: { name: '', description: '' } } });
  assert.equal(saved.i18n.rw.name, 'Urubuga rushya');
  assert.equal(saved.i18n.fr, undefined, 'an emptied translation is removed, so clients see English');
  assert.equal((await services.listActive()).find((s) => s.id === web.id).i18n.rw.name, 'Urubuga rushya');

  const u = await accounts.createAccount({ name: 'Claudine', company: 'Salon Claudine', phone: '0729876543', password: 'salon-claudine', lang: 'fr' });
  assert.equal(u.lang, 'fr');
  assert.equal((await accounts.setLang(u.id, 'rw')).lang, 'rw');
  assert.equal((await accounts.setLang(u.id, 'xx')).lang, 'en', 'unknown languages fall back to English');

  const o = await orders.createOrder(u.id, { service_id: web.id, details: 'Website for the salon please.' });
  await orders.submitPayment(u.id, o.id, { momo_txid: 'MP261001.0001.F' });
  const v = await orders.getForClient(u.id, o.id);
  assert.deepEqual(v.updates.map((x) => x.code), ['order_placed', 'payment_reported']);
  assert.deepEqual(v.updates[0].params, { pct: 50, amount: o.deposit });
  assert.deepEqual(v.updates[1].params, { kind: 'deposit', amount: o.deposit, txid: 'MP261001.0001.F' });
  assert.equal(v.service_i18n.rw.name, 'Urubuga rushya');
});

test('older English system updates get codes so they can be translated', async () => {
  const o = await db.get('SELECT id FROM orders ORDER BY id LIMIT 1');
  const add = async (message) => (await db.get("INSERT INTO order_updates (order_id, author, message) VALUES (?, 'system', ?) RETURNING id", o.id, message)).id;
  const a = await add('Final payment of RWF 150,000 reported (MoMo ID MP1.2.3). We will confirm it soon.');
  const b = await add('Order cancelled. Client changed their mind.');
  const c = await add('Something we never wrote automatically.');
  await orders.backfillUpdateCodes();
  const row = (id) => db.get('SELECT code, params FROM order_updates WHERE id = ?', id);
  assert.equal((await row(a)).code, 'payment_reported');
  assert.deepEqual(JSON.parse((await row(a)).params), { kind: 'final', amount: 150000, txid: 'MP1.2.3' });
  assert.deepEqual(JSON.parse((await row(b)).params), { by: 'admin', reason: 'Client changed their mind.' });
  assert.equal((await row(c)).code, null, 'unknown text is left alone and shown as written');
});
