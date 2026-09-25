'use strict';
// Usage:
//   npm run import -- osm                  pull Kigali businesses from OpenStreetMap
//   npm run import -- csv <file.csv>       import an RDB export or your own list
const fs = require('node:fs');
const { fetchOsm } = require('../src/prospecting/osm');
const { parseRdbCsv } = require('../src/prospecting/rdb');
const { importProspects } = require('../src/prospecting/importer');

(async () => {
  const [source, file] = process.argv.slice(2);
  let records;
  if (source === 'osm') {
    console.log('Querying OpenStreetMap (can take a minute)...');
    records = await fetchOsm();
  } else if (source === 'csv' && file) {
    records = parseRdbCsv(fs.readFileSync(file, 'utf8'));
  } else {
    console.error('Usage: npm run import -- osm   |   npm run import -- csv <file.csv>');
    process.exit(1);
  }
  const r = importProspects(records);
  console.log(`Found ${records.length}: ${r.added} added, ${r.merged} merged, ${r.skipped} unchanged.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
