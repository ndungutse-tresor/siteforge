'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DATA_DIR } = require('./db');

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
function loadSecret() {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
    return Buffer.from(process.env.SESSION_SECRET);
  }
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
class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k);
    }, 60000).unref();
  }
  entry(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    return e;
  }
  blocked(key) { return this.entry(key).n >= this.max; }
  hit(key) { this.entry(key).n++; }
  clear(key) { this.hits.delete(key); }
  retryAfterSec(key) { return Math.ceil((this.entry(key).reset - Date.now()) / 1000); }
}

module.exports = { hashSecret, verifySecret, burnTime, signToken, verifyToken, parseCookies, cookie, Limiter };
