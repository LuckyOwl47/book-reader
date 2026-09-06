'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const SLUG = new URLSearchParams(location.search).get('book');
// how many of the reader's most recent marks the 'recent marks' toggle sends
const RECENT_MARKS = 4;

const state = {
  book: null,
  marks: [],
  threads: [],
  history: [],         // units jumped away from, newest last
  thread: null,        // the open chat thread (full object)
  engine: null,
  pending: [],         // blocks staged for the next message
  includePage: true,
  nearby: localStorage.getItem('nearby') === '1',   // also send the pages either side
  recent: localStorage.getItem('recent') === '1',   // also send the last few marks
  brief: localStorage.getItem('brief') === '1',
  streaming: false,
  agentAvailable: false,
  models: [],          // [{id, label, provider, vision, available}] from /api/agent/status
  model: localStorage.getItem('model') || '',
  selection: null,     // {text, unit, cfi} | {clipId, dataUrl, unit, nearby}
};

// ------------------------------------------------------------ plumbing

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const jpost = (url, data, method = 'POST') =>
  api(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Small markdown renderer. Input is our own model output, not the open web.
 *
 * Maths and code are lifted into placeholders before the markdown pipeline runs and put
 * back afterwards untouched. Without that, `x_1 + y_2` becomes italics and `\frac` loses
 * its backslash — the renderer would quietly corrupt every formula it touched.
 */
function md(src) {
  const slots = [];
  const hold = (raw, kind) => {
    slots.push({ raw, kind });
    return '@@SLOT' + (slots.length - 1) + '@@';
  };

  const source = String(src || '')
    .replace(/```[\s\S]*?```/g, (m) => hold(m, 'fence'))
    .replace(/`[^`\n]+`/g, (m) => hold(m, 'code'))
    .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\)/g, (m) => hold(m, 'math'));

  const lines = esc(source).split('\n');
  let out = '';
  let list = null;
  const closeList = () => {
    if (list) out += '</' + list + '>';
    list = null;
  };

  for (const line of lines) {
    const inline = (t) =>
      t
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out += '<' + want + '>';
        list = want;
      }
      out += '<li>' + inline((ul || ol)[1]) + '</li>';
      continue;
    }
    closeList();
    if (/^\s*(---+|___+)\s*$/.test(line)) out += '<hr>';
    else if (/^#{1,6}\s/.test(line)) out += '<h3>' + inline(line.replace(/^#+\s/, '')) + '</h3>';
    else if (/^>\s?/.test(line)) out += '<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>';
    else if (line.trim()) out += '<p>' + inline(line) + '</p>';
  }
  closeList();

  return out
    .replace(/@@SLOT(\d+)@@/g, (_, i) => {
      const s = slots[Number(i)];
      if (!s) return '';
      if (s.kind === 'math') return esc(s.raw); // KaTeX reads it back out of the text node
      if (s.kind === 'code') return '<code>' + esc(s.raw.slice(1, -1)) + '</code>';
      const body = s.raw.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
      return '<pre><code>' + esc(body) + '</code></pre>';
    })
    .replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, '$1');
}

/**
 * Turn "p.70" / "§3" inside a reply into something the reader can click.
 * Walks text nodes rather than regexing the HTML, so it can't corrupt an attribute or
 * reach inside code, links or rendered maths.
 */
function linkifyRefs(el) {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && n.parentElement.closest('a, code, pre, .katex')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (/(?:\bp\.\s?\d+|§\s?\d+)/.test(node.nodeValue)) targets.push(node);
  }
  const total = state.book ? state.book.unitCount : 0;
  for (const n of targets) {
    const frag = document.createDocumentFragment();
    const re = /(\bp\.\s?(\d+)|§\s?(\d+))/g;
    let last = 0;
    let m;
    while ((m = re.exec(n.nodeValue))) {
      const unit = Number(m[2] || m[3]);
      if (!unit || unit > total) continue; // a stray number is not a page
      frag.append(n.nodeValue.slice(last, m.index));
      const a = document.createElement('a');
      a.className = 'jump';
      a.dataset.unit = unit;
      a.textContent = m[0];
      a.title = 'Go to ' + unitLabel(unit);
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (!last) continue;
    frag.append(n.nodeValue.slice(last));
    n.parentNode.replaceChild(frag, n);
  }
}

/** Typeset any maths inside an element that already holds rendered markdown. */
function renderMath(el) {
  if (!el || typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch {}
}

function unitLabel(u) {
  if (!state.book) return String(u);
  if (state.book.format === 'pdf') return `p.${u}`;
  const e = (state.book.units || []).find((x) => x.index === u);
  return e && e.chapter ? `§${u} · ${e.chapter}` : `section ${u}`;
}

function modal({ title, quote, image, value = '', placeholder = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    const box = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-quote').textContent = quote || '';
    $('#modal-quote').style.display = quote ? '' : 'none';
    const img = $('#modal-img');
    img.hidden = !image;
    if (image) img.src = image;
    const input = $('#modal-input');
    input.value = value;
    input.placeholder = placeholder;
    $('#modal-ok').textContent = ok;
    box.classList.add('on');
    setTimeout(() => input.focus(), 20);
    const done = (v) => {
      box.classList.remove('on');
      $('#modal-ok').onclick = $('#modal-cancel').onclick = input.onkeydown = null;
      resolve(v);
    };
    $('#modal-ok').onclick = () => done(input.value.trim());
    $('#modal-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done(input.value.trim());
    };
  });
}

// ------------------------------------------------------------ PDF engine

// ------------------------------------------------------------ view settings

const PAGE_GAP = 16;

/** How the document is laid out. Both persist; `spread: auto` fits pages to the width. */
const view = {
  flow: localStorage.getItem('flow') || 'paged', // 'paged' | 'scroll'
  spread: localStorage.getItem('spread') || 'auto', // 'auto' | 'single' | 'double'
  zoom: Number(localStorage.getItem('zoom')) || 1, // multiplier on top of fit-to-width
  theme: localStorage.getItem('theme') || 'paper', // 'paper' | 'dark'
};

/** What the page itself is painted in. pdf.js maps the PDF's own colours onto these. */
const PAGE_COLORS = {
  paper: { background: '#ffffff', foreground: '#111111' },
  dark: { background: '#1b1e24', foreground: '#dfe3ea' },
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];

/** `auto` becomes double only when two pages still leave each one readable. */
function resolvedSpread(naturalWidth) {
  if (view.spread !== 'auto') return view.spread;
  const avail = $('#stage').clientWidth - 44;
  return avail / 2 >= Math.min(420, (naturalWidth || 612) * 0.72) ? 'double' : 'single';
}

// ------------------------------------------------------------ PDF engine

class PdfEngine {
  constructor() {
    this.unit = 1;
    this.gen = 0; // bumped on every layout, so in-flight renders know they are stale
    this.queue = [];
  }

  async init() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.js';
    this.doc = await pdfjsLib.getDocument(`/api/books/${SLUG}/file`).promise;
    this.count = this.doc.numPages;

    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.natural = { w: vp.width, h: vp.height };
    first.cleanup();

    $('#pdf-stage').hidden = false;
    this.root = $('#pdf-doc');
    this.root.addEventListener('mouseup', () => setTimeout(() => this.readSelection(), 0));
    $('#stage').addEventListener('scroll', () => this.onScroll(), { passive: true });
    // Watch the stage itself rather than the window: the rail, the chat panel and the
    // split/popup switch all change the space available without a window resize.
    this._ro = new ResizeObserver(() => {
      const w = $('#stage').clientWidth;
      if (!w) return;
      if (!this.pending && Math.abs(w - (this.lastWidth || 0)) < 5) return;
      clearTimeout(this._rz);
      this._rz = setTimeout(() => this.layout(this.unit), 120);
    });
    this._ro.observe($('#stage'));
  }

  // ---- geometry

  buildRows() {
    const rows = [];
    if (this.spread === 'double') {
      // page 1 alone, then pairs — matches how the printed book falls open
      rows.push([1]);
      for (let i = 2; i <= this.count; i += 2) rows.push([i, i + 1].filter((n) => n <= this.count));
    } else {
      for (let i = 1; i <= this.count; i++) rows.push([i]);
    }
    this.rows = rows;
    this.rowOf = new Map();
    rows.forEach((pages, i) => pages.forEach((p) => this.rowOf.set(p, i)));
  }

  measure() {
    this.spread = resolvedSpread(this.natural.w);
    // A stage with no width yet (still laying out, or a background tab) would otherwise
    // pin the page at the minimum scale and leave it there.
    const width = $('#stage').clientWidth || this.lastWidth || 0;
    if (!width) {
      this.pending = true; // the ResizeObserver will call us back with a real width
      return false;
    }
    this.lastWidth = width;
    this.pending = false;
    const avail = width - 44;
    const per = this.spread === 'double' ? (avail - PAGE_GAP) / 2 : avail;
    // fit to the width available, then apply the reader's zoom on top of that
    const fit = Math.min(2.4, Math.max(0.3, per / this.natural.w));
    this.scale = Math.min(8, Math.max(0.12, fit * view.zoom));
    this.pageW = Math.floor(this.natural.w * this.scale);
    this.pageH = Math.floor(this.natural.h * this.scale);
    return true;
  }

  // ---- layout

  async layout(focus) {
    const want = focus || this.unit;
    if (!this.measure()) {
      this.unit = want; // remember where we were headed for when the width arrives
      return;
    }
    this.buildRows();
    this.gen++;
    this.queue.length = 0;
    this.root.dataset.flow = view.flow;
    this.root.replaceChildren();

    const rows = view.flow === 'scroll' ? this.rows : [this.rows[this.rowOf.get(want) ?? 0]];
    for (const pages of rows) this.root.appendChild(this.makeRow(pages));

    // announce the destination before rendering it — waiting for the canvas leaves the
    // page box and the chapter label showing where the reader just left
    this.setUnit(want);

    if (view.flow === 'scroll') {
      const el = this.root.querySelector(`.prow[data-first="${this.rows[this.rowOf.get(want) ?? 0][0]}"]`);
      if (el) $('#stage').scrollTop = el.offsetTop - 12;
      this.renderVisible();
    } else {
      $('#stage').scrollTop = 0;
      await Promise.all([...this.root.querySelectorAll('.ppage')].map((el) => this.renderPage(el)));
    }
  }

  makeRow(pages) {
    const row = document.createElement('div');
    row.className = 'prow';
    row.dataset.first = pages[0];
    row.style.minHeight = this.pageH + 'px';
    for (const n of pages) {
      const el = document.createElement('div');
      el.className = 'ppage';
      el.dataset.page = n;
      el.style.width = this.pageW + 'px';
      el.style.height = this.pageH + 'px';
      row.appendChild(el);
    }
    return row;
  }

  // ---- rendering one page

  async renderPage(el) {
    const n = Number(el.dataset.page);
    if (el.dataset.state) return; // already 'busy' or 'ready'
    el.dataset.state = 'busy';

    const gen = this.gen;
    // A re-layout while this is in flight makes it stale. Always clear the busy flag
    // when bailing, or the page can never be rendered again.
    const stale = () => gen !== this.gen || !el.isConnected;
    const bail = (page) => {
      if (page) page.cleanup();
      delete el.dataset.state;
    };

    let page;
    try {
      page = await this.doc.getPage(n);
      if (stale()) return bail(page);

      const vp = page.getViewport({ scale: this.scale });
      const dpr = window.devicePixelRatio || 1;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';

      const layer = document.createElement('div');
      layer.className = 'textLayer';
      layer.style.width = Math.floor(vp.width) + 'px';
      layer.style.height = Math.floor(vp.height) + 'px';
      layer.style.setProperty('--scale-factor', this.scale);

      // pages can differ in size; trust the page over the estimate
      el.style.width = Math.floor(vp.width) + 'px';
      el.style.height = Math.floor(vp.height) + 'px';
      el.replaceChildren(canvas, layer);

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        // pdf.js remaps the page's own colours rather than inverting it, so diagrams
        // and photographs stay readable instead of turning into negatives
        pageColors: view.theme === 'dark' ? PAGE_COLORS.dark : null,
      }).promise;
      if (stale()) return bail(page);

      await pdfjsLib.renderTextLayer({
        textContentSource: await page.getTextContent(),
        container: layer,
        viewport: vp,
        textDivs: [],
      }).promise;

      page.cleanup();
      el.dataset.state = 'ready';
      this.paintPage(el);
    } catch (err) {
      bail(page);
    }
  }

  releasePage(el) {
    if (el.dataset.state !== 'ready') return;
    el.replaceChildren();
    delete el.dataset.state;
  }

  // ---- scrolling

  onScroll() {
    if (view.flow !== 'scroll') return;
    clearTimeout(this._sc);
    this._sc = setTimeout(() => {
      this.renderVisible();
      const top = $('#stage').scrollTop;
      let current = this.unit;
      for (const row of this.root.children) {
        if (row.offsetTop <= top + 80) current = Number(row.dataset.first);
        else break;
      }
      if (current !== this.unit) this.setUnit(current);
    }, 60);
  }

  /**
   * Render what's on screen plus a screen either side; drop the rest.
   * Reads every row's geometry first, then writes — interleaving them would force
   * one reflow per row, and a textbook has hundreds.
   */
  renderVisible() {
    const stage = $('#stage');
    const top = stage.scrollTop - stage.clientHeight;
    const bottom = stage.scrollTop + stage.clientHeight * 2;
    const plan = [];
    for (const row of this.root.children) {
      plan.push([row, row.offsetTop + row.offsetHeight > top && row.offsetTop < bottom]);
    }
    for (const [row, visible] of plan) {
      for (const el of row.children) {
        if (visible) this.enqueue(el);
        else this.releasePage(el);
      }
    }
  }

  /**
   * Render one page at a time. Firing every visible page at once makes a dense
   * textbook stutter — pdf.js has a single worker and they all queue behind each other
   * anyway, but the canvases land in a lump at the end instead of top-down.
   */
  enqueue(el) {
    if (el.dataset.state || this.queue.includes(el)) return;
    this.queue.push(el);
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const el = this.queue.shift();
        if (el.isConnected && !el.dataset.state) await this.renderPage(el);
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- navigation

  setUnit(unit) {
    this.unit = unit;
    onUnitChanged(unit);
  }

  async show(unit) {
    unit = Math.min(Math.max(1, unit), this.count);
    if (view.flow === 'scroll') {
      if (!this.root.children.length) return this.layout(unit);
      const first = this.rows[this.rowOf.get(unit)][0];
      const el = this.root.querySelector(`.prow[data-first="${first}"]`);
      if (el) $('#stage').scrollTop = el.offsetTop - 12;
      this.renderVisible();
      this.setUnit(unit);
    } else {
      await this.layout(unit);
    }
  }

  step(delta) {
    const row = this.rowOf.get(this.unit) ?? 0;
    const next = this.rows[Math.min(Math.max(0, row + delta), this.rows.length - 1)];
    if (next) this.show(next[0]);
  }

  setView() { return this.layout(this.unit); }
  setZoom() { return this.layout(this.unit); }
  setTheme() { return this.layout(this.unit); }
  relayout() { return this.layout(this.unit); }

  jump(u) { this.show(u); }
  next() { this.step(1); }
  prev() { this.step(-1); }
  current() { return this.unit; }
  canCapture() { return true; }

  // ---- selection, marks, capture

  pageElAt(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest('.ppage') : null;
  }

  readSelection() {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    if (!text) return;
    const el = this.pageElAt(sel.anchorNode);
    if (!el) return;
    state.selection = { text, unit: Number(el.dataset.page), cfi: null };
  }

  paint() {
    for (const el of this.root.querySelectorAll('.ppage[data-state="ready"]')) this.paintPage(el);
  }

  paintPage(el) {
    el.querySelectorAll('.mark-box, .region-box').forEach((n) => n.remove());
    // where each mark landed, page-relative — hit-tested on mousemove rather than made
    // clickable, so that selecting text inside a highlight still works
    el._marks = [];
    const unit = Number(el.dataset.page);
    const layer = el.querySelector('.textLayer');
    if (!layer) return;
    const base = el.getBoundingClientRect();
    const fills = {
      purple: 'rgba(200,150,255,.5)',
      green: 'rgba(150,220,110,.5)',
      blue: 'rgba(120,175,255,.5)',
      yellow: 'rgba(240,190,90,.55)',
    };
    for (const m of state.marks.filter((x) => x.unit === unit && x.source !== 'chat')) {
      if (m.type === 'region' && m.rect) {
        const box = document.createElement('div');
        box.className = 'region-box';
        box.style.cssText = `left:${m.rect.x * this.scale}px;top:${m.rect.y * this.scale}px;width:${m.rect.w * this.scale}px;height:${m.rect.h * this.scale}px;border-color:var(--${m.color || 'purple'})`;
        el.appendChild(box);
        el._marks.push({
          id: m.id,
          boxes: [[m.rect.x * this.scale, m.rect.y * this.scale, m.rect.w * this.scale, m.rect.h * this.scale]],
        });
        continue;
      }
      const range = findRange(layer, m.text);
      if (!range) continue;
      const boxes = [];
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const box = document.createElement('div');
        box.className = 'mark-box';
        const x = rect.left - base.left;
        const y = rect.top - base.top;
        box.style.cssText = `left:${x}px;top:${y}px;width:${rect.width}px;height:${rect.height}px;background:${fills[m.color] || fills.yellow}`;
        el.appendChild(box);
        boxes.push([x, y, rect.width, rect.height]);
      }
      if (boxes.length) el._marks.push({ id: m.id, boxes });
    }
  }

  /**
   * Every mark under this point, most specific first. Marks overlap — a long passage can
   * enclose a short one — so the caller has to choose, and the smallest box is the one
   * the reader is most plausibly pointing at.
   */
  marksAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const page = el && el.closest ? el.closest('.ppage') : null;
    if (!page || !page._marks) return [];
    const r = page.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    return page._marks
      .map((m) => {
        const box = m.boxes.find((b) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]);
        if (!box) return null;
        const area = m.boxes.reduce((sum, b) => sum + b[2] * b[3], 0);
        return { id: m.id, area };
      })
      .filter(Boolean)
      .sort((a, b) => a.area - b.area)
      .map((h) => h.id);
  }

  /** Crop whichever page the box was drawn over, plus the text sitting inside it. */
  async capture(clientRect) {
    let best = null;
    let bestArea = 0;
    for (const el of this.root.querySelectorAll('.ppage[data-state="ready"]')) {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, clientRect.right) - Math.max(r.left, clientRect.left);
      const h = Math.min(r.bottom, clientRect.bottom) - Math.max(r.top, clientRect.top);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    if (!best) return null;

    const canvas = best.querySelector('canvas');
    const layer = best.querySelector('.textLayer');
    const cr = canvas.getBoundingClientRect();
    const sx = canvas.width / cr.width;
    const x = Math.max(0, clientRect.left - cr.left);
    const y = Math.max(0, clientRect.top - cr.top);
    const w = Math.min(clientRect.right - cr.left, cr.width) - x;
    const h = Math.min(clientRect.bottom - cr.top, cr.height) - y;
    if (w < 8 || h < 8) return null;

    const out = document.createElement('canvas');
    out.width = Math.round(w * sx);
    out.height = Math.round(h * sx);
    const ctx = out.getContext('2d');
    ctx.fillStyle = PAGE_COLORS[view.theme] ? PAGE_COLORS[view.theme].background : '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, x * sx, y * sx, w * sx, h * sx, 0, 0, out.width, out.height);

    const nearby = [...layer.children]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > clientRect.left && r.left < clientRect.right && r.bottom > clientRect.top && r.top < clientRect.bottom;
      })
      .map((e) => e.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    return {
      blob,
      dataUrl: out.toDataURL('image/png'),
      nearby,
      unit: Number(best.dataset.page),
      rect: { x: x / this.scale, y: y / this.scale, w: w / this.scale, h: h / this.scale },
    };
  }
}


/**
 * Locate `needle` among a container's text nodes, ignoring whitespace entirely.
 * pdf.js splits a line into many absolutely-positioned spans, and where the breaks
 * fall differs between the extracted text, the selection string, and the DOM — so any
 * comparison that preserves whitespace misses. Matching on non-space characters only,
 * with each one mapped back to its node and offset, is what actually holds up.
 */
function findRange(container, needle) {
  const want = (needle || '').replace(/\s+/g, '').toLowerCase();
  if (!want) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let flat = '';
  const pos = []; // pos[i] is where flat[i] lives
  let node;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      flat += t[i].toLowerCase();
      pos.push({ node, offset: i });
    }
  }

  const at = flat.indexOf(want);
  if (at === -1) return null;
  const start = pos[at];
  const end = pos[at + want.length - 1];
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
  } catch {
    return null;
  }
  return range;
}

// ------------------------------------------------------------ EPUB engine

class EpubEngine {
  constructor() {
    this.unit = 1;
    this._painted = new Set();
  }

  async init() {
    $('#epub-stage').hidden = false;
    // epub.js guesses archive-vs-unpacked from the URL extension; ours has none
    const buf = await (await fetch(`/api/books/${SLUG}/file`)).arrayBuffer();
    this.ebook = ePub(buf);
    this.rendition = this.ebook.renderTo(document.getElementById('epub-stage'), {
      width: '100%',
      height: '100%',
      flow: view.flow === 'scroll' ? 'scrolled-doc' : 'paginated',
      spread: view.spread === 'single' ? 'none' : 'auto',
      minSpreadWidth: view.spread === 'double' ? 0 : 800,
      allowScriptedContent: false,
    });
    this.applyTheme();

    await this.ebook.ready;
    if (view.zoom !== 1) this.rendition.themes.fontSize(Math.round(view.zoom * 100) + '%');
    await this.rendition.display();

    this.rendition.on('selected', async (cfiRange) => {
      let text = '';
      try {
        text = (await this.ebook.getRange(cfiRange)).toString().trim();
      } catch {}
      if (text) state.selection = { text, unit: this.current(), cfi: cfiRange };
    });

    this.rendition.on('relocated', (loc) => {
      this.unit = (loc.start.index || 0) + 1;
      onUnitChanged(this.unit);
    });

    this.rendition.on('rendered', (section, view) => {
      this.paint();
      const doc = view && view.document;
      if (!doc) return;
      doc.addEventListener('contextmenu', (e) => {
        const frame = doc.defaultView.frameElement.getBoundingClientRect();
        e.preventDefault();
        openMenu(frame.left + e.clientX, frame.top + e.clientY);
      });
      doc.addEventListener('keydown', (e) => {
        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) onKey(e);
      });
    });
  }

  current() {
    const loc = this.rendition.currentLocation();
    return (loc && loc.start ? loc.start.index : 0) + 1;
  }

  paint() {
    const fills = { purple: '#bb9af7', green: '#9ece6a', blue: '#7aa2f7', yellow: '#e0af68' };
    for (const m of state.marks) {
      if (!m.cfi || m.source === 'chat' || this._painted.has(m.id)) continue;
      try {
        this.rendition.annotations.highlight(m.cfi, {}, () => {
          const chats = chatsForMark(m);
          if (chats.length) {
            openThread(chats[0].id);
            showAgent();
          } else jumpToMark(m);
        }, 'hl', {
          fill: fills[m.color] || fills.yellow,
          'fill-opacity': '0.45',
        });
        this._painted.add(m.id);
      } catch {}
    }
  }

  repaint() {
    for (const id of [...this._painted]) {
      if (!state.marks.some((m) => m.id === id)) this._painted.delete(id);
    }
    this.paint();
  }

  setView() {
    this.rendition.flow(view.flow === 'scroll' ? 'scrolled-doc' : 'paginated');
    this.rendition.spread(view.spread === 'single' ? 'none' : 'auto', view.spread === 'double' ? 0 : 800);
  }
  applyTheme() {
    const dark = view.theme === 'dark';
    this.rendition.themes.default({
      body: {
        background: dark ? '#1b1e24' : '#f6f3ea',
        color: dark ? '#dfe3ea' : '#22242a',
        'font-size': '1.05em',
        'line-height': '1.65',
        padding: '0 6px',
      },
      a: { color: dark ? '#8fb3ff' : '#2a5db0' },
      // an EPUB's own figures are usually drawn for a white page
      img: dark ? { filter: 'brightness(.85) contrast(1.05)' } : { filter: 'none' },
      '::selection': { background: 'rgba(122,162,247,.4)' },
    });
  }

  setTheme() {
    this.applyTheme();
  }

  setZoom() {
    // reflowable text has no fixed page to scale, so zoom is type size
    this.rendition.themes.fontSize(Math.round(view.zoom * 100) + '%');
  }
  relayout() {}

  jump(u) {
    const item = this.ebook.spine.get(u - 1);
    if (item) this.rendition.display(item.href);
  }
  jumpCfi(cfi) { this.rendition.display(cfi); }
  next() { this.rendition.next(); }
  prev() { this.rendition.prev(); }
  canCapture() { return false; }
}

// ------------------------------------------------------------ context menu

const MENU_ITEMS = [
  { act: 'context', label: 'Add to context', dot: 'context', key: 'p' },
  { act: 'keep', label: 'Save markdown', dot: 'keep', key: 'h' },
  { act: 'chat', label: 'Start side chat', dot: 'chat', key: 'c' },
  { act: 'define', label: 'Define', dot: null, key: 'd', textOnly: true },
  { act: 'related', label: 'Find related passages', dot: null, key: 'f' },
  { act: 'comment', label: 'Comment…', dot: null, key: 'v' },
  { act: 'google', label: 'Search Google', dot: null, key: 'g', textOnly: true },
];

const SEARCH_URL = 'https://www.google.com/search?q=';

/**
 * Tidy a selection into a search query. PDF text carries the book's line-break
 * hyphenation — "pen-\ndulum" — which would otherwise be searched literally.
 */
function searchQuery(text) {
  return String(text || '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function openMenu(x, y) {
  const sel = state.selection;
  if (!sel) return;
  const menu = $('#menu');
  const excerpt = (sel.text || '').replace(/\s+/g, ' ');
  const head = sel.clipId
    ? 'Region capture'
    : (sel.source === 'chat' ? 'From the reply: ' : '') + excerpt.slice(0, 56) + (excerpt.length > 56 ? '…' : '');
  menu.innerHTML =
    `<div class="head">${esc(head)}</div>` +
    MENU_ITEMS.map(
      (i) =>
        `<button class="item" data-act="${i.act}"${i.textOnly && sel.clipId ? ' disabled' : ''}>` +
        (i.dot ? `<span class="dot ${i.dot}"></span>` : '<span class="dot" style="background:transparent"></span>') +
        `${i.label}<span class="k">${i.key}</span></button>`
    ).join('') +
    '<div class="sep"></div>' +
    '<button class="item" data-act="attach"><span class="dot" style="background:transparent"></span>Attach to current chat</button>' +
    (sel.clipId ? '' : '<button class="item" data-act="copy"><span class="dot" style="background:transparent"></span>Copy</button>');

  menu.classList.add('on');
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  menu.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h) : y) + 'px';
}

function closeMenu() {
  $('#menu').classList.remove('on');
  delete $('#menu').dataset.pins;
  delete $('#menu').dataset.chat;
}

$('#menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('.item');
  if (!btn || btn.disabled) return;
  if (btn.dataset.chat) {
    const id = $('#menu').dataset.chat;
    const t = state.threads.find((x) => x.id === id);
    closeMenu();
    if (!t) return;
    if (btn.dataset.chat === 'open') return openThread(t.id).then(showAgent);
    if (btn.dataset.chat === 'jump') {
      const m = state.marks.find((x) => x.id === (t.anchors || [])[0]);
      return m ? jumpToMark(m) : toast('That passage is gone');
    }
    if (btn.dataset.chat === 'keep') return deleteThread(t, { keep: true });
    return deleteThread(t);
  }
  if (btn.dataset.pin) {
    closeMenu();
    const pins = visiblePins();
    if (btn.dataset.pin === '*') {
      const muted = !pins.every((m) => isMuted(m));
      for (const m of pins) await mutePin(m, muted);
    } else {
      const m = pins.find((x) => x.id === btn.dataset.pin);
      if (m) await mutePin(m, !isMuted(m));
    }
    return;
  }
  closeMenu();
  runAction(btn.dataset.act);
});

$('#stage').addEventListener('contextmenu', (e) => {
  if (!state.selection) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY);
});

/** Text selected inside a reply is markable too — it just isn't the book's text. */
function readChatSelection() {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  if (!text) return false;
  const anchor = sel.anchorNode;
  const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
  if (!el || !el.closest('#thread')) return false;
  state.selection = {
    text,
    unit: (state.thread && state.thread.unit) || state.engine.current(),
    cfi: null,
    source: 'chat',
  };
  return true;
}

$('#thread').addEventListener('mouseup', () => setTimeout(readChatSelection, 0));
$('#thread').addEventListener('contextmenu', (e) => {
  if (!readChatSelection()) return; // no selection: leave the browser's own menu alone
  e.preventDefault();
  openMenu(e.clientX, e.clientY);
});

let menuWasPinMenu = false;
document.addEventListener('mousedown', (e) => {
  menuWasPinMenu = $('#menu').classList.contains('on') && $('#menu').dataset.pins === '1' && !!e.target.closest('.pin-chip');
  if (!e.target.closest('#menu')) closeMenu();
  if (!e.target.closest('#define')) $('#define').classList.remove('on');
});

// ------------------------------------------------------------ actions

async function runAction(act) {
  const sel = state.selection;
  if (!sel) return;

  // must stay before any await: window.open outside a user gesture gets blocked
  if (act === 'google') {
    const q = searchQuery(sel.text);
    if (!q) return;
    window.open(SEARCH_URL + encodeURIComponent(q), '_blank', 'noopener,noreferrer');
    clearSelection();
    return;
  }
  if (act === 'copy') {
    navigator.clipboard.writeText(`"${sel.text}" — ${state.book.title}, ${unitLabel(sel.unit)}`);
    return toast('Copied');
  }
  if (act === 'define') return defineTerm(sel);
  if (act === 'comment') {
    // comment on the mark already under the selection, or make one to hang it on
    let mark = state.marks.find((m) => normText(m.text) === normText(sel.text) && m.unit === sel.unit);
    const text = await modal({
      title: 'Comment' + (mark ? ' · ' + unitLabel(mark.unit) : ''),
      quote: sel.text,
      placeholder: 'What do you want to remember about this?',
      ok: 'Save comment',
    });
    if (text === null || !text) return;
    if (!mark) mark = await createMark(sel, 'plain');
    Object.assign(mark, await jpost(`/api/books/${SLUG}/marks/${mark.id}/comments`, { text }));
    renderRail();
    repaintMarks();
    clearSelection();
    return toast('Comment saved');
  }
  if (act === 'related') {
    stage(sel);
    if (!state.thread) state.thread = await jpost(`/api/books/${SLUG}/chats`, { unit: sel.unit });
    showAgent();
    return send({
      text: 'Where else in this book does this come up, and does any of it answer what I am asking here?',
      navigate: true,
    });
  }
  if (act === 'attach') {
    stage(sel);
    return;
  }

  const mark = await createMark(sel, act);
  if (act === 'chat') {
    const thread = await jpost(`/api/books/${SLUG}/chats`, {
      anchors: [mark.id],
      unit: sel.unit,
      title: 'New chat',
    });
    await openThread(thread.id);
    stage(sel);
    showAgent();
    $('#ask').focus();
  } else {
    toast(act === 'context' ? 'Pinned to context' : 'Saved to highlights.md');
  }
}

async function createMark(sel, kind) {
  const mark = await jpost(`/api/books/${SLUG}/marks`, {
    kind,
    unit: sel.unit,
    text: sel.clipId ? sel.nearby || '' : sel.text,
    cfi: sel.cfi || null,
    clipId: sel.clipId || null,
    rect: sel.rect || null,
    source: sel.source || 'book',
    // pins belong to the open chat; anything else is shared by every chat
    threadId: kind === 'context' && state.thread ? state.thread.id : null,
  });
  state.marks.push(mark);
  renderRail();
  repaintMarks();
  clearSelection();
  return mark;
}

function repaintMarks() {
  if (state.engine.paint) state.engine.paint();
  if (state.engine.repaint) state.engine.repaint();
}

function clearSelection() {
  state.selection = null;
  const s = window.getSelection();
  if (s) s.removeAllRanges();
}

const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Stage a selection as an attachment on the next chat message.
 * Refining a selection and attaching again is normal, so an incoming quote replaces any
 * staged one that overlaps it rather than piling up two near-identical excerpts.
 */
function stage(sel) {
  if (sel.clipId) {
    if (state.pending.some((b) => b.clipId === sel.clipId)) return;
    state.pending.push({ type: 'clip', clipId: sel.clipId, dataUrl: sel.dataUrl });
  } else {
    const incoming = normText(sel.text);
    if (!incoming) return;
    state.pending = state.pending.filter((b) => {
      if (b.type !== 'quote') return true;
      const existing = normText(b.text);
      return !(existing.includes(incoming) || incoming.includes(existing));
    });
    state.pending.push({
      type: 'quote',
      text: sel.text,
      label: sel.source === 'chat' ? 'your earlier reply' : unitLabel(sel.unit),
      unit: sel.unit,
    });
  }
  renderChips();
  showAgent();
  $('#ask').focus();
}

async function defineTerm(sel) {
  const term = (sel.text || '').trim();
  if (!term) return;
  const pop = $('#define');
  $('#define-term').textContent = term.length > 60 ? term.slice(0, 60) + '…' : term;
  $('#define-body').textContent = 'Looking it up…';
  pop.classList.add('on');
  const r = $('#menu').getBoundingClientRect();
  pop.style.left = Math.min(Math.max(8, r.left || 200), innerWidth - 356) + 'px';
  pop.style.top = Math.min(Math.max(8, r.top || 200), innerHeight - 240) + 'px';

  const sentence = sentenceAround(sel);
  try {
    const res = await jpost(`/api/books/${SLUG}/define`, { term, sentence, unit: sel.unit });
    $('#define-body').innerHTML = md(res.text);
    renderMath($('#define-body'));
  } catch (err) {
    $('#define-body').textContent = err.message;
  }
  $('#define-chat').onclick = () => {
    pop.classList.remove('on');
    stage({ text: term, unit: sel.unit });
    $('#ask').value = `What does "${term}" mean here?`;
    $('#ask').focus();
  };
}

/** Give `define` a little context: the sentence the term sits in, from the page text. */
function sentenceAround(sel) {
  const page = state.pageText || '';
  const i = page.indexOf(sel.text);
  if (i === -1) return sel.text;
  const start = Math.max(0, page.lastIndexOf('.', i - 1) + 1);
  const endDot = page.indexOf('.', i + sel.text.length);
  return page.slice(start, endDot === -1 ? i + sel.text.length + 200 : endDot + 1).trim();
}

$('#define-close').addEventListener('click', () => $('#define').classList.remove('on'));

// ------------------------------------------------------------ region capture

const capture = { on: false, dragging: false, x0: 0, y0: 0 };

function setCapture(on) {
  if (on && !state.engine.canCapture()) return toast('Region capture works on PDFs; EPUB pages have no fixed image.', 3600);
  capture.on = on;
  $('#stage').classList.toggle('capturing', on);
  $('#capture').classList.toggle('on', on);
  if (!on) $('#capture-rect').style.display = 'none';
}

$('#capture').addEventListener('click', () => setCapture(!capture.on));

$('#stage').addEventListener('mousedown', (e) => {
  if (!capture.on || e.button !== 0) return;
  e.preventDefault();
  capture.dragging = true;
  capture.x0 = e.clientX;
  capture.y0 = e.clientY;
});

addEventListener('mousemove', (e) => {
  if (!capture.dragging) return;
  const stageEl = $('#stage');
  const sr = stageEl.getBoundingClientRect();
  const box = $('#capture-rect');
  const left = Math.min(capture.x0, e.clientX);
  const top = Math.min(capture.y0, e.clientY);
  box.style.display = 'block';
  box.style.left = left - sr.left + stageEl.scrollLeft + 'px';
  box.style.top = top - sr.top + stageEl.scrollTop + 'px';
  box.style.width = Math.abs(e.clientX - capture.x0) + 'px';
  box.style.height = Math.abs(e.clientY - capture.y0) + 'px';
});

addEventListener('mouseup', async (e) => {
  if (!capture.dragging) return;
  capture.dragging = false;
  $('#capture-rect').style.display = 'none';
  const rect = {
    left: Math.min(capture.x0, e.clientX),
    top: Math.min(capture.y0, e.clientY),
    width: Math.abs(e.clientX - capture.x0),
    height: Math.abs(e.clientY - capture.y0),
  };
  rect.right = rect.left + rect.width;
  rect.bottom = rect.top + rect.height;
  setCapture(false);
  if (rect.width < 10 || rect.height < 10) return;

  const shot = await state.engine.capture(rect);
  if (!shot) return toast('That region was too small');
  const res = await fetch(`/api/books/${SLUG}/clips`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: shot.blob,
  }).then((r) => r.json());

  state.selection = {
    clipId: res.clipId,
    dataUrl: shot.dataUrl,
    nearby: shot.nearby,
    rect: shot.rect,
    unit: shot.unit || state.engine.current(),
  };
  openMenu(Math.min(rect.right, innerWidth - 220), rect.top);
});

// ------------------------------------------------------------ chats hanging off a passage

/**
 * Every chat started from this passage. Matched by anchor id, and also by text: starting
 * a second chat from the same sentence makes a second anchor mark, and the reader thinks
 * of those as the same passage.
 */
function chatsForMark(mark) {
  if (!mark) return [];
  const byId = new Map(state.marks.map((m) => [m.id, m]));
  const key = normText(mark.text);
  return state.threads.filter((t) =>
    (t.anchors || []).some((id) => {
      if (id === mark.id) return true;
      const other = byId.get(id);
      return other && key && normText(other.text) === key;
    })
  );
}

let popTimer = null;
let popMark = null;

function showChatPop(mark, x, y) {
  const chats = chatsForMark(mark);
  const notes = mark.comments || [];
  if (!chats.length && !notes.length) return hideChatPop();
  popMark = mark.id;

  const pop = $('#chatpop');
  pop.querySelector('.head').textContent = !chats.length
    ? notes.length === 1
      ? 'Your comment'
      : 'Your comments'
    : chats.length === 1
      ? 'Chat started from this passage'
      : `${chats.length} chats started from this passage`;
  const list = pop.querySelector('.list');
  list.innerHTML = '';

  for (const c of notes) {
    const el = document.createElement('div');
    el.className = 'note' + (c.by === 'agent' ? ' agent' : '');
    el.textContent = (c.by === 'agent' ? '⌁ ' : '') + c.text;
    list.appendChild(el);
  }
  for (const t of chats) {
    const row = document.createElement('button');
    row.className = 'row' + (state.thread && state.thread.id === t.id ? ' current' : '');
    row.innerHTML = '<span class="q"></span><span class="meta"></span>';
    row.querySelector('.q').textContent = t.opening || t.title;
    row.querySelector('.meta').textContent =
      `${t.messageCount} message${t.messageCount === 1 ? '' : 's'}` +
      (state.thread && state.thread.id === t.id ? ' · open' : '');
    row.onclick = () => {
      hideChatPop();
      openThread(t.id);
      showAgent();
    };
    list.appendChild(row);
  }

  pop.classList.add('on');
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8) + 'px';
  pop.style.top = (y - h - 10 > 8 ? y - h - 10 : y + 16) + 'px';
}

function hideChatPop() {
  popMark = null;
  $('#chatpop').classList.remove('on');
}

$('#chatpop').addEventListener('mouseenter', () => clearTimeout(popTimer));
$('#chatpop').addEventListener('mouseleave', () => {
  popTimer = setTimeout(hideChatPop, 220);
});

function markUnderPointer(e) {
  if (!state.engine || !state.engine.marksAt) return null;
  const ids = state.engine.marksAt(e.clientX, e.clientY);
  if (!ids.length) return null;
  const under = ids.map((id) => state.marks.find((m) => m.id === id)).filter(Boolean);
  // something to show beats mere proximity; otherwise the tightest mark wins
  return under.find((m) => chatsForMark(m).length || (m.comments || []).length) || under[0];
}

$('#stage').addEventListener('mousemove', (e) => {
  if (capture.on || capture.dragging) return;
  const mark = markUnderPointer(e);
  const chats = mark ? chatsForMark(mark) : [];
  const worth = chats.length || (mark && (mark.comments || []).length);
  $('#stage').classList.toggle('over-chat', chats.length > 0);
  if (!worth) {
    if (popMark) popTimer = setTimeout(hideChatPop, 220);
    return;
  }
  clearTimeout(popTimer);
  if (mark.id !== popMark) showChatPop(mark, e.clientX, e.clientY);
});

$('#stage').addEventListener('mouseleave', () => {
  popTimer = setTimeout(hideChatPop, 250);
});

$('#stage').addEventListener('click', (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // they were selecting, not clicking through
  const mark = markUnderPointer(e);
  const chats = mark ? chatsForMark(mark) : [];
  if (chats.length === 1) {
    hideChatPop();
    openThread(chats[0].id);
    showAgent();
  } else if (chats.length > 1) {
    showChatPop(mark, e.clientX, e.clientY);
  }
});

// ------------------------------------------------------------ rail

function railSection(id, open) {
  const sec = $(id);
  sec.classList.toggle('closed', !open);
  sec.querySelector('h2').onclick = () => {
    sec.classList.toggle('closed');
    localStorage.setItem('rail:' + id, sec.classList.contains('closed') ? '0' : '1');
  };
}

async function renderDocs() {
  const books = await api('/api/books');
  $('#docs-count').textContent = books.length || '';
  const box = $('#docs');
  box.innerHTML = '';
  for (const b of books) {
    const row = document.createElement('div');
    row.className = 'row' + (b.slug === SLUG ? ' active' : '');
    row.innerHTML = `<span class="label"></span><span class="sub">${b.format}</span>`;
    row.querySelector('.label').textContent = b.title;
    row.title = b.title;
    row.onclick = () => {
      if (b.slug !== SLUG) location.href = `/reader.html?book=${encodeURIComponent(b.slug)}`;
    };
    box.appendChild(row);
  }
}

function renderRail() {
  // chats
  $('#chats-count').textContent = state.threads.length || '';
  const cbox = $('#chats');
  cbox.innerHTML = '';
  if (!state.threads.length) cbox.innerHTML = '<div class="empty">No chats yet.</div>';
  for (const t of state.threads) {
    const row = document.createElement('div');
    row.className = 'row' + (state.thread && t.id === state.thread.id ? ' active' : '');
    row.innerHTML = `<span class="label"></span><button class="x" title="Delete chat">✕</button>`;
    row.querySelector('.label').textContent = t.title;
    row.title = t.preview || t.title;
    row.onclick = (e) => {
      if (e.target.closest('.x')) return;
      openThread(t.id);
      showAgent();
    };
    row.querySelector('.x').onclick = (e) => {
      e.stopPropagation();
      deleteThread(t);
    };
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openChatMenu(e.clientX, e.clientY, t);
    });
    cbox.appendChild(row);
  }

  renderMarkList('#context-list', '#context-count', 'context', 'Right-click a passage → Add to context.');
  renderMarkList('#keep-list', '#keep-count', 'keep', 'Right-click → Save markdown to keep an excerpt.');
  renderMarkList('#plain-list', '#plain-count', 'plain', 'Plain marks land here.');
  $('#sec-plain').hidden = !state.marks.some((m) => m.kind === 'plain');
}

function renderMarkList(boxSel, countSel, kind, emptyMsg) {
  const marks = state.marks.filter((m) => m.kind === kind);
  $(countSel).textContent = marks.length || '';
  const box = $(boxSel);
  box.innerHTML = '';
  if (!marks.length) {
    box.innerHTML = `<div class="empty">${esc(emptyMsg)}</div>`;
    return;
  }
  for (const m of marks) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.alignItems = 'flex-start';
    const body =
      m.type === 'region'
        ? `<img class="clip-thumb" src="/api/books/${SLUG}/clips/${m.clipId}" alt="region capture" title="${esc(clipHint(m.unit))}">`
        : `<div class="snip"></div>`;
    const where =
      m.source === 'chat'
        ? `<span class="from-chat">from a reply</span> · ${esc(unitLabel(m.unit))}`
        : esc(unitLabel(m.unit));
    row.innerHTML = `<span class="dot ${kind}" style="margin-top:6px"></span>
      <span class="label" style="white-space:normal">
        <div class="sub">${where}</div>${body}
      </span>
      <button class="x" title="Remove">✕</button>`;
    if (m.type !== 'region') row.querySelector('.snip').textContent = m.text;
    if (kind === 'context') {
      const scope = document.createElement('button');
      const mine = !!state.thread && m.threadId === state.thread.id;
      const global = !m.threadId;
      scope.className = 'scope' + (global || mine ? '' : ' inactive');
      scope.textContent = global ? 'all chats' : mine ? 'this chat' : 'other chat';
      scope.title = global
        ? 'Sent with every chat. Click to limit it to this one.'
        : mine
          ? 'Sent with this chat only. Click to share it with every chat.'
          : 'Belongs to a different chat, so it is not being sent here. Click to share it with every chat.';
      scope.onclick = async (e) => {
        e.stopPropagation();
        const threadId = global && state.thread ? state.thread.id : null;
        Object.assign(m, await jpost(`/api/books/${SLUG}/marks/${m.id}`, { threadId }, 'PATCH'));
        renderRail();
      };
      row.querySelector('.sub').appendChild(scope);

      // ...and, for a pin that does reach the open chat, whether it is switched on there
      if (state.thread && (global || mine)) {
        const off = isMuted(m);
        const mute = document.createElement('button');
        mute.className = 'scope' + (off ? ' inactive' : '');
        mute.textContent = off ? 'off here' : 'on here';
        mute.title = off
          ? 'Excluded from the open chat. Click to send it again.'
          : 'Sent with every message in the open chat. Click to exclude it here.';
        mute.onclick = async (e) => {
          e.stopPropagation();
          await mutePin(m, !off);
        };
        row.querySelector('.sub').appendChild(mute);
        if (off) row.style.opacity = '.55';
      }
    }

    const comments = document.createElement('div');
    comments.className = 'comments';
    renderComments(comments, m);
    row.querySelector('.label').appendChild(comments);

    row.onclick = (e) => {
      if (e.target.closest('.x') || e.target.closest('.scope') || e.target.closest('.comments')) return;
      jumpToMark(m);
    };
    row.querySelector('.x').onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/books/${SLUG}/marks/${m.id}`, { method: 'DELETE' });
      state.marks = state.marks.filter((x) => x.id !== m.id);
      renderRail();
      repaintMarks();
    };
    box.appendChild(row);
  }
}

