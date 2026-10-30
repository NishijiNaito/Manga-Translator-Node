// Glossary + export, against the real server and real Chrome. Only Gemini is stubbed.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const HERE = __dirname;
const TMP = require('os').tmpdir() + '/mt-feat';
const sharp = require(NODE + '/node_modules/sharp');
const puppeteer = require('puppeteer-core');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP + '/site', { recursive: true });

const realFetch = global.fetch;
const prompts = [];
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
  const out = '[{"box":[100,100,300,600],"text":"ก"}]';
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) };
};
process.env.DATA_DIR = TMP + '/data';
process.env.PORT = '3078';
process.env.GEMINI_API_KEY = 'stub';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  for (const [i, c] of Object.entries({ 1: '#cc3333', 2: '#3333cc', 3: '#33aa33' })) {
    await sharp({ create: { width: 400, height: 600, channels: 3, background: c } }).png().toFile(`${TMP}/site/p${i}.png`);
  }
  fs.writeFileSync(TMP + '/site/index.html', '<html><head><title>Ch 1: ทดสอบ/ชื่อ</title></head><body>' + [1, 2, 3].map((i) => `<img src="p${i}.png">`).join('') + '</body></html>');
  require('http').createServer((req, res) => {
    const f = TMP + '/site' + (req.url === '/' ? '/index.html' : req.url);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(8096);

  require(NODE + '/server.js');
  await sleep(800);
  const B = 'http://127.0.0.1:3078';
  const j = (u, o) => realFetch(B + u, o).then((r) => r.json());
  const proj = await j('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8096/index.html' }) });
  const id = proj.id;
  const put = (u, body, type = 'application/json') => realFetch(B + u, { method: 'PUT', headers: { 'content-type': type }, body });

  // ============ EXPORT (API level) ============
  const exportTo = async (qs, file) => {
    const r = await realFetch(`${B}/api/projects/${id}/export${qs}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (file) fs.writeFileSync(file, buf);
    return { r, buf };
  };
  const inspect = (file) => JSON.parse(execFileSync('python', ['-I', HERE + '/zipinfo.py', file]).toString());

  let ex = await exportTo('');
  check('export with nothing translated -> 400 with a message', ex.r.status === 400, JSON.parse(ex.buf.toString()).error);

  // results for page 0 and page 2 only (distinct bytes so we can tell them apart)
  const resPng = {};
  for (const idx of [0, 2]) {
    resPng[idx] = await sharp({ create: { width: 400 + idx, height: 600, channels: 3, background: '#ffee00' } }).png().toBuffer();
    await put(`/api/projects/${id}/images/${idx}/result`, resPng[idx], 'image/png');
  }
  const orig1 = fs.readFileSync(`${TMP}/data/projects/${id}/orig/1`);

  ex = await exportTo('?format=zip', TMP + '/a.zip');
  let z = inspect(TMP + '/a.zip');
  check('zip opens in Python and every CRC is valid', z.testzip === null);
  check('translated-only: 001, 002 = page 0 and page 2 results, byte-identical',
    z.entries.length === 2 && z.entries[0][0] === '001.png' && z.entries[1][0] === '002.png'
    && z.entries[0][1] === sha(resPng[0]) && z.entries[1][1] === sha(resPng[2]), z.entries.map((e) => e[0]).join(','));
  check('entries are stored (method 0)', z.entries.every((e) => e[2] === 0));
  check('zip headers: attachment + UTF-8 title in filename*', /attachment/.test(ex.r.headers.get('content-disposition')) && /filename\*=UTF-8''Ch%201/.test(ex.r.headers.get('content-disposition')), ex.r.headers.get('content-disposition'));

  ex = await exportTo('?format=cbz&originals=1', TMP + '/b.cbz');
  z = inspect(TMP + '/b.cbz');
  check('cbz + originals: 3 pages, numbering follows page order (001 result, 002 original, 003 result)',
    z.entries.map((e) => e[0]).join() === '001.png,002.png,003.png'
    && z.entries[0][1] === sha(resPng[0]) && z.entries[1][1] === sha(orig1) && z.entries[2][1] === sha(resPng[2]));
  check('cbz content-type', /comicbook/.test(ex.r.headers.get('content-type')) && /\.cbz/.test(ex.r.headers.get('content-disposition')));

  await put(`/api/projects/${id}/images/2/skip`, JSON.stringify({ skipped: true }));
  await exportTo('?originals=1', TMP + '/c.zip');
  z = inspect(TMP + '/c.zip');
  check('skipped image is left out (and numbering closes up)', z.entries.map((e) => e[0]).join() === '001.png,002.png');
  await put(`/api/projects/${id}/images/2/skip`, JSON.stringify({ skipped: false }));

  // ============ GLOSSARY + dialogs (browser) ============
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  const reqs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => reqs.push(r.url()));
  await page.goto(`${B}/#/p/${id}`);
  await page.waitForSelector('#c');

  check('Glossary button starts without a tick', (await page.$eval('#bGloss', (b) => b.textContent)).trim() === '📖 Glossary');
  await page.click('#bGloss');
  await page.waitForFunction(() => document.getElementById('dlgGloss').open);
  await page.type('#glossText', 'Iruma = อิรุมะ\nBabel = บาเบล');
  await page.click('#glossSave');
  await page.waitForFunction(() => P.glossary && P.glossary.includes('Babel'), { timeout: 4000 });
  check('saving glossary updates the project and the button gets a tick', (await page.$eval('#bGloss', (b) => b.textContent)).includes('✓'));
  const saved = (await j(`/api/projects/${id}`)).glossary;
  check('glossary is persisted on the server', saved === 'Iruma = อิรุมะ\nBabel = บาเบล');

  prompts.length = 0;
  await page.click('#bTr');
  await page.waitForFunction(() => document.querySelectorAll('#side .blk').length === 1, { timeout: 8000 });
  check('glossary text is sent to the model with the next translate',
    prompts.length === 1 && prompts[0].includes('PROJECT GLOSSARY') && prompts[0].includes('Iruma = อิรุมะ') && prompts[0].includes('Babel = บาเบล'));

  // no glossary -> no glossary section in the prompt
  await put(`/api/projects/${id}/glossary`, JSON.stringify({ text: '' }));
  prompts.length = 0;
  await j(`/api/projects/${id}/images/1/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('empty glossary adds nothing to the prompt', prompts.length === 1 && !prompts[0].includes('GLOSSARY'));

  // export dialog
  await page.evaluate(() => { P.images.forEach((i) => { i.hasResult = i.index !== 1; }); }); // mirror server: pages 0 and 2 done
  await page.click('#bExport');
  await page.waitForFunction(() => document.getElementById('dlgExport').open);
  const info = await page.$eval('#expInfo', (e) => e.textContent);
  check('export dialog shows done/total', /แปลแล้ว 2 จาก 3/.test(info), info);
  await page.click('input[name=expfmt][value=cbz]');
  reqs.length = 0;
  await page.click('#expGo');
  await sleep(600);
  check('Download requests the export URL with the chosen format',
    reqs.some((u) => u.includes(`/api/projects/${id}/export?format=cbz&originals=0`)), reqs.filter((u) => u.includes('export')).join(' '));

  check('no JavaScript errors in the page', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
