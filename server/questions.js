'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');

function file(slug) {
  return path.join(lib.bookDir(slug), 'questions.jsonl');
}

function readAll(slug) {
  let raw = '';
  try {
    raw = fs.readFileSync(file(slug), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id) byId.set(rec.id, { ...(byId.get(rec.id) || {}), ...rec });
    } catch {}
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function ask(slug, { text, unit, markId }) {
  const rec = {
    id: crypto.randomBytes(5).toString('hex'),
    text: String(text || '').trim(),
    unit: Number(unit) || null,
    markId: markId || null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  fs.appendFileSync(file(slug), JSON.stringify(rec) + '\n');
  return rec;
}

function answer(slug, id, markdown) {
  const q = readAll(slug).find((r) => r.id === id);
  if (!q) return null;
  const rec = { id, answeredAt: new Date().toISOString(), answer: markdown };
  fs.appendFileSync(file(slug), JSON.stringify(rec) + '\n');
  const meta = lib.getBook(slug);
  const where = q.unit && meta ? ` (${lib.unitLabel(meta, q.unit)})` : '';
  lib.appendNote(slug, `**Q${where}: ${q.text}**\n\n${markdown}`);
  require('./chats').postFromSidebar(slug, markdown, { question: q.text });
  return { ...q, ...rec };
}

module.exports = { readAll, ask, answer };
