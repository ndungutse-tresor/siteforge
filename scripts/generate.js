'use strict';
// Usage: npm run generate -- <prospect id>
const { db } = require('../src/core/db');
const { generateSite } = require('../src/generation/generate');

(async () => {
  const id = Number(process.argv[2]);
  if (!id) {
    console.error('Usage: npm run generate -- <prospect id>');
    process.exitCode = 1;
    return;
  }
  const s = await generateSite(id);
  console.log(`Version ${s.version} (${s.content_source}) ready: ${s.preview_url}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.close());
