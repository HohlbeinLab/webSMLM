#!/usr/bin/env node
// GPU vs CPU fit benchmark — synthetic stacks via the built-in "Simulate
// movie" generator, swept over the parameters that actually drive fit cost:
// emitter density (candidates/frame), photon count, stack length, and fit
// window radius. Every case here keeps detection on the CPU worker pool and
// measures the adaptive fit path selected by the single GPU checkbox. The old
// WebGPU detector port was removed after benchmarking slower than CPU workers.
// This script enables auditCandidates and joins CPU/GPU localizations by exact
// detector key (frame + candidate pixel), so result order cannot affect the
// correctness gate.
//
// "very many frames" cases below (well past the Simulate-movie UI's own
// max="800" input attribute) are set by writing the DOM input's .value
// directly rather than the UI's own +/- steppers — confirmed safe:
// paramValue() (webSMLM.html) does a bare parseFloat(el.value), no min/max
// clamping, so this genuinely drives a larger synthetic stack, not just a
// cosmetic UI overshoot.
//
// Usage: cd tests && npm install (once), then node bench-fit.mjs
import { launchPage, checkGpu } from '../lib/launch.mjs';
import { diffLocsExact, printTable, speedup, verdict, writeResults } from '../lib/report.mjs';

const CASES = [
  { label: 'baseline (defaults)',       dens: 0.05, phot: 900,  frames: 300,  winr: 4 },
  { label: 'low density',               dens: 0.02, phot: 900,  frames: 300,  winr: 4 },
  { label: 'high density',              dens: 0.5,  phot: 900,  frames: 300,  winr: 4 },
  { label: 'very high density',         dens: 0.6,  phot: 900,  frames: 300,  winr: 4 },
  { label: 'dim emitters',              dens: 0.5,  phot: 300,  frames: 300,  winr: 4 },
  { label: 'bright emitters',           dens: 0.05, phot: 5000, frames: 300,  winr: 4 },
  { label: 'long stack',                dens: 0.5,  phot: 900,  frames: 800,  winr: 4 },
  { label: 'large fit window',          dens: 0.5,  phot: 900,  frames: 300,  winr: 8 },
  { label: 'dense long stack',          dens: 0.25, phot: 900,  frames: 800,  winr: 4 },
  { label: 'very many frames (1500)',   dens: 0.2,  phot: 900,  frames: 1500, winr: 4 },
  { label: 'very many frames (3000)',   dens: 0.5,  phot: 900,  frames: 3000, winr: 4 },
  // mle3d (axis-aligned elliptical GPU kernel, WGSL_FIT_ELL3D) — localize3D
  // unchecked (no calibration exists in this synthetic-only harness, so 3D
  // z would be blocked by run()'s own needCal guard; 2D-only is still a
  // real exercise of the fit itself). generateSynthetic()'s PSF is a fixed
  // circular σ=1.3 (webSMLM.html ~3355) — this only proves "doesn't crash/
  // diverge, CPU and GPU agree, σx≈σy≈1.3 either way," NOT real ellipticity
  // recovery; that signal only exists in bench-3d-fit.mjs's real bead data.
  { label: 'mle3d (2D, baseline)',    dens: 0.05, phot: 900, frames: 300, winr: 4, method: 'mle3d', localize3D: false },
  { label: 'mle3d (2D, high density)', dens: 0.5, phot: 900, frames: 300, winr: 4, method: 'mle3d', localize3D: false },
  // gaussmleEll fixed-angle (WGSL_FIT_ROT_FIXED) — localize3D unchecked so
  // the angle is FIXED at sSmlmAngleCenter (nonzero here — a real angle to
  // fit against, not the trivial 0° case) rather than fit as a 7th free
  // parameter. Same circular-PSF caveat as mle3d above.
  { label: 'gaussmleEll fixed-angle', dens: 0.5, phot: 900, frames: 300, winr: 4, method: 'gaussmleEll', localize3D: false, sSmlmAngleCenter: 30 },
  // FTM (temporal median filtering) + GPU fit together — this round's actual
  // fix: FTM used to hard-exclude GPU fit entirely (runCore()'s useGpuFit
  // gate required fetchStack===stack, false for the whole run whenever FTM
  // is on), forcing CPU fit even with useGpu checked. The FTM barrier loop
  // now routes its own detect/fit phase through the same GPU accumulator
  // when eligible — this case is the one thing no other case here exercises
  // at all. mle3d (not gaussmle) since that's the method combination the
  // real reported log used; localize3D:false (no calibration in this
  // synthetic harness, same reasoning as the mle3d/gaussmleEll cases above).
  // forceWorkers: the fix only applies inside runCore()'s useWorkers branch
  // (which requires pool.length>1 AND the stack to clear workerMinFrames/
  // workerMinPxFrame/workerMinTotalPx) — a small enough stack (this harness's
  // synthetic 128×128 frames, well under those thresholds even at the
  // simulate-movie UI's own 800-frame ceiling) falls through to the bare
  // serial fallback instead, which has NO GPU-fit support at all (a real,
  // separate, narrower gap — FTM+GPU on a small dataset — left as a known
  // follow-up, not fixed this round; confirmed live during verification: an
  // identical case without forceWorkers silently ran on CPU, no GPU log line
  // at all, no crash). Forcing the worker-count thresholds to 0 via
  // paramOverrides (see the main loop below) makes THIS one case exercise
  // the real, intended fix (a large real dataset like the one that reported
  // this bug crosses these thresholds naturally) without needing a
  // multi-thousand-frame synthetic stack just to prove it.
  { label: 'FTM + GPU fit (mle3d)', dens: 0.05, phot: 900, frames: 300, winr: 4, method: 'mle3d', localize3D: false, ftmEnabled: true, ftmWindow: 15, forceWorkers: true },
  // gaussmleEll free-angle (WGSL_FIT_ROT_FREE) has NO case here on purpose:
  // localize3D:true makes run()'s own needCal guard (webSMLM.html ~line
  // 11953) require a loaded gaussian_width calibration before it will even
  // call runCore() at all — confirmed live (an attempted case here just
  // hangs: runBtn's click returns immediately, window.runCore is never
  // invoked, so this harness's own "wait for runCore to be called" pattern
  // times out). This synthetic/interactive harness has no calibration
  // mechanism, so free-angle can't be exercised here — bench-3d-fit.mjs's
  // real-bead-data test (which DOES supply a calibrationFile) is the actual
  // and more meaningful verification for this kernel.
];

