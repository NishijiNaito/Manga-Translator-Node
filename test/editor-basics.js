// Drives the real editor in headless Chrome against the real server, with only the
// Gemini endpoint stubbed (so no key / network is needed).
const path = require('path');
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-ui';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ---- stub ONLY Gemini; everything else uses the real fetch ----
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  const out = '[{"box":[100,100,300,600],"text":"ก"},{"box":[500,100,700,600],"text":"ข"}]';
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) };
};

process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3077';
process.env.APP_SECRET = ''; // a real .env may set it: these tests run the server in local mode
process.env.GEMINI_API_KEY = 'stub';
const SITE_PORT = 8097;

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // three solid-colour pages so we can tell WHICH image a background came from
  const colours = { 1: '#cc3333', 2: '#3333cc', 3: '#33aa33' };
  fs.mkdirSync(TMP + '/site');
  for (const [i, c] of Object.entries(colours)) {
    await sharp({ create: { width: 400, height: 600, channels: 3, background: c } }).png().toFile(`${TMP}/site/p${i}.png`);
  }
  fs.writeFileSync(TMP + '/site/index.html', '<html><head><title>T</title></head><body>' + [1, 2, 3].map((i) => `<img src="p${i}.png">`).join('') + '</body></html>');
  const http = require('http');
  http.createServer((req, res) => {
    const f = TMP + '/site' + (req.url === '/' ? '/index.html' : req.url);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(SITE_PORT);

  require(NODE + '/server.js');
  await sleep(800);
  const api = (u, o) => realFetch('http://127.0.0.1:3077' + u, o).then((r) => r.json());
  const proj = await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${SITE_PORT}/index.html` }) });
  const id = proj.id;
  const status = async () => (await api('/api/projects/' + id)).images;

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace('http://127.0.0.1:3077', '')}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:3077/#/p/${id}`);
  await page.waitForSelector('#c');
  check('editor loads with 3 thumbnails + canvas', (await page.$$('.thumb')).length === 3);

  // ---- translate image 0 (stub returns 2 boxes) ----
  await page.click('#bTr');
  await page.waitForFunction(() => document.querySelectorAll('#side .blk').length === 2, { timeout: 8000 });
  check('translate fills 2 blocks', true);
  const first = await page.evaluate(() => selId);

  // ---- Tab walks blocks and selects ----
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => selId);
  check('Tab selects the next block', afterTab !== first, `${first} -> ${afterTab}`);
  const selMarked = await page.evaluate(() => document.querySelectorAll('#side .blk.sel').length === 1 && document.querySelectorAll('#boxes .box.sel').length === 1);
  check('exactly one block highlighted in both side list and canvas', selMarked);

  // ---- Delete + undo / redo ----
  await page.keyboard.press('Delete');
  check('Delete removes the selected block', await page.evaluate(() => blocks.length) === 1);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  check('Ctrl+Z brings the block back', await page.evaluate(() => blocks.length) === 2);
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  check('Ctrl+Y removes it again', await page.evaluate(() => blocks.length) === 1);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  check('undo button state reflects history', await page.evaluate(() => !document.getElementById('bRedo').disabled));

  // ---- typing coalesces into ONE undo step and doesn't hijack Ctrl+Z ----
  await page.evaluate(() => { undoStack = []; redoStack = []; lastUndoTag = ''; });
  await page.click('#side .blk textarea');
  await page.keyboard.type('hello world');
  const steps = await page.evaluate(() => undoStack.length);
  check('typing a sentence = 1 undo step (not 11)', steps === 1, `steps=${steps}`);
  await page.keyboard.press('Escape');

  // ---- Space shows original, releasing restores ----
  await page.keyboard.down('Space');
  const holding = await page.evaluate(() => showOrig);
  await page.keyboard.up('Space');
  check('hold Space shows original, release hides it', holding === true && (await page.evaluate(() => showOrig)) === false);

  // ---- navigating away from an edited image renders it (no manual "apply") ----
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => cur && cur.index === 1, { timeout: 5000 });
  check('ArrowRight moves to the next image', true);
  let img = (await status())[0];
  for (let i = 0; i < 20 && !img.hasResult; i++) { await sleep(250); img = (await status())[0]; }
  check('edited image was auto-rendered when leaving it', img.hasResult === true, `status=${img.status}`);

  // ---- auto-apply after 3s of quiet ----
  await page.click('#bTr'); // image index 1
  await page.waitForFunction(() => cur.index === 1 && blocks.length === 2, { timeout: 8000 });
  await page.keyboard.press('a'); // add a block
  check("'A' adds a block", await page.evaluate(() => blocks.length) === 3);
  let two = (await status())[1];
  check('result is NOT rendered immediately', two.hasResult === false);
  await sleep(3800);
  two = (await status())[1];
  check('auto-apply rendered it after ~3s idle', two.hasResult === true, `status=${two.status}`);

  // ---- the bug fix: Apply-all must sample colours from EACH image, not the open one ----
  await api(`/api/projects/${id}/images/2/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  // current image is #1 (blue). Apply image #2 (green) through the same code path as "ใช้ทั้งหมด".
  await page.evaluate(async () => { P.images.find((i) => i.index === 2).blocks = (await (await fetch(`/api/projects/${P.id}`)).json()).images[2].blocks; });
  await page.evaluate(() => applyImage(2, false));
  const png = await fetch(`http://127.0.0.1:3077/files/${id}/result/2.png`).then((r) => r.arrayBuffer());
  const { data, info } = await sharp(Buffer.from(png)).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const o = (y * info.width + x) * info.channels; return [data[o], data[o + 1], data[o + 2]]; };
  // block 1 = box [100,100,300,600] -> x 40..240 (of 400), y 60..180 (of 600); take its top-left inner pixel
  const [r, g, b] = px(44, 64);
  check('non-open image gets ITS OWN background colour (green), not the open image\'s (blue)', g > r && g > b, `rgb=${r},${g},${b}`);

  // ---- settings: auto-apply can be turned off ----
  await page.evaluate(() => localStorage.setItem('mt-settings', JSON.stringify({ autoApply: false })));
  const off = await page.evaluate(() => autoApplyOn());
  check('autoApply setting off is honoured', off === false);

  console.log('HTTP >=400 responses seen:', bad.length ? bad.join(' | ') : 'none');
  const realErrors = errors.filter((e) => !(e.includes('404') && bad.every((b) => b.includes('favicon'))));
  check('no JavaScript errors in the page (favicon 404 ignored)', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
