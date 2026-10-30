require('dotenv').config();
const express = require('express');
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { extractImages, rewriteHtml } = require('./lib/extract');
const { translateImage, translateRegion, listModels } = require('./lib/llm');
const { streamZip } = require('./lib/zip');
const { safeGet, makeAuth, makeLimiter, parseCookies } = require('./lib/security');
const { createStorage } = require('./lib/storage');

const PORT = Number(process.env.PORT || 3000);
// Loopback by default: this server fetches arbitrary URLs for you, so don't
// expose it to a network unless you mean to (set HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MIN_SIDE = Number(process.env.MIN_IMAGE_SIDE || 150); // skip icons / avatars
const MAX_BYTES = 30 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; MangaTranslatorNode/1.0)';

// Where the images live: local disk (default) or an R2 bucket (STORAGE=r2). See lib/storage.js.
let storage;
try {
  storage = createStorage({ dataDir: DATA_DIR });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ---------- hosted mode ----------
// APP_SECRET set = the server is meant to be reachable from the internet: login required,
// fetches to private networks refused, links to files are signed. Without it the server
// is a local tool and refuses to listen on anything but loopback.
const SECRET = (process.env.APP_SECRET || '').trim();
const HOSTED = !!SECRET;
if (!HOSTED && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`Refusing to listen on ${HOST} without APP_SECRET: this server has no login of its own. Set APP_SECRET (16+ characters) in .env.`);
  process.exit(1);
}
if (HOSTED && SECRET.length < 16) {
  console.error('APP_SECRET is too short: use at least 16 random characters (e.g. `openssl rand -base64 24`).');
  process.exit(1);
}
const auth = HOSTED ? makeAuth(SECRET) : null;
const SESSION_TTL = 30 * 24 * 3600;
const MAX_PROJECTS = Number(process.env.MAX_PROJECTS || 300);
const MAX_IMAGES = Number(process.env.MAX_IMAGES_PER_PROJECT || 400);
const loginFails = makeLimiter(5, 15 * 60_000);            // wrong secrets per IP
const llmCalls = makeLimiter(Number(process.env.LLM_CALLS_PER_MIN || 90), 60_000); // spend guard

// A link to /files/... that works without a cookie (other sites' pages load our images).
const fileLink = (pathname, ttlSec) => (auth ? auth.signPath(pathname, ttlSec) : pathname);

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

// Headers on everything. (/view overrides the CSP with a stricter sandbox.)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '5mb' }));

if (HOSTED) {
  const sameOrigin = (req) => {
    const o = req.get('origin');
    if (!o) return true;
    try { return new URL(o).host === req.get('host'); } catch { return false; }
  };
  const bearer = (req) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    return !!m && auth.secretOk(m[1]);
  };
  const cookieOk = (req) => auth.checkSession(parseCookies(req.headers.cookie).mt_session);
  const secureCookie = (req) => req.secure || process.env.COOKIE_SECURE === '1';

  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));

  app.post('/api/login', (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
    const ip = req.ip;
    if (loginFails.full(ip)) return res.status(429).json({ error: 'ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่' });
    if (!auth.secretOk(String(req.body?.secret || ''))) {
      loginFails.add(ip);
      return res.status(401).json({ error: 'รหัสไม่ถูกต้อง' });
    }
    loginFails.reset(ip);
    res.set('Set-Cookie', `mt_session=${auth.issueSession(SESSION_TTL)}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; SameSite=Strict${secureCookie(req) ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `mt_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secureCookie(req) ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  // The gate: a Bearer secret (extension), the login cookie (browser), or a signed /files link.
  app.use((req, res, next) => {
    if (bearer(req)) return next();
    if (cookieOk(req)) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
        return res.status(403).json({ error: 'Cross-origin request refused' });
      }
      return next();
    }
    if (req.method === 'GET' && req.path.startsWith('/files/') && auth.checkPath(req.path, req.query.e, req.query.s)) return next();
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/files/')) return res.redirect('/login');
    res.status(401).json({ error: 'Unauthorized' });
  });
}

