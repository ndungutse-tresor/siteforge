'use strict';
// Usage: npm run generate -- <prospect id>
const { generateSite } = require('../src/generation/generate');

(async () => {
  const id = Number(process.argv[2]);
  if (!id) {
    console.error('Usage: npm run generate -- <prospect id>');
    process.exit(1);
  }
  const s = await generateSite(id);
  console.log(`Version ${s.version} (${s.content_source}) ready: ${s.preview_url}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
