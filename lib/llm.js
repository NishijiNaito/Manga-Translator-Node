const sharp = require('sharp');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Output ceiling per request. Unset (default) = Gemini: the model's own maximum, read
// from the API; OpenRouter: no limit sent. Set MAX_OUTPUT_TOKENS in .env to force a cap.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || null;
// How many slices of ONE tall image are sent to the model at the same time.
const SLICE_CONCURRENCY = Math.max(1, Number(process.env.SLICE_CONCURRENCY) || 3);
// 0 = as repeatable as the model allows. Detecting regions is a lookup, not creative
// writing, so randomness only makes the box count wander between runs.
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0);
// Gemini's API reports token counts but no money, so cost is an ESTIMATE from
// list prices (USD per 1M tokens: [input, output]). Thinking tokens bill as output.
// Override with PRICE_IN_PER_M / PRICE_OUT_PER_M in .env; check ai.google.dev/pricing.
const GEMINI_PRICES = {
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-2.5-pro': [1.25, 10.0],
};
function geminiCost(model, inTok, outTok) {
  let rate = null;
  if (process.env.PRICE_IN_PER_M && process.env.PRICE_OUT_PER_M) {
    rate = [Number(process.env.PRICE_IN_PER_M), Number(process.env.PRICE_OUT_PER_M)];
  } else {
    const key = Object.keys(GEMINI_PRICES).sort((a, b) => b.length - a.length).find((k) => model.startsWith(k));
    if (key) rate = GEMINI_PRICES[key];
  }
  return rate ? (inTok * rate[0] + outTok * rate[1]) / 1e6 : null; // null = unknown model
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT =
  'You are a professional Thai manga, manhwa, and webtoon translator AND a precise text-detection engine. ' +
  'You receive a manga image and must: (1) locate every region that contains text - speech bubbles, ' +
  'narration/caption boxes, and sound effects; and (2) translate each region into natural, colloquial, ' +
  'and emotional Thai. Rules: do NOT translate idioms literally; use natural Thai pronouns and particles; ' +
  'keep it punchy like real manga dialogue; output ONLY the Thai text for each region, no romaji, no notes.';

function normalize(arr) {
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const box = it.box || it.box_2d || it.bbox;
    if (Array.isArray(box) && box.length === 4 && typeof it.text === 'string' && it.text.trim()) {
      const parts = (Array.isArray(it.parts) ? it.parts : [])
        .filter((q) => Array.isArray(q) && q.length === 4 && q.every((n) => Number.isFinite(Number(n))))
        .slice(0, 6).map((q) => q.map(Number));
      out.push({
        box: box.map(Number),
        ...(parts.length ? { parts } : {}),
        text: it.text.trim(),
        source: typeof it.source === 'string' ? it.source.trim() : '',
      });
    }
  }
  return out;
}

function parseDetections(raw) {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a !== -1 && b > a) {
    try {
      const arr = JSON.parse(s.slice(a, b + 1));
      const ok = normalize(arr);
      if (ok.length || arr.length === 0) return ok;
    } catch {
      // fall through to lenient recovery
    }
  }
  // Lenient: scan object by object for models that emit nearly-valid JSON.
  const out = [];
  for (const chunk of s.match(/\{[^{}]*\}/g) || []) {
    const box = chunk.match(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
    const strs = [...chunk.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .filter((t) => !/^(box|box_2d|bbox|parts|text|source)$/.test(t));
    if (!box || !strs.length) continue;
    // "text" is always the last field; "source" (when asked for) comes just before it.
    const unescape = (v) => {
      try {
        return JSON.parse(`"${v}"`);
      } catch {
        return v; // keep raw
      }
    };
    const text = unescape(strs[strs.length - 1]);
    const source = strs.length > 1 ? unescape(strs[strs.length - 2]) : '';
    out.push({ box: box.slice(1, 5).map(Number), text: text.trim(), source: source.trim() });
  }
  return out;
}

async function requestOpenRouter(png, prompt, apiKey, model) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        },
      ],
      ...(MAX_OUTPUT_TOKENS ? { max_tokens: MAX_OUTPUT_TOKENS } : {}),
      temperature: TEMPERATURE,
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Empty LLM response');
  const u = data.usage || {};
  return {
    content,
    usage: { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, cost: u.cost ?? null, estimated: false },
  };
}

// The model's own maximum output size, asked from the API once per model and cached.
// null if it can't be read (then no limit is sent and the model default applies).
const outputLimits = new Map();
async function modelOutputLimit(model, apiKey) {
  if (outputLimits.has(model)) return outputLimits.get(model);
  let limit = null;
  try {
    const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) limit = (await res.json()).outputTokenLimit || null;
  } catch {
    // fall through: no limit
  }
  if (limit) outputLimits.set(model, limit); // don't cache failures
  return limit;
}

