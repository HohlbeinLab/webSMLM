#!/usr/bin/env node
// The reproducible regime sweep: a fixed, seeded set of simulated imaging regimes, each localized
// by the app's own analyze() and scored by the app's own scoreTruthCore() (through
// tests/lib/score.mjs, the harness's one scoring authority), emitted as ONE FLAT ROW PER CELL.
//
// Why a sweep and not a single test: a fitter change shows up as a number moving in a known
// regime, not as "the synthetic image looked fine". Why OFAT (one factor at a time) and not a
// cross-product: 22 cells cover the axes that matter; a cross-product explodes for no added
// insight. The one exception is dens x phot — crowded-and-dim is where single-emitter fitting
// actually breaks and it is not additive, so those four corners are swept explicitly.
//
// Output: tests/results/regime-matrix-*.json (writeResults()). JSON only; a later phase renders
// it. Rows are flat and tidy — every swept parameter is its own column even when unswept in that
// cell, so the table needs no joins. Nested per-cell extras (bins, sweeps, logs) live under a
// sibling `detail[cell_id]`.
//
// ---------------------------------------------------------------------------------------------
// THE COINCIDENCE CEILING (jaccard_ceiling) — why no cell can reach Jaccard 1
//
// generateSynthetic()/spawnMolecules() picks emitter sites WITH REPLACEMENT
// (`const gi = Math.floor(r() * gt.length)`), so two distinct molecules can sit on the IDENTICAL
// site and be ON in the same frame. scoreTruthCore() matches one-to-one, and a single-emitter
// fitter returns ONE localization for an unresolved group — so every extra truth point in that
// group is a forced FN that no tool can avoid. That ceiling RISES WITH DENSITY, and dens is one
// of the axes here, so leaving it out makes the density axis uninterpretable: part of the Jaccard
// drop would be structural and part real, with no way to tell which.
//
// Computed here from the ground truth ALONE (never from the nominal `dens` — the realized Poisson
// rate under the blinking kinetics is well below it, so a nominal figure is off by ~2x):
//   1. expand the GT events to emitter-frames exactly as groundTruthByFrame() does (same
//      overlap>0 rule), adding the simulator's per-frame drift as scoreTruthCore() does;
//   2. keep only the COUNTED ones, mirroring scoreTruthCore()'s own `cares()`:
//      !haze && phot >= minPhotons && inside the border — using the minPhotons/borderPx the
//      scorer itself reported for this cell, so the two populations are identical by construction;
//   3. per frame, single-linkage group the counted points at the match radius (lateral, in nm);
//   4. a perfect single-emitter localizer yields one TP per group and (k-1) FNs for a group of k,
//      with no FPs, so  jaccard_ceiling = (number of groups) / (counted emitter-frames).
// `jaccard_norm = jaccard / jaccard_ceiling` is the fitter's share of what was reachable.
// Coincident emitters are deliberately NOT dropped: their photons are in the movie and a
// localization of them is legitimate.
//
// detail[].coincidence also carries the pairwise `fracWithinRadius` (fraction of counted
// emitter-frames with another within the match radius) and `fracExact` (within 1 nm — the purely
// structural sampling-with-replacement share, which no multi-emitter fitter could resolve either).
//
// ---------------------------------------------------------------------------------------------
// PASS/FAIL — three tiers. Exit non-zero on any tier-1 failure or tier-2 regression.
//   Tier 1  physics invariants, machine-independent, NEVER tuned. Beating the Cramer-Rao bound
//           means the simulator or the scorer is broken, which is a sharper test than any
//           accuracy floor. Skipped (and marked crlb:"unavailable") when the ground truth carries
//           no `_theory` block, since the theoretical CRLB is then genuinely unknown — a skipped
//           check is never reported as a pass.
//   Tier 2  regression against tests/baselines/regime-matrix.json, written by
//           `--full --write-baseline` as the median of the seed replicates plus the OBSERVED
//           per-metric seed spread. The tolerance is 3x that spread (floored), so it is derived
//           from measurement rather than hand-picked. No baseline entry => status "new".
//   Tier 3  engine isolation: `engine`/`gpu_adapter` are recorded and baselines are keyed per
//           engine. CPU==GPU is deliberately NOT asserted — that is tests/gpu/'s job and would
//           fail on ordinary f32/f64 noise.
//
// Usage:  node tests/validation/bench-regime-matrix.mjs [--full] [--write-baseline]
//                [--headless] [--only=<substring>] [--no-baseline]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchPage, repoRoot } from '../lib/launch.mjs';
import { simulateInPage } from '../lib/simulate.mjs';
import { scoreLocsInPage, DEFAULT_SCORE_CFG } from '../lib/score.mjs';
import { writeResults, printTable } from '../lib/report.mjs';

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const WRITE_BASELINE = argv.includes('--write-baseline');
const NO_BASELINE = argv.includes('--no-baseline');
const HEADLESS = argv.includes('--headless');
const ONLY = (argv.find(a => a.startsWith('--only=')) || '').slice(7);

const BASELINE_DIR = join(repoRoot, 'tests', 'baselines');
const BASELINE_FILE = join(BASELINE_DIR, 'regime-matrix.json');
// WHAT THIS BENCHMARK MEASURES — read before quoting a number from it.
// Detection and fit settings are held FIXED at the anchor (the window and seed sigma_PSF follow the
// PSF, nothing else moves) while the imaging regime is swept. So a row says "webSMLM at anchor
// settings in this regime", which is what a regression benchmark must hold constant — it is NOT
// webSMLM's best achievable in that regime, which a real user would reach by retuning the threshold
// and window per regime. Reading jaccard 0.002 at dens 3.0 as "the app fails at high density" is the
// trap: much of that gap is untuned settings, not capability. Hence `benchmark_kind` in the JSON and
// the sentence the summary prints.
const BENCHMARK_KIND = 'regression-fixed-settings';

const THIN_TP = 2000;                   // below this a cell's medians/percentiles are noise, not a measurement
// Below this many matched pairs the tier-1 statistics (bias, photometry, median error vs the CRLB)
// are computed from too few samples to test anything, so they are SKIPPED and marked as skipped —
// never reported as a pass. n_locs>0 still applies. This is not a tolerance: no threshold moves,
// a statistic that cannot be measured simply is not claimed.
const MIN_PAIRS_FOR_STATS = 100;
const TARGET_EMITTER_FRAMES = 6000;     // nominal emitter-frames per cell; frames are derived from it
// The floor matters more than the formula. Two measured reasons the nominal target is not what makes
// a cell measurable: (1) the realized Poisson rate under the blinking kinetics is about half the
// nominal `dens`, and (2) only the counted emitter-frames the detector actually FINDS become matched
// pairs (anchor recall ~0.25). At the anchor, 150 frames already met the 6000 nominal target —
// 7542 COUNTED emitter-frames — while tp was only 1890, i.e. thin. 600 frames puts anchor tp near
// 7500, comfortably past THIN_TP, and the whole default sweep still finishes well inside its budget.
// A cell whose recall is genuinely near zero (dens 3.0, phot 8000) stays thin, correctly.
const FRAMES_MIN = 600;
const LOC_CHUNK = 100000;               // locs cross the CDP bridge in pieces, as run-webSMLM.mjs does

