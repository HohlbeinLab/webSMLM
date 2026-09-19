#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGpuReport } from '../lib/gpu-report.mjs';

const dir = mkdtempSync(join(tmpdir(), 'websmlm-gpu-report-'));

try {
  const fitFile = join(dir, 'bench-fit.json');
  const renderFile = join(dir, 'bench-render.json');

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

  const first = writeGpuReport({ run, resultFiles: [fitFile, renderFile], resultsDir: dir });
  const second = writeGpuReport({ run, resultFiles: [fitFile, renderFile], resultsDir: dir });

  assert.equal(first.latestPath, second.latestPath, 'latest JSON path must be stable and overwritten');
  assert.equal(first.reportPath, second.reportPath, 'HTML report path must be stable and overwritten');

  const html = readFileSync(first.reportPath, 'utf8');
  assert.match(html, /Latest update/i);
  assert.match(html, /2026-09-11T10:00:00\.000Z/);
  assert.match(html, /CPU fit ms/i);
  assert.match(html, /GPU fit ms/i);
  assert.match(html, /CPU ms/i);
  assert.match(html, /GPU ms/i);
  assert.match(html, /fit fixture/);
  assert.match(html, /render fixture/);
  assert.match(html, /3\.00x|3x/);

  const latest = JSON.parse(readFileSync(first.latestPath, 'utf8'));
  assert.equal(latest.startedAt, run.startedAt);
  assert.equal(latest.endedAt, run.endedAt);
  assert.equal(latest.resultFiles.length, 2);

  console.log('GPU report generation: PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
