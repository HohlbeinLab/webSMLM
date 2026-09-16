#!/usr/bin/env node
// GPU vs CPU render benchmark — one small synthetic Localize (CPU-fit is
// fine here, only the render step is under test) provides a fixed loc set,
// then renderSuperRes()/renderSuperResGpu() (both real `window` functions,
// see webSMLM.html MODULE: render / MODULE: gpu) are called directly and
// timed, swept over magnification and blur radius (the two knobs that scale
// the accumulate/blur/colormap workload) plus one depth-colour (z) case.
// The 2D fit used to seed locs has no real z — that one case assigns a
// synthetic z per loc purely to exercise the colour-by-depth code path,
// independent of any fit accuracy question (out of scope here).
//
// Usage: cd tests && npm install (once), then node bench-render.mjs
import { launchPage, checkGpu } from '../lib/launch.mjs';
import { printTable, speedup, verdict, writeResults } from '../lib/report.mjs';

// `mode` is renderSuperRes()'s own renderMode (MODULE: render). 'precision'
// splats each localization's own CRLB-sized Gaussian instead of binning and
// blurring; it gained a GPU kernel (WGSL_RENDER_PRECISION) and so is under test
// here for the same thing 'fixed' is: the GPU image must match the CPU image,
// not merely arrive sooner. 'dither' has no kernel and is not benched.
//
// `perturbPrecision` rewrites lpx/lpy on the seeded locs before rendering. It is
// what actually exercises the three branches the precision path can take per
// loc — a real per-loc sigma, the blurPx fallback when precision is missing, and
// MAX_SPLAT_SIGMA_PX clamping a badly-localized outlier. Without it every loc
// from one synthetic Localize has a similar lpx and two of those three branches
// are never reached, so a kernel that got them wrong would still pass.
const CASES = [
  { label: 'baseline (defaults)', mag: 10, rblur: 0.25, zColor: false, mode: 'fixed' },
  { label: 'no blur',             mag: 10, rblur: 0,    zColor: false, mode: 'fixed' },
  { label: 'heavy blur',          mag: 10, rblur: 0.75, zColor: false, mode: 'fixed' },
  { label: 'high magnification',  mag: 20, rblur: 0.25, zColor: false, mode: 'fixed' },
  { label: 'high mag + no blur',  mag: 20, rblur: 0,    zColor: false, mode: 'fixed' },
  { label: 'depth colour (z)',    mag: 10, rblur: 0.25, zColor: true,  mode: 'fixed' },
  { label: 'precision mag 5',     mag: 5,  rblur: 0.25, zColor: false, mode: 'precision' },
  { label: 'precision mag 10',    mag: 10, rblur: 0.25, zColor: false, mode: 'precision' },
  { label: 'precision mag 20',    mag: 20, rblur: 0.25, zColor: false, mode: 'precision' },
  { label: 'precision + z',       mag: 10, rblur: 0.25, zColor: true,  mode: 'precision' },
  { label: 'precision mixed lp',  mag: 10, rblur: 0.25, zColor: false, mode: 'precision', perturbPrecision: true },
  { label: 'precision no blurPx', mag: 10, rblur: 0,    zColor: false, mode: 'precision', perturbPrecision: true },
];