// ---------------------------------------------------------------------------------------------
// The anchor. Every cell is this plus one (or, for the corners, two) overrides.
const ANCHOR_SIM = {
  simulation_structureType: 'microtubules',
  simulation_psfModel: 'zernike',
  simulation_psfZernikePreset: 'astigModerate',
  simulation_cameraType: 'scmos',
  dens: 0.5, phot: 2000, simbg: 10,
  simulation_zRange: 750,
  simulation_fov: 128, simulation_pxnm: 100,
  simulation_seed: 1234, simulation_mt_seed: 77,
  driftpx: 0,
};
// Fit side. winr comes from the shipped winr3d/winr2d defaults rather than a per-cell guess, and
// is recorded so a reader can see what window each number was measured with.
const ANCHOR_FIT = { method: 'mle3d', localize3D: true, winr: 4, psf: 1.3, shapeTest: true,
                     detFilter: 'wave', detection_wavelet_thr: 4 };
// 2D spherical. winr/psf are left out on purpose so they are still derived from the measured PSF.
const FIT_2D = { method: 'gaussmle', localize3D: false };

const REPLICATE_SEEDS = [1234, 991, 20260101];   // simulation_seed only: same structure, different blinking/noise

function buildCells() {
  const c = [];
  const add = (id, axis, level, sim = {}, fit = {}) => c.push({ id, axis, level, sim, fit });
  add('anchor', 'anchor', 'anchor');
  for (const d of [0.1, 1.5, 3.0]) add(`dens-${d}`, 'dens', d, { dens: d });
  for (const p of [500, 1000, 8000]) add(`phot-${p}`, 'phot', p, { phot: p });
  for (const b of [2, 40]) add(`simbg-${b}`, 'simbg', b, { simbg: b });
  // The z-range axis runs on uniform3D, NOT on the anchor's microtubules: the CellField's dye slab
  // around simulation_mt_focusZ is thinner than +/-400 nm, so clipping at 400/750/1200 removes
  // nothing and all three levels produce the IDENTICAL movie (verified by frames_hash). uniform3D
  // spreads emitters through the whole z range, so the axis actually perturbs the input. Its 750 nm
  // reference cell is in the default set for that reason — the axis is uninterpretable without it.
  add('structure-uniform3D', 'simulation_structureType', 'uniform3D', { simulation_structureType: 'uniform3D' });
  for (const z of [400, 1200])
    add(`zrange-${z}-uniform3D`, 'simulation_zRange (uniform3D)', z,
        { simulation_structureType: 'uniform3D', simulation_zRange: z });
  for (const k of ['saddlePoint', 'extendedRange'])
    add(`psfpreset-${k}`, 'simulation_psfZernikePreset', k, { simulation_psfZernikePreset: k });
  // A fixed-sigma Gaussian PSF has no z-dependent width, so generateCalibrationStack() refuses it
  // and there is nothing to fit z against: this cell is 2D by construction, not by choice.
  add('psfmodel-gaussian', 'simulation_psfModel', 'gaussian', { simulation_psfModel: 'gaussian' }, FIT_2D);
  add('camera-emccd', 'simulation_cameraType', 'emccd', { simulation_cameraType: 'emccd' });
  add('method-gaussmleEll', 'method', 'gaussmleEll', {}, { method: 'gaussmleEll' });
  add('method-gaussmle2d', 'method', 'gaussmle(2D)', {}, FIT_2D);
  for (const d of [1.5, 3.0]) for (const p of [500, 8000])
    add(`dens${d}-phot${p}`, 'dens x phot', `${d} x ${p}`, { dens: d, phot: p });
  add('shapetest-off', 'shapeTest', false, {}, { shapeTest: false });
  if (FULL) {
    for (const s of ['nup', 'filaments_ring', 'tiltedPlane', 'shell'])   // uniform3D is in the default set
      add(`structure-${s}`, 'simulation_structureType', s, { simulation_structureType: s });
    for (const dp of [1, 3]) add(`drift-${dp}`, 'driftpx', dp, { driftpx: dp });
    add('fov-256', 'simulation_fov', 256, { simulation_fov: 256 });
  }
  return ONLY ? c.filter(x => x.id.includes(ONLY)) : c;
}

// frames derived, not fixed: keep ~TARGET_EMITTER_FRAMES nominal emitter-frames per cell so
// medians, p90, the 12 photonBins and the per-z bins are stable rather than noise.
function framesFor(sim) {
  const areaUm2 = (sim.simulation_fov * sim.simulation_pxnm / 1000) ** 2;
  return Math.min(1500, Math.max(FRAMES_MIN, Math.round(TARGET_EMITTER_FRAMES / (areaUm2 * sim.dens))));
}

// Which PSF/geometry a 3D calibration depends on. phot/simbg are deliberately EXCLUDED and the
// bead stack always uses the anchor's brightness: a real calibration is one bright bead
// acquisition reused across experiments, not re-measured per sample brightness.
// simulation_zRange is in the key not because the bead stack changes with it (that follows
// simulation_psfZRange) but because the fit window below is sized over the z span being simulated.
const CALIB_KEY_FIELDS = ['simulation_psfModel', 'simulation_psfZernikePreset', 'simulation_fov',
                          'simulation_pxnm', 'simulation_cameraType', 'simulation_zRange'];

// ---------------------------------------------------------------------------------------------
// In-page work. Three evaluates: build a calibration, localize, read the live camera fields.

