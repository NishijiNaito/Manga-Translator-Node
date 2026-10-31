'use strict';

const $app = document.getElementById('app');
const $crumb = document.getElementById('crumb');
const FONT = '"Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif';

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, err = false, ms = 3000) {
  const t = document.getElementById('toast');
  const sl = document.getElementById('statusline'); // persistent copy in the editor
  if (sl) { sl.textContent = msg; sl.style.color = err ? 'var(--bad)' : ''; }
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => (t.style.display = 'none'), ms);
}

const settings = {
  get() {
    try { return JSON.parse(localStorage.getItem('mt-settings')) || {}; } catch { return {}; }
  },
  set(v) {
    try { localStorage.setItem('mt-settings', JSON.stringify(v)); } catch { /* storage blocked */ }
  },
};

async function api(url, opts = {}) {
  const s = settings.get();
  const headers = { ...(opts.headers || {}) };
  headers['x-provider'] = s.provider || 'gemini';
  if (s.key) headers['x-api-key'] = s.key;
  if (s.model) headers['x-model'] = s.model;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- settings dialog ----------
const dlg = document.getElementById('dlgSettings');
document.getElementById('btnSettings').onclick = () => {
  const s = settings.get();
  setProvider.value = s.provider || 'gemini';
  setKey.value = s.key || '';
  setModel.value = s.model || '';
  setLang.value = s.lang || 'auto';
  setSlice.checked = !!s.slice;
  setAuto.checked = s.autoApply !== false;
  setSource.checked = s.withSource !== false;
  setSkipTitles.checked = !!s.skipTitles;
  setParallel.value = s.parallel || 3;
  dlg.showModal();
};
setCancel.onclick = () => dlg.close();

// Fill the Model box's suggestions from the provider's own model list. Uses the
// values currently typed in the dialog (not yet saved).
async function loadModels() {
  setLoadModels.disabled = true;
  modelHint.textContent = 'กำลังโหลด…';
  try {
    const res = await fetch('/api/models', {
      headers: { 'x-provider': setProvider.value, 'x-api-key': setKey.value.trim() },
    });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error || `HTTP ${res.status}`);
    modelList.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    modelHint.textContent = `พบ ${list.length} model — คลิกช่องแล้วเลือก หรือพิมพ์ค้นหา`;
  } catch (e) {
    modelHint.textContent = `❌ ${e.message}`;
  } finally {
    setLoadModels.disabled = false;
  }
}
setLoadModels.onclick = loadModels;
setProvider.onchange = () => { modelList.innerHTML = ''; modelHint.textContent = ''; };
setSave.onclick = () => {
  settings.set({ withSource: setSource.checked, skipTitles: setSkipTitles.checked, autoApply: setAuto.checked, parallel: Math.min(8, Math.max(1, Number(setParallel.value) || 3)), slice: setSlice.checked, provider: setProvider.value, key: setKey.value.trim(), model: setModel.value.trim(), lang: setLang.value });
  dlg.close();
  toast('บันทึกการตั้งค่าแล้ว');
};

// Home link + logout (the logout button only exists when the server asks for a login).
document.getElementById('home').onclick = () => { location.hash = '#/'; };
fetch('/api/session').then((r) => r.json()).then((s) => {
  if (!s.hosted) return;
  const b = document.getElementById('btnLogout');
  b.hidden = false;
  b.onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };
}).catch(() => {});

// ---------- routing ----------
function route() {
  const r = location.hash.match(/^#\/p\/([a-f0-9]{12})\/read$/);
  if (r) return openReader(r[1]);
  const m = location.hash.match(/^#\/p\/([a-f0-9]{12})(?:\/(\d+))?$/);
  if (m) return openEditor(m[1], m[2] === undefined ? undefined : Number(m[2]));
  return renderHome();
}
window.addEventListener('hashchange', route);
route();

// ============================================================
// Home: create a project + list projects
// ============================================================
async function renderHome() {
  $crumb.textContent = '';
  $app.innerHTML = `
  <div class="wrap">
    <div class="card">
      <h2>1. ดึงรูปจากหน้าเว็บ</h2>
      <div class="row">
        <input type="url" id="url" placeholder="https://example.com/manga/chapter-1">
        <button class="primary" id="go">ค้นหารูป</button>
      </div>
      <p class="muted" style="margin:10px 0 6px">หรือวาง HTML ของหน้าเว็บ (กรณีหน้าที่ต้องล็อกอิน)</p>
      <textarea id="html" rows="4" placeholder="&lt;html&gt;…"></textarea>
      <div class="row" style="margin-top:6px"><input type="url" id="base" placeholder="Base URL (ใช้แปลงลิงก์รูปแบบ relative)"><button id="goHtml">ใช้ HTML นี้</button></div>
    </div>
    <div class="card"><h2>โปรเจ็คของคุณ</h2><div id="list" class="muted">กำลังโหลด…</div></div>
  </div>`;

  const create = async (body, btn) => {
    btn.disabled = true;
    toast('กำลังดึงหน้าเว็บและรูปภาพ…', false, 0);
    try {
      const p = await api('/api/projects', { method: 'POST', json: body });
      toast(`พบรูป ${p.images.length} รูป`);
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      toast(e.message, true, 6000);
    } finally {
      btn.disabled = false;
    }
  };
  go.onclick = () => url.value.trim() && create({ url: url.value.trim() }, go);
  goHtml.onclick = () => html.value.trim() && create({ html: html.value, baseUrl: base.value.trim() }, goHtml);

  try {
    const list = await api('/api/projects');
    document.getElementById('list').innerHTML = list.length
      ? `<table>${list.map((p) => `<tr>
          <td><a href="#/p/${p.id}">${esc(p.title)}</a><div class="muted" style="font-size:12px">${esc(p.sourceUrl)}</div></td>
          <td>${p.done}/${p.images} รูป</td>
          <td style="text-align:right">${p.done ? `<a href="#/p/${p.id}/read">อ่าน</a> <a href="/view/${p.id}" target="_blank">ดูหน้าที่แปลแล้ว</a> ` : ''}
          <button class="danger" data-del="${p.id}">ลบ</button></td></tr>`).join('')}</table>`
      : 'ยังไม่มีโปรเจ็ค';
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('ลบโปรเจ็คนี้?')) return;
      await api(`/api/projects/${b.dataset.del}`, { method: 'DELETE' });
      renderHome();
    }));
  } catch (e) {
    document.getElementById('list').textContent = e.message;
  }
}

