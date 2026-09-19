#!/usr/bin/env node
// AIM drift: dense-grid vs hashmap reference histogram.
//
// aimDrift2D()'s reference histogram (webSMLM.html, MODULE: drift) is stored as
// a flat typed array when it fits in memory and as a Map otherwise. The two are
// meant to be the SAME computation in different containers — same bins, same
// counts, same Math.min, same sum — so this asserts they agree BIT-FOR-BIT, not
// merely within a tolerance. A drift estimate is applied to every localization's
// coordinates, so a divergence here would silently move the whole
// reconstruction.
//
// It also reports the speedup, which is the reason the dense path exists: on a
// real 40,000-frame run the Map path measured 115 s, the largest single cost in
// the pipeline and nearly 4x the entire GPU-accelerated Localize run.
//
// The Map path is unreachable on any realistic dataset (the grid essentially
// always fits), so this forces it by setting DRIFT_GRID_MAX_BYTES=0 — otherwise
// that branch would ship having never executed.
//
// Skips (does not fail) if the file isn't present — real, git-ignored data.
//
// Usage: cd tests && npm install (once), then node bench-drift.mjs
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { printTable, speedup, writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

// Localizations only: drift never touches pixels, so the processed CSV is the
// honest input here and avoids a multi-minute Localize just to reach the stage
// under test.
const TARGET = await resolveDataFile('LOCALIZATIONS_CSV', join('19165061', 'Processed localizations.csv'));
if (!TARGET) { console.log('Skipping drift benchmark.'); process.exit(0); }

// driftCore()'s own defaults: 100-frame segments, ±120 nm search, 15 nm bins.
const CASES = [
  { label: 'defaults',       segFrames: 100, roiNm: 120, samplePct: 100 },
  { label: 'wide search',    segFrames: 100, roiNm: 300, samplePct: 100 },
  { label: 'short segments', segFrames: 50,  roiNm: 120, samplePct: 100 },
  { label: 'sampled 20%',    segFrames: 100, roiNm: 120, samplePct: 20 },
];

// Each case runs AIM twice over the same localizations, and the forced-Map pass
// builds a reference Map with one entry per occupied bin. At the full 1.4M locs
// that is enough live memory across four cases to OOM the renderer (observed:
// the page closed mid-run on case 2). Correctness does not need the whole file —
// a contiguous prefix is a real, frame-ordered acquisition with real drift — and
// the at-scale timing comes from tests/bench-gpu-stages.mjs, which measures the
// drift stage inside a genuine 40,000-frame run. --full opts back in.
const MAX_LOCS = process.argv.includes('--full') ? Infinity : 400000;

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#file', TARGET);
  await page.waitForFunction(
    () => typeof lastResult !== 'undefined' && lastResult && lastResult.locs && lastResult.locs.length > 0,
    null, { timeout: 900000 });
  // Trim once, in the page, so every case shares one array — re-slicing per case
  // would leave four copies of it alive.
  const info = await page.evaluate((maxLocs) => {
    if (lastResult.locs.length > maxLocs) lastResult.locs = lastResult.locs.slice(0, maxLocs);
    return { n: lastResult.locs.length, w: lastResult.w, h: lastResult.h };
  }, MAX_LOCS === Infinity ? Number.MAX_SAFE_INTEGER : MAX_LOCS);
  console.log(`Using ${info.n.toLocaleString()} real localizations on a ${info.w}×${info.h} frame`
    + (MAX_LOCS === Infinity ? '.' : ` (leading prefix; pass --full for all of them).`) + '\n');

  const rows = [];
  let allIdentical = true;
  for (const c of CASES) {
    process.stdout.write(`Running "${c.label}"...`);
    const r = await page.evaluate(async ({ segFrames, roiNm, samplePct }) => {
      const locs = lastResult.locs;
      let minF = Infinity, maxF = -Infinity;
      for (const L of locs) { const f = L.frame | 0; if (f < minF) minF = f; if (f > maxF) maxF = f; }
      const nFrames = maxF - minF + 1, px = 100, intD = 15;
      const run = async () => aimDrift2D(locs, nFrames, px, segFrames, intD, roiNm, samplePct, minF, null, () => false, () => {});

      const savedCap = DRIFT_GRID_MAX_BYTES;
      // Dense path (the shipping default).
      const t0 = performance.now();
      const dense = await run();
      const denseMs = performance.now() - t0;

      // Force the Map fallback on identical inputs.
      DRIFT_GRID_MAX_BYTES = 0;
      const t1 = performance.now();
      const sparse = await run();
      const sparseMs = performance.now() - t1;
      DRIFT_GRID_MAX_BYTES = savedCap;

      // Bit-for-bit, not approximately: both paths sum the same integers.
      const cmp = (a, b) => {
        if (a.length !== b.length) return { same: false, where: `length ${a.length} vs ${b.length}` };
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { same: false, where: `index ${i}: ${a[i]} vs ${b[i]}` };
        return { same: true, where: null };
      };
      const checks = {
        segdx: cmp(dense.segdx, sparse.segdx),
        segdy: cmp(dense.segdy, sparse.segdy),
        fdx: cmp(dense.fdx, sparse.fdx),
        fdy: cmp(dense.fdy, sparse.fdy),
      };
      const firstBad = Object.entries(checks).find(([, v]) => !v.same);
      let lo = Infinity, hi = -Infinity;
      for (const v of dense.segdx) { if (v < lo) lo = v; if (v > hi) hi = v; }
      return {
        denseMs, sparseMs, nSeg: dense.nSeg,
        identical: !firstBad,
        mismatch: firstBad ? `${firstBad[0]} — ${firstBad[1].where}` : null,
        // A non-zero drift range is what makes "identical" meaningful: two
        // all-zero curves would match trivially and prove nothing.
        driftRangeNm: (hi - lo) * px,
      };
    }, c);

    if (!r.identical) allIdentical = false;
    rows.push({
      label: c.label, segFrames: c.segFrames, roiNm: c.roiNm, samplePct: c.samplePct,
      nSeg: r.nSeg,
      driftNm: Math.round(r.driftRangeNm),
      mapMs: Math.round(r.sparseMs), denseMs: Math.round(r.denseMs),
      speedup: speedup(r.sparseMs, r.denseMs),
      verdict: r.identical ? 'bit-identical' : `MISMATCH: ${r.mismatch}`,
    });
    console.log(r.identical ? ' done.' : ` MISMATCH (${r.mismatch})`);
  }

  console.log('');
  printTable(rows, [
    { key: 'label', label: 'case', width: 16 },
    { key: 'nSeg', label: 'segs', width: 6 },
    { key: 'driftNm', label: 'drift nm', width: 9 },
    { key: 'mapMs', label: 'Map ms', width: 9 },
    { key: 'denseMs', label: 'dense ms', width: 9 },
    { key: 'speedup', label: 'speedup', width: 8, fmt: v => v == null ? 'n/a' : v.toFixed(2) + 'x' },
    { key: 'verdict', label: 'verdict', width: 34 },
  ]);

  const outFile = writeResults('bench-drift', { target: TARGET, locs: info.n, cases: rows });
  console.log(`\nFull results written to ${outFile}`);

  if (!allIdentical) {
    console.error('\nFAIL: the dense grid and the hashmap disagree. They must be bit-identical — a drift estimate moves every localization.');
    process.exit(1);
  }
  const mean = rows.reduce((s, r) => s + r.speedup, 0) / rows.length;
  console.log(`\nAll cases bit-identical. Mean dense-grid speedup: ${mean.toFixed(2)}x.`);
} finally {
  await browser.close();
}
