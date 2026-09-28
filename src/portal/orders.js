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
function addUpdate(orderId, author, message, { name = null, progress = null, code = null, params = null } = {}) {
  db.prepare('INSERT INTO order_updates (order_id, author, author_name, message, progress, code, params) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, author, name, message, progress, code, params ? JSON.stringify(params) : null);
  db.prepare("UPDATE orders SET updated_at = datetime('now') WHERE id = ?").run(orderId);
}

// Updates written before codes existed get one from their English text, so they translate too.
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
const num = (s) => Number(String(s).replace(/,/g, ''));

function backfillUpdateCodes() {
  const rows = db.prepare("SELECT id, message FROM order_updates WHERE author = 'system' AND code IS NULL").all();
  const set = db.prepare('UPDATE order_updates SET code = ?, params = ? WHERE id = ?');
  for (const r of rows) {
    for (const [re, toCode] of LEGACY) {
      const m = r.message.match(re);
      if (m) { const [code, params] = toCode(m); set.run(code, JSON.stringify(params), r.id); break; }
    }
  }
}
backfillUpdateCodes();

function getOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw fail(404, 'Order not found.');
  return o;
}

// A client may only ever see their own orders; anything else looks like "not found".
function getOwnOrder(userId, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  if (!o) throw fail(404, 'Order not found.');
  return o;
}

