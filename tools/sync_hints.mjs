#!/usr/bin/env node
// Syncs webSMLM.html's in-app "more info…" popups (.hint divs) FROM
// docs/DOCUMENTATION.md, so the two stop drifting apart — before this,
// each was hand-authored independently and could (and did) silently
// disagree. docs/DOCUMENTATION.md is the source of truth: edit a hint's
// content inside its `<!-- HINT:id --> ... <!-- /HINT:id -->` marker
// there, then run this script; never hand-edit a `.hint` div's content in
// webSMLM.html directly (this script overwrites it on every run).
//
// Usage:
//   node tools/sync_hints.mjs           # sync and report
//   node tools/sync_hints.mjs --check   # exit 1 if webSMLM.html would change (CI/pre-commit use)
//
// Marker content is raw HTML, byte-identical to what ends up in the .hint
// div — deliberately NOT Markdown, so there's no conversion step (and
// therefore no conversion bugs) between the two. The <span class="pill">
// module: X</span> label at the top of each .hint div is NOT part of the
// synced content — it's a fixed part of webSMLM.html's own markup, kept
// untouched, so DOCUMENTATION.md's markers don't need to know about that
// UI-only styling detail.
//
// Matching: each .hint div needs `id="hint-<name>"`; each DOCUMENTATION.md
// marker pair is `<!-- HINT:<name> -->`/`<!-- /HINT:<name> -->`. A hint div
// with no matching marker, or a marker with no matching div, is reported
// as a warning (not a hard failure) — could be a genuine one-sided
// in-progress edit, not necessarily a bug.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'webSMLM.html');
const DOC_PATH = path.join(ROOT, 'docs', 'DOCUMENTATION.md');
const checkOnly = process.argv.includes('--check');

const doc = readFileSync(DOC_PATH, 'utf8');
let html = readFileSync(HTML_PATH, 'utf8');

// Extract every <!-- HINT:id --> ... <!-- /HINT:id --> block from the docs.
const markers = new Map();
// [\w-]+ (not \S+): deliberately narrow enough that a literal "<!-- HINT:name
// -->" used as a prose EXAMPLE elsewhere in the docs (e.g. explaining this
// mechanism itself) can't accidentally parse as a real marker.
const markerRe = /<!--\s*HINT:([\w-]+)\s*-->([\s\S]*?)<!--\s*\/HINT:\1\s*-->/g;
for (const m of doc.matchAll(markerRe)) {
  markers.set(m[1], m[2].replace(/^\n/, '').replace(/\n$/, ''));
}

// Find every .hint div carrying id="hint-<name>" and its <span class="pill">
// ...</span> preamble, then replace everything after that span up to the
// div's own closing tag. No .hint div nests another <div> today (checked),
// so matching up to the next </div> is safe — if that ever changes, this
// regex needs to get smarter (a real HTML parser) rather than silently
// grabbing the wrong closing tag.
const hintDivRe = /(<div class="hint" hidden id="hint-([\w-]+)">\s*<span class="pill">[^<]*<\/span>)[\s\S]*?(<\/div>)/g;

const foundIds = new Set();
let missingMarker = [];
let changed = 0;
html = html.replace(hintDivRe, (whole, head, id, tail) => {
  foundIds.add(id);
  if (!markers.has(id)) { missingMarker.push(id); return whole; }
  const indented = markers.get(id).split('\n').map(l => l.trim() ? '          ' + l.trim() : '').join('\n');
  const replaced = `${head}\n${indented}\n        ${tail}`;
  if (replaced !== whole) changed++;
  return replaced;
});

const orphanMarkers = [...markers.keys()].filter(id => !foundIds.has(id));

if (missingMarker.length) {
  console.warn('⚠ .hint div(s) with no matching DOCUMENTATION.md marker (left untouched): ' + missingMarker.join(', '));
}
if (orphanMarkers.length) {
  console.warn('⚠ DOCUMENTATION.md marker(s) with no matching .hint div id: ' + orphanMarkers.join(', '));
}

console.log(`${foundIds.size} .hint div(s) found, ${markers.size} marker(s) found, ${changed} changed.`);

if (checkOnly) {
  const original = readFileSync(HTML_PATH, 'utf8');
  if (html !== original) {
    console.error('webSMLM.html is out of sync with docs/DOCUMENTATION.md — run `node tools/sync_hints.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('In sync.');
  process.exit(0);
}

if (changed) writeFileSync(HTML_PATH, html);
