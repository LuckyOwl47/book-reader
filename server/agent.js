'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const lib = require('./library');
const related = require('./related');
const chats = require('./chats');

const MODEL = process.env.BOOK_READER_MODEL || 'claude-opus-5';
const MAX_PAGE_CHARS = 6000;
const MAX_NEARBY_CHARS = 3000;
const MAX_RECENT_CHARS = 600;

const SYSTEM = `You are the reading companion for one specific book. The reader is reading it right now, in a reader app beside you, and marks passages and screenshots figures for you to look at.

Answer first, then stop. Your opening sentence carries the actual answer — the verdict, the number, the mechanism. Never open by characterizing the question, the passage, or what kind of claim the book is making. If the honest answer is "partly", lead with what is true and what is not, in that order, then explain.

Your last paragraph is load-bearing too. End on substance, mid-thought if need be. Do not append a closing paragraph that reframes the question, tells the reader how to read the passage, or offers a further irony, curiosity, or "one thing worth noting" — however tempting. If a fact deserves the reader's attention, work it into the body; if it does not fit there, leave it out.

- Ground answers in what you were given: the pinned passages, the region captures, the page text. If something isn't there, say so rather than filling it in from memory. Knowledge from outside the book is welcome and needs no announcement — flag it only where it actually contradicts the book.
- A region capture is a screenshot of part of the page: a plot, a diagram, a table, an equation. Read it as the reader sees it and describe what is actually there — axes, curves, labels, intersections — not what a figure with that caption usually shows.
- Quote exactly when you quote, and name the page or section.
- You are in a narrow side panel. Short paragraphs. No headings, and no lists unless the content is genuinely a list.
- The panel renders LaTeX through KaTeX. Use $...$ for inline maths and $$...$$ on its own lines for displayed equations, and write anything with a fraction, an exponent, a subscript, an integral or a dot-derivative that way. Keep short bare symbols as plain text - saying x, r or f(x) mid-sentence needs no delimiters. KaTeX is maths-only: no \\text{} paragraphs, no \\begin{document}.
- The reader is mid-page and mid-thought. Match their level: if they are working through a derivation, work through it with them rather than summarizing it from above.`;

function hasCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
  } catch {
    return false;
  }
}

