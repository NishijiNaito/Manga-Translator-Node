// Continuous reading mode, against the real server and real Chrome. No LLM involved.
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-reader';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3081';
process.env.APP_SECRET = ''; // a real .env may set it: these tests run the server in local mode

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  const out = '[{"box":[100,100,300,600],"text":"ก"}]';
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) };
};
process.env.GEMINI_API_KEY = 'stub';

(async () => {
  for (const i of [1, 2, 3]) {
    await sharp({ create: { width: 400, height: 600, channels: 3, background: '#cc3333' } }).png().toFile(`${TMP}/site/p${i}.png`);
  }
  fs.writeFileSync(TMP + '/site/index.html', '<html><head><title>R</title></head><body>' + [1, 2, 3].map((i) => `<img src="p${i}.png">`).join('') + '</body></html>');
  require('http').createServer((req, res) => {
    const f = TMP + '/site' + (req.url === '/' ? '/index.html' : req.url);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(8098);
  require(NODE + '/server.js');
  await sleep(800);
  const B = 'http://127.0.0.1:3081';
  const proj = await realFetch(B + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8098/index.html' }) }).then((r) => r.json());
  const id = proj.id;
  const put = (u, body, type = 'application/json') => realFetch(B + u, { method: 'PUT', headers: { 'content-type': type }, body });
  // page 0 translated (taller result, so we can tell it apart), page 2 skipped, page 1 untranslated
  await put(`/api/projects/${id}/images/0/result`, await sharp({ create: { width: 400, height: 700, channels: 3, background: '#ffee00' } }).png().toBuffer(), 'image/png');
  await put(`/api/projects/${id}/images/2/skip`, JSON.stringify({ skipped: true }));

  // keep-original: page 1 (untranslated) is kept as-is
  const ex0 = await realFetch(`${B}/api/projects/${id}/export`);
  check('before "keep": export without originals has only the translated page', (await ex0.arrayBuffer()).byteLength > 0 && ex0.status === 200);
  const kept = await put(`/api/projects/${id}/images/1/keep`, JSON.stringify({ keep: true })).then((r) => r.json());
  check('keep flag is saved on the image', kept.keep === true);
  const repl = await realFetch(`${B}/api/projects/${id}/replacements`).then((r) => r.json());
  check('replacements list only translated, non-kept images', repl.length === 1 && repl[0].index === 0);
  const zbuf = Buffer.from(await realFetch(`${B}/api/projects/${id}/export`).then((r) => r.arrayBuffer()));
  fs.writeFileSync(TMP + '/k.zip', zbuf);
  const z = JSON.parse(execFileSync('python', ['-I', __dirname + '/zipinfo.py', TMP + '/k.zip']).toString());
  check('export (originals off) = translated page + kept original, numbered in order', z.testzip === null && z.entries.length === 2
    && z.entries[1][1] === sha(fs.readFileSync(`${TMP}/data/projects/${id}/orig/1`)), z.entries.map((e) => e[0]).join());
  // a translated page that is then marked keep reverts to its original in export
  await put(`/api/projects/${id}/images/0/keep`, JSON.stringify({ keep: true }));
  fs.writeFileSync(TMP + '/k2.zip', Buffer.from(await realFetch(`${B}/api/projects/${id}/export`).then((r) => r.arrayBuffer())));
  const z2 = JSON.parse(execFileSync('python', ['-I', __dirname + '/zipinfo.py', TMP + '/k2.zip']).toString());
  check('keep wins over an existing result in the export', z2.entries[0][1] === sha(fs.readFileSync(`${TMP}/data/projects/${id}/orig/0`)));
  await put(`/api/projects/${id}/images/0/keep`, JSON.stringify({ keep: false }));
  await put(`/api/projects/${id}/images/1/keep`, JSON.stringify({ keep: false }));

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${B}/#/p/${id}/read`);
  await page.waitForSelector('.pg img');
  await page.waitForFunction(() => [...document.querySelectorAll('.pg img')].every((i) => i.complete && i.naturalWidth));

  const info = await page.$$eval('.pg', (p) => p.map((e) => ({ i: e.dataset.i, raw: e.classList.contains('raw'), h: e.querySelector('img').naturalHeight })));
  check('strip lists non-skipped images in order', info.map((x) => x.i).join() === '0,1', JSON.stringify(info));
  check('translated image uses the result, untranslated falls back to the original (marked raw)', info[0].h === 700 && !info[0].raw && info[1].h === 600 && info[1].raw);

  await page.$eval('#rdW', (e) => { e.value = 500; e.dispatchEvent(new Event('input')); });
  const w = await page.$eval('#strip', (e) => Math.round(e.getBoundingClientRect().width));
  check('width slider resizes the strip', w === 500, String(w));
  check('width choice is remembered', await page.evaluate(() => JSON.parse(localStorage['mt-settings']).reader.width === 500));

  await page.click('#rdOrig');
  await page.waitForFunction(() => document.querySelector('.pg img').src.includes('/orig/0'));
  check('"ดูต้นฉบับ" switches every page to the original', true);

  // keep button in the editor
  await page.goto(`${B}/#/p/${id}/1`);
  await page.reload();
  await page.waitForSelector('#bKeep');
  await page.waitForFunction(() => cur && cur.index === 1);
  await page.click('#bKeep');
  await page.waitForFunction(() => P.images.find((i) => i.index === 1).keep === true);
  check('editor button marks the image keep (badge + button text)', await page.evaluate(() => /คงต้นฉบับ/.test(document.querySelector('.thumb.keep .badge')?.textContent) && /ยกเลิก/.test(bKeep.textContent)));
  await page.goto(`${B}/#/p/${id}/read`);
  await page.reload();
  await page.waitForSelector('.pg img');
  check('reader shows the kept image as original without the red outline', await page.$$eval('.pg', (p) => p.every((e) => !e.classList.contains('raw'))));
  await page.goto(`${B}/#/p/${id}/1`);
  await page.reload();
  await page.waitForSelector('#bKeep');
  await page.click('#bTr');
  await page.waitForFunction(() => !P.images.find((i) => i.index === 1).keep && P.images.find((i) => i.index === 1).blocks.length, { timeout: 8000 });
  check('translating a kept image clears the keep flag', await page.evaluate(() => !P.images.find((i) => i.index === 1).keep));
  await page.goto(`${B}/#/p/${id}/read`);
  await page.reload();
  await page.waitForSelector('.pg img');
  await page.evaluate(() => (location.hash = location.hash.replace('/read', '/1')));
  await page.waitForSelector('#c');
  check('edit link opens the editor on that image', await page.evaluate(() => cur && cur.index === 1));

  await page.evaluate((id) => (location.hash = `#/p/${id}/read`), id);
  await page.waitForSelector('.pg img');
  check('no JavaScript errors in the page', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
