require('dotenv').config();
const express = require('express');
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { extractImages, rewriteHtml } = require('./lib/extract');
const { translateImage, translateRegion, listModels } = require('./lib/llm');
const { streamZip } = require('./lib/zip');

const PORT = Number(process.env.PORT || 3000);
// Loopback by default: this server fetches arbitrary URLs for you, so don't
// expose it to a network unless you mean to (set HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MIN_SIDE = Number(process.env.MIN_IMAGE_SIDE || 150); // skip icons / avatars
const MAX_BYTES = 30 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; MangaTranslatorNode/1.0)';

const app = express();
app.use(express.json({ limit: '5mb' }));
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
    res.status(e.status || 500).json({ error: e.message });
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
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('File too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('File too large');
  return buf;
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
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw Object.assign(new Error(`Could not fetch page: HTTP ${r.status}`), { status: 502 });
    html = await r.text();
    baseUrl = r.url || url;
  }
  if (!given && !html) throw Object.assign(new Error('Provide "url", "html" or "images"'), { status: 400 });

  const found = given
    ? given.filter((g) => g && Number.isInteger(g.index) && typeof g.url === 'string')
        .map((g) => ({ index: g.index, url: g.url, alt: '' }))
    : extractImages(html, baseUrl || '');
  const id = crypto.randomBytes(6).toString('hex');
  await fs.mkdir(path.join(projectDir(id), 'orig'), { recursive: true });
  await fs.mkdir(path.join(projectDir(id), 'result'), { recursive: true });
  if (html) await fs.writeFile(path.join(projectDir(id), 'page.html'), html);

  const images = [];
  const failed = []; // couldn't be downloaded server-side (the extension can retry)
  await pool(found, 4, async (f) => {
    try {
      const buf = await fetchBuffer(f.url, baseUrl);
      const meta = await sharp(buf).metadata();
      if (!meta.width || meta.width < MIN_SIDE || meta.height < MIN_SIDE) return;
      await fs.writeFile(path.join(projectDir(id), 'orig', String(f.index)), buf);
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
app.put('/api/projects/:id/images/:i/source', express.raw({ type: '*/*', limit: '60mb' }), wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Empty body'), { status: 400 });
  const meta = await sharp(req.body).metadata();
  if (!meta.width || meta.width < MIN_SIDE || meta.height < MIN_SIDE) return res.json({ skipped: true });
  await fs.writeFile(path.join(projectDir(p.id), 'orig', String(index)), req.body);
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
      images: p.images.filter((i) => !i.skipped).length, done: p.images.filter((i) => i.hasResult && !i.skipped).length });
  }
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
}));

app.get('/api/projects/:id', wrap(async (req, res) => res.json(await needProject(req))));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  await needProject(req);
  await fs.rm(projectDir(req.params.id), { recursive: true, force: true });
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

app.post('/api/projects/:id/images/:i/translate', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!p.images.some((i) => i.index === index)) throw Object.assign(new Error('Image not found'), { status: 404 });
  const buf = await fs.readFile(path.join(projectDir(p.id), 'orig', String(index)));
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
  });
  let nextId = Math.max(0, ...kept.map((b) => b.id || 0)) + 1;
  const blocks = [...kept, ...out.blocks.map((b) => ({ id: nextId++, ...b }))];
  const img = await updateImage(p.id, index, { blocks, status: 'translated', hasResult: false });
  await fs.rm(path.join(projectDir(p.id), 'result', `${index}.png`), { force: true });
  res.json({ image: img, usage: out.usage, total: await recordUsage(p.id, out.usage) });
}));

