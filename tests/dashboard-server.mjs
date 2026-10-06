#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASETS } from './lib/datasets.mjs';
import { openInBrowser } from './lib/report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const toolsDir = join(repoRoot, 'tools');
const resultsDir = join(__dirname, 'results');
const dashboardPath = join(__dirname, 'dashboard.html');
const packagePath = join(toolsDir, 'package.json');
const historyPath = join(resultsDir, 'dashboard-runs.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const requireFromTools = createRequire(packagePath);
const MAX_BODY = 64 * 1024;
const MAX_LOG_LINES = 3000;
const MAX_COMMAND_LOG_LINES = 1200;
const MAX_SAVED_RUNS = 25;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const EXCLUDED_SCRIPTS = new Set([
  'postinstall', 'dashboard', 'harness:test:dashboard',
  'validation:setup', 'picasso:setup', 'data:download', 'bench:dataset',
]);
const SUITE_INFO = {
  test: ['All correctness tests', 'Runs tests only; benchmarks are excluded.'],
  all: ['Standard run', 'Runs every automated test and bounded benchmark. Optional data and tools may skip.'],
  'all:full': ['Standard run (full workloads)', 'The standard run with full-size benchmark workloads.'],
  everything: ['Everything available', 'The standard run plus independent, same-seed simulator, and available EPFL ground-truth comparisons with Picasso.'],
  'everything:full': ['Everything available (full)', 'Everything available with full workloads, including the EPFL low-density comparison when downloaded.'],
  'bench:all': ['All bounded benchmarks', 'Runs benchmarks only with their normal bounded workloads.'],
  'gpu:all': ['GPU group', 'Runs all GPU tests and bounded GPU benchmarks.'],
  'cpu:all': ['CPU group', 'Runs all CPU tests and bounded CPU benchmarks.'],
  'io:all': ['File loading and saving group', 'Runs all automated input/output checks.'],
  'livestream:all': ['Livestream group', 'Runs simulated livestream checks; live hardware stays manual.'],
  'validation:all': ['Built-in validation group', 'Runs validation that does not require Picasso.'],
};

function readCommandSources(command) {
  let source = command;
  for (const match of command.matchAll(/\.\.\/tests\/[^\s&|]+\.mjs/g)) {
    const path = resolve(toolsDir, match[0]);
    if (existsSync(path)) source += `\n${readFileSync(path, 'utf8')}`;
  }
  return source;
}

function benchmarkSource(dataset) {
  if (!dataset.benchmark) return '';
  for (const group of ['gpu', 'cpu', 'io', 'livestream', 'validation']) {
    const path = join(__dirname, group, dataset.benchmark);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return '';
}

function commandDatasetDependencies(command) {
  let source = readCommandSources(command);
  const hasResolver = /resolveDatasetFile\s*\(/.test(source);
  const commandKeys = Object.keys(DATASETS).filter(key => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s=])${escaped}(?:$|\\s)`).test(command);
  });
  const sourceKeys = Object.keys(DATASETS).filter(key => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`resolveDatasetFile\\(\\s*['"]${escaped}['"]`).test(source)
      || (hasResolver && source.includes(key));
  });
  const keys = commandKeys.length ? commandKeys : sourceKeys;
  for (const key of keys) source += `\n${benchmarkSource(DATASETS[key])}`;
  return keys.map(key => ({
    key,
    roles: Object.keys(DATASETS[key].files || {}).filter(role =>
      source.includes(`'${role}'`) || source.includes(`"${role}"`)),
  }));
}

export function commandStatus(exitCode, output, cancelled = false) {
  if (cancelled) return 'cancelled';
  if (exitCode !== 0) return 'fail';
  return /^\s*(?:SKIP(?:PED)?|Skipping)\b/im.test(output) ? 'skip' : 'pass';
}

function scriptGroup(name) {
  if (name.startsWith('bench:dataset:') || name.startsWith('data:')) return 'datasets';
  if (!name.includes(':') || ['all:full', 'bench:all', 'live-hardware'].includes(name)) return 'suites';
  return name.split(':')[0];
}

function scriptKind(name) {
  if (['test', 'all', 'all:full', 'everything', 'everything:full', 'bench:all', 'live-hardware', 'gpu:test'].includes(name) || name.endsWith(':all')) return 'suite';
  if (name.includes(':bench:') || name.startsWith('bench:')) return 'benchmark';
  return 'test';
}

function runnableScripts() {
  return Object.entries(packageJson.scripts)
    .filter(([name]) => !EXCLUDED_SCRIPTS.has(name) && !name.startsWith('data:download:'))
    .map(([name, command]) => {
      const info = SUITE_INFO[name];
      const kind = scriptKind(name);
      return {
        name,
        command,
        label: info?.[0] || name,
        description: info?.[1] || '',
        group: scriptGroup(name),
        kind,
        full: name.includes(':full'),
        manual: name === 'live-hardware',
        aliasFor: command.match(/^(?:npm|bun) run ([^\s]+)$/)?.[1] || null,
        datasetDependencies: kind === 'suite' ? [] : commandDatasetDependencies(command),
      };
    });
}

const scripts = runnableScripts();
const scriptsByName = new Map(scripts.map(script => [script.name, script]));

function selectionConflict(names) {
  if (names.some(name => ['all', 'all:full', 'everything', 'everything:full'].includes(name)) && names.length > 1) return 'Predefined whole-project runs must run by themselves.';
  for (const name of names) {
    const script = scriptsByName.get(name);
    if (script?.aliasFor && names.includes(script.aliasFor)) return `${name} is an alias of ${script.aliasFor}.`;
    if (name === 'test' && names.some(other => other !== name && scriptsByName.get(other)?.kind === 'test')) return 'test already includes the selected individual tests.';
    if (name === 'bench:all' && names.some(other => other !== name && scriptsByName.get(other)?.kind === 'benchmark')) return 'bench:all already includes the selected benchmarks.';
    if (name.endsWith(':all')) {
      const group = name.split(':')[0];
      if (names.some(other => other !== name && other.startsWith(`${group}:`))) return `${name} already includes the selected ${group} commands.`;
    }
  }
  return null;
}

function datasetState() {
  return Object.entries(DATASETS).map(([key, dataset]) => {
    const base = join(repoRoot, 'temp', dataset.localPath);
    const roles = Object.fromEntries(Object.entries(dataset.files || {}).map(([roleName, role]) => [roleName,
      Boolean(process.env[role.envKey] && existsSync(resolve(process.env[role.envKey])))
      || (role.paths || []).some(file => existsSync(join(base, file))),
    ]));
    const present = (!dataset.download?.marker || existsSync(join(base, dataset.download.marker)))
      && Object.values(roles).every(Boolean);
    const bytes = typeof dataset.bytes === 'number' ? dataset.bytes
      : Object.values(dataset.bytes || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    return {
      key,
      label: dataset.label,
      source: dataset.source || null,
      scenarios: dataset.scenarios || [],
      present,
      downloadable: Boolean(dataset.download),
      roles,
      bytes: bytes || null,
      localPath: `temp/${dataset.localPath}`,
    };
  });
}

function dependencyState(dependencies, states = datasetState()) {
  const byKey = new Map(states.map(dataset => [dataset.key, dataset]));
  return dependencies.map(dependency => {
    const dataset = byKey.get(dependency.key);
    const present = dependency.roles.length
      ? dependency.roles.every(role => dataset?.roles?.[role])
      : Boolean(dataset?.present);
    return { ...dataset, roles: dependency.roles, present };
  }).filter(dataset => dataset.key);
}

export function commandReason(status, log, datasets) {
  const missing = datasets.filter(dataset => !dataset.present);
  if (missing.length && ['skip', 'fail'].includes(status)) {
    const downloadable = missing.filter(dataset => dataset.downloadable).map(dataset => dataset.label);
    const privateFixtures = missing.filter(dataset => !dataset.downloadable).map(dataset => dataset.label);
    const parts = [];
    if (downloadable.length) parts.push(`Please download ${downloadable.join(', ')} under Real data, then rerun.`);
    if (privateFixtures.length) parts.push(`Provide the local fixture for ${privateFixtures.join(', ')} at its documented path or environment variable.`);
    return parts.join(' ');
  }
  if (status === 'skip') return log.find(line => /^\s*(?:SKIP(?:PED)?|Skipping)\b/i.test(line))?.trim() || 'An optional requirement was unavailable.';
  return '';
}

function parseResult(path, stat) {
  const name = basename(path);
  const result = { name, size: stat.size, modifiedAt: stat.mtime.toISOString(), type: 'json', summary: {} };
  if (stat.size > MAX_RESULT_BYTES) return { ...result, summary: { note: 'Large result; open JSON for details.' } };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.commands && data.summary) {
      result.type = name.startsWith('picasso-') ? 'validation-suite' : 'test-suite';
      result.summary = { ...data.summary, durationMs: data.durationMs, mode: data.mode };
      result.commands = data.commands.map(command => ({
        name: command.name,
        group: command.group || command.name?.split(':')[0] || 'other',
        kind: command.kind || (command.name?.includes(':bench:') ? 'benchmark' : 'test'),
        status: command.status,
        durationMs: command.durationMs,
      }));
    } else if (data.dataset || data.gpuMode || data.cpuRunMs != null || data.gpuRunMs != null) {
      result.type = 'dataset-benchmark';
      result.summary = {
        dataset: data.dataset || data.label,
        gpuMode: data.gpuMode,
        nFiles: data.nFiles,
        nFrames: data.nFrames,
        nLocs: data.nLocs,
        nCand: data.nCand,
        cpuRunMs: data.cpuRunMs,
        gpuRunMs: data.gpuRunMs,
        fitSpeedup: data.fitSpeedup,
        wallSpeedup: data.wallSpeedup,
        verdict: data.verdict,
      };
      result.parameters = data.parameters || null;
    } else if (data.crossTool || data.tools?.picasso) {
      result.type = 'validation';
      result.summary = {
        truthSource: data.truthSource,
        matchRadiusNm: data.matchRadiusNm,
        emitters: data.truth?.emitters?.length || data.truth?.nEmitters,
        webSMLM: data.tools?.webSMLM?.nLocs,
        picasso: data.tools?.picasso?.nLocs,
      };
      result.parameters = data.parameters || null;
    } else {
      result.summary = { keys: Object.keys(data).slice(0, 12).join(', ') };
    }
  } catch (error) {
    result.type = 'invalid';
    result.summary = { error: error.message };
  }
  return result;
}

function scanResults() {
  mkdirSync(resultsDir, { recursive: true });
  return readdirSync(resultsDir)
    .filter(name => name !== basename(historyPath) && (name.endsWith('.json') || name.endsWith('.html')))
    .map(name => {
      const path = join(resultsDir, name);
      const stat = statSync(path);
      return name.endsWith('.html')
        ? { name, size: stat.size, modifiedAt: stat.mtime.toISOString(), type: 'report', summary: {} }
        : parseResult(path, stat);
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function readRunHistory() {
  try {
    const data = JSON.parse(readFileSync(historyPath, 'utf8'));
    return Array.isArray(data.runs) ? data.runs.slice(0, MAX_SAVED_RUNS) : [];
  } catch { return []; }
}

function writeRunHistory(runs) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({ format: 'websmlm-dashboard-runs-v1', runs }, null, 2));
}

function snapshotResultFiles() {
  const files = new Map();
  if (!existsSync(resultsDir)) return files;
  for (const name of readdirSync(resultsDir)) {
    if (name === basename(historyPath) || (!name.endsWith('.json') && !name.endsWith('.html'))) continue;
    files.set(name, statSync(join(resultsDir, name)).mtimeMs);
  }
  return files;
}

function changedResultFiles(before) {
  return [...snapshotResultFiles()].filter(([name, mtime]) => !before.has(name) || mtime > before.get(name) + 0.5).map(([name]) => name).sort();
}

export function snapshotMutableArtifacts(names, runId, commandName, directory = resultsDir) {
  const suffix = `${runId}-${commandName}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  return names.map(name => {
    if (!name.endsWith('.html') && !name.endsWith('-latest.json')) return name;
    const dot = name.lastIndexOf('.');
    const snapshot = `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
    copyFileSync(join(directory, name), join(directory, snapshot));
    return snapshot;
  });
}

