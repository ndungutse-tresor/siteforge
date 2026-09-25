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

async function daily() {
  const purge = purgeGoogleCoords();
  const renewals = await checkRenewals();
  return { purge, renewals };
}

function startWorker({ pollMs = 2000, log = console.log } = {}) {
  queue.recoverStale();
  const running = Object.fromEntries(Object.keys(HANDLERS).map((k) => [k, 0]));
  let stopped = false;

  async function tick() {
    for (const kind of Object.keys(HANDLERS)) {
      while (!stopped && running[kind] < CONCURRENCY[kind]) {
        const job = queue.claim([kind]);
        if (!job) break;
        running[kind]++;
        HANDLERS[kind](job.payload)
          .then(() => queue.complete(job.id))
          .catch((e) => { queue.fail(job, e); log(`job ${job.id} (${kind}) failed: ${e.message}`); })
          // Take the next job straight away: waiting for the next poll capped quick jobs at 1 per poll.
          .finally(() => { running[kind]--; if (!stopped) tick().catch((e) => log(`worker: ${e.message}`)); });
      }
    }
  }

  const poll = setInterval(() => tick().catch((e) => log(`worker: ${e.message}`)), pollMs);
  // Daily housekeeping: stale Google coordinates and hosting renewals.
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

module.exports = { startWorker, daily };
