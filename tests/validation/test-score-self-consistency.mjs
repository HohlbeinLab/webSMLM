#!/usr/bin/env node
// Self-consistency of the harness's simulate + score layer (tests/lib/simulate.mjs,
// tests/lib/score.mjs): score the simulator's OWN per-emitter-frame answer against its own ground
// truth and confirm the scorer reports a near-perfect result. If this is not ~1.0/~0 nm, no number
// any later phase reports about any tool means anything.
//
// The localizations are the ground-truth CSV that Save sim. movie wrote to disk, parsed back in
// Node — i.e. exactly the route a real tool's localizations take (a file, in nm, with a 1-based
// frame column), not a page global. It therefore also checks the trueDrift rehydration: the CSV's
// x/y include the simulated drift, so a wrong drift accessor shows up immediately as a bias.
//
// Deliberately NOT at default validation settings: scoreTruthCore() classifies emitter-frames by
// validation_minPhotons (300), validation_border (-1 = auto) and validation_crowdRadius (300), so
// even a perfect input yields counts below 1 because dim/edge/crowded emitters are excluded or
// marked don't-care. Per CLAUDE.md those three at 0 "must reproduce the unclassified numbers
// exactly", which is what makes a 1.0 assertion meaningful.
//
// `--perturb=<nm>` shifts every localization in x by that many nm; the run MUST then fail. That is
// how this test is proved able to fail at all (see the Phase 1 report for the recorded output).
import { launchPage, checkGpu } from '../lib/launch.mjs';
import { simulateInPage } from '../lib/simulate.mjs';
import { scoreLocsInPage, locsFromGroundTruthCsv } from '../lib/score.mjs';
import { writeResults } from '../lib/report.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const perturbNm = Number((process.argv.find(a => a.startsWith('--perturb=')) || '').slice('--perturb='.length)) || 0;

// Small and fast on purpose: this checks the correctness of plumbing, not statistics. uniform3D
// rather than the default microtubules — no cell field to build, and CLAUDE.md's own advice is to
// quote accuracy from uniform3D.
const PARAMS = {
  simulation_structureType: 'uniform3D',
  simulation_seed: 20261001,
  frames: 50, simulation_fov: 64, dens: 1.0,
  simulation_pxnm: 100, frametime: 0.02,
  // One blink per molecule (the 'min' Physics-detail preset's own value), so a molecule id
  // identifies exactly one structure site and the coincidence filter below can key on it. Blinks
  // still straddle frame boundaries, so fractional-photon emitter-frames are still exercised.
  simulation_blinkBleachProb: 1,
  driftpx: 3,                       // non-zero: the scorer must use the true drift to place truth
  useGpu: false,
};
// minPhotons/border/crowdRadius at 0 => every emitter-frame counts (see header).
const SCORE_CFG = { validation_minPhotons: 0, validation_border: 0, validation_crowdRadius: 0 };

