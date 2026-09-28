'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { db, DATA_DIR } = require('./db');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(secret), salt, KEYLEN, SCRYPT);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifySecret(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const expected = Buffer.from(parts[2], 'base64');
  const hash = await scrypt(String(secret), Buffer.from(parts[1], 'base64'), KEYLEN, SCRYPT);
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

// Used when the account doesn't exist, so a wrong phone number takes as long as a wrong PIN.
let dummyHash = null;
async function burnTime(secret) {
  if (!dummyHash) dummyHash = await hashSecret('not-a-real-account');
  await verifySecret(secret, dummyHash);
  return false;
}

// ---------- signed session tokens ----------
// Signs login cookies. On Vercel (read-only disk, many instances) it must come from SESSION_SECRET;
// locally a random one is kept in data/secret.key.
function loadSecret() {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
    return Buffer.from(process.env.SESSION_SECRET);
  }
  if (process.env.VERCEL) throw new Error('Set SESSION_SECRET (32+ random characters) in the Vercel project settings.');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim());
}
const SECRET = loadSecret();

function mac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + mac(body);
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(body));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() ? p : null;
  } catch (e) {
    return null;
  }
}

// ---------- cookies ----------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAgeSec, path: p = '/', secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${p}`,
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

// ---------- rate limiting ----------
// Counted in the database, so every server instance (Vercel runs many) sees the same numbers.
class Limiter {
  constructor(name, max, windowMs) {
    this.name = name;
    this.max = max;
    this.windowMs = windowMs;
  }
  key(k) { return `${this.name}:${String(k).slice(0, 200)}`; }
  async blocked(k) {
    const r = await db.get('SELECT hits FROM rate_limits WHERE key = ? AND reset_at > now()', this.key(k));
    return Boolean(r && r.hits >= this.max);
  }
  async hit(k) {
    await db.run(`INSERT INTO rate_limits (key, hits, reset_at) VALUES (?, 1, now() + (?::int * interval '1 millisecond'))
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= now() THEN excluded.reset_at ELSE rate_limits.reset_at END`,
    this.key(k), this.windowMs);
  }
  async clear(k) { await db.run('DELETE FROM rate_limits WHERE key = ?', this.key(k)); }
}

module.exports = { hashSecret, verifySecret, burnTime, signToken, verifyToken, parseCookies, cookie, Limiter };
