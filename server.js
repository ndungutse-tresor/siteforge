'use strict';
// Local server: the admin panel, the client portal and the job worker in one process.
// On Vercel, api/index.js serves the same app and Supabase pg_cron drives the worker.
const http = require('node:http');
const { PORT } = require('./src/core/config');
const { db } = require('./src/core/db');
const { app, prepare } = require('./src/app');
const { startWorker } = require('./src/jobs/worker');

prepare().then(() => {
  const stopWorker = startWorker();
  const server = http.createServer(app);
  server.listen(PORT, () => console.log(`SiteForge admin: http://localhost:${PORT}/admin/  ·  portal: http://localhost:${PORT}/portal/`));
  const stop = () => {
    stopWorker();
    server.close();
    db.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((e) => {
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
});
