# Manga Translator (Node) — context for Claude

Read this first. It was written at the end of the session that built the project, so a
fresh chat can carry on without the old conversation.

## What it is

Find the `<img>` tags of a web page → a vision LLM detects each text region and translates it
to Thai → edit the text online in a browser editor → render new PNGs → swap them back into the
page. Works on a pasted URL/HTML, or through the browser extension on the live page.

Replaces the older Python + screenshot-overlay project (sibling folder `Manga-Translator`,
uses OpenCV inpainting). This repo shares nothing with it.

## Run / test

```bash
npm install
cp .env.example .env      # GEMINI_API_KEY (Google AI Studio) or OPENROUTER_API_KEY; or set it in the web UI (⚙️)
npm start                 # http://127.0.0.1:3000
npm test                  # ~70 checks in real browsers (see Testing)
```

Env vars read: `PORT HOST DATA_DIR GEMINI_API_KEY GEMINI_MODEL OPENROUTER_API_KEY OPENROUTER_MODEL
MAX_OUTPUT_TOKENS TEMPERATURE SLICE_CONCURRENCY MIN_IMAGE_SIDE PRICE_IN_PER_M PRICE_OUT_PER_M`.
Browser settings live in `localStorage["mt-settings"]`: `provider key model lang slice parallel autoApply withSource`.

## Layout

| Path | Role |
|---|---|
| `server.js` | Express API + static files. Per-project write lock (`withLock`), `recordUsage`, zip export, `/view` page rewrite |
| `lib/llm.js` | Providers (Gemini direct, OpenRouter), prompt building, lenient JSON parser, optional slicing + dedupe, `translateImage`, `translateRegion` (one box), retry/backoff, cost estimate, `listModels` |
| `lib/extract.js` | Find `<img>` in HTML (lazy attrs, srcset), `rewriteHtml` for `/view` |
| `lib/zip.js` | Own streaming "stored" ZIP writer (no dependency) |
| `public/app.js` | The whole web UI (home + editor + reader). Sections are commented. Routes: `#/`, `#/p/<id>[/<imageIndex>]` (editor), `#/p/<id>/read` (continuous reader: non-skipped images as one strip, result or original fallback with red outline, width slider + original toggle kept in `mt-settings.reader`) |
| `extension/` | MV3 extension: `background.js` does the work, `popup.*` is a thin UI |
| `test/` | Browser tests (puppeteer-core), `run-all.js` runs them |
| `data/` | Runtime store (git-ignored): `projects/<id>/{project.json, page.html?, orig/<i>, result/<i>.png}` |

Data model (`project.json`): `{ id, sourceUrl, title, createdAt, glossary, usage{requests,prompt_tokens,
completion_tokens,cost,unpriced,estimated}, images[] }`; image = `{ index, url, width, height, status
(new|translated|edited|done), hasResult, skipped, keep, blocks[] }`; block = `{ id, x, y, w, h, text, erase?[{x,y,w,h,bg?}], source?,
fontSize?, color?, bg? }`. **`index` is the position among ALL `<img>` in the DOM**, not among kept images.

`skipped` = irrelevant image (ad/logo), left out of everything. `keep` = "keep original": not translated or swapped,
but still a page in the export (original bytes, wins over any result) and the reader; translating/editing it clears `keep`.