app.get('/api/session', (req, res) => res.json({ hosted: HOSTED }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- storage helpers ----------
const ID_RE = /^[a-f0-9]{12}$/;
const projectDir = (id) => path.join(DATA_DIR, 'projects', id);
const projectFile = (id) => path.join(projectDir(id), 'project.json');

async function loadProject(id) {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(projectFile(id), 'utf8'));
  } catch {
    return null;
  }
}

// Serialize writes per project so concurrent image jobs don't clobber each other.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

function saveProject(p) {
  return fs.writeFile(projectFile(p.id), JSON.stringify(p, null, 2));
}

function updateImage(id, index, patch) {
  return withLock(id, async () => {
    const p = await loadProject(id);
    const img = p?.images.find((i) => i.index === index);
    if (!img) throw Object.assign(new Error('Image not found'), { status: 404 });
    Object.assign(img, typeof patch === 'function' ? patch(img) : patch);
    await saveProject(p);
    return img;
  });
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    // Hosted: never show file-system errors (they contain server paths).
    const fsErr = HOSTED && !e.status && /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST|EMFILE)$/.test(String(e.code));
    res.status(e.status || 500).json({ error: fsErr ? 'Server error' : e.message });
  });

function getIndex(req) {
  const i = Number(req.params.i);
  if (!Number.isInteger(i) || i < 0) throw Object.assign(new Error('Bad image index'), { status: 400 });
  return i;
}

async function needProject(req) {
  const p = await loadProject(req.params.id);
  if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
  return p;
}

// ---------- fetching ----------
async function fetchBuffer(url, referer) {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:[^;,]+(;base64)?,(.*)$/s);
    if (!m) throw new Error('Bad data URL');
    return Buffer.from(m[2], m[1] ? 'base64' : 'utf8');
  }
  const res = await safeGet(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    maxBytes: MAX_BYTES, allowPrivate: !HOSTED,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.buffer;
}

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
}

// ---------- projects ----------
app.post('/api/projects', wrap(async (req, res) => {
  let { url, html, baseUrl } = req.body || {};
  // Extension mode: the browser already knows the page's real <img> list (logged-in,
  // lazy-loaded, JS-rendered), so it sends that instead of HTML.
  const given = Array.isArray(req.body?.images) ? req.body.images : null;
  if (given) {
    baseUrl = String(req.body.pageUrl || '');
    html = html || '';
  } else if (url) {
    const r = await safeGet(String(url), { headers: { 'User-Agent': UA }, maxBytes: MAX_BYTES, allowPrivate: !HOSTED });
    if (!r.ok) throw Object.assign(new Error(`Could not fetch page: HTTP ${r.status}`), { status: 502 });
    html = r.buffer.toString('utf8');
    baseUrl = r.url || url;
  }
  if (!given && !html) throw Object.assign(new Error('Provide "url", "html" or "images"'), { status: 400 });

  if (HOSTED && (await fs.readdir(path.join(DATA_DIR, 'projects')).catch(() => [])).length >= MAX_PROJECTS) {
    throw Object.assign(new Error(`มีโปรเจ็คครบ ${MAX_PROJECTS} แล้ว ลบอันเก่าก่อน`), { status: 400 });
  }
  const found = (given
    ? given.filter((g) => g && Number.isInteger(g.index) && typeof g.url === 'string')
        .map((g) => ({ index: g.index, url: g.url, alt: '' }))
    : extractImages(html, baseUrl || '')).slice(0, MAX_IMAGES);
  const id = crypto.randomBytes(6).toString('hex');
  await storage.init(id);
  if (html) await fs.writeFile(path.join(projectDir(id), 'page.html'), html);

  const images = [];
  const failed = []; // couldn't be downloaded server-side (the extension can retry)
  await pool(found, 4, async (f) => {
    try {
      const buf = await fetchBuffer(f.url, baseUrl);
      const meta = await sharp(buf).metadata();
      if (!meta.width || meta.width < MIN_SIDE || meta.height < MIN_SIDE) return;
      await storage.put(id, 'orig', f.index, buf);
      images.push({
        index: f.index, url: f.url, alt: f.alt,
        width: meta.width, height: meta.height,
        status: 'new', blocks: [], hasResult: false,
      });
    } catch (e) {
      console.warn(`skip image ${f.url}: ${e.message}`);
      failed.push({ index: f.index, url: f.url });
    }
  });
  images.sort((a, b) => a.index - b.index);

  const project = {
    id, sourceUrl: baseUrl || '',
    title: String(req.body?.title || '').trim() || (html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim() || baseUrl || id,
    createdAt: new Date().toISOString(), images,
  };
  await saveProject(project);
  res.json({ ...project, failed });
}));

// Upload the bytes of an image the server couldn't fetch itself (cookies,
// hotlink protection, blob: URLs). Adds or replaces that image in the project.
app.put('/api/projects/:id/images/:i/source', express.raw({ type: '*/*', limit: '32mb' }), wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Empty body'), { status: 400 });
  const meta = await sharp(req.body).metadata();
  if (!meta.width || meta.width < MIN_SIDE || meta.height < MIN_SIDE) return res.json({ skipped: true });
  await storage.put(p.id, 'orig', index, req.body);
  await withLock(p.id, async () => {
    const fresh = await loadProject(p.id);
    const rec = { index, url: String(req.query.url || ''), alt: '', width: meta.width, height: meta.height,
      status: 'new', blocks: [], hasResult: false };
    const at = fresh.images.findIndex((i) => i.index === index);
    if (at >= 0) fresh.images[at] = rec; else fresh.images.push(rec);
    fresh.images.sort((a, b) => a.index - b.index);
    await saveProject(fresh);
  });
  res.json({ ok: true });
}));