async function ensureCalibration(page, sim) {
  if (sim.simulation_psfModel !== 'zernike') return null;
  const key = CALIB_KEY_FIELDS.map(f => `${f}=${sim[f]}`).join('|');
  // The bead stack is generated at the anchor's brightness (see CALIB_KEY_FIELDS).
  const params = { ...sim, phot: ANCHOR_SIM.phot, simbg: ANCHOR_SIM.simbg };
  const r = await page.evaluate(async ({ key, params, winr, psf }) => {
    window.__calibCache = window.__calibCache || {};
    if (window.__calibCache[key]) return { ...window.__calibCache[key].info, key, cached: true };
    for (const [id, v] of Object.entries(params)) {
      const spec = PARAMS[id]; if (!spec) return { err: `unknown PARAMS id "${id}"` };
      const el = spec.id ? $(spec.id) : null;
      if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change')); }
      else paramOverrides[id] = v;
    }
    try {
      // generateCalibrationStack() + calibrationCore() directly: the DOM-free pair behind
      // "Calib. 3D stack" + "Calibrate". runCalibrationSimulation() is deliberately NOT used — it
      // calls clearAnalysisOutputs() and replaces the global stack, which would throw away the
      // ground truth of whatever movie is loaded.
      const { stack: st, focusIndex, zStepNm } = await generateCalibrationStack();
      const cam = simulatedCameraSettings();
      const cfg = { ...defaultConfig(), ...cam, pxnm: st.px, psf, winr,
                    calFirst: 1, calLast: st.n, calStep: zStepNm, calRef: focusIndex + 1,
                    calFixedXY: false, calFixedPts: null, sourceFile: 'simulated bead stack' };
      const logs = [];
      const cr = await calibrationCore(cfg, st, { onLog: m => logs.push(String(m)), onProgress: () => {} });
      if (!cr || !cr.calib) return { err: `calibrationCore returned nothing. ${logs.slice(-3).join(' ')}` };
      const w = buildCalibJson(cr.calib);
      // The PSF's own measured width, from the bead stack this very calibration fitted
      // (calib.pts: z nm, sx/sy nm). sigmaFocusPx (the width AT FOCUS) seeds sigma_PSF and sizes
      // the fit window by Smith et al. 2010's box rule, side 2*3*sigma+1 i.e. winr =
      // ceil(3*sigma) — the same winrForSigma() rule tests/validation/run-webSMLM.mjs uses.
      // sigmaMaxPx (the widest sigma over the simulated z span) is recorded but deliberately NOT
      // used for the window: a 3-sigma box of the most defocused plane spans several um^2 and so
      // contains other ON emitters at realistic density, which makes the Gaussian model wrong and
      // the shape test reject nearly everything (measured 93% at the anchor, vs 45% at focal
      // sizing). Don't size the window off the defocused width.
      const zLim = paramValue('simulation_zRange');
      const inZ = cr.calib.pts.filter(p => Math.abs(p.z) <= zLim);
      const pts = (inZ.length >= 8 ? inZ : cr.calib.pts);
      const widest = pts.map(p => Math.max(p.sx, p.sy) / st.px).sort((a, b) => a - b);
      // sigma at focus from the calibration's own FITTED quadratics, sigma(z) = a(z-c)^2 + b
      // evaluated at z = 0 (buildCalibJson()'s z is already relative to the sigma_x=sigma_y focus),
      // geometric mean of the two axes. NOT the median of the few near-focus bead points: that
      // estimator is a handful of samples from a bead stack whose per-pixel offset map
      // generateCalibrationStack() draws with the UNSEEDED gauss(), and on a wide engineered preset
      // it moved enough between identical runs to cross the 0.1 rounding step —
      // psfpreset-saddlePoint flipped psf_px 1.9 -> 2.1 and winr 6 -> 7, which alone moved its
      // jaccard by 0.037 and rmse_z_nm by 53 nm and tripped its own tier-2 tolerance. The
      // quadratics are fitted over ~1400 bead points, so they average that noise away.
      const sAt0 = q => (q && isFinite(q.a) && isFinite(q.b) && isFinite(q.c)) ? q.a * q.c * q.c + q.b : NaN;
      const sx0 = sAt0(w.sigma_x_nm), sy0 = sAt0(w.sigma_y_nm);
      const focFit = (isFinite(sx0) && isFinite(sy0) && sx0 > 0 && sy0 > 0)
        ? Math.sqrt(sx0 * sy0) / st.px : NaN;
      // Fallback only if the quadratics are unusable: the old near-focus bead median.
      const atFocus = cr.calib.pts.slice().sort((a, b) => Math.abs(a.z) - Math.abs(b.z)).slice(0, 9);
      const focPts = atFocus.map(p => Math.sqrt(Math.max(1e-6, p.sx * p.sy)) / st.px).sort((a, b) => a - b);
      const foc = isFinite(focFit) ? [focFit] : focPts;
      const info = { zStepNm, focusFrame: focusIndex + 1, frames: st.n,
                     hasWidthModel: !!(w.sigma_x_nm && w.sigma_y_nm), zRangeNm: w.z_range_nm || null,
                     nPts: cr.calib.pts.length, zLimNm: zLim,
                     // 90th percentile, not the max: one clamped bead fit should not size every window.
                     sigmaMaxPx: widest.length ? widest[Math.min(widest.length - 1, Math.floor(0.9 * widest.length))] : null,
                     sigmaFocusPx: foc.length ? foc[foc.length >> 1] : null };
      window.__calibCache[key] = { json: w, info };
      return { ...info, key, cached: false };
    } catch (err) { return { err: `${err.name}: ${err.message}` }; }
  }, { key, params, winr: ANCHOR_FIT.winr, psf: ANCHOR_FIT.psf });
  if (r.err) throw new Error(`calibration for ${key}: ${r.err}`);
  return r;
}

