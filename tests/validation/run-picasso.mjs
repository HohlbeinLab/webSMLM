// Spawns the real, installed Picasso CLI (`python -m picasso ...` --
// invoked via `python -m` rather than relying on the `picasso` console
// script being on PATH, since pip's Scripts dir isn't always there,
// especially on Windows) directly -- no custom Python glue script. Verified
// live against a real `pip install picassosr` this session:
//   - `picasso localize` ALSO runs RCC drift-correction by default
//     (-d/--drift defaults to 1000, the RCC segment size) -- we pass -d 0
//     to disable it, since Milestone 1 wants raw per-frame localizations,
//     not drift-corrected ones (drift parity is Milestone 4's own concern).
//   - `picasso hdf2ts` writes a ThunderSTORM-shaped CSV (<stem>_locs.csv,
//     next to the input .hdf5) with x/y already in nm (pixelsize applied at
//     localize time via -px) and a 0-based frame column -- confirmed against
//     a known single-emitter truth, not assumed from docs.
// Follows the same "skip, don't fail" contract every existing tests/gpu/
// real-data bench already uses for a missing external prerequisite.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { readThunderstormCsv, toScorerLoc, assertScorerLocs } from './ts-csv.mjs';

const execFileP = promisify(execFile);
const PYTHON = process.env.WEBSMLM_PICASSO_PYTHON || 'python';

// Net-gradient detection threshold: Picasso's own scheme (min. brightness gradient across a spot)
// has no equivalent to webSMLM's k*sigma_noise wavelet threshold, and its scale follows the image's
// ADU noise/brightness, so there is NO single right value. Defaults are per truth source, each
// tuned once against that source's own noise level (simulator sweep: 30/100/400/800/1500 -> Jaccard 0.43/0.53/0.794/0.795/0.745; independent 400 -> 1.0), and the
// value actually used is recorded in result.parameters.detection.threshold. Override with
// --picasso-gradient=N (cross-validate.mjs) or WEBSMLM_PICASSO_GRADIENT; never reuse one source's
// number for the other.
// (superseded: cross-validate.mjs now sweeps; kept for resolveGradient callers)
export const DEFAULT_GRADIENT = { independent: 400, simulator: 800 };

export function resolveGradient(source, override) {
  const v = override ?? (process.env.WEBSMLM_PICASSO_GRADIENT ? Number(process.env.WEBSMLM_PICASSO_GRADIENT) : null);
  if (v != null) { if (!Number.isFinite(v) || v <= 0) throw new Error(`invalid Picasso net-gradient ${v}`); return { value: v, origin: 'override' }; }
  if (!(source in DEFAULT_GRADIENT)) throw new Error(`no default Picasso gradient for truth source "${source}"`);
  return { value: DEFAULT_GRADIENT[source], origin: `default for ${source}` };
}

// truth: {pxnm, gainPhotonsPerADU, offsetADU, nFrames, emitters?} (either truth source's movie descriptor).
export function picassoParameters(truth, { boxSide, gradient } = {}) {
  if (gradient == null) throw new Error('picassoParameters: gradient is required (see resolveGradient())');
  return {
    fitMethod: 'mle-spherical',
    pixelSizeNm: truth.pxnm,
    gainPhotonsPerADU: truth.gainPhotonsPerADU,
    offsetADU: truth.offsetADU,
    psfSigmaPx: truth.sigmaPx ?? null,
    boxSidePx: boxSide,
    detection: { method: 'Net gradient', threshold: gradient, unit: 'gradient' },
    frames: truth.nFrames,
    emitters: truth.emitters?.length ?? null,
    gpuMode: 'n/a',
  };
}

async function picassoAvailable() {
  try { await execFileP(PYTHON, ['-m', 'picasso', '--help'], { timeout: 20000 }); return true; }
  catch { return false; }
}

export async function runPicasso(truth, { outDir, tiffPath, boxSide = 2 * Math.ceil(3 * truth.sigmaPx) + 1, gradient } = {}) {
  const parameters = picassoParameters(truth, { boxSide, gradient });
  if (!await picassoAvailable()) {
    return { skipped: true, reason: `Picasso not found -- run "pip install -r tests/validation/requirements.txt" (or set WEBSMLM_PICASSO_PYTHON to a python with picassosr installed). See tests/validation/README.md.`, parameters };
  }

  const tmpDir = outDir || mkdtempSync(join(tmpdir(), 'picasso-'));
  // Picasso writes its outputs next to the INPUT file (not the cwd), so the movie is staged in tmpDir.
  const tiff = join(tmpDir, 'movie.tif');
  if (tiffPath) copyFileSync(tiffPath, tiff); else writeFileSync(tiff, truth.tiffBuffer);
  const stem = basename(tiff).replace(/\.tif{1,2}$/i, '');
  const locsHdf5 = join(tmpDir, `${stem}_locs.hdf5`);
  const locsCsv = join(tmpDir, `${stem}_locs.csv`);

  const localizeArgs = [
    '-m', 'picasso', 'localize', tiff,
    '-a', parameters.fitMethod,
    '-b', String(parameters.boxSidePx),
    '-g', String(parameters.detection.threshold),
    '-bl', String(parameters.offsetADU),
    '-s', String(parameters.gainPhotonsPerADU),   // photons = ADU * sensitivity / EM gain: webSMLM's gain (photons/ADU) is Picasso's sensitivity
    '-ga', '1',
    '-qe', '1',
    '-px', String(parameters.pixelSizeNm),
    '-d', '0',                      // disable Picasso's own default RCC undrift -- see file banner
  ];

  const t0 = Date.now();
  let log = '';
  try {
    const r1 = await execFileP(PYTHON, localizeArgs, { cwd: tmpDir, timeout: 180000 });
    log += r1.stdout + r1.stderr;
    if (!existsSync(locsHdf5)) return { skipped: false, error: `picasso localize did not produce ${locsHdf5}`, wallMs: Date.now() - t0, log, parameters };
    const r2 = await execFileP(PYTHON, ['-m', 'picasso', 'hdf2ts', locsHdf5], { cwd: tmpDir, timeout: 60000 });
    log += r2.stdout + r2.stderr;
  } catch (err) {
    return { skipped: false, error: `picasso CLI failed: ${err.message}`, wallMs: Date.now() - t0, log: (err.stdout || '') + (err.stderr || ''), parameters };
  }
  const wallMs = Date.now() - t0;

  if (!existsSync(locsCsv)) return { skipped: false, error: `picasso hdf2ts did not produce ${locsCsv}`, wallMs, log, parameters };
  const rows = readThunderstormCsv(locsCsv);
  // Picasso's CSV frame is already 0-based; NOT coerced with |0 (a missing column must fail, see assertScorerLocs).
  const locs = assertScorerLocs(rows.map(row => toScorerLoc(row, row.frame, parameters.pixelSizeNm)), { nFrames: truth.nFrames, label: 'picasso locs' });

  return { skipped: false, locs, wallMs, log, parameters };
}
