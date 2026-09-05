const $ = (s) => document.querySelector(s);

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function render(books) {
  const list = $('#list');
  if (!books.length) {
    list.innerHTML = '<div class="muted" style="padding:8px">Nothing here yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const b of books) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = `/reader.html?book=${encodeURIComponent(b.slug)}`;
    a.innerHTML = `
      <span class="fmt">${b.format.toUpperCase()}</span>
      <span class="grow">
        <div class="t"></div>
        <div class="s"></div>
      </span>
      <button class="ghost del" title="Remove from library">✕</button>`;
    a.querySelector('.t').textContent = b.title;
    a.querySelector('.s').textContent =
      [b.author, `${b.unitCount} ${b.unitName}s`, `library/${b.slug}/`].filter(Boolean).join(' · ');
    a.querySelector('.del').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(`Remove "${b.title}" from the library?\n\nlibrary/${b.slug}/ (marks and notes included) will be deleted.`)) return;
      await api(`/api/books/${b.slug}`, { method: 'DELETE' });
      load();
    });
    list.appendChild(a);
  }
}

async function load() {
  render(await api('/api/books'));
}

$('#add').addEventListener('click', async () => {
  const p = $('#path').value.trim();
  if (!p) return;
  toast('Extracting text…');
  try {
    const m = await api('/api/books/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    $('#path').value = '';
    toast(`Added ${m.title}`);
    load();
  } catch (e) {
    toast(e.message, 4000);
  }
});

$('#path').addEventListener('keydown', (e) => e.key === 'Enter' && $('#add').click());

$('#scan').addEventListener('click', async () => {
  toast('Scanning books/ …');
  const added = await api('/api/books/scan', { method: 'POST' });
  toast(added.length ? `Added ${added.length}` : 'Nothing new in books/');
  load();
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  })
);
drop.addEventListener('drop', async (e) => {
  for (const file of e.dataTransfer.files) {
    if (!/\.(pdf|epub)$/i.test(file.name)) {
      toast(`${file.name}: only .pdf and .epub`, 3500);
      continue;
    }
    toast(`Uploading ${file.name}…`, 60000);
    try {
      const m = await api(`/api/books/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      toast(`Added ${m.title}`);
      load();
    } catch (err) {
      toast(err.message, 4000);
    }
  }
});

load();