const { browser, page } = await launchPage({ headless: true });
try {
  const gpu = await checkGpu(page);

  const a = await simulateInPage(page, PARAMS, { name: 'selfcons' });
  console.log(`  simulated: ${a.frames} frames ${a.w}×${a.h} px · ${a.nEvents} blinks of ${a.nMolecules} molecules · ${a.driftTotalPx} px drift`);
  console.log(`  wrote ${a.tiffPath}`);
  console.log(`         ${a.gtCsvPath}`);
  assert.ok(a.tiffPath && a.gtCsvPath, 'Save sim. movie wrote both the TIFF and the ground-truth CSV');

  // spawnMolecules() draws structure sites WITH REPLACEMENT (`gt[Math.floor(r()*gt.length)]`), so
  // several molecules can sit on one site — the ground truth then holds two emitter-frames at the
  // IDENTICAL position. No single-emitter localizer can report two points there, and matchFrame()'s
  // gridNN() is unidirectional, so both perfect localizations propose that one truth: one becomes an
  // FP and its twin an FN. Measured on this movie: 173 coincident emitter-frames of 4928 gave
  // exactly 173 FP + 173 FN, Jaccard 0.9320. That is a property of the sample and of the scorer's
  // matcher, not of this plumbing, so the colliding molecules are dropped from BOTH sides (the truth
  // is plain data here) and what remains must score exactly 1 — a sharper assertion than any
  // tolerance on Jaccard would be. The count is reported, and asserted to stay a small minority.
  const { gt, keptMol, nDropped } = withoutCoincidentSites(a.groundTruth);
  const locs = locsFromGroundTruthCsv(readFileSync(a.gtCsvPath, 'utf8'), a.pxNm)
    .filter(L => keptMol.has(L.moleculeId));
  console.log(`  dropped ${nDropped} of ${a.nEvents} blinks that share a site AND a frame with another; scoring ${locs.length} emitter-frames`);
  assert.ok(locs.length > 50, `enough emitter-frames left to score (${locs.length})`);
  assert.ok(nDropped < 0.25 * a.nEvents, `site collisions are a minority of the truth (${nDropped}/${a.nEvents})`);
  if (perturbNm) for (const L of locs) L.x += perturbNm / a.pxNm;

  const s = await scoreLocsInPage(page, locs, gt, SCORE_CFG);
  console.log(`  scored ${locs.length} truth localizations${perturbNm ? ` (PERTURBED +${perturbNm} nm in x)` : ''}: ` +
    `tp ${s.tp} fp ${s.fp} fn ${s.fn} · Jaccard ${s.jaccard.toFixed(6)} · median lateral ${s.medLat.toFixed(3)} nm · ` +
    `RMSE ${s.rmseLat.toFixed(3)} nm · bias (${s.biasX.toFixed(3)}, ${s.biasY.toFixed(3)}) nm`);
  console.log(`  ${s.nIgnoredGT} emitter-frame(s) outside the frame are don't-care, ${s.nIgnoredPairs} of them matched; ` +
    `theoretical CRLB model ${s.hasCrlbModel ? 'built' : 'absent'}`);

  // Tolerance: buildGroundTruthCsv() writes x/y to 0.1 nm, so each axis carries at most 0.05 nm of
  // rounding and the lateral error at most hypot(0.05,0.05) = 0.071 nm. 0.25 nm leaves room for the
  // nm->px->nm round trip without being able to hide a real offset. (The 1 nm lpx/lpy the simulator
  // pins on groundTruthLocs is a render hint, not a position uncertainty — it does not enter here.)
  const TOL_NM = 0.25;
  assert.ok(Math.abs(s.jaccard - 1) < 1e-6, `Jaccard must be 1 for perfect input, got ${s.jaccard}`);
  assert.equal(s.fp, 0, 'no false positives on perfect input');
  assert.equal(s.fn, 0, 'no misses on perfect input');
  assert.ok(s.medLat < TOL_NM, `median lateral error must be under ${TOL_NM} nm, got ${s.medLat.toFixed(3)} nm`);
  assert.ok(s.rmseLat < TOL_NM, `lateral RMSE must be under ${TOL_NM} nm, got ${s.rmseLat.toFixed(3)} nm`);
  assert.ok(Math.abs(s.biasX) < TOL_NM, `x bias must be under ${TOL_NM} nm, got ${s.biasX.toFixed(3)} nm`);
  assert.ok(Math.abs(s.biasY) < TOL_NM, `y bias must be under ${TOL_NM} nm, got ${s.biasY.toFixed(3)} nm`);

  // The scored frame range must come from the ground truth's movie, never from the localizations.
  // scoreTruthCore() falls back to the locs' own min/max frame when cfg._runFirst/_runLast are
  // absent, and then truth in frames a tool produced nothing for is never counted as a miss — two
  // tools scored over two different denominators, which defeats the whole point of one shared truth.
  // Half the frames are dropped here, so recall MUST roughly halve. Without the fields it would come
  // back near 1.0 over the surviving 25-frame span.
  const half = Math.floor(a.frames / 2);
  const t = await scoreLocsInPage(page, locs.filter(L => L.frame < half), gt, SCORE_CFG);
  console.log(`  truncated to frames 0..${half - 1}: tp ${t.tp} fp ${t.fp} fn ${t.fn} · recall ${t.recall.toFixed(4)} ` +
    `(full-range recall ${s.recall.toFixed(4)})`);
  assert.ok(t.fn > 0.3 * s.tp, `the truth in dropped frames must be counted as misses, got fn ${t.fn} against ${s.tp} full-range hits`);
  assert.ok(Math.abs(t.recall - 0.5) < 0.1, `recall must roughly halve when half the frames are dropped, got ${t.recall.toFixed(4)}`);
  assert.equal(t.tp + t.fn, s.tp + s.fn, 'the counted truth (denominator) must not depend on which frames a tool reported');

  // Determinism (1): two runs at the same seed are BIT-identical. The emitter draws go through
  // mulberry32(simulation_seed) and the camera noise is counter-based (pcg4d over seed/frame/pixel),
  // so this is exact — compared by a pixel hash computed inside the page, no frames cross the bridge.
  const b = await simulateInPage(page, PARAMS, { writeFiles: false });
  console.log(`  frame hashes: run A ${a.framesHash} · run B (same seed) ${b.framesHash}  [${a.nPixels} pixels each]`);
  assert.equal(b.framesHash, a.framesHash, 'two runs at the same seed must produce identical frames');
  assert.equal(b.nEvents, a.nEvents, 'two runs at the same seed must produce the same blinks');

  // Determinism (2): the GPU frame path against the CPU one. NOT bit-identical, and that is not a
  // bug: the counter-based noise DRAWS are identical on both paths, but WGSL_SIM_FRAMES does the
  // splat in f32 where the CPU has f64, so a handful of pixels' expectation lands one integer ADU
  // apart after the clip. Measured here: 3 of 204,800 pixels differ, by exactly 1 ADU
  // (99.9985% identical). The app's own criterion for this comparison is tests/gpu/test-sim-gpu.mjs
  // check (f), "≥ 99.9% of pixels within 1e-3 ADU", and that is what is asserted — the hashes are
  // printed too, so the difference stays visible instead of being swallowed by the tolerance.
  const g = await page.evaluate(async () => {
    const hash = fr => { let h = 0x811c9dc5;
      for (const f of fr) { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
        for (let i = 0; i < u.length; i++) h = ((h ^ u[i]) * 16777619) >>> 0; }
      return h.toString(16).padStart(8, '0'); };
    const el = $('useGpu'), out = [];
    for (const on of [false, true]) {
      el.checked = on; el.dispatchEvent(new Event('change'));
      const st = await generateSynthetic();
      out.push({ path: lastSimTimings.path, frames: await st.getFrames(0, st.n) });
    }
    el.checked = false; el.dispatchEvent(new Event('change'));
    const [A, B] = out.map(o => o.frames);
    let tot = 0, close = 0, maxAbs = 0;
    for (let fi = 0; fi < A.length; fi++) for (let i = 0; i < A[fi].length; i++) {
      const d = Math.abs(A[fi][i] - B[fi][i]); tot++; if (d <= 1e-3) close++; if (d > maxAbs) maxAbs = d; }
    return { paths: out.map(o => o.path).join('/'), hashCpu: hash(A), hashGpu: hash(B),
             tot, nDiff: tot - close, fracClose: close / tot, maxAbs };
  });
  console.log(`  useGpu off/on (${g.paths}): hashes ${g.hashCpu} / ${g.hashGpu} · ${g.nDiff} of ${g.tot} pixels differ ` +
    `(${(100 * g.fracClose).toFixed(4)}% identical, max |Δ| ${g.maxAbs} ADU)`);
  assert.equal(g.hashCpu, a.framesHash, 'generateSynthetic() reproduces the Simulate movie frames exactly');
  assert.ok(gpu.available ? g.paths === 'cpu/gpu' : true, `the GPU run must take the GPU path, took ${g.paths}`);
  assert.ok(g.fracClose >= 0.999, `useGpu must leave ≥99.9% of pixels within 1e-3 ADU, got ${(100 * g.fracClose).toFixed(4)}%`);

  writeResults('score-self-consistency', {
    params: PARAMS, scoreCfg: SCORE_CFG, perturbNm,
    movie: { w: a.w, h: a.h, frames: a.frames, pxNm: a.pxNm, frameTimeS: a.frameTimeS,
             nEvents: a.nEvents, nMolecules: a.nMolecules, nHaze: a.nHaze, driftTotalPx: a.driftTotalPx },
    nLocsScored: locs.length, nCoincidentBlinksDropped: nDropped,
    truncatedHalf: { frames: half, tp: t.tp, fp: t.fp, fn: t.fn, recall: t.recall },
    score: s,                      // already stripped of the per-TP residual arrays (see score.mjs)
    determinism: { gpuAvailable: gpu.available, hashA: a.framesHash, hashB: b.framesHash, gpu: g },
  });
  console.log('Score self-consistency: PASS');
} finally { await browser.close(); }

