import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, card, statusPill, sectionTable, ms, speed, number, REPORT_CSS } from './report-html.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');
export const defaultResultsDir = join(repoRoot, 'tests', 'results');

export function writeGpuReport({ run, resultFiles = [], resultsDir = defaultResultsDir }) {
  mkdirSync(resultsDir, { recursive: true });
  const parsed = resultFiles.map(readResultFile);
  const latestPath = join(resultsDir, 'gpu-latest.json');
  const reportPath = join(resultsDir, 'gpu-report.html');
  const latest = {
    ...run,
    generatedAt: new Date().toISOString(),
    resultFiles: parsed.map(file => ({
      path: file.path,
      name: file.name,
      ok: !file.error,
      error: file.error || undefined,
    })),
    summary: summarizeRun(run, parsed),
  };
  const html = renderGpuReport(latest, parsed);
  writeFileSync(latestPath, JSON.stringify(latest, null, 2));
  writeFileSync(reportPath, html);
  return { latestPath, reportPath, latest, html };
}

export function readResultFile(file) {
  const path = String(file);
  const name = relative(repoRoot, path).replaceAll('\\', '/');
  try {
    return { path, name, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { path, name, data: null, error: err.message };
  }
}

export function summarizeRun(run, files) {
  const commands = Array.isArray(run.commands) ? run.commands : [];
  const count = status => commands.filter(cmd => cmd.status === status).length;
  const gpuSource = files.map(file => file.data).find(data => data && data.gpu);
  return {
    totalCommands: commands.length,
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skip'),
    resultFiles: files.length,
    gpuAvailable: gpuSource && gpuSource.gpu ? gpuSource.gpu.available : null,
  };
}

function renderGpuReport(latest, files) {
  const run = latest;
  const summary = latest.summary || {};
  const ended = run.endedAt || run.startedAt || run.generatedAt;
  const latestLocal = ended ? new Date(ended).toLocaleString() : 'unknown';
  const parsedOk = files.filter(file => !file.error);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>webSMLM test run report</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Test run report</h1>
        <p><strong>Latest update:</strong> ${escapeHtml(latestLocal)} · <code>${escapeHtml(ended || 'unknown')}</code></p>
        <p><strong>Run window:</strong> <code>${escapeHtml(run.startedAt || 'unknown')}</code> → <code>${escapeHtml(run.endedAt || 'unknown')}</code></p>
      </div>
      <p>Generated from this run only; stale older JSON files are ignored.</p>
    </header>
    <section class="cards" aria-label="Run summary">
      ${card('Duration', ms(run.durationMs))}
      ${card('Commands', summary.totalCommands ?? 0)}
        ${card('Passed', summary.passed ?? 0)}
        ${card('Failed', summary.failed ?? 0)}
        ${summary.gpuAvailable === null ? '' : card('Graphics processor', summary.gpuAvailable ? 'available' : 'unavailable')}
    </section>
      <section><h2>How to read these results</h2><div class="panel empty">
        <strong>Central processing unit (CPU)</strong> is the software path. <strong>Graphics processing unit (GPU)</strong> is the accelerated path.
        Speedup is CPU time divided by GPU time, so a value above 1 means the GPU was faster. Wall time is the complete elapsed time for a run.
      </div></section>
    ${commandsTable(run.commands || [])}
    ${fitTable(parsedOk)}
    ${renderTable(parsedOk)}
    ${frcTable(parsedOk)}
    ${simulationTable(parsedOk)}
      ${truthTable(parsedOk)}
    ${realDataTable(parsedOk)}
    ${stageTable(parsedOk)}
    ${rawSection(files)}
  </main>
</body>
</html>`;
}

function commandsTable(commands) {
    return sectionTable('Commands', ['Command', 'Script and arguments', 'Status', 'Exit code', 'Duration', 'Result file'], commands.map(cmd => [
    escapeHtml(cmd.name || ''),
    escapeHtml([cmd.script, ...(cmd.args || [])].filter(Boolean).join(' ')),
    statusPill(cmd.status),
    String(cmd.exitCode ?? ''),
    ms(cmd.durationMs),
    (cmd.resultFiles || []).map(file => `<code>${escapeHtml(relative(repoRoot, file).replaceAll('\\', '/'))}</code>`).join('<br>') || '-',
  ]));
}

function fitTable(files) {
  const rows = [];
  for (const file of files) {
    for (const c of cases(file.data)) {
      if (c.cpuFitMs == null && c.gpuFitMs == null) continue;
      rows.push([
        escapeHtml(file.name),
        escapeHtml(c.label || ''),
        pathPill(c.path),
        escapeHtml(c.reason || ''),
        ms(c.cpuFitMs),
        ms(c.gpuFitMs),
        speed(c.speedup),
        number(c.acceptDiscord ?? c.acceptanceDiscordance),
        number(c.posP99),
        number(c.maxDx),
        escapeHtml(c.verdict || ''),
      ]);
    }
  }
    return rows.length ? sectionTable('Localization fitting: CPU compared with GPU', ['Result file', 'Case', 'Execution path', 'Path reason', 'CPU fit time (ms)', 'GPU fit time (ms)', 'Speedup', 'Acceptance disagreement', '99th-percentile position difference', 'Maximum x-position difference', 'Verdict'], rows) : '';
}

function renderTable(files) {
  const rows = [];
  for (const file of files) {
    for (const c of cases(file.data)) {
      if (c.cpuMs == null && c.gpuMs == null) continue;
      rows.push([
        escapeHtml(file.name),
        escapeHtml(c.label || c.mode || ''),
        escapeHtml(c.mode || ''),
        ms(c.cpuMs),
        ms(c.gpuMs),
        speed(c.speedup),
        number(c.massRelError),
        number(c.maxByteDiff),
        escapeHtml(c.correct == null ? '' : String(c.correct)),
        escapeHtml(c.verdict || ''),
      ]);
    }
  }
    return rows.length ? sectionTable('Rendering: CPU compared with GPU', ['Result file', 'Case', 'Mode', 'CPU time (ms)', 'GPU time (ms)', 'Speedup', 'Relative mass error', 'Maximum byte difference', 'Correct', 'Verdict'], rows) : '';
}

function frcTable(files) {
  const rows = [];
  for (const file of files) {
    const dataRows = Array.isArray(file.data.rows) ? file.data.rows : [];
    for (const r of dataRows) {
      if (r.cpuMedian == null && r.gpuMedian == null) continue;
      rows.push([
        escapeHtml(file.name),
        escapeHtml(r.N ?? ''),
        ms(r.cpuMedian),
        ms(r.gpuMedian),
        speed(r.speedup),
        escapeHtml(r.pass == null ? '' : String(r.pass)),
      ]);
    }
  }
    return rows.length ? sectionTable('Fourier ring correlation: CPU compared with GPU', ['Result file', 'Fourier transform size', 'Median CPU time (ms)', 'Median GPU time (ms)', 'Speedup', 'Passed'], rows) : '';
}

// bench-simulation.mjs: each row times the splat+noise stage of a movie or calibration stack.
function simulationTable(files) {
  const rows = [];
  for (const file of files) {
    const dataRows = Array.isArray(file.data.simCases) ? file.data.simCases : [];
    for (const r of dataRows) rows.push([
      escapeHtml(file.name),
      escapeHtml(r.label || ''),
      ms(r.cpuMs),
      ms(r.gpuMs),
      ms(r.gpuColdMs),
      speed(r.speedup),
      escapeHtml(r.gpuPath || ''),
    ]);
  }
    return rows.length ? sectionTable('Simulation: CPU compared with GPU', ['Result file', 'Case', 'CPU time (ms)', 'Warm GPU time (ms)', 'Cold GPU time (ms)', 'Speedup', 'GPU execution path'], rows) : '';
}

function truthTable(files) {
  const rows = [];
  for (const file of files) {
    for (const r of Array.isArray(file.data.rows) ? file.data.rows : []) {
      if (r.n_gt_events == null || r.jaccard == null) continue;
      rows.push([
        escapeHtml(file.name), escapeHtml(r.cell_id || ''), escapeHtml(r.status || ''),
        escapeHtml(r.tier2 === 'REGRESSED' ? 'Changed beyond tolerance' : (r.tier2 || '')),
        escapeHtml(r.sim_seed ?? ''), escapeHtml(r.structure || ''),
        escapeHtml(r.engine || ''), escapeHtml(r.frames ?? ''), escapeHtml(r.n_gt_events), escapeHtml(r.n_locs ?? ''),
        escapeHtml(r.tp ?? ''), escapeHtml(r.fp ?? ''), escapeHtml(r.fn ?? ''), number(r.jaccard), number(r.precision),
        number(r.recall), number(r.rmse_lat_nm), number(r.rmse_z_nm), escapeHtml(r.method || ''), number(r.psf_px),
        escapeHtml(r.winr ?? ''), number(r.det_thr), ms(r.fit_ms), escapeHtml(r.locs_per_s ?? ''),
      ]);
    }
  }
  return rows.length ? sectionTable('Known-ground-truth simulation accuracy', [
    'Result file', 'Simulation regime', 'Scientific status', 'Baseline comparison', 'Random seed', 'Structure', 'Execution path', 'Frames', 'Ground-truth events',
    'Reported localizations', 'True-positive matches', 'False-positive localizations', 'Missed ground-truth events',
    'Jaccard overlap score', 'Precision', 'Recall', 'Lateral root mean square error (nm)', 'Axial root mean square error (nm)',
    'Fit method', 'Point-spread-function width (pixels)', 'Fit radius (pixels)', 'Detection threshold', 'Fit time (ms)',
    'Localizations per second',
  ], rows) : '';
}

function realDataTable(files) {
  const rows = [];
  for (const file of files) {
    const d = file.data;
    if (!d || (d.cpuRunMs == null && d.gpuRunMs == null && d.wallSpeedup == null)) continue;
    rows.push([
      escapeHtml(file.name),
      escapeHtml(d.full ? 'full' : 'standard'),
      ms(d.cpuRunMs),
      ms(d.gpuRunMs),
      speed(d.wallSpeedup),
      escapeHtml(d.cpuLocs ?? d.nCpu ?? ''),
      escapeHtml(d.gpuLocs ?? d.nGpu ?? ''),
      escapeHtml(d.nCandidates ?? ''),
      escapeHtml(d.verdict || ''),
    ]);
  }
    return rows.length ? sectionTable('Real-data elapsed time', ['Result file', 'Run size', 'CPU wall time (ms)', 'GPU wall time (ms)', 'Wall-time speedup', 'CPU localizations', 'GPU localizations', 'Candidate detections', 'Verdict'], rows) : '';
}

function stageTable(files) {
  const rows = [];
  for (const file of files) {
    for (const r of Array.isArray(file.data.rows) ? file.data.rows : []) {
      if (!r.stage) continue;
      rows.push([
        escapeHtml(file.name),
        escapeHtml(r.stage),
        ms(r.cpuMs),
        ms(r.gpuMs),
        speed(r.sp ?? r.speedup),
        escapeHtml(r.note || ''),
      ]);
    }
    const stages = file.data.execution && file.data.execution.stages;
    if (stages) {
      for (const [name, s] of Object.entries(stages)) {
        rows.push([
          escapeHtml(file.name),
          escapeHtml(name),
          escapeHtml(s.cpuCalls ?? ''),
          escapeHtml(s.gpuCalls ?? ''),
          escapeHtml(s.fallbackCalls ?? ''),
          escapeHtml([s.path, ...(s.reasons || [])].filter(Boolean).join(' · ')),
        ]);
      }
    }
  }
    return rows.length ? sectionTable('Processing-stage execution', ['Result file', 'Stage', 'CPU time or calls', 'GPU time or calls', 'Fallback calls or speedup', 'Path or reason'], rows) : '';
}

function rawSection(files) {
  const body = files.map(file => `<details>
    <summary>${escapeHtml(file.name)} ${file.error ? statusPill('fail') : statusPill('pass')}</summary>
    <pre>${escapeHtml(file.error ? file.error : JSON.stringify(file.data, null, 2))}</pre>
  </details>`).join('');
  return `<section><h2>Raw JSON</h2>${body || '<div class="panel empty">No result JSON files were generated.</div>'}</section>`;
}

function cases(data) {
  return data && Array.isArray(data.cases) ? data.cases : [];
}

function pathPill(path) {
  if (!path) return '';
  return `<span class="pill ${path === 'gpu' ? 'gpu' : path === 'cpu' ? 'cpu' : ''}">${escapeHtml(path)}</span>`;
}

if (!existsSync(repoRoot)) {
  throw new Error(`repoRoot does not exist: ${repoRoot}`);
}
