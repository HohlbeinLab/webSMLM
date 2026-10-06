// HTML report renderer for the webSMLM-vs-Picasso cross-validation harness
// (tests/validation/) -- sibling to gpu-report.mjs, sharing its page chrome/
// table primitives via report-html.mjs but with its own domain-specific
// tables (Jaccard/RMSE/Bland-Altman rather than CPU-vs-GPU speed) and its
// own output files (picasso-latest.json / picasso-report.html), so this
// never touches gpu-report.mjs's own 5 tables or the 23 existing GPU tests
// that assert against them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, statusPill, sectionTable, diffTable, diffCell, valueCell, ms, number, REPORT_CSS } from './report-html.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');
export const defaultResultsDir = join(repoRoot, 'tests', 'results');

export function buildCrossValidationResult(truth, comparison, toolResults) {
  return {
    truth: { ...truth, tiffBuffer: undefined },
    parameters: {
      webSMLM: toolResults.webSMLM?.parameters ?? null,
      picasso: toolResults.picasso?.parameters ?? null,
    },
    ...comparison,
  };
}

export function writeCrossReport({ run, resultFiles = [], resultsDir = defaultResultsDir }) {
  mkdirSync(resultsDir, { recursive: true });
  const parsed = resultFiles.map(readResultFile);
  const latestPath = join(resultsDir, 'picasso-latest.json');
  const reportPath = join(resultsDir, 'picasso-report.html');
  const latest = {
    ...run,
    generatedAt: new Date().toISOString(),
    resultFiles: parsed.map(file => ({ path: file.path, name: file.name, ok: !file.error, error: file.error || undefined })),
    summary: summarizeRun(run, parsed),
  };
  const html = renderCrossReport(latest, parsed, resultsDir);
  writeFileSync(latestPath, JSON.stringify(latest, null, 2));
  writeFileSync(reportPath, html);
  return { latestPath, reportPath, latest, html };
}

