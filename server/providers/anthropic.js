'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

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

/** Stream one turn. `messages` and `systemBlocks` are already in Anthropic's own shape. */
async function stream({ model, systemBlocks, messages, maxTokens = 16000 }, handlers = {}) {
  const anthropic = getClient();
  const req = anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive', display: 'summarized' },
    cache_control: { type: 'ephemeral' },
    system: systemBlocks,
    messages,
  });

  req.on('text', (delta) => handlers.onText && handlers.onText(delta));
  req.on('thinking', (delta) => handlers.onThinking && handlers.onThinking(delta));

  const final = await req.finalMessage();
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

async function complete({ model, system, prompt, maxTokens = 1000 }) {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

module.exports = { stream, complete, hasCredentials };
