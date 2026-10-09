// HTML report for the regime-matrix benchmark (tests/validation/bench-regime-matrix.mjs): one tool,
// many imaging regimes. Cells are rows, sorted by how far they moved from the baseline; every
// comparison goes through the shared diffCell()/diffTable() in report-html.mjs.
// CLI: node tests/lib/regime-report.mjs [result.json]   (default: newest regime-matrix-*.json)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeHtml, sectionTable, diffTable, diffCell, valueCell, sparkline, REPORT_CSS } from './report-html.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, '..', 'results');

export function newestRegimeResult(dir = resultsDir) {
  const f = readdirSync(dir).filter(n => /^regime-matrix-.*\.json$/.test(n)).sort().pop();
  return f ? join(dir, f) : null;
}

// Replicates of one cell collapse to the per-metric median (the baseline's own definition).
function mergeReps(rows) {
  const by = new Map();
  for (const r of rows) (by.get(r.cell_id) || by.set(r.cell_id, []).get(r.cell_id)).push(r);
  return [...by.values()].map(reps => {
    if (reps.length === 1) return reps[0];
    const out = { ...reps[0] };
    for (const k of Object.keys(out)) {
      const v = reps.map(r => r[k]).filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
      if (typeof out[k] === 'number' && v.length) out[k] = v[v.length >> 1];
    }
    const worst = ['error', 'fail', 'thin', 'new', 'ok'].find(s => reps.some(r => r.status === s));
    out.status = worst || out.status;
    return out;
  });
}

// Noise band for a baselined metric, in raw-delta units: the bench's own rule,
// max(3 x seed spread, floor), the floor being absolute or a fraction of the baseline.
function band(spec, b) {
  if (!spec || !b) return undefined;
  const floor = spec.kind === 'abs' ? spec.floor : Math.max(spec.floor, spec.rel * Math.abs(b.median));
  return Math.max(3 * (b.spread || 0), floor);
}