/**
 * Every discontinuous move — a mark, a search hit, a link in the chat — is recorded so
 * the reader can get back. Turning pages is not: it would bury the place you jumped from.
 */
function jumpTo(unit, { record = true, cfi = null } = {}) {
  const from = state.engine.current();
  if (record && from !== unit) {
    state.history.push(from);
    if (state.history.length > 50) state.history.shift();
    paintBack();
  }
  if (cfi && state.book.format === 'epub') state.engine.jumpCfi(cfi);
  else state.engine.jump(unit);
  $('#unit').value = unit;
}

function goBack() {
  const unit = state.history.pop();
  if (unit === undefined) return;
  paintBack();
  state.engine.jump(unit);
  $('#unit').value = unit;
  toast('Back to ' + unitLabel(unit));
}

function paintBack() {
  const btn = $('#back');
  const n = state.history.length;
  btn.hidden = !n;
  if (n) btn.title = 'Back to ' + unitLabel(state.history[n - 1]) + ' (b)';
}

function renderComments(box, m) {
  box.innerHTML = '';
  for (const c of m.comments || []) {
    const el = document.createElement('div');
    el.className = 'comment' + (c.by === 'agent' ? ' agent' : '');
    el.innerHTML = '<span class="body"></span><button class="x" title="Delete comment">✕</button>';
    el.querySelector('.body').textContent = (c.by === 'agent' ? '⌁ ' : '') + c.text;
    el.title = (c.by === 'agent' ? 'From the agent' : 'Your comment') + (c.at ? ' · ' + c.at.slice(0, 10) : '');
    el.querySelector('.x').onclick = async (e) => {
      e.stopPropagation();
      Object.assign(m, await api(`/api/books/${SLUG}/marks/${m.id}/comments/${c.id}`, { method: 'DELETE' }));
      renderComments(box, m);
    };
    box.appendChild(el);
  }
  const add = document.createElement('button');
  add.className = 'add-comment';
  add.textContent = (m.comments || []).length ? '+ comment' : '+ add a comment';
  add.onclick = async (e) => {
    e.stopPropagation();
    const text = await modal({ title: 'Comment · ' + unitLabel(m.unit), quote: m.text, ok: 'Save comment' });
    if (text === null || !text) return;
    Object.assign(m, await jpost(`/api/books/${SLUG}/marks/${m.id}/comments`, { text }));
    renderComments(box, m);
  };
  box.appendChild(add);
}