// Google AI Studio key -> Gemini API directly. box_2d is Gemini's native
// [ymin, xmin, ymax, xmax] 0-1000 format, same as the prompt asks for.
async function requestGemini(png, prompt, apiKey, model) {
  // Output cap = MAX_OUTPUT_TOKENS if you set it, else the model's own maximum.
  const maxOut = MAX_OUTPUT_TOKENS || (await modelOutputLimit(model, apiKey));
  const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: TEMPERATURE, seed: 7, ...(maxOut ? { maxOutputTokens: maxOut } : {}), responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!content) throw new Error(`Empty Gemini response (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
  const finish = data.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP') console.warn(`Gemini finishReason=${finish} (output may be cut off)`);
  const u = data.usageMetadata || {};
  const inTok = u.promptTokenCount || 0;
  const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  return { content, usage: { prompt_tokens: inTok, completion_tokens: outTok, cost: geminiCost(model, inTok, outTok), estimated: true } };
}

async function callOnce(pngBuffer, w, h, { provider, apiKey, model, language, known, glossary, withSource, regionMode }) {
  const lang = { ja: 'Japanese', ko: 'Korean', zh: 'Chinese', en: 'English' }[language];
  const langNote = lang
    ? `The main source language is ${lang}, but translate text in ANY other language too. `
    : 'The text may be Japanese, Korean, Chinese or English, even several in one image. ';
  // Sweep mode: some regions are already handled; ask only for what was missed.
  const knownNote = known
    ? 'These regions are ALREADY translated, do NOT return them again: ' + JSON.stringify(known) +
      '. Return ONLY text regions NOT covered by those boxes (return [] if none are missing). '
    : '';
  // Per-project glossary / style notes, so names and terms stay consistent across
  // every image of a chapter (each image is translated in its own request).
  const glossaryNote = glossary && glossary.trim()
    ? 'PROJECT GLOSSARY AND STYLE NOTES. Follow them strictly: whenever one of the listed names or terms ' +
      'appears, use exactly the Thai wording given.\n' + glossary.trim().slice(0, 6000) + '\n'
    : '';
  // "source" = the original text as written, so you can check a translation against it.
  // It costs extra output tokens, so it is optional. "text" stays the LAST field.
  const itemShape = withSource || regionMode
    ? '{"box": [y_min, x_min, y_max, x_max], "source": "<original text exactly as written>", "text": "<Thai translation>"}'
    : '{"box": [y_min, x_min, y_max, x_max], "text": "<Thai translation>"}';
  // Region mode: the image is a tight crop around ONE bubble/caption being re-translated.
  const prompt = regionMode
    ? 'This image is a crop of a manga page that contains ONE speech bubble, caption or sound effect ' +
      `(it may span several lines). ${langNote}Read ALL the text in it and translate it into natural Thai. ` +
      glossaryNote +
      `Return ONLY a JSON array with exactly one item: ${itemShape} using box [0, 0, 1000, 1000]. ` +
      'If there is no text, return [].'
    : `This image is ${w} pixels wide and ${h} pixels tall. ${langNote}` +
      'Translate EVERY piece of text that is not already Thai: speech bubbles, narration boxes, captions, ' +
      'titles, signs and sound effects. Do not skip or summarise any region, even small or stylised ones. ' +
      'Scan the whole image from top to bottom before answering. ' + knownNote + glossaryNote +
      'Detect every text region and return ONLY a JSON array (no markdown, no prose). Each item must be exactly: ' +
      `${itemShape} where the four box values are ` +
      'integers from 0 to 1000, normalized to the image size, y before x, top-left origin. ' +
      'Merge text of the same speech bubble into one item. If a bubble is not rectangular (for example L-shaped) ' +
      'or its text is split into separate areas, set "box" to the area where the whole translation will fit best ' +
      '(its largest text area) and add "parts": an array of [y_min, x_min, y_max, x_max] boxes (same scale) for ' +
      'every OTHER area holding text of that same bubble, placed right after "box". Omit "parts" otherwise. ' +
      'If there is no text, return [].';

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Rate limit (429) / overload (5xx): wait a bit longer each time instead of
    // hammering the API again straight away. Matters most with parallel requests.
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const { content, usage } = provider === 'openrouter'
        ? await requestOpenRouter(pngBuffer, prompt, apiKey, model)
        : await requestGemini(pngBuffer, prompt, apiKey, model);
      const detections = parseDetections(content);
      if (!detections.length && content.replace(/\s/g, '') !== '[]') {
        console.warn(`[llm] 0 boxes parsed from a non-empty reply:\n${content.slice(0, 600)}`);
      }
      return { detections, usage };
    } catch (e) {
      lastErr = e;
      if (/\b(400|401|403|404)\b/.test(e.message)) break; // retrying won't help
      if (attempt) console.warn(`[llm] retry ${attempt}: ${e.message.slice(0, 120)}`);
    }
  }
  throw new Error(`Vision LLM call failed: ${lastErr.message}`);
}

const area = (b) => b.w * b.h;
function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(area(a), area(b));
}

/** Drop boxes that mostly overlap an already-kept one (bigger box wins). Slices
 * overlap, so text near a cut is seen twice; this keeps the fuller copy. */
function dedupe(blocks) {
  const out = [];
  for (const b of [...blocks].sort((p, q) => area(q) - area(p))) {
    if (!out.some((k) => overlapRatio(k, b) > 0.5)) out.push(b);
  }
  return out;
}

/** Provider / key / model for a request: the request's own values, else .env defaults. */
function resolveConfig(opts) {
  const provider = opts.provider === 'openrouter' ? 'openrouter' : 'gemini';
  const apiKey = (opts.apiKey ||
    (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY) || '').trim();
  const model = opts.model || (provider === 'gemini'
    ? process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    : process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite');
  if (!apiKey) throw new Error('ยังไม่ได้ใส่ API key — ตั้งค่าในปุ่ม ⚙️ หรือไฟล์ .env');
  return { provider, apiKey, model };
}

/**
 * Re-translate ONE box: crop around rect {x,y,w,h} (with some margin so the model sees
 * the whole bubble) and ask only about that. Much cheaper than redoing the whole image.
 * Returns { text, source, usage }.
 */
async function translateRegion(buffer, rect, opts) {
  const { provider, apiKey, model } = resolveConfig(opts);
  const meta = await sharp(buffer).rotate().metadata();
  const pad = Math.max(12, Math.round(0.15 * Math.max(rect.w, rect.h)));
  const left = Math.max(0, Math.floor(rect.x - pad));
  const top = Math.max(0, Math.floor(rect.y - pad));
  const width = Math.min(meta.width - left, Math.ceil(rect.w + pad * 2));
  const height = Math.min(meta.height - top, Math.ceil(rect.h + pad * 2));
  if (width < 4 || height < 4) throw new Error('กล่องอยู่นอกรูป');

  const png = await sharp(buffer).rotate().extract({ left, top, width, height }).png().toBuffer();
  const { detections, usage } = await callOnce(png, width, height, {
    provider, apiKey, model, language: opts.language, glossary: opts.glossary, regionMode: true,
  });
  if (!detections.length) throw new Error('AI ไม่พบข้อความในกล่องนี้');
  const ordered = [...detections].sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
  return {
    text: ordered.map((d) => d.text).join('\n'),
    source: ordered.map((d) => d.source).filter(Boolean).join('\n'),
    usage,
  };
}

/**
 * Detect + translate all text in an image. Tall webtoon strips are cut into
 * slices because vision models localize poorly on very elongated images. Slices
 * overlap so text sitting on a cut isn't lost; boxes map back to full-image pixels.
 *
 * opts.existing: blocks already found (pixels). When given, this is a "sweep":
 * the model is told about them and asked only for what was missed, and the
 * result holds only the NEW blocks.
 * Returns blocks: [{ x, y, w, h, text }] in pixels of the original image.
 */
async function translateImage(buffer, opts) {
  const { provider, apiKey, model } = resolveConfig(opts);

  const meta = await sharp(buffer).rotate().metadata();
  const W = meta.width;
  const H = meta.height;
  const existing = opts.existing || null;
  const step = Math.round(W * 1.2);
  const overlap = Math.round(step * 0.12);
  const slices = [];
  if (!opts.slice) {
    slices.push({ y: 0, h: H }); // whole image in one request
  } else {
    for (let y = 0; y < H; y += step) {
      const top = Math.max(0, y - overlap);
      const bottom = Math.min(H, y + step + overlap);
      if (slices.length && bottom - y < W * 0.25) break; // adds almost nothing new
      slices.push({ y: top, h: bottom - top });
    }
  }

  const found = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0, estimated: false };
  // Slices are independent requests, so run a few at once. JS is single-threaded,
  // so merging into found/usage below needs no locking.
  let nextSlice = 0;
  const worker = async () => {
    while (nextSlice < slices.length) {
      const n = nextSlice++;
      await doSlice(n, slices[n]);
    }
  };
  async function doSlice(n, s) {
    const png = await sharp(buffer).rotate().extract({ left: 0, top: s.y, width: W, height: s.h }).png().toBuffer();
    // Existing boxes touching this slice, in the slice's 0-1000 [y,x,y,x] space.
    const known = existing && existing
      .filter((b) => b.y + b.h > s.y && b.y < s.y + s.h)
      .map((b) => [
        Math.round(((Math.max(b.y, s.y) - s.y) / s.h) * 1000), Math.round((b.x / W) * 1000),
        Math.round(((Math.min(b.y + b.h, s.y + s.h) - s.y) / s.h) * 1000), Math.round(((b.x + b.w) / W) * 1000),
      ]);
    const { detections, usage: u } = await callOnce(png, W, s.h, {
      provider, apiKey, model, language: opts.language, known, glossary: opts.glossary, withSource: opts.withSource,
    });
    console.log(`[llm] slice ${n + 1}/${slices.length} (y=${s.y}, h=${s.h}): ${detections.length} regions`);
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.cost = usage.cost === null || u.cost == null ? null : usage.cost + u.cost; // null = unknown price
    usage.estimated = usage.estimated || !!u.estimated;
    for (const d of detections) {
      let [y1, x1, y2, x2] = d.box;
      [y1, y2] = [Math.min(y1, y2), Math.max(y1, y2)];
      [x1, x2] = [Math.min(x1, x2), Math.max(x1, x2)];
      const x = Math.round((Math.max(0, x1) / 1000) * W);
      const w = Math.round((Math.min(1000, x2) / 1000) * W) - x;
      const y = s.y + Math.round((Math.max(0, y1) / 1000) * s.h);
      const h = s.y + Math.round((Math.min(1000, y2) / 1000) * s.h) - y;
      if (w < 8 || h < 8) continue;
      // Extra text areas of the same bubble (L-shaped bubbles): to be erased, not written into.
      const erase = (d.parts || []).map(([py1, px1, py2, px2]) => {
        const ex = Math.round((Math.max(0, Math.min(px1, px2)) / 1000) * W);
        const ew = Math.round((Math.min(1000, Math.max(px1, px2)) / 1000) * W) - ex;
        const ey = s.y + Math.round((Math.max(0, Math.min(py1, py2)) / 1000) * s.h);
        const eh = s.y + Math.round((Math.min(1000, Math.max(py1, py2)) / 1000) * s.h) - ey;
        return { x: ex, y: ey, w: ew, h: eh };
      }).filter((r) => r.w >= 8 && r.h >= 8);
      found.push({ x, y, w, h, text: d.text, ...(d.source ? { source: d.source } : {}), ...(erase.length ? { erase } : {}) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(SLICE_CONCURRENCY, slices.length) }, worker));
  // Merge duplicates from overlapping slices, and drop anything already in `existing`.
  const blocks = dedupe(found).filter((b) => !(existing || []).some((e) => overlapRatio(e, b) > 0.5));
  blocks.sort((a, b) => a.y - b.y || a.x - b.x);
  return { width: W, height: H, blocks, usage };
}

/**
 * List the models the provider offers, for the settings dropdown.
 * Gemini: only models that support generateContent (the list also holds
 * embedding/other models). OpenRouter: only models that accept image input.
 * Returns [{ id, label }].
 */
async function listModels(provider, apiKey) {
  if (provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const { data = [] } = await res.json();
    return data
      .filter((m) => (m.architecture?.input_modalities || []).includes('image'))
      .map((m) => {
        const inP = Number(m.pricing?.prompt) * 1e6;
        const outP = Number(m.pricing?.completion) * 1e6;
        const price = Number.isFinite(inP) && Number.isFinite(outP)
          ? (inP === 0 && outP === 0 ? 'ฟรี' : `$${inP.toFixed(2)}/$${outP.toFixed(2)} ต่อ 1M`) : '';
        return { id: m.id, label: price ? `${m.name || m.id} · ${price}` : m.name || m.id };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  if (!apiKey) throw new Error('ใส่ API key ก่อนจึงจะโหลดรายการ model ได้');
  const out = [];
  let pageToken = '';
  do {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    for (const m of data.models || []) {
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id.startsWith('gemini')) continue; // skip gemma/imagen/etc. that can't read manga pages reliably
      out.push({ id, label: `${m.displayName || id}${m.outputTokenLimit ? ` · out ≤ ${m.outputTokenLimit.toLocaleString()}` : ''}` });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { translateImage, translateRegion, listModels };
