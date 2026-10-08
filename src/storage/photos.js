'use strict';
const { db } = require('../core/db');

// Photos a business gives us for its site. The list lives in the photos table; the bytes live in
// Supabase Storage when it is configured (production), otherwise in the table itself (local, tests).
//   SUPABASE_URL + SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) → bucket PHOTO_BUCKET (default "photos")

const PHOTO_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(jpe?g|png|webp)$/i;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_BYTES = 3 * 1024 * 1024;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.PHOTO_BUCKET || 'photos';
const useStorage = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

const fail = (status, message) => Object.assign(new Error(message), { status });
const objectPath = (prospectId, name) => `${Number(prospectId)}/${name}`;

async function storage(method, path, body, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(contentType ? { 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': '31536000' } : {})
    },
    body,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    throw fail(502, `Photo storage answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

async function listPhotos(prospectId) {
  return (await db.all('SELECT name FROM photos WHERE prospect_id = ? ORDER BY created_at, name', prospectId)).map((r) => r.name);
}

// Saves under a clean, unique name and returns it.
async function savePhoto(prospectId, originalName, buffer, type) {
  const ext = Object.entries(TYPES).find(([, t]) => t === type)?.[0] || '';
  if (!ext) throw fail(400, 'Send a JPEG, PNG or WebP image.');
  if (buffer.length > MAX_BYTES) throw fail(413, 'Keep photos under 3 MB.');
  const base = String(originalName || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  const taken = new Set(await listPhotos(prospectId));
  let name = `${base}.${ext === 'jpeg' ? 'jpg' : ext}`, n = 2;
  while (taken.has(name)) name = `${base}-${n++}.${ext === 'jpeg' ? 'jpg' : ext}`;
  if (useStorage()) await storage('POST', objectPath(prospectId, name), buffer, type);
  await db.run('INSERT INTO photos (prospect_id, name, content_type, size, data) VALUES (?, ?, ?, ?, ?)',
    prospectId, name, type, buffer.length, useStorage() ? null : buffer);
  return name;
}

// → { buffer, type } or null
async function readPhoto(prospectId, name) {
  if (!PHOTO_RE.test(name)) return null;
  const row = await db.get('SELECT content_type, data FROM photos WHERE prospect_id = ? AND name = ?', prospectId, name);
  if (!row) return null;
  if (row.data) return { buffer: Buffer.from(row.data), type: row.content_type };
  if (!useStorage()) return null;
  const res = await storage('GET', objectPath(prospectId, name));
  return { buffer: Buffer.from(await res.arrayBuffer()), type: row.content_type };
}

async function deletePhoto(prospectId, name) {
  if (!PHOTO_RE.test(name)) throw fail(400, 'Bad file name.');
  if (useStorage()) await storage('DELETE', objectPath(prospectId, name));
  await db.run('DELETE FROM photos WHERE prospect_id = ? AND name = ?', prospectId, name);
}

// Removes every photo of a business (erase on request).
async function deleteAll(prospectId) {
  for (const name of await listPhotos(prospectId)) await deletePhoto(prospectId, name);
}

module.exports = { listPhotos, savePhoto, readPhoto, deletePhoto, deleteAll, useStorage, PHOTO_RE, TYPES, MAX_BYTES };
