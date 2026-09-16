#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultResultsDir, writeGpuReport } from '../lib/gpu-report.mjs';
import { openInBrowser } from '../lib/report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const full = args.has('--full');
const benchesOnly = args.has('--benches-only');
const liveHardware = args.has('--live-hardware');
// --only=name1,name2 — script basenames (no .mjs), e.g. --only=bench-fit,bench-render.
// Filters the roster below to just those; omitted = every command, unchanged.
const onlyArg = argv.find(a => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null;

const TESTS = [
  ['gpu:test:foundation', 'test-foundation.mjs'],
  ['gpu:test:correctness', 'test-gpu-correctness.mjs'],
  ['gpu:test:frc', 'test-frc-gpu.mjs'],
  ['gpu:test:candidate-audit', 'test-candidate-audit.mjs'],
  ['gpu:test:report', 'test-report-generation.mjs'],
];

const BENCHES = [
  ['gpu:bench:detect', 'bench-detect.mjs'],
  ['gpu:bench:fit', 'bench-fit.mjs'],
  ['gpu:bench:render', 'bench-render.mjs'],
  ['gpu:bench:frc', 'bench-frc.mjs'],
  ['gpu:bench:stages', 'bench-gpu-stages.mjs'],
  ['gpu:bench:drift', 'bench-drift.mjs'],
  ['gpu:bench:real', 'bench-real-data.mjs', full ? ['--full'] : []],
  ['gpu:bench:calibration', 'bench-calibration.mjs'],
  ['gpu:bench:3d-fit', 'bench-3d-fit.mjs'],
  ['gpu:bench:live-render', 'bench-live-render.mjs'],
  ['gpu:bench:sSMLM', 'bench-sSMLM.mjs'],
  ['gpu:bench:spt', 'bench-spt.mjs'],
  ['gpu:bench:multifile', 'bench-multi-file-load.mjs'],
  ['gpu:bench:segmentation', 'bench-segmentation.mjs'],
  ['gpu:bench:livestream', 'bench-livestream.mjs'],
  ['gpu:bench:livestream-realtime', 'bench-livestream-realtime.mjs'],
];

// Tier C (real Micro-Manager hardware) is never part of a default/unattended
// run — nothing here can drive Micro-Manager's GUI, so this is opt-in only.
const LIVE_HARDWARE = [
  ['gpu:live-hardware', 'live-hardware-checklist.mjs'],
];

let selected = [
  ...(benchesOnly ? [] : TESTS),
  ...BENCHES,
  ...(liveHardware ? LIVE_HARDWARE : []),
].map(([name, script, scriptArgs = []]) => ({ name, script, args: scriptArgs }));

if (only) {
  selected = selected.filter(cmd => only.has(cmd.script.replace(/\.mjs$/, '')) || only.has(cmd.name));
  if (!selected.length) {
    console.error(`--only matched nothing. Known scripts: ${[...TESTS, ...BENCHES, ...LIVE_HARDWARE].map(c => c[1].replace(/\.mjs$/, '')).join(', ')}`);
    process.exit(1);
  }
}

mkdirSync(defaultResultsDir, { recursive: true });

const startedAt = new Date().toISOString();
const runStart = Date.now();
const commands = [];

for (const cmd of selected) {
  const before = snapshotResults();
  const started = Date.now();
  const result = await runNodeScript(cmd);
  const durationMs = Date.now() - started;
  const changed = changedResults(before);
  commands.push({
    ...cmd,
    status: result.exitCode === 0 ? (/\bSKIP\b/i.test(result.output) ? 'skip' : 'pass') : 'fail',
    exitCode: result.exitCode,
    durationMs,
    resultFiles: changed,
  });
}

const endedAt = new Date().toISOString();
const resultFiles = [...new Set(commands.flatMap(cmd => cmd.resultFiles))];
const run = {
  mode: benchesOnly ? 'benches' : 'all',
  only: only ? [...only] : null,
  full,
  startedAt,
  endedAt,
  durationMs: Date.now() - runStart,
  commands,
};

const report = writeGpuReport({ run, resultFiles });
console.log(`\nGPU latest JSON: ${report.latestPath}`);
console.log(`GPU HTML report: ${report.reportPath}`);
openInBrowser(report.reportPath);

if (commands.some(cmd => cmd.status === 'fail')) process.exitCode = 1;

function runNodeScript(cmd) {
  return new Promise(resolve => {
    const scriptPath = join(__dirname, cmd.script);
    console.log(`\n=== ${cmd.name}: node ${cmd.script} ${(cmd.args || []).join(' ')} ===`);
    const child = spawn(process.execPath, [scriptPath, ...(cmd.args || [])], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Tells the child's own writeResults() (tests/lib/report.mjs) not to
      // generate/open its own single-command report — this suite writes ONE
      // combined report at the end instead (see openInBrowser() call above).
      env: { ...process.env, WEBSMLM_TEST_SUITE: '1' },
    });
    let output = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on('close', exitCode => resolve({ exitCode, output }));
  });
}

function snapshotResults() {
  const out = new Map();
  if (!existsSync(defaultResultsDir)) return out;
  for (const name of readdirSync(defaultResultsDir)) {
    if (!name.endsWith('.json') || name === 'gpu-latest.json') continue;
    const path = join(defaultResultsDir, name);
    out.set(path, statSync(path).mtimeMs);
  }
  return out;
}

function changedResults(before) {
  const changed = [];
  const after = snapshotResults();
  for (const [file, mtimeMs] of after) {
    if (!before.has(file) || mtimeMs > before.get(file) + 0.5) changed.push(file);
  }
  return changed.sort();
}
