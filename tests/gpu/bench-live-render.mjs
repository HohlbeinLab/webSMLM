#!/usr/bin/env node
// Live/real-time render measurement — bench-render.mjs already times ONE
// renderSuperRes()/renderSuperResGpu() call per case; this measures what an
// interactive scrubbing/live-preview session actually feels like: many
// back-to-back full re-renders against the same loc set, reporting a
// latency DISTRIBUTION (min/mean/p95/max) and an effective fps figure, not
// just a single mean.
//
// Part A (always runs, no external data): built-in "Simulate movie"
// generator seeds a real loc set (same pattern bench-render.mjs uses), then
// N back-to-back render calls are timed in a tight loop.
//
// Part B (skips if the real dataset isn't present): wraps
// window.renderSuperRes/renderSuperResGpu via the same monkeypatch technique
// bench-fit.mjs already uses for window.runCore, around one real
// window.webSMLM.analyze() call — this is the ONLY way to see the
// reconstruction-render cost a real headless Run actually pays, since
// result.timings never reports it (runCore() returns timings before
// analyze() even reaches the render step — confirmed directly in
// webSMLM.html).
//
// Usage: cd tests && npm install (once), then node bench-live-render.mjs
import { join } from 'node:path';
import { launchPage, checkGpu } from '../lib/launch.mjs';
import { printTable, speedup, writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const N_ITERS = 40;
const MAG = 10, RBLUR = 0.25;

function stats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  return { min: s[0], mean, p95, max: s[s.length - 1], fps: 1000 / mean };
}

async function seedLocs(page) {
  // Same "wait for the run to actually finish" guard as bench-render.mjs's
  // own seedLocs (onSrPreview mutates lastResult mid-run) — copied rather
  // than imported since it's a small, self-contained DOM sequence specific
  // to each script's own case parameters.
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

async function repeatedRenderLoop(page, { mag, rblur, n, gpuAvailable }) {
  return page.evaluate(async ({ mag, rblur, n, gpuAvailable }) => {
    const w = lastResult.w, h = lastResult.h, locs = lastResult.locs;
    const cpuMs = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      window.renderSuperRes(locs, w, h, mag, rblur, 'fire', 99.5, false, 0, 0, locs, 'z');
      cpuMs.push(performance.now() - t0);
    }
    let gpuMsArr = null;
    if (gpuAvailable) {
      const engine = await window.getGpuEngine();
      gpuMsArr = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        await window.renderSuperResGpu(engine, locs, w, h, mag, rblur, 'fire', 99.5, false, 0, 0, undefined, 'z');
        gpuMsArr.push(performance.now() - t0);
      }
    }
    return { cpuMs, gpuMs: gpuMsArr };
  }, { mag, rblur, n, gpuAvailable });
}