export function readResultFile(file) {
  const path = String(file);
  const name = relative(repoRoot, path).replaceAll('\\', '/');
  try { return { path, name, data: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (err) { return { path, name, data: null, error: err.message }; }
}

export function summarizeRun(run, files) {
  const commands = Array.isArray(run.commands) ? run.commands : [];
  const count = status => commands.filter(cmd => cmd.status === status).length;
  const picassoSkipped = files.some(f => f.data?.tools?.picasso?.skipped);
  return { totalCommands: commands.length, passed: count('pass'), failed: count('fail'), skipped: count('skip'), resultFiles: files.length, picassoAvailable: picassoSkipped ? false : (files.length ? true : null) };
}

function nm(v) { return v == null ? '-' : `${number(v)} nm`; }

function runMatrixTable(files) {
  const rows = [];
  for (const file of files) {
    const parameters = file.data?.parameters;
    if (!parameters) continue;
    for (const [tool, p] of Object.entries(parameters)) {
      if (!p) continue;
      const dimensions = [];
        if (p.psfSigmaPx != null) dimensions.push(`Point-spread-function sigma ${number(p.psfSigmaPx)} pixels`);
        if (p.boxSidePx != null) dimensions.push(`fit box ${number(p.boxSidePx)} pixels`);
      const detection = p.detection
        ? `${p.detection.method}: ${number(p.detection.threshold)}${p.detection.unit ? ` ${p.detection.unit}` : ''}`
        : '-';
      rows.push([
        escapeHtml(file.name), escapeHtml(tool), statusPill(file.data?.tools?.[tool]?.skipped ? 'skip' : 'pass'),
        escapeHtml(p.fitMethod ?? '-'), nm(p.pixelSizeNm), escapeHtml(number(p.gainPhotonsPerADU)),
        escapeHtml(number(p.offsetADU)), escapeHtml(dimensions.join('; ') || '-'), escapeHtml(detection),
        escapeHtml(number(p.frames)), escapeHtml(number(p.emitters)), escapeHtml(p.gpuMode ?? '-'),
      ]);
    }
  }
  return sectionTable('Parameters used for each tool', ['Result file', 'Tool', 'Status', 'Fit method', 'Pixel size', 'Gain (photons per analog-to-digital unit)', 'Camera offset (analog-to-digital units)', 'Point-spread function and fit box', 'Detection method and threshold', 'Frames', 'Ground-truth emitters', 'Processing mode'], rows);
}

// Tool-vs-tool rows: [metric key, digits]. Numbers come from the app scorer's result (t.score);
// older result files carried them on the tool itself.
const TOOL_ROWS = [
  ['jaccard', 'Jaccard overlap score', 3],
  ['precision', 'Precision (reported localizations that match truth)', 3],
  ['recall', 'Recall (counted truth events that were found)', 3],
  ['rmse_lat_nm', 'Lateral root mean square error (nm)', 1],
  ['med_lat_nm', 'Median lateral error (nm)', 1],
  ['rmse_z_nm', 'Axial root mean square error (nm)', 1],
  ['tp', 'True-positive matches', 0],
  ['fp', 'False-positive localizations', 0],
  ['fn', 'Missed ground-truth events', 0],
  ['runtime_s', 'Runtime (seconds)', 1],
];

function toolMetrics(t) {
  if (!t || t.skipped) return null;
  const s = t.score || t;
  return {
    jaccard: s.jaccard ?? t.jaccardCI?.point, precision: s.precision, recall: s.recall,
    rmse_lat_nm: s.rmseLat ?? t.rmseXYCI?.point, med_lat_nm: s.medLat, rmse_z_nm: s.rmseZ,
    tp: s.tp, fp: s.fp, fn: s.fn, runtime_s: t.wallMs == null ? null : t.wallMs / 1000,
  };
}

function toolComparison(d) {
  const A = toolMetrics(d.tools?.webSMLM), B = toolMetrics(d.tools?.picasso);
  const tally = { better: 0, worse: 0, same: 0 };
  const rows = [];
  for (const [key, label, digits] of TOOL_ROWS) {
    const va = A?.[key], vb = B?.[key];
    if (va == null && vb == null && key !== 'jaccard') continue; // 2D runs: no z row
    const out = {};
    const delta = diffCell(key, va, vb, { out });
    if (out.verdict) tally[out.verdict]++;
    rows.push([escapeHtml(label), valueCell(va, digits), valueCell(vb, digits), delta]);
  }
  const skipped = ['webSMLM', 'picasso'].filter(t => d.tools?.[t]?.skipped);
  const n = tally.better + tally.worse + tally.same;
  const verdict = skipped.length
    ? `${escapeHtml(skipped.join(' and '))} skipped (${escapeHtml(d.tools[skipped[0]].reason || 'not available')}): no comparison.`
    : `Against the same reference, webSMLM is better on ${tally.better}, worse on ${tally.worse}, and within tolerance on ${tally.same} of ${n} comparable measurements.`;
  const c = d.ceiling;
  const ceiling = c && c.fraction != null
    ? `Detection ceiling: ${(c.fraction * 100).toFixed(1)}% of emitter-frames (${c.coincident}/${c.emitterFrames}) have another emitter within ${number(c.radiusPx)} pixels, so the Jaccard, precision, and recall scores cannot reach 1 for either tool.`
    : '';
  const table = diffTable({
    title: 'Accuracy and performance against the same reference', headers: ['Measurement', 'webSMLM', 'Picasso', 'Difference (webSMLM minus Picasso)'], rows,
    note: [ceiling, 'The difference is webSMLM minus Picasso. Scores bounded from 0 to 1 use direct units; distances, counts, and runtime use signed percent. Each value is labelled better, worse, or within tolerance. Not comparable means one or both tools did not produce that measurement.'].filter(Boolean).join('<br>'),
  });
  return { verdict, table };
}

function tuningLine(d) {
  const t = d.provenance?.tuning;
  if (!t) return '';
  const one = (name, x) => x ? `${name} <code>${escapeHtml(x.param)} = ${escapeHtml(number(x.best))}</code> (best of ${Array.isArray(x.sweep) ? x.sweep.length : '?'} tried)` : '';
  return `<p class="sub">Tuning (${escapeHtml(t.regime || 'each tool swept')}): ${[one('webSMLM', t.webSMLM), one('Picasso', t.picasso)].filter(Boolean).join(' &middot; ')}</p>`;
}

function crossCheckLine(d) {
  const cc = d.tools?.webSMLM?.crossCheck;
  if (!cc) return '';
  if (cc.allEqual) return `<p class="sub">Scorer cross-check: the app's own <code>analyze({scoreVsTruth})</code> equals the harness scorer on ${cc.nEqual}/${cc.nCompared} fields.</p>`;
  const bad = Object.entries(cc.fields || {}).filter(([, v]) => !v.equal).map(([k]) => k);
  return `<p class="sub"><span class="dn">Scorer cross-check DISAGREES</span> on ${cc.nCompared - cc.nEqual}/${cc.nCompared} fields: ${escapeHtml(bad.join(', '))}</p>`;
}

function agreementTable(d) {
  const ct = d.crossTool;
  if (!ct) return '';
  const rows = ['x', 'y', 'photons'].filter(f => ct[f]?.n).map(f => {
    const q = ct[f], u = f === 'photons' ? '' : ' nm', number = v => (+v).toFixed(2);
    const label = { x: 'X position', y: 'Y position', photons: 'Photon count' }[f] || f;
    return [label, String(q.n), `${number(q.bias)}${u}`, `${number(q.sd)}${u}`, `[${number(q.loaLo)}, ${number(q.loaHi)}]${u}`];
  });
  return diffTable({
    title: 'Agreement between tools for matched localizations',
    headers: ['Measurement', 'Matched localization pairs', 'Mean difference (Picasso minus webSMLM)', 'Standard deviation of differences', '95% agreement interval'],
    rows,
    note: 'These are agreement measurements, not ground-truth accuracy. A mean difference near zero indicates little systematic offset; a narrower 95% agreement interval indicates closer pairwise agreement.',
  });
}

function explanation(d) {
  const knownTruth = Boolean(d.truthSource);
  const source = escapeHtml(d.truthSource || (d.dataset ? `${d.dataset} dataset ground truth` : 'synthetic ground truth'));
  return `<section><h2>How to read these results</h2><div class="panel empty" style="text-align:left">
    <p><strong>Evidence:</strong> ${knownTruth ? source : 'Cross-tool agreement only; no ground truth was available.'}</p>
    <p><strong>Accuracy:</strong> precision, recall, overlap, and localization error compare each tool independently with the same known answer.</p>
    <p><strong>Agreement:</strong> matched-pair differences show whether the tools return similar coordinates and photon estimates. Agreement alone does not prove either tool is correct.</p>
    <p><strong>Runtime:</strong> elapsed wall-clock time is reported separately from scientific accuracy.</p>
    <p><strong>Real-time scope:</strong> Picasso is an offline analysis tool. Live latency and throughput are measured separately by the webSMLM livestream benchmarks, so they are not presented as a cross-tool comparison.</p>
    ${d.limitations?.length ? `<p><strong>Limitations:</strong> ${escapeHtml(d.limitations.join(' '))}</p>` : ''}
  </div></section>`;
}

function provenanceDetails(file) {
  const d = file.data;
  const pv = d.provenance || {};
  const facts = [
    ['Ground-truth source', d.truthSource], ['Matching radius', d.matchRadiusNm != null ? `${d.matchRadiusNm} nm` : null],
    ['Scoring implementation', d.scorer], ['Drift handling', pv.drift ? JSON.stringify(pv.drift) : null],
    ['Simulation parameters', pv.simParams ? JSON.stringify(pv.simParams) : null],
  ].filter(([, v]) => v != null).map(([k, v]) => `<tr><td>${k}</td><td><code>${escapeHtml(v)}</code></td></tr>`).join('');
  return `<details><summary>Run provenance</summary><table>${facts}</table>${runMatrixTable([file])}</details>`;
}

function fileSection(file, resultsDir) {
  if (file.error) return `<section><h2>${escapeHtml(file.name)} ${statusPill('fail')}</h2><p class="sub">${escapeHtml(file.error)}</p></section>`;
  const d = file.data;
  const sp = d.provenance?.simParams;
  const structure = sp?.simulation_structureType === 'uniform3D' ? 'Uniform three-dimensional simulation' : sp?.simulation_structureType;
  const regime = sp ? [structure, sp.dens != null && `density ${sp.dens}`, sp.frames != null && `${sp.frames} frames`].filter(Boolean).join(', ') : '';
  const link = relative(resultsDir, file.path).replaceAll('\\', '/');
  const cmp = d.tools ? toolComparison(d) : null;
  return `<section>
    <h2>${escapeHtml(regime || file.name)} <span class="sub"><a href="${escapeHtml(link)}">${escapeHtml(file.name)}</a></span></h2>
    ${explanation(d)}
    ${cmp ? `<p class="verdict">${cmp.verdict}</p>${cmp.table}` : ''}
    ${tuningLine(d)}${crossCheckLine(d)}
    ${agreementTable(d)}
    ${provenanceDetails(file)}
  </section>`;
}

function commandsTable(commands) {
  return sectionTable('Commands', ['Command', 'Script and arguments', 'Status', 'Exit code', 'Duration', 'Result files'], commands.map(cmd => [
    escapeHtml(cmd.name || ''),
    escapeHtml([cmd.script, ...(cmd.args || [])].filter(Boolean).join(' ')),
    statusPill(cmd.status),
    String(cmd.exitCode ?? ''),
    ms(cmd.durationMs),
    (cmd.resultFiles || []).map(file => `<code>${escapeHtml(relative(repoRoot, file).replaceAll('\\', '/'))}</code>`).join('<br>') || '-',
  ]));
}

function renderCrossReport(latest, files, resultsDir = defaultResultsDir) {
  const run = latest;
  const summary = latest.summary || {};
  const ended = run.endedAt || run.startedAt || run.generatedAt;
  const failedCmds = (run.commands || []).filter(c => c.status !== 'pass');
  const picasso = summary.picassoAvailable === false ? ' Picasso is not installed.' : '';
  const verdict = `${summary.passed ?? 0}/${summary.totalCommands ?? 0} commands passed${failedCmds.length ? `, ${failedCmds.length} did not` : ''} in ${ms(run.durationMs)}.${picasso}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>webSMLM vs. Picasso -- latest report</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>webSMLM vs. Picasso</h1>
        <p><code>${escapeHtml(ended || 'unknown')}</code></p>
      </div>
    </header>
    <p class="verdict">${verdict}</p>
    ${files.map(f => fileSection(f, resultsDir)).join('')}
    <details><summary>Commands</summary>${commandsTable(run.commands || [])}</details>
  </main>
</body>
</html>`;
}

if (!existsSync(repoRoot)) {
  throw new Error(`repoRoot does not exist: ${repoRoot}`);
}
