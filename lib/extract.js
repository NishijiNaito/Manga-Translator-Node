const cheerio = require('cheerio');

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'src'];

function resolve(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

function bestFromSrcset(srcset) {
  let best = null;
  let bestW = -1;
  for (const part of srcset.split(',')) {
    const [url, desc] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = desc && desc.endsWith('w') ? parseInt(desc, 10) : 0;
    if (w > bestW) {
      best = url;
      bestW = w;
    }
  }
  return best;
}

/**
 * Find every <img> in the HTML and return its absolute URL, in document order.
 * `index` is the position among ALL <img> tags, so the viewer can swap the same
 * element later without re-deriving URLs.
 */
function extractImages(html, baseUrl) {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const base = baseHref ? resolve(baseHref, baseUrl) || baseUrl : baseUrl;
  const out = [];
  $('img').each((index, el) => {
    const $el = $(el);
    let raw = null;
    for (const attr of LAZY_ATTRS) {
      const v = ($el.attr(attr) || '').trim();
      if (v && !v.startsWith('data:image/gif') && !/^data:image\/svg/.test(v)) {
        raw = v;
        break;
      }
    }
    if (!raw) {
      const ss = $el.attr('data-srcset') || $el.attr('srcset');
      if (ss) raw = bestFromSrcset(ss);
    }
    if (!raw) return;
    const url = raw.startsWith('data:') ? raw : resolve(raw, base);
    if (url) out.push({ index, url, alt: $el.attr('alt') || '' });
  });
  return out;
}

/**
 * Re-emit the page with translated images swapped in. `replacements` maps the
 * <img> index to a new URL. Scripts are dropped so lazy-loaders can't undo it.
 */
function rewriteHtml(html, baseUrl, replacements) {
  const $ = cheerio.load(html);
  $('script').remove();
  if (baseUrl && !$('base[href]').length) {
    $('head').prepend(`<base href="${baseUrl.replace(/"/g, '&quot;')}">`);
  }
  $('img').each((index, el) => {
    const url = replacements[index];
    if (!url) return;
    const $el = $(el);
    for (const a of ['srcset', 'data-srcset', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'loading']) {
      $el.removeAttr(a);
    }
    $el.attr('src', url);
    $el.parent('picture').find('source').remove();
  });
  return $.html();
}

module.exports = { extractImages, rewriteHtml };