function jumpToMark(m) {
  jumpTo(m.unit, { cfi: m.cfi });
}

// ------------------------------------------------------------ chat

async function refreshThreads() {
  state.threads = await api(`/api/books/${SLUG}/chats`);
  renderRail();
}

/**
 * Walking away from a chat you never asked anything in. The server drops the thread
 * and the passage it hung off reverts to a plain mark, so the rail is not filling up
 * with rows called "New chat".
 */
async function leaveThread() {
  const t = state.thread;
  if (!t || (t.messages || []).length) return;
  const { collapsed } = await jpost(`/api/books/${SLUG}/chats/${t.id}/collapse`, {});
  if (!collapsed) return;
  state.thread = null;
  state.marks = await api(`/api/books/${SLUG}/marks`);
  await refreshThreads();
  repaintMarks();
}

async function openThread(id) {
  if (state.thread && state.thread.id !== id) {
    // anything staged was meant for the chat you are leaving
    if (state.pending.length) state.pending = [];
    await leaveThread();
  }
  state.thread = await api(`/api/books/${SLUG}/chats/${id}`);
  renderThread();
  renderRail();
  renderChips();
}

async function newThread() {
  state.pending = [];
  await leaveThread();
  const t = await jpost(`/api/books/${SLUG}/chats`, { unit: state.engine.current() });
  await refreshThreads();
  await openThread(t.id);
  showAgent();
  $('#ask').focus();
}

