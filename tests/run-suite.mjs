#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultResultsDir, writeGpuReport } from './lib/gpu-report.mjs';
import { openInBrowser } from './lib/report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const full = args.has('--full');
const everything = args.has('--everything');
const benchesOnly = args.has('--benches-only');
const testsOnly = args.has('--tests-only');
const KNOWN_FLAGS = ['--full', '--everything', '--benches-only', '--tests-only', '--live-hardware', '--gpu', '--cpu', '--io', '--livestream', '--harness', '--validation', '--only=<a,b>'];
const unknown = argv.filter(a => a.startsWith('--') && !a.startsWith('--only=') && !KNOWN_FLAGS.includes(a));
if (unknown.length) { console.error(`Unknown flag(s): ${unknown.join(' ')}
Accepted: ${KNOWN_FLAGS.join(' ')}`); process.exit(1); }
if (testsOnly && benchesOnly) { console.error('--tests-only and --benches-only are mutually exclusive.'); process.exit(1); }
const liveHardware = args.has('--live-hardware');
// --only=name1,name2 — script basenames (no .mjs), e.g. --only=bench-fit,bench-render.
// Filters the roster below to just those; omitted = every command, unchanged.
const onlyArg = argv.find(a => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null;

// One roster: { group (folder under tests/), name, script, args }. Names match the npm scripts in tools/package.json.
const T = (group, name, script, scriptArgs = []) => ({ kind: 'test', group, name: `${group}:test:${name}`, script, args: scriptArgs });
const B = (group, name, script, scriptArgs = []) => ({ kind: 'bench', group, name: `${group}:bench:${name}`, script, args: scriptArgs });
const ROSTER = [
  T('gpu', 'foundation', 'test-foundation.mjs'),
  T('gpu', 'correctness', 'test-gpu-correctness.mjs'),
  T('gpu', 'frc', 'test-frc-gpu.mjs'),
  T('gpu', 'candidate-audit', 'test-candidate-audit.mjs'),
  T('gpu', 'pcfo', 'test-pcfo.mjs'),
  T('gpu', 'simulation', 'test-sim-gpu.mjs'),
  T('gpu', 'shape-test', 'test-shape-test.mjs'),
  T('gpu', 'frame-cache', 'test-frame-cache-integrity.mjs'),
  T('gpu', 'view3d', 'test-view3d.mjs'),
  T('gpu', 'viewport-gpu', 'test-viewport-gpu.mjs'),
  T('gpu', 'frc-pixelsize', 'test-frc-pixelsize.mjs'),
  T('gpu', 'sim-memory', 'test-sim-memory.mjs'),
  T('gpu', 'comet-drift', 'test-comet-drift.mjs'),
  T('cpu', 'viewport', 'test-viewport-render.mjs'),
  T('cpu', 'cellfield-worker', 'test-cellfield-worker.mjs'),
  T('cpu', 'mle-variance', 'test-mle-vs-aperture-variance.mjs'),
  T('cpu', 'smfret-anchored-bg', 'test-smfret-anchored-bg.mjs'),
  T('cpu', 'smfret-bearing-width', 'test-smfret-bearing-width.mjs'),
  T('cpu', 'smfret-fit-robustness', 'test-smfret-fit-robustness.mjs'),
  T('io', 'bigtiff', 'test-bigtiff.mjs'),
  T('io', 'rotate', 'test-rotate-movie.mjs'),
  T('io', 'save-sim', 'test-save-sim-movie.mjs'),
  T('io', 'load-clears', 'test-load-clears-state.mjs'),
  T('harness', 'report', 'test-report-generation.mjs'),
  T('harness', 'datasets', 'datasets.test.mjs'),
  T('harness', 'cross-report', 'test-cross-report.mjs'),
  T('harness', 'dashboard', 'test-dashboard.mjs'),
    T('validation', 'self-consistency', 'test-score-self-consistency.mjs'),
  B('gpu', 'detect', 'bench-detect.mjs'),
  B('gpu', 'fit', 'bench-fit.mjs'),
  B('gpu', 'render', 'bench-render.mjs'),
  B('gpu', 'frc', 'bench-frc.mjs'),
  B('gpu', 'simulation', 'bench-simulation.mjs', full ? ['--full'] : []),
  B('gpu', 'stages', 'bench-gpu-stages.mjs'),
  B('gpu', '3d-fit', 'bench-3d-fit.mjs'),
  B('gpu', 'live-render', 'bench-live-render.mjs'),
  B('gpu', 'real', 'bench-real-data.mjs', full ? ['--full'] : []),
  B('cpu', 'drift', 'bench-drift.mjs'),
  B('cpu', 'calibration', 'bench-calibration.mjs'),
  B('cpu', 'sSMLM', 'bench-sSMLM.mjs'),
  B('cpu', 'spt', 'bench-spt.mjs'),
  B('cpu', 'segmentation', 'bench-segmentation.mjs'),
  B('cpu', 'segmentation-scrambled', 'bench-segmentation.mjs', ['--dataset=cas12a-scrambled']),
  B('io', 'multifile', 'bench-multi-file-load.mjs'),
  B('livestream', 'livestream', 'bench-livestream.mjs'),
  B('livestream', 'livestream-realtime', 'bench-livestream-realtime.mjs'),
];

// Tier C (real Micro-Manager hardware) is never part of a default/unattended
// run — nothing here can drive Micro-Manager's GUI, so this is opt-in only.
const LIVE_HARDWARE = [
  { kind: 'live', group: 'livestream', name: 'livestream:live-hardware', script: 'live-hardware-checklist.mjs', args: [] },
];

// Optional software validation joins only the explicit "everything" run.
// cross-validate exits successfully with SKIP when Python/Picasso is unavailable.
const OPTIONAL_VALIDATION = [
    B('validation', 'regimes', 'bench-regime-matrix.mjs', full ? ['--full'] : []),
  B('validation', 'picasso-independent', 'cross-validate.mjs', full ? ['--full'] : []),
  B('validation', 'picasso-simulator', 'cross-validate.mjs', ['--truth=simulator', ...(full ? ['--full'] : [])]),
  B('validation', 'picasso-epfl-hd', 'cross-validate.mjs', ['--dataset=epfl-as-hd']),
  ...(full ? [B('validation', 'picasso-epfl-ld', 'cross-validate.mjs', ['--dataset=epfl-as-ld', '--full'])] : []),
];

// Group flags (--gpu --cpu --io --livestream --harness --validation) combine; none = every group.
const GROUPS = ['gpu', 'cpu', 'io', 'livestream', 'harness', 'validation'].filter(g => args.has(`--${g}`));
let selected = [
  ...ROSTER.filter(c => !(benchesOnly && c.kind === 'test') && !(testsOnly && c.kind === 'bench') && (!GROUPS.length || GROUPS.includes(c.group))),
  ...(everything ? OPTIONAL_VALIDATION : []),
  ...(liveHardware ? LIVE_HARDWARE : []),
];

if (only) {
  selected = selected.filter(cmd => only.has(cmd.script.replace(/\.mjs$/, '')) || only.has(cmd.name));
  if (!selected.length) {
    console.error(`--only matched nothing. Known scripts: ${[...ROSTER, ...OPTIONAL_VALIDATION, ...LIVE_HARDWARE].map(c => c.script.replace(/\.mjs$/, '')).join(', ')}`);
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
    status: result.exitCode === 0 ? (/^\s*(?:SKIP(?:PED)?|Skipping)\b/im.test(result.output) ? 'skip' : 'pass') : 'fail',
    exitCode: result.exitCode,
    durationMs,
    resultFiles: changed,
    log: result.output.replaceAll('\r', '').split('\n').slice(-1200),
  });
}

const endedAt = new Date().toISOString();
const resultFiles = [...new Set(commands.flatMap(cmd => cmd.resultFiles))];
const run = {
  mode: benchesOnly ? 'benches' : testsOnly ? 'tests' : 'all',
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
    const scriptPath = join(__dirname, cmd.group, cmd.script);
    console.log(`\n=== ${cmd.name}: node ${cmd.group}/${cmd.script} ${(cmd.args || []).join(' ')} ===`);
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
