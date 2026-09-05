'use strict';
const { ingest, scanDropFolder } = require('./ingest');

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    const added = await scanDropFolder();
    if (!added.length) console.log('books/ has nothing new to ingest.');
    for (const m of added) console.log(m.error ? `  ! ${m.error}` : `  + ${m.title} (${m.slug}, ${m.unitCount} ${m.unitName}s)`);
    return;
  }
  for (const f of args) {
    const m = await ingest(f);
    console.log(`  + ${m.title} (${m.slug}, ${m.unitCount} ${m.unitName}s)`);
  }
})().catch((e) => {
  console.error('ingest failed:', e.message);
  process.exit(1);
});
