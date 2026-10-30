'use strict';
// Everything that exists because the server may sit on the internet:
//  - safeGet: fetch a URL for a client WITHOUT letting it reach private networks (SSRF)
//  - makeAuth: one shared secret -> login cookie / Bearer token / signed file links
//  - small in-memory rate limiter
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// ---------- private address detection ----------
function parseIPv4(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function isPrivateV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
    (a === 169 && b === 254) ||             // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;                               // multicast + reserved
}

function parseIPv6(input) {
  let s = input.split('%')[0].toLowerCase();
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // trailing dotted IPv4
  if (m) {
    const v4 = parseIPv4(m[2]);
    if (!v4) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;
  const n = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return n.some(Number.isNaN) ? null : n;
}

function isPrivateV6(g) {
  const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;      // link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;      // unique local
  if ((g[0] & 0xff00) === 0xff00) return true;      // multicast
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateV4(embedded(g[6], g[7]));                    // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;   // Teredo
  return false;
}

/** True for loopback / private / link-local / metadata / multicast addresses (and anything unparseable). */
function isPrivateAddress(addr) {
  const a = String(addr).replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return isPrivateV4(parseIPv4(a));
  if (net.isIPv6(a)) {
    const g = parseIPv6(a);
    return !g || isPrivateV6(g);
  }
  return true;
}

const blocked = (what) => Object.assign(new Error(`ปลายทางไม่ได้รับอนุญาต (เครือข่ายภายใน/พอร์ตที่ไม่รองรับ): ${what}`), { status: 400, code: 'EBLOCKED' });

// Runs on the real connection, so the address that was checked is the address used
// (a DNS answer that changes between "check" and "connect" cannot sneak past).
function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => isPrivateAddress(a.address))) return cb(blocked(hostname));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/**
 * GET a URL and return { ok, status, url, headers, buffer }.
 * Unless allowPrivate: only ports 80/443, no private/loopback targets, and every
 * redirect hop is checked again. Body size is limited after decompression too.
 */
function safeGet(rawUrl, { headers = {}, timeoutMs = 30_000, maxBytes = 30 * 1024 * 1024, maxRedirects = 5, allowPrivate = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  const step = (urlStr, hops) => new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(Object.assign(new Error('Bad URL'), { status: 400 })); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(Object.assign(new Error('Only http(s) URLs are supported'), { status: 400 }));
    }
    if (u.username || u.password) return reject(Object.assign(new Error('URLs with a login are not supported'), { status: 400 }));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!allowPrivate) {
      if (port !== 80 && port !== 443) return reject(blocked(`port ${port}`));
      if (net.isIP(host) && isPrivateAddress(host)) return reject(blocked(host)); // IP literals skip DNS
    }
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error('Timeout'));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'GET',
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      lookup: allowPrivate ? undefined : guardedLookup,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc) {
        res.resume();
        clearTimeout(timer);
        if (hops >= maxRedirects) return reject(new Error('Too many redirects'));
        let next;
        try { next = new URL(loc, u).href; } catch { return reject(new Error('Bad redirect')); }
        return resolve(step(next, hops + 1));
      }
      if (Number(res.headers['content-length'] || 0) > maxBytes) { req.destroy(); return reject(new Error('File too large')); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let body = res;
      if (enc === 'gzip' || enc === 'x-gzip') body = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') body = res.pipe(zlib.createInflate());
      else if (enc === 'br') body = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      body.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); clearTimeout(timer); reject(new Error('File too large')); return; }
        chunks.push(c);
      });
      body.on('end', () => { clearTimeout(timer); resolve({ ok: status >= 200 && status < 300, status, url: u.href, headers: res.headers, buffer: Buffer.concat(chunks) }); });
      body.on('error', (e) => { clearTimeout(timer); reject(e); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('Timeout')), left);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
  return step(rawUrl, 0);
}

// ---------- auth ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function makeAuth(secret) {
  const key = crypto.createHmac('sha256', secret).update('manga-translator/v1').digest();
  const mac = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const same = (a, b) => {
    const A = Buffer.from(String(a)), B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    /** Is this the shared secret? (constant time) */
    secretOk: (candidate) => crypto.timingSafeEqual(sha(candidate), sha(secret)),
    /** Login cookie value: "<expiry>.<mac>". */
    issueSession(ttlSec) {
      const exp = now() + ttlSec;
      return `${exp}.${mac(`s:${exp}`)}`;
    },
    checkSession(token) {
      const [exp, sig] = String(token || '').split('.');
      return !!(exp && sig && Number(exp) > now() && same(sig, mac(`s:${exp}`)));
    },
    /** `pathname` + ?e=&s= : a link that works without a cookie until it expires (for /files only). */
    signPath(pathname, ttlSec) {
      const exp = now() + ttlSec;
      return `${pathname}?e=${exp}&s=${mac(`f:${pathname}:${exp}`)}`;
    },
    checkPath(pathname, e, s) {
      return !!(e && s && Number(e) > now() && same(s, mac(`f:${pathname}:${e}`)));
    },
  };
}

// ---------- rate limit ----------
/** At most `max` events per `windowMs` per key (in memory; fine for one process). */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  const recent = (key) => {
    const t = Date.now() - windowMs;
    const list = (hits.get(key) || []).filter((x) => x > t);
    hits.set(key, list);
    return list;
  };
  return {
    /** Record an event; returns false when the key is over the limit. */
    hit(key) {
      const list = recent(key);
      if (list.length >= max) return false;
      list.push(Date.now());
      return true;
    },
    /** Is the key at its limit (without recording)? */
    full: (key) => recent(key).length >= max,
    add(key) { recent(key).push(Date.now()); },
    reset: (key) => hits.delete(key),
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { isPrivateAddress, safeGet, makeAuth, makeLimiter, parseCookies };
