#!/usr/bin/env node
// Orchestrator: obtain truth -> webSMLM -> Picasso -> score BOTH through tests/lib/score.mjs's
// scoreLocsInPage() (the app's own scoreTruthCore()) -> cross-tool agreement -> results JSON.
//
//   node tests/validation/cross-validate.mjs [--truth=independent|simulator] [--full]
//                                            [--picasso-gradient=N]
//
// Truth sources (same shape reaches the scorer from both):
//   independent (default) generate-ground-truth.mjs, a third-party forward model with static
//                 emitters at gain 1. The no-shared-bias guard: webSMLM scoring well only against its
//                 own simulator would be the tell.
//   simulator     the app's own Simulate movie via tests/lib/simulate.mjs: blinking, camera physics.
//
// Drift: simulated with driftpx 0 and nothing drift-corrected. An external tool's CSV carries no
// raw (x0/y0) coordinates, so a drift-corrected CSV cannot be scored honestly; drift correction is
// a separate comparison.
//
// Skips (exit 0), never fails, when Picasso isn't installed. Never touches git.
import { generateGroundTruth } from './generate-ground-truth.mjs';
import { runWebSMLM } from './run-webSMLM.mjs';
import { runPicasso } from './run-picasso.mjs';
import { matchCrossTool, blandAltman, coincidenceCeiling } from './compare.mjs';
import { printTable, writeResults } from '../lib/report.mjs';
import { writeCrossReport } from '../lib/cross-report.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';
import { getDataset } from '../lib/datasets.mjs';
import { launchPage } from '../lib/launch.mjs';
import { simulateInPage } from '../lib/simulate.mjs';
import { scoreLocsInPage } from '../lib/score.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../lib/launch.mjs';

const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const full = process.argv.includes('--full');
const datasetKey = arg('dataset', null);
const source = datasetKey ? `dataset:${datasetKey}` : arg('truth', 'independent');
const EPFL_DATASETS = ['epfl-as-hd', 'epfl-as-ld'];
if (!datasetKey && !['independent', 'simulator'].includes(source)) { console.error(`--truth must be independent or simulator, got "${source}"`); process.exit(2); }
if (datasetKey && !EPFL_DATASETS.includes(datasetKey)) { console.error(`--dataset must be ${EPFL_DATASETS.join(' or ')}, got "${datasetKey}"`); process.exit(2); }
const gradientOverride = arg('picasso-gradient', null);

const UPLOAD_CHUNK = 100000;   // scoreLocsInPage()'s own chunked-input threshold
const WS_SWEEP = [1, 1.5, 2, 3, 4, 6, 8];
const PIC_SWEEP = [30, 100, 200, 400, 800, 1500];
const scoreChunked = (page, locs, gt, cfg = {}) => scoreLocsInPage(page, locs, gt, cfg, { chunk: UPLOAD_CHUNK });

// ---- truth sources, both ending in { movie, tiffPath, groundTruth } ----
function independentTruth() {
  const { truth } = generateGroundTruth(full ? { nFrames: 100, nEmitters: 60, W: 128, H: 128 } : {});
  const dir = join(repoRoot, 'tests', 'results'); mkdirSync(dir, { recursive: true });
  const tiffPath = join(dir, 'independent-movie.tif');
  writeFileSync(tiffPath, truth.tiffBuffer);
  const n = truth.emitters.length;
  const groundTruth = {   // one never-blinking event per emitter spanning the whole movie, camera px
    movie: { w: truth.W, h: truth.H, frames: truth.nFrames, pxNm: truth.pxnm },
    events: { x: truth.emitters.map(e => e.x), y: truth.emitters.map(e => e.y), z: new Array(n).fill(NaN),
              tStart: new Array(n).fill(0), tEnd: new Array(n).fill(truth.nFrames), rate: new Array(n).fill(truth.photonsTotal),
              moleculeId: truth.emitters.map(e => e.id), haze: new Array(n).fill(0) },
    drift: null,
  };
  return { movie: { ...truth, tiffBuffer: undefined }, tiffPath, groundTruth, scoreVsTruth: false, simParams: null };
}

