#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGpuReport } from '../lib/gpu-report.mjs';
import { writeResults } from '../lib/report.mjs';

const dir = mkdtempSync(join(tmpdir(), 'websmlm-gpu-report-'));
let standaloneFile;

try {
  const fitFile = join(dir, 'bench-fit.json');
  const renderFile = join(dir, 'bench-render.json');
  const regimeFile = join(dir, 'regime-matrix.json');

  writeFileSync(fitFile, JSON.stringify({
    gpu: { available: true, adapter: 'fixture adapter' },
    cases: [{
      label: 'fit fixture',
      path: 'gpu',
      reason: 'selected',
      cpuFitMs: 120,
      gpuFitMs: 40,
      speedup: 3,
      acceptDiscord: 0,
      posP99: 0.0005,
      maxDx: 0.002,
      verdict: 'GPU faster (3.00x)'
    }]
  }, null, 2));

  writeFileSync(renderFile, JSON.stringify({
    gpu: { available: true },
    cases: [{
      label: 'render fixture',
      mode: 'precision',
      cpuMs: 90,
      gpuMs: 30,
      speedup: 3,
      massRelError: 0.000001,
      maxByteDiff: 2,
      correct: true,
      verdict: 'GPU faster (3.00x)'
    }]
  }, null, 2));

  writeFileSync(regimeFile, JSON.stringify({ rows: [{
    cell_id: 'anchor', status: 'fail', tier2: 'REGRESSED', sim_seed: 1234, structure: 'microtubules', engine: 'cpu', frames: 50,
    n_gt_events: 400, n_locs: 360, tp: 340, fp: 20, fn: 60, jaccard: 0.81,
    precision: 0.94, recall: 0.85, rmse_lat_nm: 18.2, rmse_z_nm: 42.5,
    method: 'mle3d', psf_px: 1.3, winr: 4, det_thr: 4, fit_ms: 220, locs_per_s: 1636,
  }] }, null, 2));

  const run = {
    startedAt: '2026-09-11T10:00:00.000Z',
    endedAt: '2026-09-11T10:00:05.000Z',
    durationMs: 5000,
    full: false,
    commands: [
      { name: 'gpu:bench:fit', script: 'bench-fit.mjs', status: 'pass', exitCode: 0, durationMs: 1000, resultFiles: [fitFile] },
      { name: 'gpu:bench:render', script: 'bench-render.mjs', status: 'pass', exitCode: 0, durationMs: 1000, resultFiles: [renderFile] }
    ]
  };

  const first = writeGpuReport({ run, resultFiles: [fitFile, renderFile, regimeFile], resultsDir: dir });
  const second = writeGpuReport({ run, resultFiles: [fitFile, renderFile, regimeFile], resultsDir: dir });

  assert.equal(first.latestPath, second.latestPath, 'latest JSON path must be stable and overwritten');
  assert.equal(first.reportPath, second.reportPath, 'HTML report path must be stable and overwritten');

  const html = readFileSync(first.reportPath, 'utf8');
  assert.match(html, /webSMLM test run report/i);
  assert.match(html, /Latest update/i);
  assert.match(html, /2026-09-11T10:00:00\.000Z/);
  assert.match(html, /How to read these results/i);
  assert.match(html, /Central processing unit \(CPU\)/i);
  assert.match(html, /Graphics processing unit \(GPU\)/i);
  assert.match(html, /CPU fit time \(ms\)/i);
  assert.match(html, /GPU fit time \(ms\)/i);
  assert.doesNotMatch(html, />pos p99</i);
  assert.doesNotMatch(html, />max dx</i);
  assert.match(html, /fit fixture/);
  assert.match(html, /render fixture/);
  assert.match(html, /Known-ground-truth simulation accuracy/i);
  assert.match(html, /Lateral root mean square error \(nm\)/i);
  assert.match(html, /Ground-truth events/i);
  assert.match(html, /Changed beyond tolerance/i);
  assert.match(html, /3\.00x|3x/);
  assert.doesNotMatch(html, /Simulation CPU vs GPU/i, 'empty benchmark sections must be omitted');

  const latest = JSON.parse(readFileSync(first.latestPath, 'utf8'));
  assert.equal(latest.startedAt, run.startedAt);
  assert.equal(latest.endedAt, run.endedAt);
  assert.equal(latest.resultFiles.length, 3);

  let standaloneRun;
  const oldSuite = process.env.WEBSMLM_TEST_SUITE;
  const oldNoOpen = process.env.WEBSMLM_TEST_NO_OPEN;
  try {
    delete process.env.WEBSMLM_TEST_SUITE;
    process.env.WEBSMLM_TEST_NO_OPEN = '1';
    standaloneFile = writeResults('harness-standalone-report-metadata', { ok: true }, {
      durationMs: 1234,
      reportWriter: args => { standaloneRun = args.run; return { reportPath: 'not-opened' }; },
    });
  } finally {
    if (oldSuite == null) delete process.env.WEBSMLM_TEST_SUITE; else process.env.WEBSMLM_TEST_SUITE = oldSuite;
    if (oldNoOpen == null) delete process.env.WEBSMLM_TEST_NO_OPEN; else process.env.WEBSMLM_TEST_NO_OPEN = oldNoOpen;
  }
  assert.equal(standaloneRun.durationMs, 1234);
  assert.equal(standaloneRun.commands[0].status, 'pass');
  assert.equal(standaloneRun.commands[0].exitCode, 0);

  console.log('GPU report generation: PASS');
} finally {
  if (standaloneFile) rmSync(standaloneFile, { force: true });
  rmSync(dir, { recursive: true, force: true });
}
