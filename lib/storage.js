'use strict';
// Where the IMAGES live: the originals (orig/<i>) and the rendered pages (result/<i>.png).
// project.json and page.html always stay on the local disk; only the big files can move to R2.
//   STORAGE unset / "local"  -> data/projects/<id>/{orig,result}/...
//   STORAGE=r2               -> an R2 (or any S3-compatible) bucket, private; the app serves the files itself
const fs = require('fs/promises');
const path = require('path');
const { createClient } = require('./s3');

const notFound = () => Object.assign(new Error('File not found'), { status: 404 });

function createStorage({ dataDir, env = process.env }) {
  const projectDir = (id) => path.join(dataDir, 'projects', id);
  const localPath = (id, kind, index) => path.join(projectDir(id), kind, kind === 'orig' ? String(index) : `${index}.png`);
  const keyOf = (id, kind, index) => `projects/${id}/${kind}/${kind === 'orig' ? index : `${index}.png`}`;

  if ((env.STORAGE || 'local').toLowerCase() !== 'r2') {
    return {
      kind: 'local',
      describe: () => `local disk (${dataDir})`,
      async init(id) {
        await fs.mkdir(path.join(projectDir(id), 'orig'), { recursive: true });
        await fs.mkdir(path.join(projectDir(id), 'result'), { recursive: true });
      },
      put: (id, kind, index, buf) => fs.writeFile(localPath(id, kind, index), buf),
      async get(id, kind, index) {
        try {
          return await fs.readFile(localPath(id, kind, index));
        } catch (e) {
          if (e.code === 'ENOENT') throw notFound();
          throw e;
        }
      },
      del: (id, kind, index) => fs.rm(localPath(id, kind, index), { force: true }),
      removeProject: (id) => fs.rm(projectDir(id), { recursive: true, force: true }),
    };
  }

  const missing = ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  const endpoint = env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  if (!endpoint) missing.push('R2_ACCOUNT_ID (or R2_ENDPOINT)');
  if (missing.length) throw new Error(`STORAGE=r2 needs these in .env: ${missing.join(', ')}`);
  const client = createClient({
    endpoint, bucket: env.R2_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: env.R2_REGION || 'auto',
  });
  return {
    kind: 'r2',
    describe: () => `R2 bucket "${env.R2_BUCKET}" (project.json stays in ${dataDir})`,
    init: (id) => fs.mkdir(projectDir(id), { recursive: true }),
    put: (id, kind, index, buf) => client.put(keyOf(id, kind, index), buf, kind === 'result' ? 'image/png' : 'application/octet-stream'),
    async get(id, kind, index) {
      const buf = await client.get(keyOf(id, kind, index));
      if (!buf) throw notFound();
      return buf;
    },
    del: (id, kind, index) => client.del(keyOf(id, kind, index)),
    // The project knows which image indices exist, so no bucket listing is needed.
    async removeProject(id, indices = []) {
      let next = 0;
      const jobs = indices.flatMap((i) => [['orig', i], ['result', i]]);
      await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
        while (next < jobs.length) { const [kind, i] = jobs[next++]; await client.del(keyOf(id, kind, i)); }
      }));
      await fs.rm(projectDir(id), { recursive: true, force: true });
    },
  };
}

module.exports = { createStorage };
