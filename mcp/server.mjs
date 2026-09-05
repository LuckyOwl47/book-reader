#!/usr/bin/env node
/**
 * MCP bridge over the local book library.
 * Every tool takes an optional `book` slug; omitted, it uses the most recently opened book.
 */
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);
const lib = require('../server/library.js');
const questions = require('../server/questions.js');
const chats = require('../server/chats.js');

const MAX_CHARS = 40000;
const Q = '"""';

function resolveSlug(slug) {
  if (slug) {
    const b = lib.getBook(slug);
    if (!b) throw new Error(`no book "${slug}". Use list_books.`);
    return b;
  }
  const [first] = lib.listBooks();
  if (!first) throw new Error('the library is empty — add a book at http://localhost:4321');
  return first;
}

const bookArg = { book: { type: 'string', description: 'Book slug. Omit for the most recently opened book.' } };

const TOOLS = [
  {
    name: 'list_books',
    description: 'List every book in the library with its slug, format, length, and mark count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_book',
    description:
      'Overview of a book: title, author, length, table of contents, where the reader currently is, and how many passages are marked. Start here.',
    inputSchema: { type: 'object', properties: { ...bookArg } },
  },
  {
    name: 'get_marks',
    description:
      "The passages and figures the reader marked, with location, their own notes, and tags. This is the primary context for questions about 'this passage' or 'what I highlighted'. Marks flagged REGION CAPTURE are screenshots — call get_region_capture to actually see them.",
    inputSchema: {
      type: 'object',
      properties: {
        ...bookArg,
        kind: {
          type: 'string',
          enum: ['context', 'keep', 'chat', 'plain'],
          description: "Only marks of this kind. 'context' is what the reader pinned for the agent; 'keep' is their saved highlights.",
        },
        tag: { type: 'string', description: 'Only marks carrying this tag.' },
        from: { type: 'number', description: 'Only marks at or after this page/section.' },
        to: { type: 'number', description: 'Only marks at or before this page/section.' },
      },
    },
  },
  {
    name: 'get_region_capture',
    description:
      'Look at a region the reader screenshotted from the page — a figure, plot, diagram, table, or equation. Returns the actual image. Use it whenever the reader asks about a figure: the extracted page text holds only the caption, never the picture.',
    inputSchema: {
      type: 'object',
      properties: { ...bookArg, mark_id: { type: 'string', description: 'The mark id from get_marks.' } },
      required: ['mark_id'],
    },
  },
  {
    name: 'get_text',
    description:
      'Full extracted text of a page/section range — use it to read around a mark, or to read a chapter the reader is asking about.',
    inputSchema: {
      type: 'object',
      properties: {
        ...bookArg,
        from: { type: 'number', description: 'First page (PDF) or section (EPUB), 1-based.' },
        to: { type: 'number', description: 'Last page/section. Defaults to `from`.' },
      },
      required: ['from'],
    },
  },
  {
    name: 'search_book',
    description: 'Case-insensitive full-text search across the book; returns matching locations with surrounding context.',
    inputSchema: {
      type: 'object',
      properties: { ...bookArg, query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'list_chats',
    description: "The reader's in-app chat threads for a book, newest first, with titles and last message.",
    inputSchema: { type: 'object', properties: { ...bookArg } },
  },
  {
    name: 'read_chat',
    description: 'The full transcript of one in-app chat thread, so you can pick up where it left off.',
    inputSchema: {
      type: 'object',
      properties: { ...bookArg, chat_id: { type: 'string' } },
      required: ['chat_id'],
    },
  },
  {
    name: 'read_inbox',
    description:
      "Questions the reader filed from the reader app that have no answer yet. Check this when they say 'check my book inbox'.",
    inputSchema: { type: 'object', properties: { ...bookArg, all: { type: 'boolean', description: 'Include answered questions.' } } },
  },
  {
    name: 'answer_question',
    description: "Answer a question from read_inbox. The answer appears in the reader's Notes within a few seconds.",
    inputSchema: {
      type: 'object',
      properties: { ...bookArg, id: { type: 'string' }, answer: { type: 'string', description: 'Markdown.' } },
      required: ['id', 'answer'],
    },
  },
  {
    name: 'add_note',
    description: "Write a note beside the book — a summary, an explanation, anything worth keeping next to the text.",
    inputSchema: { type: 'object', properties: { ...bookArg, markdown: { type: 'string' } }, required: ['markdown'] },
  },
  {
    name: 'comment_on_mark',
    description:
      "Leave a note on one of the reader's marks — a correction, a pointer, something worth remembering next time they look at it. It shows up beside the passage in their reader and in CONTEXT.md.",
    inputSchema: {
      type: 'object',
      properties: { ...bookArg, mark_id: { type: 'string' }, comment: { type: 'string' } },
      required: ['mark_id', 'comment'],
    },
  },
  {
    name: 'add_mark',
    description:
      'Mark a passage on the reader\'s behalf. Copy the text verbatim from get_text so the reader app can highlight it in place.',
    inputSchema: {
      type: 'object',
      properties: {
        ...bookArg,
        unit: { type: 'number', description: 'Page (PDF) or section (EPUB) the passage is on.' },
        text: { type: 'string', description: 'The passage, verbatim.' },
        note: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        kind: {
          type: 'string',
          enum: ['context', 'keep', 'plain'],
          description: "'context' pins it in front of the in-app chat (purple); 'keep' saves it to the reader's highlights.md (green).",
        },
      },
      required: ['unit', 'text'],
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function clip(s) {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + `\n\n…[truncated at ${MAX_CHARS} chars — request a smaller range]` : s;
}

const KIND_LABEL = { context: 'pinned to context', keep: 'saved highlight', chat: 'chat anchor', plain: 'marked' };

function formatMarks(meta, marks) {
  if (!marks.length) return 'No marks yet.';
  return marks
    .map((m) => {
      const tags = m.tags && m.tags.length ? ' ' + m.tags.map((t) => '#' + t).join(' ') : '';
      const origin =
        m.source === 'chat'
          ? `cut from an in-app chat reply, near ${lib.unitLabel(meta, m.unit)} — NOT the book's own words`
          : lib.unitLabel(meta, m.unit);
      const head = `[${m.id}] ${origin} — ${KIND_LABEL[m.kind] || 'marked'}${tags}`;
      const note = (m.comments || [])
        .map((c) => `\n${c.by === 'agent' ? 'earlier agent note' : "reader's comment"}: ${c.text}`)
        .join('');
      if (m.type === 'region') {
        const near = m.text ? `\ntext inside the box: ${m.text}` : '';
        return `${head}\nREGION CAPTURE — a screenshot of part of the page. Call get_region_capture with mark_id "${m.id}" to see it.${near}${note}`;
      }
      return `${head}\n${Q}\n${m.text}\n${Q}${note}`;
    })
    .join('\n\n');
}

const handlers = {
  list_books() {
    const books = lib.listBooks();
    if (!books.length) return text('The library is empty. Add a book at http://localhost:4321');
    return text(
      books
        .map(
          (b) =>
            `${b.slug} — "${b.title}"${b.author ? ' by ' + b.author : ''} · ${b.format} · ${b.unitCount} ${b.unitName}s · ${lib.readMarks(b.slug).length} marks`
        )
        .join('\n')
    );
  },

  get_book({ book }) {
    const meta = resolveSlug(book);
    const pos = lib.getPosition(meta.slug);
    const marks = lib.readMarks(meta.slug);
    const byKind = marks.reduce((acc, m) => {
      const k = m.kind || 'plain';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const regions = marks.filter((m) => m.type === 'region').length;
    const toc = (meta.units || [])
      .filter((u) => u.chapter)
      .map((u) => `  ${meta.format === 'pdf' ? 'p.' : '§'}${u.index}: ${u.chapter}`)
      .join('\n');
    return text(
      [
        `${meta.title}${meta.author ? ' — ' + meta.author : ''}`,
        `slug: ${meta.slug} · ${meta.format} · ${meta.unitCount} ${meta.unitName}s`,
        `reader is at: ${lib.unitLabel(meta, pos.unit || 1)}`,
        `marks: ${marks.length}${Object.keys(byKind).length ? ' (' + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') + ')' : ''}${regions ? `, of which ${regions} are region captures` : ''}`,
        `chats: ${chats.listThreads(meta.slug).length}`,
        `files: library/${meta.slug}/ (CONTEXT.md, highlights.md, marks.jsonl, text/NNNN.txt, clips/, chats/)`,
        toc ? `\ncontents:\n${toc}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  },

  get_marks({ book, kind, tag, from, to }) {
    const meta = resolveSlug(book);
    let marks = lib.readMarks(meta.slug);
    if (kind) marks = marks.filter((m) => (m.kind || 'plain') === kind);
    if (tag) marks = marks.filter((m) => (m.tags || []).includes(tag));
    if (from) marks = marks.filter((m) => m.unit >= from);
    if (to) marks = marks.filter((m) => m.unit <= to);
    return text(clip(`${meta.title} — ${marks.length} mark(s)\n\n${formatMarks(meta, marks)}`));
  },

  get_region_capture({ book, mark_id }) {
    const meta = resolveSlug(book);
    const mark = lib.readMarks(meta.slug).find((m) => m.id === mark_id);
    if (!mark) throw new Error(`no mark "${mark_id}" — use get_marks`);
    if (mark.type !== 'region' || !mark.clipId) throw new Error(`mark ${mark_id} is a text passage, not a region capture`);
    const png = lib.readClip(meta.slug, mark.clipId);
    if (!png) throw new Error(`the image for ${mark_id} is missing from disk`);
    return {
      content: [
        { type: 'text', text: `Region captured from ${lib.unitLabel(meta, mark.unit)} of "${meta.title}":` },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },

  get_text({ book, from, to }) {
    const meta = resolveSlug(book);
    const a = Math.max(1, Number(from));
    const b = Math.min(meta.unitCount, Number(to || from));
    const parts = [];
    for (let i = a; i <= b; i++) {
      parts.push(
        `===== ${lib.unitLabel(meta, i)} =====\n${lib.readUnit(meta.slug, i) || '(no extractable text — this page may be a scan, or all figure)'}`
      );
    }
    return text(clip(parts.join('\n\n')));
  },

  search_book({ book, query, limit }) {
    const meta = resolveSlug(book);
    const hits = lib.searchBook(meta.slug, query, limit || 20);
    if (!hits.length) return text(`No matches for "${query}" in ${meta.title}.`);
    return text(clip(hits.map((h) => `${h.label}: …${h.excerpt}…`).join('\n\n')));
  },

  list_chats({ book }) {
    const meta = resolveSlug(book);
    const threads = chats.listThreads(meta.slug);
    if (!threads.length) return text('No in-app chats for this book yet.');
    return text(
      threads.map((t) => `[${t.id}] ${t.title} — ${t.messageCount} message(s), updated ${t.updatedAt}\n  ${t.preview}`).join('\n\n')
    );
  },

  read_chat({ book, chat_id }) {
    const meta = resolveSlug(book);
    const thread = chats.getThread(meta.slug, chat_id);
    if (!thread) throw new Error(`no chat "${chat_id}" — use list_chats`);
    const body = thread.messages
      .map((m) => {
        const who = m.role === 'user' ? 'Reader' : 'Claude';
        const parts = (m.blocks || []).map((b) => {
          if (b.type === 'text') return b.text;
          if (b.type === 'quote') return `[quoted ${b.label || ''}]\n${Q}\n${b.text}\n${Q}`;
          if (b.type === 'clip') return '[attached a region capture]';
          return '';
        });
        return `${who}: ${parts.filter(Boolean).join('\n')}`;
      })
      .join('\n\n');
    return text(clip(`"${thread.title}"\n\n${body}`));
  },

  read_inbox({ book, all }) {
    const meta = resolveSlug(book);
    const qs = questions.readAll(meta.slug).filter((q) => all || !q.answeredAt);
    if (!qs.length) return text('Nothing pending.');
    const marks = lib.readMarks(meta.slug);
    return text(
      qs
        .map((q) => {
          const m = marks.find((x) => x.id === q.markId);
          return [
            `[${q.id}] ${q.unit ? lib.unitLabel(meta, q.unit) : ''} ${q.answeredAt ? '(answered)' : ''}`.trim(),
            `Q: ${q.text}`,
            m ? `about this passage:\n${Q}\n${m.text}\n${Q}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n')
    );
  },

  answer_question({ book, id, answer }) {
    const meta = resolveSlug(book);
    const rec = questions.answer(meta.slug, id, answer);
    if (!rec) throw new Error(`no question "${id}" — use read_inbox`);
    return text(`Answered ${id}; it is now in the reader's "${chats.SIDEBAR_TITLE}" chat in the app.`);
  },

  add_note({ book, markdown }) {
    const meta = resolveSlug(book);
    lib.appendNote(meta.slug, markdown);
    chats.postFromSidebar(meta.slug, markdown);
    return text(`Posted to the reader's "${chats.SIDEBAR_TITLE}" chat in the app (and appended to notes.md).`);
  },

  comment_on_mark({ book, mark_id, comment }) {
    const meta = resolveSlug(book);
    const rec = lib.addComment(meta.slug, mark_id, comment, 'agent');
    if (!rec) throw new Error(`no mark "${mark_id}", or the comment was empty — use get_marks`);
    return text(`Left a note on ${mark_id} (${lib.unitLabel(meta, rec.unit)}).`);
  },

  add_mark({ book, unit, text: passage, note, tags, kind }) {
    const meta = resolveSlug(book);
    const page = lib.readUnit(meta.slug, unit) || '';
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const found = norm(page).includes(norm(passage));
    const m = lib.addMark(meta.slug, { unit, text: passage, note, tags, kind: kind || 'plain' });
    return text(
      `Marked ${lib.unitLabel(meta, unit)} as ${m.id} (${KIND_LABEL[m.kind]}).` +
        (found ? '' : ` Warning: that text was not found on ${lib.unitLabel(meta, unit)}, so the reader app cannot highlight it in place.`)
    );
  },
};

const server = new Server({ name: 'book-reader', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = handlers[req.params.name];
  if (!fn) throw new Error(`unknown tool ${req.params.name}`);
  try {
    return await fn(req.params.arguments || {});
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