// Localize the movie simSaved holds, through the app's own headless entry point. The movie is
// re-encoded to a TIFF File in memory (encodeTiff16(), the same bytes Save sim. movie writes) and
// handed to analyze() as config.file: analyze() requires a file, and this keeps the sweep off disk
// — hundreds of TIFFs per --full run is not a thing to leave in tests/results/.
async function localizeInPage(page, fitCfg, calibKey, wantTruthScore) {
  const r = await page.evaluate(async ({ fitCfg, calibKey, wantTruthScore }) => {
    const sv = simSaved;
    if (!sv || !sv.stack) return { err: 'no simulated movie in simSaved' };
    const st = sv.stack, frames = await st.getFrames(0, st.n);
    const { parts } = encodeTiff16(frames, st.w, st.h, { pxNm: st.px, frameTimeS: sv.frameTimeS });
    const file = new File(parts, 'regime-cell.tif', { type: 'image/tiff' });
    const cached = calibKey ? (window.__calibCache || {})[calibKey] : null;
    const calibrationJson = cached ? cached.json : null;
    const cam = { gain: paramValue('gain'), camoffset: paramValue('camoffset'),
                  cameraExcessNoise: paramValue('cameraExcessNoise'), pcfoRnstd: paramValue('pcfoRnstd') };
    const cfg = { ...fitCfg, ...cam, pxnm: st.px, file, calibrationJson,
                  // mag 1: analyze() always renders and PNG-encodes a reconstruction, which is
                  // pure overhead here — nothing in this bench looks at the image.
                  mag: 1, useGpu: true, scoreVsTruth: !!wantTruthScore };
    const t0 = performance.now();
    let res;
    try { res = await window.webSMLM.analyze(cfg); }
    catch (err) { return { err: `analyze(): ${err.name}: ${err.message}` }; }
    const wallMs = performance.now() - t0;
    window.__wsLocs = res.locs.map(l => ({ frame: l.frame, x: l.x, y: l.y, z: l.z, photons: l.photons,
                                           lpx: l.lpx, lpy: l.lpy, lpz: l.lpz, zClamped: l.zClamped }));
    let truthScore = null;
    if (res.truthScore && !res.truthScore.err) {
      const { dx, dy, dz, zTrue, photonPairs, bins, ...rest } = res.truthScore;
      truthScore = { jaccard: rest.jaccard, recall: rest.recall, precision: rest.precision,
                     tp: rest.tp, fp: rest.fp, fn: rest.fn, medLat: rest.medLat, rmseLat: rest.rmseLat,
                     borderPx: rest.borderPx, minPhotons: rest.minPhotons };
    }
    const ad = res.execution && res.execution.adapter;
    return { n: window.__wsLocs.length, wallMs, truthScore,
             localizationMs: res.performance && res.performance.phases ? res.performance.phases.localizationMs : null,
             gpuFit: /GPU fit: /.test(res.logText),
             gpuAvailable: res.execution ? res.execution.gpuAvailable : null,
             adapter: ad ? [ad.vendor, ad.architecture, ad.device, ad.description].filter(Boolean).join(' ') || null : null,
             shapeTest: res.shapeTest || null,
             nCand: res.timings ? res.timings.nCand : null,
             logTail: res.logText.split('\n').filter(l => /detect|candid|fit|reject|stop|memory/i.test(l)).slice(0, 12),
             warnings: res.logText.split('\n').filter(l => l.includes('!!!')).slice(0, 8) };
  }, { fitCfg, calibKey, wantTruthScore });
  if (r.err) throw new Error(`localize: ${r.err}`);
  const locs = [];
  for (let i = 0; i < r.n; i += LOC_CHUNK) {
    const chunk = await page.evaluate(([a, b]) => window.__wsLocs.slice(a, b), [i, i + LOC_CHUNK]);
    for (const l of chunk) locs.push(l);
  }
  await page.evaluate(() => { window.__wsLocs = null; });
  return { ...r, locs };
}

// Camera fields the simulation wrote into Localisation (applySimulatedCameraSettings()), plus the
// simulated camera's own parameters, for the provenance columns.
const readSimParams = page => page.evaluate(() => ({
  gain: paramValue('simulation_gain'), offset: paramValue('simulation_offset'),
  readnoise: paramValue('simulation_readnoise'), qe: paramValue('simulation_qe'),
  emGain: paramValue('simulation_emGain'), sim3d: paramValue('simulation_3d'),
  structureFov: paramOverrides.simulation_structureFov ?? null,
}));

// ---------------------------------------------------------------------------------------------
// The coincidence ceiling, in Node, from the ground truth JSON. See the header for the derivation.
function coincidenceCeiling(gt, { matchRadiusNm, minPhotons, borderPx }) {
  const m = gt.movie, E = gt.events, N = E.x.length, pxNm = m.pxNm;
  const d = gt.drift;
  const dxNm = f => (d ? (d.dxNm[Math.min(f, d.dxNm.length - 1)] || 0) : 0);
  const dyNm = f => (d ? (d.dyNm[Math.min(f, d.dyNm.length - 1)] || 0) : 0);
  const byFrame = new Map();
  for (let i = 0; i < N; i++) {
    if (E.haze[i]) continue;                                   // haze is never cared for
    const t0 = E.tStart[i], t1 = E.tEnd[i], rate = E.rate[i];
    const f0 = Math.max(0, Math.floor(t0)), f1 = Math.min(m.frames - 1, Math.floor(t1));
    for (let f = f0; f <= f1; f++) {
      const ov = Math.min(f + 1, t1) - Math.max(f, t0);
      if (!(ov > 0)) continue;                                 // groundTruthByFrame()'s own rule
      const phot = rate === undefined ? Infinity : rate * ov;
      if (!(phot >= minPhotons)) continue;
      const x = E.x[i] + dxNm(f) / pxNm, y = E.y[i] + dyNm(f) / pxNm;   // scoreTruthCore() drifts the truth
      if (!(x >= borderPx && y >= borderPx && x <= m.w - 1 - borderPx && y <= m.h - 1 - borderPx)) continue;
      let a = byFrame.get(f); if (!a) { a = []; byFrame.set(f, a); } a.push([x, y]);
    }
  }
  const rPx = matchRadiusNm / pxNm;
  let counted = 0, groups = 0, withinR = 0, exact = 0;
  const exactPx = 1 / pxNm;                                    // 1 nm: the sampling-with-replacement share
  // ponytail: plain O(n^2) per frame — a frame holds tens to a few hundred counted emitters, same
  // reasoning scoreTruthCore()'s own crowding pass gives. Grid it only if a cell ever gets dense
  // enough to matter.
  for (const pts of byFrame.values()) {
    const n = pts.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const near = new Array(n).fill(false), nearX = new Array(n).fill(false);
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const dd = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
      if (dd <= rPx) { near[a] = near[b] = true; const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
      if (dd <= exactPx) nearX[a] = nearX[b] = true;
    }
    const roots = new Set(); for (let i = 0; i < n; i++) roots.add(find(i));
    counted += n; groups += roots.size;
    for (let i = 0; i < n; i++) { if (near[i]) withinR++; if (nearX[i]) exact++; }
  }
  return { countedEmitterFrames: counted, groups, framesWithTruth: byFrame.size,
           ceiling: counted ? groups / counted : NaN,
           fracWithinRadius: counted ? withinR / counted : NaN,
           fracExact: counted ? exact / counted : NaN,
           matchRadiusNm, minPhotons, borderPx };
}