function renderThread() {
  const box = $('#thread');
  $('#thread-name').textContent = state.thread ? state.thread.title : 'New chat';
  box.innerHTML = '';

  const messages = (state.thread && state.thread.messages) || [];
  for (const m of messages) box.appendChild(renderMessage(m));

  // A missing key stops new in-app answers, but must never hide what is already
  // there — the Claude Code sidebar writes into these same threads.
  const ready = modelReady();
  if (!messages.length || !ready) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.innerHTML = ready
      ? 'Right-click a passage or capture a figure, then ask about it.<br><br><kbd>r</kbd> capture a region &middot; <kbd>p</kbd> pin &middot; <kbd>c</kbd> chat'
      : missingKeyNote();
    box.appendChild(note);
  }
  box.scrollTop = box.scrollHeight;

  const ask = $('#ask');
  ask.disabled = !ready;
  $('#send').disabled = !ready;
  const cur = currentModel();
  ask.placeholder = ready
    ? 'Ask about what you are reading...'
    : cur
      ? `Add ${cur.envVar} to .env to chat with ${cur.label}`
      : 'Add an API key to .env to chat here';
}

/**
 * Why this panel cannot answer: either nothing is configured at all, or the model
 * the picker is on belongs to a provider whose key is missing while another's is set.
 */