async function seedLocs(page) {
  // A modest, fast Localize just to get a real, non-trivial loc set —
  // useGpu doesn't matter here (fit isn't what's being measured). Must wait
  // for the run to actually FINISH, not just "lastResult.locs is non-empty"
  // — onSrPreview reassigns lastResult repeatedly mid-run with a still-
  // growing subset (see webSMLM.html's run() wrapper), so that weaker check
  // let a later case's render read a lastResult still being mutated by an
  // in-flight run — a real, confirmed bug (nLocs climbing across cases,
  // large bogus pixel diffs) caught by running this suite for real. Same
  // window.runCore monkey-patch bench-fit.mjs already uses to know for sure.
  return page.evaluate(async () => {
    for (const [id, v] of Object.entries({ dens: 1.0, phot: 900, frames: 300, winr: 4 })) {
      const el = document.getElementById(id); el.value = v;
      el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    }
    document.getElementById('useGpu').checked = false;
    document.getElementById('useGpu').dispatchEvent(new Event('change'));
    document.getElementById('genBtn').click();
    const t0 = performance.now();
    while (document.getElementById('runBtn').disabled) {
      if (performance.now() - t0 > 60000) throw new Error('Simulate movie did not finish within 60s');
      await new Promise(r => setTimeout(r, 50));
    }
    let captured = null;
    const orig = window.runCore;
    window.runCore = async function (...args) { const r = await orig.apply(this, args); captured = r; return r; };
    document.getElementById('runBtn').click();
    const t1 = performance.now();
    while (!captured) {
      if (performance.now() - t1 > 120000) throw new Error('Localize did not finish within 120s');
      await new Promise(r => setTimeout(r, 50));
    }
    window.runCore = orig;
    return { w: lastResult.w, h: lastResult.h, n: lastResult.locs.length };
  });
}

