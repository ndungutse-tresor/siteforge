'use strict';
// Runs the daily housekeeping once: purge Google coordinates older than 30 days and
// check hosting renewals. The server already does this every 24 h; use this from
// Windows Task Scheduler or a host's cron if the server isn't always running.
const { daily } = require('../src/jobs/worker');

daily()
  .then((r) => console.log(`Cleared ${r.purge.cleared} stale coordinates; ${r.renewals.newly_overdue} newly overdue; ${r.renewals.suspended} suspended.`))
  .catch((e) => { console.error(e.message); process.exit(1); });
