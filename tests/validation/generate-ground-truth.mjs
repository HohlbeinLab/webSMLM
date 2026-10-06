// Neutral synthetic-movie generator for the webSMLM-vs-Picasso cross-
// validation harness (tests/validation/). Deliberately NOT webSMLM's own
// "Simulate movie" (MODULE: simulation in webSMLM.html) and NOT Picasso's
// own picasso/simulate.py — either tool's own simulator would bias the
// comparison toward whichever tool's detector/fitter happens to match that
// simulator's own noise/PSF assumptions (see the plan's "Independent ground
// truth" rationale). This is a third, standalone forward model.
//
// Emitters are static (same position every frame, independent Poisson shot
// noise per frame) rather than blinking — this is Milestone 1's scope
// (detection + localization accuracy vs. a known truth), which wants many
// independent (truth, estimate) pairs, not blinking-kinetics realism.
//
// Forward model, deliberately kept to a 1:1 photon<->ADU gain regime for v1
// (gain=1 photon/ADU on webSMLM's side == sensitivity=1 ADU/e-, gain=1, qe=1
// on Picasso's side): this isolates LOCALIZATION correctness from GAIN-
// CALIBRATION correctness, which is a separate, later concern.
//   raw_ADU = offsetADU + Poisson(true_photons_at_pixel) + round(Gaussian(0, readNoiseADU))
// true_photons_at_pixel = background + sum over emitters of a PIXEL-
// INTEGRATED 2D Gaussian (erf-based, not point-sampled) scaled to each
// emitter's own total integrated photon count -- matches both tools' own
// "photons" column semantics (the total under the PSF, not a peak
// amplitude) and avoids the ~1-5% bias a point-sampled forward model would
// introduce at these pixel-scale sigmas.
import { encodeMultiFrameTiff16 } from '../lib/mini-tiff.mjs';

// Small hand-rolled LCG -- same construction mini-tiff.mjs's own
// makeSyntheticFrame() already uses, kept consistent rather than pulling in
// a second seeded-RNG style for the same job.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Box-Muller, using the same rng stream (two draws per sample).
function gaussianSample(rng, mean, sd) {
  const u1 = Math.max(1e-12, rng()), u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Poisson sampler: exact (Knuth) for small lambda, Gaussian approximation
// for lambda>=30 -- standard practice (Poisson(lambda) -> Normal(lambda,
// sqrt(lambda)) is an excellent approximation there, and Knuth's algorithm
// is O(lambda) per draw, too slow per-pixel at our photon counts of ~1e3-1e4).
function poissonSample(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(gaussianSample(rng, lambda, Math.sqrt(lambda))));
}

// Abramowitz & Stegun 7.1.26, ~1e-7 max error -- exact closed-form pixel-
// integration needs this rather than a supersampling loop.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// Total integrated mass of a 2D Gaussian (integral = 1 over all space) that
// falls inside pixel [x,x+1)x[y,y+1) (pixel (x,y)'s own footprint, in the
// same 0-based, pixel-CENTER-at-integer coordinate convention verified
// empirically against the real picasso CLI -- see the plan's Milestone-1
// smoke-test note).
function pixelGaussianMass(px, py, cx, cy, sigma) {
  const s = sigma * Math.SQRT2;
  const gx = 0.5 * (erf((px + 0.5 - cx) / s) - erf((px - 0.5 - cx) / s));
  const gy = 0.5 * (erf((py + 0.5 - cy) / s) - erf((py - 0.5 - cy) / s));
  return gx * gy;
}

