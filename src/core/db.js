'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { ROOT } = require('./config');

// Postgres access for the whole app.
//   DATABASE_URL=postgres://…   Supabase (production) or any Postgres
//   DATABASE_URL=pglite:memory  an in-process Postgres (tests)
//   DATABASE_URL=pglite:<dir>   an in-process Postgres saved in a folder (offline development)
// With no DATABASE_URL, local development uses pglite:data/pglite.
//
//   await db.get(sql, ...params)  first row or null
//   await db.all(sql, ...params)  all rows
//   await db.run(sql, ...params)  { changes }
//   await tx(async () => { ... }) every db call inside runs in one transaction
// SQL uses ? placeholders; they become $1, $2 … for Postgres.

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STAGES = ['discovered', 'audited', 'generated', 'contacted', 'interested', 'won', 'lost', 'dormant'];
const SCHEMA = path.join(ROOT, 'db', 'schema.sql');

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
const clean = (params) => params.map((v) => (v === undefined ? null : v));

// Values come back as plain JS: counts as numbers, dates as 'YYYY-MM-DD', times as ISO strings.
function isoFromPg(v) {
  const s = String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
const PARSERS = {
  20: (v) => Number(v), // int8: COUNT(*), SUM(integer)
  1700: (v) => Number(v), // numeric: ROUND, AVG
  1082: (v) => String(v), // date
  1114: isoFromPg, // timestamp
  1184: isoFromPg // timestamptz
};

const store = new AsyncLocalStorage();
let driver = null;

async function connect() {
  let url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!url) {
    if (process.env.VERCEL) throw new Error('DATABASE_URL is not set. Connect the Supabase database to this Vercel project.');
    url = `pglite:${path.join(DATA_DIR, 'pglite')}`;
  }

  if (url.startsWith('pglite:')) {
    const where = url.slice('pglite:'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    if (where && where !== 'memory') fs.mkdirSync(where, { recursive: true });
    const pg = new PGlite(where && where !== 'memory' ? where : undefined, { parsers: PARSERS });
    await pg.exec(fs.readFileSync(SCHEMA, 'utf8'));
    const wrap = (c) => ({
      query: async (sql, params) => {
        const r = await c.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      }
    });
    driver = {
      kind: 'pglite',
      ...wrap(pg),
      transaction: (fn) => pg.transaction((t) => fn(wrap(t))),
      exec: (sql) => pg.exec(sql),
      close: () => pg.close()
    };
    return;
  }

  const { Pool, types } = require('pg');
  for (const [oid, fn] of Object.entries(PARSERS)) types.setTypeParser(Number(oid), fn);
  // Supabase requires TLS. sslmode in the URL is dropped so these settings apply.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10000
  });
  pool.on('error', (e) => console.error('Postgres pool:', e.message));
  driver = {
    kind: 'pg',
    query: (sql, params) => pool.query(sql, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    exec: (sql) => pool.query(sql),
    close: () => pool.end()
  };
}

let readyPromise = null;
const ready = () => (readyPromise ||= connect());

async function query(sql, params) {
  await ready();
  const target = store.getStore() || driver;
  return target.query(toPg(sql), clean(params));
}

const db = {
  all: async (sql, ...params) => (await query(sql, params)).rows,
  get: async (sql, ...params) => (await query(sql, params)).rows[0] || null,
  run: async (sql, ...params) => ({ changes: (await query(sql, params)).rowCount }),
  // Several statements without parameters (schema, maintenance).
  exec: async (sql) => { await ready(); return driver.exec(sql); },
  ready,
  kind: () => driver?.kind,
  close: async () => { if (driver) await driver.close(); driver = null; readyPromise = null; }
};

// Runs fn in one transaction. Every db call made inside (however deep) uses that transaction.
async function tx(fn) {
  await ready();
  if (store.getStore()) return fn(); // already inside one
  return driver.transaction((client) => store.run(client, fn));
}

module.exports = { db, tx, DATA_DIR, STAGES, SCHEMA };
