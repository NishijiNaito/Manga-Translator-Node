'use strict';
// A very small S3-compatible client (Cloudflare R2, MinIO, AWS...): PUT / GET / DELETE of one
// object, signed with AWS Signature V4. No dependency, like lib/zip.js.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 percent-encoding (what SigV4 wants), not encodeURIComponent's looser set.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map(enc).join('/');

/**
 * SigV4: returns the headers to send (host, x-amz-date, [x-amz-content-sha256], Authorization).
 * `path` is the already-encoded request path. Pure function so it can be checked against AWS' test vectors.
 */
function sign({ method, host, path, query = '', headers = {}, body = '', accessKeyId, secretAccessKey, region, service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const all = { host, 'x-amz-date': amzDate, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  if (service === 's3') all['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(all).sort();
  const canonical = [
    method, path, query,
    names.map((n) => `${n}:${all[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return all;
}

function createClient({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', timeoutMs = 30_000 }) {
  const base = new URL(endpoint);
  const lib = base.protocol === 'http:' ? http : https;

  function once(method, key, body, contentType) {
    return new Promise((resolve, reject) => {
      const path = `${base.pathname.replace(/\/+$/, '')}/${enc(bucket)}/${encPath(key)}`; // path-style addressing
      const payload = body || Buffer.alloc(0);
      const headers = sign({
        method, host: base.host, path, body: payload, accessKeyId, secretAccessKey, region,
        headers: contentType ? { 'content-type': contentType } : {},
      });
      const { host, ...send } = headers;
      const req = lib.request({
        protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method, path,
        headers: { ...send, ...(method === 'PUT' ? { 'content-length': payload.length } : {}) },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Storage request timed out')));
      req.on('error', reject);
      if (method === 'PUT') req.write(payload);
      req.end();
    });
  }

  // Network errors and 5xx are retried a couple of times; 4xx are answers, not accidents.
  async function call(method, key, body, contentType) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try {
        const res = await once(method, key, body, contentType);
        if (res.status < 500) return res;
        last = new Error(`Storage ${method} ${res.status}: ${res.buffer.toString('utf8').slice(0, 160)}`);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  const fail = (res, what) => new Error(`Storage ${what} failed (${res.status}): ${res.buffer.toString('utf8').slice(0, 200)}`);
  return {
    async put(key, buf, contentType) {
      const res = await call('PUT', key, buf, contentType);
      if (res.status < 200 || res.status >= 300) throw fail(res, 'PUT');
    },
    /** Buffer, or null when the object does not exist. */
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw fail(res, 'GET');
      return res.buffer;
    },
    async del(key) {
      const res = await call('DELETE', key);
      if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw fail(res, 'DELETE');
    },
  };
}

module.exports = { sign, createClient };