// Runs one Localize (CPU or GPU) against whatever stack is already loaded,
// via the real UI (genBtn's simulate happens once per case, before this is
// called twice). Captures runCore()'s own {timings} return by monkey-
// patching the top-level window.runCore — a real `window` property here
// since webSMLM.html uses a classic (non-module) <script>. Waits on that
// capture rather than any DOM state, so it can't race a slow run.
async function runLocalize(page, useGpu) {
  return page.evaluate(async (useGpu) => {
    document.getElementById('useGpu').checked = useGpu;
    document.getElementById('useGpu').dispatchEvent(new Event('change'));
    let captured = null;
    const orig = window.runCore;
    window.runCore = async function (...args) {
      args[0] = Object.assign({}, args[0], { auditCandidates: true });
      const r = await orig.apply(this, args); captured = r; return r;
    };
    document.getElementById('runBtn').click();
    const t0 = performance.now();
    while (!captured) {
      if (performance.now() - t0 > 120000) throw new Error('Localize did not finish within 120s');
      await new Promise(r => setTimeout(r, 50));
    }
    window.runCore = orig;
    // NOTE: lastResult is a top-level `let` in webSMLM.html, not a `var`/
    // function declaration — those don't attach to `window` the way
    // top-level `function`s do (confirmed live: `window.lastResult` is
    // always undefined, but the bare identifier resolves via the shared
    // global lexical environment page.evaluate() runs in).
    const locs = (typeof lastResult !== 'undefined' && lastResult ? lastResult.locs : []).map(L => ({
      x: L.x, y: L.y, z: L.z, frame: L.frame,
      photons: L.photons, bg: L.bg, bgstd: L.bgstd,
      sigma: L.sigma, sx: L.sx, sy: L.sy,
      angle: L.angle, lpx: L.lpx, lpy: L.lpy,
      lpsx: L.lpsx, lpsy: L.lpsy, lpangle: L.lpangle,
    }));
    return {
      timings: captured.timings, execution: captured.execution, stageTimings: captured.stageTimings,
      locs, auditCandidatePixels: Array.from(captured.auditCandidatePixels || []),
    };
  }, useGpu);
}

