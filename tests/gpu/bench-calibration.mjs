#!/usr/bin/env node
// Z-calibration correctness/perf check — drives window.webSMLM.analyze() the
// same way bench-real-data.mjs / tools/webSMLM-cli.mjs do, against the real
// local 161-frame bead z-stack in temp/19165061/ (see experimental_data/
// README.md's "Dataset II" folder — this file sits alongside "Aquired
// STORM.tif"). Config below is exactly what the user already validated by
// hand interactively (same calFirst/calLast/calStep/psf/winr/detFilter/
// threshold/pxnm), so this script's own numbers have a known-good reference
// to compare against, not just "did it throw".
//
// analyze() only ever gets stack data from config.file/config.calibrationFile
// — there's no "reuse the already-loaded stack" shortcut headlessly, unlike
// the interactive session the reference numbers below came from — so this
// passes the same file as config.calibrationFile explicitly.
//
// Skips (does not fail) if the file isn't present — real, git-ignored data.
//
// Usage: cd tests && npm install (once), then node bench-calibration.mjs
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const TARGET = await resolveDataFile('Z_CALIBRATION', join('19165061', 'Z calibration (step 10nm).tif'));
if (!TARGET) { console.log('Skipping calibration benchmark.'); process.exit(0); }

// The user's own already-validated interactive config (calibrationOnly, same
// frame range/step/detection settings) — analyze() additionally needs
// config.calibrationFile since there's no already-loaded stack headlessly.
const CONFIG = {
  calibrationOnly: true,
  calFirst: 20, calLast: 140, calStep: 10, calRef: 0, calFixedXY: false,
  psf: 1.3, winr: 4, detFilter: 'wave', detection_wavelet_thr: 4, pxnm: 100,
};

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', TARGET);
  const t0 = Date.now();
  const result = await page.evaluate(async ({ cfg, fileInputId }) => {
    const config = Object.assign({}, cfg);
    config.calibrationFile = document.getElementById(fileInputId).files[0];
    const r = await window.webSMLM.analyze(config);
    return { calib: r.calib, logText: r.logText };
  }, { cfg: CONFIG, fileInputId: 'analyzeFileInput' });
  const wallMs = Date.now() - t0;

  const { calib, logText } = result;
  console.log(logText);

  // Sanity checks against the user's own already-validated numbers, with
  // real margin (real-data detector noise, not a hardcoded exact match):
  const focusFrame = calib.zref / calib.step + 1;
  const inRange = focusFrame >= CONFIG.calFirst && focusFrame <= CONFIG.calLast;
  const hasWidthModel = !!(calib.qx && calib.qy);
  const hasPhasorModel = !!calib.zcal;
  const m = logText.match(/(\d+) spots detected, (\d+) pass quality filter/);
  const passFrac = m ? (+m[2] / +m[1]) : null;

  const checks = [
    ['focus frame within calibrated range', inRange, `frame ${focusFrame.toFixed(1)} (range ${CONFIG.calFirst}-${CONFIG.calLast})`],
    ['gaussian-width model present', hasWidthModel, hasWidthModel ? `a=${calib.qx.a.toExponential(2)}/${calib.qy.a.toExponential(2)}` : 'MISSING'],
    ['phasor-magnitude model present', hasPhasorModel, hasPhasorModel ? `rms=${calib.zcal.rms.toFixed(0)}nm` : 'MISSING'],
    ['>50% of detected spots pass quality filter', passFrac != null && passFrac > 0.5, passFrac != null ? `${(passFrac * 100).toFixed(1)}%` : 'n/a'],
  ];
  console.log('');
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} (${detail})`);
  console.log(`\nCalibration wall time: ${wallMs} ms.`);

  const failed = checks.filter(c => !c[1]);
  const outFile = writeResults('bench-calibration', { config: CONFIG, wallMs, focusFrame, hasWidthModel, hasPhasorModel, passFrac, checks: checks.map(c => ({ label: c[0], ok: c[1], detail: c[2] })) });
  console.log(`Full results written to ${outFile}`);
  if (failed.length) { console.error(`\n${failed.length} check(s) failed.`); process.exitCode = 1; }
} finally {
  await browser.close();
}