function loadBaseline(data) {
  const p = data.baseline_file;
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

const dash = '<span class="na">n/a</span>';
const crlbOk = r => r.crlb === 'ok';

function mainTable(rows, data, baseline) {
  const specs = data.baseline_metrics || {};
  const cols = [['jaccard', 3], ['rmse_lat_nm', 1], ['eff_e3d', 1]];
  const lines = rows.map(r => {
    const entry = baseline?.engines?.[r.engine]?.[r.cell_id];
    const comparable = entry && r.status !== 'thin' && r.status !== 'error';
    let rank = -1;
    const cells = [];
    for (const [m, d] of cols) {
      const b = comparable ? entry.metrics?.[m] : null;
      const out = {};
      const delta = diffCell(m, r[m], b?.median, { tol: band(specs[m], b), na: !b, out });
      if (out.ratio != null) rank = Math.max(rank, out.ratio);
      const val = m === 'jaccard' && r.jaccard != null
        ? `${valueCell(r[m], d)} <span class="sub">/ ${valueCell(r.jaccard_ceiling, 3)}</span>` : valueCell(r[m], d);
      cells.push(val, delta);
    }
    const st = r.status === 'fail' || r.status === 'thin' ? `<span class="pill ${r.status === 'fail' ? 'fail' : 'skip'}">${r.status}</span>` : '';
    const label = `<span${r.notes ? ` title="${escapeHtml(r.notes)}"` : ''}>${escapeHtml(r.cell_id)}</span>`;
    return { rank, row: [label, ...cells, valueCell(r.tp, 0), sparkline(data.detail?.[r.cell_id]?.rep0?.bins), st] };
  });
  lines.sort((a, b) => b.rank - a.rank); // stable: cells without a baseline keep run order at the end
  return diffTable({
    title: 'Regimes by movement from baseline',
    headers: ['cell', 'jaccard / ceiling', '&Delta;', 'rmse_lat_nm', '&Delta;', 'eff_e3d', '&Delta;', 'tp', 'recall vs z', ''],
    numeric: [1, 2, 3, 4, 5, 6, 7],
    rows: lines.map(l => l.row),
    note: 'Delta vs the baseline median: signed units for jaccard and eff_e3d, signed percent for rmse_lat_nm. &#9650; better, &#9660; worse, = inside the baseline noise band, n/a no baseline or too few matches (thin). Jaccard is bounded above by its ceiling (coincident emitters), which falls with density. Sparkline: recall across true z (axis 0 to 1).',
  });
}

function crlbTable(rows) {
  const ratio = (a, b) => (a != null && b != null && b > 0 ? a / b : null);
  const body = rows.map(r => {
    const ok = crlbOk(r);
    const rl = ok ? ratio(r.med_lat_nm, r.crlb_lat_nm) : null, rz = ok ? ratio(r.med_z_nm, r.crlb_z_nm) : null;
    const flag = rl != null && rl > 3 ? ' <span class="dn" title="above the tier-1 bound of 3 x CRLB">x</span>' : '';
    return [escapeHtml(r.cell_id), valueCell(ok ? r.med_lat_nm : null, 1), valueCell(ok ? r.crlb_lat_nm : null, 1),
      rl == null ? dash : `${rl.toFixed(2)}${flag}`,
      valueCell(ok ? r.med_z_nm : null, 0), valueCell(ok ? r.crlb_z_nm : null, 0), rz == null ? dash : rz.toFixed(2)];
  });
  return diffTable({
    title: 'Precision against the theoretical limit (no baseline needed)',
    headers: ['cell', 'med_lat nm', 'crlb', 'ratio', 'med_z nm', 'crlb_z', 'ratio'], rows: body,
    note: 'Ratio = measured median error / CRLB of the simulator\'s own image model. A red x marks a lateral ratio above 3, the tier-1 bound. n/a = CRLB unavailable for that cell or no matches.',
  });
}

function provenance(data, rows) {
  const keys = ['axis', 'dens', 'phot', 'simbg', 'z_range_nm', 'structure', 'psf_model', 'zernike_preset', 'camera_type', 'method', 'frames'];
  const facts = [
    ['run', data.run_id], ['commit', data.git_commit], ['app build', data.app_build], ['node', data.node_ver],
    ['engine', rows[0] ? `${rows[0].engine} (${rows[0].gpu_adapter})` : null], ['seeds', JSON.stringify(data.seeds)],
    ['baseline', data.baseline_file ? `${basename(data.baseline_file)} @ ${data.baseline_commit}` : 'none'],
    ['anchor', JSON.stringify(data.anchor)],
  ].filter(([, v]) => v != null).map(([k, v]) => `<tr><td>${k}</td><td><code>${escapeHtml(v)}</code></td></tr>`).join('');
  const params = sectionTable('Swept parameters', ['cell', ...keys], rows.map(r => [escapeHtml(r.cell_id), ...keys.map(k => escapeHtml(r[k] ?? '-'))]));
  return `<details><summary>Run provenance</summary><table>${facts}</table>${params}</details>`;
}

export function renderRegimeReport(data, { jsonHref = null } = {}) {
  const baseline = loadBaseline(data);
  const rows = mergeReps(data.rows || []);
  const s = data.summary || {};
  const kind = data.benchmark_kind || 'unknown';
  const banner = kind === 'regression-fixed-settings'
    ? `<div class="banner"><strong>Fixed-settings regression benchmark.</strong> Detection and fit settings are held fixed across every cell, so a per-cell number is NOT the best the app can achieve in that regime. A low jaccard at high density is not a capability limit; retuning threshold and window per regime would raise it.</div>`
    : `<p class="sub">Benchmark kind: ${escapeHtml(kind)}</p>`;
  const compared = baseline ? rows.filter(r => baseline.engines?.[r.engine]?.[r.cell_id]).length : 0;
  const verdict = [`${s.cells ?? rows.length} cells`, `${s.tier1_failures ?? 0} tier-1 failures`,
    baseline ? `${s.tier2_regressions ?? 0} regressions vs baseline (${compared} compared)` : 'no baseline: every delta is n/a',
    `${s.thin ?? 0} thin`, `${s.errors ?? 0} errors`].join(' &middot; ');
  // one line per cell and rule, not per seed replicate
  const fails = [...new Set((data.failures || []).map(f => f.replace(/ seed=\S+/, '').replace(/(tier\d) — ([^:]+):.*/, '$1: $2')))];
  const failures = fails.length ? `<ul class="sub">${fails.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>webSMLM regime matrix</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <main>
    <header><div><h1>webSMLM regime matrix</h1>
    <p><code>${escapeHtml(data.run_id || '')}</code>${jsonHref ? ` &middot; <a href="${escapeHtml(jsonHref)}">result JSON</a>` : ''}</p></div></header>
    ${banner}
    <p class="verdict">${verdict}</p>
    ${failures}
    ${mainTable(rows, data, baseline)}
    ${crlbTable(rows)}
    ${provenance(data, rows)}
  </main>
</body>
</html>`;
}

export function writeRegimeReport(file = newestRegimeResult(), outPath) {
  if (!file) throw new Error('no regime-matrix-*.json found');
  const out = outPath || join(dirname(file), 'regime-report.html');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const html = renderRegimeReport(data, { jsonHref: relative(dirname(out), file).replaceAll('\\', '/') });
  writeFileSync(out, html);
  return { reportPath: out, html };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = writeRegimeReport(process.argv[2]);
  console.log(`${r.reportPath} (${r.html.length} bytes)`);
}