// ============================================================
// Reader: all images as one continuous vertical strip
// ============================================================
async function openReader(id) {
  $app.innerHTML = '<div class="wrap muted">กำลังโหลด…</div>';
  try {
    P = await api(`/api/projects/${id}`);
  } catch (e) {
    $app.innerHTML = `<div class="wrap">${esc(e.message)}</div>`;
    return;
  }
  $crumb.textContent = P.title;
  const prefs = { width: 720, orig: false, ...(settings.get().reader || {}) };
  const save = () => settings.set({ ...settings.get(), reader: prefs });
  const list = P.images.filter((i) => !i.skipped);
  const useResult = (i) => i.hasResult && !i.keep;
  const left = list.filter((i) => !i.hasResult && !i.keep).length;
  $app.innerHTML = `
  <div class="readbar">
    <a href="#/p/${P.id}">← กลับไปแก้ไข</a>
    <label>ความกว้าง <input type="range" id="rdW" min="320" max="1600" step="20"></label>
    <label><input type="checkbox" id="rdOrig" style="width:auto"> ดูต้นฉบับ</label>
    <span class="muted">${list.filter(useResult).length}/${list.length} รูปแปลแล้ว${list.some((i) => i.keep) ? ` · คงต้นฉบับ ${list.filter((i) => i.keep).length}` : ''}${left ? ' · รูปที่ยังไม่แปลแสดงเป็นต้นฉบับ (มีขอบแดง)' : ''}</span>
    <span id="rdPos" class="muted" style="margin-left:auto"></span>
  </div>
  <div id="strip" class="strip"></div>`;
  const strip = $('strip');
  const url = (i) => (useResult(i) && !prefs.orig ? `/files/${P.id}/result/${i.index}.png?v=${i.v || 0}` : `/files/${P.id}/orig/${i.index}`);
  strip.innerHTML = list.length ? list.map((i) => `<div class="pg ${useResult(i) || i.keep ? '' : 'raw'}" data-i="${i.index}">
      <img loading="lazy" src="${url(i)}" alt="">
      <a class="pgedit" href="#/p/${P.id}/${i.index}" title="แก้ไขรูปนี้">✎ #${i.index}</a></div>`).join('')
    : '<p class="muted" style="padding:20px">ไม่มีรูปให้อ่าน</p>';
  const setW = () => { strip.style.width = `min(100%, ${prefs.width}px)`; };
  rdW.value = prefs.width; rdOrig.checked = prefs.orig; setW();
  rdW.oninput = () => { prefs.width = Number(rdW.value); setW(); save(); };
  rdOrig.onchange = () => {
    prefs.orig = rdOrig.checked; save();
    strip.querySelectorAll('.pg').forEach((pg) => { pg.querySelector('img').src = url(list.find((i) => i.index === Number(pg.dataset.i))); });
  };
  const upd = () => {
    const pgs = [...strip.querySelectorAll('.pg')];
    const n = pgs.filter((pg) => pg.getBoundingClientRect().top < innerHeight / 2).length;
    $('rdPos') && ($('rdPos').textContent = pgs.length ? `${Math.max(1, n)}/${pgs.length}` : '');
  };
  window.addEventListener('scroll', upd, { passive: true });
  const stop = () => { window.removeEventListener('scroll', upd); window.removeEventListener('hashchange', stop); };
  window.addEventListener('hashchange', stop);
  upd();
}

// ============================================================
// Editor
// ============================================================
let P = null;            // project
let cur = null;          // current image record
let blocks = [];         // working copy of cur's blocks
let selId = null;
let srcImg = null;       // HTMLImageElement of the original
let srcCanvas = null;    // original drawn to a canvas (for colour sampling)
let showOrig = false;
let scale = 1;
let saveTimer = null;
let autoTimer = null;          // debounce for auto-apply
let busy = 0;                  // >0 while a translate job runs (auto-apply waits)
const dirtyIdx = new Set();    // images edited here but not rendered yet
let undoStack = [];            // JSON snapshots of `blocks`, newest last
let redoStack = [];
let lastUndoTag = '';
let lastUndoAt = 0;

async function openEditor(id, startIndex) {
  $app.innerHTML = '<div class="wrap muted">กำลังโหลด…</div>';
  try {
    P = await api(`/api/projects/${id}`);
  } catch (e) {
    $app.innerHTML = `<div class="wrap">${esc(e.message)}</div>`;
    return;
  }
  $crumb.textContent = P.title;
  $app.innerHTML = `
  <div class="editor">
    <div class="col" id="thumbs"></div>
    <div class="stage" id="stage"><div class="toolbar" id="toolbar"></div>
      <div class="statusbar"><span id="statusline">พร้อม</span><span id="usageline"></span></div><div id="cv"></div></div>
    <div class="col right" id="side"></div>
  </div>`;
  drawThumbs();
  renderUsage();
  const first = P.images.find((i) => i.index === startIndex) || P.images[0];
  if (first) selectImage(first.index);
  else $('stage').innerHTML = '<p class="muted">ไม่พบรูปที่ใหญ่พอในหน้านี้</p>';
  renderToolbar();
}

const $ = (id) => document.getElementById(id);

function drawThumbs() {
  $('thumbs').innerHTML = P.images.map((i) => `
    <a class="thumb ${cur && cur.index === i.index ? 'sel' : ''} ${i.skipped ? 'skipped' : ''} ${i.keep ? 'keep' : ''}" data-i="${i.index}">
      <img loading="lazy" src="${i.hasResult && !i.keep ? `/files/${P.id}/result/${i.index}.png?v=${i.v || 0}` : `/files/${P.id}/orig/${i.index}`}">
      <span class="badge ${i.status}">${i.skipped ? 'ข้าม' : i.keep ? 'คงต้นฉบับ' : { new: 'ใหม่', translated: 'แปลแล้ว', edited: 'แก้ไข', done: '✓ เสร็จ' }[i.status]}</span>
      <button class="x k" data-keep="${i.index}" title="${i.keep ? 'ยกเลิกการคงต้นฉบับ' : 'คงต้นฉบับ (ไม่ต้องแก้ แต่ยังรวมในการส่งออก/โหมดอ่าน)'}">${i.keep ? '↩' : '📌'}</button>
      <button class="x" data-skip="${i.index}" title="${i.skipped ? 'ยกเลิกการข้าม' : 'ข้ามรูปนี้ (ไม่เกี่ยวข้อง)'}">${i.skipped ? '↩' : '✕'}</button>
    </a>`).join('');
  $('thumbs').querySelectorAll('.thumb').forEach((t) => (t.onclick = () => selectImage(Number(t.dataset.i))));
  $('thumbs').querySelectorAll('[data-keep]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    toggleKeep(Number(b.dataset.keep));
  }));
  $('thumbs').querySelectorAll('[data-skip]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    toggleSkip(Number(b.dataset.skip));
  }));
}