async function runCase(page, c) {
  // Diffs the two pixel buffers INSIDE the page and returns only the
  // summary numbers — at mag=20 on even a modest frame this is a 25M+
  // element buffer; shipping that (or an Array.from() of it) across the
  // Playwright/CDP boundary as a return value blew the Node process's own
  // JS heap in testing (an out-of-memory crash, not a webSMLM.html bug).
  // Exactly the "never let a large blob cross as one JSON return value"
  // lesson tools/webSMLM-cli.mjs's own comments already document for
  // analyze()'s pcfo.pts/sSmlmPair.locs trimming — same rule, applied here.
  return page.evaluate(async ({ mag, rblur, zColor, mode, perturbPrecision }) => {
    const zlo = 0, zhi = 400, colorField = 'z';
    const w = lastResult.w, h = lastResult.h;
    let locs = lastResult.locs;
    // A smooth gradient, not a wrapped/modulo pattern: real 3D SMLM z data
    // varies smoothly between neighbouring molecules, so this is what
    // actually exercises the depth-colour path representatively. A sharp
    // modulo pattern (tried first) put adjacent pixels on opposite sides of
    // a LUT colour-bucket boundary, which f32-vs-f64 hue rounding then tips
    // one way or the other essentially at random — a real, understood
    // effect (confirmed live) but one only THIS test's own harsh synthetic
    // pattern would ever encounter at meaningful scale.
    if (zColor) locs = locs.map(L => ({ ...L, z: (L.x / w) * zhi }));
    // Deterministic (index-keyed, no RNG) so a rerun compares like with like:
    // every 7th loc loses its precision entirely -> the blurPx fallback; every
    // 11th gets a deliberately terrible 400 nm-scale lpx -> MAX_SPLAT_SIGMA_PX
    // clamping; the rest keep whatever the fit produced.
    if (perturbPrecision) locs = locs.map((L, i) => (
      i % 7 === 0 ? { ...L, lpx: undefined, lpy: undefined }
      : i % 11 === 0 ? { ...L, lpx: 3.9, lpy: 4.4 }
      : L));

    const t0 = performance.now();
    const cpuCanvas = await window.renderSuperRes(locs, w, h, mag, rblur, 'fire', 99.5, zColor, zlo, zhi, locs, colorField, undefined, mode);
    const cpuMs = performance.now() - t0;
    const cpuData = cpuCanvas.getContext('2d').getImageData(0, 0, cpuCanvas.width, cpuCanvas.height).data;

    const engine = await window.getGpuEngine();
    if (!engine.available) return { cpuMs, gpuMs: null, gpuAvailable: false, width: cpuCanvas.width, height: cpuCanvas.height, nLocs: locs.length };

    const t1 = performance.now();
    const gpuCanvas = await window.renderSuperResGpu(engine, locs, w, h, mag, rblur, 'fire', 99.5, zColor, zlo, zhi, locs, colorField, mode);
    const gpuMs = performance.now() - t1;
    const gpuData = gpuCanvas.getContext('2d').getImageData(0, 0, gpuCanvas.width, gpuCanvas.height).data;
    const N = cpuCanvas.width * cpuCanvas.height;
    const cpuBuf = {
      acc: mode === 'precision' ? new Float32Array(N) : new Uint16Array(N),
      zacc: zColor ? new Float32Array(N) : null,
      blurDst: mode === 'fixed' ? new Float32Array(N) : null,
      zBlurDst: (mode === 'fixed' && zColor) ? new Float32Array(N) : null,
      blurTmp: mode === 'fixed' ? new Float32Array(N) : null,
    };
    window.renderSuperResPixels(locs, cpuCanvas.width, cpuCanvas.height, mag, rblur, zColor, zlo, zhi, locs, colorField, 'fire', 99.5, cpuBuf, mode);
    let cpuMass = 0; for (let i = 0; i < cpuBuf.acc.length; i++) cpuMass += cpuBuf.acc[i];
    if (!_gpuAccumCache || !_gpuAccumCache.accF) throw new Error('GPU render mass audit: missing retained primary accumulator');
    const massStaging = engine.device.createBuffer({ size: N * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'test:render-mass-staging' });
    const massEncoder = engine.device.createCommandEncoder({ label: 'test:render-mass-readback' });
    massEncoder.copyBufferToBuffer(_gpuAccumCache.accF, 0, massStaging, 0, N * 4);
    engine.device.queue.submit([massEncoder.finish()]);
    await massStaging.mapAsync(GPUMapMode.READ);
    const gpuAcc = new Float32Array(massStaging.getMappedRange());
    let gpuMass = 0; for (let i = 0; i < gpuAcc.length; i++) gpuMass += gpuAcc[i];
    massStaging.unmap(); massStaging.destroy();
    const massRelError = Math.abs(cpuMass - gpuMass) / Math.max(1, Math.abs(cpuMass));

    let maxDiff = 0, sum = 0, nDiffPixels = 0, nOver4 = 0;
    const hist=new Uint32Array(256);
    const n = Math.min(cpuData.length, gpuData.length), nPixels = n / 4;
    for (let px = 0; px < nPixels; px++) {
      let pxMax = 0;
      for (let c = 0; c < 4; c++) { const d = Math.abs(cpuData[px * 4 + c] - gpuData[px * 4 + c]); if (d > pxMax) pxMax = d; sum += d; hist[d]++; }
      if (pxMax > 0) nDiffPixels++;
      if (pxMax > 4) nOver4++;
      if (pxMax > maxDiff) maxDiff = pxMax;
    }
    let acc=0,p99=0;for(let d=0;d<hist.length;d++){acc+=hist[d];if(acc>=n*.99){p99=d;break;}}
    return { cpuMs, gpuMs, gpuAvailable: true, width: cpuCanvas.width, height: cpuCanvas.height, nLocs: locs.length, massRelError, maxByteDiff: maxDiff, meanByteDiff: n ? sum / n : 0, p99ByteDiff:p99, over4Fraction:nPixels?nOver4/nPixels:0, diffPixelFraction: nPixels ? nDiffPixels / nPixels : 0 };
  }, c);
}