// Newest project created for a given page URL (the extension uses this to find
// what to swap in on the page you're looking at).
app.get('/api/lookup', wrap(async (req, res) => {
  const want = String(req.query.url || '');
  let ids = [];
  try { ids = await fs.readdir(path.join(DATA_DIR, 'projects')); } catch { /* none yet */ }
  let best = null;
  for (const id of ids) {
    const p = await loadProject(id);
    if (p && p.sourceUrl === want && (!best || p.createdAt > best.createdAt)) best = p;
  }
  if (!best) throw Object.assign(new Error('No project for this page'), { status: 404 });
  res.json({ id: best.id, title: best.title, images: best.images.length, done: best.images.filter((i) => i.hasResult).length });
}));

app.get('/api/projects', wrap(async (req, res) => {
  let ids = [];
  try { ids = await fs.readdir(path.join(DATA_DIR, 'projects')); } catch { /* none yet */ }
  const list = [];
  for (const id of ids) {
    const p = await loadProject(id);
    if (p) list.push({ id, title: p.title, sourceUrl: p.sourceUrl, createdAt: p.createdAt,
      images: p.images.filter((i) => !i.skipped).length, done: p.images.filter((i) => (i.hasResult || i.keep) && !i.skipped).length });
  }
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
}));

app.get('/api/projects/:id', wrap(async (req, res) => res.json(await needProject(req))));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const p = await needProject(req);
  await storage.removeProject(p.id, p.images.map((i) => i.index));
  res.json({ ok: true });
}));

// Models the chosen provider offers (key from the request, else from .env).
app.get('/api/models', wrap(async (req, res) => {
  const provider = req.get('x-provider') === 'openrouter' ? 'openrouter' : 'gemini';
  const apiKey = (req.get('x-api-key') || (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY) || '').trim();
  try {
    res.json(await listModels(provider, apiKey));
  } catch (e) {
    throw Object.assign(e, { status: 502 });
  }
}));

// ---------- translate / edit / result ----------
// Running totals per project, so the page can show what this chapter has cost.
function recordUsage(id, usage) {
  return withLock(id, async () => {
    const fresh = await loadProject(id);
    const t = fresh.usage || { requests: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0, unpriced: 0, estimated: false };
    t.requests += 1;
    t.prompt_tokens += usage.prompt_tokens;
    t.completion_tokens += usage.completion_tokens;
    if (usage.cost === null) t.unpriced += 1; else t.cost += usage.cost;
    t.estimated = t.estimated || usage.estimated;
    fresh.usage = t;
    await saveProject(fresh);
    return t;
  });
}

