#!/usr/bin/env node
import { launchPage } from '../lib/launch.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';
import { getDataset, parseGpuMode } from '../lib/datasets.mjs';
import { expectGpuUsed, printTable, speedup, writeResults } from '../lib/report.mjs';

const key = process.argv.find(arg => arg.startsWith('--dataset='))?.slice('--dataset='.length);
if (!key) throw new Error('Pass --dataset=<key>.');
const dataset = getDataset(key);
if (!dataset.scenarios.includes('localize-cpu') || !dataset.scenarios.includes('localize-gpu')) {
  throw new Error(`${key} is not configured for CPU/GPU localization.`);
}

const gpuMode = parseGpuMode();
const full = process.argv.includes('--full');
const target = await resolveDatasetFile(key, 'stack');
if (!target) { console.log(`Skipping ${key} benchmark.`); process.exit(0); }

const config = {
  ...dataset.parameters,
  method: 'gaussmle', psf: 1.3, winr: 4,
  detFilter: 'wave', detection_wavelet_thr: 4,
  fitFirstFrame: 1, fitLastFrame: full ? Infinity : 2500,
};
const modes = gpuMode === 'both' ? ['cpu', 'gpu'] : [gpuMode];
const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', target);
  const runs = [];
  for (const mode of modes) {
    console.log(`Running ${key} on ${mode.toUpperCase()}...`);
    const result = await page.evaluate(async ({ config, mode }) => {
      const file = document.getElementById('analyzeFileInput').files[0];
      const r = await window.webSMLM.analyze({ ...config, file, useGpu: mode === 'gpu' });
      return { mode, nLocalizations: r.locs.length, timings: r.timings, execution: r.execution, logText: r.logText };
    }, { config, mode });
    if (mode === 'gpu') expectGpuUsed(result.logText, true);
    runs.push(result);
  }

  const cpu = runs.find(run => run.mode === 'cpu');
  const gpu = runs.find(run => run.mode === 'gpu');
  const rows = runs.map(run => ({
    mode: run.mode.toUpperCase(), nLocs: run.nLocalizations,
    wallMs: Math.round(run.timings.runMs), fitMs: Math.round(run.timings.tFit),
    speedup: cpu && run === gpu ? speedup(cpu.timings.runMs, gpu.timings.runMs) : null,
  }));
  printTable(rows, [
    { key: 'mode', label: 'mode', width: 5 },
    { key: 'nLocs', label: 'locs', width: 10 },
    { key: 'wallMs', label: 'wall ms', width: 10 },
    { key: 'fitMs', label: 'fit ms', width: 10 },
    { key: 'speedup', label: 'speedup', width: 9, fmt: value => value == null ? '-' : `${value.toFixed(2)}x` },
  ]);
  const outFile = writeResults(`bench-${key}`, { dataset: key, target, full, gpuMode, parameters: config, runs });
  console.log(`Full results written to ${outFile}`);
} finally {
  await browser.close();
}
