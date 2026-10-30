const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'http://127.0.0.1:3000';

function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = cls;
}

chrome.storage.local.get('serverUrl', ({ serverUrl }) => {
  $('server').value = serverUrl || DEFAULT_SERVER;
});

chrome.storage.local.get('autoSwap', ({ autoSwap }) => { $('auto').checked = !!autoSwap; });
$('auto').addEventListener('change', () => chrome.storage.local.set({ autoSwap: $('auto').checked }));

$('server').addEventListener('change', () => {
  chrome.storage.local.set({ serverUrl: $('server').value.trim().replace(/\/+$/, '') });
});

async function run(action, busy, done) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({ serverUrl: $('server').value.trim().replace(/\/+$/, '') });
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  status(busy);
  try {
    const r = await chrome.runtime.sendMessage({ action, tabId: tab.id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'ไม่มีการตอบกลับจาก background');
    status(done(r), 'ok');
  } catch (e) {
    status(`❌ ${e.message}\n(เช็กว่า server รันอยู่ที่ ${$('server').value})`, 'err');
  } finally {
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

$('send').onclick = () => run('SEND', 'กำลังส่งรูป… อย่าปิดหน้านี้', (r) => `ส่ง ${r.count} รูปแล้ว — เปิดหน้าแก้ไขในแท็บใหม่`);
$('swap').onclick = () => run('SWAP', 'กำลังสลับรูป…', (r) => `สลับแล้ว ${r.swapped} รูป (มีรูปแปลแล้ว ${r.available})`);
$('restore').onclick = () => run('RESTORE', 'กำลังคืนรูป…', (r) => `คืนรูปเดิม ${r.restored} รูป`);
