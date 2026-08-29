#!/usr/bin/env node
// webSMLM live-streaming bridge — keeps ONE non-headless Chromium page open
// for a whole acquisition and repeatedly calls window.webSMLM.stream.
// pushChunk() (MODULE: pipeline, webSMLM.html) as an external process (e.g.
// a Gladoscopy RT node driving a live Micro-Manager/pycromanager
// acquisition) pushes frame chunks in — a different shape from
// webSMLM-cli.mjs's one-shot "launch, run once, exit", which pays a full
// browser-launch+page-load cost per invocation and is the wrong fit for a
// long streaming session.
//
// Deliberately NOT headless (chromium.launch({headless:false})) — the whole
// point of this tier is to watch the reconstruction grow live during the
// acquisition, not just get numbers back.
//
// This script sends NO config/init message of its own. A streaming session
// is armed only by the OPERATOR clicking "Start streaming" in webSMLM's own
// sidebar (the "Live streaming" section) — they set pxnm/gain/camoffset/
// method/mag/lut/etc. through webSMLM's normal controls first, exactly as
// for an ordinary interactive Localize. Until that click, window.webSMLM.
// stream.isActive() is false and every "push" this script receives comes
// back as a clear "not started" error rather than being silently queued.
//
// Protocol (stdin -> this process, one command at a time, ASCII '\n'
// (0x0A) terminated JSON header lines):
//   {"cmd":"push","nBytes":<N>}\n   followed immediately by exactly N raw
//                                    bytes — one frame chunk, any TIFF
//                                    UTIF.decode() can read (contiguous
//                                    ImageJ-style multi-frame is simplest)
//   {"cmd":"stop"}\n                 finalize the session, then this
//                                    process exits
// Reply (this process -> stdout, one JSON line per command):
//   {"ok":true, chunkFrames, chunkLocs, totalFrames, totalLocs}   (push)
//   {"ok":true, "stopped":true}                                   (stop)
//   {"ok":false, "error":"..."}
//
// Usage:
//   node tools/webSMLM-stream.mjs
// A driving process (a Gladoscopy RT node, or a standalone test script for
// the feasibility spike — see docs/REFACTOR_PLAN.md) writes commands to
// this process's stdin and reads one JSON reply per line from stdout;
// anything on stderr is just human-readable status, not part of the
// protocol.

import { chromium } from 'playwright';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const htmlUrl = pathToFileURL(join(repoRoot, 'webSMLM.html')).href;

console.error('Launching Chromium (headed — watch the reconstruction grow live in this window)...');
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error') console.error('  [page error] ' + msg.text()); });
await page.goto(htmlUrl);
await page.waitForFunction(() => window.webSMLM && window.webSMLM.stream);
console.error('Ready — click "Start streaming" in the webSMLM window, then start pushing chunks on stdin.');

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handlePush(buf) {
  const armed = await page.evaluate(() => window.webSMLM.stream.isActive());
  if (!armed) { reply({ ok: false, error: 'not started — click "Start streaming" in the webSMLM window first' }); return; }
  await page.setInputFiles('#streamChunkInput', { name: 'chunk.tif', mimeType: 'image/tiff', buffer: buf });
  try {
    const result = await page.evaluate(() => window.webSMLM.stream.pushChunk());
    reply({ ok: true, ...result });
  } catch (err) {
    reply({ ok: false, error: (err && err.message) || String(err) });
  }
}

async function handleStop() {
  try { await page.evaluate(() => window.webSMLM.stream.end()); reply({ ok: true, stopped: true }); }
  catch (err) { reply({ ok: false, error: (err && err.message) || String(err) }); }
  await browser.close();
  process.exit(0);
}

// ---- stdin framing: a JSON header line, then (for "push") exactly nBytes
// raw bytes immediately after it, with no separator — buf accumulates
// whatever async iteration over process.stdin hands us and this drains as
// many complete header(+body) frames as are currently available. Processing
// one command is awaited before draining the next, so two pushChunk() calls
// can never race against each other on the same page.
let buf = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const nl = buf.indexOf(0x0A);
    if (nl === -1) break;   // header line not fully arrived yet
    const headerLine = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    let header;
    try { header = JSON.parse(headerLine); }
    catch { reply({ ok: false, error: `bad header JSON: ${headerLine}` }); buf = buf.subarray(nl + 1); continue; }
    if (header.cmd === 'stop') { buf = buf.subarray(nl + 1); await handleStop(); continue; }   // handleStop() calls process.exit(0)
    if (header.cmd === 'push') {
      const need = nl + 1 + header.nBytes;
      if (buf.length < need) break;   // wait for the rest of this chunk's bytes to arrive
      const body = buf.subarray(nl + 1, need);
      buf = buf.subarray(need);
      await handlePush(body);
      continue;
    }
    reply({ ok: false, error: `unknown cmd: ${header.cmd}` });
    buf = buf.subarray(nl + 1);
  }
}
await browser.close();
