// All the heavy lifting lives here (not in the popup) so it keeps running if the
// popup closes while images are being sent.

const DEFAULT_SERVER = 'http://127.0.0.1:3000';

// ---------- functions injected into the page (must be self-contained) ----------
function pageCollect() {
  const LAZY = ['data-src', 'data-original', 'data-lazy-src', 'data-url'];
  const images = [];
  document.querySelectorAll('img').forEach((el, index) => {
    let cand = LAZY.map((a) => el.getAttribute(a)).find((v) => v && v.trim());
    const fromLazyAttr = !!cand;
    if (!cand) cand = el.currentSrc || el.getAttribute('src');
    if (!cand || /^data:image\/(gif|svg)/.test(cand)) return;
    // Skip icons by their loaded size. Not for lazy images: their src is a 1x1
    // placeholder, so naturalWidth says nothing about the real image (the server
    // drops tiny ones after downloading anyway).
    if (!fromLazyAttr && el.complete && el.naturalWidth && el.naturalWidth < 100) return;
    try {
      images.push({ index, url: new URL(cand.trim(), document.baseURI).href });
    } catch { /* unparseable URL */ }
  });
  return { pageUrl: location.href, title: document.title, images };
}

function pageSwap(map) {
  const LAZY = ['data-src', 'data-original', 'data-lazy-src', 'data-url'];
  const ATTRS = ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-srcset', 'loading'];
  let swapped = 0;
  document.querySelectorAll('img').forEach((el) => {
    if (el.dataset.mtOrig) return; // already swapped
    let cand = LAZY.map((a) => el.getAttribute(a)).find((v) => v && v.trim());
    if (!cand) cand = el.currentSrc || el.getAttribute('src');
    if (!cand) return;
    let key;
    try { key = new URL(cand.trim(), document.baseURI).href; } catch { return; }
    const to = map[key];
    if (!to) return;

    const saved = { attrs: {}, sources: [] };
    for (const a of ATTRS) saved.attrs[a] = el.getAttribute(a);
    const pic = el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : null;
    if (pic) pic.querySelectorAll('source').forEach((s) => { saved.sources.push(s.getAttribute('srcset')); s.removeAttribute('srcset'); });
    el.dataset.mtOrig = JSON.stringify(saved);
    for (const a of ATTRS) if (a !== 'src') el.removeAttribute(a);
    el.setAttribute('src', to);
    swapped++;
  });
  return swapped;
}

function pageRestore() {
  let restored = 0;
  document.querySelectorAll('img[data-mt-orig]').forEach((el) => {
    const saved = JSON.parse(el.dataset.mtOrig);
    for (const [a, v] of Object.entries(saved.attrs)) {
      if (v === null) el.removeAttribute(a); else el.setAttribute(a, v);
    }
    const pic = el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : null;
    if (pic) pic.querySelectorAll('source').forEach((s, i) => saved.sources[i] != null && s.setAttribute('srcset', saved.sources[i]));
    delete el.dataset.mtOrig;
    restored++;
  });
  return restored;
}

// blob: URLs only exist inside the page, so read those from there.
async function pageReadBlob(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

// ---------- helpers ----------
async function inPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
}

async function serverUrl() {
  const { serverUrl: s } = await chrome.storage.local.get('serverUrl');
  return (s || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function api(path, opts) {
  const res = await fetch((await serverUrl()) + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function imageBytes(tabId, url) {
  if (url.startsWith('blob:')) return (await fetch(await inPage(tabId, pageReadBlob, [url]))).blob();
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// ---------- actions ----------
async function sendPage(tabId) {
  const data = await inPage(tabId, pageCollect);
  if (!data.images.length) throw new Error('ไม่พบรูปในหน้านี้');
  const project = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  // Retry from the browser what the server couldn't fetch (login cookies, hotlink
  // protection, blob: URLs). Three at a time.
  const queue = [...project.failed];
  let uploaded = 0;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const blob = await imageBytes(tabId, f.url);
        await api(`/api/projects/${project.id}/images/${f.index}/source?url=${encodeURIComponent(f.url)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
        });
        uploaded++;
      } catch (e) {
        console.warn('could not fetch image', f.url, e.message);
      }
    }
  }));

  const total = project.images.length + uploaded;
  if (!total) throw new Error('ดึงรูปมาไม่ได้เลย (ลองเปิดหน้าเว็บให้รูปโหลดครบก่อน)');
  await chrome.tabs.create({ url: `${await serverUrl()}/#/p/${project.id}` });
  return { id: project.id, count: total };
}

async function swapPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const found = await api(`/api/lookup?url=${encodeURIComponent(tab.url)}`).catch(() => null);
  if (!found) throw new Error('ยังไม่เคยส่งหน้านี้ไปแปล (หรือ URL ของหน้าเปลี่ยนไป)');
  const list = await api(`/api/projects/${found.id}/replacements`);
  if (!list.length) throw new Error('ยังไม่มีรูปที่กด “ใช้รูปนี้/ใช้ทั้งหมด” ในหน้าแก้ไข');
  const map = Object.fromEntries(list.map((r) => [r.original, r.translated]));
  const n = await inPage(tabId, pageSwap, [map]);
  return { swapped: n, available: list.length };
}

// Opt-in (popup checkbox): when a page finishes loading, swap in translated images if
// a project exists for that exact URL. It asks your server about EVERY page you open,
// which is why it is off by default.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !/^https?:/.test(tab.url || '')) return;
  const { autoSwap } = await chrome.storage.local.get('autoSwap');
  if (!autoSwap) return;
  try {
    await swapPage(tabId);
  } catch {
    return; // no project for this page, or nothing translated yet: stay quiet
  }
  // Lazy-loaded images appear later; sweep again a couple of times.
  for (const wait of [3000, 8000]) {
    await new Promise((r) => setTimeout(r, wait));
    try { await swapPage(tabId); } catch { return; } // tab closed / navigated away
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const run = {
    SEND: () => sendPage(msg.tabId),
    SWAP: () => swapPage(msg.tabId),
    RESTORE: async () => ({ restored: await inPage(msg.tabId, pageRestore) }),
  }[msg.action];
  if (!run) return false;
  run().then((r) => respond({ ok: true, ...r }), (e) => respond({ ok: false, error: e.message }));
  return true; // async response
});