let client = null;
function getClient() {
  if (!hasCredentials()) {
    const err = new Error(
      'No Anthropic credentials. Put ANTHROPIC_API_KEY=sk-ant-... in .env at the project root and restart, or run `ant auth login`.'
    );
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  if (!client) client = new Anthropic();
  return client;
}

/** The stable half of the prompt — cheap to cache, changes only per book. */
function bookFacts(meta, unit) {
  const toc = (meta.units || [])
    .filter((u) => u.chapter)
    .map((u) => `  ${meta.format === 'pdf' ? 'p.' : '§'}${u.index}: ${u.chapter}`)
    .join('\n');
  return [
    `Book: "${meta.title}"${meta.author ? ` by ${meta.author}` : ''}`,
    `${meta.unitCount} ${meta.unitName}s. The reader is on ${lib.unitLabel(meta, unit)}.`,
    toc ? `\nContents:\n${toc}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Everything the reader has put in front of us, as content blocks: pinned marks,
 * this thread's anchors, and optionally the page they're looking at.
 */
function contextBlocks(
  slug,
  meta,
  {
    anchors = [],
    unit,
    includePage = true,
    threadId = null,
    mutedPins = [],
    nearby = false,
    recent = 0,
    slugForChats = null,
  }
) {
  const marks = lib.readMarks(slug);
  // A pin belongs to the chat it was made in. Only pins with no thread are global —
  // otherwise every side chat inherits every other side chat's context. On top of that
  // the reader can switch any pin off for this chat alone, without unpinning it.
  const muted = new Set(mutedPins);
  const chosen = marks.filter(
    (m) =>
      (m.kind === 'context' && (!m.threadId || m.threadId === threadId) && !muted.has(m.id)) ||
      anchors.includes(m.id)
  );
  const blocks = [];

  if (chosen.length) {
    blocks.push({ type: 'text', text: 'The reader pinned these for you:' });
    for (const m of chosen) {
      const origin =
        m.source === 'chat'
          ? `from one of your earlier replies, while the reader was on ${lib.unitLabel(meta, m.unit)}`
          : lib.unitLabel(meta, m.unit);
      const notes = (m.comments || [])
        .map((c) => `\n  ${c.by === 'agent' ? 'earlier note' : "reader's comment"}: ${c.text}`)
        .join('');
      const head = `[${m.id}] ${origin}${notes}`;
      if (m.type === 'region' && m.clipId) {
        const png = lib.readClip(slug, m.clipId);
        if (png) {
          blocks.push({ type: 'text', text: `${head} — region capture from the page:` });
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          });
          continue;
        }
      }
      blocks.push({ type: 'text', text: `${head}\n"""\n${m.text}\n"""` });
    }
  }

  if (includePage && unit) {
    const page = lib.readUnit(slug, unit);
    if (page) {
      const body = page.length > MAX_PAGE_CHARS ? page.slice(0, MAX_PAGE_CHARS) + '\n…[page truncated]' : page;
      blocks.push({
        type: 'text',
        text: `Text of ${lib.unitLabel(meta, unit)}, the page the reader is on:\n"""\n${body}\n"""`,
      });
    }
  }

  // The pages either side of the one they are on. A passage's argument routinely starts
  // on the page before and lands on the page after, and the reader should not have to
  // page back and forth to hand us the rest of it.
  if (nearby && unit) {
    for (const i of [unit - 1, unit + 1]) {
      if (i < 1 || i > meta.unitCount || i === unit) continue;
      const page = lib.readUnit(slug, i);
      if (!page) continue;
      const body =
        page.length > MAX_NEARBY_CHARS ? page.slice(0, MAX_NEARBY_CHARS) + '\n…[truncated]' : page;
      blocks.push({
        type: 'text',
        text: `Text of ${lib.unitLabel(meta, i)}, the ${i < unit ? 'previous' : 'next'} ${meta.unitName}:\n\"\"\"\n${body}\n\"\"\"`,
      });
    }
  }

  // The last few things they marked anywhere in the book — not pinned, but recent enough
  // to be what they are still thinking about.
  if (recent > 0) {
    const skip = new Set([...anchors, ...chosen.map((m) => m.id)]);
    // a chat mark does not name its thread; the thread names the mark, in `anchors`
    const openerFor = new Map();
    if (slugForChats) {
      for (const t of chats.listThreads(slugForChats)) {
        for (const a of t.anchors || []) if (t.opening) openerFor.set(a, t.opening);
      }
    }
    const pool = marks
      .filter((m) => m.kind !== 'context' && !skip.has(m.id))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, recent);
    if (pool.length) {
      const lines = pool.map((m) => {
        const body = (m.text || '').slice(0, MAX_RECENT_CHARS);
        let head = `${lib.unitLabel(meta, m.unit)}`;
        if (m.type === 'region') head += ' — a region they captured';
        if (m.kind === 'keep') head += ' — saved to their highlights';
        if (m.kind === 'chat') {
          const opener = openerFor.get(m.id);
          head += opener
            ? ` — they started a side chat here, asking: ${opener.replace(/\s+/g, ' ').slice(0, 140)}`
            : ' — they started a side chat here';
        }
        if (m.note) head += `\n  their note: ${m.note}`;
        return `${head}\n  \"\"\"\n  ${body}\n  \"\"\"`;
      });
      blocks.push({
        type: 'text',
        text: `The last ${pool.length} ${pool.length === 1 ? 'passage' : 'passages'} they marked, most recent first — background, not necessarily what they are asking about:\n\n${lines.join('\n\n')}`,
      });
    }
  }

  if (!blocks.length) blocks.push({ type: 'text', text: '(The reader has not pinned anything yet.)' });
  return blocks;
}

/** Turn a stored message into Anthropic content blocks, inlining any clips. */
function toApiContent(slug, message) {
  const out = [];
  for (const b of message.blocks || []) {
    if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
    else if (b.type === 'quote') out.push({ type: 'text', text: `Quoting ${b.label || ''}:\n"""\n${b.text}\n"""` });
    else if (b.type === 'clip' && b.clipId) {
      const png = lib.readClip(slug, b.clipId);
      if (png) {
        out.push({ type: 'text', text: 'Region captured from the page:' });
        out.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
      }
    }
  }
  return out.length ? out : [{ type: 'text', text: '(empty)' }];
}

