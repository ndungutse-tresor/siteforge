'use strict';
// Usage:
//   npm run audit                 audit up to 200 prospects that have no score yet
//   npm run audit -- 50           ...up to 50
//   npm run audit -- --id 12      audit one prospect
//   npm run audit -- --url x.rw   inspect any website without saving
const { db } = require('../src/core/db');
const { auditMany, inspect } = require('../src/scoring/auditor');
const { score } = require('../src/scoring/score');

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--url') {
    const r = await inspect(args[1]);
    console.log(JSON.stringify({ ...r, ...score(r.signals, 'generic') }, null, 2));
    return;
  }
  const ids = args[0] === '--id'
    ? [Number(args[1])]
    : (await db.all('SELECT id FROM prospects WHERE score IS NULL AND do_not_contact = 0 ORDER BY id LIMIT ?', Number(args[0]) || 200)).map((r) => r.id);
  if (!ids.length) return console.log('Nothing to audit.');
  console.log(`Auditing ${ids.length} prospect(s), 4 at a time...`);
  let n = 0;
  await auditMany(ids, {
    concurrency: 4,
    onDone: (err, r) => {
      n++;
      console.log(`[${n}/${ids.length}] #${r.prospect_id} ${err ? 'ERROR ' + err.message : `${r.website_status} -> score ${r.score}`}`);
    }
  });
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.close());
