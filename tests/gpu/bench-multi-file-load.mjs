#!/usr/bin/env node
// Multi-file TIFF-SEQUENCE loading — the one loading mode nothing else in
// this suite exercises with real data (loadTiffFilesAuto() ->
// loadTiffSequence(), MODULE: in/out: one TIFF file per frame). Every other
// real-data bench uses a single contiguous multi-frame stack file.
//
// Uses the GATTA-PAINT-80R nanoruler dataset's raw per-frame TIFF dump
// (Dataset I, experimental_data/README.md) — 4826 single-frame TIFFs. A
// bounded prefix keeps this fast; --full loads all of them.
//
// Skips (does not fail) if the directory isn't present.
//
// Usage: cd tests && npm install (once), then node bench-multi-file-load.mjs [--full]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const FULL = process.argv.includes('--full');
const dir = await resolveDataFile('GATTA_PAINT_DIR', join('GATTA-PAINT-80R-RAW', 'GATTA-PAINT-80R-raw-tifs'));
if (!dir) { console.log('Skipping multi-file-load benchmark.'); process.exit(0); }

const allFiles = readdirSync(dir).filter(f => /\.tif$/i.test(f)).sort();
const N = FULL ? allFiles.length : Math.min(200, allFiles.length);
const paths = allFiles.slice(0, N).map(f => join(dir, f));
console.log(`Loading ${paths.length} of ${allFiles.length} single-frame TIFFs from\n  ${dir}`
  + (FULL ? '' : ' (a bounded prefix; pass --full for all of them).'));

const { browser, page } = await launchPage();
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };

try {
  await page.setInputFiles('#file', paths);
  await page.waitForFunction(() => typeof stack !== 'undefined' && stack && stack.n > 0, null, { timeout: 300000 });
  const info = await page.evaluate(() => ({ n: stack.n, w: stack.w, h: stack.h }));
  console.log(`Loaded: ${info.n} frames, ${info.w}x${info.h}.`);
  check('frame count matches the files selected', info.n === paths.length, `${info.n} vs ${paths.length}`);
  check('dimensions are sane (>0)', info.w > 0 && info.h > 0, `${info.w}x${info.h}`);

  // A real Localize run over this sequence-loaded stack — proves
  // loadTiffSequence()'s per-file frames reach detect/fit cleanly, not just
  // that the frame count came out right. Default settings; not a
  // correctness gate against a reference (no ground truth for this real,
  // borrowed dataset), just "does the whole pipeline run without throwing".
  const runOk = await page.evaluate(async () => {
    let captured = null;
    const orig = window.runCore;
    window.runCore = async function (...args) { const r = await orig.apply(this, args); captured = r; return r; };
    document.getElementById('runBtn').click();
    const t0 = performance.now();
    while (!captured) {
      if (performance.now() - t0 > 120000) { window.runCore = orig; return { ok: false, why: 'Localize did not finish within 120s' }; }
      await new Promise(r => setTimeout(r, 50));
    }
    window.runCore = orig;
    return { ok: true, nLocs: (typeof lastResult !== 'undefined' && lastResult ? lastResult.locs.length : 0) };
  });
  check('Localize completes over the sequence-loaded stack', runOk.ok, runOk.ok ? `${runOk.nLocs} locs` : runOk.why);

  const outFile = writeResults('bench-multi-file-load', { dir, nFiles: paths.length, nFilesTotal: allFiles.length, full: FULL, info, runOk });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll multi-file-load checks passed.');