// Gaussian PSF (the 2D spherical fit both tools run is the right model for it), blinking kinetics at
// their defaults, no drift. uniform3D keeps the structure free of filament crowding.
const SIM_PARAMS = () => ({
  simulation_structureType: 'uniform3D', simulation_psfModel: 'gaussian', simulation_seed: 20261001,
  frames: full ? 300 : 100, simulation_fov: full ? 128 : 64, dens: 0.3,
  simulation_pxnm: 100, frametime: 0.02, driftpx: 0, useGpu: false,
});
async function simulatorTruth(page) {
  const simParams = SIM_PARAMS();
  const sim = await simulateInPage(page, simParams, { name: 'xval' });
  const cam = await page.evaluate(() => ({ gain: paramValue('gain'), camoffset: paramValue('camoffset'), psf: paramValue('psf') }));
  return {
    movie: { W: sim.w, H: sim.h, nFrames: sim.frames, pxnm: sim.pxNm, gainPhotonsPerADU: cam.gain, offsetADU: cam.camoffset,
             sigmaPx: 1.3, seed: simParams.simulation_seed, nEvents: sim.nEvents, nMolecules: sim.nMolecules, framesHash: sim.framesHash },
    tiffPath: sim.tiffPath, groundTruth: sim.groundTruth, scoreVsTruth: true, simParams,
    truthSource: `webSMLM physical simulator with fixed seed ${simParams.simulation_seed}`,
  };
}

export function parseEpflActivations(csv, pixelSizeNm) {
  const events = { x: [], y: [], z: [], tStart: [], tEnd: [], rate: [], moleculeId: [], haze: [] };
  for (const line of String(csv).split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [id, frame, xNm, yNm, zNm, photons] = line.split(',').map(Number);
    if (![id, frame, xNm, yNm, zNm, photons].every(Number.isFinite)) throw new Error(`Invalid EPFL activation row: ${line}`);
    events.moleculeId.push(id);
    events.tStart.push(frame - 1);
    events.tEnd.push(frame);
    events.x.push(xNm / pixelSizeNm);
    events.y.push(yNm / pixelSizeNm);
    events.z.push(zNm);
    events.rate.push(photons);
    events.haze.push(0);
  }
  return events;
}

export async function epflDatasetTruth(key) {
  const dataset = getDataset(key);
  const [tiffPath, activationsPath] = await Promise.all([
    resolveDatasetFile(key, 'stack'),
    resolveDatasetFile(key, 'activations'),
  ]);
  if (!tiffPath || !activationsPath) return null;
  const p = dataset.parameters;
  const groundTruth = {
    movie: { w: p.width, h: p.height, frames: p.frames, pxNm: p.pxnm },
    events: parseEpflActivations(readFileSync(activationsPath, 'utf8'), p.pxnm),
    drift: null,
  };
  return {
    movie: { W: p.width, H: p.height, nFrames: p.frames, pxnm: p.pxnm, gainPhotonsPerADU: p.gain, offsetADU: p.camoffset, sigmaPx: p.psfSigmaPx },
    tiffPath,
    groundTruth,
    scoreVsTruth: false,
    simParams: null,
    dataset: key,
    truthSource: 'published EPFL SMLM Challenge activations',
    limitations: [
      'This run scores lateral localization only.',
      'The input is astigmatic, but both tools use their spherical 2D fit here; axial accuracy requires a separate matched 3D calibration workflow.',
    ],
  };
}

const HEADLINE = ['tp', 'fp', 'fn', 'jaccard', 'precision', 'recall'];
// analyze()'s own truthScore vs scoreLocsInPage() for the same locs: any headline number present in
// both, side by side. Differences are expected only from the run's detection border / frame range.
function crossCheck(analyzeScore, ourScore) {
  if (!analyzeScore) return null;
  const rows = {};
  for (const k of Object.keys(ourScore)) {
    const a = analyzeScore[k], b = ourScore[k];
    if (typeof a === 'number' && typeof b === 'number') rows[k] = { analyze: a, scoreLocsInPage: b, equal: a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) };
  }
  const keys = Object.keys(rows);
  return { fields: rows, nCompared: keys.length, nEqual: keys.filter(k => rows[k].equal).length, allEqual: keys.every(k => rows[k].equal) };
}

