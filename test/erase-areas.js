// Extra erase areas for L-shaped / split bubbles. Real server + real Chrome, Gemini stubbed.
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-erase';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  // main text area top-left; the same bubble's second text area lower down (parts)
  const out = '[{"box":[100,100,300,600],"parts":[[660,480,760,760]],"text":"ก"}]';
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) };
};
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3082';
process.env.GEMINI_API_KEY = 'stub';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // white page with a black square where the second text area is (x 200-300, y 400-450)
  const black = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#000000' } }).png().toBuffer();
  await sharp({ create: { width: 400, height: 600, channels: 3, background: '#ffffff' } })
    .composite([{ input: black, left: 200, top: 400 }]).png().toFile(`${TMP}/site/p1.png`);
  fs.writeFileSync(TMP + '/site/index.html', '<html><head><title>E</title></head><body><img src="p1.png"></body></html>');
  require('http').createServer((req, res) => {
    const f = TMP + '/site' + (req.url === '/' ? '/index.html' : req.url);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(8099);
  require(NODE + '/server.js');
  await sleep(800);
  const B = 'http://127.0.0.1:3082';
  const proj = await realFetch(B + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8099/index.html' }) }).then((r) => r.json());
  const id = proj.id;

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${B}/#/p/${id}`);
  await page.waitForSelector('#c');
  const pixel = (x, y) => page.evaluate((x, y) => { const d = document.getElementById('c').getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; }, x, y);
  const rect = () => page.evaluate(() => blocks[0].erase);

  check('before translating, the black square is visible in the canvas', (await pixel(250, 425))[0] < 20);
  await page.click('#bTr');
  await page.waitForFunction(() => blocks.length === 1, { timeout: 8000 });
  const er = await rect();
  check('"parts" from the model become an erase area in pixels', er && er.length === 1 && Math.abs(er[0].x - 192) <= 2 && Math.abs(er[0].y - 396) <= 2, JSON.stringify(er));
  await sleep(300);
  check('the extra area is erased on the canvas (black square gone)', (await pixel(250, 425))[0] > 235);
  check('a dashed erase box is shown for the selected block', (await page.$$('#boxes .ebox')).length === 1);
  check('side panel button shows the count', /\(1\)/.test(await page.$eval('[data-erase]', (b) => b.textContent)));

  await page.click('[data-erase]');
  check('"＋ พื้นที่ลบ" adds a second area', (await rect()).length === 2 && (await page.$$('#boxes .ebox')).length === 2);

  // drag the new area; it must move and the block must be marked changed
  const before = (await rect())[1];
  const box = await (await page.$$('#boxes .ebox'))[1].boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 20, { steps: 4 });
  await page.mouse.up();
  const after = (await rect())[1];
  check('dragging an erase area moves it', after.x > before.x && after.y < before.y, `${before.x},${before.y} -> ${after.x},${after.y}`);

  await page.evaluate(() => document.querySelectorAll('#boxes .ebox [data-edel]')[1].click());
  check('✕ removes that area', (await rect()).length === 1);
  await page.click('#bUndo');
  check('undo brings it back', (await rect()).length === 2);

  // side panel: every button of a block row stays inside the panel (they used to be pushed out of view)
  const fit = await page.evaluate(() => {
    const side = document.getElementById('side').getBoundingClientRect();
    return ['[data-retr]', '[data-del]'].every((q) => { const r = document.querySelector('#side ' + q).getBoundingClientRect(); return r.right <= side.right + 1 && r.left >= side.left; });
  });
  check('"↻ แปลใหม่" and "ลบ" are visible inside the side panel', fit);
  check('Thai text is not flagged', (await page.$$('#side .nothai')).length === 0);
  await page.$eval('#side textarea[data-f=text]', (t) => { t.value = 'Ah. There is one inside'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => drawSide());
  check('English text is flagged as not Thai', (await page.$$('#side .nothai')).length === 1);

  // survives save + reload
  await page.evaluate(() => flushSave());
  await sleep(500);
  const saved = await realFetch(`${B}/api/projects/${id}`).then((r) => r.json());
  check('erase areas are saved in project.json', saved.images[0].blocks[0].erase.length === 2);

  check('no JavaScript errors in the page', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