async function toggleKeep(index) {
  const rec = P.images.find((i) => i.index === index);
  const keep = !rec.keep;
  try {
    // A pending edit on this image would otherwise re-render it later and undo the choice.
    if (keep && cur && cur.index === index) { clearTimeout(autoTimer); dirtyIdx.delete(index); }
    await api(`/api/projects/${P.id}/images/${index}/keep`, { method: 'PUT', json: { keep } });
    rec.keep = keep;
    drawThumbs();
    renderKeepButton();
    toast(keep ? `คงรูป #${index} เป็นต้นฉบับ — ไม่ถูกแปลหรือสลับ แต่ยังอยู่ในการส่งออก` : `ยกเลิกการคงต้นฉบับรูป #${index}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderKeepButton() {
  const b = document.getElementById('bKeep');
  if (b && cur) b.textContent = cur.keep ? '↩ ยกเลิกคงต้นฉบับ' : '📌 คงต้นฉบับ';
}

async function toggleSkip(index) {
  const rec = P.images.find((i) => i.index === index);
  const skipped = !rec.skipped;
  try {
    await api(`/api/projects/${P.id}/images/${index}/skip`, { method: 'PUT', json: { skipped } });
    rec.skipped = skipped;
    drawThumbs();
    toast(skipped ? `ข้ามรูป #${index} แล้ว — จะไม่ถูกแปลหรือสลับ` : `ยกเลิกการข้ามรูป #${index}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderToolbar() {
  $('toolbar').innerHTML = `
    <button id="bTr" class="primary">🌐 แปลรูปนี้</button>
    <button id="bSweep" title="ส่งรูปให้ AI หาข้อความที่ยังไม่ได้แปลเพิ่ม โดยไม่แตะกล่องที่มีอยู่">🔍 หาข้อความที่ตกหล่น</button>
    <button id="bAll">แปลทั้งหมด</button>
    <button id="bApply">✅ ใช้รูปนี้</button>
    <button id="bApplyAll">✅ ใช้ทั้งหมด</button>
    <button id="bKeep" title="ไม่ต้องแก้รูปนี้: คงต้นฉบับไว้ แต่ยังรวมในการส่งออกและโหมดอ่าน"></button>
    <button id="bOrig">👁 ดูต้นฉบับ</button>
    <button id="bAdd">＋ เพิ่มกล่องข้อความ</button>
    <button id="bUndo" title="ย้อนกลับ (Ctrl+Z)">↶</button>
    <button id="bRedo" title="ทำซ้ำ (Ctrl+Y)">↷</button>
    <button id="bKeys" title="คีย์ลัด">⌨</button>
    <button id="bGloss" title="ชื่อตัวละคร/ศัพท์เฉพาะ ที่ต้องแปลให้ตรงกันทุกรูป">📖 Glossary</button>
    <button id="bExport" title="ดาวน์โหลดรูปที่แปลแล้วเป็น ZIP / CBZ">⬇ ส่งออก</button>
    <span class="sp" style="flex:1"></span>
    <a href="#/p/${P.id}/read">📖 โหมดอ่าน</a>
    <a href="/view/${P.id}" target="_blank">เปิดหน้าที่แปลแล้ว ↗</a>`;
  bTr.onclick = () => translateCurrent(false);
  bSweep.onclick = () => translateCurrent(true);
  bAll.onclick = translateAll;
  bApply.onclick = () => applyImage(cur.index, true);
  bApplyAll.onclick = applyAll;
  bKeep.onclick = () => cur && toggleKeep(cur.index);
  bOrig.onmousedown = () => { showOrig = true; redraw(); };
  window.addEventListener('mouseup', () => { if (showOrig) { showOrig = false; redraw(); } });
  bAdd.onclick = addBlock;
  bUndo.onclick = undo;
  bRedo.onclick = redo;
  bKeys.onclick = () => $('dlgKeys').showModal();
  bGloss.onclick = openGlossary;
  bExport.onclick = openExport;
  updateUndoButtons();
  updateGlossButton();
  renderKeepButton();
}

const ensureFont = () =>
  document.fonts.load(`700 20px "Noto Sans Thai"`, 'กข').catch(() => {});

async function selectImage(index) {
  const prev = cur, prevImg = srcImg;
  flushSave();
  clearTimeout(autoTimer);
  // Leaving an image you edited: render it now so the result is never stale.
  // (Snapshot taken synchronously; `cur`/`blocks` are about to change.)
  if (prev && prev.index !== index && prevImg && dirtyIdx.has(prev.index) && !busy && autoApplyOn()) {
    applyImage(prev.index, false, { img: prevImg, list: structuredClone(blocks) }).catch((e) => toast(`ใช้รูป #${prev.index} อัตโนมัติไม่สำเร็จ: ${e.message}`, true));
  }
  await ensureFont();
  cur = P.images.find((i) => i.index === index);
  blocks = structuredClone(cur.blocks || []);
  selId = blocks[0]?.id ?? null;
  undoStack = []; redoStack = []; lastUndoTag = '';
  updateUndoButtons();
  drawThumbs();
  document.querySelector('.thumb.sel')?.scrollIntoView({ block: 'nearest' });
  $('cv').innerHTML = '<p class="muted">กำลังโหลดรูป…</p>';
  srcImg = await loadImage(`/files/${P.id}/orig/${index}`);
  srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcImg.naturalWidth;
  srcCanvas.height = srcImg.naturalHeight;
  srcCanvas.getContext('2d', { willReadFrequently: true }).drawImage(srcImg, 0, 0);
  buildCanvas();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('โหลดรูปไม่ได้'));
    im.src = src;
  });
}

function buildCanvas() {
  const W = srcImg.naturalWidth;
  const avail = $('stage').clientWidth - 30;
  scale = Math.min(1, avail / W);
  $('cv').innerHTML = `<div class="canvaswrap" id="cw"><canvas id="c" width="${W}" height="${srcImg.naturalHeight}"
    style="width:${W * scale}px;height:${srcImg.naturalHeight * scale}px"></canvas><div id="boxes"></div></div>`;
  redraw();
  drawBoxes();
  drawSide();
}