async function main() {
  const t0 = Date.now();
  let t = datasetKey ? await epflDatasetTruth(datasetKey) : null;
  if (datasetKey && !t) {
    console.log(`Skipping ${datasetKey}: download its movie and ground-truth files under Real data, then rerun.`);
    return;
  }
  const { browser, page } = await launchPage({ headless: true });
  try {
    console.log(`Truth source: ${source}${full ? ' (full)' : ''}`);
    t ||= source === 'simulator' ? await simulatorTruth(page) : independentTruth();
    const m = t.movie, gt = t.groundTruth;
    console.log(`  ${m.W}x${m.H}, ${m.nFrames} frames, ${gt.events.x.length} truth events, ${m.pxnm} nm/px, gain ${m.gainPhotonsPerADU}, offset ${m.offsetADU}`);

    // Symmetric tuning: each tool's one detection threshold is swept over a comparable range on THIS
    // truth source and the best Jaccard (same scorer, same truth) is kept; both sweeps are recorded.
    // An explicit --wavelet-thr / --picasso-gradient pins that tool instead (no sweep).
    const pick = (rows) => rows.reduce((b, r) => (r.jaccard > (b?.jaccard ?? -1) ? r : b), null);
    const wsFixed = arg('wavelet-thr', null), picFixed = gradientOverride;
    const wsSweep = [];
    for (const thr of wsFixed != null ? [Number(wsFixed)] : WS_SWEEP) {
      const r = await runWebSMLM(page, m, { tiffPath: t.tiffPath, threshold: thr });
      if (r.error || !r.locs.length) { wsSweep.push({ value: thr, nLocs: r.locs?.length ?? 0, jaccard: 0 }); continue; }
      const sc = await scoreChunked(page, r.locs, gt);
      wsSweep.push({ value: thr, nLocs: r.locs.length, jaccard: sc.jaccard, precision: sc.precision, recall: sc.recall });
    }
    const wsBest = pick(wsSweep);
    const ws = await runWebSMLM(page, m, { tiffPath: t.tiffPath, scoreVsTruth: t.scoreVsTruth, threshold: wsBest.value });
    console.log(`webSMLM wavelet threshold sweep: ${wsSweep.map(r => `${r.value}->${r.jaccard.toFixed(3)}`).join('  ')}  best ${wsBest.value}`);
    console.log(ws.error ? `  webSMLM: ${ws.error}` : `  webSMLM: ${ws.locs.length} localizations in ${ws.wallMs}ms (winr ${ws.parameters.winr})`);

    let pic = null, picSweep = [], grad = null;
    for (const g of picFixed != null ? [Number(picFixed)] : PIC_SWEEP) {
      const r = await runPicasso(m, { tiffPath: t.tiffPath, gradient: g });
      if (r.skipped) { pic = r; break; }
      if (r.error || !r.locs.length) { picSweep.push({ value: g, nLocs: r.locs?.length ?? 0, jaccard: 0 }); continue; }
      const sc = await scoreChunked(page, r.locs, gt);
      picSweep.push({ value: g, nLocs: r.locs.length, jaccard: sc.jaccard, precision: sc.precision, recall: sc.recall });
      if (!pic || sc.jaccard > pic.jaccard) pic = { ...r, jaccard: sc.jaccard };
    }
    if (picSweep.length) {
      const best = pick(picSweep);
      grad = { value: best.value, origin: picFixed != null ? 'override' : 'swept' };
      console.log(`Picasso net-gradient sweep: ${picSweep.map(r => `${r.value}->${r.jaccard.toFixed(3)}`).join('  ')}  best ${best.value}`);
    }
    if (!pic) pic = { skipped: false, error: 'every Picasso run failed' };
    console.log(pic.skipped ? `  Picasso: SKIPPED -- ${pic.reason}` : pic.error ? `  Picasso: ${pic.error}` : `  Picasso: ${pic.locs.length} localizations`);

    const tools = {};
    const scoreTimings = {};
    for (const [name, res] of [['webSMLM', ws], ['picasso', pic]]) {
      if (res.skipped || res.error) { tools[name] = { skipped: true, reason: res.reason || res.error, parameters: res.parameters }; continue; }
      if (!res.locs.length) { tools[name] = { skipped: false, error: 'no localizations', nLocs: 0, wallMs: res.wallMs, parameters: res.parameters }; continue; }
      const ts = Date.now();
      const score = await scoreChunked(page, res.locs, gt);
      scoreTimings[name] = { locs: res.locs.length, ms: Date.now() - ts };
      tools[name] = { skipped: false, nLocs: res.locs.length, wallMs: res.wallMs, parameters: res.parameters, score };
      if (name === 'webSMLM' && ws.truthScore) {
        // analyze() scores inside its own detection border; re-score the same locs with that border
        // so the two scorers see the same denominator (the headline score above keeps border 0).
        const same = await scoreChunked(page, res.locs, gt, { _detBorder: ws.truthScore.borderPx });
        tools[name].crossCheck = { ...crossCheck(ws.truthScore, same), detBorderPx: ws.truthScore.borderPx };
      }
    }

    let crossTool = null;
    if (ws.locs && pic.locs && ws.locs.length && pic.locs.length) {
      const px = m.pxnm, nm = l => ({ frame: l.frame, xNm: l.x * px, yNm: l.y * px, photons: l.photons });
      const pairs = matchCrossTool(ws.locs.map(nm), pic.locs.map(nm), 250);   // same radius as the scorer's default
      crossTool = { n: pairs.length, radiusNm: 250, x: blandAltman(pairs, l => l.xNm), y: blandAltman(pairs, l => l.yNm), photons: blandAltman(pairs, l => l.photons) };
    }

    const radiusNm = 250;   // DEFAULT_SCORE_CFG.validation_matchRadius, what both tools were scored at
    const ceiling = coincidenceCeiling(gt.events, m.nFrames, radiusNm / m.pxnm);

    const data = {
      truthSource: t.truthSource || source,
      dataset: t.dataset || null,
      evidenceType: 'known-ground-truth',
      limitations: t.limitations || [],
      truth: m,
      matchRadiusNm: radiusNm,
      scorer: 'tests/lib/score.mjs scoreLocsInPage() -> scoreTruthCore()',
      provenance: { drift: { driftpx: 0, corrected: false }, picassoGradient: grad, tuning: { regime: 'each tool swept on its one detection threshold, best Jaccard kept', webSMLM: { param: 'detection_wavelet_thr', winr: ws.parameters?.winr, best: wsBest.value, sweep: wsSweep }, picasso: { param: 'net gradient', best: grad?.value ?? null, sweep: picSweep, boxSidePx: pic.parameters?.boxSidePx } }, simParams: t.simParams,
                    inboundCdp: { chunk: UPLOAD_CHUNK, scoreTimings } },
      parameters: { webSMLM: ws.parameters ?? null, picasso: pic.parameters ?? null },
      tools, crossTool, ceiling,
    };

    printTable(
      Object.entries(tools).map(([tool, r]) => ({ tool, skipped: r.skipped, jaccard: r.score?.jaccard, rmse: r.score?.rmseLat ?? r.score?.latRmse, wallMs: r.wallMs })),
      [
        { key: 'tool', label: 'Tool', width: 10 },
        { key: 'skipped', label: 'Status', width: 8, fmt: v => v ? 'skip' : 'ok' },
          { key: 'jaccard', label: 'Jaccard overlap', width: 16, fmt: v => v != null ? v.toFixed(3) : '-' },
          { key: 'rmse', label: 'Lateral root mean square error (nm)', width: 35, fmt: v => v != null ? v.toFixed(1) : '-' },
          { key: 'wallMs', label: 'Elapsed time (ms)', width: 17, fmt: v => v != null ? String(Math.round(v)) : '-' },
      ]);
    console.log(`Coincidence ceiling: ${(100 * ceiling.fraction).toFixed(1)}% of ${ceiling.emitterFrames} emitter-frames have a neighbour within ${radiusNm} nm (context for Jaccard < 1; both tools face it).`);
    if (tools.webSMLM.crossCheck) console.log(`analyze({scoreVsTruth}) vs scoreLocsInPage(): ${tools.webSMLM.crossCheck.nEqual}/${tools.webSMLM.crossCheck.nCompared} numeric fields equal.`);
      if (crossTool) for (const f of ['x', 'y', 'photons']) { const s = crossTool[f]; if (s.n) console.log(`  cross-tool ${f}: mean difference=${s.bias.toFixed(2)}, standard deviation=${s.sd.toFixed(2)}, Pearson correlation=${s.pearsonR?.toFixed(4)}`); }

    const resultFile = writeResults(`picasso-compare-${datasetKey || source}`, data, { reportWriter: writeCrossReport, durationMs: Date.now() - t0 });
    console.log(`\nWrote ${resultFile}\nTotal wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally { await browser.close(); }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(String.fromCharCode(92)).join("/").split("/").pop());
if (isMain) main().catch(err => { console.error(err); process.exitCode = 1; });
