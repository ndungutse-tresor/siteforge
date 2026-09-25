'use strict';
const { db, tx } = require('../core/db');

const MAX_ATTEMPTS = 3;

function enqueue(kind, payload = {}) {
  return db.prepare('INSERT INTO jobs (kind, payload) VALUES (?, ?) RETURNING id').get(kind, JSON.stringify(payload)).id;
}

// Atomically takes the oldest runnable job.
function claim(kinds) {
  return tx(() => {
    const job = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= datetime('now')
      AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id LIMIT 1`).get(...kinds);
    if (!job) return null;
    db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
    return { ...job, attempts: job.attempts + 1, payload: JSON.parse(job.payload) };
  });
}

function complete(id) {
  db.prepare("UPDATE jobs SET status = 'done', error = NULL, finished_at = datetime('now') WHERE id = ?").run(id);
}

// Retries with a growing delay, then gives up.
function fail(job, err) {
  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?").run(String(err.message || err), job.id);
  } else {
    db.prepare("UPDATE jobs SET status = 'queued', error = ?, run_after = datetime('now', ?) WHERE id = ?")
      .run(String(err.message || err), `+${job.attempts * 5} minutes`, job.id);
  }
}

// Jobs left 'running' by a crashed worker go back in the queue.
function recoverStale() {
  return db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run().changes;
}

function counts() {
  return db.prepare('SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status').all();
}

module.exports = { enqueue, claim, complete, fail, recoverStale, counts };
