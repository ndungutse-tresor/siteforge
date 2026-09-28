'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteforge-portal-'));
process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = TMP;
process.env.MOMO_PAY_NUMBER = '0788000000';
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

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const rejects = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

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

test('only priced, active services are offered', () => {
  assert.equal(services.listActive().length, 0, 'seeded services start hidden until they have a price');
  assert.equal(services.listAll().length, services.SEED.length);
  const web = services.listAll().find((s) => s.slug === 'new-website');
  rejects(() => services.saveService(web.id, { active: true }), /Set a price/);
  services.saveService(web.id, { price: 300000, active: true });
  const added = services.saveService(null, { name: 'Social media setup', price: 50000, active: true });
  assert.equal(added.slug, 'social-media-setup');
  assert.deepEqual(services.listActive().map((s) => s.name), ['New business website', 'Social media setup']);
});

test('order flow: 50% to start, work, 50% to receive the result', () => {
  const u = db.prepare("SELECT * FROM portal_users WHERE phone = '+250781234567'").get();
  const web = services.listAll().find((s) => s.slug === 'new-website');
  const hidden = services.listAll().find((s) => s.slug === 'chatbot');
  rejects(() => orders.createOrder(u.id, { service_id: hidden.id, details: 'A chatbot please, for our hotel' }), /services on offer/);

  const o = orders.createOrder(u.id, { service_id: web.id, details: 'A website for our hotel with rooms and photos.' });
  assert.equal(o.price, 300000);
  assert.equal(o.deposit, 150000);
  services.saveService(web.id, { price: 400000 });
  assert.equal(orders.getForClient(u.id, o.id).price, 300000, 'a later price change does not affect the order');

  let v = orders.getForClient(u.id, o.id);
  assert.deepEqual(v.due, { kind: 'deposit', amount: 150000 });
  rejects(() => orders.postUpdate('tresor', o.id, { message: 'x', progress: 10 }), /only change while the work is in progress/);

  // Deposit: reported, rejected with a reason, sent again, confirmed.
  rejects(() => orders.submitPayment(u.id, o.id, { momo_txid: '12' }), /transaction ID/);
  const p1 = orders.submitPayment(u.id, o.id, { momo_txid: 'mp240928.1234.A', payer_phone: '0781234567' });
  assert.equal(p1.kind, 'deposit');
  assert.equal(p1.momo_txid, 'MP240928.1234.A');
  rejects(() => orders.submitPayment(u.id, o.id, { momo_txid: 'OTHER123456' }), /still checking/);
  rejects(() => orders.reviewPayment('tresor', p1.id, { approve: false }), /Say why/);
  orders.reviewPayment('tresor', p1.id, { approve: false, note: 'Not on our statement yet.' });
  const p2 = orders.submitPayment(u.id, o.id, { momo_txid: 'MP240928.1234.A' }); // the same ID may be sent again after a rejection
  orders.reviewPayment('tresor', p2.id, { approve: true });
  v = orders.getForClient(u.id, o.id);
  assert.equal(v.status, 'in_progress');
  assert.equal(v.paid, 150000);
  assert.equal(v.due, null);
  rejects(() => orders.cancelOrder('client', o.id, { userId: u.id }), /payment is already recorded/);

  // Work, then finished: the result stays hidden until the balance is paid.
  orders.postUpdate('tresor', o.id, { message: 'Design approved, building pages.', progress: 60 });
  rejects(() => orders.markFinished('tresor', o.id, {}), /Describe what you are delivering/);
  orders.markFinished('tresor', o.id, { result_url: 'https://umucyo.rw', delivery_note: 'Login: admin / sent by SMS' });
  v = orders.getForClient(u.id, o.id);
  assert.equal(v.status, 'awaiting_final');
  assert.deepEqual(v.due, { kind: 'final', amount: 150000 });
  assert.equal(v.delivery, null, 'nothing is handed over before the final payment');

  rejects(() => orders.submitPayment(u.id, o.id, { momo_txid: 'MP240928.1234.A' }), /already been used/);
  const p3 = orders.submitPayment(u.id, o.id, { momo_txid: 'MP241015.9999.B' });
  assert.equal(p3.kind, 'final');
  orders.reviewPayment('tresor', p3.id, { approve: true });
  v = orders.getForClient(u.id, o.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.paid, 300000);
  assert.deepEqual(v.delivery, { note: 'Login: admin / sent by SMS', url: 'https://umucyo.rw' });
  assert.ok(v.updates.some((x) => /Design approved/.test(x.message)));
  rejects(() => orders.submitPayment(u.id, o.id, { momo_txid: 'MP241020.0000.C' }), /Nothing is due/);
});