// Crop-simulation: `locs` is a filtered SUBSET (exactly what the SR-panel
// crop tool hands rerender() as `renderLocs` — see applyFilterToReconstruction(),
// MODULE: table), while `normLocs` stays the FULL, unfiltered dataset — the
// colour-scale-pinning case rerender() always constructs (MODULE: render).
// Before this round, rerender()'s GPU branch was gated OFF entirely whenever
// `rlocs!==lastResult.locs` (any crop/filter active), regardless of the
// useGpu checkbox, and renderSuperResGpu() had no normLocs support to fall
// back on even if called directly. This exercises exactly that path: GPU
// must now actually run, and its pinned-scale output must match the CPU
// path within TOLERANCE.
// `mode` matters more here than it looks: with normLocs present, 'precision'
// leaves the PRIMARY accumulator unblurred (its splat is the smoothing) while
// the colour-scale accumulator is still binned-and-blurred in 'fixed' style —
// two different treatments of two buffers inside one render, which is exactly
// the sort of split that goes wrong silently.
async function runCropCase(page, mode) {
  return page.evaluate(async (mode) => {
    const zlo = 0, zhi = 400, colorField = 'z', mag = 10, rblur = 0.25, zColor = true;
    const w = lastResult.w, h = lastResult.h;
    const full = lastResult.locs.map(L => ({ ...L, z: (L.x / w) * zhi }));
    const cropped = full.filter(L => L.x < w * 0.3);   // a real, non-trivial ROI subset

    const t0 = performance.now();
    const cpuCanvas = await window.renderSuperRes(cropped, w, h, mag, rblur, 'fire', 99.5, zColor, zlo, zhi, full, colorField, undefined, mode);
    const cpuMs = performance.now() - t0;
    const cpuData = cpuCanvas.getContext('2d').getImageData(0, 0, cpuCanvas.width, cpuCanvas.height).data;

    const engine = await window.getGpuEngine();
    if (!engine.available) return { cpuMs, gpuMs: null, gpuAvailable: false, width: cpuCanvas.width, height: cpuCanvas.height, nLocs: cropped.length };

    const t1 = performance.now();
    const gpuCanvas = await window.renderSuperResGpu(engine, cropped, w, h, mag, rblur, 'fire', 99.5, zColor, zlo, zhi, full, colorField, mode);
    const gpuMs = performance.now() - t1;
    const gpuData = gpuCanvas.getContext('2d').getImageData(0, 0, gpuCanvas.width, gpuCanvas.height).data;
    const N = cpuCanvas.width * cpuCanvas.height;
    const cpuBuf = {
      acc: mode === 'precision' ? new Float32Array(N) : new Uint16Array(N),
      zacc: zColor ? new Float32Array(N) : null,
      blurDst: mode === 'fixed' ? new Float32Array(N) : null,
      zBlurDst: (mode === 'fixed' && zColor) ? new Float32Array(N) : null,
      blurTmp: mode === 'fixed' ? new Float32Array(N) : null,
    };
    window.renderSuperResPixels(cropped, cpuCanvas.width, cpuCanvas.height, mag, rblur, zColor, zlo, zhi, cropped, colorField, 'fire', 99.5, cpuBuf, mode);
    let cpuMass = 0; for (let i = 0; i < cpuBuf.acc.length; i++) cpuMass += cpuBuf.acc[i];
    if (!_gpuAccumCache || !_gpuAccumCache.accF) throw new Error('GPU render mass audit: missing retained primary accumulator');
    const massStaging = engine.device.createBuffer({ size: N * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'test:render-mass-staging' });
    const massEncoder = engine.device.createCommandEncoder({ label: 'test:render-mass-readback' });
    massEncoder.copyBufferToBuffer(_gpuAccumCache.accF, 0, massStaging, 0, N * 4);
    engine.device.queue.submit([massEncoder.finish()]);
    await massStaging.mapAsync(GPUMapMode.READ);
    const gpuAcc = new Float32Array(massStaging.getMappedRange());
    let gpuMass = 0; for (let i = 0; i < gpuAcc.length; i++) gpuMass += gpuAcc[i];
    massStaging.unmap(); massStaging.destroy();
    const massRelError = Math.abs(cpuMass - gpuMass) / Math.max(1, Math.abs(cpuMass));

    let maxDiff = 0, sum = 0, nDiffPixels = 0, nOver4 = 0;
    const hist=new Uint32Array(256);
    const n = Math.min(cpuData.length, gpuData.length), nPixels = n / 4;
    for (let px = 0; px < nPixels; px++) {
      let pxMax = 0;
      for (let c = 0; c < 4; c++) { const d = Math.abs(cpuData[px * 4 + c] - gpuData[px * 4 + c]); if (d > pxMax) pxMax = d; sum += d; hist[d]++; }
      if (pxMax > 0) nDiffPixels++;
      if (pxMax > 4) nOver4++;
      if (pxMax > maxDiff) maxDiff = pxMax;
    }
    let acc=0,p99=0;for(let d=0;d<hist.length;d++){acc+=hist[d];if(acc>=n*.99){p99=d;break;}}
    return { cpuMs, gpuMs, gpuAvailable: true, width: cpuCanvas.width, height: cpuCanvas.height, nLocs: cropped.length, massRelError, maxByteDiff: maxDiff, meanByteDiff: n ? sum / n : 0, p99ByteDiff:p99, over4Fraction:nPixels?nOver4/nPixels:0, diffPixelFraction: nPixels ? nDiffPixels / nPixels : 0 };
  }, mode);
}

