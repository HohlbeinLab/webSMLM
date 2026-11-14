#!/usr/bin/env node
// DME drift (driftMethod 'dme'), fixed bins and the learned temporal prior, CPU and GPU score kernels: recovers a known
// drift (slow + a step + a fast vibration); the learned prior beats fixed bins on it; its cross-fit candidates follow the
// release's dme_prior_estimate (a per-frame candidate and 1-3-frame segments when there are enough localizations, one AIM
// start per checkerboard half), on the full set and on half of it; GPU = CPU drift; a Stop applies
// nothing; the corrected positions keep x0/y0; the sidebar shows the method's own rows. The GPU half is skipped (and
// reported) without a WebGPU adapter.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async () => {
    const rnd = mulberry32(11), g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    const F = 2000, A = 6000, px = 100, sig = 10;
    // DNA-origami-like clusters, each site seen in several short binding events
    const sites = []; for (let k = 0; k < 400; k++) { const cx = rnd() * A, cy = rnd() * A; for (let s = 0; s < 6; s++) sites.push([cx + (s % 3) * 20, cy + Math.floor(s / 3) * 20]); }
    const drift = f => ({ x: 30 * Math.sin(2 * Math.PI * f / 1700) + (f > 1100 ? 15 : 0) + 6 * Math.sin(2 * Math.PI * f / 150), y: 20 * Math.cos(2 * Math.PI * f / 1300) - 0.008 * f });
    const base = [];
    for (const [sx, sy] of sites) for (let e = 0; e < 12; e++) { const f0 = (rnd() * F) | 0, len = 1 + ((rnd() * 4) | 0);
      for (let f = f0; f < Math.min(F, f0 + len); f++) { const d = drift(f); base.push({ x: (sx + sig * g() + d.x) / px, y: (sy + sig * g() + d.y) / px, z: NaN, frame: f, lpx: sig / px, lpy: sig / px }); } }
    const mk = () => base.map(l => ({ ...l }));
    const truth = Array.from({ length: F }, (_, f) => drift(f));
    const rms = (est, key) => { let m = 0; for (let f = 0; f < F; f++) m += -est[f] * px - truth[f][key]; m /= F; let s = 0; for (let f = 0; f < F; f++) { const e = -est[f] * px - truth[f][key] - m; s += e * e; } return Math.sqrt(s / F); };
    const run = (locs, cfg, hooks = {}) => driftCore(locs, px, { driftMethod: 'dme', useGpu: false, ...cfg }, { onLog: () => {}, onProgress: () => {}, ...hooks });
    const out = { n: base.length };
    let locs = mk(), t0 = performance.now(), d = await run(locs, { driftDmeMode: 'bins' });
    out.bins = { x: rms(d.drift.fdx, 'x'), y: rms(d.drift.fdy, 'y'), ms: Math.round(performance.now() - t0), keep: locs[0].x0 !== undefined && locs[0].x0 !== locs[0].x };
    // learned mode counts its AIM starts (aimDrift2D is a global function, so wrapping it reaches dmeDrift's ctx.aimInit)
    const aim0 = aimDrift2D; let nAim = 0; aimDrift2D = (...a) => { nAim++; return aim0(...a); };
    const cands = c => ({ perFrame: c.candidates.some(k => k.kind === 'bins' && k.fpb === 1), perFrameLearned: c.candidates.some(k => k.kind === 'learned' && k.fpb === 1),
      Ls: [...new Set(c.candidates.filter(k => k.kind === 'learned').map(k => k.L))].sort((a, b) => a - b), best: c.best });
    const eligibleLs = n => [1, 2, 3, 6, 12, 24, 48, 96, 192].filter(L => L * n / F >= 30 && Math.ceil(F / L) >= 24);
    try {
      // dense: ~36 localizations per frame, so the per-frame candidate and 1-3-frame segments are eligible
      locs = mk(); const logs = []; t0 = performance.now(); d = await run(locs, { driftDmeMode: 'learned' }, { onLog: m => logs.push(m) });
      out.learned = { x: rms(d.drift.fdx, 'x'), y: rms(d.drift.fdy, 'y'), ms: Math.round(performance.now() - t0), log: logs.find(l => /^DME:/.test(l)),
        aimStarts: nAim, ...cands(d.drift.dmeChoice), expectLs: eligibleLs(base.length) };
      // half the localizations (~18 per frame): no per-frame candidate, segments from 2 frames
      const half = base.filter((_, i) => (mix32(i) >>> 0) / 4294967296 < 0.5);
      locs = half.map(l => ({ ...l })); nAim = 0; t0 = performance.now(); d = await run(locs, { driftDmeMode: 'learned' });
      out.sparse = { n: half.length, x: rms(d.drift.fdx, 'x'), y: rms(d.drift.fdy, 'y'), ms: Math.round(performance.now() - t0),
        aimStarts: nAim, ...cands(d.drift.dmeChoice), expectLs: eligibleLs(half.length) };
    } finally { aimDrift2D = aim0; }
    const eng = await getGpuEngine();
    out.gpuAvailable = !!(eng && eng.available);
    if (out.gpuAvailable) {
      const lc = mk(), lg = mk(), gl = [];
      const dc = await run(lc, { driftDmeMode: 'bins' }), dg = await run(lg, { driftDmeMode: 'bins', useGpu: true }, { onLog: m => gl.push(m) });
      let md = 0; for (let f = 0; f < F; f++) md = Math.max(md, Math.abs(dc.drift.fdx[f] - dg.drift.fdx[f]) * px, Math.abs(dc.drift.fdy[f] - dg.drift.fdy[f]) * px);
      out.gpu = { maxDiffNm: md, onGpu: gl.some(l => /on the GPU/.test(l)) };
      const ll = mk(); const dl = await run(ll, { driftDmeMode: 'learned', useGpu: true }); out.gpuLearned = { x: rms(dl.drift.fdx, 'x'), y: rms(dl.drift.fdy, 'y') };
    }
    locs = mk(); let n = 0; d = await run(locs, { driftDmeMode: 'learned' }, { shouldStop: () => ++n > 40 });
    out.stop = { stopped: d.stopped, unchanged: locs.every(l => l.x0 === undefined) };
    $('driftMethod').value = 'dme'; $('driftMethod').dispatchEvent(new Event('change'));
    const vis = id => $(id).style.display !== 'none';
    out.ui = { dme: vis('driftDmeModeRow') && vis('driftDmeFpbRow') && !vis('driftSegRow') && !vis('driftCometSegRow') && !vis('driftRoiRow') };
    $('driftMethod').value = 'aim'; $('driftMethod').dispatchEvent(new Event('change'));
    out.ui.aim = !vis('driftDmeModeRow') && vis('driftSegRow');
    return out;
  });
  console.log(JSON.stringify(r));
  assert.ok(r.bins.x < 10 && r.bins.y < 10 && r.bins.keep, `fixed bins (~550 frames per knot here) recover the slow drift: ${JSON.stringify(r.bins)}`);
  assert.ok(r.learned.x < 3 && r.learned.y < 3, `learned prior recovers step + vibration: ${JSON.stringify(r.learned)}`);
  assert.ok(r.learned.x < r.bins.x && r.learned.y <= r.bins.y * 1.05, `learned prior beats fixed bins here: bins ${JSON.stringify(r.bins)} learned ${JSON.stringify(r.learned)}`);
  assert.ok(r.learned.perFrame && !r.learned.perFrameLearned, `>= 30 localizations per frame: per-frame candidate (no prior variants): ${JSON.stringify(r.learned)}`);
  assert.deepEqual(r.learned.Ls, r.learned.expectLs, 'dense: learned-prior segment lengths');
  assert.ok(r.learned.Ls[0] === 1, `dense: 1-frame segments eligible: ${JSON.stringify(r.learned.Ls)}`);
  assert.equal(r.learned.aimStarts, 2, 'one AIM start per checkerboard half; later fits and the final fit start from earlier fits');
  assert.ok(!r.sparse.perFrame && r.sparse.Ls[0] === 2, `< 30 localizations per frame: no per-frame candidate, segments from 2 frames: ${JSON.stringify(r.sparse)}`);
  assert.deepEqual(r.sparse.Ls, r.sparse.expectLs, 'sparse: learned-prior segment lengths');
  assert.equal(r.sparse.aimStarts, 2, 'sparse: one AIM start per half');
  assert.ok(r.sparse.x < 4 && r.sparse.y < 4, `learned prior on half the localizations: ${JSON.stringify(r.sparse)}`);
  if (r.gpuAvailable) {
    assert.ok(r.gpu.onGpu && r.gpu.maxDiffNm < 1, `GPU = CPU drift: ${JSON.stringify(r.gpu)}`);
    assert.ok(r.gpuLearned.x < 3 && r.gpuLearned.y < 3, `learned prior on the GPU: ${JSON.stringify(r.gpuLearned)}`);
  } else console.log('SKIP: GPU half (no WebGPU adapter; on headless Linux set WEBSMLM_BROWSER_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan")');
  assert.ok(r.stop.stopped && r.stop.unchanged, `Stop applies nothing: ${JSON.stringify(r.stop)}`);
  assert.ok(r.ui.dme && r.ui.aim, `sidebar rows: ${JSON.stringify(r.ui)}`);
  console.log('PASS test-dme-drift');
} finally { await browser.close(); }