function suiteChildren(resultFiles) {
  const latest = ['gpu-latest.json', 'picasso-latest.json'].find(name => resultFiles.includes(name));
  if (!latest) return [];
  try {
    const data = JSON.parse(readFileSync(join(resultsDir, latest), 'utf8'));
    return (data.commands || []).map(command => {
      const log = Array.isArray(command.log) ? command.log : command.log ? String(command.log).split(/\r?\n/) : ['No per-test log was recorded.'];
      const datasets = dependencyState(scriptsByName.get(command.name)?.datasetDependencies || []);
      return {
        name: command.name,
        group: command.group || command.name?.split(':')[0] || 'other',
        kind: command.kind || (command.name?.includes(':bench:') ? 'benchmark' : 'test'),
        status: command.status,
        reason: commandReason(command.status, log, datasets),
        datasets,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        results: (command.resultFiles || []).map(file => basename(file)),
        log,
      };
    });
  } catch { return []; }
}

function summarizeCommands(commands) {
  const expanded = commands.flatMap(command => command.children?.length ? command.children : [command]);
  const count = status => expanded.filter(command => command.status === status).length;
  return { total: expanded.length, passed: count('pass'), failed: count('fail'), skipped: count('skip'), cancelled: count('cancelled') };
}

function commandVersion(command, args = ['--version'], timeout = 5000) {
  return new Promise(resolveVersion => {
    let output = '';
    let settled = false;
    let child;
    let timer;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveVersion({ ok, detail: String(detail || '').trim() });
    };
    try { child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish(false, error.code === 'ENOENT' ? 'Not installed' : error.message); return; }
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => finish(false, error.code === 'ENOENT' ? 'Not installed' : error.message));
    child.on('close', code => finish(code === 0, output.split(/\r?\n/).find(Boolean) || `Exited ${code}`));
    timer = setTimeout(() => { child.kill(); finish(false, 'Timed out'); }, timeout);
  });
}