function missingKeyNote() {
  const cur = currentModel();
  const tail =
    '<br><br>Marking still works, and the agent in your Claude Code sidebar reads and writes these same threads.';
  if (state.agentAvailable && cur) {
    return `Replies from ${esc(cur.label)} are off: no <code>${esc(cur.envVar)}</code>. Put one in <code>.env</code> at the project root and restart the server, or pick another model above.${tail}`;
  }
  const keys = [...new Set(state.models.map((m) => m.envVar))];
  const list = keys.length
    ? keys.map((k) => `<code>${esc(k)}</code>`).join(' or ')
    : '<code>ANTHROPIC_API_KEY</code>';
  return `Replies in this panel are off: no API key. Put ${list} in <code>.env</code> at the project root and restart the server.${tail}`;
}

/** Display name for a model id. Turns saved before the picker existed were all Claude. */
function modelLabel(id) {
  const m = state.models.find((x) => x.id === id);
  return m ? m.label : id || 'Claude';
}

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role + (m.error ? ' error' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = m.role === 'user' ? 'You' : modelLabel(m.model);
  el.appendChild(who);

  if (m.role === 'user') {
    for (const b of m.blocks || []) {
      if (b.type === 'clip') {
        const a = document.createElement('div');
        a.className = 'attach';
        a.innerHTML = `<img src="/api/books/${SLUG}/clips/${b.clipId}" alt="captured region">`;
        el.appendChild(a);
      } else if (b.type === 'quote') {
        const a = document.createElement('div');
        a.className = 'attach';
        const q = document.createElement('div');
        q.className = 'quote';
        q.textContent = b.text;
        a.appendChild(q);
        el.appendChild(a);
      }
    }
    const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) {
      const bub = document.createElement('div');
      bub.className = 'bubble';
      bub.textContent = text;
      el.appendChild(bub);
    }
  } else {
    if (m.thinking) {
      const d = document.createElement('details');
      d.className = 'thinking';
      d.innerHTML = `<summary>thought for a moment</summary><div class="body"></div>`;
      d.querySelector('.body').textContent = m.thinking;
      el.appendChild(d);
    }
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = md((m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    renderMath(body);
    linkifyRefs(body);
    el.appendChild(body);
  }
  return el;
}

/**
 * Captures are the one thing in a chat that is a picture rather than text, and the
 * word alone does not say so — spell it out wherever one appears.
 */
const CLIP_HINT =
  'Region capture — a screenshot of part of the page, taken with Capture in the toolbar. ' +
  'It carries the actual picture: the page text holds a figure\u2019s caption but never the figure.';

const clipHint = (unit) => (unit ? `${CLIP_HINT}\nFrom ${unitLabel(unit)}.` : CLIP_HINT);

/**
 * The pins that could reach this chat: the global ones plus the ones made here.
 * A pin belonging to another side chat is not in play, so it should not be counted.
 */
function visiblePins() {
  return state.marks.filter(
    (m) => m.kind === 'context' && (!m.threadId || (state.thread && m.threadId === state.thread.id))
  );
}

const isMuted = (m) => !!state.thread && (state.thread.mutedPins || []).includes(m.id);

/** Switch a pin off for this chat alone. The mark itself is untouched. */
async function mutePin(mark, muted) {
  // muting is stored on the thread, so a chat you have not sent to yet needs one first
  if (!state.thread) {
    state.thread = await jpost(`/api/books/${SLUG}/chats`, { unit: state.engine.current() });
    await refreshThreads();
  }
  state.thread = await jpost(
    `/api/books/${SLUG}/chats/${state.thread.id}/pins/${mark.id}`,
    { muted }
  );
  renderChips();
  renderRail();
}

/** The per-chat pin switchboard, hung off the "N pinned" chip. */
function openPinMenu(chip) {
  const pins = visiblePins();
  const menu = $('#menu');
  const rows = pins
    .map((m) => {
      const label =
        m.type === 'region'
          ? '🖼 region capture'
          : (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 44) + ((m.text || '').length > 44 ? '…' : '');
      return (
        `<button class="item" data-pin="${m.id}">` +
        `<span class="dot ${isMuted(m) ? '' : 'context'}"${isMuted(m) ? ' style="background:transparent;border:1px solid var(--line-2)"' : ''}></span>` +
        `<span style="${isMuted(m) ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(label)}</span>` +
        `<span class="k">${esc(unitLabel(m.unit))}</span></button>`
      );
    })
    .join('');
  menu.innerHTML =
    '<div class="head">Pins sent with this chat</div>' +
    rows +
    '<div class="sep"></div>' +
    `<button class="item" data-pin="*"><span class="dot" style="background:transparent"></span>` +
    (pins.every((m) => isMuted(m)) ? 'Turn them all back on' : 'Exclude them all from this chat') +
    '</button>';
  menu.dataset.pins = '1';
  menu.classList.add('on');
  const r = chip.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.max(8, r.top - h - 6) + 'px';
}

/**
 * Deleting a chat takes its anchor passage with it — that mark exists only to hang the
 * chat off — so say so before doing it, unless nothing was ever said in there.
 */
async function deleteThread(t, { keep = false } = {}) {
  const spoken = (t.messageCount || 0) > 0;
  if (!keep && spoken && !confirm(`Delete "${t.title}"? The passage it was started from goes too.`))
    return;
  await api(`/api/books/${SLUG}/chats/${t.id}${keep ? '?keep=1' : ''}`, { method: 'DELETE' });
  if (state.thread && state.thread.id === t.id) state.thread = null;
  state.marks = await api(`/api/books/${SLUG}/marks`);
  await refreshThreads();
  renderThread();
  repaintMarks();
  toast(keep ? 'Chat deleted, passage kept' : 'Chat deleted');
}

/** Right-click on a row in the rail's chat list. */
function openChatMenu(x, y, t) {
  const menu = $('#menu');
  menu.innerHTML =
    `<div class="head">${esc(t.title)}</div>` +
    '<button class="item" data-chat="open"><span class="dot chat"></span>Open<span class="k">↵</span></button>' +
    (t.anchors && t.anchors.length
      ? '<button class="item" data-chat="jump"><span class="dot" style="background:transparent"></span>Go to the passage</button>'
      : '') +
    '<div class="sep"></div>' +
    '<button class="item" data-chat="keep"><span class="dot" style="background:transparent"></span>Delete, keep the passage</button>' +
    '<button class="item" data-chat="delete"><span class="dot" style="background:transparent"></span>Delete chat and passage</button>';
  menu.dataset.chat = t.id;
  menu.classList.add('on');
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  menu.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h) : y) + 'px';
}

