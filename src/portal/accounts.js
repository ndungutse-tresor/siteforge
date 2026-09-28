'use strict';
const crypto = require('node:crypto');
const { db, tx } = require('../core/db');
const { hashSecret, verifySecret, burnTime } = require('../core/auth');

// Client accounts for the portal. A client logs in with a phone number or an email address.

const MIN_PASSWORD = 8;
const LANGS = ['en', 'rw', 'fr'];
const cleanLang = (l) => (LANGS.includes(l) ? l : 'en');
const fail = (status, message) => Object.assign(new Error(message), { status });

// Rwandan mobile numbers in any common spelling -> +2507XXXXXXXX. Anything else -> null.
function normalizePhone(value) {
  const digits = String(value || '').replace(/[\s().-]/g, '');
  const m = digits.match(/^(?:\+?250|0)?(7[2389]\d{7})$/);
  return m ? `+250${m[1]}` : null;
}

function normalizeEmail(value) {
  const e = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) && e.length <= 160 ? e : null;
}

// The login box takes either; decide which one was typed.
function parseIdentifier(value) {
  const s = String(value || '').trim();
  if (s.includes('@')) return { email: normalizeEmail(s) };
  return { phone: normalizePhone(s) };
}

function publicUser(u) {
  return { id: u.id, name: u.name, company: u.company, phone: u.phone, email: u.email, lang: u.lang || 'en', created_at: u.created_at };
}

function cleanText(v, max) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function createAccount(b) {
  const name = cleanText(b.name, 80);
  const company = cleanText(b.company, 120);
  const phoneRaw = String(b.phone || '').trim();
  const emailRaw = String(b.email || '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  const password = String(b.password || '');

  if (name.length < 2) throw fail(400, 'Enter your name.');
  if (company.length < 2) throw fail(400, 'Enter your business name.');
  if (phoneRaw && !phone) throw fail(400, 'Enter a Rwandan mobile number, for example 078 123 4567.');
  if (emailRaw && !email) throw fail(400, 'That email address does not look right.');
  if (!phone && !email) throw fail(400, 'Enter a phone number or an email address, so you can log in.');
  if (password.length < MIN_PASSWORD) throw fail(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > 200) throw fail(400, 'That password is too long.');

  const taken = db.prepare('SELECT phone, email FROM portal_users WHERE phone = ? OR email = ?').get(phone, email);
  if (taken) {
    throw fail(409, taken.phone && taken.phone === phone
      ? 'An account with this phone number already exists. Log in instead.'
      : 'An account with this email already exists. Log in instead.');
  }
  const pass_hash = await hashSecret(password);
  const u = db.prepare(`INSERT INTO portal_users (name, company, phone, email, pass_hash, lang) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(name, company, phone, email, pass_hash, cleanLang(b.lang));
  return u;
}

// Returns the user, or null. Takes the same time whether or not the account exists.
async function verifyLogin(identifier, password) {
  const id = parseIdentifier(identifier);
  const u = id.phone ? db.prepare('SELECT * FROM portal_users WHERE phone = ? AND erased_at IS NULL').get(id.phone)
    : id.email ? db.prepare('SELECT * FROM portal_users WHERE email = ? AND erased_at IS NULL').get(id.email)
    : null;
  const ok = u ? await verifySecret(String(password || ''), u.pass_hash) : await burnTime(String(password || ''));
  if (!ok) return null;
  db.prepare("UPDATE portal_users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  return u;
}

function getUser(userId) {
  return db.prepare('SELECT * FROM portal_users WHERE id = ? AND erased_at IS NULL').get(userId) || null;
}

async function changePassword(userId, current, next) {
  const u = getUser(userId);
  if (!u) throw fail(404, 'Account not found.');
  if (!(await verifySecret(String(current || ''), u.pass_hash))) throw fail(400, 'Your current password is not right.');
  if (String(next || '').length < MIN_PASSWORD) throw fail(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
  // A new token_version logs out every other device.
  db.prepare('UPDATE portal_users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await hashSecret(String(next)), u.id);
  return getUser(u.id);
}

// The portal language the client picked (en, rw or fr), so replies can be written in it too.
function setLang(userId, lang) {
  db.prepare('UPDATE portal_users SET lang = ? WHERE id = ?').run(cleanLang(lang), userId);
  return getUser(userId);
}

// Admin resets a forgotten password and gives the client the temporary one (for example by WhatsApp).
async function resetPassword(userId) {
  const u = getUser(userId);
  if (!u) throw fail(404, 'Account not found.');
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i: easy to read out over the phone
  const temp = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
  db.prepare('UPDATE portal_users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await hashSecret(temp), u.id);
  return { temporary_password: temp };
}

function listAccounts() {
  return db.prepare(`SELECT u.id, u.name, u.company, u.phone, u.email, u.lang, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status NOT IN ('completed', 'cancelled')) AS open_orders
    FROM portal_users u WHERE u.erased_at IS NULL ORDER BY u.created_at DESC`).all();
}

// Everything held about one account (Law Nº 058/2021 access request).
function exportAccount(userId) {
  const u = db.prepare('SELECT * FROM portal_users WHERE id = ?').get(userId);
  if (!u) throw fail(404, 'Account not found.');
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id').all(u.id);
  return {
    exported_at: new Date().toISOString(),
    account: publicUser(u),
    orders: orders.map((o) => ({
      ...o,
      payments: db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id').all(o.id),
      updates: db.prepare('SELECT * FROM order_updates WHERE order_id = ? ORDER BY id').all(o.id)
    }))
  };
}

// Erase on request: personal details go, orders and payments stay as business records
// (invoices must be kept), attached to an anonymous account that can no longer log in.
function eraseAccount(userId) {
  const u = getUser(userId);
  if (!u) throw fail(404, 'Account not found.');
  const open = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status NOT IN ('completed', 'cancelled')").get(u.id).n;
  if (open) throw fail(409, 'This client has an order in progress. Finish or cancel it first.');
  tx(() => {
    db.prepare(`UPDATE portal_users SET name = 'Deleted account', phone = NULL, email = NULL, pass_hash = '!',
      token_version = token_version + 1, erased_at = datetime('now') WHERE id = ?`).run(u.id);
    db.prepare("UPDATE order_payments SET payer_phone = NULL WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)").run(u.id);
    db.prepare("UPDATE order_updates SET author_name = NULL WHERE author = 'client' AND order_id IN (SELECT id FROM orders WHERE user_id = ?)").run(u.id);
  });
  return { erased: u.id };
}

module.exports = {
  normalizePhone, normalizeEmail, parseIdentifier, publicUser, createAccount, verifyLogin, getUser,
  changePassword, setLang, resetPassword, listAccounts, exportAccount, eraseAccount, MIN_PASSWORD
};
