'use strict';
const fs = require('fs');
const path = require('path');

/** Minimal .env loader — no dependency, never overwrites a real environment variable. */
function loadEnv(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

module.exports = { loadEnv };