async function setSimParams(page, { dens, phot, frames, winr, method, localize3D, sSmlmAngleCenter, ftmEnabled, ftmWindow }) {
  await page.evaluate(({ dens, phot, frames, winr, method, localize3D, sSmlmAngleCenter, ftmEnabled, ftmWindow }) => {
    for (const [id, v] of Object.entries({ dens, phot, frames, winr })) {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    }
    // Explicitly reset method/localize3D/sSmlmAngleCenter/ftmEnabled/ftmWindow
    // every case (not just when a case specifies one) — the DOM persists
    // across cases in this same page, so a later case would otherwise
    // silently inherit an earlier one's leftover selection.
    document.getElementById('method').value = method || 'gaussmle';
    document.getElementById('method').dispatchEvent(new Event('change'));
    document.getElementById('localize3D').checked = localize3D !== undefined ? localize3D : true;
    document.getElementById('localize3D').dispatchEvent(new Event('change'));
    const angleEl = document.getElementById('sSmlmAngleCenter');
    angleEl.value = sSmlmAngleCenter !== undefined ? sSmlmAngleCenter : 0;
    angleEl.dispatchEvent(new Event('input')); angleEl.dispatchEvent(new Event('change'));
    document.getElementById('ftmEnabled').checked = !!ftmEnabled;
    document.getElementById('ftmEnabled').dispatchEvent(new Event('change'));
    const ftmWindowEl = document.getElementById('ftmWindow');
    ftmWindowEl.value = ftmWindow !== undefined ? ftmWindow : 50;
    ftmWindowEl.dispatchEvent(new Event('input')); ftmWindowEl.dispatchEvent(new Event('change'));
  }, { dens, phot, frames, winr, method, localize3D, sSmlmAngleCenter, ftmEnabled, ftmWindow });
}

async function simulateAndWait(page, seed) {
  await page.evaluate((seed) => {
    window.__benchFitOldRandom = Math.random;
    Math.random = mulberry32(seed);
    if (typeof _g !== 'undefined') _g = null; // reset gauss() spare sample; otherwise previous cases leak into this seed
    document.getElementById('genBtn').click();
  }, seed);
  try {
    await page.waitForFunction(() => !document.getElementById('runBtn').disabled, { timeout: 60000 });
  } finally {
    await page.evaluate(() => {
      if (window.__benchFitOldRandom) {
        Math.random = window.__benchFitOldRandom;
        delete window.__benchFitOldRandom;
      }
      if (typeof _g !== 'undefined') _g = null;
    });
  }
}

function fitStage(result) {
  return (result.execution && result.execution.stages && result.execution.stages.fit) ||
    (result.stageTimings && result.stageTimings.fit) || {};
}

