#!/usr/bin/env node
// Per-stage GPU-vs-CPU A/B — the repeatable form of the two experiments the
// stage harness exists for. Drives window.webSMLM.analyze() twice against the
// same dataset (useGpu:false then useGpu:true) the same way bench-real-data.mjs
// does, and diffs result.stageTimings between the two runs.
//
// The point is NOT the total speedup (bench-real-data.mjs already reports that)
// — it is the per-stage breakdown, so each stage can be judged on its own:
// which ones actually gained, which have no GPU path yet, and which have one
// that failed and silently fell back. That is what decides, stage by stage,
// whether GPU is worth keeping on or leaving off.
//
// Every stage runs through runStage() (MODULE: gpu in webSMLM.html), which
// records {ms, calls, path, gpuFailed} per stage. A stage whose `path` is still
// 'cpu' in the GPU run has no kernel; one with gpuFailed:true has a broken one.
// Those two look identical in a wall-clock number and mean opposite things.
//
// Runs the full post-processing pipeline (drift + NeNA + FRC) on purpose: FRC
// is adaptive WebGPU now, while drift/NeNA stay CPU baselines for future work.
//
// Skips (does not fail) if the file isn't present — real, git-ignored data.
//
// Usage: cd tests && npm install (once), then node bench-gpu-stages.mjs [--full]
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { printTable, speedup, writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const FULL = process.argv.includes('--full');
const TARGET = await resolveDataFile('STORM_STACK', join('19165061', 'Aquired STORM.tif'));
if (!TARGET) { console.log('Skipping stage benchmark.'); process.exit(0); }

const BASE_CONFIG = {
  pxnm: 100, method: 'gaussmle', psf: 1.3, winr: 4,
  detFilter: 'wave', detection_wavelet_thr: 2,
  fitFirstFrame: 1, fitLastFrame: FULL ? Infinity : 2000,
  // Post-processing on: FRC should route through the adaptive stage policy when
  // eligible; drift/NeNA stay CPU baselines.
  correctDrift: true, computeNeNA: true, computeFRC: true,
};

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', TARGET);

  async function runAnalyze(useGpu) {
    let lastPct = -10;
    page.removeAllListeners('console');
    page.on('console', msg => {
      const m = msg.text().match(/^\[progress\](\d+(?:\.\d+)?)/);
      if (m) {
        const pct = Math.floor(+m[1]);
        if (pct >= lastPct + 5) { lastPct = pct; process.stdout.write(`  ${useGpu ? 'GPU' : 'CPU'} run: ${pct}%  \r`); }
      }
    });
    const result = await page.evaluate(async ({ cfg, useGpu, fileInputId }) => {
      const config = Object.assign({}, cfg, { useGpu });
      config.file = document.getElementById(fileInputId).files[0];
      config.onProgress = pct => console.log('[progress]' + pct);
      const r = await window.webSMLM.analyze(config);
      return { nLocalizations: r.locs.length, timings: r.timings,
               stageTimings: r.stageTimings, logText: r.logText };
    }, { cfg: BASE_CONFIG, useGpu, fileInputId: 'analyzeFileInput' });
    process.stdout.write('\n');
    return result;
  }

  console.log(`Target: ${TARGET}`);
  console.log(FULL ? 'Processing the entire stack.' : 'Processing frames 1-2000 only (pass --full for the entire stack).');

  console.log('\nRunning CPU pass (useGpu:false)...');
  const cpu = await runAnalyze(false);
  console.log(`CPU: ${cpu.nLocalizations} localizations in ${Math.round(cpu.timings.runMs)} ms.`);

  console.log('\nRunning GPU pass (useGpu:true)...');
  const gpu = await runAnalyze(true);
  console.log(`GPU: ${gpu.nLocalizations} localizations in ${Math.round(gpu.timings.runMs)} ms.`);

  if (!cpu.stageTimings || !gpu.stageTimings) {
    console.error('\nFAIL: analyze() returned no stageTimings — the harness is not wired through.');
    process.exit(1);
  }

  // Union of both runs' stages: a stage can legitimately appear in only one of
  // them (a GPU-only fast path, or a CPU fallback that never ran on GPU).
  const ids = [...new Set([...Object.keys(cpu.stageTimings), ...Object.keys(gpu.stageTimings)])];
  const rows = ids.map(id => {
    const c = cpu.stageTimings[id], g = gpu.stageTimings[id];
    let note = '';
    if (g && g.gpuFailed) note = 'GPU FAILED, fell back';
    else if (g && g.path === 'cpu') note = 'no GPU path';
    else if (g && g.path === 'gpu') note = 'GPU';
    return { stage: id, cpuMs: c ? c.ms : null, gpuMs: g ? g.ms : null,
             sp: (c && g) ? speedup(c.ms, g.ms) : null, note };
  });
  // Slowest CPU stage first — the ordering that answers "what should get a
  // kernel next" at a glance.
  rows.sort((a, b) => (b.cpuMs || 0) - (a.cpuMs || 0));

  const ms = v => v == null ? '-' : Math.round(v).toLocaleString();
  console.log('\nPer-stage GPU vs CPU:');
  printTable(rows, [
    { key: 'stage', label: 'stage',   width: 12 },
    { key: 'cpuMs', label: 'CPU ms',  width: 10, fmt: ms },
    { key: 'gpuMs', label: 'GPU ms',  width: 10, fmt: ms },
    { key: 'sp',    label: 'speedup', width: 8,  fmt: v => v == null ? '-' : v.toFixed(2) + 'x' },
    { key: 'note',  label: 'note',    width: 22 },
  ]);

  const accelerated = rows.filter(r => r.note === 'GPU').map(r => r.stage);
  const noPath      = rows.filter(r => r.note === 'no GPU path').map(r => r.stage);
  const failed      = rows.filter(r => r.note.startsWith('GPU FAILED')).map(r => r.stage);
  console.log(`\nAccelerated: ${accelerated.join(', ') || '(none)'}`);
  console.log(`No GPU path: ${noPath.join(', ') || '(none)'}`);
  if (failed.length) console.log(`GPU FAILED:  ${failed.join(', ')}`);

  // A localization-count mismatch between the two runs means the GPU path
  // changed the RESULT, not just its speed — worth flagging loudly, since a
  // stage table full of speedups is meaningless if the output differs.
  if (cpu.nLocalizations !== gpu.nLocalizations) {
    const d = Math.abs(cpu.nLocalizations - gpu.nLocalizations);
    const pct = 100 * d / Math.max(cpu.nLocalizations, 1);
    console.log(`\n${pct < 0.1 ? 'Note' : '⚠ WARNING'}: localization counts differ by ${d} (${pct.toFixed(3)}%) — GPU f32 vs CPU f64 accept/reject at threshold margins.`);
  }

  writeResults('bench-gpu-stages', { target: TARGET, full: FULL, rows,
    cpu: { n: cpu.nLocalizations, runMs: cpu.timings.runMs, stageTimings: cpu.stageTimings },
    gpu: { n: gpu.nLocalizations, runMs: gpu.timings.runMs, stageTimings: gpu.stageTimings } });
  if (failed.length) process.exit(1);
} finally {
  await browser.close();
}