test('a client can cancel only before paying; admins can cancel later', () => {
  const u = db.prepare("SELECT * FROM portal_users WHERE phone = '+250781234567'").get();
  const web = services.listAll().find((s) => s.slug === 'new-website');
  const a = orders.createOrder(u.id, { service_id: web.id, details: 'Second site for our restaurant.' });
  assert.equal(orders.cancelOrder('client', a.id, { userId: u.id }).status, 'cancelled');
  const b = orders.createOrder(u.id, { service_id: web.id, details: 'Third site for our shop please.' });
  orders.submitPayment(u.id, b.id, { momo_txid: 'MP241101.0001.D' });
  rejects(() => orders.cancelOrder('client', b.id, { userId: u.id }), /payment is already recorded/);
  orders.cancelOrder('admin', b.id, { reason: 'Client changed their mind.' });
  const pay = db.prepare("SELECT status FROM order_payments WHERE momo_txid = 'MP241101.0001.D'").get();
  assert.equal(pay.status, 'rejected', 'a pending payment on a cancelled order is closed');
});

test('deleting an account removes personal details but keeps orders', async () => {
  const u = await accounts.createAccount({ name: 'Jean', company: 'Jean Garage', email: 'jean@garage.rw', password: 'garage2026' });
  const web = services.listAll().find((s) => s.slug === 'new-website');
  const o = orders.createOrder(u.id, { service_id: web.id, details: 'Website for the garage.' });
  rejects(() => accounts.eraseAccount(u.id), /order in progress/);
  orders.cancelOrder('client', o.id, { userId: u.id });
  const exp = accounts.exportAccount(u.id);
  assert.equal(exp.account.email, 'jean@garage.rw');
  assert.equal(exp.orders.length, 1);
  accounts.eraseAccount(u.id);
  const row = db.prepare('SELECT * FROM portal_users WHERE id = ?').get(u.id);
  assert.equal(row.email, null);
  assert.equal(row.name, 'Deleted account');
  assert.equal(await accounts.verifyLogin('jean@garage.rw', 'garage2026'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(u.id).n, 1, 'the order record stays');
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
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar ? { Cookie: jar } : {}) },
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
    db.prepare('INSERT INTO admins (username, pass_hash) VALUES (?, ?)').run('tresor', await hashSecret('admin-password-1'));
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
  const web = services.listAll().find((s) => s.slug === 'new-website');
  assert.equal(web.i18n.rw.name, "Urubuga rushya rw'ubucuruzi");
  assert.equal(web.i18n.fr.name, "Nouveau site web d'entreprise");
  const saved = services.saveService(web.id, { i18n: { rw: { name: 'Urubuga rushya', description: '' }, fr: { name: '', description: '' } } });
  assert.equal(saved.i18n.rw.name, 'Urubuga rushya');
  assert.equal(saved.i18n.fr, undefined, 'an emptied translation is removed, so clients see English');
  assert.equal(services.listActive().find((s) => s.id === web.id).i18n.rw.name, 'Urubuga rushya');

  const u = await accounts.createAccount({ name: 'Claudine', company: 'Salon Claudine', phone: '0729876543', password: 'salon-claudine', lang: 'fr' });
  assert.equal(u.lang, 'fr');
  assert.equal(accounts.setLang(u.id, 'rw').lang, 'rw');
  assert.equal(accounts.setLang(u.id, 'xx').lang, 'en', 'unknown languages fall back to English');

  const o = orders.createOrder(u.id, { service_id: web.id, details: 'Website for the salon please.' });
  orders.submitPayment(u.id, o.id, { momo_txid: 'MP261001.0001.F' });
  const v = orders.getForClient(u.id, o.id);
  assert.deepEqual(v.updates.map((x) => x.code), ['order_placed', 'payment_reported']);
  assert.deepEqual(v.updates[0].params, { pct: 50, amount: o.deposit });
  assert.deepEqual(v.updates[1].params, { kind: 'deposit', amount: o.deposit, txid: 'MP261001.0001.F' });
  assert.equal(v.service_i18n.rw.name, 'Urubuga rushya');
});

test('older English system updates get codes so they can be translated', () => {
  const o = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get();
  const add = db.prepare("INSERT INTO order_updates (order_id, author, message) VALUES (?, 'system', ?) RETURNING id");
  const a = add.get(o.id, 'Final payment of RWF 150,000 reported (MoMo ID MP1.2.3). We will confirm it soon.').id;
  const b = add.get(o.id, 'Order cancelled. Client changed their mind.').id;
  const c = add.get(o.id, 'Something we never wrote automatically.').id;
  orders.backfillUpdateCodes();
  const row = (id) => db.prepare('SELECT code, params FROM order_updates WHERE id = ?').get(id);
  assert.equal(row(a).code, 'payment_reported');
  assert.deepEqual(JSON.parse(row(a).params), { kind: 'final', amount: 150000, txid: 'MP1.2.3' });
  assert.deepEqual(JSON.parse(row(b).params), { by: 'admin', reason: 'Client changed their mind.' });
  assert.equal(row(c).code, null, 'unknown text is left alone and shown as written');
});