async function collectDiagnostics() {
  const npmRunner = packageRunner();
  const [npm, bun, python] = await Promise.all([
    commandVersion(npmRunner.command, [...npmRunner.prefix, '--version']),
    commandVersion(process.platform === 'win32' ? 'bun.exe' : 'bun'),
    commandVersion('python'),
  ]);
  let playwright = { ok: false, detail: 'Run JavaScript setup' };
  let chromium = { ok: false, detail: 'Run JavaScript setup' };
  try {
    const module = requireFromTools('playwright');
    playwright = { ok: true, detail: requireFromTools('playwright/package.json').version };
    const executable = module.chromium.executablePath();
    chromium = { ok: existsSync(executable), detail: existsSync(executable) ? 'Installed' : 'Browser binary missing' };
  } catch {}

  let picasso = { ok: false, detail: python.ok ? 'Run Python/Picasso setup' : 'Python is not installed' };
  if (python.ok) picasso = await commandVersion('python', ['-c', "import picasso; print(getattr(picasso, '__version__', 'installed'))"], 10_000);

  let writable = true;
  try { mkdirSync(resultsDir, { recursive: true }); accessSync(resultsDir, constants.W_OK); } catch { writable = false; }
  return {
    updatedAt: new Date().toISOString(),
    items: [
      { id: 'node', label: 'Node', ok: true, detail: process.version },
      { id: 'npm', label: 'npm', ...npm },
      { id: 'bun', label: 'Bun', ...bun, optional: true },
      { id: 'playwright', label: 'Playwright', ...playwright },
      { id: 'chromium', label: 'Chromium', ...chromium },
      { id: 'python', label: 'Python', ...python },
      { id: 'picasso', label: 'Picasso', ...picasso },
      { id: 'results', label: 'Results directory', ok: writable, detail: writable ? 'Writable' : 'Not writable' },
      { id: 'gpu-report', label: 'GPU report', ok: existsSync(join(resultsDir, 'gpu-report.html')), detail: existsSync(join(resultsDir, 'gpu-report.html')) ? 'Available' : 'Not generated yet', optional: true },
      { id: 'validation-report', label: 'Validation report', ok: existsSync(join(resultsDir, 'picasso-report.html')), detail: existsSync(join(resultsDir, 'picasso-report.html')) ? 'Available' : 'Not generated yet', optional: true },
    ],
  };
}

