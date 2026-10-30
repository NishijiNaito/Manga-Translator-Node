// Hosted-mode protections: login, CSRF, SSRF, signed file links, sandboxed /view.
// No browser and no LLM: real server over HTTP (APP_SECRET set), real sockets.
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-sec';
const sharp = require(NODE + '/node_modules/sharp');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const SECRET = 'test-secret-0123456789abcdef';
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3083';
process.env.APP_SECRET = SECRET;
process.env.TRUST_PROXY = '1';
const { isPrivateAddress, safeGet } = require(NODE + '/lib/security.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plain http client: lets us set Origin / X-Forwarded-* freely.
function call(method, path, { headers = {}, body, port = 3083 } = {}) {
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

(async () => {
  // ---------- address classifier ----------
  const priv = ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::1', 'not-an-ip'];
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888'];
  const badPriv = priv.filter((a) => !isPrivateAddress(a));
  const badPub = pub.filter((a) => isPrivateAddress(a));
  check('every private / loopback / metadata / mapped address is classified private', !badPriv.length, badPriv.join(' '));
  check('public addresses are not blocked', !badPub.length, badPub.join(' '));

  // ---------- safeGet against a local site (allowPrivate for the mechanics) ----------
  let secretHits = 0;
  const site = http.createServer((req, res) => {
    secretHits++;
    if (req.url === '/r1') { res.writeHead(302, { Location: '/r2' }); return res.end(); }
    if (req.url === '/r2') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (req.url === '/gz') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync('hello gzip')); }
    if (req.url === '/bomb') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024))); }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 }); return res.end(Buffer.alloc(5 * 1024 * 1024)); }
    res.writeHead(200); res.end('ok');
  }).listen(8100);
  const base = 'http://127.0.0.1:8100';
  const open = { allowPrivate: true, maxBytes: 1024 * 1024 };
  check('safeGet follows redirects', (await safeGet(base + '/r1', open)).buffer.toString() === 'ok');
  check('safeGet stops redirect loops', await safeGet(base + '/loop', open).then(() => false, (e) => /redirects/.test(e.message)));
  check('safeGet decodes gzip', (await safeGet(base + '/gz', open)).buffer.toString() === 'hello gzip');
  check('safeGet limits the DECOMPRESSED size (gzip bomb)', await safeGet(base + '/bomb', open).then(() => false, (e) => /too large/.test(e.message)));
  check('safeGet rejects oversized content-length', await safeGet(base + '/big', open).then(() => false, (e) => /too large/.test(e.message)));
  secretHits = 0;
  const guarded = await Promise.all([base + '/', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0/', 'http://2130706433/']
    .map((u) => safeGet(u).then(() => 'fetched', (e) => (e.code === 'EBLOCKED' ? 'blocked' : `other:${e.message}`))));
  check('safeGet (default) refuses loopback / link-local / metadata / numeric hosts without connecting', guarded.every((g) => g === 'blocked') && secretHits === 0, guarded.join(','));

  // ---------- start the real server in hosted mode ----------
  require(NODE + '/server.js');
  await sleep(800);
  const H = { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' };

  let r = await call('GET', '/api/projects');
  check('no credentials: API answers 401', r.status === 401, String(r.status));
  r = await call('GET', '/');
  check('no credentials: pages redirect to /login', r.status === 302 && r.headers.location === '/login', `${r.status} ${r.headers.location}`);
  r = await call('GET', '/files/aaaaaaaaaaaa/orig/0');
  check('no credentials: /files answers 401', r.status === 401);
  r = await call('GET', '/login');
  check('/login is public and has no X-Powered-By', r.status === 200 && !r.headers['x-powered-by'] && /<form/.test(r.text));
  check('security headers: CSP, nosniff, frame deny, HSTS behind HTTPS proxy',
    /script-src 'self'/.test(r.headers['content-security-policy']) && r.headers['x-content-type-options'] === 'nosniff' && r.headers['x-frame-options'] === 'DENY'
    && !!(await call('GET', '/login', { headers: H })).headers['strict-transport-security']);

  // login throttle (per client IP, taken from X-Forwarded-For because TRUST_PROXY=1)
  const bad = { 'X-Forwarded-For': '198.51.100.9', Origin: 'http://127.0.0.1:3083' };
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/login', { headers: { ...bad, Host: '127.0.0.1:3083' }, body: { secret: 'wrong' + i } })).status);
  check('5 wrong secrets -> 401, the 6th attempt is throttled (429)', codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, codes.join(','));
  r = await call('POST', '/api/login', { headers: { ...bad, Host: '127.0.0.1:3083' }, body: { secret: SECRET } });
  check('a locked-out IP cannot log in even with the right secret', r.status === 429);

  r = await call('POST', '/api/login', { headers: { ...H, Host: '127.0.0.1:3083' }, body: { secret: SECRET } });
  const cookie = (r.headers['set-cookie'] || [])[0] || '';
  check('right secret -> cookie is HttpOnly, SameSite=Strict, Secure behind HTTPS proxy', r.status === 200 && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Secure/.test(cookie), cookie.replace(/=[^;]+/, '=…'));
  const C = { Cookie: cookie.split(';')[0], Host: '127.0.0.1:3083' };
  check('cookie is accepted', (await call('GET', '/api/projects', { headers: C })).status === 200);
  check('cookie value tampering is rejected', (await call('GET', '/api/projects', { headers: { Cookie: 'mt_session=' + cookie.split(';')[0].split('=')[1].replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) } })).status === 401);
  check('Bearer secret is accepted (extension), a wrong one is not',
    (await call('GET', '/api/projects', { headers: { Authorization: `Bearer ${SECRET}` } })).status === 200
    && (await call('GET', '/api/projects', { headers: { Authorization: 'Bearer nope' } })).status === 401);

  r = await call('POST', '/api/projects', { headers: { ...C, Origin: 'https://evil.example' }, body: { html: '<html></html>' } });
  check('cookie + foreign Origin on a POST is refused (CSRF)', r.status === 403, String(r.status));
  r = await call('POST', '/api/projects', { headers: { ...C, Origin: 'http://127.0.0.1:3083' }, body: {} });
  check('same Origin passes the gate (then fails on its own validation)', r.status === 400, String(r.status));

  // ---------- SSRF through the API ----------
  secretHits = 0;
  const targets = ['http://127.0.0.1:8100/', 'http://localhost:8100/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/',
    'http://2130706433:8100/', 'http://[::ffff:127.0.0.1]:8100/', 'http://0/', 'file:///etc/passwd', 'ftp://example.com/x'];
  const ssrf = [];
  for (const t of targets) { const x = await call('POST', '/api/projects', { headers: C, body: { url: t } }); ssrf.push(x.status); }
  check('project creation refuses internal / odd URLs (400) and never reaches the local site', ssrf.every((s) => s === 400) && secretHits === 0, `${ssrf.join(',')} hits=${secretHits}`);

  // ---------- /view: sandbox, no scripts, signed image links ----------
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const html = `<html><head><title>T</title><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body onload="evil()">
    <img src="data:image/png;base64,${png.toString('base64')}" onerror="evil()"><script>evil()</script>
    <a href="javascript:evil()">x</a><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input></form></body></html>`;
  r = await call('POST', '/api/projects', { headers: C, body: { html, baseUrl: 'https://example.org/' } });
  const proj = r.json();
  check('project from pasted HTML (data: image needs no network)', r.status === 200 && proj.images?.length === 1, r.text.slice(0, 120));
  r = await call('PUT', `/api/projects/${proj.id}/images/0/result`, { headers: { ...C, 'Content-Type': 'image/png' }, body: png });
  check('result upload works', r.status === 200);

  r = await call('GET', `/view/${proj.id}`, { headers: C });
  const v = r.text;
  check('/view is sandboxed by CSP (no scripts, no same-origin)', /^sandbox /.test(r.headers['content-security-policy']) && /default-src 'none'/.test(r.headers['content-security-policy']));
  check('/view HTML has no script, handlers, javascript: links, iframes, forms or meta refresh',
    !/<script|onerror|onload|javascript:|<iframe|<form|http-equiv/i.test(v), v.slice(0, 200));
  const m = v.match(/src="(http:\/\/127\.0\.0\.1:3083\/files\/[^"]+)"/);
  if (m) m[1] = m[1].replace(/&amp;/g, '&'); // the HTML encodes it; a browser decodes it
  check('/view points the image at a signed /files link', !!m && /\?e=\d+&s=/.test(m[1]), m && m[1]);
  const link = m ? m[1].replace('http://127.0.0.1:3083', '') : '/x';
  check('the signed link works WITHOUT a cookie', (await call('GET', link)).status === 200);
  check('a tampered signature is refused', (await call('GET', link.replace(/s=(.)/, (_, c) => 's=' + (c === 'a' ? 'b' : 'a')))).status === 401);
  check('the signature does not carry over to another file', (await call('GET', link.replace('/result/0.png', '/orig/0'))).status === 401);
  check('an altered expiry is refused', (await call('GET', link.replace(/e=\d+/, 'e=99999999999'))).status === 401);

  r = await call('GET', `/api/projects/${proj.id}/replacements`, { headers: { Authorization: `Bearer ${SECRET}`, Host: '127.0.0.1:3083' } });
  const list = r.json();
  check('replacements: signed URL, and no wildcard CORS', list.length === 1 && /\?e=\d+&s=/.test(list[0].translated) && !r.headers['access-control-allow-origin']);
  check('that signed URL loads without credentials', (await call('GET', list[0].translated.replace('http://127.0.0.1:3083', ''))).status === 200);

  r = await call('POST', '/api/logout', { headers: C });
  check('logout clears the cookie', r.status === 200 && /Max-Age=0/.test((r.headers['set-cookie'] || [''])[0]));

  // ---------- startup guards ----------
  const run = (env) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(NODE + '/server.js')})`], { cwd: TMP, env: { ...process.env, DATA_DIR: TMP + '/d2', PORT: '3084', APP_SECRET: '', TRUST_PROXY: '', ...env }, timeout: 8000, encoding: 'utf8' });
  let g = run({ HOST: '0.0.0.0' });
  check('refuses to listen on 0.0.0.0 without APP_SECRET', g.status === 1 && /Refusing to listen/.test(g.stderr), `exit ${g.status}`);
  g = run({ APP_SECRET: 'short' });
  check('refuses a short APP_SECRET', g.status === 1 && /too short/.test(g.stderr), `exit ${g.status}`);

  site.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
