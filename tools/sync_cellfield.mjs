#!/usr/bin/env node
// Brings the insiliscope CellField block into webSMLM.html. The block is the generated cell-field
// world model (C++ core -> WASM, inlined, plus a thin JS wrapper defining `const CellField`), built
// and published by CI in https://github.com/kjamartens/insiliscope (workflow "webSMLM block",
// file cellfield_block.js). It sits in MODULE: simulation between its own
//   // ==== BEGIN insiliscope CellField block ====
//   // ==== END insiliscope CellField block ====
// markers; never hand-edit it -- change the insiliscope core, rebuild, re-sync.
// Full procedure (download, ABI/call-site check, smoke test, commit): docs/CELLFIELD_SYNC.md.
//
// Usage:
//   node tools/sync_cellfield.mjs <cellfield_block.js>   # replace the block in webSMLM.html
//   node tools/sync_cellfield.mjs --check [<block.js>]    # exit 1 if the embedded block is corrupt
//                                                         # (checksum), or differs from <block.js>
//
// Both check the header's sha256(module) against the module the block actually carries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'webSMLM.html');
const BEGIN = '// ==== BEGIN insiliscope CellField block ====';
const END = '// ==== END insiliscope CellField block ====';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const blockPath = args.find(a => !a.startsWith('--'));

// Returns the block text (BEGIN..END inclusive, LF line endings) or throws.
function extract(text, where) {
  const t = text.replace(/\r\n/g, '\n');
  const i = t.indexOf(BEGIN), j = t.indexOf(END);
  if (i < 0 || j < i || t.indexOf(BEGIN, i + 1) >= 0) throw new Error(`${where}: exactly one BEGIN..END CellField block expected`);
  return t.slice(i, j + END.length);
}
// Verifies the header checksum against the module literal; returns the header's fields.
function verify(block, where) {
  const sha = (/^\/\/ sha256\(module\): ([0-9a-f]{64})$/m.exec(block) || [])[1];
  const lit = (/^\)\((".*")\);$/m.exec(block) || [])[1];
  if (!sha || !lit) throw new Error(`${where}: no sha256(module) header or module literal`);
  const actual = crypto.createHash('sha256').update(JSON.parse(lit)).digest('hex');
  if (actual !== sha) throw new Error(`${where}: header sha256 ${sha.slice(0, 12)} != module ${actual.slice(0, 12)}`);
  const commit = (/^\/\/ commit: (\S+)$/m.exec(block) || [])[1] || 'unknown';
  return { sha, commit };
}

const html = fs.readFileSync(HTML_PATH, 'utf8');
const cur = extract(html, 'webSMLM.html');
const curInfo = verify(cur, 'webSMLM.html');

if (checkOnly) {
  if (blockPath) {
    const want = extract(fs.readFileSync(blockPath, 'utf8'), blockPath);
    verify(want, blockPath);
    if (want !== cur) { console.error(`webSMLM.html's CellField block differs from ${blockPath}: run node tools/sync_cellfield.mjs ${blockPath}`); process.exit(1); }
  }
  console.log(`CellField block OK: insiliscope ${curInfo.commit.slice(0, 12)}, module sha256 ${curInfo.sha.slice(0, 12)}`);
  process.exit(0);
}

if (!blockPath) { console.error('usage: node tools/sync_cellfield.mjs <cellfield_block.js> | --check [<block.js>]'); process.exit(2); }
const next = extract(fs.readFileSync(blockPath, 'utf8'), blockPath);
const nextInfo = verify(next, blockPath);
// Keep the file's own line endings.
const eol = html.includes('\r\n') && html.indexOf(BEGIN) > 0 && html.slice(html.indexOf(BEGIN) - 2, html.indexOf(BEGIN)) === '\r\n' ? '\r\n' : '\n';
const i = html.indexOf(BEGIN), j = html.indexOf(END) + END.length;
fs.writeFileSync(HTML_PATH, html.slice(0, i) + next.replace(/\n/g, eol) + html.slice(j));
console.log(next === cur ? 'CellField block already up to date' :
  `CellField block: insiliscope ${curInfo.commit.slice(0, 12)} -> ${nextInfo.commit.slice(0, 12)}, module sha256 ${nextInfo.sha.slice(0, 12)}`);
