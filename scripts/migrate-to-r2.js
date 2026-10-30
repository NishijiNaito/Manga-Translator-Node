#!/usr/bin/env node
// Upload the images of existing projects (data/projects/*/orig, */result) to the bucket set in .env
// (STORAGE=r2 + R2_*). Safe to run again: uploading is a plain overwrite.
//   node scripts/migrate-to-r2.js             upload everything
//   node scripts/migrate-to-r2.js --dry-run   only list what would be uploaded
//   node scripts/migrate-to-r2.js --prune     delete each local image AFTER it was uploaded and read back
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('../lib/storage');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dry = process.argv.includes('--dry-run');
const prune = process.argv.includes('--prune');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.STORAGE = 'r2';
  const storage = createStorage({ dataDir: DATA_DIR }); // throws with a clear message if R2_* is missing
  console.log(`Source: ${DATA_DIR}\nTarget: ${storage.describe()}${dry ? '  (dry run)' : ''}${prune ? '  (local copies are deleted after verification)' : ''}\n`);

  let ids = [];
  try { ids = await fs.readdir(path.join(DATA_DIR, 'projects')); } catch { /* no projects */ }
  let uploaded = 0, failed = 0, pruned = 0;
  for (const id of ids) {
    if (!/^[a-f0-9]{12}$/.test(id)) continue;
    for (const kind of ['orig', 'result']) {
      const dir = path.join(DATA_DIR, 'projects', id, kind);
      let files = [];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files) {
        const index = kind === 'orig' ? f : f.replace(/\.png$/, '');
        if (!/^\d+$/.test(index) || (kind === 'result' && !f.endsWith('.png'))) continue;
        const file = path.join(dir, f);
        try {
          const buf = await fs.readFile(file);
          if (dry) { console.log(`would upload ${id}/${kind}/${f} (${buf.length} bytes)`); continue; }
          await storage.put(id, kind, Number(index), buf);
          uploaded++;
          if (prune) {
            // Only delete what the bucket gives back byte for byte.
            if (sha(await storage.get(id, kind, Number(index))) === sha(buf)) { await fs.rm(file); pruned++; }
            else throw new Error('read-back differs, local copy kept');
          }
        } catch (e) {
          failed++;
          console.error(`FAILED ${id}/${kind}/${f}: ${e.message}`);
        }
      }
    }
  }
  console.log(`\nuploaded ${uploaded}${prune ? `, deleted ${pruned} local copies` : ''}${failed ? `, FAILED ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
