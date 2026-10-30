// Continuous reading mode, against the real server and real Chrome. No LLM involved.
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-reader';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3081';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = global.fetch;

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
