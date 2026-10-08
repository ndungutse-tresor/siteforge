'use strict';
const { db, tx } = require('../core/db');
const { ADVANCE_PERCENT } = require('../core/config');
const { normalizePhone } = require('./accounts');

// Orders from the client portal. Money rule: the client pays ADVANCE_PERCENT (50%) before work
// starts and the rest when the work is finished; the result is handed over after the final payment.
//
//   awaiting_deposit --deposit confirmed--> in_progress --admin marks finished--> awaiting_final
//   awaiting_final --final payment confirmed--> completed
//   (cancelled from any state before completion)

const STATUSES = ['awaiting_deposit', 'in_progress', 'awaiting_final', 'completed', 'cancelled'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const rwf = (n) => `RWF ${Number(n || 0).toLocaleString('en-US')}`;

function depositFor(price) {
  return Math.round((price * ADVANCE_PERCENT) / 100);
}

// What the client has to pay now, and for which part.
function amountDue(o) {
  if (o.status === 'awaiting_deposit') return { kind: 'deposit', amount: o.deposit };
  if (o.status === 'awaiting_final') return { kind: 'final', amount: o.price - o.deposit };
  return null;
}

// System updates carry a code and values so the portal can show them in the client's language;
// message is the English text (used by the admin panel and as a fallback).
async function addUpdate(orderId, author, message, { name = null, progress = null, code = null, params = null } = {}) {
  await db.run('INSERT INTO order_updates (order_id, author, author_name, message, progress, code, params) VALUES (?, ?, ?, ?, ?, ?, ?)',
    orderId, author, name, message, progress, code, params ? JSON.stringify(params) : null);
  await db.run('UPDATE orders SET updated_at = now() WHERE id = ?', orderId);
}

// Updates written before codes existed get one from their English text, so they translate too.
const num = (s) => Number(String(s).replace(/,/g, ''));
const LEGACY = [
  [/^Order placed\. Pay the (\d+)% deposit of RWF ([\d,]+) to start the work\.$/, (m) => ['order_placed', { pct: +m[1], amount: num(m[2]) }]],
  [/^(Deposit|Final payment) of RWF ([\d,]+) reported \(MoMo ID (\S+)\)\. We will confirm it soon\.$/,
    (m) => ['payment_reported', { kind: m[1] === 'Deposit' ? 'deposit' : 'final', amount: num(m[2]), txid: m[3] }]],
  [/^Payment (\S+) could not be confirmed: ([\s\S]*) Please check and send the correct transaction ID\.$/, (m) => ['payment_rejected', { txid: m[1], reason: m[2] }]],
  [/^Deposit of RWF ([\d,]+) confirmed\. Work has started\.$/, (m) => ['deposit_confirmed', { amount: num(m[1]) }]],
  [/^Final payment of RWF ([\d,]+) confirmed\./, (m) => ['final_confirmed', { amount: num(m[1]) }]],
  [/^The work is finished\. Pay the remaining RWF ([\d,]+) to receive it\.$/, (m) => ['work_finished', { amount: num(m[1]) }]],
  [/^Order cancelled( by you)?\.\s*([\s\S]*)$/, (m) => ['order_cancelled', { by: m[1] ? 'client' : 'admin', reason: m[2] }]]
];

async function backfillUpdateCodes() {
  const rows = await db.all("SELECT id, message FROM order_updates WHERE author = 'system' AND code IS NULL");
  for (const r of rows) {
    for (const [re, toCode] of LEGACY) {
      const m = r.message.match(re);
      if (m) {
        const [code, params] = toCode(m);
        await db.run('UPDATE order_updates SET code = ?, params = ? WHERE id = ?', code, JSON.stringify(params), r.id);
        break;
      }
    }
  }
}

// forUpdate locks the order row until the transaction ends, so two requests can't change it at once.
async function getOrder(orderId, { forUpdate = false } = {}) {
  const o = await db.get(`SELECT * FROM orders WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, orderId);
  if (!o) throw fail(404, 'Order not found.');
  return o;
}

// A client may only ever see their own orders; anything else looks like "not found".
async function getOwnOrder(userId, orderId, { forUpdate = false } = {}) {
  const o = await db.get(`SELECT * FROM orders WHERE id = ? AND user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, orderId, userId);
  if (!o) throw fail(404, 'Order not found.');
  return o;
}

async function createOrder(userId, b) {
  const s = await db.get('SELECT * FROM services WHERE id = ? AND active = 1 AND price > 0', Number(b.service_id));
  if (!s) throw fail(400, 'Choose one of the services on offer.');
  const details = String(b.details || '').trim().slice(0, 3000);
  const website = String(b.website || '').trim().slice(0, 200) || null;
  if (details.length < 10) throw fail(400, 'Tell us in a sentence or two what you need.');
  const open = (await db.get("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'awaiting_deposit'", userId)).n;
  if (open >= 5) throw fail(429, 'You have 5 orders waiting for a deposit. Pay or cancel one first.');
  return tx(async () => {
    const o = await db.get(`INSERT INTO orders (user_id, service_id, service_name, price, deposit, website, details)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, userId, s.id, s.name, s.price, depositFor(s.price), website, details);
    await addUpdate(o.id, 'system', `Order placed. Pay the ${ADVANCE_PERCENT}% deposit of ${rwf(o.deposit)} to start the work.`,
      { code: 'order_placed', params: { pct: ADVANCE_PERCENT, amount: o.deposit } });
    return o;
  });
}

// The client reports a MoMo payment for what is due now. An admin must confirm it.
async function submitPayment(userId, orderId, b) {
  const txid = String(b.momo_txid || '').replace(/\s+/g, '').toUpperCase();
  const payerRaw = String(b.payer_phone || '').trim();
  const payer = payerRaw ? normalizePhone(payerRaw) : null;
  return tx(async () => {
    const o = await getOwnOrder(userId, orderId, { forUpdate: true });
    const due = amountDue(o);
    if (!due) throw fail(409, 'Nothing is due on this order right now.');
    if (await db.get("SELECT 1 FROM order_payments WHERE order_id = ? AND status = 'pending'", o.id)) {
      throw fail(409, 'We are still checking your last payment. You will see the result here soon.');
    }
    if (!/^[A-Z0-9.-]{6,40}$/.test(txid)) throw fail(400, 'Enter the transaction ID from your MoMo confirmation SMS.');
    // The same MoMo transaction can't pay for two things (here or in hosting payments).
    if (await db.get("SELECT 1 FROM order_payments WHERE momo_txid = ? AND status <> 'rejected'", txid) || await db.get('SELECT 1 FROM payments WHERE momo_txid = ?', txid)) {
      throw fail(409, 'This transaction ID has already been used.');
    }
    if (payerRaw && !payer) throw fail(400, 'Enter the MoMo number you paid from, for example 078 123 4567.');
    let p;
    try {
      p = await db.get(`INSERT INTO order_payments (order_id, kind, amount, momo_txid, payer_phone)
        VALUES (?, ?, ?, ?, ?) RETURNING *`, o.id, due.kind, due.amount, txid, payer);
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'This transaction ID has already been used.');
      throw e;
    }
    await addUpdate(o.id, 'system', `${due.kind === 'deposit' ? 'Deposit' : 'Final payment'} of ${rwf(due.amount)} reported (MoMo ID ${txid}). We will confirm it soon.`,
      { code: 'payment_reported', params: { kind: due.kind, amount: due.amount, txid } });
    return p;
  });
}

// Admin checks the MoMo statement, then confirms or rejects (with a reason the client sees).
async function reviewPayment(adminName, paymentId, { approve, note }) {
  const reason = String(note || '').trim().slice(0, 500);
  if (!approve && !reason) throw fail(400, 'Say why the payment is rejected; the client will see it.');
  return tx(async () => {
    const p = await db.get('SELECT * FROM order_payments WHERE id = ? FOR UPDATE', paymentId);
    if (!p) throw fail(404, 'Payment not found.');
    if (p.status !== 'pending') throw fail(409, 'This payment was already reviewed.');
    const o = await getOrder(p.order_id, { forUpdate: true });
    const expected = amountDue(o);
    if (approve && (!expected || expected.kind !== p.kind)) throw fail(409, 'The order has moved on; this payment no longer matches what is due.');
    await db.run('UPDATE order_payments SET status = ?, reviewed_at = now(), reviewed_by = ?, review_note = ? WHERE id = ?',
      approve ? 'confirmed' : 'rejected', adminName, reason || null, p.id);
    if (!approve) {
      await addUpdate(o.id, 'system', `Payment ${p.momo_txid} could not be confirmed: ${reason} Please check and send the correct transaction ID.`,
        { code: 'payment_rejected', params: { txid: p.momo_txid, reason } });
    } else if (p.kind === 'deposit') {
      await db.run("UPDATE orders SET status = 'in_progress', started_at = now() WHERE id = ?", o.id);
      await addUpdate(o.id, 'system', `Deposit of ${rwf(p.amount)} confirmed. Work has started.`, { code: 'deposit_confirmed', params: { amount: p.amount } });
    } else {
      await db.run("UPDATE orders SET status = 'completed', completed_at = now(), progress = 100 WHERE id = ?", o.id);
      await addUpdate(o.id, 'system', `Final payment of ${rwf(p.amount)} confirmed. Thank you! Your order is complete.`, { code: 'final_confirmed', params: { amount: p.amount } });
    }
    return getOrder(o.id);
  });
}

// Progress note from us, visible to the client.
async function postUpdate(adminName, orderId, b) {
  const message = String(b.message || '').trim().slice(0, 2000);
  return tx(async () => {
    const o = await getOrder(orderId, { forUpdate: true });
    if (o.status === 'cancelled') throw fail(409, 'This order is cancelled.');
    if (!message) throw fail(400, 'Write the update for the client.');
    let progress = null;
    if (b.progress !== undefined && b.progress !== '' && b.progress !== null) {
      progress = Math.round(Number(b.progress));
      if (!(progress >= 0 && progress <= 100)) throw fail(400, 'Progress is a number from 0 to 100.');
      if (o.status !== 'in_progress') throw fail(409, 'Progress can only change while the work is in progress.');
    }
    if (progress !== null) await db.run('UPDATE orders SET progress = ? WHERE id = ?', progress, o.id);
    await addUpdate(o.id, 'admin', message, { name: adminName, progress });
    return getOrder(o.id);
  });
}

// Question or note from the client.
async function clientMessage(userId, orderId, b) {
  const o = await getOwnOrder(userId, orderId);
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) throw fail(400, 'Write your message.');
  const u = await db.get('SELECT name FROM portal_users WHERE id = ?', userId);
  await addUpdate(o.id, 'client', message, { name: u?.name || null });
  return { ok: true };
}

// Work done: the client is asked for the rest. What we deliver stays hidden until they pay it.
async function markFinished(adminName, orderId, b) {
  const note = String(b.delivery_note || '').trim().slice(0, 3000);
  const url = String(b.result_url || '').trim().slice(0, 300);
  return tx(async () => {
    const o = await getOrder(orderId, { forUpdate: true });
    if (o.status !== 'in_progress') throw fail(409, 'Only an order in progress can be marked finished.');
    if (!note && !url) throw fail(400, 'Describe what you are delivering (a link, login details or a note). The client sees it after the final payment.');
    if (url && !/^https?:\/\//i.test(url)) throw fail(400, 'The result link must start with https:// or http://.');
    await db.run(`UPDATE orders SET status = 'awaiting_final', progress = 100, finished_at = now(),
      delivery_note = ?, result_url = ? WHERE id = ?`, note || null, url || null, o.id);
    await addUpdate(o.id, 'system', `The work is finished. Pay the remaining ${rwf(o.price - o.deposit)} to receive it.`,
      { progress: 100, code: 'work_finished', params: { amount: o.price - o.deposit } });
    return getOrder(o.id);
  });
}

// Clients can cancel only before any money is confirmed; admins can cancel anything not completed.
// Refunds of confirmed money are handled outside the system, by agreement.
async function cancelOrder(actor, orderId, { userId, reason } = {}) {
  const why = String(reason || '').trim().slice(0, 500);
  return tx(async () => {
    const o = actor === 'client' ? await getOwnOrder(userId, orderId, { forUpdate: true }) : await getOrder(orderId, { forUpdate: true });
    if (o.status === 'completed' || o.status === 'cancelled') throw fail(409, `This order is already ${o.status}.`);
    const paid = (await db.get("SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ? AND status IN ('pending', 'confirmed')", o.id)).n;
    if (actor === 'client' && paid) throw fail(409, 'A payment is already recorded on this order. Send us a message to cancel it.');
    await db.run("UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = ?", o.id);
    await db.run("UPDATE order_payments SET status = 'rejected', reviewed_at = now(), review_note = 'Order cancelled' WHERE order_id = ? AND status = 'pending'", o.id);
    await addUpdate(o.id, 'system', `Order cancelled${actor === 'client' ? ' by you' : ''}.${why ? ' ' + why : ''}`,
      { code: 'order_cancelled', params: { by: actor, reason: why } });
    return getOrder(o.id);
  });
}

const paymentsFor = (orderId) => db.all('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id', orderId);
const updatesFor = (orderId) => db.all('SELECT * FROM order_updates WHERE order_id = ? ORDER BY id', orderId);

// ---------- what the client sees ----------
async function serviceI18n(serviceId) {
  try { return JSON.parse((await db.get('SELECT i18n FROM services WHERE id = ?', serviceId))?.i18n || '{}'); } catch (e) { return {}; }
}
const parseParams = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

async function clientView(o) {
  const payments = (await paymentsFor(o.id)).map(({ reviewed_by, ...p }) => p);
  const updates = await updatesFor(o.id);
  return {
    id: o.id, service_name: o.service_name, service_i18n: await serviceI18n(o.service_id), price: o.price, deposit: o.deposit, balance: o.price - o.deposit,
    website: o.website, details: o.details, status: o.status, progress: o.progress,
    created_at: o.created_at, updated_at: o.updated_at, started_at: o.started_at, finished_at: o.finished_at,
    completed_at: o.completed_at, cancelled_at: o.cancelled_at,
    due: amountDue(o), payment_pending: payments.some((p) => p.status === 'pending'),
    paid: payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0),
    payments,
    updates: updates.map((u) => ({ id: u.id, author: u.author, author_name: u.author === 'client' ? u.author_name : null,
      message: u.message, code: u.code, params: parseParams(u.params), progress: u.progress, created_at: u.created_at })),
    // The deliverable is handed over only after the final payment.
    delivery: o.status === 'completed' ? { note: o.delivery_note, url: o.result_url } : null
  };
}

async function listForClient(userId) {
  const rows = await db.all(`SELECT o.*, s.i18n AS service_i18n_raw,
      EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id AND p.status = 'pending') AS payment_pending
    FROM orders o LEFT JOIN services s ON s.id = o.service_id WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC`, userId);
  return rows.map((o) => ({
    id: o.id, service_name: o.service_name, service_i18n: parseParams(o.service_i18n_raw) || {}, price: o.price, status: o.status, progress: o.progress,
    due: amountDue(o), payment_pending: Boolean(o.payment_pending), created_at: o.created_at, updated_at: o.updated_at
  }));
}

async function getForClient(userId, orderId) {
  return clientView(await getOwnOrder(userId, orderId));
}

// The client's home screen: what needs their action, and what happened lately across all orders.
async function overviewForClient(userId) {
  const rows = await listForClient(userId);
  const open = rows.filter((o) => !['completed', 'cancelled'].includes(o.status));
  const toPay = open.filter((o) => o.due && !o.payment_pending);
  const recent = (await db.all(`SELECT u.id, u.order_id, u.author, u.message, u.code, u.params, u.progress, u.created_at, o.service_name, s.i18n AS service_i18n_raw
    FROM order_updates u JOIN orders o ON o.id = u.order_id LEFT JOIN services s ON s.id = o.service_id
    WHERE o.user_id = ? ORDER BY u.id DESC LIMIT 8`, userId))
    .map(({ params, service_i18n_raw, ...u }) => ({ ...u, params: parseParams(params), service_i18n: parseParams(service_i18n_raw) || {} }));
  return {
    counts: { open: open.length, in_progress: open.filter((o) => o.status === 'in_progress').length,
      completed: rows.filter((o) => o.status === 'completed').length, total: rows.length },
    to_pay: toPay, to_pay_total: toPay.reduce((s, o) => s + o.due.amount, 0),
    checking: open.filter((o) => o.payment_pending),
    open, recent
  };
}

// ---------- what the admin sees ----------
async function listForAdmin({ status } = {}) {
  const where = STATUSES.includes(status) ? 'WHERE o.status = ?' : '';
  return db.all(`SELECT o.*, u.name AS client_name, u.company, u.phone, u.email,
      (SELECT COUNT(*) FROM order_payments p WHERE p.order_id = o.id AND p.status = 'pending') AS pending_payments,
      (SELECT COALESCE(SUM(amount), 0) FROM order_payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS paid
    FROM orders o JOIN portal_users u ON u.id = o.user_id ${where}
    ORDER BY pending_payments DESC, o.updated_at DESC`, ...(where ? [status] : []));
}

async function adminSummary() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')) counts[r.status] = r.n;
  return {
    counts,
    pending_payments: (await db.get("SELECT COUNT(*) AS n FROM order_payments WHERE status = 'pending'")).n,
    accounts: (await db.get('SELECT COUNT(*) AS n FROM portal_users WHERE erased_at IS NULL')).n,
    received: (await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM order_payments WHERE status = 'confirmed'")).n
  };
}

async function getForAdmin(orderId) {
  const o = await getOrder(orderId);
  const u = await db.get('SELECT id, name, company, phone, email, lang, created_at, erased_at FROM portal_users WHERE id = ?', o.user_id);
  return { ...o, balance: o.price - o.deposit, due: amountDue(o), client: u, payments: await paymentsFor(o.id), updates: await updatesFor(o.id) };
}

module.exports = {
  STATUSES, ADVANCE_PERCENT, backfillUpdateCodes, depositFor, amountDue, createOrder, submitPayment, reviewPayment, postUpdate,
  clientMessage, markFinished, cancelOrder, listForClient, getForClient, overviewForClient, listForAdmin, getForAdmin, adminSummary
};