// Re-translate a single box (crop + one small request) instead of the whole image.
// The client sends the box's current rectangle and applies the text itself, so edits
// you've made to the other boxes are never touched.
app.post('/api/projects/:id/images/:i/retranslate-block', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  if (!p.images.some((i) => i.index === index)) throw Object.assign(new Error('Image not found'), { status: 404 });
  const { x, y, w, h } = req.body || {};
  if (![x, y, w, h].every(Number.isFinite) || w < 4 || h < 4) throw Object.assign(new Error('Bad box'), { status: 400 });
  const buf = await fs.readFile(path.join(projectDir(p.id), 'orig', String(index)));
  const out = await translateRegion(buf, { x, y, w, h }, {
    provider: req.get('x-provider'),
    apiKey: req.get('x-api-key'),
    model: req.get('x-model'),
    language: req.body?.language || 'auto',
    glossary: p.glossary || '',
  });
  res.json({ text: out.text, source: out.source, usage: out.usage, total: await recordUsage(p.id, out.usage) });
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
  const img = await updateImage(p.id, getIndex(req), { blocks, status: 'edited', hasResult: false });
  res.json(img);
}));

app.put('/api/projects/:id/images/:i/result',
  express.raw({ type: ['image/png', 'application/octet-stream'], limit: '60mb' }),
  wrap(async (req, res) => {
    const p = await needProject(req);
    const index = getIndex(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Empty body'), { status: 400 });
    await sharp(req.body).metadata(); // reject non-images
    await fs.writeFile(path.join(projectDir(p.id), 'result', `${index}.png`), req.body);
    res.json(await updateImage(p.id, index, { hasResult: true, status: 'done' }));
  }));

app.delete('/api/projects/:id/images/:i/result', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  await fs.rm(path.join(projectDir(p.id), 'result', `${index}.png`), { force: true });
  res.json(await updateImage(p.id, index, { hasResult: false, status: 'edited' }));
}));

// ---------- files ----------
app.get('/files/:id/orig/:i', wrap(async (req, res) => {
  const p = await needProject(req);
  const index = getIndex(req);
  const buf = await fs.readFile(path.join(projectDir(p.id), 'orig', String(index)));
  res.type((await sharp(buf).metadata()).format || 'png').send(buf);
}));

app.get('/files/:id/result/:i.png', wrap(async (req, res) => {
  const p = await needProject(req);
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(projectDir(p.id), 'result', `${getIndex(req)}.png`));
}));

// ---------- replace images back ----------
function replacementMap(p, origin) {
  const map = {};
  for (const i of p.images) if (i.hasResult && !i.skipped) map[i.index] = `${origin}/files/${p.id}/result/${i.index}.png`;
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
// images are left out; ?originals=1 also includes the untouched original for any
// page that has no translation yet, so the numbering still lines up with the chapter.
app.get('/api/projects/:id/export', wrap(async (req, res) => {
  const p = await needProject(req);
  const includeOrig = req.query.originals === '1';
  const ext = req.query.format === 'cbz' ? 'cbz' : 'zip';

  const picked = p.images.filter((i) => !i.skipped && (i.hasResult || includeOrig));
  if (!picked.length) throw Object.assign(new Error('ยังไม่มีรูปที่แปลแล้วให้ส่งออก'), { status: 400 });

  const items = [];
  for (const [n, i] of picked.entries()) {
    const num = String(n + 1).padStart(3, '0');
    if (i.hasResult) {
      items.push({ name: `${num}.png`, load: () => fs.readFile(path.join(projectDir(p.id), 'result', `${i.index}.png`)) });
    } else {
      const buf = await fs.readFile(path.join(projectDir(p.id), 'orig', String(i.index)));
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
  res.type('html').send(rewriteHtml(html, p.sourceUrl, replacementMap(p, origin)));
}));

// Machine-readable swap list: original image URL -> translated image URL.
// Handy for a userscript / extension that swaps images on the live site.
app.get('/api/projects/:id/replacements', wrap(async (req, res) => {
  const p = await needProject(req);
  const origin = `${req.protocol}://${req.get('host')}`;
  res.set('Access-Control-Allow-Origin', '*');
  res.json(p.images.filter((i) => i.hasResult && !i.skipped).map((i) => ({
    index: i.index, original: i.url, translated: `${origin}/files/${p.id}/result/${i.index}.png`,
  })));
}));

app.listen(PORT, HOST, () => console.log(`Manga Translator (Node) → http://${HOST}:${PORT}`));
