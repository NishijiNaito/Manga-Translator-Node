// Loads the REAL extension into Chrome and drives it end to end against the real server.
// Messages go through chrome.runtime.sendMessage from the popup page, i.e. the same
// path the popup buttons use. No Gemini is needed (results are uploaded via the API).
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const EXT = NODE + '/extension';
const TMP = require('os').tmpdir() + '/mt-ext';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });

process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3080';
process.env.APP_SECRET = ''; // a real .env may set it: these tests run the server in local mode
process.env.GEMINI_API_KEY = 'stub';
const SITE = 'http://127.0.0.1:8093';
const APP = 'http://127.0.0.1:3080';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 8000, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

(async () => {
  for (const [name, w, h, c] of [['icon', 50, 50, '#000000'], ['p1', 400, 600, '#cc3333'], ['p2', 400, 600, '#3333cc'], ['p3', 400, 600, '#33aa33']]) {
    await sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toFile(`${TMP}/site/${name}.png`);
  }
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  fs.writeFileSync(TMP + '/site/index.html', `<html><head><title>Chapter</title></head><body>
    <img id="icon" src="icon.png">
    <img id="plain" src="p1.png">
    <img id="lazy" src="${GIF}" data-src="p2.png">
    <script>
      // an image that only exists inside this page: the server can never fetch a blob: URL
      fetch('p3.png').then(r => r.blob()).then(b => { const i = new Image(); i.id = 'blob'; i.src = URL.createObjectURL(b); document.body.appendChild(i); });
    </script></body></html>`);
  fs.writeFileSync(TMP + '/site/other.html', '<html><body><img id="x" src="p1.png"></body></html>');
  require('http').createServer((req, res) => {
    const u = req.url.split('?')[0];
    const f = TMP + '/site' + (u === '/' ? '/index.html' : u);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(8093);
  require(NODE + '/server.js');
  await sleep(800);
  const j = (u, o) => fetch(APP + u, o).then((r) => r.json());

  const browser = await puppeteer.launch({
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', // branded Chrome ignores --load-extension
    headless: 'new',
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 }).catch(() => null);
  check('extension loads and its service worker starts', !!swTarget);
  if (!swTarget) { await browser.close(); process.exit(1); }
  const extId = new URL(swTarget.url()).host;

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const send = (action, tabId) => popup.evaluate((a, t) => chrome.runtime.sendMessage({ action: a, tabId: t }), action, tabId);
  const storage = (obj) => popup.evaluate((o) => chrome.storage.local.set(o), obj);
  await storage({ serverUrl: APP, autoSwap: false });
  await popup.reload();

  // ---------- popup UI ----------
  check('popup shows the server URL and the auto-swap box (off)', (await popup.$eval('#server', (e) => e.value)) === APP && (await popup.$eval('#auto', (e) => e.checked)) === false);
  await popup.click('#auto');
  check('ticking the box saves autoSwap', (await popup.evaluate(() => chrome.storage.local.get('autoSwap'))).autoSwap === true);
  await popup.click('#auto');
  check('unticking turns it back off', (await popup.evaluate(() => chrome.storage.local.get('autoSwap'))).autoSwap === false);

  // ---------- the manga page ----------
  const tab = await browser.newPage();
  await tab.goto(`${SITE}/index.html`);
  await tab.waitForFunction(() => document.getElementById('blob') && document.getElementById('blob').complete && document.getElementById('blob').naturalWidth > 0);
  const tabId = await popup.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0].id, `${SITE}/index.html*`);
  const imgState = () => tab.$$eval('img', (els) => els.map((e) => ({ id: e.id, src: e.getAttribute('src'), swapped: !!e.dataset.mtOrig })));
  const orig = await imgState();

  // SWAP before anything was sent
  let r = await send('SWAP', tabId);
  check('swap on a page never sent -> clear message, nothing changes', r.ok === false && /ยังไม่เคยส่ง/.test(r.error) && (await imgState()).every((i) => !i.swapped), r.error);

  // ---------- SEND ----------
  r = await send('SEND', tabId);
  check('SEND succeeds and reports 3 usable images (icon skipped)', r.ok === true && r.count === 3, JSON.stringify(r));
  const proj = await j(`/api/projects/${r.id}`);
  const urls = proj.images.map((i) => i.url);
  check('project has the normal image, the lazy data-src image and the blob: image',
    urls.some((u) => u.endsWith('/p1.png')) && urls.some((u) => u.endsWith('/p2.png')) && urls.some((u) => u.startsWith('blob:')), urls.join(' , '));
  const blobRec = proj.images.find((i) => i.url.startsWith('blob:'));
  check('the blob: image bytes were uploaded by the extension (server could not fetch it)', !!blobRec && blobRec.width === 400 && blobRec.height === 600);
  check('the editor opened in a new tab', (await browser.pages()).some((p) => p.url().includes(`/#/p/${r.id}`)));

  // ---------- SWAP with nothing translated yet ----------
  r = await send('SWAP', tabId);
  check('swap before any image is "applied" -> tells you what to do', r.ok === false && /ใช้รูปนี้|ใช้ทั้งหมด/.test(r.error), r.error);

  // translated results (distinct sizes so they are recognisable)
  for (const im of proj.images) {
    const png = await sharp({ create: { width: 300 + im.index, height: 500, channels: 3, background: '#ffee00' } }).png().toBuffer();
    await fetch(`${APP}/api/projects/${proj.id}/images/${im.index}/result`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  }

  // ---------- SWAP ----------
  r = await send('SWAP', tabId);
  check('SWAP replaces the 3 images', r.ok === true && r.swapped === 3, JSON.stringify(r));
  let now = await imgState();
  const swappedOk = ['plain', 'lazy', 'blob'].every((id) => { const e = now.find((i) => i.id === id); return e.swapped && e.src.startsWith(`${APP}/files/${proj.id}/result/`); });
  check('the page now points at translated images from the server; the icon is untouched', swappedOk && !now.find((i) => i.id === 'icon').swapped);
  await tab.waitForFunction(() => [...document.querySelectorAll('img')].filter((i) => i.dataset.mtOrig).every((i) => i.complete && i.naturalWidth > 0));
  const dims = await tab.$$eval('img[data-mt-orig]', (els) => els.map((e) => e.naturalWidth).sort());
  check('they actually load (translated images are 301-303px wide; indices are DOM positions 1-3)', dims.length === 3 && dims.every((w) => w >= 301 && w <= 303), dims.join(','));
  r = await send('SWAP', tabId);
  check('swapping twice is harmless (nothing swapped again)', r.ok === true && r.swapped === 0, JSON.stringify(r));

  // ---------- RESTORE ----------
  r = await send('RESTORE', tabId);
  check('RESTORE puts all 3 back', r.ok === true && r.restored === 3, JSON.stringify(r));
  now = await imgState();
  check('originals are exactly as before (src + lazy data-src)', JSON.stringify(now) === JSON.stringify(orig), JSON.stringify(now.map((i) => i.src && i.src.slice(0, 30))));
  check('lazy image still has its data-src', (await tab.$eval('#lazy', (e) => e.getAttribute('data-src'))) === 'p2.png');

  // ---------- auto-swap ----------
  await storage({ autoSwap: true });
  await tab.reload();
  const autoSwapped = await waitFor(async () => (await tab.$$eval('img', (els) => els.filter((e) => e.dataset.mtOrig).map((e) => e.id))).includes('plain'), 8000);
  const ids = await tab.$$eval('img', (els) => els.filter((e) => e.dataset.mtOrig).map((e) => e.id));
  check('auto-swap ON: reloading the page swaps the normal + lazy images by itself', !!autoSwapped && ids.includes('plain') && ids.includes('lazy'), ids.join(','));
  check('(known limit) the blob: image is NOT matched after a reload, its URL is new each time', !ids.includes('blob'), ids.join(','));

  await storage({ autoSwap: false });
  await tab.reload();
  await sleep(2500);
  check('auto-swap OFF: reloading swaps nothing', (await tab.$$eval('img', (els) => els.filter((e) => e.dataset.mtOrig).length)) === 0);

  // a different page with no project: auto-swap on must stay quiet
  await storage({ autoSwap: true });
  const other = await browser.newPage();
  await other.goto(`${SITE}/other.html`);
  await sleep(2000);
  check('auto-swap ON on a page with no project: nothing happens', (await other.$$eval('img', (els) => els.filter((e) => e.dataset.mtOrig).length)) === 0);

  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
