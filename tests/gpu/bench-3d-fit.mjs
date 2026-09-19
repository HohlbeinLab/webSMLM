#!/usr/bin/env node
// 3D fit (Gauss MLE) self-consistency check — the real feature gap this
// suite existed without: mle3d/gaussmleEll + localize3D were completely
// untested before this (bench-real-data.mjs deliberately restricts itself to
// method:'gaussmle' 2D, the only GPU-fit-accelerated method).
//
// Self-consistency design: the SAME real local bead z-stack (temp/19165061/
// Z calibration (step 10nm).tif — see bench-calibration.mjs / experimental_
// data/README.md "Dataset II" folder) is used BOTH as config.calibrationFile
// (build a fresh calibration) AND config.file (the dataset to localize) in
// ONE analyze() call — confirmed valid directly from webSMLM.html's analyze():
// calibrationFile/Files builds-and-applies in one call regardless of
// calibrationOnly. Since every frame's true z is known (frame index × calStep,
// relative to the fitted focus), a real 3D fit run against its own
// calibration source has a known-good answer to check against: z should sit
// near zero at the focus frame and track away from it with distance.
//
// Also confirms (see expectGpuUsed) GPU-fit engagement: every method/
// localize3D combination here now has its own WGSL kernel (WGSL_FIT_ELL3D
// for mle3d; WGSL_FIT_ROT_FIXED/WGSL_FIT_ROT_FREE for gaussmleEll's two
// angle modes) and should engage GPU whenever useGpu:true — turning "did it
// actually accelerate" into an explicit, documented check rather than an
// inference from timing alone.
//
// Skips (does not fail) if the file isn't present — real, git-ignored data.
//
// Usage: cd tests && npm install (once), then node bench-3d-fit.mjs
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { expectGpuUsed, printTable, writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const TARGET = await resolveDataFile('Z_CALIBRATION', join('19165061', 'Z calibration (step 10nm).tif'));
if (!TARGET) { console.log('Skipping 3D fit benchmark.'); process.exit(0); }

const BASE_CONFIG = {
  calFirst: 20, calLast: 140, calStep: 10, calRef: 0, calFixedXY: false,
  psf: 1.3, winr: 4, detFilter: 'wave', detection_wavelet_thr: 4, pxnm: 100,
  gain: 1, camoffset: 0,
  fitFirstFrame: 20, fitLastFrame: 140,   // bounded to the calibrated range — every loc gets a meaningful z
  useGpu: true,   // deliberately on: proves GPU still doesn't engage for these methods (see expectGpuUsed below)
};
const FOCUS_FRAME = 72;   // from the calibration's own focus (zref) — see bench-calibration.mjs

const CASES = [
  { label: 'mle3d, localize3D=true',        method: 'mle3d',      localize3D: true,  expectGpu: true },
  { label: 'mle3d, localize3D=false',       method: 'mle3d',      localize3D: false, expectGpu: true },
  { label: 'gaussmleEll, localize3D=true',  method: 'gaussmleEll', localize3D: true,  expectGpu: true },
  { label: 'gaussmleEll, localize3D=false', method: 'gaussmleEll', localize3D: false, expectGpu: true },
];

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', TARGET);

  const rows = [];
  for (const c of CASES) {
    process.stdout.write(`Running "${c.label}"...`);
    const t0 = Date.now();
    const result = await page.evaluate(async ({ cfg, method, localize3D, fileInputId }) => {
      const f = document.getElementById(fileInputId).files[0];
      const config = Object.assign({}, cfg, { method, localize3D, file: f, calibrationFile: f });
      const r = await window.webSMLM.analyze(config);
      return {
        nLocs: r.locs.length, logText: r.logText,
        // Only what's needed for the checks below — never ship a full locs
        // array with real z across the Playwright/CDP boundary for no reason.
        zByFrame: r.locs.reduce((m, L) => { (m[L.frame] = m[L.frame] || []).push(L.z); return m; }, {}),
      };
    }, { cfg: BASE_CONFIG, method: c.method, localize3D: c.localize3D, fileInputId: 'analyzeFileInput' });
    const wallMs = Date.now() - t0;

    let gpuOk = true, gpuErr = null;
    try { expectGpuUsed(result.logText, c.expectGpu); } catch (e) { gpuOk = false; gpuErr = e.message; }

    const hasZ = c.localize3D;   // unchecked → angle fixed, no z computed (see PARAMS.localize3D)
    let medianAbsZFocus = null, zAccuracyOk = true;
    if (hasZ) {
      const near = [];
      for (let fi = FOCUS_FRAME - 2; fi <= FOCUS_FRAME + 2; fi++) if (result.zByFrame[fi]) near.push(...result.zByFrame[fi]);
      const finite = near.filter(Number.isFinite).sort((a, b) => Math.abs(a) - Math.abs(b));
      medianAbsZFocus = finite.length ? Math.abs(finite[Math.floor(finite.length / 2)]) : null;
      // A calibration spanning ~600nm of usable z (see bench-calibration.mjs's
      // own zmin/zmax) should place near-focus locs well under half that —
      // generous on purpose (real detector noise, not a tight physics bound).
      zAccuracyOk = medianAbsZFocus != null && medianAbsZFocus < 300;
    }

    rows.push({
      label: c.label, nLocs: result.nLocs, wallMs,
      medianAbsZFocus, zAccuracyOk: hasZ ? zAccuracyOk : 'n/a (no z)',
      gpuAsExpected: gpuOk, gpuErr,
    });
    console.log(' done.');
  }

  console.log('');
  printTable(rows, [
    { key: 'label', label: 'case', width: 26 },
    { key: 'nLocs', label: 'locs', width: 6 },
    { key: 'wallMs', label: 'wall ms', width: 8 },
    { key: 'medianAbsZFocus', label: 'medianΔz@focus(nm)', width: 19, fmt: v => v == null ? 'n/a' : v.toFixed(0) },
    { key: 'zAccuracyOk', label: 'z sane?', width: 8 },
    { key: 'gpuAsExpected', label: 'GPU as expected?', width: 17 },
  ]);

  const failed = rows.filter(r => (r.zAccuracyOk !== true && r.zAccuracyOk !== 'n/a (no z)') || !r.gpuAsExpected);
  for (const r of failed) if (r.gpuErr) console.error(`⚠ ${r.label}: ${r.gpuErr}`);

  const outFile = writeResults('bench-3d-fit', { config: BASE_CONFIG, focusFrame: FOCUS_FRAME, cases: rows });
  console.log(`\nFull results written to ${outFile}`);
  if (failed.length) { console.error(`\n${failed.length}/${rows.length} case(s) failed.`); process.exitCode = 1; }
  else console.log('\nAll 3D fit self-consistency checks passed.');
} finally {
  await browser.close();
}