const spendGuard = (req, res, next) => {
  if (HOSTED && !llmCalls.hit('all')) return res.status(429).json({ error: 'เรียก AI ถี่เกินไป รอสักครู่' });
  next();
};

app.post('/api/projects/:id/images/:i/translate', spendGuard, wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!p.images.some((i) => i.index === index)) throw Object.assign(new Error('Image not found'), { status: 404 });
  const buf = await storage.get(p.id, 'orig', index);
  // sweep: keep the blocks already there (including the user's edits) and only
  // look for text that was missed.
  const sweep = !!req.body?.sweep;
  const kept = sweep ? p.images.find((i) => i.index === index).blocks || [] : [];
  const out = await translateImage(buf, {
    provider: req.get('x-provider'),
    apiKey: req.get('x-api-key'),
    model: req.get('x-model'),
    language: req.body?.language || 'auto',
    existing: sweep ? kept : null,
    slice: !!req.body?.slice,
    glossary: p.glossary || '',
    withSource: req.body?.withSource !== false, // original text next to the translation (costs some output tokens)
    skipTitles: !!req.body?.skipTitles,
  });
  let nextId = Math.max(0, ...kept.map((b) => b.id || 0)) + 1;
  const blocks = [...kept, ...out.blocks.map((b) => ({ id: nextId++, ...b }))];
  const img = await updateImage(p.id, index, { blocks, status: 'translated', hasResult: false, keep: false });
  await storage.del(p.id, 'result', index);
  res.json({ image: img, usage: out.usage, dropped: out.dropped || 0, total: await recordUsage(p.id, out.usage) });
}));

// Re-translate a single box (crop + one small request) instead of the whole image.
// The client sends the box's current rectangle and applies the text itself, so edits
// you've made to the other boxes are never touched.
app.post('/api/projects/:id/images/:i/retranslate-block', spendGuard, wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!p.images.some((i) => i.index === index)) throw Object.assign(new Error('Image not found'), { status: 404 });
  const { x, y, w, h } = req.body || {};
  if (![x, y, w, h].every(Number.isFinite) || w < 4 || h < 4) throw Object.assign(new Error('Bad box'), { status: 400 });
  const buf = await storage.get(p.id, 'orig', index);
  const out = await translateRegion(buf, { x, y, w, h }, {
    provider: req.get('x-provider'),
    apiKey: req.get('x-api-key'),
    model: req.get('x-model'),
    language: req.body?.language || 'auto',
    glossary: p.glossary || '',
  });
  res.json({ text: out.text, source: out.source, usage: out.usage, total: await recordUsage(p.id, out.usage) });
}));

// Keep an image as the untouched original: not translated, but still a page of the
// chapter (included in the export and the reader; never swapped).
app.put('/api/projects/:id/images/:i/keep', wrap(async (req, res) => {
  const p = await needProject(req);
  res.json(await updateImage(p.id, getIndex(req), { keep: !!req.body?.keep }));
}));

// Mark an image as irrelevant (ad, banner, logo…): it is left alone everywhere.
app.put('/api/projects/:id/images/:i/skip', wrap(async (req, res) => {
  const p = await needProject(req);
  res.json(await updateImage(p.id, getIndex(req), { skipped: !!req.body?.skipped }));
}));

app.put('/api/projects/:id/images/:i/blocks', wrap(async (req, res) => {
  const p = await needProject(req);
  const blocks = req.body?.blocks;
  if (!Array.isArray(blocks)) throw Object.assign(new Error('"blocks" must be an array'), { status: 400 });
  const img = await updateImage(p.id, getIndex(req), { blocks, status: 'edited', hasResult: false, keep: false });
  res.json(img);
}));

app.put('/api/projects/:id/images/:i/result',
  express.raw({ type: ['image/png', 'application/octet-stream'], limit: '32mb' }),
  wrap(async (req, res) => {
    const p = await needProject(req);
    const index = getIndex(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Empty body'), { status: 400 });
    await sharp(req.body).metadata(); // reject non-images
    await storage.put(p.id, 'result', index, req.body);
    res.json(await updateImage(p.id, index, { hasResult: true, status: 'done' }));
  }));

app.delete('/api/projects/:id/images/:i/result', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  await storage.del(p.id, 'result', index);
  res.json(await updateImage(p.id, index, { hasResult: false, status: 'edited' }));
}));