// ---------------------------------------------------------------------------------------------
// Tier 1 — physics invariants. Never tuned; a failure is the benchmark doing its job.
function tier1(row) {
  const checks = [], fails = [];
  const chk = (name, ok, msg) => { checks.push({ name, ok: !!ok, msg: ok ? null : msg }); if (!ok) fails.push(`${name}: ${msg}`); };
  chk('n_locs>0', row.n_locs > 0, `n_locs=${row.n_locs}`);
  if (!(row.tp >= MIN_PAIRS_FOR_STATS)) {
    for (const n of ['bias_mag<15nm', 'photometry 0.8-1.25', 'med_lat>=0.8*crlb', 'med_lat<=3*crlb'])
      checks.push({ name: n, ok: null, msg: `only ${row.tp} matched pair(s) — below ${MIN_PAIRS_FOR_STATS}, not measurable` });
    return { checks, fails };
  }
  chk('bias_mag<15nm', isFinite(row.bias_mag_nm) && row.bias_mag_nm < 15, `bias_mag_nm=${fmt(row.bias_mag_nm)}`);
  // PHOTOMETRY IS A FIT-MODEL TEST, NOT A PHYSICS INVARIANT — do not re-tighten this to an
  // unconditional band. A Gaussian fit model cannot capture a Zernike/Gibson-Lanni PSF's wings, so a
  // ~20% photon undercount there is the physically EXPECTED outcome, not a defect: measured over the
  // Zernike cells, photom_median 0.802 median (0.557 extendedRange .. 1.163), against 1.022 on the
  // one cell where the fit model matches the generating model (psf_model 'gaussian', same camera,
  // same gain, same scorer — the only thing changed is the PSF). The absolute [0.8, 1.25] band
  // therefore holds ONLY where the models match; everywhere else photom_median is recorded and gated
  // against the tier-2 baseline instead, where a DRIFT from the committed value is meaningful.
  if (row.photom_median == null || !isFinite(row.photom_median))
    checks.push({ name: 'photometry', ok: null, msg: 'no photometry (needs >=10 photon pairs)' });
  else if (row.psf_model !== 'gaussian')
    checks.push({ name: 'photometry 0.8-1.25', ok: null,
                  msg: `not applicable: a Gaussian fit of a '${row.psf_model}' PSF undercounts photons by design (photom_median=${fmt(row.photom_median)}) — baselined under tier 2 instead` });
  else chk('photometry 0.8-1.25', row.photom_median >= 0.8 && row.photom_median <= 1.25, `photom_median=${fmt(row.photom_median)}`);
  if (row.crlb !== 'ok') {
    checks.push({ name: 'med_lat>=0.8*crlb', ok: null, msg: 'crlb unavailable' });
    checks.push({ name: 'med_lat<=3*crlb', ok: null, msg: 'crlb unavailable' });
  } else {
    chk('med_lat>=0.8*crlb', row.med_lat_nm >= 0.8 * row.crlb_lat_nm,
        `med_lat_nm=${fmt(row.med_lat_nm)} < 0.8*crlb_lat_nm=${fmt(0.8 * row.crlb_lat_nm)} — beating the Cramer-Rao bound means the simulator or the scorer is broken`);
    // UNCONDITIONAL, and it stays that way. An exemption keyed on engineered PSF preset / dens > 1.5
    // / shape test off was added to this file at one point and removed again: those three conditions
    // are exactly the five cells that were failing, so the exemption did nothing but turn measured
    // failures green without a single number changing. If 3x is the wrong ceiling for an aberrated or
    // crowded PSF, change the 3 and say so in the report — do not carve out the cells that fail it.
    // `lat_over_crlb` is recorded in the row either way, so the ratio is always visible.
    chk('med_lat<=3*crlb', row.med_lat_nm <= 3 * row.crlb_lat_nm,
        `med_lat_nm=${fmt(row.med_lat_nm)} > 3*crlb_lat_nm=${fmt(3 * row.crlb_lat_nm)}`);
  }
  return { checks, fails };
}

// Tier 2 — which metrics are baselined, and the floor under the measured-spread tolerance.
// `abs` metrics are unitless 0..1 (floor 0.02); `rel` metrics get 5% of the baseline, with a small
// absolute floor only so a baseline near zero cannot make the tolerance vanish.
const BASELINE_METRICS = {
  jaccard: { kind: 'abs', floor: 0.02 },
  jaccard_norm: { kind: 'abs', floor: 0.02 },
  recall: { kind: 'abs', floor: 0.02 },
  precision: { kind: 'abs', floor: 0.02 },
  photom_rsd_rel: { kind: 'abs', floor: 0.02 },
  // Baselined because the absolute band above cannot apply to a mismatched fit model (see tier1()).
  photom_median: { kind: 'abs', floor: 0.02 },
  eff_e3d: { kind: 'abs', floor: 1.0 },
  rmse_lat_nm: { kind: 'rel', rel: 0.05, floor: 1.0 },
  rmse_z_nm: { kind: 'rel', rel: 0.05, floor: 5.0 },
  bias_mag_nm: { kind: 'rel', rel: 0.05, floor: 1.0 },
};
const toleranceFor = (metric, base, spread) => {
  const s = BASELINE_METRICS[metric];
  const floor = s.kind === 'abs' ? s.floor : Math.max(s.floor, s.rel * Math.abs(base));
  return Math.max(3 * (spread || 0), floor);
};

function compareToBaseline(row, baseline) {
  const perEngine = baseline && baseline.engines && baseline.engines[row.engine];
  const entry = perEngine && perEngine[row.cell_id];
  if (!entry) return { status: 'new', regressions: [], deltas: {} };
  const regressions = [], deltas = {};
  for (const [metric, spec] of Object.entries(BASELINE_METRICS)) {
    const b = entry.metrics[metric];
    const v = row[metric];
    if (!b || !isFinite(b.median) || !isFinite(v)) continue;
    const tol = toleranceFor(metric, b.median, b.spread);
    const delta = v - b.median;
    deltas[metric] = { value: v, baseline: b.median, delta, tolerance: tol, spread: b.spread };
    if (Math.abs(delta) > tol)
      regressions.push(`${metric}: ${fmt(v)} vs baseline ${fmt(b.median)} (delta ${delta >= 0 ? '+' : ''}${fmt(delta)}, tolerance +/-${fmt(tol)} = max(3x seed spread ${fmt(b.spread)}, floor))`);
    void spec;
  }
  return { status: regressions.length ? 'regressed' : 'ok', regressions, deltas };
}

// Baseline from this run's rows: median per metric per cell_id per engine, plus the observed
// spread (max-min over the replicates — the honest range for a 3-replicate sample).
function buildBaseline(rows, meta) {
  const engines = {};
  for (const row of rows) {
    if (row.status === 'error') continue;
    const e = engines[row.engine] = engines[row.engine] || {};
    (e[row.cell_id] = e[row.cell_id] || { rows: [] }).rows.push(row);
  }
  for (const cells of Object.values(engines)) for (const [id, c] of Object.entries(cells)) {
    const metrics = {};
    for (const metric of Object.keys(BASELINE_METRICS)) {
      const vals = c.rows.map(r => r[metric]).filter(v => isFinite(v)).sort((a, b) => a - b);
      if (!vals.length) continue;
      metrics[metric] = { median: vals[vals.length >> 1], spread: vals[vals.length - 1] - vals[0] };
    }
    cells[id] = { n_replicates: c.rows.length, axis: c.rows[0].axis, level: c.rows[0].level, metrics };
  }
  return { format: 'webSMLM-regime-matrix-baseline', version: 1, created: new Date().toISOString(),
           ...meta, tolerance: 'max(3 x observed seed spread, 0.02 absolute / 5% relative)', engines };
}