function buildMessages(slug, meta, thread, opts) {
  const messages = [
    { role: 'user', content: contextBlocks(slug, meta, opts) },
    {
      role: 'assistant',
      content: "I've read what you pinned and I'm looking at the page with you. What would you like to know?",
    },
  ];
  for (const m of thread.messages) {
    messages.push({ role: m.role, content: m.role === 'user' ? toApiContent(slug, m) : blocksToText(m) });
  }
  return messages;
}

function blocksToText(message) {
  const text = (message.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || '(no answer)';
}

/**
 * Stream one assistant turn. `handlers` gets {onText, onThinking}; resolves with
 * the finished text plus usage.
 */
const NAVIGATE = `Navigation mode, for this turn only.

Below is a keyword shortlist: passages elsewhere in the book that share uncommon vocabulary with what the reader selected. It is retrieval, not judgement — some entries will be coincidental overlap.

Say which of them actually bear on the reader's question, at most five, one short line each: what that passage adds that the current one does not. Name every location the way it appears below (p.12, or §3) so the reader can click through to it. Put the most useful first. Say plainly if a listed passage is only a word-level coincidence, and if none of them are relevant say that instead of padding the list.`;

const BRIEF = `Brief mode, for this turn: at most four sentences total. State the answer and the single most important reason for it. No examples, no history, no caveats you were not asked for, no closing remark.`;

/** The text of the reader's last turn, used as the retrieval query. */
function lastUserQuery(thread) {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m.role !== 'user') continue;
    return (m.blocks || [])
      .filter((b) => b.type === 'text' || b.type === 'quote')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

async function streamTurn(
  { slug, thread, unit, includePage = true, brief = false, navigate = false, nearby = false, recent = 0 },
  handlers = {}
) {
  const meta = lib.getBook(slug);
  const anthropic = getClient();

  const messages = buildMessages(slug, meta, thread, {
    anchors: thread.anchors,
    unit,
    includePage,
    threadId: thread.id,
    mutedPins: thread.mutedPins || [],
    nearby,
    recent,
    slugForChats: slug,
  });
  // A trailing system message steers this turn without editing the cached prefix,
  // so toggling brief mode costs nothing in cache.
  if (brief) messages.push({ role: 'system', content: BRIEF });

  if (navigate) {
    const hits = related.relatedUnits(slug, lastUserQuery(thread), { exclude: [unit], limit: 8 });
    const list = hits.length
      ? hits
          .map((h) => `${lib.unitLabel(meta, h.unit)} (${h.matched} shared terms)\n  …${h.excerpt}…`)
          .join('\n\n')
      : '(nothing in the book shares enough uncommon vocabulary with this passage.)';
    messages.push({ role: 'system', content: `${NAVIGATE}\n\nShortlist:\n\n${list}` });
  }

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive', display: 'summarized' },
    cache_control: { type: 'ephemeral' },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: bookFacts(meta, unit) },
    ],
    messages,
  });

  stream.on('text', (delta) => handlers.onText && handlers.onText(delta));
  stream.on('thinking', (delta) => handlers.onThinking && handlers.onThinking(delta));

  const final = await stream.finalMessage();
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const thinking = final.content
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking)
    .filter(Boolean)
    .join('\n');
  return { text, thinking, usage: final.usage, stopReason: final.stop_reason };
}

/** A short definition of a term, in the context of the sentence it came from. */
async function define({ slug, term, sentence, unit }) {
  const meta = lib.getBook(slug);
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: 'low' },
    system: `You define terms for someone reading "${meta.title}"${meta.author ? ` by ${meta.author}` : ''}. Give the meaning the term carries in this book and this field — two or three sentences, no preamble, no restating the question. If the term is standard notation or a named result, say what it denotes and where it comes from. If the sentence is too little to disambiguate, give the most likely reading and say what you assumed.`,
    messages: [
      {
        role: 'user',
        content: `Term: "${term}"\n\nThe sentence it appears in, on ${lib.unitLabel(meta, unit)}:\n"""\n${sentence}\n"""`,
      },
    ],
  });
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

module.exports = { streamTurn, define, hasCredentials, MODEL };