function packageRunner() {
  const execPath = process.env.npm_execpath;
  if (execPath && /bun(?:\.exe)?$/i.test(execPath)) return { command: execPath, prefix: [] };
  if (execPath && /npm-cli\.js$/i.test(execPath)) return { command: process.execPath, prefix: [execPath] };
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) return { command: process.execPath, prefix: [npmCli] };
  return process.platform === 'win32'
    ? { command: 'cmd.exe', prefix: ['/d', '/s', '/c', 'npm'] }
    : { command: 'npm', prefix: [] };
}

function packageCommand(name) {
  const runner = packageRunner();
  return { command: runner.command, args: [...runner.prefix, 'run', name] };
}

function installCommand() {
  const runner = packageRunner();
  return { command: runner.command, args: [...runner.prefix, 'install'] };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body.')); }
    });
    request.on('error', reject);
  });
}

export async function startDashboardServer({ host = '127.0.0.1', port = 0, open = true } = {}) {
  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  let activeChild = null;
  let cancelled = false;
  let diagnostics = { updatedAt: null, busy: true, items: [] };
  let gpuDiagnostic = { ok: null, detail: 'Not checked' };
  let runs = readRunHistory();
  let activeRecord = null;
  const run = { id: null, busy: false, active: null, startedAt: null, endedAt: null, selection: [], commands: [], log: [] };

  const snapshot = () => {
    const datasetStates = datasetState();
    return {
      scripts: scripts.map(script => ({ ...script, datasets: dependencyState(script.datasetDependencies, datasetStates) })),
      datasets: datasetStates.filter(dataset => dataset.downloadable),
      diagnostics,
      gpuDiagnostic,
      results: scanResults(),
      run,
      runs,
    };
  };

  const broadcast = (type = 'state', payload = snapshot()) => {
    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(message);
  };

  const appendLog = text => {
    const lines = String(text).replaceAll('\r', '').split('\n');
    if (!lines.at(-1)) lines.pop();
    run.log.push(...lines);
    if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
    if (activeRecord) {
      activeRecord.log.push(...lines);
      if (activeRecord.log.length > MAX_COMMAND_LOG_LINES) activeRecord.log.splice(0, activeRecord.log.length - MAX_COMMAND_LOG_LINES);
    }
    broadcast('log', { lines });
  };

  const refreshDiagnostics = async () => {
    diagnostics = { ...diagnostics, busy: true };
    broadcast();
    diagnostics = { ...(await collectDiagnostics()), busy: false };
    broadcast();
    return diagnostics;
  };

  const runQueue = async entries => {
    run.busy = true;
    run.active = null;
    run.startedAt = new Date().toISOString();
    run.id = run.startedAt.replace(/[:.]/g, '-');
    run.endedAt = null;
    run.selection = entries.map(entry => entry.name);
    run.commands = [];
    run.log = [];
    cancelled = false;
    broadcast();

    for (const entry of entries) {
      if (cancelled) break;
      const started = Date.now();
      const beforeResults = snapshotResultFiles();
      const datasets = dependencyState(entry.datasetDependencies || []);
      const record = { name: entry.name, group: entry.group || 'other', kind: entry.kind || 'command', status: 'running', reason: '', datasets, startedAt: new Date().toISOString(), durationMs: 0, results: [], log: [], children: [] };
      run.commands.push(record);
      activeRecord = record;
      run.active = entry.name;
      appendLog(`\n> ${entry.display || `${entry.command} ${entry.args.join(' ')}`}`);
      broadcast();
      const exitCode = await new Promise(resolveExit => {
        try {
          activeChild = spawn(entry.command, entry.args, {
            cwd: toolsDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, WEBSMLM_TEST_NO_OPEN: '1' },
          });
        } catch (error) {
          appendLog(error.message);
          resolveExit(-1);
          return;
        }
        activeChild.stdout.on('data', appendLog);
        activeChild.stderr.on('data', appendLog);
        activeChild.on('error', error => { appendLog(error.message); resolveExit(-1); });
        activeChild.on('close', code => resolveExit(code ?? -1));
      });
      activeChild = null;
      record.durationMs = Date.now() - started;
      record.exitCode = exitCode;
      record.status = commandStatus(exitCode, record.log.join('\n'), cancelled);
      record.reason = commandReason(record.status, record.log, record.datasets);
      const changedResults = changedResultFiles(beforeResults);
      record.children = entry.suite ? suiteChildren(changedResults) : [];
      record.results = snapshotMutableArtifacts(changedResults, run.id, entry.name);
      activeRecord = null;
      broadcast();
      if (exitCode !== 0 || cancelled) break;
    }

    run.busy = false;
    run.active = null;
    run.endedAt = new Date().toISOString();
    const completed = {
      id: run.id,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: new Date(run.endedAt) - new Date(run.startedAt),
      selection: [...run.selection],
      commands: structuredClone(run.commands),
      summary: summarizeCommands(run.commands),
    };
    runs = [completed, ...runs.filter(saved => saved.id !== completed.id)].slice(0, MAX_SAVED_RUNS);
    writeRunHistory(runs);
    await refreshDiagnostics();
    broadcast();
  };

  const startQueue = entries => {
    if (run.busy) throw Object.assign(new Error('A command is already running.'), { status: 409 });
    void runQueue(entries);
  };

  const authorize = request => request.headers['x-dashboard-token'] === token;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(dashboardPath, 'utf8').replace('__DASHBOARD_TOKEN__', token);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'",
        });
        return response.end(html);
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, snapshot());
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (url.searchParams.get('token') !== token) return sendJson(response, 403, { error: 'Invalid dashboard token.' });
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        clients.add(response);
        response.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/result') {
        if (!authorize(request)) return sendJson(response, 403, { error: 'Invalid dashboard token.' });
        const file = url.searchParams.get('file') || '';
        if (basename(file) !== file || !file.endsWith('.json')) return sendJson(response, 400, { error: 'Invalid result path.' });
        const path = join(resultsDir, file);
        if (!existsSync(path)) return sendJson(response, 404, { error: 'Result not found.' });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(readFileSync(path));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/reports/')) {
        const file = decodeURIComponent(url.pathname.slice('/reports/'.length));
        if (basename(file) !== file || !file.endsWith('.html')) return sendJson(response, 400, { error: 'Invalid report path.' });
        const path = join(resultsDir, file);
        if (!existsSync(path)) return sendJson(response, 404, { error: 'Report not found.' });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(readFileSync(path));
      }
      if (request.method === 'POST') {
        if (!authorize(request)) return sendJson(response, 403, { error: 'Invalid dashboard token.' });
        const body = await readBody(request);
        if (url.pathname === '/api/run') {
          const names = [...new Set(Array.isArray(body.scripts) ? body.scripts : [])];
          if (!names.length || names.some(name => !scriptsByName.has(name))) return sendJson(response, 400, { error: 'Select one or more available scripts.' });
          const conflict = selectionConflict(names);
          if (conflict) return sendJson(response, 400, { error: conflict });
          const entries = names.map(name => ({
            name,
            group: scriptsByName.get(name).group,
            kind: scriptsByName.get(name).kind,
            suite: scriptsByName.get(name).kind === 'suite',
            datasetDependencies: scriptsByName.get(name).datasetDependencies,
            ...packageCommand(name),
            display: `npm run ${name}`,
          }));
          startQueue(entries);
          return sendJson(response, 202, { ok: true });
        }
        if (url.pathname === '/api/setup') {
          if (body.kind === 'javascript') startQueue([{ name: 'setup:javascript', group: 'setup', kind: 'setup', ...installCommand(), display: 'install JavaScript and Playwright requirements' }]);
          else if (body.kind === 'validation') {
            if (!diagnostics.items.find(item => item.id === 'python')?.ok) return sendJson(response, 409, { error: 'Python is not installed or is not on PATH.' });
            startQueue([{ name: 'setup:validation', group: 'setup', kind: 'setup', ...packageCommand('validation:setup'), display: 'npm run validation:setup' }]);
          } else return sendJson(response, 400, { error: 'Unknown setup action.' });
          return sendJson(response, 202, { ok: true });
        }
        if (url.pathname === '/api/download') {
          const dataset = DATASETS[body.key];
          if (!dataset?.download) return sendJson(response, 400, { error: 'Dataset is not downloadable.' });
          const named = `data:download:${body.key}`;
          const entry = packageJson.scripts[named]
            ? { name: named, group: 'datasets', kind: 'download', ...packageCommand(named), display: `npm run ${named}` }
            : { name: named, group: 'datasets', kind: 'download', command: process.execPath, args: [join(__dirname, 'data', 'download.mjs'), body.key], display: `download ${body.key}` };
          startQueue([entry]);
          return sendJson(response, 202, { ok: true });
        }
        if (url.pathname === '/api/diagnostics') {
          if (diagnostics.busy) return sendJson(response, 409, { error: 'Diagnostics are already running.' });
          void refreshDiagnostics();
          return sendJson(response, 202, { ok: true });
        }
        if (url.pathname === '/api/gpu-probe') {
          if (run.busy) return sendJson(response, 409, { error: 'Wait for the active command to finish.' });
          gpuDiagnostic = { ok: null, detail: 'Checking...' };
          broadcast();
          void (async () => {
            let browser;
            try {
              const { launchPage, checkGpu } = await import('./lib/launch.mjs');
              const launched = await launchPage({ headless: true });
              browser = launched.browser;
              const gpu = await checkGpu(launched.page);
              gpuDiagnostic = { ok: Boolean(gpu.available), detail: gpu.available ? 'WebGPU available in the test browser' : 'WebGPU unavailable in the test browser', limits: gpu.limits };
            } catch (error) {
              gpuDiagnostic = { ok: false, detail: error.message };
            } finally {
              await browser?.close();
              broadcast();
            }
          })();
          return sendJson(response, 202, { ok: true });
        }
        if (url.pathname === '/api/cancel') {
          if (!run.busy || !activeChild) return sendJson(response, 409, { error: 'No command is running.' });
          cancelled = true;
          if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(activeChild.pid), '/t', '/f'], { windowsHide: true });
          else activeChild.kill('SIGTERM');
          return sendJson(response, 202, { ok: true });
        }
      }
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      return sendJson(response, error.status || 400, { error: error.message });
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  void refreshDiagnostics();
  if (open) openInBrowser(url);
  return {
    url,
    token,
    close: async () => {
      cancelled = true;
      activeChild?.kill();
      for (const client of clients) client.end();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7)) || 0;
  const dashboard = await startDashboardServer({ port, open: !process.argv.includes('--no-open') });
  console.log(`webSMLM test dashboard: ${dashboard.url}`);
}