// ---------------------------------------------------------------------------------------------
const fmt = v => (v == null || !isFinite(v) ? '-' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
const num = v => (v == null || !isFinite(v) ? null : v);
const wmean = (bins, key) => {   // pair-weighted mean over crlbBins, matching scoreTruthCore()'s wRatio()
  if (!bins) return null;
  let s = 0, n = 0;
  for (const b of bins) if (isFinite(b[key]) && b[key] > 0) { s += b.n * b[key]; n += b.n; }
  return n ? s / n : null;
};

function appBuild() {
  const m = readFileSync(join(repoRoot, 'webSMLM.html'), 'utf8').match(/<span class="pill">([^<]*)<\/span>/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}
function gitCommit() {
  try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); }
  catch { return null; }
}

// One flat row per cell. Column ORDER here is the contract: provenance, every swept parameter,
// validation settings, counts and metrics, timing, then the pass/fail bookkeeping.
function buildRow(ctx, cell, sim, fit, simR, locR, sc, coin, simP) {
  const crlbLat = wmean(sc.crlbBins, 'theoLat'), crlbZ = wmean(sc.crlbBins, 'theoZ');
  const crlb = crlbLat != null ? 'ok' : 'unavailable';
  const eff = sc.efficiency || {};
  const jaccard = num(sc.jaccard);
  const row = {
    run_id: ctx.runId, ts: new Date().toISOString(), cell_id: cell.id, axis: cell.axis, level: cell.level,
    status: 'ok', git_commit: ctx.gitCommit, app_build: ctx.appBuild,
    tool: 'webSMLM', tool_version: ctx.appBuild, node_ver: process.version,
    engine: locR.gpuFit ? 'gpu' : 'cpu', gpu_adapter: locR.adapter,

    sim_seed: sim.simulation_seed, sim_mt_seed: sim.simulation_mt_seed, frames: sim.frames,
    fov_px: sim.simulation_fov, px_nm: sim.simulation_pxnm, dens: sim.dens, phot: sim.phot,
    simbg: sim.simbg, driftpx: sim.driftpx, sim_3d: simP.sim3d,
    z_range_nm: sim.simulation_zRange, structure: sim.simulation_structureType,
    // structFov = round(1.1 * fov) unless simulation_structureFov is overridden (generateSynthetic()).
    structure_fov: simP.structureFov ?? Math.round(1.1 * sim.simulation_fov),
    psf_model: sim.simulation_psfModel, zernike_preset: sim.simulation_psfZernikePreset,
    camera_type: sim.simulation_cameraType, cam_gain: simP.gain, cam_offset: simP.offset,
    cam_readnoise: simP.readnoise, cam_qe: simP.qe, cam_emgain: simP.emGain,
    method: fit.method, localize3d: !!fit.localize3D, det_filter: fit.detFilter,
    det_thr: fit.detection_wavelet_thr, psf_px: fit.psf, winr: fit.winr, shape_test: !!fit.shapeTest,

    match_radius_nm: sc.matchRadiusNm, min_photons: sc.minPhotons, border_px: sc.borderPx,
    crowd_radius_nm: DEFAULT_SCORE_CFG.validation_crowdRadius, match_mode: sc.matchMode,
    val_preset: 'webSMLM',

    n_gt_events: simR.nEvents, n_molecules: simR.nMolecules, n_locs: locR.n,
    tp: sc.tp, fp: sc.fp, fn: sc.fn,
    jaccard, jaccard_ceiling: num(coin.ceiling),
    jaccard_norm: jaccard != null && isFinite(coin.ceiling) && coin.ceiling > 0 ? jaccard / coin.ceiling : null,
    recall: num(sc.recall), precision: num(sc.precision),
    bias_x_nm: num(sc.biasX), bias_y_nm: num(sc.biasY),
    bias_mag_nm: isFinite(sc.biasX) && isFinite(sc.biasY) ? num(Math.hypot(sc.biasX, sc.biasY)) : null,
    rmse_lat_nm: num(sc.rmseLat), med_lat_nm: num(sc.medLat), p90_lat_nm: num(sc.p90Lat),
    rmse_z_nm: num(sc.rmseZ), med_z_nm: num(sc.medZ), p90_z_nm: num(sc.p90Z), p95_z_nm: num(sc.p95Z),
    n_gross_z: sc.nGrossZ ?? null,
    eff_lat: num(eff.lat), eff_ax: num(eff.ax), eff_e3d: num(eff.e3d),
    eff_z_width_nm: sc.effZ ? num(sc.effZ.widthNm) : null,
    phot50: num(sc.phot50),
    photom_median: sc.photometry ? num(sc.photometry.median) : null,
    photom_rsd_rel: sc.photometry ? num(sc.photometry.rsdRel) : null,
    prec_over_crlb: sc.precVsCrlb ? num(sc.precVsCrlb.measOverTheory) : null,
    crlb_lat_nm: num(crlbLat), crlb_z_nm: num(crlbZ),
    lat_over_crlb: crlbLat > 0 && isFinite(sc.medLat) ? num(sc.medLat / crlbLat) : null,
    jaccard_isolated: sc.isolated ? num(sc.isolated.recall) : null,
    jaccard_crowded: sc.crowded ? num(sc.crowded.recall) : null,
    mol_recall: sc.molecules ? num(sc.molecules.recall) : null,
    mol_mean_det: sc.molecules ? num(sc.molecules.meanDetections) : null,

    sim_ms: Math.round(simR.wallMs), fit_ms: Math.round(locR.wallMs),
    locs_per_s: locR.wallMs > 0 ? Math.round(locR.n / (locR.wallMs / 1000)) : null,

    // frames_hash: simulateInPage()'s FNV-1a over the generated pixels. Two cells with the same
    // hash saw the SAME movie, which is how an inert axis gives itself away (measured:
    // simulation_zRange is inert for 'microtubules', whose cell field is thinner than +/-400 nm
    // around the focus height, so 400/750/1200 clip nothing).
    frames_hash: simR.framesHash,
    // The COUNTED emitter-frames the ceiling was computed over (scoreTruthCore()'s cares() set),
    // i.e. what `frames` actually delivered — the nominal target says nothing about this.
    n_counted_ef: coin.countedEmitterFrames ?? null,
    crlb, tier1: 'ok', tier2: 'new', rep: sim._rep, notes: '',
  };
  return row;
}

