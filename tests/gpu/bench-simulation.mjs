#!/usr/bin/env node
// Simulate movie / calibration stack: CPU (sim worker pool) vs GPU, end to end through
// the real generateSynthetic() / generateCalibrationStack() — so the GPU
// numbers include packing, upload and readback, not just kernel time.
//
// Each case runs once cold and then three times warm per path, and the MEDIAN warm run is
// reported: the cold run builds and caches the PSF kernel stack and, on the GPU path, compiles the
// pipeline (reported separately: every page session pays it once). The median,
// not one run, because a laptop's clocks and power states put ~0.5 s spikes into maybe one run in
// four on an integrated GPU, and ±30% into the CPU worker pool.
//
// Sizes are laptop-friendly by default (a run takes about a minute on an integrated GPU).
// --full adds the default-size movies (128² x 300 frames, the full ±2 µm / 401-plane PSF) and a
// dense and a 512² one — meant for a machine with a dedicated GPU; it takes minutes on a laptop.
// --baseline=<path to an older webSMLM.html> additionally times that file's CPU path on the same
// movie cases (e.g. `git show <rev>:webSMLM.html > old.html`), for before/after numbers.
//
// Usage: node tests/gpu/bench-simulation.mjs [--full] [--baseline=old.html]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchPage, checkGpu, repoRoot } from '../lib/launch.mjs';
import { printTable, writeResults } from '../lib/report.mjs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const full = argv.includes('--full');
const baselineArg = argv.find(a => a.startsWith('--baseline='));
const baselinePath = baselineArg ? baselineArg.slice('--baseline='.length) : null;
// --cases=text  runs only the cases whose label contains `text` (case-insensitive).
const casesArg = argv.find(a => a.startsWith('--cases='));
const caseFilter = casesArg ? casesArg.slice('--cases='.length).toLowerCase() : null;

const SMALL_PSF = { simulation_psfZRange: 400, simulation_psfZStep: 20 };          // 41 planes
const MOVIE_CASES = [
  { label: '2D cubic 128² × 100',   set: { ...SMALL_PSF, simulation_fov: 128, frames: 100, simulation_3d: false } },
  { label: '3D cubic 128² × 100',   set: { ...SMALL_PSF, simulation_fov: 128, frames: 100, simulation_3d: true, simulation_zRange: 400 } },
  { label: '2D linear 128² × 100',  set: { ...SMALL_PSF, simulation_fov: 128, frames: 100, simulation_3d: false, simulation_psfInterp: 'linear' } },
  { label: '2D dens 0.3, 128² × 50', set: { ...SMALL_PSF, simulation_fov: 128, frames: 50, simulation_3d: false, dens: 0.3 } },
  { label: '2D 256² × 50 (noise-heavy)', set: { ...SMALL_PSF, simulation_fov: 256, frames: 50, simulation_3d: false, simbg: 20 } },
  { label: 'EMCCD 128² × 100',      set: { ...SMALL_PSF, simulation_fov: 128, frames: 100, simulation_3d: false, simulation_cameraType: 'emccd' } },
  ...(full ? [
    { label: 'FULL 2D defaults 128² × 300', set: { simulation_fov: 128, frames: 300, simulation_3d: false } },
    { label: 'FULL 3D defaults 128² × 300', set: { simulation_fov: 128, frames: 300, simulation_3d: true } },
    { label: 'FULL dense 1.0, 128² × 100',  set: { simulation_fov: 128, frames: 100, simulation_3d: false, dens: 1 } },
    { label: 'FULL 512² × 200',             set: { simulation_fov: 512, frames: 200, simulation_3d: false, simbg: 20 } },
  ] : []),
];
const DEFAULTS = { dens: 0.05, simbg: 0, simulation_psfInterp: 'cubic', simulation_cameraType: 'scmos',
                   simulation_psfKernelWidth: 6000, simulation_seed: 11, simulation_structureType: 'uniform3D',
                   simulation_psfZernikePreset: 'astigModerate', simulation_psfModel: 'zernike' };

