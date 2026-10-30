// Page numbers / lone symbols are dropped, the prompt says so, titles are optional.
// No browser, no network: lib/llm.js against a stubbed Gemini endpoint.
const NODE = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); // repo root
const sharp = require(NODE + '/node_modules/sharp');

const realFetch = global.fetch;
const prompts = [];
let reply = '[]';
global.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage')) return realFetch(url, init);
  if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ outputTokenLimit: 65536 }) };
  prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: reply }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) };
};
const { isNoise, translateImage } = require(NODE + '/lib/llm.js');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
  const n = (source, text) => isNoise({ source, text });
  check('page number "28" is noise', n('28', '28'));
  check('lone symbols are noise', n('!?', '!?') && n('…', '...') && n('♪', '♪'));
  check('unchanged text is noise', n('SOS', 'SOS'));
  check('real text is kept', !n('BUT TO GET BACK ON TOPIC.', 'แต่เข้าเรื่องกันก่อนเถอะ') && !n('ドン', 'ตูม'));
  check('without source: digits only is noise, Thai text is kept', n('', '28') && !n('', 'สวัสดี'));
  check('without source: "55555" (Thai laughing) is kept', !n('', '55555'));
  check('source "www" (laughing) is kept even though text is digits', !n('www', '55555'));

  const img = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
  reply = JSON.stringify([
    { box: [100, 100, 200, 600], source: 'HELLO', text: 'สวัสดี' },
    { box: [900, 900, 990, 990], source: '28', text: '28' },
    { box: [300, 300, 360, 400], source: '!?', text: '!?' },
  ]);
  const out = await translateImage(img, { provider: 'gemini', apiKey: 'stub' });
  check('translateImage keeps only the real box and reports 2 dropped', out.blocks.length === 1 && out.blocks[0].text === 'สวัสดี' && out.dropped === 2, `${out.blocks.length} kept, dropped=${out.dropped}`);
  check('prompt always asks to leave out page numbers / watermarks', /page numbers/.test(prompts[0]) && /watermarks/.test(prompts[0]));
  check('titles are NOT excluded by default', !/title-card/.test(prompts[0]));
  await translateImage(img, { provider: 'gemini', apiKey: 'stub', skipTitles: true });
  check('skipTitles adds the title rule to the prompt', /title-card/.test(prompts[1]));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
