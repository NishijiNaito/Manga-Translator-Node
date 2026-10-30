// Source text, single-box re-translate, and the cost confirm. Real server + real Chrome;
// only the Gemini endpoint is stubbed (and records what it was asked).
const fs = require('fs');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const TMP = require('os').tmpdir() + '/mt-feat2';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });

const realFetch = global.fetch;
const asked = []; // { prompt, imgW, imgH }
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  const body = JSON.parse(init.body);
  const prompt = body.contents[0].parts[0].text;
  const meta = await sharp(Buffer.from(body.contents[0].parts[1].inline_data.data, 'base64')).metadata();
  asked.push({ prompt, imgW: meta.width, imgH: meta.height });
  const region = prompt.includes('crop of a manga page');
  const wantSource = prompt.includes('"source"');
  const out = region
    ? '[{"box":[0,0,1000,1000],"source":"原文NEW","text":"แปลใหม่"}]'
    : wantSource
      ? '[{"box":[100,100,300,600],"source":"原文A","text":"ก"},{"box":[500,100,700,600],"source":"原文B","text":"ข"}]'
      : '[{"box":[100,100,300,600],"text":"ก"},{"box":[500,100,700,600],"text":"ข"}]';
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } }) };
};
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3079';
process.env.APP_SECRET = ''; // a real .env may set it: these tests run the server in local mode
process.env.GEMINI_API_KEY = 'stub';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const [i, c] of Object.entries({ 1: '#cc3333', 2: '#3333cc', 3: '#33aa33' })) {
    await sharp({ create: { width: 400, height: 600, channels: 3, background: c } }).png().toFile(`${TMP}/site/p${i}.png`);
  }
  fs.writeFileSync(TMP + '/site/index.html', '<html><head><title>T</title></head><body>' + [1, 2, 3].map((i) => `<img src="p${i}.png">`).join('') + '</body></html>');
  require('http').createServer((req, res) => {
    const f = TMP + '/site' + (req.url === '/' ? '/index.html' : req.url);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(8094);
  require(NODE + '/server.js');
  await sleep(800);

  const B = 'http://127.0.0.1:3079';
  const j = (u, o) => realFetch(B + u, o).then((r) => r.json());
  const proj = await j('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8094/index.html' }) });
  const id = proj.id;

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  const dialogs = [];
  let dialogAnswer = true;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { dialogs.push(d.message()); await (dialogAnswer ? d.accept() : d.dismiss()); });
  await page.goto(`${B}/#/p/${id}`);
  await page.waitForSelector('#c');

  // ---- 1. source text on by default ----
  asked.length = 0;
  await page.click('#bTr');
  await page.waitForFunction(() => document.querySelectorAll('#side .blk').length === 2, { timeout: 8000 });
  check('default: prompt asks for the original text ("source")', asked.length === 1 && asked[0].prompt.includes('"source"'));
  const srcTexts = await page.$$eval('#side .blk .src', (els) => els.map((e) => e.textContent));
  check('side panel shows the original text under each translation', srcTexts.length === 2 && srcTexts[0].includes('原文A') && srcTexts[1].includes('原文B'), srcTexts.join(' | '));

  // ---- 2. turning it off ----
  await page.evaluate(() => localStorage.setItem('mt-settings', JSON.stringify({ withSource: false })));
  asked.length = 0;
  await page.evaluate(() => { cur = P.images[1]; });
  const r2 = await j(`/api/projects/${id}/images/1/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ withSource: false }) });
  check('setting off: prompt does not ask for "source", blocks carry none',
    asked.length === 1 && !asked[0].prompt.includes('"source"') && r2.image.blocks.every((b) => b.source === undefined));
  await page.evaluate(() => localStorage.removeItem('mt-settings'));
  await page.evaluate(() => selectImage(0)); // back to image 0

  // ---- 3. re-translate ONE box ----
  await page.waitForFunction(() => cur.index === 0 && blocks.length === 2);
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(blocks)));
  const reqsBefore = (await j(`/api/projects/${id}`)).usage.requests;
  asked.length = 0;
  await page.click('#side .blk:nth-child(1) [data-retr]');
  await page.waitForFunction(() => blocks[0].text === 'แปลใหม่', { timeout: 8000 });
  check('re-translate sends ONE small request', asked.length === 1);
  check('...and it is a crop around the box, not the whole image', asked[0].imgW < 400 && asked[0].imgH < 600, `${asked[0].imgW}x${asked[0].imgH} (page is 400x600)`);
  check('...in single-region mode', asked[0].prompt.includes('crop of a manga page'));
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(blocks)));
  // `bg` is the background colour sampled lazily on first paint, so ignore it.
  const strip = ({ bg, ...rest }) => JSON.stringify(rest);
  const same = strip(after[1]) === strip(before[1]);
  if (!same) console.log('   before[1] =', JSON.stringify(before[1]), '\n   after[1]  =', JSON.stringify(after[1]));
  check('only that box changed; the other keeps its text, position and source',
    after[0].text === 'แปลใหม่' && after[0].source === '原文NEW' && same);
  check('the box keeps its position and size', ['x', 'y', 'w', 'h'].every((k) => after[0][k] === before[0][k]));
  await sleep(1000);
  check('token usage was recorded for it', (await j(`/api/projects/${id}`)).usage.requests === reqsBefore + 1);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  check('Ctrl+Z restores the old text', (await page.evaluate(() => blocks[0].text)) === before[0].text);

  // ---- 4. cost confirm before "translate all" ----
  asked.length = 0; dialogs.length = 0; dialogAnswer = false;
  await page.click('#bAll');
  await sleep(500);
  check('translate-all asks to confirm, with an estimate from this project', dialogs.length === 1 && /แปล 2 รูป/.test(dialogs[0]) && /ประมาณ/.test(dialogs[0]) && /≈ \$/.test(dialogs[0]), dialogs[0].replace(/\n/g, ' / '));
  check('dismissing the confirm sends nothing', asked.length === 0);
  dialogAnswer = true; dialogs.length = 0;
  await page.click('#bAll');
  await page.waitForFunction(() => P.images.every((i) => i.status !== 'new'), { timeout: 15000 });
  check('accepting runs the batch', asked.length >= 2);

  // a brand-new project has no history -> says so instead of inventing a number
  const fresh = await j('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8094/index.html' }) });
  await page.goto(`${B}/#/p/${fresh.id}`);
  await page.reload();
  await page.waitForSelector('#c');
  dialogs.length = 0; dialogAnswer = false;
  await page.click('#bAll');
  await sleep(400);
  check('no history yet -> confirm says it cannot estimate (no made-up number)', dialogs.length === 1 && /ยังประเมินค่าใช้จ่ายไม่ได้/.test(dialogs[0]), dialogs[0] && dialogs[0].replace(/\n/g, ' / '));

  check('no JavaScript errors in the page', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
