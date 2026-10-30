// Runs every browser test in turn and fails if any of them does.
// Needs: npm install (puppeteer-core), Google Chrome, and Microsoft Edge for the
// extension test (branded Chrome 137+ ignores --load-extension). Override the
// browser locations with CHROME_PATH / EDGE_PATH. Python is used to verify zip files.
const { spawnSync } = require('child_process');
const path = require('path');

const files = ['editor-basics.js', 'glossary-export.js', 'source-retranslate.js', 'reader.js', 'erase-areas.js', 'noise-filter.js', 'extension.js'];
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) FAILED` : '\nall test files passed');
process.exit(failed ? 1 : 0);