// A cell that produced zero localizations is a RESULT (the detector found nothing at these
// settings), not a harness error: it gets a full row with the tier-1 n_locs>0 failure recorded.
// scoreLocsInPage() cannot be called at all with an empty loc array, so every metric is null.
function emptyRow(ctx, cell, sim, fit, simR, locR, simP) {
  const sc = { matchRadiusNm: DEFAULT_SCORE_CFG.validation_matchRadius, minPhotons: DEFAULT_SCORE_CFG.validation_minPhotons,
               borderPx: fit.winr + 1, matchMode: DEFAULT_SCORE_CFG.validation_matchMode, tp: 0, fp: 0, fn: null };
  const row = buildRow(ctx, cell, sim, fit, simR, locR, sc, { ceiling: NaN }, simP);
  row.crlb = 'unavailable';
  return row;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const ctx = { runId: `rm-${new Date().toISOString().replace(/[:.]/g, '-')}`, gitCommit: gitCommit(), appBuild: appBuild() };
  const cells = buildCells();
  const seeds = FULL ? REPLICATE_SEEDS : [ANCHOR_SIM.simulation_seed];
  console.log(`regime matrix: ${cells.length} cell(s) x ${seeds.length} seed(s) = ${cells.length * seeds.length} run(s)`);
  console.log(`  build ${ctx.appBuild} · commit ${ctx.gitCommit}`);

  let baseline = null;
  if (!NO_BASELINE && existsSync(BASELINE_FILE)) {
    try { baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); }
    catch (err) { console.error(`  (could not read baseline: ${err.message})`); }
  }
  if (!baseline) console.log(NO_BASELINE ? '  --no-baseline: tier 2 skipped, every cell is "new"'
                                         : `  no baseline at ${BASELINE_FILE} — every cell is tier-2 "new"`);

  const { browser, page } = await launchPage({ headless: HEADLESS });
  const rows = [], detail = {}, failures = [];
  try {
    for (const cell of cells) for (const seed of seeds) {
      const sim = { ...ANCHOR_SIM, ...cell.sim, simulation_seed: seed };
      sim.frames = framesFor(sim);
      const fit = { ...ANCHOR_FIT, ...cell.fit };
      const label = `${cell.id}${seeds.length > 1 ? ` seed=${seed}` : ''}`;
      process.stdout.write(`  ${label} … `);
      try {
        const calib = await ensureCalibration(page, sim);
        // No calibration (a fixed-sigma Gaussian PSF) means no width model to fit z against, so
        // that cell is 2D and keeps the anchor's winr/psf — which ARE that PSF's own sigma.
        if (!calib && fit.localize3D) { fit.localize3D = false; fit.method = FIT_2D.method; }
        // Fit window and seed sigma_PSF from the PSF's own measured width (see ensureCalibration()).
        // A cell that explicitly sweeps winr/psf keeps its own value.
        if (calib && calib.sigmaFocusPx && cell.fit.winr === undefined)
          fit.winr = Math.max(2, Math.min(20, Math.ceil(3 * calib.sigmaFocusPx)));
        // Rounded to PARAMS.psf's own 0.1 step: generateCalibrationStack() builds its per-pixel
        // offset map with the UNSEEDED gauss(), so the bead fits move by ~2% between runs, and
        // without the rounding that jitter would ride into every cell's seed sigma_PSF.
        if (calib && calib.sigmaFocusPx && cell.fit.psf === undefined)
          fit.psf = +Math.max(0.8, Math.min(5, calib.sigmaFocusPx)).toFixed(1);
        const simT0 = Date.now();
        const simR = await simulateInPage(page, sim, { writeFiles: false, name: cell.id });
        simR.wallMs = Date.now() - simT0;
        const simP = await readSimParams(page);
        // The app's own analyze({scoreVsTruth}) is cross-checked against scoreLocsInPage() on the
        // anchor only: scoreLocsInPage() is the authority (it is what scores other tools too), and
        // scoring twice costs real time.
        const wantTruthScore = cell.id === 'anchor' && seed === seeds[0];
        const locR = await localizeInPage(page, fit, calib ? calib.key : null, wantTruthScore);
        const simTagged = { ...sim, _rep: seeds.indexOf(seed) };
        let sc, coin, row;
        if (!locR.n) {
          sc = {}; coin = { ceiling: NaN, note: 'no localizations to score against' };
          row = emptyRow(ctx, cell, simTagged, fit, simR, locR, simP);
        } else {
          sc = await scoreLocsInPage(page, locR.locs, simR.groundTruth, { _detBorder: fit.winr + 1 });
          coin = coincidenceCeiling(simR.groundTruth, sc);
          row = buildRow(ctx, cell, simTagged, fit, simR, locR, sc, coin, simP);
        }

        const t1 = tier1(row);
        if (t1.fails.length) { row.tier1 = 'FAIL'; failures.push(`${label} tier1 — ${t1.fails.join('; ')}`); }
        const t2 = compareToBaseline(row, baseline);
        row.tier2 = t2.status === 'regressed' ? 'REGRESSED' : t2.status;
        if (t2.status === 'regressed') failures.push(`${label} tier2 — ${t2.regressions.join('; ')}`);
        if (row.tp < THIN_TP) row.status = 'thin';
        if (t2.status === 'new' && row.status === 'ok') row.status = 'new';
        if (row.tier1 === 'FAIL' || row.tier2 === 'REGRESSED') row.status = 'fail';
        const notes = [];
        if (!locR.n) notes.push('no localizations at these settings — every metric is null, not zero; ' + `nCand=${locR.nCand} shapeTest=${JSON.stringify(locR.shapeTest)} ${(locR.warnings || []).join(' | ')}`);
        if (row.tp < MIN_PAIRS_FOR_STATS) notes.push(`only ${row.tp} matched pair(s): the tier-1 statistics were SKIPPED, not passed`);
        else if (row.tp < THIN_TP) notes.push(`tp ${row.tp} < ${THIN_TP}: medians/percentiles are noisy`);
        if (row.crlb !== 'ok') notes.push('theoretical CRLB unavailable (no _theory in the ground truth) — the two CRLB invariants were SKIPPED, not passed');
        if (!calib && cell.fit !== FIT_2D) notes.push('no 3D calibration possible for this PSF — fitted 2D');
        if (!locR.n && locR.shapeTest && locR.shapeTest.fits > 0 && locR.shapeTest.rejected === locR.shapeTest.fits)
          notes.push('lost at the SHAPE TEST: every fit was rejected (fixed shapeTestThr=-1 vs a Gaussian fit of overlapping/bright emitters whose model mismatch scales with photons) — the fixed anchor settings do not suit this regime');
        row.notes = notes.join(' · ');

        detail[cell.id] = detail[cell.id] || {};
        detail[cell.id][`rep${seeds.indexOf(seed)}`] = {
          coincidence: coin, bins: sc.bins, photonBins: sc.photonBins, radiusSweep: sc.radiusSweep,
          crlbBins: sc.crlbBins, precVsCrlb: sc.precVsCrlb, photometry: sc.photometry,
          isolated: sc.isolated, crowded: sc.crowded, effZ: sc.effZ, molecules: sc.molecules,
          shapeTest: locR.shapeTest, calibration: calib, tier1: t1.checks, tier2: t2,
          nResiduals: sc.nResiduals, hasCrlbModel: sc.hasCrlbModel, nIgnoredGT: sc.nIgnoredGT,
          warnings: locR.warnings,
          appTruthScore: locR.truthScore ? {
            app: locR.truthScore,
            harness: { jaccard: sc.jaccard, recall: sc.recall, precision: sc.precision, tp: sc.tp, fp: sc.fp, fn: sc.fn,
                       medLat: sc.medLat, rmseLat: sc.rmseLat, borderPx: sc.borderPx, minPhotons: sc.minPhotons },
            jaccardDelta: locR.truthScore.jaccard - sc.jaccard,
          } : null,
        };
        rows.push(row);
        console.log(`Jaccard ${fmt(row.jaccard)} (ceiling ${fmt(row.jaccard_ceiling)}), recall ${fmt(row.recall)}, median lateral ${fmt(row.med_lat_nm)} nm, axial RMSE ${fmt(row.rmse_z_nm)} nm [${row.status}] ${Math.round((simR.wallMs + locR.wallMs) / 1000)}s`);
      } catch (err) {
        console.log(`ERROR ${err.message}`);
        rows.push({ run_id: ctx.runId, ts: new Date().toISOString(), cell_id: cell.id, axis: cell.axis,
                    level: cell.level, status: 'error', git_commit: ctx.gitCommit, app_build: ctx.appBuild,
                    tool: 'webSMLM', node_ver: process.version, engine: 'unknown',
                    sim_seed: seed, frames: sim.frames, dens: sim.dens, phot: sim.phot,
                    tier1: 'skipped', tier2: 'skipped', notes: `error: ${err.message}` });
        failures.push(`${label} — ${err.message}`);
      }
    }
  } finally { await browser.close(); }

  const wallMs = Date.now() - t0;
  printTable(rows, [
    { key: 'cell_id', label: 'Regime', width: 20 }, { key: 'status', label: 'Status', width: 6 },
    { key: 'frames', label: 'Frames', width: 6 }, { key: 'tp', label: 'True positives', width: 14 },
    { key: 'jaccard', label: 'Jaccard overlap', width: 15, fmt },
    { key: 'jaccard_ceiling', label: 'Jaccard ceiling', width: 15, fmt },
    { key: 'jaccard_norm', label: 'Normalized Jaccard', width: 18, fmt },
    { key: 'recall', label: 'Recall', width: 7, fmt }, { key: 'precision', label: 'Precision', width: 9, fmt },
    { key: 'med_lat_nm', label: 'Median lateral nm', width: 17, fmt }, { key: 'crlb_lat_nm', label: 'Cramer-Rao bound nm', width: 19, fmt },
    { key: 'rmse_z_nm', label: 'Axial RMSE nm', width: 13, fmt }, { key: 'bias_mag_nm', label: 'Bias magnitude nm', width: 17, fmt },
    { key: 'photom_median', label: 'Median photometry', width: 17, fmt }, { key: 'eff_e3d', label: '3D efficiency', width: 13, fmt },
    { key: 'tier1', label: 'Invariant check', width: 15 }, { key: 'tier2', label: 'Baseline check', width: 18 },
  ]);

  console.log(`\n${BENCHMARK_KIND}: detection/fit settings are held FIXED at the anchor across every cell, so these\n` +
              `  numbers are a regression measurement — NOT webSMLM's best achievable per regime (a user would\n` +
              `  retune the threshold and window). A low Jaccard in a hard regime is not a capability limit.\n` +
              `  REGRESSED means changed beyond the stored tolerance in either direction; inspect the metric to tell better from worse.`);
  const thin = rows.filter(r => r.status === 'thin').length;
  const noCrlb = rows.filter(r => r.crlb === 'unavailable').length;
  console.log(`\n${rows.length} row(s) in ${(wallMs / 1000).toFixed(0)}s · thin ${thin} · crlb unavailable ${noCrlb} · ` +
              `tier-1 failures ${rows.filter(r => r.tier1 === 'FAIL').length} · tier-2 regressions ${rows.filter(r => r.tier2 === 'REGRESSED').length}`);
  for (const f of failures) console.log(`  !!! ${f}`);

  const out = {
    format: 'webSMLM-regime-matrix', version: 1, run_id: ctx.runId, full: FULL,
    benchmark_kind: BENCHMARK_KIND,
    benchmark_note: 'Detection and fit settings are held FIXED at the anchor while the imaging regime is swept. ' +
      'Each row is "webSMLM at anchor settings in this regime" — a regression measurement — NOT the app\'s best ' +
      'achievable there, which a user would reach by retuning threshold and window per regime. Do not read a low ' +
      'Jaccard in a hard regime as a capability limit. REGRESSED means changed beyond the stored tolerance in ' +
      'either direction; inspect the metric delta to tell improvement from degradation.',
    git_commit: ctx.gitCommit, app_build: ctx.appBuild, node_ver: process.version,
    wall_ms: wallMs, seeds, target_emitter_frames: TARGET_EMITTER_FRAMES, thin_tp: THIN_TP,
    baseline_file: baseline ? BASELINE_FILE : null,
    baseline_commit: baseline ? baseline.git_commit : null,
    baseline_metrics: BASELINE_METRICS,
    anchor: { ...ANCHOR_SIM, ...ANCHOR_FIT },
    summary: { cells: rows.length, thin, crlb_unavailable: noCrlb,
               tier1_failures: rows.filter(r => r.tier1 === 'FAIL').length,
               tier2_regressions: rows.filter(r => r.tier2 === 'REGRESSED').length,
               errors: rows.filter(r => r.status === 'error').length },
    failures, rows, detail,
  };
  // writeResults()' default reportWriter emits HTML; a later phase owns all rendering here, so
  // this bench produces JSON only.
  const file = writeResults('regime-matrix', out,
    { reportWriter: () => ({ reportPath: '(none — this bench writes JSON only; a later phase renders the rows)' }) });
  console.log(`\nrows: ${file}`);

  if (WRITE_BASELINE) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const b = buildBaseline(rows, { git_commit: ctx.gitCommit, app_build: ctx.appBuild, full: FULL, seeds });
    writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2));
    console.log(`baseline written: ${BASELINE_FILE} (${Object.keys(b.engines).map(e => `${e}:${Object.keys(b.engines[e]).length} cells`).join(', ')})`);
    if (!FULL) console.log('  !!! baseline written from a NON---full run: one replicate per cell, so every seed spread is 0 and the tolerance falls back to its floor. Use --full --write-baseline.');
  }

  const bad = rows.filter(r => r.tier1 === 'FAIL' || r.tier2 === 'REGRESSED' || r.status === 'error').length;
  if (bad) { console.error(`\nFAIL: ${bad} cell(s) failed a tier-1 invariant, regressed against the baseline, or errored.`); process.exit(1); }
  console.log('\nPASS');
}

main().catch(err => { console.error(err); process.exit(1); });
