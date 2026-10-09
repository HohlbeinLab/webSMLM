// Tiny shared parser for the ThunderSTORM-shaped CSV both tools emit --
// webSMLM's own buildCsvText() (MODULE: export, webSMLM.html) and Picasso's
// `picasso hdf2ts` produce near-identical headers (id, frame, "x [nm]",
// "y [nm]", "sigma [nm]", "intensity [photon]", "offset [photon]",
// "bkgstd [photon]", "uncertainty[_xy] [nm]") -- confirmed empirically
// against a real `picasso hdf2ts` run, not assumed from docs (see the plan's
// Milestone-1 coordinate-convention smoke test). One parser, one column-name
// normalization step, used by both run-webSMLM.mjs and run-picasso.mjs so
// compare.mjs only ever sees one canonical loc shape.
import { readFileSync } from 'node:fs';

// "x [nm]" -> "x_nm"; "uncertainty_xy [nm]" -> "uncertainty_xy_nm" (already
// underscored, unaffected); "intensity [photon]" -> "intensity_photon".
// webSMLM's own buildCsvText() wraps every HEADER field in double quotes
// (`"id","frame","x [nm]",...`) while leaving data rows unquoted -- strip
// that first (confirmed against a real result.csv, not assumed) or every
// lookup below silently misses.
function normalizeHeader(h) {
  return h.trim().replace(/^"|"$/g, '').replace(/\s*\[([^\]]+)\]\s*/g, '_$1').replace(/\s+/g, '_').toLowerCase();
}

function parseCsvLine(line) {
  // No field in either tool's own CSV output ever contains a comma or quote
  // (plain numeric columns + a small fixed header) -- a plain split is
  // correct here and matches the simplicity of the data, not a general CSV
  // parser this harness doesn't need.
  return line.split(',');
}

export function parseThunderstormCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length !== headers.length) continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = Number(cells[c]);
    rows.push(row);
  }
  return rows;
}

export function readThunderstormCsv(path) {
  return parseThunderstormCsv(readFileSync(path, 'utf8'));
}

// One parsed row -> the loc shape tests/lib/score.mjs reads: x/y in CAMERA PIXELS (these CSVs are
// in nm, so divide by pxnm), `frame` 0-based. frame0 is passed in already converted (webSMLM's CSV
// is 1-based, Picasso's 0-based) and is deliberately NOT coerced: a missing frame column gives NaN,
// which assertScorerLocs() rejects, instead of `|0` silently filing the loc in frame 0.
export function toScorerLoc(row, frame0, pxnm) {
  const loc = { frame: frame0, x: row.x_nm / pxnm, y: row.y_nm / pxnm, photons: row.intensity_photon };
  const u = row.uncertainty_nm ?? row.uncertainty_xy_nm;   // webSMLM / Picasso hdf2ts column names
  if (Number.isFinite(u)) loc.lpx = loc.lpy = u / pxnm;
  if (Number.isFinite(row.z_nm)) loc.z = row.z_nm;
  return loc;
}

// The scorer reads `L.frame|0`, so a missing/garbage frame silently scores as frame 0 -- fail
// loudly instead. Also range-checks against the movie, so a 1-based/0-based mixup that lands a
// frame at nFrames is caught too.
export function assertScorerLocs(locs, { nFrames, label = 'locs' }) {
  for (let i = 0; i < locs.length; i++) {
    const l = locs[i];
    if (!Number.isInteger(l.frame) || l.frame < 0 || l.frame >= nFrames)
      throw new Error(`${label}[${i}]: frame must be an integer in [0, ${nFrames}), got ${JSON.stringify(l.frame)} -- refusing to score (the scorer would file it in frame 0)`);
    if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) throw new Error(`${label}[${i}]: x/y must be finite camera pixels, got ${l.x}, ${l.y}`);
    if ('nMerged' in l) throw new Error(`${label}[${i}]: nMerged must be absent`);
  }
  return locs;
}
