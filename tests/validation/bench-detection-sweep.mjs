#!/usr/bin/env node
// Detection threshold against the recall-vs-photons curve (docs/REFACTOR_PLAN.md: "the default k has
// never been chosen against a measured curve"). One seeded 2D movie with a wide spread of blink
// brightness (log-normal, CV 1.5) is localized once per detection setting — each of the three
// filters over a range of its threshold — and every result is scored by the app's own
// scoreTruthCore() (through tests/lib/score.mjs) with NO photon floor (validation_minPhotons 0), so
// dim emitters count as misses rather than "don't care". Everything but the detector is held fixed:
// spherical MLE, shape test off (so a fit rejection can't pose as a detection miss), sparse density
// (so coincident emitters don't set the ceiling).
//
// Per setting: recall in three photon strata (<300, 300-1000, >1000 photons/frame), the photon level
// at which detection reaches 50% (phot50), false positives per 1000 frames, and Jaccard. A threshold
// trades the first against the second; the table makes the trade visible, it does not pick a winner.
//
// Output: tests/results/detection-sweep-*.json.
// What it cannot show: the simulated frames have shot and read noise but no structure at the PSF's own
// scale (hot pixels, out-of-focus light, cell autofluorescence), which is what produces false
// positives on real data. The false-positive column is therefore a floor, not a prediction.
// Usage:  node tests/validation/bench-detection-sweep.mjs [--headless] [--seeds=1234,991]
import { launchPage } from '../lib/launch.mjs';
import { simulateInPage } from '../lib/simulate.mjs';
import { scoreLocsInPage, DEFAULT_SCORE_CFG } from '../lib/score.mjs';
import { writeResults, printTable } from '../lib/report.mjs';

const argv = process.argv.slice(2);
const HEADLESS = argv.includes('--headless');
const SEEDS = ((argv.find(a => a.startsWith('--seeds=')) || '').slice(8) || '1234,991').split(',').map(Number);
// Background level (photons/pixel/frame): the threshold is k·σ of the filtered frame, so it follows the noise.
const BACKGROUNDS = [10, 40];

const FRAMES = 400;
const SIM = {
  simulation_structureType: 'uniform3D', simulation_psfModel: 'gaussian', simulation_cameraType: 'scmos',
  simulation_3d: false, simulation_zRange: 300,
  dens: 0.15, phot: 800, simulation_photCV: 1.5, simbg: 10,
  simulation_fov: 96, simulation_pxnm: 100, frames: FRAMES, driftpx: 0,
};
const FIT = { method: 'gaussmle', localize3D: false, winr: 4, psf: 1.3, shapeTest: false };
const K = [2, 2.5, 3, 3.5, 4, 5, 6, 8];
const BOX = [6, 10, 16, 25, 40, 60];
const CELLS = [
  ...K.map(k => ({ filter: 'wave', key: 'detection_wavelet_thr', thr: k })),
  ...K.map(k => ({ filter: 'dog', key: 'detection_DoG_thr', thr: k })),
  ...BOX.map(t => ({ filter: 'box', key: 'detection_box_thr', thr: t })),
];

async function localize(page, cell) {
  const r = await page.evaluate(async ({ fit, cell }) => {
    const sv = simSaved, st = sv.stack, frames = await st.getFrames(0, st.n);
    const { parts } = encodeTiff16(frames, st.w, st.h, { pxNm: st.px, frameTimeS: sv.frameTimeS });
    const cam = { gain: paramValue('gain'), camoffset: paramValue('camoffset'), cameraExcessNoise: paramValue('cameraExcessNoise'), pcfoRnstd: paramValue('pcfoRnstd') };
    const cfg = { ...fit, ...cam, pxnm: st.px, file: new File(parts, 'sweep.tif', { type: 'image/tiff' }),
                  detFilter: { wave: 'wave', dog: 'dog', box: 'box' }[cell.filter], [cell.key]: cell.thr, mag: 1, useGpu: false };
    let res; try { res = await window.webSMLM.analyze(cfg); } catch (e) { return { err: `${e.name}: ${e.message}` }; }
    return { locs: res.locs.map(l => ({ frame: l.frame, x: l.x, y: l.y, photons: l.photons, lpx: l.lpx, lpy: l.lpy })), nCand: res.timings ? res.timings.nCand : null };
  }, { fit: FIT, cell });
  if (r.err) throw new Error(r.err);
  return r;
}