// Drops every blink that shares a structure site with another blink whose ON window can reach the
// same frame, from the ground truth's column arrays — plain bookkeeping on the saveGroundTruth()
// JSON. Sharing a site is common (most molecules do, since sites are drawn with replacement); only
// sharing a site AND a FRAME is unmatchable, so only that is cut. Needs one blink per molecule so
// the kept set can be expressed as molecule ids, which is how the CSV's rows are filtered to match.
//
// *** ONLY VALID BECAUSE THE LOCALIZATIONS SCORED HERE ARE THE TRUTH ITSELF. Do NOT reuse this when
// scoring a real tool: the dropped emitters' photons are still in the TIFF, so a localizer would
// legitimately report them and every one would land as a false positive against a truth that no
// longer contains them. ***
//
// win() is a deliberately coarse copy of groundTruthByFrame()'s floor(tStart)..floor(tEnd) window,
// without its `ov>0` guard, and it can invert when tStart >= nFrames. Both deviations only ever make
// the interval test fire more often, i.e. drop more — never leave a coincidence in — which is the
// safe direction for this filter, so neither is worth reproducing exactly.
function withoutCoincidentSites(src) {
  const E = src.events, n = E.x.length, nF = src.movie.frames;
  const perMol = new Map();
  for (let i = 0; i < n; i++) perMol.set(E.moleculeId[i], (perMol.get(E.moleculeId[i]) || 0) + 1);
  for (const c of perMol.values())
    if (c !== 1) throw new Error('withoutCoincidentSites() needs one blink per molecule — set simulation_blinkBleachProb to 1.');
  const bySite = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${E.x[i]},${E.y[i]},${E.z[i]}`;
    let a = bySite.get(k); if (!a) bySite.set(k, a = []); a.push(i);
  }
  const win = i => [Math.max(0, Math.floor(E.tStart[i])), Math.min(nF - 1, Math.floor(E.tEnd[i]))];
  const drop = new Set();
  for (const ix of bySite.values()) {
    if (ix.length < 2) continue;
    const iv = ix.map(win);
    for (let a = 0; a < ix.length; a++) for (let b = a + 1; b < ix.length; b++)
      if (iv[a][0] <= iv[b][1] && iv[b][0] <= iv[a][1]) { drop.add(ix[a]); drop.add(ix[b]); }
  }
  const keep = []; for (let i = 0; i < n; i++) if (!drop.has(i)) keep.push(i);
  const events = Object.fromEntries(Object.keys(E).map(k => [k, keep.map(i => E[k][i])]));
  return { gt: { ...src, events }, keptMol: new Set(events.moleculeId), nDropped: drop.size };
}