// ---------- rendering ----------
function medianColor(src, x, y, w, h) {
  // Sample a 3px ring just outside the box: that's the bubble/background colour.
  // `src` is a pristine canvas of THIS image (never the one being painted on).
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const W = src.width, H = src.height;
  const x0 = Math.max(0, x - 3), y0 = Math.max(0, y - 3);
  const x1 = Math.min(W, x + w + 3), y1 = Math.min(H, y + h + 3);
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const rs = [], gs = [], bs = [];
  for (let py = 0; py < d.height; py++) {
    for (let px = 0; px < d.width; px++) {
      const gx = x0 + px, gy = y0 + py;
      if (gx >= x && gx < x + w && gy >= y && gy < y + h) continue;
      const o = (py * d.width + px) * 4;
      rs.push(d.data[o]); gs.push(d.data[o + 1]); bs.push(d.data[o + 2]);
    }
  }
  if (!rs.length) return '#ffffff';
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `#${hex(med(rs))}${hex(med(gs))}${hex(med(bs))}`;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
function tokens(line) {
  return segmenter ? [...segmenter.segment(line)].map((s) => s.segment) : line.split(/(\s+)/);
}

function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const tok of tokens(para)) {
      const test = line + tok;
      if (line && ctx.measureText(test.trimEnd()).width > maxW) {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      } else {
        line = test;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function layoutText(ctx, b) {
  const pad = 3;
  const maxW = Math.max(4, b.w - pad * 2);
  const maxH = Math.max(4, b.h - pad * 2);
  const fit = (size) => {
    ctx.font = `700 ${size}px ${FONT}`;
    const lines = wrapText(ctx, b.text || '', maxW);
    const lh = size * 1.3;
    const ok = lines.length * lh <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW);
    return { size, lines, lh, ok };
  };
  if (b.fontSize > 0) return fit(b.fontSize);
  let lo = 8, hi = Math.min(72, maxH), best = fit(lo);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = fit(mid);
    if (r.ok) { best = r; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function paintBlocks(ctx, list, src) {
  for (const b of list) {
    if (b.noFill) {
      // Nothing is erased (sound effects over artwork): the Thai goes on top, outlined so it stays readable.
      const L = layoutText(ctx, b);
      ctx.font = `700 ${L.size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, L.size / 6);
      const fill = b.color || '#ffffff';
      ctx.strokeStyle = luminance(fill) > 128 ? '#000000' : '#ffffff';
      ctx.fillStyle = fill;
      const top = b.y + b.h / 2 - (L.lines.length * L.lh) / 2 + L.lh / 2;
      L.lines.forEach((line, n) => {
        ctx.strokeText(line, b.x + b.w / 2, top + n * L.lh);
        ctx.fillText(line, b.x + b.w / 2, top + n * L.lh);
      });
      continue;
    }
    // Extra areas of an L-shaped / split bubble: erased only, the text goes in the main box.
    for (const e of b.erase || []) {
      if (!e.bg) e.bg = medianColor(src, e.x, e.y, e.w, e.h);
      ctx.fillStyle = e.bg;
      ctx.fillRect(e.x, e.y, e.w, e.h);
    }
    if (!b.bg) b.bg = medianColor(src, b.x, b.y, b.w, b.h);
    ctx.fillStyle = b.bg;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const L = layoutText(ctx, b);
    ctx.font = `700 ${L.size}px ${FONT}`;
    ctx.fillStyle = b.color || (luminance(b.bg) > 128 ? '#111111' : '#ffffff');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const top = b.y + b.h / 2 - (L.lines.length * L.lh) / 2 + L.lh / 2;
    L.lines.forEach((line, n) => ctx.fillText(line, b.x + b.w / 2, top + n * L.lh));
  }
}

function composite(img, list) {
  const make = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    return c;
  };
  const pristine = make(); // colour samples come from here, not from half-painted output
  const c = make();
  paintBlocks(c.getContext('2d'), list, pristine);
  return c;
}

let raf = 0;
function redraw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const c = $('c');
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcImg, 0, 0);
    if (!showOrig) paintBlocks(ctx, blocks, srcCanvas);
  });
}

// ---------- boxes overlay (drag / resize) ----------
function drawBoxes() {
  $('boxes').innerHTML = blocks.map((b) => `
    <div class="box ${b.id === selId ? 'sel' : ''}" data-id="${b.id}"
      style="left:${b.x * scale}px;top:${b.y * scale}px;width:${b.w * scale}px;height:${b.h * scale}px">
      <div class="h"></div></div>`).join('');
  // One drag/resize handler for the main boxes and the erase areas.
  const attachDrag = $('boxes').__attachDrag = (el, rect, blockId) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.closest('[data-edel]')) return;
      // Select without scrolling the canvas (you're already looking at this box);
      // the side list scrolls to its text instead.
      selectBlock(blockId, { scrollBox: false });
      const resize = e.target.classList.contains('h');
      const sx = e.clientX, sy = e.clientY, ox = rect.x, oy = rect.y, ow = rect.w, oh = rect.h;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved) { pushUndo(); moved = true; } // a plain click isn't an undo step
        const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
        if (resize) { rect.w = Math.max(10, Math.round(ow + dx)); rect.h = Math.max(10, Math.round(oh + dy)); }
        else { rect.x = Math.round(ox + dx); rect.y = Math.round(oy + dy); }
        rect.bg = null; // resample the background for the new position/size
        el.style.left = rect.x * scale + 'px'; el.style.top = rect.y * scale + 'px';
        el.style.width = rect.w * scale + 'px'; el.style.height = rect.h * scale + 'px';
        redraw();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (moved) {
          changed();
          drawBoxes();
          drawSide();
          selectBlock(blockId, { scrollBox: false, scrollSide: false });
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  };
  $('boxes').querySelectorAll('.box').forEach((el) => {
    const b = blocks.find((x) => x.id === Number(el.dataset.id));
    attachDrag(el, b, b.id);
  });
  drawEraseBoxes();
}

// Dashed red rectangles: the extra areas that get erased for the selected block.
function drawEraseBoxes() {
  const host = $('boxes');
  if (!host) return;
  host.querySelectorAll('.ebox').forEach((el) => el.remove());
  const b = blocks.find((x) => x.id === selId);
  if (!b || !b.erase?.length) return;
  b.erase.forEach((r, n) => {
    const el = document.createElement('div');
    el.className = 'ebox';
    el.title = 'พื้นที่ลบเพิ่ม (ไม่ใส่ข้อความ)';
    el.style.cssText = `left:${r.x * scale}px;top:${r.y * scale}px;width:${r.w * scale}px;height:${r.h * scale}px`;
    el.innerHTML = '<div class="h"></div><button data-edel title="ลบพื้นที่นี้">✕</button>';
    host.appendChild(el);
    el.querySelector('[data-edel]').onclick = (e) => {
      e.stopPropagation();
      pushUndo();
      b.erase.splice(n, 1);
      if (!b.erase.length) delete b.erase;
      redraw(); changed(); drawEraseBoxes(); drawSide();
    };
    host.__attachDrag(el, r, b.id);
  });
}

function addEraseArea(id) {
  const b = blocks.find((x) => x.id === id);
  if (!b) return;
  pushUndo();
  const W = srcImg.naturalWidth, H = srcImg.naturalHeight;
  const w = Math.max(20, Math.round(b.w * 0.6)), h = Math.max(20, Math.round(b.h * 0.5));
  // Start just below the main box (or above it when there is no room): drag it into place.
  const y = b.y + b.h + h <= H ? b.y + b.h : Math.max(0, b.y - h);
  (b.erase ||= []).push({ x: Math.max(0, Math.min(W - w, b.x)), y, w, h });
  selId = id;
  redraw(); changed(); drawEraseBoxes(); drawSide();
  selectBlock(id, { scrollBox: false });
}

// ---------- side panel ----------
// Letters of another script and no Thai at all (numbers / "!?" alone are fine).
const notThai = (t) => /[A-Za-z぀-ヿ㐀-鿿가-힯]/.test(t || '') && !/[฀-๿]/.test(t || '');

function drawSide() {
  $('side').innerHTML = blocks.length ? blocks.map((b) => `
    <div class="blk ${b.id === selId ? 'sel' : ''}" data-id="${b.id}">
      <textarea rows="3" data-f="text">${esc(b.text)}</textarea>
      ${notThai(b.text) ? '<div class="nothai">⚠ ยังไม่ใช่ภาษาไทย — กด “↻ แปลใหม่” เพื่อแปลเฉพาะกล่องนี้</div>' : ''}
      ${b.source ? `<div class="src" title="ข้อความต้นฉบับที่ AI อ่านได้">ต้นฉบับ: ${esc(b.source)}</div>` : ''}
      <div class="f">
        ขนาด <input type="number" min="0" max="200" data-f="fontSize" value="${b.fontSize || 0}" title="0 = อัตโนมัติ">
        ตัวอักษร <input type="color" data-f="color" value="${b.color || (b.noFill ? '#ffffff' : '#111111')}">
        พื้น <input type="color" data-f="bg" value="${b.bg || '#ffffff'}" ${b.noFill ? 'disabled' : ''}>
        <label title="ไม่ทาสีทับของเดิม วางข้อความไทยทับพร้อมขอบ เหมาะกับคำเลียนเสียงบนภาพวาด"><input type="checkbox" data-f="noFill" ${b.noFill ? 'checked' : ''}> ไม่ลบพื้น</label>
        <button data-reset title="ใช้สีอัตโนมัติ">↺</button>
        <button data-erase title="เพิ่มพื้นที่ลบอีกก้อน สำหรับกรอบที่ไม่เป็นสี่เหลี่ยม (รูปตัว L) หรือข้อความที่แยกเป็นหลายส่วน">＋ พื้นที่ลบ${b.erase?.length ? ` (${b.erase.length})` : ''}</button>
        <button data-retr title="แปลใหม่เฉพาะกล่องนี้ (เรียก AI หนึ่งครั้ง ราคาถูกกว่าแปลทั้งรูป)">↻ แปลใหม่</button>
        <span style="flex:1"></span><button class="danger" data-del>ลบ</button>
      </div>
    </div>`).join('') : '<p class="muted">ยังไม่มีข้อความ กด “แปลรูปนี้” หรือ “เพิ่มกล่องข้อความ”</p>';

  $('side').querySelectorAll('.blk').forEach((el) => {
    const b = blocks.find((x) => x.id === Number(el.dataset.id));
    // Focusing a block's text jumps the canvas to that box (handy on tall images).
    el.addEventListener('focusin', () => {
      if (selId !== b.id) selectBlock(b.id, { scrollSide: false });
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('textarea, input, button')) return;
      selectBlock(b.id, { scrollSide: false });
    });
    el.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        pushUndo(`${b.id}:${f}`); // typing in one field = one undo step
        b[f] = f === 'fontSize' ? Number(inp.value) || 0 : f === 'noFill' ? inp.checked : inp.value;
        redraw();
        changed();
        if (f === 'noFill') drawSide(); // refresh the colour pickers' defaults
      });
    });
    el.querySelector('[data-erase]').onclick = () => addEraseArea(b.id);
    el.querySelector('[data-reset]').onclick = () => { pushUndo(); b.bg = null; b.color = ''; (b.erase || []).forEach((r) => (r.bg = null)); redraw(); changed(); drawSide(); };
    el.querySelector('[data-retr]').onclick = (e) => retranslateBlock(b.id, e.currentTarget);
    el.querySelector('[data-del]').onclick = () => { deleteBlock(b.id); };
  });
}

function addBlock() {
  pushUndo();
  const w = Math.round(srcImg.naturalWidth * 0.3), h = Math.round(w * 0.5);
  const stage = $('stage');
  const cy = Math.round((stage.scrollTop + stage.clientHeight / 2) / scale);
  const b = {
    id: Math.max(0, ...blocks.map((x) => x.id)) + 1,
    x: Math.round((srcImg.naturalWidth - w) / 2),
    y: Math.max(0, Math.min(srcImg.naturalHeight - h, cy - h / 2)),
    w, h, text: 'ข้อความ',
  };
  blocks.push(b);
  selId = b.id;
  redraw(); changed(); drawBoxes(); drawSide();
  selectBlock(b.id, { scrollBox: false, focus: true });
}

// ---------- persistence ----------
function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
  if (cur) dirtyIdx.add(cur.index);
  scheduleAutoApply();
}

// ---------- auto-apply ----------
// Keep the rendered result in step with your edits, so /view and the extension
// never show a stale image. Waits for 3s of quiet; ⚙️ can turn it off.
const autoApplyOn = () => settings.get().autoApply !== false;

function scheduleAutoApply() {
  clearTimeout(autoTimer);
  if (!autoApplyOn() || !blocks.length) return;
  autoTimer = setTimeout(async () => {
    if (!cur || busy) return scheduleAutoApply();
    const idx = cur.index;
    try {
      await applyImage(idx, false);
      setStatus(`บันทึกรูป #${idx} อัตโนมัติแล้ว ✓`);
    } catch (e) {
      toast(`ใช้รูปอัตโนมัติไม่สำเร็จ: ${e.message}`, true);
    }
  }, 3000);
}

function setStatus(msg) {
  const sl = document.getElementById('statusline');
  if (sl) { sl.textContent = msg; sl.style.color = ''; }
}

function flushSave() {
  if (!saveTimer || !cur) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const target = cur;
  const snapshot = structuredClone(blocks);
  target.blocks = snapshot;
  target.hasResult = false; // result is now stale until re-applied
  target.status = 'edited';
  api(`/api/projects/${P.id}/images/${target.index}/blocks`, { method: 'PUT', json: { blocks: snapshot } })
    .then(() => drawThumbs())
    .catch((e) => toast(`บันทึกไม่สำเร็จ: ${e.message}`, true));
}

function renderUsage(last) {
  const el = $('usageline');
  if (!el) return;
  const u = P.usage;
  const fmt = (n) => Number(n || 0).toLocaleString();
  const money = (c) => (c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
  const costText = (c, est) => (c === null ? 'ไม่ทราบราคา' : `${est ? '≈ ' : ''}${money(c)}`);
  const parts = [];
  if (last) parts.push(`ครั้งล่าสุด: ${fmt(last.prompt_tokens)} เข้า / ${fmt(last.completion_tokens)} ออก · ${costText(last.cost, last.estimated)}`);
  if (u && u.requests) {
    parts.push(`โปรเจ็คนี้ ${u.requests} คำขอ: ${fmt(u.prompt_tokens)} เข้า / ${fmt(u.completion_tokens)} ออก · ${costText(u.cost, u.estimated)}${u.unpriced ? ` (+${u.unpriced} ครั้งไม่ทราบราคา)` : ''}`);
    if (u.estimated) parts.push('* ราคาประมาณตามเรตแบบเสียเงิน — ถ้าใช้ free tier ของ Google จะไม่ถูกเรียกเก็บ');
  } else {
    parts.push('ยังไม่มีการใช้ token ในโปรเจ็คนี้');
  }
  el.textContent = parts.join('  |  ');
}

let lastDropped = 0; // boxes the server left out of the last translate (page numbers, symbols…)
async function translateImageIdx(index, sweep = false) {
  const s = settings.get();
  const { image, usage, total, dropped } = await api(`/api/projects/${P.id}/images/${index}/translate`, {
    method: 'POST', json: { language: s.lang || 'auto', sweep, slice: !!s.slice, withSource: s.withSource !== false, skipTitles: !!s.skipTitles },
  });
  lastDropped = dropped || 0;
  Object.assign(P.images.find((i) => i.index === index), image);
  P.usage = total;
  renderUsage(usage);
  return usage;
}

// Re-translate one box only: the server crops around it and asks the model about
// just that region. Applies to the box as it is NOW (position/size you set).
async function retranslateBlock(id, btn) {
  const b = blocks.find((x) => x.id === id);
  if (!b || !cur) return;
  const idx = cur.index;
  btn.disabled = true;
  busy++;
  setStatus(`กำลังแปลกล่องนี้ใหม่…`);
  try {
    const r = await api(`/api/projects/${P.id}/images/${idx}/retranslate-block`, {
      method: 'POST', json: { x: b.x, y: b.y, w: b.w, h: b.h, language: settings.get().lang || 'auto' },
    });
    P.usage = r.total;
    renderUsage(r.usage);
    const live = blocks.find((x) => x.id === id);
    if (cur.index !== idx || !live) return toast('ผลแปลใหม่มาถึงตอนที่รูปหรือกล่องเปลี่ยนไปแล้ว จึงไม่ถูกนำมาใช้', true);
    pushUndo();
    live.text = r.text;
    if (r.source) live.source = r.source;
    redraw(); changed(); drawSide();
    selectBlock(id, { scrollBox: false, scrollSide: false });
    toast('แปลกล่องนี้ใหม่แล้ว (ย้อนกลับได้ด้วย Ctrl+Z)');
  } catch (e) {
    toast(e.message, true, 6000);
  } finally {
    busy--;
    btn.disabled = false;
  }
}

async function translateCurrent(sweep = false) {
  bTr.disabled = bSweep.disabled = true;
  busy++;
  toast(sweep ? `กำลังหาข้อความที่ตกหล่นในรูป #${cur.index} …` : `กำลังแปลรูป #${cur.index} … (รูปยาวอาจใช้เวลาครู่หนึ่ง)`, false, 0);
  try {
    const idx = cur.index;
    const before = blocks.length;
    if (sweep) {
      // The sweep keeps what's on the server, so push your current edits first.
      clearTimeout(saveTimer);
      saveTimer = null;
      await api(`/api/projects/${P.id}/images/${idx}/blocks`, { method: 'PUT', json: { blocks } });
    }
    await translateImageIdx(idx, sweep);
    const now = cur.blocks.length;
    toast(sweep
      ? (now > before ? `พบข้อความที่ตกหล่นเพิ่ม ${now - before} กล่อง` : 'ไม่พบข้อความที่ตกหล่นเพิ่มแล้ว')
      : `แปลรูป #${idx} เสร็จ — พบ ${now} กล่องข้อความ`) + (lastDropped ? ` · ข้าม ${lastDropped} กล่องที่ไม่ต้องแปล (เลขหน้า/สัญลักษณ์)` : '');
    if (cur.index === idx) {
      pushUndo(); // so the machine's result can be undone like any other edit
      blocks = structuredClone(cur.blocks);
      selId = blocks[0]?.id ?? null;
      redraw(); drawBoxes(); drawSide();
    }
    drawThumbs();
  } catch (e) {
    toast(e.message, true, 7000);
  } finally {
    busy--;
    bTr.disabled = bSweep.disabled = false;
  }
}

// Rough forecast for "translate all", from what this project's requests averaged so far.
// It's an average per request, so a long or text-heavy image can cost more.
function estimateCost(n) {
  const u = P.usage;
  if (!u || !u.requests) return 'ยังประเมินค่าใช้จ่ายไม่ได้ เพราะยังไม่เคยแปลในโปรเจ็คนี้ (ลองแปลรูปเดียวก่อนจะได้ตัวเลขเฉลี่ย)';
  const num = (v) => Math.round(v).toLocaleString();
  const priced = u.requests - (u.unpriced || 0);
  const money = priced > 0 ? ` ≈ $${((u.cost / priced) * n).toFixed(4)}` : '';
  return `ประมาณ ${num((u.prompt_tokens / u.requests) * n)} token เข้า / ${num((u.completion_tokens / u.requests) * n)} ออก${money}\n(เฉลี่ยจาก ${u.requests} คำขอที่ผ่านมาในโปรเจ็คนี้${u.estimated ? ' · ราคาเป็นค่าประมาณ' : ''})`;
}

async function translateAll() {
  const todo = P.images.filter((i) => i.status === 'new' && !i.skipped && !i.keep);
  if (!todo.length) return toast('ไม่มีรูปที่ยังไม่ได้แปล');
  if (todo.length > 1 && !confirm(`แปล ${todo.length} รูป?\n\n${estimateCost(todo.length)}`)) return;
  bAll.disabled = true;
  busy++;
  // Several images at once (⚙️ "แปลพร้อมกัน"). Too many trips the API's rate limit,
  // which the server answers by waiting and retrying, so 3 is a safe default.
  const limit = Math.min(8, Math.max(1, Number(settings.get().parallel) || 3));
  let next = 0, finished = 0, failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++];
      try {
        await translateImageIdx(i.index);
      } catch (e) {
        failed++;
        console.warn(`image #${i.index}: ${e.message}`);
        toast(`รูป #${i.index}: ${e.message}`, true, 5000);
      }
      toast(`แปลแล้ว ${++finished}/${todo.length}${failed ? ` (ผิดพลาด ${failed})` : ''}…`, false, 0);
      drawThumbs();
    }
  };
  toast(`กำลังแปล 0/${todo.length} (พร้อมกัน ${Math.min(limit, todo.length)} รูป)…`, false, 0);
  await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, worker));
  busy--;
  bAll.disabled = false;
  toast(failed
    ? `แปลเสร็จ ${todo.length - failed}/${todo.length} รูป — ที่ผิดพลาดกด “แปลทั้งหมด” ซ้ำได้`
    : 'แปลครบแล้ว — ตรวจแก้ข้อความ แล้วกด “ใช้ทั้งหมด”', !!failed, 0);
  selectImage(cur.index);
}