// Part C — the actual settings-lag fix (MODULE: render's _renderAccumCache/
// _gpuAccumCache, added alongside this test): unlike repeatedRenderLoop()
// above (which re-renders with IDENTICAL params every iteration — itself
// now a cache hit too, just not what a user's own zmin/LUT edits look like),
// this varies the SAME settings the sidebar's 7 render listeners cover, with
// colour-by-depth ON throughout (the "z angles" case from the report — zColor
// rendering pays for a second blur pass over the z-sum buffer, so it's NOT
// directly comparable to Part A's zColor=false numbers; every comparison
// below is against a forced-miss run of the SAME zColor=true config instead,
// for a genuine apples-to-apples hit-vs-miss number).
// Two sub-cases, since they're NOT equally cheap after the fix (a real
// distinction the original lag report conflated):
//  - LUT-only: a pure cache hit (skips the per-localization accumulate pass
//    entirely) — this is the "near-instant" case.
//  - zmin/zmax-only: STILL a cache miss every edit, because out-of-range
//    localizations are excluded from the accumulator itself (not just
//    recoloured — see renderSuperRes's own comment) — but a much CHEAPER
//    miss, via a pre-sorted-by-z index + binary search instead of an O(n)
//    scan-with-branch. Its own "miss" column here is the FORCED-miss cost
//    (same sorted-index fast path, just cache-defeated by array identity)
//    for symmetry with the LUT sub-case, not a pre-fix O(n) baseline —
//    there's no way to re-run the old O(n) code from inside this same page.
async function settingsOnlyLoop(page, { mag, rblur, n, gpuAvailable }) {
  return page.evaluate(async ({ mag, rblur, n, gpuAvailable }) => {
    const w = lastResult.w, h = lastResult.h;
    // Synthetic smooth z gradient (same technique bench-render.mjs uses) so
    // the zmin/zmax sub-case has real depth data to filter against.
    // Replicated ×30 (with tiny jitter so it isn't degenerate identical
    // points) to reach a loc count in the range a real dataset actually
    // exercises (the pasted log this fix responds to had 3.8M locs) — at
    // this seed's own ~10k locs the O(nLocs) accumulate loop is already
    // negligible next to the O(W·H) blur/colormap passes over a 1280×1280
    // canvas, which would make the accumulate-skip benefit measured here
    // look artificially small relative to what a real large dataset sees.
    const base = lastResult.locs;
    const locs = [];
    for (let r = 0; r < 30; r++) for (const L of base) locs.push({ ...L, x: L.x + (Math.random() - 0.5) * 0.5, y: L.y + (Math.random() - 0.5) * 0.5, z: (L.x / w) * 400 });
    const luts = ['fire', 'inferno', 'viridis', 'turbo'];

    function timeLoop(fn) {
      const ms = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(i); ms.push(performance.now() - t0); }
      return ms;
    }
    async function timeLoopAsync(fn) {
      const ms = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(i); ms.push(performance.now() - t0); }
      return ms;
    }
    // A fresh deep copy defeats the cache's identity check every time (same
    // content, different object) — the forced-miss baseline for comparison.
    const freshCopies = Array.from({ length: n }, () => locs.map(L => ({ ...L })));

    // Warm the cache once, matching what the FIRST real edit in a session
    // would already have paid for (a fresh Run's own initial render).
    window.renderSuperRes(locs, w, h, mag, rblur, 'fire', 99.5, true, 0, 400, locs, 'z');
    const cpuLutHit = timeLoop(i => window.renderSuperRes(locs, w, h, mag, rblur, luts[i % luts.length], 99.5, true, 0, 400, locs, 'z'));
    const cpuLutMiss = timeLoop(i => window.renderSuperRes(freshCopies[i], w, h, mag, rblur, luts[i % luts.length], 99.5, true, 0, 400, freshCopies[i], 'z'));
    const cpuZrange = timeLoop(i => { const lo = (i % 20) * 10; window.renderSuperRes(locs, w, h, mag, rblur, 'fire', 99.5, true, lo, lo + 200, locs, 'z'); });

    let gpuLutHit = null, gpuLutMiss = null, gpuZrange = null;
    if (gpuAvailable) {
      const engine = await window.getGpuEngine();
      await window.renderSuperResGpu(engine, locs, w, h, mag, rblur, 'fire', 99.5, true, 0, 400, undefined, 'z');
      gpuLutHit = await timeLoopAsync(i => window.renderSuperResGpu(engine, locs, w, h, mag, rblur, luts[i % luts.length], 99.5, true, 0, 400, undefined, 'z'));
      gpuLutMiss = await timeLoopAsync(i => window.renderSuperResGpu(engine, freshCopies[i], w, h, mag, rblur, luts[i % luts.length], 99.5, true, 0, 400, undefined, 'z'));
      gpuZrange = await timeLoopAsync(i => { const lo = (i % 20) * 10; return window.renderSuperResGpu(engine, locs, w, h, mag, rblur, 'fire', 99.5, true, lo, lo + 200, undefined, 'z'); });
    }
    return { cpuLutHit, cpuLutMiss, cpuZrange, gpuLutHit, gpuLutMiss, gpuZrange };
  }, { mag, rblur, n, gpuAvailable });
}

