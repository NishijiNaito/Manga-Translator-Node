'use strict';
const form = document.getElementById('f');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go');
  const err = document.getElementById('err');
  go.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: document.getElementById('secret').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
    go.disabled = false;
  }
});
