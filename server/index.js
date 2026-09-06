'use strict';
require('./env').loadEnv(require('path').resolve(__dirname, '..'));

const express = require('express');
const path = require('path');
const fs = require('fs');
const lib = require('./library');
const { ingest, scanDropFolder } = require('./ingest');
const questions = require('./questions');
const chats = require('./chats');
const agent = require('./agent');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 4321);

// ---- static: app + vendored reader libraries
app.use(express.static(path.join(lib.ROOT, 'web')));
app.use('/vendor/pdfjs', express.static(path.join(lib.ROOT, 'node_modules/pdfjs-dist')));
app.use('/vendor/epubjs', express.static(path.join(lib.ROOT, 'node_modules/epubjs/dist')));
app.use('/vendor/jszip', express.static(path.join(lib.ROOT, 'node_modules/jszip/dist')));
app.use('/vendor/katex', express.static(path.join(lib.ROOT, 'node_modules/katex/dist')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

function requireBook(req, res) {
  const meta = lib.getBook(req.params.slug);
  if (!meta) {
    res.status(404).json({ error: 'no such book' });
    return null;
  }
  return meta;
}

// ---- library
app.get('/api/books', (req, res) => res.json(lib.listBooks()));

app.post('/api/books/scan', wrap(async (req, res) => res.json(await scanDropFolder())));

app.post('/api/books/ingest', wrap(async (req, res) => res.json(await ingest(req.body.path))));

// raw upload from the library page's drop zone: body is the file bytes
app.post(
  '/api/books/upload',
  express.raw({ type: '*/*', limit: '512mb' }),
  wrap(async (req, res) => {
    const name = path.basename(String(req.query.name || 'book.pdf'));
    if (!/\.(pdf|epub)$/i.test(name)) throw new Error('only .pdf and .epub files');
    const dest = path.join(lib.BOOKS_DIR, name);
    fs.writeFileSync(dest, req.body);
    res.json(await ingest(dest));
  })
);

app.get('/api/books/:slug', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json({ ...meta, position: lib.getPosition(meta.slug), marks: lib.readMarks(meta.slug) });
});

app.delete('/api/books/:slug', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  fs.rmSync(lib.bookDir(meta.slug), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/books/:slug/file', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.sendFile(path.join(lib.bookDir(meta.slug), meta.file));
});

// ---- text + search
app.get('/api/books/:slug/text', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const from = Math.max(1, Number(req.query.from || req.query.unit || 1));
  const to = Math.min(meta.unitCount, Number(req.query.to || from));
  const out = [];
  for (let i = from; i <= to; i++) out.push({ unit: i, label: lib.unitLabel(meta, i), text: lib.readUnit(meta.slug, i) || '' });
  res.json(out);
});

app.get('/api/books/:slug/search', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(lib.searchBook(meta.slug, String(req.query.q || ''), Number(req.query.limit || 20)));
});

// ---- marks
app.get('/api/books/:slug/marks', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(lib.readMarks(meta.slug));
});

app.post('/api/books/:slug/marks', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(lib.addMark(meta.slug, req.body));
});

app.patch('/api/books/:slug/marks/:id', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const rec = lib.updateMark(meta.slug, req.params.id, req.body);
  if (!rec) return res.status(404).json({ error: 'no such mark' });
  res.json(rec);
});

app.post('/api/books/:slug/marks/:id/comments', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const rec = lib.addComment(meta.slug, req.params.id, (req.body || {}).text);
  if (!rec) return res.status(400).json({ error: 'no such mark, or empty comment' });
  res.json(rec);
});

app.delete('/api/books/:slug/marks/:id/comments/:commentId', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const rec = lib.deleteComment(meta.slug, req.params.id, req.params.commentId);
  if (!rec) return res.status(404).json({ error: 'no such mark' });
  res.json(rec);
});

app.delete('/api/books/:slug/marks/:id', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  lib.deleteMark(meta.slug, req.params.id);
  res.json({ ok: true });
});

// ---- position
app.get('/api/books/:slug/position', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(lib.getPosition(meta.slug));
});

app.put('/api/books/:slug/position', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const pos = lib.setPosition(meta.slug, req.body);
  lib.rebuildContext(meta.slug);
  res.json(pos);
});

// ---- notes (agent -> reader) and questions (reader -> agent)
app.get('/api/books/:slug/notes', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json({ markdown: lib.getNotes(meta.slug) });
});

