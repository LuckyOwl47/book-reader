'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');

function chatsDir(slug) {
  const dir = path.join(lib.bookDir(slug), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function threadPath(slug, id) {
  const file = path.join(chatsDir(slug), path.basename(id) + '.json');
  if (path.dirname(file) !== chatsDir(slug)) throw new Error('bad thread id');
  return file;
}

function listThreads(slug) {
  return fs
    .readdirSync(chatsDir(slug))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const t = lib.readJSON(path.join(chatsDir(slug), f), null);
      if (!t) return null;
      const last = t.messages[t.messages.length - 1];
      const opener = t.messages.find((m) => m.role === 'user');
      return {
        id: t.id,
        title: t.title,
        anchors: t.anchors || [],
        mutedPins: t.mutedPins || [],
        unit: t.unit || null,
        messageCount: t.messages.length,
        // the question that started it — what the reader wants to see when choosing
        // between several chats hanging off the same passage
        opening: opener ? textOf(opener).trim() : '',
        preview: last ? textOf(last).slice(0, 90) : '',
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function getThread(slug, id) {
  return lib.readJSON(threadPath(slug, id), null);
}

function createThread(slug, { title, anchors, unit } = {}) {
  const now = new Date().toISOString();
  const thread = {
    id: crypto.randomBytes(5).toString('hex'),
    title: (title || 'New chat').slice(0, 80),
    anchors: anchors || [],
    // pins the reader switched off for this chat alone; the mark itself stays put
    mutedPins: [],
    unit: unit || null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  lib.writeJSON(threadPath(slug, thread.id), thread);
  return thread;
}

/** Switch one pinned mark off (or back on) for this chat only. */
function mutePin(slug, id, markId, muted) {
  const thread = getThread(slug, id);
  if (!thread) return null;
  const muteds = new Set(thread.mutedPins || []);
  if (muted) muteds.add(markId);
  else muteds.delete(markId);
  thread.mutedPins = [...muteds];
  return saveThread(slug, thread);
}

function saveThread(slug, thread) {
  thread.updatedAt = new Date().toISOString();
  lib.writeJSON(threadPath(slug, thread.id), thread);
  return thread;
}

function appendMessage(slug, id, message) {
  const thread = getThread(slug, id);
  if (!thread) return null;
  thread.messages.push({ ts: new Date().toISOString(), ...message });
  // name the thread after its first question
  if (thread.title === 'New chat' && message.role === 'user') {
    const t = textOf(message).trim();
    if (t) thread.title = t.slice(0, 60) + (t.length > 60 ? '…' : '');
  }
  return saveThread(slug, thread);
}

/**
 * A side chat you never asked anything in is not a chat — it is just a passage you
 * highlighted. Drop the thread and let its anchor fall back to a plain mark, rather
 * than leaving an empty row in the rail (or deleting the passage along with it).
 */
function collapseIfEmpty(slug, id) {
  const thread = getThread(slug, id);
  if (!thread || (thread.messages || []).length) return { collapsed: false };
  const marks = lib.readMarks(slug);
  const demoted = [];
  for (const a of thread.anchors || []) {
    const m = marks.find((x) => x.id === a);
    if (!m || m.kind !== 'chat') continue;
    demoted.push(lib.updateMark(slug, a, { kind: 'plain' }));
  }
  // pins made inside a chat that never happened have nowhere to belong
  for (const m of marks) {
    if (m.kind === 'context' && m.threadId === id) lib.updateMark(slug, m.id, { threadId: null });
  }
  fs.rmSync(threadPath(slug, id), { force: true });
  return { collapsed: true, marks: demoted };
}

/** Sweep the empties left behind by a crash or an earlier version. */
function collapseEmpty(slug) {
  let n = 0;
  for (const t of listThreads(slug)) if (collapseIfEmpty(slug, t.id).collapsed) n++;
  return n;
}

function deleteThread(slug, id, { keepAnchors = false } = {}) {
  const thread = getThread(slug, id);
  fs.rmSync(threadPath(slug, id), { force: true });
  if (!thread) return;
  const anchors = new Set(thread.anchors || []);
  // the anchor mark and any pins scoped to this chat exist only to serve it — unless
  // the reader asked to keep the passage, in which case both outlive the chat
  for (const m of lib.readMarks(slug)) {
    if (anchors.has(m.id)) {
      if (keepAnchors) lib.updateMark(slug, m.id, { kind: 'plain' });
      else lib.deleteMark(slug, m.id);
    } else if (m.threadId === id) {
      if (keepAnchors) lib.updateMark(slug, m.id, { threadId: null });
      else lib.deleteMark(slug, m.id);
    }
  }
}

function textOf(message) {
  return (message.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

module.exports = {
  listThreads,
  getThread,
  createThread,
  saveThread,
  appendMessage,
  deleteThread,
  collapseIfEmpty,
  collapseEmpty,
  mutePin,
  textOf,
};

/**
 * Anything the Claude Code sidebar writes back lands in a thread of its own, so the
 * reader sees it in the same place as the in-app chat instead of a separate panel.
 */
const SIDEBAR_TITLE = 'From your Claude Code sidebar';

function postFromSidebar(slug, markdown, { question } = {}) {
  let thread = listThreads(slug).find((t) => t.title === SIDEBAR_TITLE);
  thread = thread ? getThread(slug, thread.id) : createThread(slug, { title: SIDEBAR_TITLE });
  if (question) {
    thread.messages.push({ ts: new Date().toISOString(), role: 'user', blocks: [{ type: 'text', text: question }] });
  }
  thread.messages.push({ ts: new Date().toISOString(), role: 'assistant', blocks: [{ type: 'text', text: markdown }], viaSidebar: true });
  thread.title = SIDEBAR_TITLE;
  return saveThread(slug, thread);
}

module.exports.postFromSidebar = postFromSidebar;
module.exports.SIDEBAR_TITLE = SIDEBAR_TITLE;
