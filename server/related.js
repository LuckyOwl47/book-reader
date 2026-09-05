'use strict';
const lib = require('./library');

/** Words too common to say anything about what a passage is *about*. */
const STOP = new Set(
  ('the a an and or but if then than that this these those there here of to in on at by for from with without into over under ' +
    'is are was were be been being do does did doing have has had having can could will would shall should may might must ' +
    'not no nor so as it its it s we you they he she them their our your his her i me my one two three first second also ' +
    'such which who whom whose what when where why how all any both each few more most other some only own same very just ' +
    'because while about above below after before again further once now new see fig figure chapter section page example ' +
    'exercise problem equation case shown show gives give given let us thus hence therefore however since where'
  ).split(/\s+/)
);

const cache = new Map(); // slug -> {units: [{unit, text, lower}], df: Map, n}

function index(slug) {
  const meta = lib.getBook(slug);
  const hit = cache.get(slug);
  if (hit && hit.count === meta.unitCount) return hit;

  const units = [];
  const df = new Map();
  for (let i = 1; i <= meta.unitCount; i++) {
    const text = lib.readUnit(slug, i) || '';
    const lower = text.toLowerCase();
    units.push({ unit: i, text, lower });
    for (const w of new Set(terms(lower))) df.set(w, (df.get(w) || 0) + 1);
  }
  const built = { units, df, count: meta.unitCount };
  cache.set(slug, built);
  return built;
}

function terms(s) {
  return (s.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter((w) => !STOP.has(w));
}

function excerptAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return text.slice(0, 220).replace(/\s+/g, ' ').trim();
  return text
    .slice(Math.max(0, at - 130), at + needle.length + 170)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Where else in the book does this passage's subject come up?
 * Plain tf-idf over the extracted text — enough to hand the model a shortlist worth
 * reading, which is all it needs to judge what is actually related.
 */
function relatedUnits(slug, query, { exclude = [], limit = 8 } = {}) {
  const { units, df } = index(slug);
  const n = units.length || 1;

  const wanted = new Map();
  for (const w of terms(query)) wanted.set(w, (wanted.get(w) || 0) + 1);
  if (!wanted.size) return [];

  // rare words say more about the subject than common ones
  const weights = [...wanted.keys()]
    .map((w) => ({ w, idf: Math.log(n / (1 + (df.get(w) || 0))) }))
    .filter((t) => t.idf > 0.2)
    .sort((a, b) => b.idf - a.idf)
    .slice(0, 12);
  if (!weights.length) return [];

  const skip = new Set(exclude);
  const scored = [];
  for (const u of units) {
    if (skip.has(u.unit) || !u.lower) continue;
    let score = 0;
    let matched = 0;
    let best = null;
    for (const { w, idf } of weights) {
      let tf = 0;
      let from = 0;
      while (true) {
        const at = u.lower.indexOf(w, from);
        if (at === -1) break;
        tf++;
        from = at + w.length;
        if (tf > 6) break;
      }
      if (!tf) continue;
      matched++;
      score += idf * (1 + Math.log(tf));
      if (!best || idf > best.idf) best = { w, idf };
    }
    // one shared rare word is usually a coincidence; two or more is a lead
    if (matched >= 2 && best) scored.push({ unit: u.unit, score, matched, best: best.w, text: u.text });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => ({
      unit: h.unit,
      score: Number(h.score.toFixed(2)),
      matched: h.matched,
      excerpt: excerptAround(h.text, h.best),
    }));
}

module.exports = { relatedUnits };