async function setParams(page, vals) {
  await page.evaluate(vals => {
    for (const [id, v] of Object.entries(vals)) {
      const el = document.getElementById(id);
      if (!el) { paramOverrides[id] = v; continue; }
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    }
  }, vals);
}
// Runs `fn` (a page-side generator name) twice; returns cold/warm totals and the warm frame stage.
async function timeMovie(page, useGpu, calib = false) {
  await setParams(page, { useGpu });
  return page.evaluate(async calib => {
    const go = () => calib ? generateCalibrationStack() : generateSynthetic();
    const hasT = typeof lastSimTimings !== 'undefined';
    const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
    let t = performance.now(); await go(); const cold = performance.now() - t;
    const coldFrames = hasT ? lastSimTimings.frames : null;
    const totals = [], stage = [];
    for (let k = 0; k < 3; k++) {
      t = performance.now(); await go(); totals.push(performance.now() - t);
      if (hasT) stage.push(lastSimTimings.frames);
    }
    return { cold, warm: med(totals), coldFrames, frames: hasT ? med(stage) : null, path: hasT ? lastSimTimings.path : 'cpu' };
  }, calib);
}

const { browser, page } = await launchPage({ headless: true });
let gpuInfo, results = [], baseBrowser = null;
try {
  gpuInfo = await checkGpu(page);
  const adapter = await page.evaluate(async () => { const e = await getGpuEngine(); const i = e.adapterInfo || {};
    return e.available ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') : 'unavailable'; });
  console.log(`GPU: ${adapter}`);
  let basePage = null;
  if (baselinePath) {
    const require = createRequire(pathToFileURL(join(repoRoot, 'tools', 'package.json')));
    const { chromium } = require('playwright');
    baseBrowser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true }));
    basePage = await baseBrowser.newPage({ viewport: { width: 1600, height: 1000 } });
    await basePage.goto(pathToFileURL(baselinePath).href);
    await basePage.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);
  }
  const allCases = [...MOVIE_CASES.map(c => ({ ...c, kind: 'movie' })),
                    { label: 'Calibration stack 128², 41 planes', kind: 'calib', set: { ...SMALL_PSF, simulation_fov: 128 } }]
    .filter(c => !caseFilter || c.label.toLowerCase().includes(caseFilter));
  for (const c of allCases) {
    await setParams(page, { ...DEFAULTS, ...c.set });
    const r = { label: c.label, kind: c.kind };
    const cpu = await timeMovie(page, false, c.kind === 'calib');
    const gpu = gpuInfo.available ? await timeMovie(page, true, c.kind === 'calib') : null;
    Object.assign(r, { cpuMs: cpu.frames, cpuTotalMs: cpu.warm, gpuMs: gpu && gpu.frames, gpuTotalMs: gpu && gpu.warm,
                       gpuColdMs: gpu && gpu.coldFrames, gpuPath: gpu && gpu.path });
    if (basePage && c.kind === 'movie') {
      await setParams(basePage, { ...DEFAULTS, ...c.set });
      r.baselineTotalMs = (await timeMovie(basePage, false)).warm;
    }
    r.speedup = r.cpuMs && r.gpuMs ? r.cpuMs / r.gpuMs : null;
    results.push(r);
    console.log(`  ${c.label.padEnd(38)} CPU ${r.cpuMs == null ? '  skip' : r.cpuMs.toFixed(0).padStart(6)} ms   GPU ${r.gpuMs == null ? '   n/a' : r.gpuMs.toFixed(0).padStart(6)} ms (${r.gpuPath || '-'})` +
      (r.baselineTotalMs ? `   baseline total ${r.baselineTotalMs.toFixed(0)} ms` : ''));
  }
} finally {
  await browser.close();
  if (baseBrowser) await baseBrowser.close();
}

const f0 = v => v == null ? 'n/a' : v.toFixed(0);
printTable(results, [
  { key: 'label', label: 'Case', width: 38 },
  { key: 'cpuMs', label: 'CPU ms', width: 8, fmt: f0 },
  { key: 'gpuMs', label: 'GPU warm ms', width: 11, fmt: f0 },
  { key: 'gpuColdMs', label: 'GPU cold ms', width: 11, fmt: f0 },
  { key: 'speedup', label: 'Speedup', width: 8, fmt: v => v ? v.toFixed(2) + 'x' : '' },
  ...(baselinePath ? [{ key: 'baselineTotalMs', label: 'Old CPU total ms', width: 16, fmt: f0 }] : []),
]);
console.log('Rows time the splat+noise stage only (lastSimTimings.frames).');
writeResults('bench-simulation', { gpu: gpuInfo, full, baseline: baselinePath, simCases: results });
