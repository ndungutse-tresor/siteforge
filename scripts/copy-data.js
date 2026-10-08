'use strict';
// Copies all SiteForge data from one database into the one DATABASE_URL points to.
//
//   npm run copy-data -- data/siteforge.db     from the old SQLite database
//   npm run copy-data -- data/pglite           from the local database (npm start on your computer)
//
// With DATABASE_URL=postgres://… set, the data goes to Supabase; without it, into data/pglite.
// Ids are kept, so links between records stay correct. Safe to run again: rows that are
// already there are skipped. Photos go to Supabase Storage when SUPABASE_URL is set.
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, DATA_DIR } = require('../src/core/db');
const { BASE_URL } = require('../src/core/config');
const photos = require('../src/storage/photos');
const { backfillUpdateCodes } = require('../src/portal/orders');

// Parents before children, so every reference exists when its row is copied.
const TABLES = ['admins', 'prospects', 'audits', 'research', 'osm_tags', 'generated_sites', 'clients', 'payments',
  'outreach_log', 'jobs', 'services', 'portal_users', 'orders', 'order_payments', 'order_updates'];
const BATCH = 200;

// ---------- sources ----------
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(file, { readOnly: true });
  return {
    async columns(table) {
      if (!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
      return src.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
    },
    async rows(table, cols) { return src.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all(); },
    async photos() {
      // The SQLite version kept photos in data/photos/<prospect id>/<name>.
      const root = path.join(path.dirname(file), 'photos');
      if (!fs.existsSync(root)) return [];
      const out = [];
      for (const dir of fs.readdirSync(root)) {
        for (const name of fs.readdirSync(path.join(root, dir))) {
          const type = photos.TYPES[path.extname(name).slice(1).toLowerCase()];
          if (type) out.push({ prospect_id: Number(dir), name, type, read: () => fs.readFileSync(path.join(root, dir, name)) });
        }
      }
      return out;
    },
    async close() { src.close(); }
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ dataDir: dir });
  const all = async (sql, params) => (await pg.query(sql, params)).rows;
  return {
    async columns(table) {
      return (await all(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`, [table])).map((r) => r.column_name);
    },
    async rows(table, cols) { return all(`SELECT ${cols.join(', ')} FROM ${table}`); },
    async photos() {
      if (!(await this.columns('photos')).length) return [];
      const list = await all('SELECT prospect_id, name, content_type, data FROM photos ORDER BY created_at');
      return list.filter((p) => p.data).map((p) => ({ prospect_id: p.prospect_id, name: p.name, type: p.content_type, read: () => Buffer.from(p.data) }));
    },
    async close() { await pg.close(); }
  };
}

// ---------- copying ----------
function toTimestamp(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim().replace(' ', 'T'); // SQLite kept UTC times as 'YYYY-MM-DD HH:MM:SS'
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function convert(value, type) {
  if (value == null) return null;
  if (type === 'timestamp with time zone') return toTimestamp(value);
  if (type === 'date') return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (['integer', 'bigint', 'smallint'].includes(type)) return Math.round(Number(value));
  if (['double precision', 'real', 'numeric'].includes(type)) return Number(value);
  if (type === 'bytea') return Buffer.from(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function targetColumns(table) {
  const rows = await db.all(`SELECT column_name, data_type, is_identity FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position`, table);
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
}

async function copyTable(src, table) {
  const target = await targetColumns(table);
  const cols = (await src.columns(table)).filter((c) => target[c]);
  if (!cols.length) return { table, found: 0, copied: 0 };
  const rows = await src.rows(table, cols);
  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const vals = [];
    const tuples = rows.slice(i, i + BATCH).map((r) => {
      if (table === 'jobs' && r.status === 'running') r.status = 'queued'; // it was interrupted
      if (table === 'generated_sites' && r.slug) r.preview_url = `${BASE_URL}/preview/${r.slug}/`;
      for (const c of cols) vals.push(convert(r[c], target[c].data_type));
      return `(${cols.map(() => '?').join(', ')})`;
    });
    const r = await db.run(`INSERT INTO ${table} (${cols.join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, ...vals);
    copied += r.changes;
  }
  // New rows must get ids after the copied ones.
  if (target.id?.is_identity === 'YES') {
    await db.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1),
      (SELECT MAX(id) FROM ${table}) IS NOT NULL)`);
  }
  return { table, found: rows.length, copied };
}

async function copyPhotos(src) {
  let n = 0;
  for (const p of await src.photos()) {
    if (!(await db.get('SELECT 1 FROM prospects WHERE id = ?', p.prospect_id))) continue;
    if ((await photos.listPhotos(p.prospect_id)).includes(p.name)) continue;
    await photos.savePhoto(p.prospect_id, p.name, p.read(), p.type);
    n++;
  }
  return n;
}

(async () => {
  const from = path.resolve(process.argv[2] || path.join(DATA_DIR, 'siteforge.db'));
  if (!fs.existsSync(from)) throw new Error(`Nothing at ${from}. Usage: npm run copy-data -- data/siteforge.db   (or data/pglite)`);
  const target = process.env.DATABASE_URL || process.env.POSTGRES_URL || `pglite:${path.join(DATA_DIR, 'pglite')}`;
  if (target.startsWith('pglite:') && path.resolve(target.slice(7)) === from) throw new Error('That is the database you are copying into. Set DATABASE_URL to the Supabase address.');

  const src = from.endsWith('.db') ? openSqlite(from) : await openPglite(from);
  await db.ready();
  if (db.kind() === 'pg') await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  console.log(`Copying ${from} into ${db.kind() === 'pg' ? 'Postgres (DATABASE_URL)' : 'the local database'}...`);

  await tx(async () => {
    for (const t of TABLES) {
      const r = await copyTable(src, t);
      if (r.found) console.log(`  ${t.padEnd(16)} ${String(r.copied).padStart(5)} copied of ${r.found}`);
    }
  });
  const nPhotos = await copyPhotos(src);
  if (nPhotos) console.log(`  photos           ${String(nPhotos).padStart(5)} copied`);
  await src.close();
  await backfillUpdateCodes();
  console.log('Done.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.close());