async function uploadComposite(index, img, list) {
  const canvas = composite(img, list);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('สร้างรูปไม่ได้ (รูปใหญ่เกินไป?)');
  const rec = await api(`/api/projects/${P.id}/images/${index}/result`, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob,
  });
  const target = P.images.find((i) => i.index === index);
  Object.assign(target, rec);
  target.v = (target.v || 0) + 1; // cache-bust just this thumbnail
}

// `snap` ({ img, list }) lets a caller render an image that is no longer the open
// one (e.g. the one you just navigated away from) without touching current state.
async function applyImage(index, notify, snap) {
  await ensureFont();
  const rec = P.images.find((i) => i.index === index);
  let img, list;
  if (snap) {
    ({ img, list } = snap);
  } else if (cur && index === cur.index) {
    flushSave();
    img = srcImg;
    list = structuredClone(blocks);
  } else {
    img = await loadImage(`/files/${P.id}/orig/${index}`);
    list = rec.blocks;
  }
  // Make sure the server has the latest blocks, then render and upload.
  await api(`/api/projects/${P.id}/images/${index}/blocks`, { method: 'PUT', json: { blocks: list } });
  await uploadComposite(index, img, list);
  dirtyIdx.delete(index);
  drawThumbs();
  if (notify) toast('บันทึกรูปที่แปลแล้ว ✓');
}