const { browser, page } = await launchPage();
try {
  const gpu = await checkGpu(page);
  console.log(`WebGPU: ${gpu.available ? 'available' : 'NOT available — CPU-only numbers below'}`);

  console.log('\n=== Part A: repeated-render latency (synthetic seed, no external data) ===');
  const seeded = await seedLocs(page);
  console.log(`Seed Localize: ${seeded.n} locs on a ${seeded.w}×${seeded.h} frame. Running ${N_ITERS} render iterations each...`);
  const loop = await repeatedRenderLoop(page, { mag: MAG, rblur: RBLUR, n: N_ITERS, gpuAvailable: gpu.available });
  const cpuStats = stats(loop.cpuMs), gpuStats = loop.gpuMs ? stats(loop.gpuMs) : null;
  printTable([
    { which: 'CPU', ...cpuStats },
    ...(gpuStats ? [{ which: 'GPU', ...gpuStats }] : []),
  ], [
    { key: 'which', label: 'renderer', width: 8 },
    { key: 'min', label: 'min ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'mean', label: 'mean ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'p95', label: 'p95 ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'max', label: 'max ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'fps', label: 'fps', width: 7, fmt: v => v.toFixed(1) },
  ]);
  if (gpuStats) console.log(`GPU render speedup (mean): ${speedup(cpuStats.mean, gpuStats.mean).toFixed(2)}x.`);

  console.log('\n=== Part C: settings-only re-render (the actual reported lag) ===');
  const settingsLoop = await settingsOnlyLoop(page, { mag: MAG, rblur: RBLUR, n: N_ITERS, gpuAvailable: gpu.available });
  const cpuLutHitStats = stats(settingsLoop.cpuLutHit), cpuLutMissStats = stats(settingsLoop.cpuLutMiss), cpuZrangeStats = stats(settingsLoop.cpuZrange);
  const gpuLutHitStats = settingsLoop.gpuLutHit ? stats(settingsLoop.gpuLutHit) : null;
  const gpuLutMissStats = settingsLoop.gpuLutMiss ? stats(settingsLoop.gpuLutMiss) : null;
  const gpuZrangeStats = settingsLoop.gpuZrange ? stats(settingsLoop.gpuZrange) : null;
  printTable([
    { which: 'CPU', edit: 'LUT only — cache HIT', ...cpuLutHitStats },
    { which: 'CPU', edit: 'LUT only — forced miss', ...cpuLutMissStats },
    ...(gpuLutHitStats ? [{ which: 'GPU', edit: 'LUT only — cache HIT', ...gpuLutHitStats }] : []),
    ...(gpuLutMissStats ? [{ which: 'GPU', edit: 'LUT only — forced miss', ...gpuLutMissStats }] : []),
    { which: 'CPU', edit: 'zmin/zmax (sorted miss)', ...cpuZrangeStats },
    ...(gpuZrangeStats ? [{ which: 'GPU', edit: 'zmin/zmax (sorted miss)', ...gpuZrangeStats }] : []),
  ], [
    { key: 'which', label: 'renderer', width: 8 },
    { key: 'edit', label: 'edit type', width: 24 },
    { key: 'mean', label: 'mean ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'p95', label: 'p95 ms', width: 8, fmt: v => v.toFixed(2) },
    { key: 'fps', label: 'fps', width: 7, fmt: v => v.toFixed(1) },
  ]);
  console.log(`Cache HIT vs forced-miss, same zColor=true config, LUT-only edit: ${(cpuLutMissStats.mean / cpuLutHitStats.mean).toFixed(1)}x cheaper on CPU (skips the per-localization accumulate pass entirely).`);

  let partB = null;
  console.log('\n=== Part B: reconstruction-render cost inside a real analyze() Run ===');
  const TARGET = await resolveDataFile('STORM_STACK', join('19165061', 'Aquired STORM.tif'));
  if (!TARGET) {
    console.log('Skipping Part B.');
  } else {
    await page.setInputFiles('#analyzeFileInput', TARGET);
    const runOne = useGpu => page.evaluate(async ({ useGpu, fileInputId }) => {
      const config = { method: 'gaussmle', pxnm: 160, gain: 0.1248, camoffset: 100, fitFirstFrame: 1, fitLastFrame: 200, useGpu };
      config.file = document.getElementById(fileInputId).files[0];
      let renderMs = null;
      const key = useGpu ? 'renderSuperResGpu' : 'renderSuperRes';
      const orig = window[key];
      // renderSuperRes is SYNCHRONOUS and analyze() calls it without await
      // (`cv = renderSuperRes(...)`) — wrapping it in an async function here
      // would turn that assignment into a Promise, not a canvas, breaking
      // analyze()'s own `cv.toDataURL()` call downstream. renderSuperResGpu
      // IS async and analyze() does await it, so only that wrapper needs to be.
      window[key] = useGpu
        ? async function (...args) { const t0 = performance.now(); const r = await orig.apply(this, args); renderMs = performance.now() - t0; return r; }
        : function (...args) { const t0 = performance.now(); const r = orig.apply(this, args); renderMs = performance.now() - t0; return r; };
      const r = await window.webSMLM.analyze(config);
      window[key] = orig;
      return { renderMs, runMs: r.timings.runMs, nLocs: r.locs.length };
    }, { useGpu, fileInputId: 'analyzeFileInput' });

    const cpuRun = await runOne(false);
    const gpuRun = gpu.available ? await runOne(true) : null;
    partB = { cpuRun, gpuRun };
    printTable([
      { which: 'CPU', ...cpuRun },
      ...(gpuRun ? [{ which: 'GPU', ...gpuRun }] : []),
    ], [
      { key: 'which', label: 'run', width: 6 },
      { key: 'nLocs', label: 'locs', width: 8 },
      { key: 'runMs', label: 'total runMs', width: 11, fmt: v => v.toFixed(0) },
      { key: 'renderMs', label: 'render ms (was untimed)', width: 24, fmt: v => v == null ? 'n/a' : v.toFixed(1) },
    ]);
  }

  const outFile = writeResults('bench-live-render', { gpu, seeded, cpuStats, gpuStats, cpuLutHitStats, cpuLutMissStats, gpuLutHitStats, gpuLutMissStats, cpuZrangeStats, gpuZrangeStats, partB });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}