app.get('/api/books/:slug/questions', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(questions.readAll(meta.slug));
});

app.post('/api/books/:slug/questions', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(questions.ask(meta.slug, req.body));
});

// nothing is open at boot, so any chat still sitting empty was abandoned
for (const b of lib.listBooks()) chats.collapseEmpty(b.slug);

// keep the digests in step with the current formatting rules
for (const b of lib.listBooks()) lib.rebuildContext(b.slug);

// ---- clips (region captures)
app.post(
  '/api/books/:slug/clips',
  express.raw({ type: '*/*', limit: '20mb' }),
  (req, res) => {
    const meta = requireBook(req, res);
    if (!meta) return;
    const id = lib.saveClip(meta.slug, req.body);
    res.json({ clipId: id, url: `/api/books/${meta.slug}/clips/${id}` });
  }
);

app.get('/api/books/:slug/clips/:id', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const png = lib.readClip(meta.slug, req.params.id);
  if (!png) return res.status(404).end();
  res.type('png').send(png);
});

// ---- chat threads
app.get('/api/books/:slug/chats', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(chats.listThreads(meta.slug));
});

app.post('/api/books/:slug/chats', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(chats.createThread(meta.slug, req.body));
});

app.get('/api/books/:slug/chats/:id', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const t = chats.getThread(meta.slug, req.params.id);
  if (!t) return res.status(404).json({ error: 'no such chat' });
  res.json(t);
});

// switch one pinned mark off (or back on) for this chat alone
app.post('/api/books/:slug/chats/:id/pins/:markId', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const t = chats.mutePin(meta.slug, req.params.id, req.params.markId, !!(req.body || {}).muted);
  if (!t) return res.status(404).json({ error: 'no such chat' });
  res.json(t);
});

// leaving a chat you never asked anything in: drop it, keep the passage as a plain mark
app.post('/api/books/:slug/chats/:id/collapse', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  res.json(chats.collapseIfEmpty(meta.slug, req.params.id));
});

app.delete('/api/books/:slug/chats/:id', (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  chats.deleteThread(meta.slug, req.params.id, { keepAnchors: req.query.keep === '1' });
  res.json({ ok: true });
});

// ---- one assistant turn, streamed back over SSE
app.post('/api/books/:slug/chats/:id/messages', async (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const slug = meta.slug;
  const {
    blocks = [],
    unit,
    includePage = true,
    brief = false,
    navigate = false,
    nearby = false,
    recent = 0,
    model,
  } = req.body || {};

  let thread = chats.appendMessage(slug, req.params.id, { role: 'user', blocks });
  if (!thread) return res.status(404).json({ error: 'no such chat' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await agent.streamTurn(
      {
        slug,
        thread,
        unit: unit || lib.getPosition(slug).unit,
        includePage,
        brief,
        navigate,
        nearby,
        recent: Math.min(Number(recent) || 0, 12),
        model: model || agent.MODEL,
      },
      {
        onText: (t) => send('text', { t }),
        onThinking: (t) => send('thinking', { t }),
      }
    );
    chats.appendMessage(slug, thread.id, {
      role: 'assistant',
      blocks: [{ type: 'text', text: result.text }],
      thinking: result.thinking || undefined,
      usage: result.usage,
      model: result.model,
    });
    send('done', { usage: result.usage, stopReason: result.stopReason });
  } catch (err) {
    // the user's turn is already saved; record why nothing came back
    chats.appendMessage(slug, thread.id, {
      role: 'assistant',
      blocks: [{ type: 'text', text: `_${err.message}_` }],
      error: true,
    });
    send('error', { message: err.message, code: err.code || null });
  }
  res.end();
});

// ---- define a term
app.post('/api/books/:slug/define', wrap(async (req, res) => {
  const meta = requireBook(req, res);
  if (!meta) return;
  const { term, sentence, unit } = req.body || {};
  const text = await agent.define({ slug: meta.slug, term, sentence, unit: unit || 1 });
  res.json({ term, text });
}));

// ---- is there a model behind the chat at all?
app.get('/api/agent/status', (req, res) => {
  const models = agent.MODELS.map((m) => ({ ...m, available: agent.hasCredentials(m.id) }));
  res.json({
    available: models.some((m) => m.available),
    model: agent.MODEL,
    models,
  });
});

app.listen(PORT, () => {
  console.log(`book-reader on http://localhost:${PORT}`);
});