function renderChips() {
  const box = $('#chips');
  box.innerHTML = '';

  const pageChip = document.createElement('span');
  pageChip.className = 'chip toggle' + (state.includePage ? ' on' : '');
  pageChip.textContent = `${unitLabel(state.engine ? state.engine.current() : 1)} text`;
  pageChip.title = 'Include the text of the page you are on';
  pageChip.onclick = () => {
    state.includePage = !state.includePage;
    renderChips();
  };
  box.appendChild(pageChip);

  const cur = state.engine ? state.engine.current() : 1;
  const last = state.book ? state.book.unitCount : cur;
  const sides = [cur - 1, cur + 1].filter((i) => i >= 1 && i <= last);
  const nearChip = document.createElement('span');
  nearChip.className = 'chip toggle' + (state.nearby ? ' on' : '');
  nearChip.textContent = 'nearby';
  nearChip.title = state.nearby
    ? `Also sending ${sides.map(unitLabel).join(' and ')} — what is either side of the page you are on. Click to stop.`
    : 'Off. Click to also send the pages either side of this one, for an argument that runs across a page break.';
  nearChip.onclick = () => {
    state.nearby = !state.nearby;
    localStorage.setItem('nearby', state.nearby ? '1' : '0');
    renderChips();
  };
  box.appendChild(nearChip);

  const recentChip = document.createElement('span');
  recentChip.className = 'chip toggle' + (state.recent ? ' on' : '');
  recentChip.textContent = `recent marks`;
  recentChip.title = state.recent
    ? `Also sending the last ${RECENT_MARKS} passages you marked anywhere in the book — side chats, highlights, plain marks. Click to stop.`
    : `Off. Click to also send the last ${RECENT_MARKS} passages you marked anywhere in the book.`;
  recentChip.onclick = () => {
    state.recent = !state.recent;
    localStorage.setItem('recent', state.recent ? '1' : '0');
    renderChips();
  };
  box.appendChild(recentChip);

  const briefChip = document.createElement('span');
  briefChip.className = 'chip toggle' + (state.brief ? ' on' : '');
  briefChip.textContent = state.brief ? 'brief' : 'full';
  briefChip.title = state.brief
    ? 'Brief: four sentences, answer and reason only. Click for full answers.'
    : 'Full answers. Click for brief ones.';
  briefChip.onclick = () => {
    state.brief = !state.brief;
    localStorage.setItem('brief', state.brief ? '1' : '0');
    renderChips();
  };
  box.appendChild(briefChip);

  const pins = visiblePins();
  if (pins.length) {
    const live = pins.filter((m) => !isMuted(m)).length;
    const c = document.createElement('span');
    c.className = 'chip toggle pin-chip' + (live ? ' on' : '');
    c.textContent = live === pins.length ? `${live} pinned` : `${live}/${pins.length} pinned`;
    c.title = live
      ? `${live} pinned ${live === 1 ? 'passage goes' : 'passages go'} with every message in this chat. Click to choose which.`
      : 'Pins are switched off for this chat. Click to turn them back on.';
    c.onclick = (e) => {
      e.stopPropagation();
      // the document mousedown already closed an open menu; reopen only if it was not ours
      if (menuWasPinMenu) return;
      openPinMenu(c);
    };
    box.appendChild(c);
  }

  state.pending.forEach((b, i) => {
    const c = document.createElement('span');
    c.className = 'chip on';
    const preview = (b.text || '').replace(/\s+/g, ' ').trim();
    c.innerHTML = `${b.type === 'clip' ? '🖼 region' : '“' + esc(preview.slice(0, 44)) + (preview.length > 44 ? '…' : '') + '”'}<button>✕</button>`;
    c.title = b.type === 'clip' ? CLIP_HINT : preview;
    c.querySelector('button').onclick = () => {
      state.pending.splice(i, 1);
      renderChips();
    };
    box.appendChild(c);
  });
}

