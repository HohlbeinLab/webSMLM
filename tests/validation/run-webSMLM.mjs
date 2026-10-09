// webSMLM's own localizations for the cross-validation: an in-page analyze() on a page the caller
// already opened (cross-validate.mjs needs one for scoring anyway), so one process serves both.
// The movie is loaded exactly as a user would, via the hidden Load-data input.
//
// The localizations stay in the page (window.__wsLocs) and are pulled out in bounded chunks, so no
// single CDP message scales with the loc count. They are returned in the scorer's shape (tests/lib/
// score.mjs: x/y in camera px, 0-based frame) -- analyze()'s own locs already are.
//
// With `scoreVsTruth` (only meaningful when this page's own simulation made the movie) the app's
// own analyze({scoreVsTruth}) result is returned too, minus its per-pair residual arrays, so
// cross-validate can compare it with scoreLocsInPage()'s number for the same localizations.
import { assertScorerLocs } from './ts-csv.mjs';

// Fit window radius from the PSF actually in use: Smith et al. 2010 box side 2*3*sigma+1 => winr = ceil(3*sigma).
export const winrForSigma = sigma => Math.ceil(3 * sigma);
export const DEFAULT_WAVELET_THR = 4;   // documented app default scale; swept by cross-validate.mjs
const CHUNK = 100000;

// truth: {pxnm, gainPhotonsPerADU, offsetADU, sigmaPx, nFrames, emitters?}
export function webSMLMParameters(truth, threshold = DEFAULT_WAVELET_THR) {
  const winr = winrForSigma(truth.sigmaPx);
  return {
    fitMethod: 'gaussmle',
    pixelSizeNm: truth.pxnm,
    gainPhotonsPerADU: truth.gainPhotonsPerADU,
    offsetADU: truth.offsetADU,
    psfSigmaPx: truth.sigmaPx ?? null,
    winr, boxSidePx: winr * 2 + 1,
    detection: { method: 'Wavelet', threshold, unit: 'k*sigma_noise' },
    frames: truth.nFrames,
    emitters: truth.emitters?.length ?? null,
    gpuMode: 'adaptive (enabled)',
  };
}

export async function runWebSMLM(page, truth, { tiffPath, scoreVsTruth = false, threshold = DEFAULT_WAVELET_THR } = {}) {
  const parameters = webSMLMParameters(truth, threshold);
  await page.setInputFiles('#analyzeFileInput', tiffPath);
  const cfg = {
    pxnm: parameters.pixelSizeNm, gain: parameters.gainPhotonsPerADU, camoffset: parameters.offsetADU,
    method: parameters.fitMethod, winr: parameters.winr, detFilter: 'wave',
    detection_wavelet_thr: threshold, useGpu: true, scoreVsTruth,
  };
  cfg.psf = parameters.psfSigmaPx;

  const t0 = Date.now();
  let r;
  try {
    r = await page.evaluate(async cfg => {
      const config = { ...cfg, file: document.getElementById('analyzeFileInput').files[0] };
      const res = await window.webSMLM.analyze(config);
      // The fields the scorer reads, nothing else (analyze() locs carry many more).
      window.__wsLocs = res.locs.map(l => ({ frame: l.frame, x: l.x, y: l.y, z: l.z, photons: l.photons, lpx: l.lpx, lpy: l.lpy }));
      let truthScore = null;
      if (res.truthScore) { const { dx, dy, dz, zTrue, photonPairs, bins, ...rest } = res.truthScore; truthScore = rest; }
      return { n: window.__wsLocs.length, truthScore, usedCfg: { psf: paramValue('psf'), gain: paramValue('gain'), camoffset: paramValue('camoffset') } };
    }, cfg);
  } catch (err) {
    return { skipped: false, error: `in-page analyze() failed: ${err.message}`, wallMs: Date.now() - t0, parameters };
  }
  const wallMs = Date.now() - t0;

  const locs = [];
  for (let i = 0; i < r.n; i += CHUNK) {
    const chunk = await page.evaluate(([a, b]) => window.__wsLocs.slice(a, b), [i, i + CHUNK]);
    for (const l of chunk) locs.push(l);
  }
  await page.evaluate(() => { window.__wsLocs = null; });
  assertScorerLocs(locs, { nFrames: truth.nFrames, label: 'webSMLM locs' });
  return { skipped: false, locs, wallMs, truthScore: r.truthScore, parameters };
}