API: `PUT .../images/:i/keep` {keep}, `POST /api/projects` (url | html | extension's `{pageUrl,title,images}`), `GET/DELETE /api/projects[/:id]`,
`PUT .../images/:i/source` (extension uploads bytes the server couldn't fetch), `POST .../translate`
(`sweep`, `slice`, `withSource`), `POST .../retranslate-block`, `PUT .../blocks|skip|result`, `DELETE .../result`,
`PUT /api/projects/:id/glossary`, `GET /api/projects/:id/export?format=zip|cbz&originals=0|1`,
`GET /api/lookup?url=`, `GET /api/projects/:id/replacements`, `GET /api/models`, `GET /view/:id`.

## Decisions and gotchas (the non-obvious bits)

- **LLM contract**: items are `{"box":[ymin,xmin,ymax,xmax] (0-1000), "source"?, "text"}`. `text` MUST stay the
  last field: the lenient parser (for near-valid JSON) takes the last quoted string as the text.
- **Output cap**: Gemini → the model's own `outputTokenLimit` (asked from the API, cached); OpenRouter → none sent.
  `MAX_OUTPUT_TOKENS` forces a value. `temperature` defaults to 0 (+ seed) so the box count doesn't wander.
- **L-shaped / split bubbles**: one block, one translation. `x,y,w,h` is where the Thai text is laid out; `erase[]` are EXTRA
  rectangles that are only painted over (own median colour each). The model may return `"parts":[[ymin,xmin,ymax,xmax],..]`
  (after `box`, before `source`/`text`; `text` stays last) and `lib/llm.js` turns it into `erase`. In the editor the selected
  block shows them as dashed red boxes (drag/resize/✕); button "＋ พื้นที่ลบ" adds one. Whether the real model emits `parts`
  sensibly is UNVERIFIED (never called the real API); the manual editing is the fallback. Region re-translate ignores parts.
- **Slicing is optional, default OFF** (user asked for whole-image requests). When on: slices overlap ~12% and
  are deduped by overlap ratio. Slices run in parallel (`SLICE_CONCURRENCY`, default 3); 429/5xx retry with backoff.
- **Sweep** ("หาข้อความที่ตกหล่น") tells the model which boxes exist and asks only for missed ones.
- **Cost is an ESTIMATE.** Gemini's API returns tokens, not money. `GEMINI_PRICES` in `lib/llm.js` covers only
  `gemini-2.5-flash-lite|flash|pro`; other models (e.g. 3.5) show "ไม่ทราบราคา" until `PRICE_*` is set.
  The prices are from memory and were never checked against ai.google.dev/pricing. Thinking tokens bill as output.
- **Erasing text = flat fill** with the median colour of a 3px ring around the box, not inpainting. Weak on
  patterned backgrounds (biggest known quality gap vs the Python version). Colour must be sampled from a pristine
  canvas of THAT image — an earlier bug sampled the currently open image when rendering others.
- **Auto-apply** (default on): render ~3s after the last edit and when leaving an edited image, so `/view` and the
  extension never see stale results. `busy` blocks it during translate jobs; `dirtyIdx` tracks unrendered images.
- **Extension swaps by URL**, not index. `blob:` images work only in the same page session (URL changes on reload).
  Lazy images are collected from `data-src` first; their 1×1 `src` placeholder must not be used for the size filter
  (that bug dropped every lazy image). Auto-swap on page load is opt-in because it sends every visited URL to the server.
- **Security**: server binds `127.0.0.1` on purpose — it fetches whatever URL a client gives it (SSRF-ish) and has
  no auth. Don't expose it without adding auth.

## Testing

`npm test` drives the real server with the real editor in headless Chrome, and the real extension in Edge. Only the
Gemini endpoint is stubbed (global `fetch` intercepts `generativelanguage`), so no key is needed. Needs Chrome, Edge
and Python (zip verification); override locations with `CHROME_PATH` / `EDGE_PATH`. Branded Chrome 137+ ignores
`--load-extension`, which is why the extension test uses Edge. Ports used: 3077-3082 and 8093-8099.

## Verified vs NOT verified

Verified by the tests above: editor flows (translate, undo/redo, shortcuts, auto-apply, glossary, export zip/cbz
byte-identical + CRC via Python, single-box re-translate sends only a crop, cost confirm), extension send/swap/restore/
auto-swap incl. lazy-load and blob images.

**Never done:** a single call to the real Gemini/OpenRouter API (prompt quality, `source` field, region mode, JSON
compliance, thinking-token behaviour, real 429 limits are all unverified); installing the extension through
`chrome://extensions` in regular Chrome; opening the CBZ in a real reader; touch/mobile use.

## Backlog (ideas the user was offered, none started)

Ellipse/rounded boxes and font choice, eraser brush (to fix leftover text on patterned backgrounds), zoom and
side-by-side compare, list of failed images with retry, rename/clean up projects,
right-click "translate this image" in the extension.

## Repo state

Split from the old `Manga-Translator` repo. One local commit, **no remote yet**, no LICENSE chosen (user's call).
Commit author comes from git config. Only commit/push when asked; ask before creating a GitHub repo.

## Working with the user

- Replies in **Thai**. They care about token usage and cost, and like quality-of-life features.
- Confirm before anything outward-facing (GitHub, publishing). Report test results honestly, including what
  was not run against real services.
- Editing pitfalls seen on this machine: Git Bash heredocs with quotes/backticks failed (use the file tools); a
  script once wrote a literal backspace (U+0008) in place of `\b` inside a regex — if an Edit says "string not
  found" for text that looks identical, grep the file for `\x08`.