const { browser, page } = await launchPage();
try {
  const gpu = await checkGpu(page);
  console.log(`WebGPU: ${gpu.available ? 'available' : 'NOT available — every case will just report the CPU side'}`);

  const seeded = await seedLocs(page);
  console.log(`Seed Localize: ${seeded.n} locs on a ${seeded.w}×${seeded.h} frame.\n`);

  const rows = [];
  for (const c of CASES) {
    process.stdout.write(`Running "${c.label}"...`);
    const r = await runCase(page, c);
    // A large maxByteDiff confined to a tiny fraction of pixels is expected
    // f32-vs-f64 boundary noise (one loc landing near a pixel edge buckets
    // differently), not a bug — only fail on EITHER a small-but-widespread
    // diff OR a diff affecting more than pixelDiffFraction of the image.
    const withinTolerance = r.gpuAvailable ? r.meanByteDiff<=.25&&r.p99ByteDiff<=2&&r.over4Fraction<=.001&&r.massRelError<=(c.mode==='precision'?1e-4:1e-6) : null;
    const sp = r.gpuAvailable ? speedup(r.cpuMs, r.gpuMs) : null;
    rows.push({
      label: c.label, mode: c.mode, mag: c.mag, rblur: c.rblur, zColor: c.zColor,
      size: `${r.width}×${r.height}`, nLocs: r.nLocs,
      cpuMs: Math.round(r.cpuMs), gpuMs: r.gpuAvailable ? Math.round(r.gpuMs) : null,
      speedup: sp, maxByteDiff: r.gpuAvailable ? r.maxByteDiff : null,
      meanByteDiff:r.gpuAvailable?r.meanByteDiff:null,p99ByteDiff:r.gpuAvailable?r.p99ByteDiff:null,
      massRelError:r.gpuAvailable?r.massRelError:null,
      over4Pct:r.gpuAvailable?r.over4Fraction*100:null,correct:withinTolerance,
      diffPct: r.gpuAvailable ? r.diffPixelFraction * 100 : null,
      verdict: verdict(sp, withinTolerance),
    });
    console.log(' done.');
  }

  for (const cropMode of ['fixed', 'precision']) {
    process.stdout.write(`Running "crop + normLocs (${cropMode})"...`);
    const cr = await runCropCase(page, cropMode);
    const cropWithinTolerance = cr.gpuAvailable ? cr.meanByteDiff<=.25&&cr.p99ByteDiff<=2&&cr.over4Fraction<=.001&&cr.massRelError<=(cropMode==='precision'?1e-4:1e-6) : null;
    const cropSpeedup = cr.gpuAvailable ? speedup(cr.cpuMs, cr.gpuMs) : null;
    rows.push({
      label: `crop + normLocs`, mode: cropMode, mag: 10, rblur: 0.25, zColor: true,
      size: `${cr.width}×${cr.height}`, nLocs: cr.nLocs,
      cpuMs: Math.round(cr.cpuMs), gpuMs: cr.gpuAvailable ? Math.round(cr.gpuMs) : null,
      speedup: cropSpeedup, maxByteDiff: cr.gpuAvailable ? cr.maxByteDiff : null,
      meanByteDiff:cr.gpuAvailable?cr.meanByteDiff:null,p99ByteDiff:cr.gpuAvailable?cr.p99ByteDiff:null,
      massRelError:cr.gpuAvailable?cr.massRelError:null,
      over4Pct:cr.gpuAvailable?cr.over4Fraction*100:null,correct:cropWithinTolerance,
      diffPct: cr.gpuAvailable ? cr.diffPixelFraction * 100 : null,
      verdict: cr.gpuAvailable ? verdict(cropSpeedup, cropWithinTolerance) : 'GPU unavailable — CPU-only',
    });
    console.log(' done.');
    if (cr.gpuAvailable && !cropWithinTolerance) {
      console.log(`⚠ crop+normLocs (${cropMode}) GPU/CPU mismatch beyond tolerance: maxByteDiff=${cr.maxByteDiff}, diffPct=${(cr.diffPixelFraction * 100).toFixed(4)}%`);
    }
  }

  console.log('');
  printTable(rows, [
    { key: 'label', label: 'case', width: 20 },
    { key: 'mode', label: 'mode', width: 10 },
    { key: 'size', label: 'px size', width: 11 },
    { key: 'nLocs', label: 'locs', width: 6 },
    { key: 'cpuMs', label: 'CPU ms', width: 8 },
    { key: 'gpuMs', label: 'GPU ms', width: 8 },
    { key: 'speedup', label: 'speedup', width: 8, fmt: v => v == null ? 'n/a' : v.toFixed(2) + 'x' },
    { key: 'maxByteDiff', label: 'maxΔbyte', width: 9 },
    { key: 'meanByteDiff', label: 'meanΔ', width: 7, fmt:v=>v==null?'n/a':v.toFixed(3) },
    { key: 'p99ByteDiff', label: 'p99Δ', width: 6 },
    { key: 'over4Pct', label: '>4 %px', width: 7, fmt:v=>v==null?'n/a':v.toFixed(3) },
    { key: 'massRelError', label: 'massErr', width: 8, fmt:v=>v==null?'n/a':v.toExponential(1) },
    { key: 'diffPct', label: 'diff%px', width: 8, fmt: v => v == null ? 'n/a' : v.toFixed(4) },
    { key: 'verdict', label: 'verdict', width: 26 },
  ]);

  const withGpu = rows.filter(r => r.speedup != null);
  if (withGpu.length) {
    const meanSpeedup = withGpu.reduce((s, r) => s + r.speedup, 0) / withGpu.length;
    console.log(`\nMean GPU render speedup across ${withGpu.length} cases: ${meanSpeedup.toFixed(2)}x.`);
    console.log(withGpu.every(r => r.speedup >= 1) ? 'GPU render was faster in every case tested.'
      : `GPU render was SLOWER than CPU in ${withGpu.filter(r => r.speedup < 1).length}/${withGpu.length} case(s) — at this small a reconstruction, the CPU path (already a single fast typed-array pass) may simply not have enough work to amortise the GPU dispatch/readback round-trip; try higher magnification/larger stacks if that's the pattern.`);
  } else {
    console.log('\nGPU was unavailable — nothing to compare.');
  }

  const outFile = writeResults('bench-render', { gpu, seeded, cases: rows });
  console.log(`\nFull results written to ${outFile}`);
  const failed=rows.filter(r=>r.correct===false);
  if(failed.length){console.error(`\n${failed.length}/${rows.length} render correctness gate(s) failed.`);process.exitCode=1;}
} finally {
  await browser.close();
}