const { browser, page } = await launchPage();
try {
  const gpu = await checkGpu(page);
  console.log(`WebGPU: ${gpu.available ? 'available' : 'NOT available — every case will just report the CPU side'}`);
  if (gpu.available) console.log(`  limits: ${JSON.stringify(gpu.limits)}`);

  const rows = [];
  for (const c of CASES) {
    process.stdout.write(`Running "${c.label}"...`);
    if (c.forceWorkers) {
      // See the case's own comment above for why — paramOverrides is the
      // documented mechanism for params with no page control (CLAUDE.md,
      // MODULE: params), which these worker-dispatch thresholds are.
      await page.evaluate(() => { paramOverrides.workerMinTotalPx = 0; paramOverrides.workerMinPxFrame = 0; paramOverrides.workerMinFrames = 0; });
    }
    await setSimParams(page, c);
    await simulateAndWait(page, 0xBEEFF17 + rows.length);
    const cpu = await runLocalize(page, false);
    // FTM case: verify the log itself, not just that a result came back —
    // the actual bug being fixed was GPU fit being silently, permanently
    // skipped whenever FTM was on (runCore()'s old useGpuFit gate), with
    // the run still "succeeding" via a silent CPU fallback either way.
    const logBefore = c.ftmEnabled && gpu.available ? await page.evaluate(() => document.getElementById('logText').textContent.length) : null;
    const gpuRun = gpu.available ? await runLocalize(page, true) : null;
    if (c.ftmEnabled && gpu.available) {
      const newLog = await page.evaluate((from) => document.getElementById('logText').textContent.slice(from), logBefore);
      if (newLog.includes('GPU fit not available: FTM')) throw new Error(`FTM case "${c.label}": GPU fit was still skipped for FTM — the fix did not take effect. Log:\n${newLog}`);
      if (!newLog.includes('GPU fit:')) throw new Error(`FTM case "${c.label}": expected a "GPU fit: ..." summary line, found none. Log:\n${newLog}`);
      console.log(' [log verified: GPU fit ran during FTM]');
    }
    const diff = gpuRun ? diffLocsExact(cpu.locs, gpuRun.locs, cpu.auditCandidatePixels, gpuRun.auditCandidatePixels, cpu.timings.nCand) : null;
    const cpuFit = fitStage(cpu), gpuFit = gpuRun ? fitStage(gpuRun) : {};
    const gpuSelected = (gpuFit.gpuCalls || 0) > 0;
    const sp = gpuSelected ? speedup(cpuFit.wallMs || cpu.timings.tFit, gpuFit.wallMs || gpuRun.timings.tFit) : null;
    const reason = gpuRun ? ((gpuFit.reasons || []).join('+') || gpuFit.path || 'unknown') : null;
    rows.push({
      label: c.label, dens: c.dens, phot: c.phot, frames: c.frames, winr: c.winr,
      nLocs: cpu.locs.length,
      path: gpuRun ? gpuFit.path : 'n/a', reason,
      cpuFitMs: Math.round(cpuFit.wallMs || cpu.timings.tFit), gpuFitMs: gpuRun ? Math.round(gpuFit.wallMs || gpuRun.timings.tFit) : null,
      speedup: sp, acceptDiscord: diff ? diff.acceptanceDiscordance : null,
      netBias: diff ? diff.netAcceptanceBias : null,
      posP99: diff ? diff.posP99 : null, maxDx: diff ? diff.maxDx : null,
      maxDPhotonsRel: diff ? diff.maxDPhotonsRel : null,
      paramP99: diff ? diff.paramP99 : null, paramMax: diff ? diff.paramMax : null,
      paramMaxKey: diff ? diff.paramMaxKey : null,
      verdict: diff && diff.lengthMismatch ? `LENGTH MISMATCH (cpu ${diff.n} vs gpu ${diff.nGpu})` : verdict(sp, diff ? diff.withinTolerance : null),
    });
    if (c.forceWorkers) await page.evaluate(() => { delete paramOverrides.workerMinTotalPx; delete paramOverrides.workerMinPxFrame; delete paramOverrides.workerMinFrames; });
    console.log(' done.');
  }

  console.log('');
  printTable(rows, [
    { key: 'label', label: 'case', width: 22 },
    { key: 'nLocs', label: 'locs', width: 6 },
    { key: 'path', label: 'path', width: 6 },
    { key: 'cpuFitMs', label: 'CPU fit ms', width: 10 },
    { key: 'gpuFitMs', label: 'GPU fit ms', width: 10 },
    { key: 'speedup', label: 'speedup', width: 8, fmt: v => v == null ? 'n/a' : v.toFixed(2) + 'x' },
    { key: 'maxDx', label: 'maxΔpx', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'maxDPhotonsRel', label: 'maxΔphot%', width: 10, fmt: v => v == null ? 'n/a' : (v * 100).toFixed(3) },
    { key: 'acceptDiscord', label: 'discord', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(1) },
    { key: 'netBias', label: 'netbias', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(1) },
    { key: 'posP99', label: 'p99px', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'paramP99', label: 'p99param', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'paramMax', label: 'maxparam', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'paramMaxKey', label: 'max key', width: 8 },
    { key: 'verdict', label: 'verdict', width: 26 },
  ]);

  const mismatchRows = rows.filter(r => typeof r.verdict === 'string' && (r.verdict.startsWith('MISMATCH') || r.verdict.startsWith('LENGTH')));
  const withGpu = rows.filter(r => r.speedup != null);
  if (withGpu.length) {
    const meanSpeedup = withGpu.reduce((s, r) => s + r.speedup, 0) / withGpu.length;
    const worst = mismatchRows[0];
    console.log(`\nMean GPU fit speedup across ${withGpu.length} cases: ${meanSpeedup.toFixed(2)}x.`);
    console.log(withGpu.every(r => r.speedup >= 1) ? 'GPU fit was faster in every case tested.'
      : `GPU fit was SLOWER than CPU in ${withGpu.filter(r => r.speedup < 1).length}/${withGpu.length} case(s) — likely dispatch/readback overhead dominating at low candidate counts; see the "speedup" column for which.`);
    if (worst) console.log(`⚠ ${worst.label}: ${worst.verdict}`);
    if (worst) process.exitCode = 1;
  } else {
    console.log('\nGPU was unavailable for every case — nothing to compare.');
  }

  if (mismatchRows.length) process.exitCode = 1;
  const outFile = writeResults('bench-fit', { gpu, cases: rows });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}
