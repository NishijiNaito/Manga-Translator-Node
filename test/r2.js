// Images in an S3-compatible bucket (R2). No real R2 here: a fake bucket server checks the
// SigV4 signature of every request, and the real app runs against it with STORAGE=r2.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-r2';
const sharp = require(NODE + '/node_modules/sharp');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const KEY = { accessKeyId: 'AKTEST', secretAccessKey: 'test-secret-key' };
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3085';
process.env.APP_SECRET = ''; // local mode: this test is about storage, not login
process.env.STORAGE = 'r2';
process.env.R2_ENDPOINT = 'http://127.0.0.1:8101';
process.env.R2_BUCKET = 'mangabucket';
process.env.R2_ACCESS_KEY_ID = KEY.accessKeyId;
process.env.R2_SECRET_ACCESS_KEY = KEY.secretAccessKey;
const { sign, createClient } = require(NODE + '/lib/s3.js');
const { createStorage } = require(NODE + '/lib/storage.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function call(method, path, { headers = {}, body, port = 3085 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...(body && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- the fake bucket ----------
const bucket = new Map();        // key -> Buffer
const requests = [];             // what the app sent
const flaky = new Set(['flaky']); // keys that answer 503 once
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/mangabucket\/(.+)$/);
    const reply = (status, data = '') => { res.writeHead(status); res.end(data); };
    if (!m) return reply(404);
    const key = decodeURIComponent(m[1]);
    // Re-sign with the same inputs the client had and compare (checks headers + body hash + secret).
    const got = req.headers.authorization || '';
    const signed = (/SignedHeaders=([^,]+)/.exec(got) || [])[1] || '';
    const extra = {};
    for (const h of signed.split(';')) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)) extra[h] = req.headers[h];
    const expect = sign({ method: req.method, host: req.headers.host, path: url.pathname, body, ...KEY, region: 'auto', headers: extra, now: new Date(Date.parse(req.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))) });
    requests.push({ method: req.method, key });
    if (expect.authorization !== got || req.headers['x-amz-content-sha256'] !== sha(body)) return reply(403, '<Error>SignatureDoesNotMatch</Error>');
    if (flaky.delete(key)) return reply(503, 'try again');
    if (req.method === 'PUT') { bucket.set(key, body); return reply(200); }
    if (req.method === 'GET') return bucket.has(key) ? reply(200, bucket.get(key)) : reply(404, '<Error>NoSuchKey</Error>');
    if (req.method === 'DELETE') { bucket.delete(key); return reply(204); }
    reply(405);
  });
}).listen(8101);

(async () => {
  // ---------- SigV4 against AWS' published "get-vanilla" test vector ----------
  const v = sign({ method: 'GET', host: 'example.amazonaws.com', path: '/', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z') });
  check('SigV4 matches the AWS test vector (get-vanilla)', v.authorization.endsWith('Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
    && /SignedHeaders=host;x-amz-date,/.test(v.authorization), v.authorization.slice(-72));

  // ---------- storage selection ----------
  const bad = (() => { try { createStorage({ dataDir: TMP, env: { STORAGE: 'r2', R2_BUCKET: 'b' } }); return ''; } catch (e) { return e.message; } })();
  check('STORAGE=r2 with missing settings fails with a clear message', /R2_ACCESS_KEY_ID/.test(bad) && /R2_ACCOUNT_ID/.test(bad), bad);
  check('default storage is the local disk', createStorage({ dataDir: TMP, env: {} }).kind === 'local');

  // ---------- client: signatures, retry, 404 ----------
  const client = createClient({ endpoint: 'http://127.0.0.1:8101', bucket: 'mangabucket', ...KEY });
  await client.put('hello/a b.txt', Buffer.from('hi there'));
  check('client PUT/GET round trip (key with a space)', (await client.get('hello/a b.txt')).toString() === 'hi there');
  check('client GET of a missing key gives null', (await client.get('nope')) === null);
  await client.put('flaky', Buffer.from('x'));
  check('a 503 is retried and then succeeds', bucket.get('flaky')?.toString() === 'x' && requests.filter((r) => r.key === 'flaky').length === 2);
  const wrong = createClient({ endpoint: 'http://127.0.0.1:8101', bucket: 'mangabucket', accessKeyId: 'AKTEST', secretAccessKey: 'wrong' });
  check('a wrong secret is refused by the bucket (403) and reported', await wrong.get('hello/a b.txt').then(() => false, (e) => /403/.test(e.message)));
  await client.del('hello/a b.txt');
  check('client DELETE removes the object', !bucket.has('hello/a b.txt'));

  // ---------- the app on top of it ----------
  require(NODE + '/server.js');
  await sleep(800);
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#00aa00' } }).png().toBuffer();
  const html = `<html><head><title>R2</title></head><body><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`;
  let r = await call('POST', '/api/projects', { body: { html, baseUrl: 'https://example.org/' } });
  const proj = r.json();
  const id = proj.id;
  check('project creation stores the original in the bucket', r.status === 200 && bucket.has(`projects/${id}/orig/0`) && sha(bucket.get(`projects/${id}/orig/0`)) === sha(png), Object.keys(proj).join(','));
  const local = `${TMP}/data/projects/${id}`;
  check('project.json (and page.html) stay local, no image files on disk', fs.existsSync(`${local}/project.json`) && fs.existsSync(`${local}/page.html`) && !fs.existsSync(`${local}/orig`) && !fs.existsSync(`${local}/result`));

  r = await call('GET', `/files/${id}/orig/0`);
  check('/files/orig streams from the bucket', r.status === 200 && sha(r.buf) === sha(png));
  const out = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#ffee00' } }).png().toBuffer();
  r = await call('PUT', `/api/projects/${id}/images/0/result`, { headers: { 'Content-Type': 'image/png' }, body: out });
  check('rendered result is stored in the bucket', r.status === 200 && sha(bucket.get(`projects/${id}/result/0.png`)) === sha(out));
  r = await call('GET', `/files/${id}/result/0.png`);
  check('/files/result streams from the bucket as image/png', r.status === 200 && r.headers['content-type'] === 'image/png' && sha(r.buf) === sha(out));
  check('a missing file answers 404', (await call('GET', `/files/${id}/result/7.png`)).status === 404);

  r = await call('GET', `/api/projects/${id}/export`);
  check('export reads results from the bucket (zip contains the PNG bytes)', r.status === 200 && r.buf.includes(out));

  r = await call('DELETE', `/api/projects/${id}/images/0/result`);
  check('deleting a result removes the object', r.status === 200 && !bucket.has(`projects/${id}/result/0.png`));
  await call('PUT', `/api/projects/${id}/images/0/result`, { headers: { 'Content-Type': 'image/png' }, body: out });
  r = await call('DELETE', `/api/projects/${id}`);
  check('deleting a project removes its objects and its local folder', r.status === 200 && ![...bucket.keys()].some((k) => k.startsWith(`projects/${id}/`)) && !fs.existsSync(local), [...bucket.keys()].join(','));

  fake.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
