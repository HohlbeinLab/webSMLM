import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  <title>webSMLM GPU latest report</title>
  <style>
    :root{color-scheme:light;--bg:#f6f7fb;--panel:#fff;--ink:#17202a;--muted:#607086;--line:#d8deea;--ok:#157347;--bad:#b42318;--skip:#946200;--gpu:#148f6a;--cpu:#315f8a;--soft:#edf6ff;--shadow:rgba(23,32,42,.08)}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:1280px;margin:0 auto;padding:28px}
    header{display:flex;gap:18px;align-items:end;justify-content:space-between;margin-bottom:18px}
    h1{margin:0 0 6px;font-size:clamp(28px,4vw,44px);line-height:1.05;letter-spacing:-.04em}
    h2{margin:24px 0 10px;font-size:20px;letter-spacing:-.02em}
    p{margin:0;color:var(--muted)}
    code{background:#eef2f7;border-radius:6px;padding:1px 5px}
    .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:18px 0}
    .card,.panel,details{border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 12px 40px var(--shadow)}
    .card{padding:14px}.metric{font-size:28px;font-weight:760;letter-spacing:-.04em}.label{color:var(--muted);font-size:12px}
    .panel{overflow:hidden}.table-wrap{overflow:auto}
    table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:#f9fbff}tr:last-child td{border-bottom:0}
    .pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;background:#eef1f5;color:var(--muted)}
    .pass{background:#e5f6ed;color:var(--ok)}.fail{background:#fdeceb;color:var(--bad)}.skip{background:#fff4d8;color:var(--skip)}.gpu{background:#ddf7ee;color:var(--gpu)}.cpu{background:#e7f0fb;color:var(--cpu)}
    details{margin:10px 0;padding:12px 14px}summary{cursor:pointer;font-weight:700}pre{max-height:460px;overflow:auto;padding:12px;border-radius:12px;background:#111827;color:#e5e7eb;font-size:12px;white-space:pre-wrap}
    .empty{padding:16px;color:var(--muted)}
    @media(max-width:900px){main{padding:18px}header{display:block}.cards{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>GPU latest report</h1>
        <p><strong>Latest update:</strong> ${escapeHtml(latestLocal)} · <code>${escapeHtml(ended || 'unknown')}</code></p>
        <p><strong>Run window:</strong> <code>${escapeHtml(run.startedAt || 'unknown')}</code> → <code>${escapeHtml(run.endedAt || 'unknown')}</code></p>
      </div>
      <p>Generated from this run only; stale older JSON files are ignored.</p>
    </header>
    <section class="cards" aria-label="Run summary">
      ${card('Duration', ms(run.durationMs))}
      ${card('Commands', summary.totalCommands ?? 0)}
      ${card('Pass', summary.passed ?? 0)}
      ${card('Fail', summary.failed ?? 0)}
      ${card('GPU', summary.gpuAvailable === null ? 'unknown' : (summary.gpuAvailable ? 'available' : 'unavailable'))}
    </section>
    ${commandsTable(run.commands || [])}
    ${fitTable(parsedOk)}
    ${renderTable(parsedOk)}
    ${frcTable(parsedOk)}
    ${realDataTable(parsedOk)}
    ${stageTable(parsedOk)}
    ${rawSection(files)}
  </main>
</body>
</html>`;
}

function commandsTable(commands) {
  return sectionTable('Commands', ['Command', 'Script', 'Status', 'Exit', 'Duration', 'Result JSON'], commands.map(cmd => [
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
  return sectionTable('Fit CPU vs GPU', ['Source', 'Case', 'Path', 'Reason', 'CPU fit ms', 'GPU fit ms', 'Speedup', 'Accept discord', 'pos p99', 'max dx', 'Verdict'], rows);
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
  return sectionTable('Render CPU vs GPU', ['Source', 'Case', 'Mode', 'CPU ms', 'GPU ms', 'Speedup', 'Mass err', 'Max byte diff', 'Correct', 'Verdict'], rows);
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
  return sectionTable('FRC CPU vs GPU', ['Source', 'FFT N', 'CPU median', 'GPU median', 'Speedup', 'Pass'], rows);
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
  return sectionTable('Real data wall time', ['Source', 'Run', 'CPU wall', 'GPU wall', 'Wall speedup', 'CPU locs', 'GPU locs', 'Candidates', 'Verdict'], rows);
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
  return sectionTable('Stage execution', ['Source', 'Stage', 'CPU', 'GPU', 'Fallback / speedup', 'Reason'], rows);
}

function rawSection(files) {
  const body = files.map(file => `<details>
    <summary>${escapeHtml(file.name)} ${file.error ? statusPill('fail') : statusPill('pass')}</summary>
    <pre>${escapeHtml(file.error ? file.error : JSON.stringify(file.data, null, 2))}</pre>
  </details>`).join('');
  return `<section><h2>Raw JSON</h2>${body || '<div class="panel empty">No result JSON files were generated.</div>'}</section>`;
}

function sectionTable(title, headers, rows) {
  const body = rows.length
    ? `<div class="panel table-wrap"><table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="panel empty">No rows for this run.</div>';
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function cases(data) {
  return data && Array.isArray(data.cases) ? data.cases : [];
}

function card(label, value) {
  return `<div class="card"><div class="metric">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function statusPill(status) {
  const safe = escapeHtml(status || 'unknown');
  const cls = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : status === 'skip' ? 'skip' : '';
  return `<span class="pill ${cls}">${safe}</span>`;
}

function pathPill(path) {
  if (!path) return '';
  return `<span class="pill ${path === 'gpu' ? 'gpu' : path === 'cpu' ? 'cpu' : ''}">${escapeHtml(path)}</span>`;
}

function ms(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString()} ms` : '-';
}

function speed(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}x` : '-';
}

function number(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

if (!existsSync(repoRoot)) {
  throw new Error(`repoRoot does not exist: ${repoRoot}`);
}
