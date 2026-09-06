'use strict';
const OpenAI = require('openai');

function hasCredentials() {
  return !!process.env.OPENAI_API_KEY;
}

let client = null;
function getClient() {
  if (!hasCredentials()) {
    const err = new Error('No OpenAI credentials. Put OPENAI_API_KEY=sk-... in .env at the project root and restart.');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  if (!client) client = new OpenAI();
  return client;
}

/** One of our generic {type:'text'|'image', ...} blocks -> an OpenAI content part. */
function toPart(b) {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image' && b.source && b.source.data) {
    return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  }
  return null;
}

/**
 * Our messages carry Anthropic-shaped content (a string, or an array of
 * text/image blocks) regardless of which provider ends up serving the turn.
 * Only user turns may hold images here, so assistant/system turns flatten to text.
 */
function toOpenAIMessage(m) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  if (m.role === 'user') {
    const parts = m.content.map(toPart).filter(Boolean);
    return { role: 'user', content: parts.length ? parts : [{ type: 'text', text: '(empty)' }] };
  }
  const text = m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { role: m.role, content: text || '(empty)' };
}

async function stream({ model, systemText, messages, maxTokens = 16000 }, handlers = {}) {
  const openai = getClient();
  const completion = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'system', content: systemText }, ...messages.map(toOpenAIMessage)],
  });

  let text = '';
  let usage = null;
  let stopReason = null;
  for await (const chunk of completion) {
    const choice = chunk.choices && chunk.choices[0];
    const delta = choice && choice.delta && choice.delta.content;
    if (delta) {
      text += delta;
      handlers.onText && handlers.onText(delta);
    }
    if (choice && choice.finish_reason) stopReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  // OpenAI's chat models don't expose a reasoning trace over this API, so there is
  // never anything for handlers.onThinking here — the caller treats it as optional.
  return { text, thinking: '', usage, stopReason };
}

async function complete({ model, system, prompt, maxTokens = 1000 }) {
  const openai = getClient();
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  });
  return response.choices[0].message.content || '';
}

module.exports = { stream, complete, hasCredentials };
