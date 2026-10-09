#!/usr/bin/env node
// SPT tracking correctness check, against a KNOWN answer — the built-in
// synthetic generator has no correlated-motion/trajectory model (each
// blinking event is independent, no frame-to-frame linkable track), so
// there's no way to exercise sptTrack via the app's own generator. Proxy:
// a small, hand-built CSV fixture (same webSMLM CSV load path bench-sSMLM.mjs
// uses) with DETERMINISTIC constant-step motion, so the diffusion coefficient
// is analytically predictable from trackDiffusionCoeffs()'s own formula
// (webSMLM.html: D = msd/(4*frametime) - locErrorUm²/frametime) — checked
// against a known expected D, not just "did it throw".
//
// Two independent tracks, spatially far apart (>> sptSearchRange) so they
// never cross-link, each with a different known per-frame step:
//   Track A: 100 nm/frame  → msd=(0.1µm)²=0.01µm²
//   Track B: 200 nm/frame  → msd=(0.2µm)²=0.04µm²
// plus one length-1 "track" (a single isolated point, far from both) to
// confirm sptTrackLenMin correctly excludes it from the D estimate while
// still counting it in nTracks (every loc gets a track_id, per the app's
// own doc comment on sptCore()).
//
// Usage: cd tests && npm install (once), then node bench-spt.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';

const N_FRAMES = 10;
const FRAMETIME = 0.01, LOC_ERROR_NM = 35, SEARCH_RANGE_NM = 800, MEMORY = 0, TRACK_LEN_MIN = 5;
const STEP_A = 100, STEP_B = 200;   // nm/frame

function expectedD(stepNm) {
  const msdUm2 = (stepNm / 1000) ** 2;
  const locErrorUm = LOC_ERROR_NM / 1000;
  return msdUm2 / (4 * FRAMETIME) - (locErrorUm * locErrorUm) / FRAMETIME;
}

function buildCsv() {
  const header = '"id","frame","x [nm]","y [nm]","sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"';
  const rows = [header];
  let id = 1;
  const push = (frame, x, y) => rows.push(`${id++},${frame},${x.toFixed(1)},${y.toFixed(1)},130.0,1000.0,0.0,0.0,10.0`);
  for (let i = 0; i < N_FRAMES; i++) {
    push(i + 1, 1000 + STEP_A * i, 1000);   // Track A
    push(i + 1, 5000 + STEP_B * i, 5000);   // Track B — far from A, no cross-linking
  }
  push(5, 9000, 9000);   // isolated length-1 "track", far from both
  return rows.join('\n') + '\n';
}

const dir = mkdtempSync(join(tmpdir(), 'websmlm-spt-'));
const csvPath = join(dir, 'fixture-spt.csv');
writeFileSync(csvPath, buildCsv());

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', csvPath);
  const result = await page.evaluate(async ({ fileInputId, sptFrameTime, sptLocError, sptSearchRange, sptMemory, sptTrackLenMin }) => {
    // Same two gotchas bench-sSMLM.mjs already found and works around:
    // (1) parseCsvLocs() reads pxnm LIVE from the #pxnm DOM control, not
    // config.pxnm — must match or positions silently scale wrong.
    // (2) mag:1 — pxnm=1 makes nm-scale CSV coordinates the internal
    // "pixel" coordinates too, so the default mag=10 reconstruction would
    // blow past the ~16384px canvas limit analyze() always renders into.
    document.getElementById('pxnm').value = 1;
    document.getElementById('pxnm').dispatchEvent(new Event('change'));
    const config = { sptTrack: true, pxnm: 1, mag: 1, sptFrameTime, sptLocError, sptSearchRange, sptMemory, sptTrackLenMin };
    config.file = document.getElementById(fileInputId).files[0];
    const r = await window.webSMLM.analyze(config);
    const byTrack = new Map();
    for (const L of r.locs) { if (!byTrack.has(L.track_id)) byTrack.set(L.track_id, []); byTrack.get(L.track_id).push(L.D_coeff); }
    const tracks = [...byTrack.entries()].map(([id, ds]) => ({ id, n: ds.length, D: ds.find(Number.isFinite) ?? null }));
    return { spt: r.spt, logText: r.logText, tracks };
  }, { fileInputId: 'analyzeFileInput', sptFrameTime: FRAMETIME, sptLocError: LOC_ERROR_NM, sptSearchRange: SEARCH_RANGE_NM, sptMemory: MEMORY, sptTrackLenMin: TRACK_LEN_MIN });

  console.log(result.logText);

  const { nTracks, nQualify, meanD, medianD } = result.spt;
  const dA = expectedD(STEP_A), dB = expectedD(STEP_B);
  const qualifying = result.tracks.filter(t => t.n >= TRACK_LEN_MIN);
  const foundA = qualifying.some(t => Math.abs(t.D - dA) < 1e-6);
  const foundB = qualifying.some(t => Math.abs(t.D - dB) < 1e-6);

  const checks = [
    ['nTracks == 3 (A, B, and the length-1 isolate)', nTracks === 3, `${nTracks}`],
    [`nQualify == 2 (only tracks with >=${TRACK_LEN_MIN} locs get a D estimate)`, nQualify === 2, `${nQualify}`],
    [`Track A's D ≈ ${dA.toFixed(4)} µm²/s (100 nm/frame step)`, foundA, foundA ? 'found' : 'NOT found'],
    [`Track B's D ≈ ${dB.toFixed(4)} µm²/s (200 nm/frame step)`, foundB, foundB ? 'found' : 'NOT found'],
    ['meanD/medianD are finite', Number.isFinite(meanD) && Number.isFinite(medianD), `mean=${meanD.toFixed(4)}, median=${medianD.toFixed(4)}`],
  ];
  console.log('');
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} (${detail})`);

  const failed = checks.filter(c => !c[1]);
  const outFile = writeResults('bench-spt', { nFrames: N_FRAMES, stepA: STEP_A, stepB: STEP_B, expectedDA: dA, expectedDB: dB, spt: result.spt, checks: checks.map(c => ({ label: c[0], ok: c[1], detail: c[2] })) });
  console.log(`\nFull results written to ${outFile}`);
  if (failed.length) { console.error(`\n${failed.length} check(s) failed.`); process.exitCode = 1; }
  else console.log('\nAll SPT tracking checks passed.');
} finally {
  await browser.close();
}
