'use strict';

// The picker in the UI offers exactly these. Add a row here to add a model —
// nothing else needs to know its id up front.
const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', vision: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', vision: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', vision: true },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'openai', vision: true },
  { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', provider: 'openai', vision: true },
];

const DEFAULT_MODEL = process.env.BOOK_READER_MODEL || 'claude-opus-5';

function byId(id) {
  return MODELS.find((m) => m.id === id) || null;
}

module.exports = { MODELS, DEFAULT_MODEL, byId };
