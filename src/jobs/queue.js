'use strict';
const { db } = require('../core/db');

const MAX_ATTEMPTS = 3;
// A job still 'running' after this long was lost (its server instance stopped): it runs again.
const STALE_MINUTES = 10;

async function enqueue(kind, payload = {}) {
  return (await db.get('INSERT INTO jobs (kind, payload) VALUES (?, ?) RETURNING id', kind, JSON.stringify(payload))).id;
}

// Atomically takes the oldest runnable job. SKIP LOCKED lets several instances work side by side.
async function claim(kinds) {
  const job = await db.get(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now()
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
      AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, ...kinds);
  return job ? { ...job, payload: JSON.parse(job.payload) } : null;
}

async function complete(id) {
  await db.run("UPDATE jobs SET status = 'done', error = NULL, finished_at = now() WHERE id = ?", id);
}

// Retries with a growing delay, then gives up.
async function fail(job, err) {
  const msg = String(err?.message || err).slice(0, 1000);
  if (job.attempts >= MAX_ATTEMPTS) {
    await db.run("UPDATE jobs SET status = 'failed', error = ?, finished_at = now() WHERE id = ?", msg, job.id);
  } else {
    await db.run("UPDATE jobs SET status = 'queued', error = ?, run_after = now() + (?::int * interval '5 minutes') WHERE id = ?",
      msg, job.attempts, job.id);
  }
}

// Jobs left 'running' by a stopped worker go back in the queue.
async function recoverStale() {
  return (await db.run(`UPDATE jobs SET status = 'queued'
    WHERE status = 'running' AND (started_at IS NULL OR started_at < now() - (?::int * interval '1 minute'))`, STALE_MINUTES)).changes;
}

async function counts() {
  return db.all('SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status');
}

async function pending(kind) {
  return (await db.get("SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND status IN ('queued', 'running')", kind)).n;
}

module.exports = { enqueue, claim, complete, fail, recoverStale, counts, pending, MAX_ATTEMPTS };
