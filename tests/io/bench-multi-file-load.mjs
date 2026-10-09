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
import { expectGpuUsed, writeResults } from '../lib/report.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';
import { DATASETS, parseGpuMode } from '../lib/datasets.mjs';

const FULL = process.argv.includes('--full');
const GPU_MODE = parseGpuMode();
const dir = await resolveDatasetFile('gatta80r', 'frames');
if (!dir) { console.log('Skipping multi-file-load benchmark.'); process.exit(0); }

const allFiles = readdirSync(dir).filter(f => /\.tif$/i.test(f)).sort();
const N = FULL ? allFiles.length : Math.min(500, allFiles.length);
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
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.id = 'benchSequenceInput';
    input.hidden = true; document.body.append(input);
  });
  await page.setInputFiles('#benchSequenceInput', paths);
  const modes = GPU_MODE === 'both' ? ['cpu', 'gpu'] : [GPU_MODE];
  const runs = [];
  for (const mode of modes) {
    const run = await page.evaluate(async ({ mode, parameters }) => {
      const files = [...document.getElementById('benchSequenceInput').files];
      const r = await window.webSMLM.analyze({
        files, ...parameters, method: 'gaussmle', useGpu: mode === 'gpu',
        fitFirstFrame: 1, fitLastFrame: files.length,
      });
      return { mode, ok: true, nLocs: r.locs.length, timings: r.timings, execution: r.execution, logText: r.logText };
    }, { mode, parameters: DATASETS.gatta80r.parameters });
    if (mode === 'gpu') expectGpuUsed(run.logText, true);
    runs.push(run);
    check(`${mode.toUpperCase()} fit receives real candidates`, run.ok && run.timings.nCand > 0,
      `${run.timings.nCand} candidates, ${run.nLocs} accepted locs`);
  }

  const outFile = writeResults('bench-multi-file-load', {
    dataset: 'gatta80r', gpuMode: GPU_MODE, parameters: DATASETS.gatta80r.parameters,
    dir, nFiles: paths.length, nFilesTotal: allFiles.length, full: FULL, info, runs,
  });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll multi-file-load checks passed.');