async function applyAll() {
  const todo = P.images.filter((i) => !i.skipped && !i.keep && (i.blocks?.length || (i === cur && blocks.length)) && !i.hasResult);
  if (!todo.length) return toast('ไม่มีรูปที่รอใช้');
  bApplyAll.disabled = true;
  try {
    let n = 0;
    for (const i of todo) {
      toast(`กำลังสร้างรูป ${++n}/${todo.length}…`, false, 0);
      await applyImage(i.index, false);
    }
    toast('เสร็จแล้ว — กด “เปิดหน้าที่แปลแล้ว” เพื่อดูผล');
  } catch (e) {
    toast(e.message, true, 7000);
  } finally {
    bApplyAll.disabled = false;
  }
}

// ============================================================
// Undo / redo
// ============================================================
function updateUndoButtons() {
  if (typeof bUndo === 'undefined' || !document.getElementById('bUndo')) return;
  bUndo.disabled = !undoStack.length;
  bRedo.disabled = !redoStack.length;
}

// Call BEFORE changing `blocks`. A `tag` coalesces rapid changes to the same field
// (typing a sentence is one step, not one per letter).
function pushUndo(tag = '') {
  const now = Date.now();
  if (tag && tag === lastUndoTag && now - lastUndoAt < 1000) { lastUndoAt = now; return; }
  lastUndoTag = tag;
  lastUndoAt = now;
  undoStack.push(JSON.stringify(blocks));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function restoreBlocks(json) {
  blocks = JSON.parse(json);
  if (!blocks.some((b) => b.id === selId)) selId = blocks[0]?.id ?? null;
  lastUndoTag = '';
  redraw(); drawBoxes(); drawSide(); changed(); updateUndoButtons();
}

function undo() {
  if (!undoStack.length) return setStatus('ไม่มีอะไรให้ย้อนแล้ว');
  redoStack.push(JSON.stringify(blocks));
  restoreBlocks(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return setStatus('ไม่มีอะไรให้ทำซ้ำ');
  undoStack.push(JSON.stringify(blocks));
  restoreBlocks(redoStack.pop());
}

// ============================================================
// Selecting blocks / moving around
// ============================================================
// Select a block; optionally scroll the canvas to it, scroll the side list to its
// text, and/or put the cursor in its text box.
function selectBlock(id, { scrollBox = true, scrollSide = true, focus = false } = {}) {
  const was = selId;
  selId = id;
  if (was !== id) drawEraseBoxes();
  document.querySelectorAll('#side .blk').forEach((o) => o.classList.toggle('sel', Number(o.dataset.id) === id));
  document.querySelectorAll('#boxes .box').forEach((o) => o.classList.toggle('sel', Number(o.dataset.id) === id));
  const box = document.querySelector(`#boxes .box[data-id="${id}"]`);
  const row = document.querySelector(`#side .blk[data-id="${id}"]`);
  if (scrollBox && box) {
    box.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    box.classList.remove('flash');
    void box.offsetWidth; // restart the animation
    box.classList.add('flash');
  }
  if (scrollSide && row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (focus && row) row.querySelector('textarea')?.focus({ preventScroll: true });
}

// Reading order (top to bottom, then left to right), like the server sorts them.
const blocksInOrder = () => [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);

function stepBlock(dir, focus = false) {
  const list = blocksInOrder();
  if (!list.length) return;
  const at = list.findIndex((b) => b.id === selId);
  const next = list[(at + dir + list.length) % list.length]; // wraps around
  selectBlock(next.id, { focus });
}

function stepImage(dir) {
  const list = P.images.filter((i) => !i.skipped || i === cur);
  const at = list.findIndex((i) => i === cur);
  const next = list[at + dir];
  if (next) selectImage(next.index);
}

function deleteBlock(id) {
  const list = blocksInOrder();
  const at = list.findIndex((b) => b.id === id);
  if (at < 0) return;
  pushUndo();
  blocks = blocks.filter((b) => b.id !== id);
  const after = list.filter((b) => b.id !== id);
  selId = after.length ? after[Math.min(at, after.length - 1)].id : null;
  redraw(); changed(); drawBoxes(); drawSide();
  if (selId != null) selectBlock(selId, { scrollBox: false });
}

// ============================================================
// Keyboard shortcuts
// ============================================================
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlgKeys" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;min-width:min(380px,90vw)">
  <h3 style="margin-top:0">คีย์ลัด</h3>
  <table style="font-size:13px">
    <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>รูปก่อนหน้า / ถัดไป</td></tr>
    <tr><td><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></td><td>กล่องข้อความถัดไป / ก่อนหน้า (เลื่อนไปที่กล่องให้)</td></tr>
    <tr><td><kbd>Enter</kbd></td><td>พิมพ์แก้ข้อความของกล่องที่เลือก</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>ออกจากช่องพิมพ์</td></tr>
    <tr><td><kbd>Alt+↑</kbd> <kbd>Alt+↓</kbd></td><td>ไปกล่องก่อนหน้า/ถัดไป โดยไม่ออกจากช่องพิมพ์</td></tr>
    <tr><td><kbd>Delete</kbd></td><td>ลบกล่องที่เลือก</td></tr>
    <tr><td><kbd>A</kbd></td><td>เพิ่มกล่องข้อความ</td></tr>
    <tr><td><kbd>Space</kbd> (ค้าง)</td><td>ดูต้นฉบับ</td></tr>
    <tr><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td><td>ย้อนกลับ / ทำซ้ำ</td></tr>
    <tr><td><kbd>Ctrl+S</kbd></td><td>ใช้รูปนี้ (render ทันที)</td></tr>
  </table>
  <p class="muted" style="font-size:12px">ขณะพิมพ์ในช่องข้อความ Ctrl+Z จะย้อนตัวอักษรตามปกติ (ปิดช่องพิมพ์ด้วย Esc ก่อน ถ้าจะย้อนการลาก/ลบกล่อง)</p>
  <div class="row" style="justify-content:flex-end"><button id="keysClose">ปิด</button></div>
</dialog>`);
document.getElementById('keysClose').onclick = () => document.getElementById('dlgKeys').close();

// ============================================================
// Glossary (per project) and export
// ============================================================
const dlgStyle = 'background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;min-width:min(480px,92vw)';
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlgGloss" style="${dlgStyle}">
  <h3 style="margin-top:0">📖 Glossary ของโปรเจ็คนี้</h3>
  <p class="muted" style="font-size:13px">ใส่ชื่อตัวละคร ศัพท์เฉพาะ หรือโน้ตสไตล์ ส่งไปกับทุกคำขอแปล ชื่อจะสะกดตรงกันทุกรูป<br>
  บรรทัดละหนึ่งรายการ เช่น <code>Iruma = อิรุมะ</code> หรือโน้ตทั่วไป เช่น <code>ตัวเอกพูดสุภาพ ลงท้าย ครับ</code></p>
  <textarea id="glossText" rows="12" placeholder="Iruma = อิรุมะ&#10;Babel = บาเบล&#10;ตัวเอกพูดสุภาพ ลงท้ายด้วย ครับ"></textarea>
  <p class="muted" style="font-size:12px">มีผลกับการแปลครั้งต่อไป รูปที่แปลไปแล้วต้องกด “แปลรูปนี้” ใหม่</p>
  <div class="row" style="justify-content:flex-end"><button id="glossClose">ปิด</button><button id="glossSave" class="primary">บันทึก</button></div>
</dialog>
<dialog id="dlgExport" style="${dlgStyle}">
  <h3 style="margin-top:0">⬇ ส่งออกรูปที่แปลแล้ว</h3>
  <p id="expInfo" class="muted"></p>
  <p><label><input type="radio" name="expfmt" value="zip" checked style="width:auto"> ZIP</label>
     &nbsp; <label><input type="radio" name="expfmt" value="cbz" style="width:auto"> CBZ (เปิดในโปรแกรมอ่านมังงะได้)</label></p>
  <p><label><input type="checkbox" id="expOrig" style="width:auto"> รวมรูปต้นฉบับของหน้าที่ยังไม่ได้แปลด้วย</label><br>
     <span class="muted" style="font-size:12px">ไม่ติ๊ก = เฉพาะหน้าที่แปลแล้ว รูปที่ข้ามไว้ไม่ถูกรวมในทั้งสองกรณี เรียงเลข 001, 002, … ตามลำดับหน้า</span></p>
  <div class="row" style="justify-content:flex-end"><button id="expClose">ปิด</button><button id="expGo" class="primary">ดาวน์โหลด</button></div>
</dialog>`);

const updateGlossButton = () => {
  const b = document.getElementById('bGloss');
  if (b) b.textContent = '📖 Glossary' + (P?.glossary?.trim() ? ' ✓' : '');
};

function openGlossary() {
  document.getElementById('glossText').value = P.glossary || '';
  document.getElementById('dlgGloss').showModal();
}
document.getElementById('glossClose').onclick = () => document.getElementById('dlgGloss').close();
document.getElementById('glossSave').onclick = async () => {
  try {
    const r = await api(`/api/projects/${P.id}/glossary`, { method: 'PUT', json: { text: document.getElementById('glossText').value } });
    P.glossary = r.text;
    updateGlossButton();
    document.getElementById('dlgGloss').close();
    toast('บันทึก glossary แล้ว — มีผลกับการแปลครั้งต่อไป');
  } catch (e) {
    toast(e.message, true);
  }
};

function openExport() {
  const live = P.images.filter((i) => !i.skipped);
  const kept = live.filter((i) => i.keep).length;
  const done = live.filter((i) => i.hasResult && !i.keep).length;
  document.getElementById('expInfo').textContent = `แปลแล้ว ${done} จาก ${live.length} รูป${kept ? ` · คงต้นฉบับ ${kept} รูป (รวมในไฟล์เสมอ)` : ''} (ไม่นับรูปที่ข้าม)`;
  document.getElementById('dlgExport').showModal();
}
document.getElementById('expClose').onclick = () => document.getElementById('dlgExport').close();
document.getElementById('expGo').onclick = async () => {
  const withOrig = document.getElementById('expOrig').checked;
  const done = P.images.filter((i) => !i.skipped && (i.keep || i.hasResult)).length;
  // Check here: a server error would replace the page with raw JSON.
  if (!done && !withOrig) return toast('ยังไม่มีรูปที่แปลแล้ว กด “ใช้รูปนี้” ก่อน หรือติ๊กรวมรูปต้นฉบับ', true);
  try {
    // Render a pending edit on the open image so the download isn't one step behind.
    if (cur && dirtyIdx.has(cur.index)) await applyImage(cur.index, false);
  } catch (e) {
    return toast(`render รูปปัจจุบันไม่สำเร็จ: ${e.message}`, true);
  }
  const fmt = document.querySelector('input[name=expfmt]:checked').value;
  document.getElementById('dlgExport').close();
  window.location.href = `/api/projects/${P.id}/export?format=${fmt}&originals=${withOrig ? 1 : 0}`;
};

function inEditor() {
  return !!(P && cur && srcImg && document.getElementById('c'));
}

document.addEventListener('keydown', (e) => {
  if (!inEditor() || e.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return; // settings / help are open
  const t = e.target;
  const typing = !!t.closest?.('textarea, select, input:not([type=color]):not([type=checkbox])');
  const onControl = !!t.closest?.('button, a');
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && key === 's') { e.preventDefault(); applyImage(cur.index, true).catch((er) => toast(er.message, true)); return; }
  if (e.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) { e.preventDefault(); stepBlock(key === 'ArrowDown' ? 1 : -1, typing); return; }
  if (typing) { if (key === 'Escape') t.blur(); return; } // let the browser handle text editing

  if (mod) {
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    return;
  }
  if (e.altKey) return;

  switch (key) {
    case 'ArrowLeft': e.preventDefault(); stepImage(-1); break;
    case 'ArrowRight': e.preventDefault(); stepImage(1); break;
    case 'Tab': e.preventDefault(); stepBlock(e.shiftKey ? -1 : 1); break;
    case 'Delete': case 'Backspace': if (selId != null) { e.preventDefault(); deleteBlock(selId); } break;
    case 'Enter': if (!onControl && selId != null) { e.preventDefault(); selectBlock(selId, { scrollBox: false, focus: true }); } break;
    case 'a': if (!onControl) { e.preventDefault(); addBlock(); } break;
    case ' ':
      if (onControl) break; // Space on a focused button should click it
      e.preventDefault();
      if (!e.repeat && !showOrig) { showOrig = true; redraw(); }
      break;
    default:
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && showOrig) { showOrig = false; redraw(); }
});
window.addEventListener('blur', () => { if (showOrig) { showOrig = false; redraw(); } });

window.addEventListener('beforeunload', flushSave);
