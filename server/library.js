'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY_DIR = path.join(ROOT, 'library');
const BOOKS_DIR = path.join(ROOT, 'books');

fs.mkdirSync(LIBRARY_DIR, { recursive: true });
fs.mkdirSync(BOOKS_DIR, { recursive: true });

function slugify(name) {
  const base = name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'book';
}

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (fs.existsSync(path.join(LIBRARY_DIR, slug))) slug = `${base}-${n++}`;
  return slug;
}

function bookDir(slug) {
  const dir = path.join(LIBRARY_DIR, slug);
  // guard against traversal via crafted slugs
  if (path.dirname(dir) !== LIBRARY_DIR) throw new Error('bad slug');
  return dir;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function listBooks() {
  return fs
    .readdirSync(LIBRARY_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJSON(path.join(LIBRARY_DIR, d.name, 'meta.json'), null))
    .filter(Boolean)
    .sort((a, b) => (b.lastOpenedAt || b.addedAt || '').localeCompare(a.lastOpenedAt || a.addedAt || ''));
}

function getBook(slug) {
  return readJSON(path.join(bookDir(slug), 'meta.json'), null);
}

function saveBook(meta) {
  writeJSON(path.join(bookDir(meta.slug), 'meta.json'), meta);
  return meta;
}

// ---------- units (pages for PDF, spine sections for EPUB) ----------

function unitFile(slug, index) {
  return path.join(bookDir(slug), 'text', String(index).padStart(4, '0') + '.txt');
}

function readUnit(slug, index) {
  try {
    return fs.readFileSync(unitFile(slug, index), 'utf8');
  } catch {
    return null;
  }
}

function writeUnit(slug, index, text) {
  const dir = path.join(bookDir(slug), 'text');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(unitFile(slug, index), text);
}

function unitLabel(meta, index) {
  if (meta.format === 'pdf') return `p.${index}`;
  const entry = (meta.units || []).find((u) => u.index === index);
  return entry && entry.chapter ? `§${index} · ${entry.chapter}` : `section ${index}`;
}

// ---------- marks ----------

function marksFile(slug) {
  return path.join(bookDir(slug), 'marks.jsonl');
}

/** Replays the append-only log; later records for an id win, tombstones remove. */
function readMarks(slug) {
  let raw = '';
  try {
    raw = fs.readFileSync(marksFile(slug), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || !rec.id) continue;
    if (rec.deleted) byId.delete(rec.id);
    else byId.set(rec.id, { ...(byId.get(rec.id) || {}), ...rec });
  }
  return [...byId.values()]
    // marks written before kinds existed: keep them, don't reinterpret them
    .map((m) => ({
      ...m,
      type: m.type || (m.clipId ? 'region' : 'text'),
      kind: m.kind || 'plain',
      source: m.source || 'book',
      threadId: m.threadId === undefined ? null : m.threadId,
      color: m.color || 'yellow',
      // marks written before comments existed carried a single `note`
      comments:
        m.comments || (m.note ? [{ id: 'note', text: m.note, at: m.createdAt, by: 'reader' }] : []),
    }))
    .sort((a, b) => (a.unit || 0) - (b.unit || 0) || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function appendMark(slug, rec) {
  fs.appendFileSync(marksFile(slug), JSON.stringify(rec) + '\n');
}

/** kind drives both colour and what the mark is *for*. */
const KIND_COLOR = { context: 'purple', keep: 'green', chat: 'blue', plain: 'yellow' };

function addMark(slug, input) {
  const kind = KIND_COLOR[input.kind] ? input.kind : 'plain';
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    type: input.clipId ? 'region' : 'text',
    kind,
    // 'chat' marks are cut from a reply, not from the book — they must never be
    // presented as if the author wrote them
    source: input.source === 'chat' ? 'chat' : 'book',
    // which chat this pin belongs to; null means every chat sees it
    threadId: input.threadId || null,
    unit: Number(input.unit) || 1,
    text: String(input.text || '').trim(),
    note: input.note ? String(input.note) : '',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    color: input.color || KIND_COLOR[kind],
    clipId: input.clipId || null,
    rect: input.rect || null,
    cfi: input.cfi || null,
    createdAt: new Date().toISOString(),
  };
  appendMark(slug, rec);
  rebuildContext(slug);
  return rec;
}

function updateMark(slug, id, patch) {
  const existing = readMarks(slug).find((m) => m.id === id);
  if (!existing) return null;
  const rec = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
  appendMark(slug, rec);
  rebuildContext(slug);
  return rec;
}

function addComment(slug, id, text, by = 'reader') {
  const mark = readMarks(slug).find((m) => m.id === id);
  if (!mark) return null;
  const comment = {
    id: crypto.randomBytes(4).toString('hex'),
    text: String(text || '').trim(),
    at: new Date().toISOString(),
    by,
  };
  if (!comment.text) return null;
  return updateMark(slug, id, { comments: [...(mark.comments || []), comment] });
}

function deleteComment(slug, id, commentId) {
  const mark = readMarks(slug).find((m) => m.id === id);
  if (!mark) return null;
  return updateMark(slug, id, { comments: (mark.comments || []).filter((c) => c.id !== commentId) });
}

function deleteMark(slug, id) {
  appendMark(slug, { id, deleted: true, deletedAt: new Date().toISOString() });
  rebuildContext(slug);
}

// ---------- clips (region captures) ----------

function clipPath(slug, clipId) {
  const file = path.join(bookDir(slug), 'clips', path.basename(clipId) + '.png');
  if (path.dirname(file) !== path.join(bookDir(slug), 'clips')) throw new Error('bad clip id');
  return file;
}

function saveClip(slug, buffer) {
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.join(bookDir(slug), 'clips'), { recursive: true });
  fs.writeFileSync(clipPath(slug, id), buffer);
  return id;
}

function readClip(slug, clipId) {
  try {
    return fs.readFileSync(clipPath(slug, clipId));
  } catch {
    return null;
  }
}

// ---------- CONTEXT.md (the human/agent-readable digest) ----------

function rebuildContext(slug) {
  const meta = getBook(slug);
  if (!meta) return;
  const marks = readMarks(slug);
  const pos = readJSON(path.join(bookDir(slug), 'position.json'), {});
  const lines = [];
  lines.push(`# ${meta.title}`);
  if (meta.author) lines.push(`*${meta.author}*`);
  lines.push('');
  lines.push(
    `${meta.format.toUpperCase()} · ${meta.unitCount} ${meta.format === 'pdf' ? 'pages' : 'sections'} · ${marks.length} mark${marks.length === 1 ? '' : 's'}`
  );
  if (pos.unit) lines.push(`Reader is currently at **${unitLabel(meta, pos.unit)}**.`);
  lines.push('');
  lines.push(`Full text: \`library/${slug}/text/NNNN.txt\` (one file per ${meta.format === 'pdf' ? 'page' : 'section'}).`);
  lines.push('');
  const sections = [
    ['context', 'Pinned to context', 'The reader put these in front of the agent deliberately.'],
    ['keep', 'Saved highlights', 'Kept for the reader\'s own notes.'],
    ['chat', 'Chat anchors', 'Passages a side chat was started from.'],
    ['plain', 'Other marks', ''],
  ];

  if (!marks.length) {
    lines.push('_No marks yet._');
  } else {
    for (const [kind, heading, blurb] of sections) {
      const group = marks.filter((m) => (m.kind || 'plain') === kind);
      if (!group.length) continue;
      lines.push(`## ${heading}`);
      if (blurb) lines.push(`_${blurb}_`);
      lines.push('');
      for (const m of group) lines.push(...markBlock(meta, m));
    }
  }
  fs.writeFileSync(path.join(bookDir(slug), 'CONTEXT.md'), lines.join('\n') + '\n');
  rebuildHighlights(slug, meta, marks);
}

function markBlock(meta, m) {
  const out = [];
  const tags = m.tags && m.tags.length ? ' ' + m.tags.map((t) => `#${t}`).join(' ') : '';
  const where = m.source === 'chat' ? `from a chat reply, near ${unitLabel(meta, m.unit)}` : unitLabel(meta, m.unit);
  out.push(`### [${m.id}] ${where}${tags}`);
  out.push('');
  if (m.source === 'chat') {
    out.push('_Cut from the assistant\'s own reply, not from the book._');
    out.push('');
  }
  if (m.type === 'region') {
    out.push(`![region capture](clips/${m.clipId}.png)`);
    out.push('');
    out.push('_A screenshot of the page — a figure, plot, or table. Ask the agent to look at it._');
    out.push('');
  }
  if (m.text) {
    out.push(m.text.split('\n').map((l) => '> ' + l).join('\n'));
    out.push('');
  }
  for (const c of m.comments || []) {
    out.push(`**${c.by === 'agent' ? 'Agent note' : "Reader's comment"}** (${(c.at || '').slice(0, 10)}): ${c.text}`);
    out.push('');
  }
  return out;
}

/** highlights.md is the take-away digest: only what the reader chose to keep. */
function rebuildHighlights(slug, meta, marks) {
  const keep = marks.filter((m) => m.kind === 'keep');
  const lines = [`# ${meta.title} — highlights`];
  if (meta.author) lines.push(`*${meta.author}*`);
  lines.push('');
  if (!keep.length) {
    lines.push('_Nothing saved yet._');
  } else {
    for (const m of keep) {
      if (m.type === 'region') lines.push(`![${unitLabel(meta, m.unit)}](clips/${m.clipId}.png)`);
      else lines.push(m.text.split('\n').map((l) => '> ' + l).join('\n'));
      lines.push('');
      for (const c of m.comments || []) lines.push(c.text + '\n');
      lines.push(
        m.source === 'chat'
          ? `— from a chat about ${meta.title}, ${unitLabel(meta, m.unit)}`
          : `— ${meta.title}, ${unitLabel(meta, m.unit)}`
      );
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(bookDir(slug), 'highlights.md'), lines.join('\n') + '\n');
}

// ---------- position & notes ----------

function getPosition(slug) {
  return readJSON(path.join(bookDir(slug), 'position.json'), { unit: 1 });
}

function setPosition(slug, pos) {
  const rec = { ...pos, updatedAt: new Date().toISOString() };
  writeJSON(path.join(bookDir(slug), 'position.json'), rec);
  const meta = getBook(slug);
  if (meta) saveBook({ ...meta, lastOpenedAt: rec.updatedAt });
  return rec;
}

function notesFile(slug) {
  return path.join(bookDir(slug), 'notes.md');
}

function getNotes(slug) {
  try {
    return fs.readFileSync(notesFile(slug), 'utf8');
  } catch {
    return '';
  }
}

function appendNote(slug, markdown) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const block = `\n---\n### ${stamp}\n\n${markdown.trim()}\n`;
  fs.appendFileSync(notesFile(slug), block);
  return getNotes(slug);
}

// ---------- search ----------

function searchBook(slug, query, limit = 20) {
  const meta = getBook(slug);
  if (!meta) return [];
  const needle = query.toLowerCase();
  const hits = [];
  for (let i = 1; i <= meta.unitCount && hits.length < limit; i++) {
    const text = readUnit(slug, i);
    if (!text) continue;
    const hay = text.toLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      hits.push({
        unit: i,
        label: unitLabel(meta, i),
        excerpt: text.slice(Math.max(0, at - 160), at + needle.length + 160).replace(/\s+/g, ' ').trim(),
      });
      from = at + needle.length;
    }
  }
  return hits;
}

module.exports = {
  ROOT,
  LIBRARY_DIR,
  BOOKS_DIR,
  slugify,
  uniqueSlug,
  bookDir,
  readJSON,
  writeJSON,
  listBooks,
  getBook,
  saveBook,
  readUnit,
  writeUnit,
  unitLabel,
  readMarks,
  addMark,
  updateMark,
  addComment,
  deleteComment,
  deleteMark,
  rebuildContext,
  clipPath,
  saveClip,
  readClip,
  getPosition,
  setPosition,
  getNotes,
  appendNote,
  searchBook,
};