/** The model row the picker is currently on, and whether its key is actually set. */
function currentModel() {
  return state.models.find((m) => m.id === state.model) || null;
}
function modelReady() {
  const m = currentModel();
  return !!(m && m.available);
}

function renderModelSelect() {
  const sel = $('#model-select');
  if (!state.models.length) {
    sel.hidden = true;
    return;
  }
  sel.hidden = false;
  sel.innerHTML = state.models
    .map(
      (m) =>
        `<option value="${esc(m.id)}" ${m.available ? '' : 'disabled'} ${m.id === state.model ? 'selected' : ''}>${esc(m.label)}${m.available ? '' : ' (no key)'}</option>`
    )
    .join('');
  sel.onchange = () => {
    state.model = sel.value;
    localStorage.setItem('model', state.model);
    renderThread(); // the composer and its note track the model you picked
  };
}

async function send(opts = {}) {
  if (state.streaming) return;
  const text = (opts.text !== undefined ? opts.text : $('#ask').value).trim();
  if (!text && !state.pending.length) return;
  if (!modelReady()) {
    const cur = currentModel();
    return toast(cur ? `${cur.label} needs ${cur.envVar} in .env` : 'No model connected — add an API key to .env', 4000);
  }

  if (!state.thread) {
    const t = await jpost(`/api/books/${SLUG}/chats`, { unit: state.engine.current() });
    state.thread = t;
  }

  const blocks = [...state.pending.map(({ dataUrl, ...b }) => b)];
  if (text) blocks.push({ type: 'text', text });

  $('#ask').value = '';
  $('#ask').style.height = 'auto';
  state.pending = [];
  renderChips();

  const box = $('#thread');
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.appendChild(renderMessage({ role: 'user', blocks }));

  const reply = document.createElement('div');
  reply.className = 'msg assistant';
  reply.innerHTML = `<div class="who">${esc(modelLabel(state.model))}</div><details class="thinking" hidden><summary>thinking…</summary><div class="body"></div></details><div class="md muted">…</div>`;
  box.appendChild(reply);
  box.scrollTop = box.scrollHeight;

  const thinkEl = reply.querySelector('.thinking');
  const thinkBody = reply.querySelector('.thinking .body');
  const bodyEl = reply.querySelector('.md');
  let acc = '';
  let think = '';

  state.streaming = true;
  $('#send').disabled = true;
  try {
    const res = await fetch(`/api/books/${SLUG}/chats/${state.thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        blocks,
        unit: state.engine.current(),
        includePage: state.includePage,
        nearby: state.nearby,
        recent: state.recent ? RECENT_MARKS : 0,
        brief: state.brief,
        navigate: !!opts.navigate,
        model: state.model,
      }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
        const raw = (chunk.match(/^data: (.*)$/m) || [])[1];
        if (!ev || !raw) continue;
        const data = JSON.parse(raw);
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        if (ev === 'text') {
          acc += data.t;
          bodyEl.classList.remove('muted');
          bodyEl.innerHTML = md(acc);
        } else if (ev === 'thinking') {
          think += data.t;
          thinkEl.hidden = false;
          thinkBody.textContent = think;
        } else if (ev === 'error') {
          bodyEl.classList.remove('muted');
          reply.classList.add('error');
          bodyEl.innerHTML = md(data.message);
        }
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    }
    if (thinkEl && !thinkEl.hidden) thinkEl.querySelector('summary').textContent = 'thought for a moment';
    renderMath(bodyEl); // only once the stream ends: partial LaTeX would flicker
    linkifyRefs(bodyEl);
  } catch (err) {
    reply.classList.add('error');
    bodyEl.textContent = err.message;
  } finally {
    state.streaming = false;
    $('#send').disabled = false;
    await refreshThreads();
    if (state.thread) state.thread = await api(`/api/books/${SLUG}/chats/${state.thread.id}`);
    $('#thread-name').textContent = state.thread ? state.thread.title : 'New chat';
  }
}

$('#send').addEventListener('click', () => send());
$('#ask').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('#ask').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px';
});
$('#agent-new').addEventListener('click', newThread);
$('#new-chat').addEventListener('click', newThread);
$('#agent-close').addEventListener('click', async () => {
  setAgent(false);
  await leaveThread();
  renderThread();
});

let lastSeen = new Map();
async function watchThreads() {
  if (state.streaming || document.hidden) return;
  let threads;
  try {
    threads = await api(`/api/books/${SLUG}/chats`);
  } catch {
    return;
  }
  const changed = threads.filter((t) => lastSeen.size && lastSeen.get(t.id) !== t.updatedAt);
  state.threads = threads;
  renderRail();
  lastSeen = new Map(threads.map((t) => [t.id, t.updatedAt]));
  if (!changed.length) return;

  const open = changed.find((t) => state.thread && t.id === state.thread.id);
  if (open) {
    state.thread = await api(`/api/books/${SLUG}/chats/${open.id}`);
    renderThread();
  } else {
    toast(`"${changed[0].title}" was updated`, 3000);
  }
}

// ------------------------------------------------------------ chrome

const FLOW_LABEL = { paged: '\u21c4 Pages', scroll: '\u21d5 Scroll' };
const SPREAD_LABEL = { auto: '\u25af Auto', single: '\u25af 1 page', double: '\u25ae\u25ae 2 pages' };

function paintViewButtons() {
  $('#toggle-flow').textContent = FLOW_LABEL[view.flow];
  $('#toggle-flow').title =
    view.flow === 'paged' ? 'Turning pages \u2014 switch to continuous scrolling' : 'Scrolling \u2014 switch to turning pages';
  $('#toggle-spread').textContent = SPREAD_LABEL[view.spread];
  $('#toggle-spread').classList.toggle('on', view.spread === 'double');
  $('#toggle-flow').classList.toggle('on', view.flow === 'scroll');
}

function setView(patch) {
  Object.assign(view, patch);
  localStorage.setItem('flow', view.flow);
  localStorage.setItem('spread', view.spread);
  paintViewButtons();
  if (state.engine && state.engine.setView) state.engine.setView();
}

// ---- zoom

function paintTheme() {
  $('#app').dataset.theme = view.theme;
  const dark = view.theme === 'dark';
  $('#toggle-theme').textContent = dark ? '☾' : '☀';
  $('#toggle-theme').title = dark ? 'Dark page — switch to paper' : 'Paper page — switch to dark';
  $('#toggle-theme').classList.toggle('on', dark);
}

function setTheme(theme) {
  view.theme = theme;
  localStorage.setItem('theme', theme);
  paintTheme();
  if (state.engine && state.engine.setTheme) state.engine.setTheme();
}

$('#toggle-theme').addEventListener('click', () => setTheme(view.theme === 'dark' ? 'paper' : 'dark'));

function paintZoom() {
  $('#zoom-reset').textContent = Math.round(view.zoom * 100) + '%';
  $('#zoom-out').disabled = view.zoom <= ZOOM_MIN + 1e-6;
  $('#zoom-in').disabled = view.zoom >= ZOOM_MAX - 1e-6;
}

let zoomTimer;
function setZoom(z) {
  view.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));
  localStorage.setItem('zoom', view.zoom);
  paintZoom();
  // re-laying out a 600-page book on every wheel tick is wasteful; settle first
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => state.engine && state.engine.setZoom && state.engine.setZoom(), 120);
}

function stepZoom(dir) {
  if (dir > 0) {
    const next = ZOOM_STEPS.find((z) => z > view.zoom + 1e-6);
    setZoom(next === undefined ? ZOOM_MAX : next);
  } else {
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < view.zoom - 1e-6);
    setZoom(prev === undefined ? ZOOM_MIN : prev);
  }
}

$('#zoom-in').addEventListener('click', () => stepZoom(1));
$('#zoom-out').addEventListener('click', () => stepZoom(-1));
$('#zoom-reset').addEventListener('click', () => setZoom(1));

$('#stage').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // trackpad pinch arrives as ctrl+wheel
    e.preventDefault();
    setZoom(view.zoom * (e.deltaY > 0 ? 0.92 : 1.08));
  },
  { passive: false }
);

$('#toggle-flow').addEventListener('click', () => setView({ flow: view.flow === 'paged' ? 'scroll' : 'paged' }));
$('#toggle-spread').addEventListener('click', () =>
  setView({ spread: { auto: 'single', single: 'double', double: 'auto' }[view.spread] })
);

/** Width changed under the reader — re-fit, keeping flow and spread as they are. */
function refit() {
  if (state.engine && state.engine.relayout) setTimeout(() => state.engine.relayout(), 60);
}

function setLayout(mode) {
  $('#app').dataset.layout = mode;
  localStorage.setItem('layout', mode);
  $('#toggle-layout').textContent = mode === 'split' ? '◱' : '⧉';
  $('#toggle-layout').title = mode === 'split' ? 'Switch to popup chat' : 'Switch to split view';
  restoreAgentPos();
  refit();
}
function setAgent(on) {
  $('#app').dataset.agent = on ? 'on' : 'off';
  localStorage.setItem('agent', on ? 'on' : 'off');
  refit();
}
function showAgent() {
  if ($('#app').dataset.agent !== 'on') setAgent(true);
}

// ---- dragging the popup chat

const KEEP_ON_SCREEN = 120; // px of the panel that must stay reachable

function placeAgent(left, top, save) {
  const el = $('#agent');
  const w = el.offsetWidth;
  const x = Math.min(Math.max(KEEP_ON_SCREEN - w, left), innerWidth - KEEP_ON_SCREEN);
  const y = Math.min(Math.max(0, top), innerHeight - 40);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  if (save) localStorage.setItem('agentPos', JSON.stringify({ x, y }));
}

function restoreAgentPos() {
  const el = $('#agent');
  if ($('#app').dataset.layout !== 'popup') {
    el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    return;
  }
  let pos = null;
  try {
    pos = JSON.parse(localStorage.getItem('agentPos') || 'null');
  } catch {}
  if (pos) placeAgent(pos.x, pos.y, false);
}

const agentDrag = { on: false, dx: 0, dy: 0 };

$('.agent .head').addEventListener('mousedown', (e) => {
  if ($('#app').dataset.layout !== 'popup' || e.button !== 0) return;
  if (e.target.closest('button')) return; // the ＋ and ✕ still click normally
  const r = $('#agent').getBoundingClientRect();
  agentDrag.on = true;
  agentDrag.dx = e.clientX - r.left;
  agentDrag.dy = e.clientY - r.top;
  document.body.classList.add('dragging');
  e.preventDefault();
});

addEventListener('mousemove', (e) => {
  if (!agentDrag.on) return;
  placeAgent(e.clientX - agentDrag.dx, e.clientY - agentDrag.dy, false);
});

addEventListener('mouseup', () => {
  if (!agentDrag.on) return;
  agentDrag.on = false;
  document.body.classList.remove('dragging');
  const r = $('#agent').getBoundingClientRect();
  placeAgent(r.left, r.top, true);
});

// a window resize can strand the panel off-screen
addEventListener('resize', () => {
  if ($('#app').dataset.layout !== 'popup') return;
  const r = $('#agent').getBoundingClientRect();
  placeAgent(r.left, r.top, true);
});
function setRail(on) {
  $('#app').dataset.rail = on ? 'on' : 'off';
  localStorage.setItem('rail', on ? 'on' : 'off');
  refit();
}

$('#toggle-layout').addEventListener('click', () =>
  setLayout($('#app').dataset.layout === 'split' ? 'popup' : 'split')
);
$('#toggle-agent').addEventListener('click', () => setAgent($('#app').dataset.agent !== 'on'));
$('#toggle-rail').addEventListener('click', () => setRail($('#app').dataset.rail !== 'on'));

let posTimer;
async function onUnitChanged(unit) {
  $('#unit').value = unit;
  const chapters = (state.book.units || []).filter((x) => x.chapter && x.index <= unit);
  const here = chapters[chapters.length - 1];
  $('#chapter').textContent = here ? here.chapter : '';
  renderChips();
  clearTimeout(posTimer);
  posTimer = setTimeout(() => jpost(`/api/books/${SLUG}/position`, { unit }, 'PUT').catch(() => {}), 600);
  try {
    const [page] = await api(`/api/books/${SLUG}/text?from=${unit}`);
    state.pageText = page ? page.text : '';
  } catch {}
}

$('#prev').addEventListener('click', () => state.engine.prev());
$('#next').addEventListener('click', () => state.engine.next());
$('#unit').addEventListener('change', () => {
  const n = Number($('#unit').value);
  if (n >= 1 && n <= state.book.unitCount) jumpTo(n);
});
$('#back').addEventListener('click', goBack);

// a page reference inside a reply
$('#thread').addEventListener('click', (e) => {
  const a = e.target.closest('a.jump');
  if (!a) return;
  e.preventDefault();
  jumpTo(Number(a.dataset.unit));
});
$('#unit').addEventListener('keydown', (e) => e.stopPropagation());

function onKey(e) {
  if (e.target.matches('input, textarea')) return;
  if ($('#modal').classList.contains('on')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
    e.preventDefault();
    return setRail($('#app').dataset.rail !== 'on');
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    closeMenu();
    if (capture.on) setCapture(false);
    return;
  }
  if (e.key === 'ArrowRight') state.engine.next();
  else if (e.key === 'ArrowLeft') state.engine.prev();
  else if (e.key === '+' || e.key === '=') stepZoom(1);
  else if (e.key === '-' || e.key === '_') stepZoom(-1);
  else if (e.key === '0') setZoom(1);
  else if (e.key === 'b') goBack();
  else if (e.key === 'n') setTheme(view.theme === 'dark' ? 'paper' : 'dark');
  else if (e.key === 'r') setCapture(!capture.on);
  else if (state.selection && ['p', 'h', 'c', 'd', 'f', 'v', 'g'].includes(e.key)) {
    e.preventDefault();
    runAction(
      { p: 'context', h: 'keep', c: 'chat', d: 'define', f: 'related', v: 'comment', g: 'google' }[e.key]
    );
  }
}
document.addEventListener('keydown', onKey);

// ------------------------------------------------------------ boot

(async function boot() {
  if (!SLUG) return (location.href = '/');

  paintViewButtons();
  paintTheme();
  paintZoom();
  paintBack();
  setLayout(localStorage.getItem('layout') || 'split');
  setRail(localStorage.getItem('rail') !== 'off');
  setAgent(localStorage.getItem('agent') !== 'off');
  ['#sec-docs', '#sec-chats', '#sec-context', '#sec-plain', '#sec-keep'].forEach((id) =>
    railSection(id, localStorage.getItem('rail:' + id) !== '0')
  );

  state.book = await api(`/api/books/${SLUG}`);
  state.marks = state.book.marks || [];
  document.title = state.book.title + ' · book-reader';
  $('#title').textContent = state.book.title;
  $('#title').title = state.book.title;
  $('#unit-total').textContent = `/ ${state.book.unitCount}`;

  const status = await api('/api/agent/status').catch(() => ({ available: false, models: [] }));
  state.agentAvailable = status.available;
  state.models = status.models || [];
  // Land on a model that can actually answer: keep their choice only if its key is set,
  // so a reader with just OPENAI_API_KEY opens on a GPT model rather than a dead Claude one.
  if (!state.models.some((m) => m.id === state.model && m.available)) {
    state.model = (state.models.find((m) => m.available) || state.models[0] || { id: status.model }).id;
  }
  renderModelSelect();

  state.engine = state.book.format === 'pdf' ? new PdfEngine() : new EpubEngine();
  await state.engine.init();
  if (!state.engine.canCapture()) $('#capture').disabled = true;

  // Start rendering the page, but don't wait on it: a heavy first page — or a tab the
  // browser has frozen — must not keep the rail and the chat list from loading.
  const start = (state.book.position && state.book.position.unit) || 1;
  const firstPage =
    state.book.format === 'pdf'
      ? state.engine.show(start)
      : start > 1
        ? Promise.resolve(state.engine.jump(start))
        : Promise.resolve();
  firstPage.catch(() => {});

  await Promise.all([renderDocs(), refreshThreads()]);
  const [recent] = state.threads;
  if (recent) await openThread(recent.id);
  else renderThread();
  renderChips();

  // the Claude Code sidebar writes into these same files; watch for its replies
  setInterval(watchThreads, 4000);

  // once the page is up, its highlights need the thread list to know what to link to
  firstPage.then(() => state.engine.paint && state.engine.paint()).catch(() => {});
})().catch((e) => toast('Failed to open: ' + e.message, 8000));
