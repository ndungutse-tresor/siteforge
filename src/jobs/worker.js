'use strict';
const queue = require('./queue');
const { auditProspect } = require('../scoring/auditor');
const { generateSite } = require('../generation/generate');
const { deploySite } = require('../hosting/publish');
const { checkRenewals } = require('../hosting/billing');
const { purgeGoogleCoords } = require('../compliance/purge');
const { collectForProspect } = require('../research/collect');

const HANDLERS = {
  audit: (p) => auditProspect(p.prospect_id),
  research: (p) => collectForProspect(p.prospect_id),
  generate: (p) => generateSite(p.prospect_id, p.brief || {}),
  deploy: (p) => deploySite(p.site_id)
};

// Caps: audits hit other people's servers, generation costs API money.
const CONCURRENCY = { audit: 4, research: 2, generate: 1, deploy: 1 };

// Daily housekeeping: stale Google coordinates and hosting renewals.
async function daily() {
  const purge = await purgeGoogleCoords();
  const renewals = await checkRenewals();
  return { purge, renewals };
}

// Works through the queue until it is empty or `ms` has passed, whichever comes first, and stops
// taking new jobs a little before the deadline so running ones can finish.
// Used by /api/cron/work on Vercel (called every minute by Supabase pg_cron).
async function runFor(ms, { log = console.log } = {}) {
  const deadline = Date.now() + ms;
  await queue.recoverStale();
  const done = { ok: 0, failed: 0 };
  async function lane(kind) {
    while (Date.now() < deadline - 15000) {
      const job = await queue.claim([kind]);
      if (!job) return;
      try {
        await HANDLERS[kind](job.payload);
        await queue.complete(job.id);
        done.ok++;
      } catch (e) {
        await queue.fail(job, e);
        done.failed++;
        log(`job ${job.id} (${kind}) failed: ${e.message}`);
      }
    }
  }
  const lanes = [];
  for (const [kind, n] of Object.entries(CONCURRENCY)) for (let i = 0; i < n; i++) lanes.push(lane(kind));
  await Promise.all(lanes);
  return done;
}

// Local server: keeps polling the queue and runs the daily jobs once a day.
function startWorker({ pollMs = 2000, log = console.log } = {}) {
  const running = Object.fromEntries(Object.keys(HANDLERS).map((k) => [k, 0]));
  let stopped = false;

  async function tick() {
    for (const kind of Object.keys(HANDLERS)) {
      while (!stopped && running[kind] < CONCURRENCY[kind]) {
        running[kind]++;
        let job;
        try { job = await queue.claim([kind]); } catch (e) { running[kind]--; throw e; }
        if (!job) { running[kind]--; break; }
        HANDLERS[kind](job.payload)
          .then(() => queue.complete(job.id))
          .catch((e) => { log(`job ${job.id} (${kind}) failed: ${e.message}`); return queue.fail(job, e); })
          // Take the next job straight away: waiting for the next poll capped quick jobs at 1 per poll.
          .finally(() => { running[kind]--; if (!stopped) tick().catch((e) => log(`worker: ${e.message}`)); });
      }
    }
  }

  queue.recoverStale().catch((e) => log(`worker: ${e.message}`));
  const poll = setInterval(() => tick().catch((e) => log(`worker: ${e.message}`)), pollMs);
  const runDaily = () => daily().then((r) => log(`daily: cleared ${r.purge.cleared} coords, ${r.renewals.newly_overdue} overdue, ${r.renewals.suspended} suspended`))
    .catch((e) => log(`daily: ${e.message}`));
  const dailyTimer = setInterval(runDaily, 24 * 60 * 60 * 1000);
  setTimeout(runDaily, 5000).unref();
  poll.unref?.();
  dailyTimer.unref?.();
  return () => { stopped = true; clearInterval(poll); clearInterval(dailyTimer); };
}

if (require.main === module) {
  console.log('Worker running. Ctrl+C to stop.');
  startWorker();
  setInterval(() => {}, 1 << 30);
}

module.exports = { startWorker, runFor, daily, HANDLERS, CONCURRENCY };
