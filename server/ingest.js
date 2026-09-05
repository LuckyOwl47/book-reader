'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const lib = require('./library');

// ---------------------------------------------------------------- PDF

function loadPdfjs() {
  // pdf.js tries to polyfill these from the optional `canvas` package at load time and
  // logs a scary warning when it is absent. Text extraction needs neither; stub them.
  globalThis.DOMMatrix ||= class DOMMatrix {};
  globalThis.Path2D ||= class Path2D {};
  return require('pdfjs-dist/legacy/build/pdf.js');
}

async function extractPdf(filePath, slug, originalName) {
  const pdfjs = loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;

  let info = {};
  try {
    info = (await doc.getMetadata()).info || {};
  } catch {}

  const units = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      const gap = lastY === null ? 0 : Math.abs(y - lastY);
      // a gap near the line height is a line break; a much larger one is a paragraph break
      if (gap > 2) text += gap > (item.height || 10) * 1.6 ? '\n\n' : '\n';
      text += item.str;
      lastY = y;
    }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    lib.writeUnit(slug, i, text);
    units.push({ index: i, label: `p.${i}` });
    page.cleanup();
  }

  // outline -> chapter labels on their starting page
  try {
    const outline = await doc.getOutline();
    if (outline) {
      const flat = [];
      const walk = (nodes, depth) => {
        for (const n of nodes) {
          flat.push({ title: n.title, dest: n.dest, depth });
          if (n.items && n.items.length) walk(n.items, depth + 1);
        }
      };
      walk(outline, 0);
      for (const entry of flat) {
        try {
          const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest;
          if (!dest) continue;
          const pageIndex = await doc.getPageIndex(dest[0]);
          const u = units[pageIndex];
          if (u && !u.chapter) u.chapter = entry.title.trim();
        } catch {}
      }
    }
  } catch {}

  await doc.destroy();
  return {
    title: (info.Title || '').trim() || originalName.replace(/\.pdf$/i, ''),
    author: (info.Author || '').trim(),
    unitCount: doc.numPages,
    units,
  };
}

// ---------------------------------------------------------------- EPUB

function htmlToText(html) {
  return html
    .replace(/<\s*head[\s\S]*?<\s*\/\s*head\s*>/gi, '')
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|section|article|li|h[1-6]|blockquote|tr|td|figcaption)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
}

function resolveHref(baseDir, href) {
  const clean = decodeURIComponent(href.split('#')[0]);
  return path.posix.normalize(path.posix.join(baseDir, clean)).replace(/^\/+/, '');
}

async function extractEpub(filePath, slug, originalName) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));

  const container = await zip.file('META-INF/container.xml').async('string');
  const rootTag = container.match(/<rootfile\s[^>]*>/i);
  if (!rootTag) throw new Error('malformed EPUB: no rootfile in META-INF/container.xml');
  const opfPath = attr(rootTag[0], 'full-path');
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const opf = await zip.file(opfPath).async('string');

  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '';
  const author = (opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '';

  const manifest = {};
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) manifest[id] = { href, type: attr(tag, 'media-type'), props: attr(tag, 'properties') || '' };
  }

  const spineBlock = (opf.match(/<spine[\s\S]*?<\/spine>/i) || [''])[0];
  const spine = (spineBlock.match(/<itemref\b[^>]*>/gi) || [])
    .map((tag) => manifest[attr(tag, 'idref')])
    .filter((it) => it && /html|xhtml/i.test(it.type || ''));

  // ---- table of contents (EPUB3 nav, else EPUB2 NCX) -> href => title
  const tocByHref = new Map();
  const navItem = Object.values(manifest).find((i) => /nav/.test(i.props));
  const ncxId = (spineBlock.match(/toc\s*=\s*"([^"]+)"/i) || [])[1];
  try {
    if (navItem) {
      const nav = await zip.file(resolveHref(opfDir, navItem.href)).async('string');
      const navDir = path.posix.dirname(resolveHref(opfDir, navItem.href));
      for (const a of nav.match(/<a\b[^>]*href[^>]*>[\s\S]*?<\/a>/gi) || []) {
        const href = attr(a.match(/<a\b[^>]*>/i)[0], 'href');
        const label = htmlToText(a);
        if (href && label) {
          const key = resolveHref(navDir === '.' ? '' : navDir, href);
          if (!tocByHref.has(key)) tocByHref.set(key, label);
        }
      }
    } else if (ncxId && manifest[ncxId]) {
      const ncxPath = resolveHref(opfDir, manifest[ncxId].href);
      const ncx = await zip.file(ncxPath).async('string');
      const ncxDir = path.posix.dirname(ncxPath);
      for (const nav of ncx.match(/<navPoint[\s\S]*?<\/navPoint>/gi) || []) {
        const label = htmlToText((nav.match(/<text[^>]*>([\s\S]*?)<\/text>/i) || [])[1] || '');
        const href = attr((nav.match(/<content\b[^>]*>/i) || [''])[0], 'src');
        if (href && label) {
          const key = resolveHref(ncxDir === '.' ? '' : ncxDir, href);
          if (!tocByHref.has(key)) tocByHref.set(key, label);
        }
      }
    }
  } catch {}

  const units = [];
  for (let i = 0; i < spine.length; i++) {
    const full = resolveHref(opfDir, spine[i].href);
    const file = zip.file(full);
    const text = file ? htmlToText(await file.async('string')) : '';
    lib.writeUnit(slug, i + 1, text);
    const label = tocByHref.get(full);
    units.push({ index: i + 1, label: label || `section ${i + 1}`, href: spine[i].href, chapter: label || undefined });
  }

  return {
    title: htmlToText(title) || originalName.replace(/\.epub$/i, ''),
    author: htmlToText(author),
    unitCount: spine.length,
    units,
  };
}

// ---------------------------------------------------------------- entry

async function ingest(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  const format = ext === '.pdf' ? 'pdf' : ext === '.epub' ? 'epub' : null;
  if (!format) throw new Error(`unsupported format: ${ext} (want .pdf or .epub)`);

  const slug = lib.uniqueSlug(path.basename(abs));
  const dir = lib.bookDir(slug);
  fs.mkdirSync(path.join(dir, 'text'), { recursive: true });

  const stored = path.join(dir, 'source' + ext);
  fs.copyFileSync(abs, stored);

  let info;
  try {
    const originalName = path.basename(abs);
    info = format === 'pdf' ? await extractPdf(stored, slug, originalName) : await extractEpub(stored, slug, originalName);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const meta = {
    slug,
    title: info.title,
    author: info.author,
    format,
    file: path.basename(stored),
    sourcePath: abs,
    unitCount: info.unitCount,
    unitName: format === 'pdf' ? 'page' : 'section',
    units: info.units,
    addedAt: new Date().toISOString(),
  };
  lib.saveBook(meta);
  lib.setPosition(slug, { unit: 1 });
  lib.rebuildContext(slug);
  return meta;
}

/** Ingest anything in books/ that isn't in the library yet. */
async function scanDropFolder() {
  const known = new Set(lib.listBooks().map((b) => b.sourcePath));
  const added = [];
  for (const name of fs.readdirSync(lib.BOOKS_DIR)) {
    const abs = path.join(lib.BOOKS_DIR, name);
    if (!/\.(pdf|epub)$/i.test(name) || known.has(abs)) continue;
    try {
      added.push(await ingest(abs));
    } catch (err) {
      added.push({ error: `${name}: ${err.message}` });
    }
  }
  return added;
}

module.exports = { ingest, scanDropFolder };
