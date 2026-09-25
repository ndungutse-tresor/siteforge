'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'siteforge.db'));

const STAGES = ['discovered', 'audited', 'generated', 'contacted', 'interested', 'won', 'lost', 'dormant'];

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Google terms: only place_id may be kept indefinitely and lat/lng for at most 30 days
-- (see compliance/purge.js). Name, phone etc. here come from RDB, OSM, the business's
-- own site or a visit - never from Google. contact_source records which.
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY,
  place_id TEXT UNIQUE,
  rdb_number TEXT UNIQUE,
  osm_id TEXT UNIQUE,
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'generic',
  district TEXT,
  sector_admin TEXT,
  lat REAL,
  lng REAL,
  coords_fetched_at TEXT,
  coords_source TEXT,
  website_url TEXT,
  website_status TEXT,
  score INTEGER,
  score_breakdown TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  contact_source TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'discovered' CHECK (stage IN (${STAGES.map((s) => `'${s}'`).join(',')})),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS prospects_stage ON prospects(stage, score DESC);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  http_status INTEGER,
  final_url TEXT,
  has_https INTEGER,
  is_mobile_friendly INTEGER,
  load_ms INTEGER,
  last_copyright_year INTEGER,
  cms_detected TEXT,
  has_ssl_error INTEGER,
  is_parked INTEGER,
  signals TEXT NOT NULL DEFAULT '{}',
  score INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audits_prospect ON audits(prospect_id, checked_at DESC);

-- Facts collected for building a prospect's site (OpenStreetMap + their own website).
-- One row per prospect, replaced on each collection. See research/collect.js.
CREATE TABLE IF NOT EXISTS research (
  prospect_id INTEGER PRIMARY KEY REFERENCES prospects(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Raw OpenStreetMap tags (ODbL, storable) saved at import, so collecting info never needs
-- one OSM API call per business (bulk use of that API is against OSM's policy).
CREATE TABLE IF NOT EXISTS osm_tags (
  prospect_id INTEGER PRIMARY KEY REFERENCES prospects(id) ON DELETE CASCADE,
  tags TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generated_sites (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  template_key TEXT NOT NULL,
  brief TEXT NOT NULL,
  content TEXT NOT NULL,
  content_source TEXT NOT NULL,
  preview_url TEXT,
  deploy_id TEXT,
  version INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by_admin TEXT,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS sites_prospect ON generated_sites(prospect_id, version DESC);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL UNIQUE REFERENCES prospects(id),
  business_name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  plan TEXT NOT NULL DEFAULT 'monthly' CHECK (plan IN ('monthly', 'annual')),
  setup_fee INTEGER NOT NULL DEFAULT 0,
  monthly_fee INTEGER NOT NULL DEFAULT 0,
  domain TEXT,
  live_url TEXT,
  started_at TEXT NOT NULL DEFAULT (date('now')),
  next_invoice_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'overdue', 'suspended', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  momo_txid TEXT UNIQUE,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  covers_until TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('visit', 'call', 'whatsapp', 'sms', 'email', 'note')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  message TEXT,
  outcome TEXT,
  opt_out_at TEXT
);

-- Queue for audit / generate / deploy work; see jobs/queue.js.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  run_after TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_next ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, DATA_DIR, STAGES };
