// Generic HTML-report building blocks shared by every tests/lib/*-report.mjs
// renderer (currently gpu-report.mjs and cross-report.mjs). Factored out of
// gpu-report.mjs so a new report domain (e.g. the webSMLM-vs-Picasso cross-
// validation report) can reuse the page chrome/table/pill primitives without
// duplicating them or coupling to gpu-report.mjs's own CPU-vs-GPU-shaped
// tables. Pure string-building, no filesystem/process access — same
// "shared analytics helpers only" scope as report.mjs.

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

export function card(label, value) {
  return `<div class="card"><div class="metric">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

export function statusPill(status) {
  const safe = escapeHtml(status || 'unknown');
  const cls = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : status === 'skip' ? 'skip' : '';
  return `<span class="pill ${cls}">${safe}</span>`;
}

export function sectionTable(title, headers, rows) {
  const body = rows.length
    ? `<div class="panel table-wrap"><table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="panel empty">No rows for this run.</div>';
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

export function ms(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString('en-US')} ms` : '-';
}

export function speed(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}x` : '-';
}

export function number(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// ---- Difference tables ----------------------------------------------------
// Declared direction per metric ('higher' | 'lower' is better) and how its delta is shown:
// 'abs' = signed native units (bounded metrics), 'rel' = signed percent. NEVER inferred from the
// sign of a delta: an undeclared metric throws, so a new column cannot silently get a glyph.
// `tol` = default noise band: native units for 'abs', a fraction of |base| for 'rel'; callers with
// a measured band (the regime baseline's seed spread) pass their own, in raw-delta units.
export const METRICS = {
  jaccard:      { polarity: 'higher', mode: 'abs', digits: 3, tol: 0.005 },
  jaccard_norm: { polarity: 'higher', mode: 'abs', digits: 3, tol: 0.005 },
  recall:       { polarity: 'higher', mode: 'abs', digits: 3, tol: 0.005 },
  precision:    { polarity: 'higher', mode: 'abs', digits: 3, tol: 0.005 },
  eff_e3d:      { polarity: 'higher', mode: 'abs', digits: 1, tol: 0.5 },
  tp:           { polarity: 'higher', mode: 'rel', digits: 1, tol: 0.01 },
  fp:           { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  fn:           { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  rmse_lat_nm:  { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  rmse_z_nm:    { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  med_lat_nm:   { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  med_z_nm:     { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
  runtime_s:    { polarity: 'lower',  mode: 'rel', digits: 1, tol: 0.01 },
};

// 'better' | 'worse' | 'same' for a signed raw delta (value - base) on `metric`.
export function judge(metric, delta, band) {
  const m = METRICS[metric];
  if (!m) throw new Error(`report-html: no declared polarity for metric "${metric}"`);
  if (!(Math.abs(delta) > band)) return 'same';
  return (delta > 0) === (m.polarity === 'higher') ? 'better' : 'worse';
}

const NA = '<span class="na">n/a</span>';
const GLYPH = {
  better: '<span class="up">better</span>',
  worse: '<span class="dn">worse</span>',
  same: '<span class="eq">within tolerance</span>',
};

// One delta cell: value - base on `metric` with its polarity glyph. n/a unless both are finite
// (no baseline, thin cell, unavailable CRLB, skipped tool) or `na` is set; never a blank.
// `tol` overrides the default band, in raw-delta units. The optional `out` object receives
// `ratio` (|delta| / band, to rank rows by movement outside the noise) and `verdict`.
export function diffCell(metric, value, base, { tol, na, out } = {}) {
  const m = METRICS[metric];
  if (!m) throw new Error(`report-html: no declared polarity for metric "${metric}"`);
  if (na || value == null || base == null || !Number.isFinite(+value) || !Number.isFinite(+base)) return NA;
  if (m.mode === 'rel' && +base === 0) return NA;
  const d = value - base;
  const band = tol != null ? tol : (m.mode === 'rel' ? m.tol * Math.abs(base) : m.tol);
  if (out) out.ratio = band > 0 ? Math.abs(d) / band : (d === 0 ? 0 : Infinity);
  const verdict = judge(metric, d, band);
  if (out) out.verdict = verdict;
  const g = GLYPH[verdict];
  const shown = m.mode === 'rel' ? (d / Math.abs(base)) * 100 : d;
  const text = Math.abs(shown).toFixed(m.digits);
  const sign = Number(text) === 0 ? '' : (shown > 0 ? '+' : '-');
  return `${sign}${text}${m.mode === 'rel' ? '%' : ''} ${g}`;
}

// Plain value cell: n/a for null/non-finite so a missing value never reads as zero.
export function valueCell(v, digits = 3) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return NA;
  return Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(digits);
}

// The one table shell for every difference table. headers/rows hold ready HTML; `numeric` = the
// right-aligned column indices (default: every column but the first).
export function diffTable({ title, headers, rows, note = '', numeric }) {
  const num = new Set(numeric ?? headers.map((_, i) => i).slice(1));
  const cls = i => (num.has(i) ? ' class="num"' : '');
  const body = rows.length
    ? `<div class="panel table-wrap"><table class="diff"><thead><tr>${headers.map((h, i) => `<th${cls(i)}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="panel empty">No rows for this run.</div>';
  return `<section><h2>${escapeHtml(title)}</h2>${body}${note ? `<p class="note">${note}</p>` : ''}</section>`;
}

// The report's only chart: recall versus true z as a bare polyline (fixed 0..1 axis).
export function sparkline(bins, w = 120, h = 28) {
  const pts = (bins || []).filter(b => b && Number.isFinite(b.zc) && Number.isFinite(b.recall));
  if (pts.length < 2) return NA;
  const z0 = pts[0].zc, z1 = pts[pts.length - 1].zc, pad = 2;
  const xy = pts.map(b => `${(pad + (b.zc - z0) / ((z1 - z0) || 1) * (w - 2 * pad)).toFixed(1)},${(h - pad - Math.max(0, Math.min(1, b.recall)) * (h - 2 * pad)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="recall versus z"><title>recall vs z, ${Math.round(z0)} to ${Math.round(z1)} nm (axis 0 to 1)</title><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// Shared <head> CSS — identical look-and-feel across every report domain.
// title is set by the caller; this only renders the <style> block content.
export const REPORT_CSS = `
    :root{color-scheme:light;--bg:#fff;--panel:#fff;--ink:#17202a;--muted:#59636b;--line:#c9ced2;--ok:var(--ink);--bad:var(--ink);--skip:var(--ink);--gpu:var(--ink);--cpu:var(--ink);--soft:#fff}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:1280px;margin:0 auto;padding:28px}
    header{display:flex;gap:18px;align-items:end;justify-content:space-between;margin-bottom:18px}
    h1{margin:0 0 6px;font-size:36px;line-height:1.05;letter-spacing:0}
    h2{margin:24px 0 10px;font-size:20px;letter-spacing:0}
    p{margin:0;color:var(--muted)}
    code{border-bottom:1px solid var(--line);padding:1px 2px}
    .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin:18px 0;border:1px solid var(--line)}
    .card,.panel,details{border:1px solid var(--line);border-radius:0;background:var(--panel)}
    .card{padding:14px;border:0;border-right:1px solid var(--line)}.card:last-child{border-right:0}.metric{font-size:28px;font-weight:760;letter-spacing:0}.label{color:var(--muted);font-size:12px}
    .panel{overflow:hidden}.table-wrap{overflow:auto}
    table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;text-transform:none;letter-spacing:0;color:var(--muted);background:#fff}tr:last-child td{border-bottom:0}
    .pill{display:inline-block;padding:1px 0;font-size:12px;font-weight:700;background:transparent;color:var(--ink)}
    .pass,.fail,.skip,.gpu,.cpu{background:transparent;color:var(--ink)}
    details{margin:10px 0;padding:12px 14px}summary{cursor:pointer;font-weight:700}pre{max-height:460px;overflow:auto;padding:12px;border:1px solid var(--line);border-radius:0;background:#fff;color:var(--ink);font-size:12px;white-space:pre-wrap}
    .empty{padding:16px;color:var(--muted)}
    .diff th.num,.diff td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .na,.eq,.sub,.note{color:var(--muted)}.up,.dn{color:var(--ink);font-weight:700}
    .note,.sub{font-size:12px}.note{margin-top:6px}.verdict{font-size:16px;font-weight:650;margin:10px 0 4px;color:var(--ink)}
    .banner{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:0;padding:10px 14px;margin:12px 0}
    .spark{color:var(--cpu);vertical-align:middle}
    @media(max-width:900px){main{padding:18px}header{display:block}.cards{grid-template-columns:repeat(2,1fr)}}
`;