function createOrder(userId, b) {
  const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1 AND price > 0').get(Number(b.service_id));
  if (!s) throw fail(400, 'Choose one of the services on offer.');
  const details = String(b.details || '').trim().slice(0, 3000);
  const website = String(b.website || '').trim().slice(0, 200) || null;
  if (details.length < 10) throw fail(400, 'Tell us in a sentence or two what you need.');
  const open = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'awaiting_deposit'").get(userId).n;
  if (open >= 5) throw fail(429, 'You have 5 orders waiting for a deposit. Pay or cancel one first.');
  return tx(() => {
    const o = db.prepare(`INSERT INTO orders (user_id, service_id, service_name, price, deposit, website, details)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(userId, s.id, s.name, s.price, depositFor(s.price), website, details);
    addUpdate(o.id, 'system', `Order placed. Pay the ${ADVANCE_PERCENT}% deposit of ${rwf(o.deposit)} to start the work.`,
      { code: 'order_placed', params: { pct: ADVANCE_PERCENT, amount: o.deposit } });
    return o;
  });
}

// The client reports a MoMo payment for what is due now. An admin must confirm it.
function submitPayment(userId, orderId, b) {
  const o = getOwnOrder(userId, orderId);
  const due = amountDue(o);
  if (!due) throw fail(409, 'Nothing is due on this order right now.');
  if (db.prepare("SELECT 1 FROM order_payments WHERE order_id = ? AND status = 'pending'").get(o.id)) {
    throw fail(409, 'We are still checking your last payment. You will see the result here soon.');
  }
  const txid = String(b.momo_txid || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9.-]{6,40}$/.test(txid)) throw fail(400, 'Enter the transaction ID from your MoMo confirmation SMS.');
  // The same MoMo transaction can't pay for two things (here or in hosting payments).
  if (db.prepare("SELECT 1 FROM order_payments WHERE momo_txid = ? AND status != 'rejected'").get(txid) || db.prepare('SELECT 1 FROM payments WHERE momo_txid = ?').get(txid)) {
    throw fail(409, 'This transaction ID has already been used.');
  }
  const payerRaw = String(b.payer_phone || '').trim();
  const payer = payerRaw ? normalizePhone(payerRaw) : null;
  if (payerRaw && !payer) throw fail(400, 'Enter the MoMo number you paid from, for example 078 123 4567.');
  return tx(() => {
    const p = db.prepare(`INSERT INTO order_payments (order_id, kind, amount, momo_txid, payer_phone)
      VALUES (?, ?, ?, ?, ?) RETURNING *`).get(o.id, due.kind, due.amount, txid, payer);
    addUpdate(o.id, 'system', `${due.kind === 'deposit' ? 'Deposit' : 'Final payment'} of ${rwf(due.amount)} reported (MoMo ID ${txid}). We will confirm it soon.`,
      { code: 'payment_reported', params: { kind: due.kind, amount: due.amount, txid } });
    return p;
  });
}

// Admin checks the MoMo statement, then confirms or rejects (with a reason the client sees).
function reviewPayment(adminName, paymentId, { approve, note }) {
  const p = db.prepare('SELECT * FROM order_payments WHERE id = ?').get(paymentId);
  if (!p) throw fail(404, 'Payment not found.');
  if (p.status !== 'pending') throw fail(409, 'This payment was already reviewed.');
  const reason = String(note || '').trim().slice(0, 500);
  if (!approve && !reason) throw fail(400, 'Say why the payment is rejected; the client will see it.');
  const o = getOrder(p.order_id);
  const expected = amountDue(o);
  if (approve && (!expected || expected.kind !== p.kind)) throw fail(409, 'The order has moved on; this payment no longer matches what is due.');
  return tx(() => {
    db.prepare(`UPDATE order_payments SET status = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ? WHERE id = ?`)
      .run(approve ? 'confirmed' : 'rejected', adminName, reason || null, p.id);
    if (!approve) {
      addUpdate(o.id, 'system', `Payment ${p.momo_txid} could not be confirmed: ${reason} Please check and send the correct transaction ID.`,
        { code: 'payment_rejected', params: { txid: p.momo_txid, reason } });
    } else if (p.kind === 'deposit') {
      db.prepare("UPDATE orders SET status = 'in_progress', started_at = datetime('now') WHERE id = ?").run(o.id);
      addUpdate(o.id, 'system', `Deposit of ${rwf(p.amount)} confirmed. Work has started.`, { code: 'deposit_confirmed', params: { amount: p.amount } });
    } else {
      db.prepare("UPDATE orders SET status = 'completed', completed_at = datetime('now'), progress = 100 WHERE id = ?").run(o.id);
      addUpdate(o.id, 'system', `Final payment of ${rwf(p.amount)} confirmed. Thank you! Your order is complete.`, { code: 'final_confirmed', params: { amount: p.amount } });
    }
    return getOrder(o.id);
  });
}

// Progress note from us, visible to the client.
function postUpdate(adminName, orderId, b) {
  const o = getOrder(orderId);
  if (o.status === 'cancelled') throw fail(409, 'This order is cancelled.');
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) throw fail(400, 'Write the update for the client.');
  let progress = null;
  if (b.progress !== undefined && b.progress !== '' && b.progress !== null) {
    progress = Math.round(Number(b.progress));
    if (!(progress >= 0 && progress <= 100)) throw fail(400, 'Progress is a number from 0 to 100.');
    if (o.status !== 'in_progress') throw fail(409, 'Progress can only change while the work is in progress.');
  }
  return tx(() => {
    if (progress !== null) db.prepare('UPDATE orders SET progress = ? WHERE id = ?').run(progress, o.id);
    addUpdate(o.id, 'admin', message, { name: adminName, progress });
    return getOrder(o.id);
  });
}

// Question or note from the client.
function clientMessage(userId, orderId, b) {
  const o = getOwnOrder(userId, orderId);
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) throw fail(400, 'Write your message.');
  const u = db.prepare('SELECT name FROM portal_users WHERE id = ?').get(userId);
  addUpdate(o.id, 'client', message, { name: u?.name || null });
  return { ok: true };
}

// Work done: the client is asked for the rest. What we deliver stays hidden until they pay it.
function markFinished(adminName, orderId, b) {
  const o = getOrder(orderId);
  if (o.status !== 'in_progress') throw fail(409, 'Only an order in progress can be marked finished.');
  const note = String(b.delivery_note || '').trim().slice(0, 3000);
  const url = String(b.result_url || '').trim().slice(0, 300);
  if (!note && !url) throw fail(400, 'Describe what you are delivering (a link, login details or a note). The client sees it after the final payment.');
  if (url && !/^https?:\/\//i.test(url)) throw fail(400, 'The result link must start with https:// or http://.');
  return tx(() => {
    db.prepare(`UPDATE orders SET status = 'awaiting_final', progress = 100, finished_at = datetime('now'),
      delivery_note = ?, result_url = ? WHERE id = ?`).run(note || null, url || null, o.id);
    addUpdate(o.id, 'system', `The work is finished. Pay the remaining ${rwf(o.price - o.deposit)} to receive it.`,
      { progress: 100, code: 'work_finished', params: { amount: o.price - o.deposit } });
    return getOrder(o.id);
  });
}

// Clients can cancel only before any money is confirmed; admins can cancel anything not completed.
// Refunds of confirmed money are handled outside the system, by agreement.
function cancelOrder(actor, orderId, { userId, reason } = {}) {
  const o = actor === 'client' ? getOwnOrder(userId, orderId) : getOrder(orderId);
  if (o.status === 'completed' || o.status === 'cancelled') throw fail(409, `This order is already ${o.status}.`);
  const paid = db.prepare("SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ? AND status IN ('pending', 'confirmed')").get(o.id).n;
  if (actor === 'client' && paid) throw fail(409, 'A payment is already recorded on this order. Send us a message to cancel it.');
  const why = String(reason || '').trim().slice(0, 500);
  return tx(() => {
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(o.id);
    db.prepare("UPDATE order_payments SET status = 'rejected', reviewed_at = datetime('now'), review_note = 'Order cancelled' WHERE order_id = ? AND status = 'pending'").run(o.id);
    addUpdate(o.id, 'system', `Order cancelled${actor === 'client' ? ' by you' : ''}.${why ? ' ' + why : ''}`,
      { code: 'order_cancelled', params: { by: actor, reason: why } });
    return getOrder(o.id);
  });
}

function paymentsFor(orderId) {
  return db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id').all(orderId);
}

function updatesFor(orderId) {
  return db.prepare('SELECT * FROM order_updates WHERE order_id = ? ORDER BY id').all(orderId);
}

// ---------- what the client sees ----------
const serviceI18n = (serviceId) => {
  try { return JSON.parse(db.prepare('SELECT i18n FROM services WHERE id = ?').get(serviceId)?.i18n || '{}'); } catch (e) { return {}; }
};
const parseParams = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

function clientView(o) {
  const payments = paymentsFor(o.id).map(({ reviewed_by, ...p }) => p);
  return {
    id: o.id, service_name: o.service_name, service_i18n: serviceI18n(o.service_id), price: o.price, deposit: o.deposit, balance: o.price - o.deposit,
    website: o.website, details: o.details, status: o.status, progress: o.progress,
    created_at: o.created_at, updated_at: o.updated_at, started_at: o.started_at, finished_at: o.finished_at,
    completed_at: o.completed_at, cancelled_at: o.cancelled_at,
    due: amountDue(o), payment_pending: payments.some((p) => p.status === 'pending'),
    paid: payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0),
    payments,
    updates: updatesFor(o.id).map((u) => ({ id: u.id, author: u.author, author_name: u.author === 'client' ? u.author_name : null,
      message: u.message, code: u.code, params: parseParams(u.params), progress: u.progress, created_at: u.created_at })),
    // The deliverable is handed over only after the final payment.
    delivery: o.status === 'completed' ? { note: o.delivery_note, url: o.result_url } : null
  };
}

function listForClient(userId) {
  return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId).map((o) => {
    const v = clientView(o);
    return { id: v.id, service_name: v.service_name, service_i18n: v.service_i18n, price: v.price, status: v.status, progress: v.progress,
      due: v.due, payment_pending: v.payment_pending, created_at: v.created_at, updated_at: v.updated_at };
  });
}

function getForClient(userId, orderId) {
  return clientView(getOwnOrder(userId, orderId));
}

// The client's home screen: what needs their action, and what happened lately across all orders.
function overviewForClient(userId) {
  const rows = listForClient(userId);
  const open = rows.filter((o) => !['completed', 'cancelled'].includes(o.status));
  const toPay = open.filter((o) => o.due && !o.payment_pending);
  const recent = db.prepare(`SELECT u.id, u.order_id, u.author, u.message, u.code, u.params, u.progress, u.created_at, o.service_name, o.service_id
    FROM order_updates u JOIN orders o ON o.id = u.order_id WHERE o.user_id = ? ORDER BY u.id DESC LIMIT 8`).all(userId)
    .map(({ service_id, params, ...u }) => ({ ...u, params: parseParams(params), service_i18n: serviceI18n(service_id) }));
  return {
    counts: { open: open.length, in_progress: open.filter((o) => o.status === 'in_progress').length,
      completed: rows.filter((o) => o.status === 'completed').length, total: rows.length },
    to_pay: toPay, to_pay_total: toPay.reduce((s, o) => s + o.due.amount, 0),
    checking: open.filter((o) => o.payment_pending),
    open, recent
  };
}

// ---------- what the admin sees ----------
function listForAdmin({ status } = {}) {
  const where = STATUSES.includes(status) ? 'WHERE o.status = ?' : '';
  const rows = db.prepare(`SELECT o.*, u.name AS client_name, u.company, u.phone, u.email,
      (SELECT COUNT(*) FROM order_payments p WHERE p.order_id = o.id AND p.status = 'pending') AS pending_payments,
      (SELECT COALESCE(SUM(amount), 0) FROM order_payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS paid
    FROM orders o JOIN portal_users u ON u.id = o.user_id ${where}
    ORDER BY pending_payments DESC, o.updated_at DESC`).all(...(where ? [status] : []));
  return rows;
}

function adminSummary() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) counts[r.status] = r.n;
  return {
    counts,
    pending_payments: db.prepare("SELECT COUNT(*) AS n FROM order_payments WHERE status = 'pending'").get().n,
    accounts: db.prepare('SELECT COUNT(*) AS n FROM portal_users WHERE erased_at IS NULL').get().n,
    received: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM order_payments WHERE status = 'confirmed'").get().n
  };
}

function getForAdmin(orderId) {
  const o = getOrder(orderId);
  const u = db.prepare('SELECT id, name, company, phone, email, lang, created_at, erased_at FROM portal_users WHERE id = ?').get(o.user_id);
  return { ...o, balance: o.price - o.deposit, due: amountDue(o), client: u, payments: paymentsFor(o.id), updates: updatesFor(o.id) };
}

module.exports = {
  STATUSES, ADVANCE_PERCENT, backfillUpdateCodes, depositFor, amountDue, createOrder, submitPayment, reviewPayment, postUpdate,
  clientMessage, markFinished, cancelOrder, listForClient, getForClient, overviewForClient, listForAdmin, getForAdmin, adminSummary
};
