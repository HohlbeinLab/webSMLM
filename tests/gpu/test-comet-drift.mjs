#!/usr/bin/env node
// COMET drift (driftMethod 'comet'), CPU and GPU cost kernels: recovers known drift (slow + a step + fast vibration) in 2D and, with z, in 3D;
// stays stable at a few tens of localizations per window; thins the localizations above the pair cap; a Stop applies
// nothing; the corrected positions keep x0/y0/z0; the sidebar shows the method's own rows.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async () => {
    const rnd = mulberry32(5), g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    const F = 1500, A = 5000, px = 100, N = 40000, sig = 12;
    const fil = Array.from({ length: 30 }, () => { const a = rnd() * 6.28; return { cx: rnd() * A, cy: rnd() * A, cz: (rnd() - 0.5) * 600, dx: Math.cos(a), dy: Math.sin(a), L: 1500 + rnd() * 2000 }; });
    const drift = f => ({ x: 35 * Math.sin(2 * Math.PI * f / 1200) + (f > 700 ? 12 : 0) + 0.01 * f + 4 * Math.sin(2 * Math.PI * f / 23), y: 25 * Math.cos(2 * Math.PI * f / 900) - 0.006 * f, z: 0.03 * f + 15 * Math.sin(2 * Math.PI * f / 800) });
    const base = [];
    for (let i = 0; i < N; i++) { const f = (rnd() * F) | 0, fl = fil[(rnd() * fil.length) | 0], t = (rnd() - 0.5) * fl.L, d = drift(f);
      base.push({ x: (fl.cx + fl.dx * t + sig * g() + d.x) / px, y: (fl.cy + fl.dy * t + sig * g() + d.y) / px, z: fl.cz + 25 * g() + d.z, frame: f }); }
    const mk = withZ => base.map(l => ({ ...l, z: withZ ? l.z : NaN }));
    const truth = Array.from({ length: F }, (_, f) => drift(f));
    const rms = (est, key, scale) => { let m = 0; for (let f = 0; f < F; f++) m += -est[f] * scale - truth[f][key]; m /= F; let s = 0; for (let f = 0; f < F; f++) { const e = -est[f] * scale - truth[f][key] - m; s += e * e; } return Math.sqrt(s / F); };
    const run = async (locs, cfg, hooks = {}) => driftCore(locs, px, { driftMethod: 'comet', driftCometRadius: 300, driftCometMinLocs: 0, driftZ: true, driftCometSeg: 10, driftCometSigma: 8, driftCometMaxPairs: 40, ...cfg }, { onLog: () => {}, onProgress: () => {}, ...hooks });
    const out = {};
    let locs = mk(false), t0 = performance.now(), d = await run(locs, {});
    out.d2 = { x: rms(d.drift.fdx, 'x', px), y: rms(d.drift.fdy, 'y', px), ms: Math.round(performance.now() - t0), has3d: !!d.drift.fdz, keep: locs[0].x0 !== undefined && locs[0].x0 !== locs[0].x };
    locs = mk(false); d = await run(locs, { driftCometSeg: 3 });
    out.sparse = { x: rms(d.drift.fdx, 'x', px), y: rms(d.drift.fdy, 'y', px), win: d.drift.nSeg };
    locs = mk(true); d = await run(locs, {});
    out.d3 = { x: rms(d.drift.fdx, 'x', px), z: rms(d.drift.fdz, 'z', 1), z0: locs[0].z0 !== undefined };
    { const lw = mk(false), logs = []; const dw = await run(lw, { driftCometRadius: 40 }, { onLog: m => logs.push(m) }); out.warn = logs.some(l => /!!! The estimated drift spans/.test(l)) || rms(dw.drift.fdx, 'x', px) > 5;
      const lm = mk(false), dm = await run(lm, { driftCometSeg: 2, driftCometMinLocs: 400 }); out.minLocs = { windows: dm.drift.nSeg, x: rms(dm.drift.fdx, 'x', px) };
      const l0 = mk(false), d0 = await run(l0, { driftCometSeg: 2, driftCometMinLocs: 0 }); out.noMin = d0.drift.nSeg; }
    locs = mk(false); const logs = []; d = await run(locs, { driftCometMaxPairs: 3 }, { onLog: m => logs.push(m) });
    out.capped = { x: rms(d.drift.fdx, 'x', px), pairs: d.drift.pairs, thinned: logs.some(l => /to stay under/.test(l)) };
    // GPU cost kernel against the CPU one (same data, same settings), and the progress bar
    { const lc = mk(false), lg = mk(false), logs = [], prog = [];
      const dc = await run(lc, { useGpu: false }), dg = await run(lg, { useGpu: true }, { onLog: m => logs.push(m), onProgress: v => prog.push(v) });
      let md = 0; for (let f = 0; f < F; f++) md = Math.max(md, Math.abs(dc.drift.fdx[f] - dg.drift.fdx[f]) * px, Math.abs(dc.drift.fdy[f] - dg.drift.fdy[f]) * px);
      out.gpu = { x: rms(dg.drift.fdx, 'x', px), y: rms(dg.drift.fdy, 'y', px), maxDiffNm: md, onGpu: logs.some(l => /cost on the GPU/.test(l)), evals: dg.drift.evals,
        prog: { n: prog.length, last: prog[prog.length - 1], monotone: prog.every((v, i) => i === 0 || v >= prog[i - 1] - 1e-9), max: Math.max(...prog) } };
      const l3 = mk(true), d3g = await run(l3, { useGpu: true }); out.gpu3 = { x: rms(d3g.drift.fdx, 'x', px), z: rms(d3g.drift.fdz, 'z', 1) }; }
    locs = mk(false); let n = 0; d = await run(locs, {}, { shouldStop: () => ++n > 3 });
    out.stop = { stopped: d.stopped, unchanged: locs.every(l => l.x0 === undefined) };
    out.auto = { value: $('driftCometSigma').value, placeholder: $('driftCometSigma').placeholder, param: paramValue('driftCometSigma') };
    // sidebar rows
    $('driftMethod').value = 'comet'; $('driftMethod').dispatchEvent(new Event('change'));
    const vis = id => $(id).style.display !== 'none';
    out.ui = { comet: vis('driftCometSegRow') && vis('driftCometRadiusRow') && vis('driftCometMinLocsRow') && vis('driftCometSmoothRow') && vis('driftCometSigmaRow') && vis('driftCometPairsRow') && !vis('driftRoiRow'), segHidden: !vis('driftSegRow') };
    $('driftMethod').value = 'aim'; $('driftMethod').dispatchEvent(new Event('change'));
    out.ui.aim = !vis('driftCometSegRow') && vis('driftSegRow') && vis('driftRoiRow');
    return out;
  });
  assert.ok(r.d2.x < 3.5 && r.d2.y < 3.5, `2D drift recovered: ${JSON.stringify(r.d2)}`);
  assert.ok(!r.d2.has3d && r.d2.keep, 'no z drift without z; positions corrected reversibly');
  assert.ok(r.sparse.x < 8 && r.sparse.y < 8, `stable at ~60 localizations per window: ${JSON.stringify(r.sparse)}`);
  assert.ok(r.d3.x < 3 && r.d3.z < 6 && r.d3.z0, `3D drift recovered: ${JSON.stringify(r.d3)}`);
  assert.ok(r.capped.thinned && r.capped.pairs <= 3.1e6 * 1.5 && r.capped.x < 6, `pair cap thins the localizations: ${JSON.stringify(r.capped)}`);
  assert.ok(r.gpu.onGpu, 'the GPU cost kernel ran');
  assert.ok(r.gpu.x < 3.5 && r.gpu.y < 3.5 && r.gpu.maxDiffNm < 1.5, `GPU = CPU drift: ${JSON.stringify(r.gpu)}`);
  assert.ok(r.gpu3.x < 3.5 && r.gpu3.z < 6, `3D on the GPU: ${JSON.stringify(r.gpu3)}`);
  assert.ok(r.gpu.prog.n >= 15 && r.gpu.prog.monotone && r.gpu.prog.max > 0.9, `progress bar: ${JSON.stringify(r.gpu.prog)}`);
  assert.ok(r.warn, 'a Max drift far below the real drift is reported or visibly poor');
  assert.ok(r.minLocs.windows < r.noMin / 2 && r.minLocs.x < 5, `min localizations per window merges short windows: ${JSON.stringify(r.minLocs)} vs ${r.noMin} windows`);
  assert.ok(r.stop.stopped && r.stop.unchanged, 'Stop applies nothing');
  assert.deepEqual(r.auto, { value: '', placeholder: 'auto', param: 0 }, 'the final length scale starts blank (auto)');
  assert.ok(r.ui.comet && r.ui.segHidden && r.ui.aim, `sidebar rows: ${JSON.stringify(r.ui)}`);
  console.log(`  GPU: RMS ${r.gpu.x.toFixed(2)} / ${r.gpu.y.toFixed(2)} nm, max difference to the CPU curve ${r.gpu.maxDiffNm.toFixed(2)} nm, ${r.gpu.prog.n} progress updates`);
  console.log(`  COMET 2D RMS x ${r.d2.x.toFixed(2)} / y ${r.d2.y.toFixed(2)} nm in ${r.d2.ms} ms; 3-frame windows ${r.sparse.x.toFixed(2)} nm; 3D z ${r.d3.z.toFixed(2)} nm; capped to ${(r.capped.pairs / 1e6).toFixed(1)} M pairs`);
  console.log('COMET drift: PASS');
} finally { await browser.close(); }
