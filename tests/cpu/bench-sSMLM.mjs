#!/usr/bin/env node
// sSMLM pair-finding correctness check, against a KNOWN answer — no real
// local dataset covers this feature (Zenodo Dataset IV, experimental_data/
// README.md, is 19.3 GB and not fetched here) and the built-in synthetic
// generator has no spectral-dispersion model to produce paired 0th/1st-order
// data. Proxy: a small, hand-built CSV fixture (webSMLM's CSV load path,
// config.file ending in .csv, v0.11.13+) with a KNOWN pair geometry —
// this is a "real simulation" for a feature with no real fixture available,
// checked against a known expected answer, not just "did it throw".
//
// Geometry (matches PARAMS.sSmlmDistMin/Max/AngleCenter/AngleTol DEFAULTS —
// 2200-2800 nm, 0°±5° — so the config below needs no sSmlm* overrides at
// all): per frame, a 0th-order point and its 1st-order partner exactly
// 2500 nm to the right (bearing 0°, i.e. the pairCore()/sSmlmCandidates()
// convention atan2(dy,dx) with dy=0). Two DECOY points per frame are NOT
// meant to pair: one at the right distance but a 90° bearing (angle-
// rejected), one at the right bearing but 5000 nm away (distance-rejected,
// never even becomes a candidate). Worked through pairCore()'s own
// directional accept/reject logic by hand (see this script's own comments
// below) to confirm neither decoy can form a spurious pair with the real
// 1st-order point either, via the hasIncoming() exclusion — this is a real
// check of the rejection logic, not just the happy path.
//
// Usage: cd tests && npm install (once), then node bench-sSMLM.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';

const N_FRAMES = 10;
const DIST = 2500;   // nm, within [sSmlmDistMin=2200, sSmlmDistMax=2800]

function buildCsv() {
  const header = '"id","frame","x [nm]","y [nm]","sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"';
  const rows = [header];
  let id = 1;
  for (let frame = 1; frame <= N_FRAMES; frame++) {
    const x0 = 1000, y0 = 1000;
    const pts = [
      [x0, y0],                  // 0th order
      [x0 + DIST, y0],           // real 1st order — bearing 0°, dist 2500nm
      [x0, y0 + DIST],           // decoy: right distance, bearing 90° — angle-rejected
      [x0 + 2 * DIST, y0],       // decoy: right bearing, dist 5000nm — distance-rejected
    ];
    for (const [x, y] of pts) rows.push(`${id++},${frame},${x.toFixed(1)},${y.toFixed(1)},130.0,1000.0,0.0,0.0,10.0`);
  }
  return rows.join('\n') + '\n';
}

const dir = mkdtempSync(join(tmpdir(), 'websmlm-sSmlm-'));
const csvPath = join(dir, 'fixture-sSmlm.csv');
writeFileSync(csvPath, buildCsv());

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', csvPath);
  const result = await page.evaluate(async ({ fileInputId }) => {
    // parseCsvLocs() (webSMLM.html) reads pxnm LIVE from the #pxnm DOM
    // control via paramValue('pxnm'), not from config.pxnm — a real
    // discrepancy from the rest of analyze()'s config-driven design, found
    // while building this fixture (config.pxnm=1 alone silently produced
    // 0 pairs: positions got divided by the DOM's default pxnm on load,
    // then re-multiplied by config.pxnm=1 in pairCore, an uncancelled
    // scale mismatch). Setting the DOM control to match config.pxnm here
    // works around it so THIS test exercises sSMLM pairing, not that gap.
    document.getElementById('pxnm').value = 1;
    document.getElementById('pxnm').dispatchEvent(new Event('change'));
    // mag:1 — with pxnm=1 the CSV's nm-scale coordinates ARE the internal
    // "pixel" coordinates, so the default mag=10 reconstruction would be
    // ~60000px/side (way past the ~16384px canvas limit analyze() always
    // renders into, even though this test only cares about sSmlmPair).
    const config = { sSmlmPair: true, pxnm: 1, mag: 1 };

    config.file = document.getElementById(fileInputId).files[0];
    const r = await window.webSMLM.analyze(config);
    return { sSmlmPair: r.sSmlmPair, logText: r.logText };
  }, { fileInputId: 'analyzeFileInput' });

  console.log(result.logText);

  const { nPairs, nInput, meanDistance, stdDistance } = result.sSmlmPair;
  const checks = [
    ['nInput == 40 (10 frames × 4 points)', nInput === 4 * N_FRAMES, `${nInput}`],
    [`nPairs == ${N_FRAMES} (one real pair per frame, both decoys rejected)`, nPairs === N_FRAMES, `${nPairs}`],
    [`meanDistance ≈ ${DIST} nm`, Math.abs(meanDistance - DIST) < 1, `${meanDistance.toFixed(2)} nm`],
    ['stdDistance ≈ 0 (every real pair is identical)', stdDistance < 1, `${stdDistance.toFixed(3)} nm`],
  ];
  console.log('');
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} (${detail})`);

  const failed = checks.filter(c => !c[1]);
  const outFile = writeResults('bench-sSMLM', { nFrames: N_FRAMES, dist: DIST, sSmlmPair: result.sSmlmPair, checks: checks.map(c => ({ label: c[0], ok: c[1], detail: c[2] })) });
  console.log(`\nFull results written to ${outFile}`);
  if (failed.length) { console.error(`\n${failed.length} check(s) failed.`); process.exitCode = 1; }
  else console.log('\nAll sSMLM pairing checks passed.');
} finally {
  await browser.close();
}
