#!/usr/bin/env node
// Shape test (PARAMS.shapeTest): Smith et al. 2010's criterion that a Poisson-MLE fit's mean
// per-pixel log-likelihood ratio (Stirling form, see mleLlrTerm()) is above a threshold.
//   1. The statistic: a correct model scores about -0.5 whatever the photons/background/window,
//      so the default -1 rejects ~nothing; a second emitter just outside the window is caught;
//      sCMOS read noise is allowed for through rnVar.
//   2. CPU = GPU: the four GPU fit kernels (spherical, elliptical, rotated fixed/free angle)
//      report the same llr as the CPU fitters.
//   3. Localize: serial, worker-pool and GPU paths keep the same fits, all pass the threshold,
//      the log and the result report the count, the CSV and the table carry the column.
import assert from 'node:assert/strict';
import { launchPage, checkGpu } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  const gpu = await checkGpu(page);

  // ---- 1. the statistic on pure-Poisson windows -------------------------------------------
  const stat = await page.evaluate(() => {
    let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const pois = m => { if (m >= 40) return Math.max(0, Math.round(m + Math.sqrt(m) * gauss()));
      const L = Math.exp(-m); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
    const S = 15, c = 7, sig = 1.3;
    const trial = (win, N, bg, { neighbour = false, readVar = 0, rnVar = 0 } = {}) => {
      const mx = c + rnd() - 0.5, my = c + rnd() - 0.5, a = 2 * Math.PI * rnd();
      const nx = c + 4.5 * Math.cos(a), ny = c + 4.5 * Math.sin(a), img = new Float32Array(S * S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let mu = bg + N * mleGInt(x, mx, sig) * mleGInt(y, my, sig);
        if (neighbour) mu += N * mleGInt(x, nx, sig) * mleGInt(y, ny, sig);
        img[y * S + x] = pois(mu) + (readVar ? Math.sqrt(readVar) * gauss() : 0); }
      return gaussianMLEspheric(img, S, S, c, c, win, sig, 1, 0, 0.001, rnVar);
    };
    const run = (win, N, bg, o) => { const v = []; for (let t = 0; t < 400; t++) { const f = trial(win, N, bg, o); if (f) v.push(f.llr); }
      v.sort((a, b) => a - b); return { n: v.length, median: v[v.length >> 1], below: v.filter(x => x < -1).length / Math.max(1, v.length) }; };
    const out = { clean: [], neighbour: run(7, 1000, 5, { neighbour: true }), noRn: run(7, 300, 5, { readVar: 8 }), withRn: run(7, 300, 5, { readVar: 8, rnVar: 8 }) };
    for (const win of [7, 9]) for (const N of [100, 1000, 3000]) for (const bg of [1, 10]) out.clean.push({ win, N, bg, ...run(win, N, bg) });
    // the inline fitter term equals the documented helper
    const img = new Float32Array(S * S).fill(3); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img[y * S + x] = pois(3 + 500 * mleGInt(x, 7.2, sig) * mleGInt(y, 6.9, sig));
    const f = gaussianMLEspheric(img, S, S, c, c, 7, sig, 1, 0, 0.001, 4);
    let ll = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const px = c + dx, py = c + dy;
      ll += mleLlrTerm(img[py * S + px], f.photons * mleGInt(px, f.x, f.sigma) * mleGInt(py, f.y, f.sigma) + f.bg, 4); }
    out.helperDiff = Math.abs(ll / 49 - f.llr);
    return out;
  });
  for (const r of stat.clean) {
    assert.ok(r.median > -0.62 && r.median < -0.40, `correct model, ${r.win}x${r.win} ${r.N} ph bg ${r.bg}: median ${r.median} should sit near -0.5`);
    assert.ok(r.below < 0.01, `correct model, ${r.win}x${r.win} ${r.N} ph bg ${r.bg}: ${(100 * r.below).toFixed(1)}% fall below -1`);
  }
  assert.ok(stat.neighbour.below > 0.8, `a bright neighbour 4.5 px away must be caught (${(100 * stat.neighbour.below).toFixed(0)}% below -1)`);
  assert.ok(stat.noRn.below > 0.1 && stat.withRn.below < stat.noRn.below / 3,
    `allowing for read noise must cut the false rejections (${(100 * stat.noRn.below).toFixed(0)}% -> ${(100 * stat.withRn.below).toFixed(0)}%)`);
  assert.ok(stat.helperDiff < 1e-9, `mleLlrTerm() disagrees with the fitter's inline term by ${stat.helperDiff}`);
  const meds = stat.clean.map(r => r.median);
  console.log(`  statistic: correct model median ${Math.min(...meds).toFixed(2)}…${Math.max(...meds).toFixed(2)} over ${meds.length} settings, <1% below -1; `
    + `neighbour caught ${(100 * stat.neighbour.below).toFixed(0)}%; read noise ${(100 * stat.noRn.below).toFixed(0)}% -> ${(100 * stat.withRn.below).toFixed(0)}% rejected with the correction`);

  // ---- 2. CPU = GPU, all four kernels ------------------------------------------------------
  if (!gpu.available) console.log('  GPU kernels: SKIP (WebGPU unavailable)');
  else {
    const par = await page.evaluate(async () => {
      let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
      const pois = m => { if (m >= 40) return Math.max(0, Math.round(m + Math.sqrt(m) * gauss()));
        const L = Math.exp(-m); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
      const S = 15, c = 7, win = 9, r = 4, K = win, k2 = K * K, sig = 1.3, M = 240, rn = 6.25;
      const engine = await getGpuEngine(); engine.fitRnVar = rn;
      const imgs = [];
      for (let m = 0; m < M; m++) {
        const N = [200, 600, 1500, 3000][m % 4], bg = [2, 8][(m >> 2) & 1], mx = c + rnd() - 0.5, my = c + rnd() - 0.5;
        const nb = m % 3 === 0, a = 2 * Math.PI * rnd(), nx = c + (3 + 3 * rnd()) * Math.cos(a), ny = c + (3 + 3 * rnd()) * Math.sin(a);
        const img = new Float32Array(S * S);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          let mu = bg + N * mleGInt(x, mx, sig) * mleGInt(y, my, sig); if (nb) mu += 0.6 * N * mleGInt(x, nx, sig) * mleGInt(y, ny, sig);
          img[y * S + x] = pois(mu); }
        imgs.push(img); }
      const frameIdx = Int32Array.from({ length: M }, (_, i) => i);
      const compare = async (name, seedRow, gpuFn, cpuFn) => {
        const sA = new Float32Array(M * 4), sB = new Float32Array(M * 4), wn = new Float32Array(M * k2);
        imgs.forEach((img, m) => seedRow(img, m, sA, sB, wn));
        const g = await gpuFn(engine, sA, sB, wn, frameIdx, M, r, 0.001);
        const byFrame = new Map(g.map(L => [L.frame, L]));
        let both = 0, maxd = 0, worst = 0, onlyGpu = 0, onlyCpu = 0; const diffs = [];
        imgs.forEach((img, m) => { const C = cpuFn(img), G = byFrame.get(m);
          if (C && G) { both++; const d = Math.abs(C.llr - G.llr), tol = d / (0.01 + 0.005 * Math.abs(C.llr)); diffs.push(d); maxd = Math.max(maxd, d); worst = Math.max(worst, tol); }
          else if (G) onlyGpu++; else if (C) onlyCpu++; });
        diffs.sort((a, b) => a - b);
        return { name, both, onlyGpu, onlyCpu, medianDiff: diffs[diffs.length >> 1], maxd, worst };
      };
      return [
        await compare('spherical', (img, m, sA, sB, wn) => buildFitSeedRow(img, S, c, c, r, K, k2, sig, 1, 0, sA, sB, wn, m),
          (e, sA, sB, wn, fi, n, rr, ep) => fitBatchGpuFlat(e, sA, sB, wn, fi, n, rr, ep), img => gaussianMLEspheric(img, S, S, c, c, win, sig, 1, 0, 0.001, rn)),
        await compare('elliptical', (img, m, sA, sB, wn) => buildFitSeedRowEll(img, S, c, c, r, K, k2, sig, sig, 1, 0, sA, sB, wn, m),
          (e, sA, sB, wn, fi, n, rr, ep) => fitBatchGpuFlatEll3D(e, sA, sB, wn, fi, n, rr, ep), img => gaussianMLEelliptic(img, S, S, c, c, win, sig, 1, 0, 0.001, rn)),
        await compare('rotated, fixed angle', (img, m, sA, sB, wn) => buildFitSeedRowEll(img, S, c, c, r, K, k2, sig, sig, 1, 0, sA, sB, wn, m),
          (e, sA, sB, wn, fi, n, rr, ep) => fitBatchGpuFlatRotFixed(e, sA, sB, wn, fi, n, rr, ep, 0.3), img => gaussianMLEellipticangled(img, S, S, c, c, win, sig, 1, 0, 0.001, 0.3, null, null, rn)),
        await compare('rotated, free angle', (img, m, sA, sB, wn) => buildFitSeedRowEll(img, S, c, c, r, K, k2, sig * 1.05, sig * 0.95, 1, 0, sA, sB, wn, m),
          (e, sA, sB, wn, fi, n, rr, ep) => fitBatchGpuFlatRotFree(e, sA, sB, wn, fi, n, rr, ep), img => gaussianMLEellipticangled(img, S, S, c, c, win, sig, 1, 0, 0.001, null, null, null, rn)),
      ];
    });
    for (const p of par) {
      assert.ok(p.both >= 150, `${p.name}: only ${p.both} fits accepted by both paths`);
      assert.ok(p.medianDiff < 0.002, `${p.name}: median |llr(GPU) - llr(CPU)| = ${p.medianDiff}`);
      assert.ok(p.worst < 1, `${p.name}: worst |llr(GPU) - llr(CPU)| = ${p.maxd} (${p.worst.toFixed(2)}x the 0.01 + 0.5% tolerance)`);
    }
    console.log('  GPU = CPU llr: ' + par.map(p => `${p.name} ${p.both} fits, median Δ ${p.medianDiff.toExponential(1)}, max Δ ${p.maxd.toExponential(1)}`).join(' · '));
  }

  // ---- 3. Localize end to end ---------------------------------------------------------------
  await page.evaluate(() => {
    for (const [k, v] of Object.entries({ frames: 400, simulation_seed: 5, simulation_psfModel: 'gaussian', simulation_structureType: 'uniform3D', dens: 0.3, gain: 0.34, camoffset: 100 })) { const el = $(k); el.value = v; el.dispatchEvent(new Event('change')); }
    $('localize3D').checked = false; $('localize3D').dispatchEvent(new Event('change'));
  });
  await page.evaluate(() => runSimulation());
  assert.deepEqual(await page.evaluate(() => [paramValue('shapeTest'), paramValue('shapeTestThr')]), [true, -1], 'the shape test is on at -1 by default');
  const localize = async (label, { useGpu, shape, workers, ftm = false, method = 'gaussmle' }) => {
    await page.evaluate(({ useGpu, shape, workers, ftm, method }) => {
      $('useGpu').checked = useGpu; $('useGpu').dispatchEvent(new Event('change'));
      $('shapeTest').checked = shape; $('shapeTest').dispatchEvent(new Event('change'));
      $('ftmEnabled').checked = ftm; $('ftmEnabled').dispatchEvent(new Event('change'));
      $('method').value = method; $('method').dispatchEvent(new Event('change'));
      if (workers) { paramOverrides.workerMinTotalPx = 1; paramOverrides.workerMinPxFrame = 1; paramOverrides.workerMinFrames = 1; }
      else { delete paramOverrides.workerMinTotalPx; delete paramOverrides.workerMinPxFrame; delete paramOverrides.workerMinFrames; }
      $('logText').textContent = ''; logHistory.length = 0;
    }, { useGpu, shape, workers, ftm, method });
    await page.evaluate(() => run());
    await page.waitForFunction(() => !$('runBtn').disabled && lastResult && lastResult.locs.length, null, { timeout: 600000 });
    return page.evaluate(() => ({ n: lastResult.locs.length, st: lastResult.shapeTest, allPass: lastResult.locs.every(L => L.llr >= paramValue('shapeTestThr')),
      logged: /Shape test \(mean log-likelihood ratio/.test($('logText').textContent) }));
  };
  const off = await localize('off', { useGpu: false, shape: false, workers: false });
  const serial = await localize('serial', { useGpu: false, shape: true, workers: false });
  const pool = await localize('worker pool', { useGpu: false, shape: true, workers: true });
  assert.equal(off.st.enabled, false); assert.equal(off.st.rejected, 0); assert.equal(off.logged, false, 'no shape-test line while it is off');
  assert.ok(serial.n < off.n && serial.st.rejected === off.n - serial.n, `the test drops fits (${off.n} -> ${serial.n}, counted ${serial.st.rejected})`);
  assert.ok(serial.allPass && serial.logged, 'every kept fit passes the threshold and the log reports the test');
  assert.equal(pool.n, serial.n, 'the worker pool keeps exactly the serial path\'s fits');
  const lines = [`  Localize: ${off.n} fits -> ${serial.n} kept (${serial.st.rejected} dropped); worker pool identical`];
  if (gpu.available) {
    for (const method of ['gaussmle', 'mle3d', 'gaussmleEll']) {
      const cpu = await localize('cpu', { useGpu: false, shape: true, workers: false, method });
      const g = await localize('gpu', { useGpu: true, shape: true, workers: true, method });
      assert.ok(g.allPass, `${method}: every GPU fit kept passes the threshold`);
      assert.ok(Math.abs(g.n - cpu.n) <= Math.max(5, 0.001 * cpu.n), `${method}: GPU keeps ${g.n} fits, CPU ${cpu.n}`);
      lines.push(`${method} CPU ${cpu.n} / GPU ${g.n}`);
    }
    const ftmCpu = await localize('ftm cpu', { useGpu: false, shape: true, workers: true, ftm: true });
    const ftmGpu = await localize('ftm gpu', { useGpu: true, shape: true, workers: true, ftm: true });
    assert.ok(ftmCpu.allPass && ftmGpu.allPass && Math.abs(ftmCpu.n - ftmGpu.n) <= Math.max(5, 0.001 * ftmCpu.n), `temporal median: CPU ${ftmCpu.n} vs GPU ${ftmGpu.n}`);
    lines.push(`temporal median CPU ${ftmCpu.n} / GPU ${ftmGpu.n}`);
  }
  console.log(lines.join(' · '));

  // ---- uncalibrated counts: the camera at its defaults, or set but wrong ------------------------
  await page.evaluate(() => {   // a low-gain camera: 20 ADU per photon, so values are far from photons at Gain 1
    for (const [k, v] of Object.entries({ simulation_gain: 0.05, simulation_offset: 100, simulation_readnoise: 0.5, simulation_offset_std: 0 })) { const el = $(k); el.value = v; el.dispatchEvent(new Event('change')); }
    $('shapeTest').checked = true; $('shapeTest').dispatchEvent(new Event('change'));
  });
  await page.evaluate(() => runSimulation());
  const camera = (gain, off) => page.evaluate(({ gain, off }) => { for (const [k, v] of [['gain', gain], ['camoffset', off]]) { const el = $(k); el.value = v; el.dispatchEvent(new Event('change')); } }, { gain, off });
  const calib = async (gain, off) => {
    await camera(gain, off);
    await page.evaluate(() => { $('logText').textContent = ''; logHistory.length = 0; });
    await page.evaluate(() => run()); await page.waitForFunction(() => !$('runBtn').disabled && lastResult && lastResult.locs.length, null, { timeout: 600000 });
    return page.evaluate(() => ({ n: lastResult.locs.length, st: lastResult.shapeTest, log: $('logText').textContent, disabled: $('shapeTest').disabled, ticked: $('shapeTest').checked }));
  };
  const tick = () => page.evaluate(() => { $('shapeTest').checked = true; $('shapeTest').dispatchEvent(new Event('change')); });
  // (a) Gain 1 / Camera offset 0: the control is greyed out, the test is not applied, every fit is kept, the live preview shows them
  const def = await calib(1, 0);
  assert.ok(def.disabled && def.ticked && !def.st.enabled && def.st.skipped.reason === 'defaults' && def.n > 0 && /Shape test not applied/.test(def.log),
    `at the defaults the Shape test is greyed out and not applied (kept ${def.n}, ${JSON.stringify(def.st)})`);
  const pvDef = await page.evaluate(async () => { $('liveUpdate').checked = true; await showFrame(20); return $('rawInfo').textContent; });
  assert.ok(!/ 0 locs/.test(pvDef), `the live preview shows its fits at the defaults (${pvDef})`);
  // (b) set but wrong (10x too many photons): the probe skips the test and unticks the box
  const wrong = await calib(0.5, 100);
  assert.ok(!wrong.disabled && wrong.st.skipped && wrong.st.skipped.reason === 'probe' && wrong.st.skipped.median < -3 && wrong.n > 0 && /Shape test skipped/.test(wrong.log) && !wrong.ticked,
    `a wrong but set camera: the probe skips the test and unticks it (kept ${wrong.n}, ${JSON.stringify(wrong.st)}, ticked ${wrong.ticked})`);
  await tick(); await camera(0.5, 100);
  const pvWrong = await page.evaluate(async () => { await showFrame(20); const info = $('rawInfo').textContent; await new Promise(r => setTimeout(r, 400)); return { info, ticked: $('shapeTest').checked }; });
  assert.ok(!/ 0 locs/.test(pvWrong.info) && pvWrong.ticked === false, `the preview also unticks it on a wrong camera (${JSON.stringify(pvWrong)})`);
  // (c) the right camera: ticked again, the test applies
  await camera(0.05, 100); await tick();
  const good = await calib(0.05, 100);
  assert.ok(good.st.skipped === null && good.st.enabled && good.ticked && !good.disabled && !/Shape test skipped|not applied/.test(good.log), 'with the right Gain/Camera offset the test applies');
  console.log(`  uncalibrated counts (20 ADU/photon): at Gain 1 / offset 0 greyed out, ${def.n} fits kept; Gain 0.5 (median llr ${wrong.st.skipped.median.toFixed(1)}) skipped and unticked, ${wrong.n} kept; right settings: test on`);

  // ---- the column survives export, reload and the table -------------------------------------
  await page.evaluate(() => { $('ftmEnabled').checked = false; $('ftmEnabled').dispatchEvent(new Event('change')); });
  await localize('final', { useGpu: false, shape: true, workers: false });
  const io = await page.evaluate(() => {
    const t = buildCsvText(lastResult.locs, lastResult.px, 1.3).parts.join(''), back = parseCsvLocs(t), L = back.locs || back;
    return { header: t.split('\n')[0].includes('"llr"'), n: L.length, d: Math.abs(L[5].llr - lastResult.locs[5].llr), cols: tableColumnInfo(lastResult.locs).cols };
  });
  assert.ok(io.header && io.n === (await page.evaluate(() => lastResult.locs.length)) && io.d < 5e-4 && io.cols.includes('llr'), 'llr: CSV column, reload and table column');
  console.log('  CSV/table: llr column written, reloaded to 3 decimals, listed in View data/filtering');
  // ---- calibration on the simulator's own data: rejections vs the truth ----------------------
  // The overall rate at a given density mixes a miscalibrated statistic with genuine neighbour
  // contamination (the test is meant to reject those). So gate only what is density-independent:
  // the rejection rate on ISOLATED emitters (no other true emitter within ISO_PX = 8 px that frame: a 9x9 window reaches 6.4 px at its corner plus PSF tails; measured 33% rejected at 4-6 px, 2% at 6-8 px, 0% beyond) and a
  // dilute run; the realistic-density rate is reported beside the contamination it should track.
  const audit = async () => {   // Localize with the test off (every fit + its llr), then on (kept + st)
    const all = await localize('audit off', { useGpu: false, shape: false, workers: false });
    const raw = await page.evaluate(() => {
      const thr = paramValue('shapeTestThr'), gt = groundTruthByFrame(groundTruthEvents, stack.nFrames || stack.length || 1e9, 0, 1e9);
      let iso = 0, isoRej = 0, nb = 0, matched = 0, win = 0;
      for (const L of lastResult.locs) {
        const g = (gt.get(L.frame) || []).filter(e => !e.haze); let best = null, bd = 2;
        for (const e of g) { const d = Math.hypot(e.x - L.x, e.y - L.y); if (d < bd) { bd = d; best = e; } }
        if (!best) continue; matched++;
        const near = g.some(e => e !== best && Math.hypot(e.x - best.x, e.y - best.y) < 8), nbWin = g.some(e => e !== best && Math.abs(e.x - best.x) <= 4.5 && Math.abs(e.y - best.y) <= 4.5);
        if (nbWin) win++; if (near) nb++; else { iso++; if (L.llr < thr) isoRej++; }
      }
      return { n: lastResult.locs.length, matched, iso, isoRej, win, rejTotal: lastResult.locs.filter(L => L.llr < thr).length };
    });
    const on = await localize('audit on', { useGpu: false, shape: true, workers: false });
    const kept = await page.evaluate(() => { const v = lastResult.locs.map(L => L.llr).sort((a, b) => a - b); return v[v.length >> 1]; });
    return { all, raw, on, kept };
  };
  const real = await audit();
  const area = await page.evaluate(() => { const w = stack.width || stack.w, h = stack.height || stack.h, px = paramValue('pxnm') / 1000; return { um2: w * h * px * px, px }; });
  const dense = real.raw;
  assert.ok(dense.matched > 0.8 * dense.n, `audit: only ${dense.matched}/${dense.n} fits matched a true emitter within 2 px`);
  assert.ok(dense.iso > 500, `audit: only ${dense.iso} isolated-emitter fits to judge the statistic`);
  const isoRate = dense.isoRej / dense.iso;
  assert.ok(isoRate < 0.03, `shape test rejects ${(100 * isoRate).toFixed(2)}% of fits on ISOLATED emitters (none within 8 px) (${dense.isoRej}/${dense.iso}); `
    + `a calibrated statistic rejects < 3% (measured 0-0.6%), so the statistic itself has drifted`);
  assert.equal(real.on.st.rejected, dense.rejTotal, 'rejected count equals fits whose llr is below the threshold');
  assert.ok(real.kept > -0.6 && real.kept < -0.4, `median llr of kept fits ${real.kept.toFixed(3)} should sit near -0.5, in (-0.6, -0.4)`);
  assert.equal(real.on.st.readNoiseVar, 0.25, `readNoiseVar ${real.on.st.readNoiseVar} should match the simulated camera's 0.5 e- read noise`);
  const lam = real.all.n / 400 / area.um2, poisson = 100 * (1 - Math.exp(-lam * 81 * area.px * area.px)), rate = 100 * real.on.st.rejected / real.all.n, win = 100 * dense.win / dense.matched;
  console.log(`  calibration (dens 0.3): isolated-emitter rejection ${(100 * isoRate).toFixed(2)}% (${dense.isoRej}/${dense.iso}); median kept llr ${real.kept.toFixed(3)}; readNoiseVar ${real.on.st.readNoiseVar.toFixed(2)}; `
    + `overall rejection ${rate.toFixed(1)}% (reported, not gated) vs ${win.toFixed(1)}% of fits with a true neighbour in the 9x9 window (measured from the truth); Poisson expectation 1-exp(-lambda*A) = ${poisson.toFixed(1)}% (lambda ${lam.toFixed(2)}/um2 fitted, A 0.81 um2)`);

  // dilute run: contamination negligible, so the OVERALL rate must be small too
  await page.evaluate(() => {
    for (const [k, v] of Object.entries({ frames: 150, dens: 0.03 })) { const el = $(k); el.value = v; el.dispatchEvent(new Event('change')); }
  });
  await page.evaluate(() => runSimulation());
  const dil = await audit();
  const dilRate = dil.on.st.rejected / dil.all.n;
  assert.ok(dil.all.n > 200, `dilute run: only ${dil.all.n} fits to judge`);
  assert.ok(dilRate < 0.03, `dilute run (dens 0.03): shape test rejects ${(100 * dilRate).toFixed(2)}% of ${dil.all.n} fits; neighbours are negligible, so < 3% expected`);
  console.log(`  calibration (dens 0.03, 150 frames): overall rejection ${(100 * dilRate).toFixed(2)}% of ${dil.all.n} fits, isolated ${dil.raw.isoRej}/${dil.raw.iso}`);

  console.log('Shape test: PASS');
} finally { await browser.close(); }