// Sample nEmitters uniform-random positions inside [margin, W-1-margin] x
// [margin, H-1-margin] -- margin keeps every emitter's own fit window fully
// inside the frame for BOTH tools, so neither tool's edge-clipping behavior
// (which may differ) confounds the comparison. Rejection-sampled to a
// minimum pairwise separation (minSep) so no two ground-truth emitters ever
// overlap -- Milestone 1 is about single-isolated-emitter localization
// accuracy, not multi-emitter PSF-blending behavior (a real, separate
// concern), so two GT points landing close together would otherwise
// conflate the two and also make nearest-neighbor GT matching in compare.mjs
// ambiguous. Capped attempts so a too-dense request fails loudly instead of
// spinning forever.
function sampleEmitterPositions(rng, n, W, H, margin, minSep) {
  const pts = [];
  const maxAttemptsPerPoint = 2000;
  for (let i = 0; i < n; i++) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttemptsPerPoint; attempt++) {
      const cand = { x: margin + rng() * (W - 1 - 2 * margin), y: margin + rng() * (H - 1 - 2 * margin) };
      if (pts.every(p => Math.hypot(p.x - cand.x, p.y - cand.y) >= minSep)) { pts.push(cand); placed = true; break; }
    }
    if (!placed) throw new Error(`generateGroundTruth: could not place emitter ${i + 1}/${n} with minSep=${minSep}px in a ${W}x${H} frame -- reduce nEmitters or minSep`);
  }
  return pts;
}

export function generateGroundTruth(opts = {}) {
  const {
    W = 96, H = 96, nFrames = 30, nEmitters = 30,
    sigmaPx = 1.3, photonsTotal = 3000, bgPhotons = 20,
    offsetADU = 100, readNoiseADU = 3, pxnm = 100,
    margin = 8, minSepPx = null, seed = 20260923,
  } = opts;
  const minSep = minSepPx ?? 6 * sigmaPx; // 6sigma: comfortably isolated PSFs, no overlap

  const rng = makeRng(seed);
  const positions = sampleEmitterPositions(rng, nEmitters, W, H, margin, minSep);
  const r = Math.ceil(sigmaPx * 4); // footprint radius beyond which a Gaussian's mass is negligible

  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const sig = new Float64Array(W * H).fill(bgPhotons); // true photon signal (before shot noise)
    for (const e of positions) {
      const cx0 = Math.max(0, Math.floor(e.x - r)), cx1 = Math.min(W - 1, Math.ceil(e.x + r));
      const cy0 = Math.max(0, Math.floor(e.y - r)), cy1 = Math.min(H - 1, Math.ceil(e.y + r));
      for (let y = cy0; y <= cy1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          sig[y * W + x] += photonsTotal * pixelGaussianMass(x, y, e.x, e.y, sigmaPx);
        }
      }
    }
    const raw = new Uint16Array(W * H);
    for (let i = 0; i < sig.length; i++) {
      const adu = offsetADU + poissonSample(rng, sig[i]) + Math.round(gaussianSample(rng, 0, readNoiseADU));
      raw[i] = Math.max(0, Math.min(65535, adu));
    }
    frames.push(raw);
  }

  const tiffBuffer = encodeMultiFrameTiff16(frames, W, H);
  const truth = {
    W, H, nFrames, pxnm, sigmaPx, photonsTotal, bgPhotons, offsetADU, readNoiseADU, seed,
    // gain=1 photon/ADU (webSMLM) == sensitivity=1,gain=1,qe=1 (Picasso) -- see file banner.
    gainPhotonsPerADU: 1,
    emitters: positions.map((e, i) => ({ id: i, x: e.x, y: e.y })),
    // Carried on truth itself (not a sibling field) so run-webSMLM.mjs/
    // run-picasso.mjs -- which only ever receive `truth`, not this whole
    // return value -- can each write it out to feed their own tool. Strip
    // it back off (see cross-validate.mjs) before the truth object goes
    // into a JSON report.
    tiffBuffer,
  };
  return { tiffBuffer, truth };
}

// Standalone CLI use: `node generate-ground-truth.mjs out.tif out.truth.json`
// -- writes files for manual inspection; cross-validate.mjs normally calls
// generateGroundTruth() in-process instead.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { writeFileSync } = await import('node:fs');
  const [, , tiffOut = 'ground-truth.tif', truthOut = 'ground-truth.json'] = process.argv;
  const { tiffBuffer, truth } = generateGroundTruth();
  writeFileSync(tiffOut, tiffBuffer);
  writeFileSync(truthOut, JSON.stringify({ ...truth, tiffBuffer: undefined }, null, 2));
  console.log(`Wrote ${tiffOut} (${truth.W}x${truth.H}, ${truth.nFrames} frames, ${truth.emitters.length} emitters) and ${truthOut}`);
}