// Recall of the emitter-frames whose true photon count falls in [lo, hi), from the scorer's log-spaced bins.
const recallIn = (bins, lo, hi) => {
  let n = 0, hit = 0;
  for (const b of bins || []) if (b.pc >= lo && b.pc < hi) { n += b.n; hit += b.hit; }
  return n ? hit / n : null;
};

const t0 = Date.now(), rows = [];
const { browser, page } = await launchPage({ headless: HEADLESS });
try {
  for (const bg of BACKGROUNDS) for (const seed of SEEDS) {
    const simR = await simulateInPage(page, { ...SIM, simbg: bg, simulation_seed: seed }, { writeFiles: false, name: 'detection-sweep' });
    console.log(`background ${bg}, seed ${seed}: ${simR.groundTruth.events.x.length} true blinks, ${CELLS.length} settings`);
    for (const cell of CELLS) {
      const loc = await localize(page, cell);
      const sc = await scoreLocsInPage(page, loc.locs, simR.groundTruth, { ...DEFAULT_SCORE_CFG, validation_minPhotons: 0, validation_crowdRadius: 0, _detBorder: FIT.winr + 1 });
      rows.push({ bg, seed, filter: cell.filter, thr: cell.thr, n_locs: loc.locs.length, tp: sc.tp, fp: sc.fp, fn: sc.fn,
                  fp_per_1000_frames: +(1000 * sc.fp / FRAMES).toFixed(1), jaccard: +sc.jaccard.toFixed(4), precision: +sc.precision.toFixed(4), recall: +sc.recall.toFixed(4),
                  recall_lt300: recallIn(sc.photonBins, 0, 300), recall_300_1000: recallIn(sc.photonBins, 300, 1000), recall_gt1000: recallIn(sc.photonBins, 1000, Infinity),
                  phot50: isFinite(sc.phot50) ? Math.round(sc.phot50) : null, med_lat_nm: +sc.medLat.toFixed(1) });
      const r = rows[rows.length - 1];
      console.log(`  ${cell.filter.padEnd(4)} ${String(cell.thr).padStart(4)}  recall ${r.recall}  fp/1000fr ${r.fp_per_1000_frames}  phot50 ${r.phot50}  jaccard ${r.jaccard}`);
    }
  }
} finally { await browser.close(); }

// Mean over the seeds, one line per background x setting.
const mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const groups = new Map();
for (const r of rows) { const k = `${r.bg}|${r.filter}|${r.thr}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const table = [...groups.values()].map(g => ({ bg: g[0].bg, filter: g[0].filter, thr: g[0].thr, ...Object.fromEntries(['recall_lt300', 'recall_300_1000', 'recall_gt1000', 'phot50', 'fp_per_1000_frames', 'jaccard', 'med_lat_nm'].map(k => [k, mean(g.map(r => r[k]))])) }));
const num = (d, w = 7) => ({ width: w, fmt: v => v == null ? '—' : v.toFixed(d) });
console.log(`\nDetection sweep, mean of ${SEEDS.length} seed(s) (spherical MLE, shape test off; recall by true photons/frame)`);
printTable(table, [{ key: 'bg', label: 'bg', width: 4 }, { key: 'filter', label: 'filter', width: 6 }, { key: 'thr', label: 'thr', width: 5 },
  { key: 'recall_lt300', label: 'rec<300', ...num(2) }, { key: 'recall_300_1000', label: '300-1000', ...num(2, 8) }, { key: 'recall_gt1000', label: '>1000', ...num(2) },
  { key: 'phot50', label: 'phot50', ...num(0) }, { key: 'fp_per_1000_frames', label: 'FP/1000fr', ...num(1, 9) }, { key: 'jaccard', label: 'jaccard', ...num(3) }, { key: 'med_lat_nm', label: 'lat nm', ...num(1) }]);
writeResults('detection-sweep', { benchmark_kind: 'detection-threshold-sweep', sim: SIM, backgrounds: BACKGROUNDS, fit: FIT, seeds: SEEDS, frames: FRAMES, rows, table }, { durationMs: Date.now() - t0 });