// ---------- files ----------
app.get('/files/:id/orig/:i', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  const buf = await storage.get(p.id, 'orig', index);
  res.type((await sharp(buf).metadata()).format || 'png').send(buf);
}));

app.get('/files/:id/result/:i.png', wrap(async (req, res) => {
  const p = await needProject(req);
  res.set('Cache-Control', 'no-cache');
  res.type('png').send(await storage.get(p.id, 'result', getIndex(req)));
}));

// ---------- replace images back ----------
function replacementMap(p, origin, ttlSec = 6 * 3600) {
  const map = {};
  for (const i of p.images) if (i.hasResult && !i.skipped && !i.keep) map[i.index] = origin + fileLink(`/files/${p.id}/result/${i.index}.png`, ttlSec);
  return map;
}

// Glossary / style notes for the whole project; sent with every translate request.
app.put('/api/projects/:id/glossary', wrap(async (req, res) => {
  await needProject(req);
  const text = req.body?.text;
  if (typeof text !== 'string') throw Object.assign(new Error('"text" must be a string'), { status: 400 });
  const saved = await withLock(req.params.id, async () => {
    const p = await loadProject(req.params.id);
    p.glossary = text.slice(0, 8000);
    await saveProject(p);
    return p.glossary;
  });
  res.json({ text: saved });
}));

// Download the translated pages as .zip / .cbz, numbered in page order. Skipped
// images are left out; images marked "keep original" are always included as the original; ?originals=1 also includes the untouched original for any
// page that has no translation yet, so the numbering still lines up with the chapter.
app.get('/api/projects/:id/export', wrap(async (req, res) => {
  const p = await needProject(req);
  const includeOrig = req.query.originals === '1';
  const ext = req.query.format === 'cbz' ? 'cbz' : 'zip';

  const picked = p.images.filter((i) => !i.skipped && (i.keep || i.hasResult || includeOrig));
  if (!picked.length) throw Object.assign(new Error('ยังไม่มีรูปที่แปลแล้วให้ส่งออก'), { status: 400 });

  const items = [];
  for (const [n, i] of picked.entries()) {
    const num = String(n + 1).padStart(3, '0');
    if (i.hasResult && !i.keep) {
      items.push({ name: `${num}.png`, load: () => storage.get(p.id, 'result', i.index) });
    } else {
      const buf = await storage.get(p.id, 'orig', i.index);
      const fmt = (await sharp(buf).metadata()).format;
      items.push({ name: `${num}.${fmt === 'jpeg' ? 'jpg' : fmt || 'png'}`, load: async () => buf });
    }
  }

  const base = (p.title || 'manga').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'manga';
  res.set({
    'Content-Type': ext === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip',
    'Content-Disposition': `attachment; filename="manga.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`,
  });
  await streamZip(res, items);
}));

// The original page with translated images swapped in.
app.get('/view/:id', wrap(async (req, res) => {
  const p = await needProject(req);
  let html;
  try {
    html = await fs.readFile(path.join(projectDir(p.id), 'page.html'), 'utf8');
  } catch {
    throw Object.assign(new Error('This project came from the extension: use its "swap images" button on the live page.'), { status: 404 });
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  // Someone else's HTML on our origin: no scripts, no cookies, no network except images/styles/fonts.
  res.set('Content-Security-Policy', "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:");
  res.type('html').send(rewriteHtml(html, p.sourceUrl, replacementMap(p, origin)));
}));

// Machine-readable swap list: original image URL -> translated image URL.
// Handy for a userscript / extension that swaps images on the live site.
app.get('/api/projects/:id/replacements', wrap(async (req, res) => {
  const p = await needProject(req);
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json(p.images.filter((i) => i.hasResult && !i.skipped && !i.keep).map((i) => ({
    index: i.index, original: i.url, translated: origin + fileLink(`/files/${p.id}/result/${i.index}.png`, 24 * 3600),
  })));
}));

app.listen(PORT, HOST, () => console.log(`Manga Translator (Node) → http://${HOST}:${PORT}  [images: ${storage.describe()}]`));
