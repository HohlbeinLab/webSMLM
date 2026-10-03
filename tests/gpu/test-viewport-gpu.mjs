#!/usr/bin/env node
// GPU viewport sampler (gpuViewportInit()/gpuViewportRegion()) against the CPU sampler it mirrors
// (srRenderRegion() + srRegionCanvas()): same colours per sample in 'fixed' (unblurred and blurred) and
// 'precision' mode, with and without depth colour, for strided and edge-touching rects; the display
// maximum from the GPU histogram against displayMax(); a locs set larger than one resident chunk; and
// the interactive path (a viewport reconstruction keeps its locs on the GPU and serves patches from them).
// Skips when WebGPU is unavailable.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const has = await page.evaluate(async () => { const e = await getGpuEngine(); return !!(e && e.available); });
  if (!has) { console.log('  no WebGPU adapter: skipped'); console.log('Viewport GPU: SKIP'); process.exit(0); }
  const rows = await page.evaluate(async () => {
    const rnd = mulberry32(9), W0 = 60, H0 = 45, locs = [];
    for (let i = 0; i < 6000; i++) { const cl = i % 40;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 1.5 - 0.2, y: (cl * 3.1) % H0 + rnd() * 1.5 - 0.2, z: rnd() * 600 - 300,
        lpx: rnd() < 0.1 ? NaN : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }
    locs.push({ x: 0, y: 0, z: 0, lpx: 0.05, lpy: 0.05 }, { x: W0 - 0.01, y: H0 - 0.01, z: 10, lpx: 0.05, lpy: 0.05 });
    const out = [];
    for (const mode of ['fixed', 'precision']) for (const zc of [false, true]) for (const blurPx of [0, 0.5]) for (const mag of [4, 9]) {
      const W = W0 * mag, H = H0 * mag, P = packSrLocs(locs, 'z', zc, mode);
      const params = { W, H, mag, blurPx, zColor: zc, zlo: -200, zhi: 250, renderMode: mode, lutName: 'viridis' };
      const g = await gpuViewportInit(P, mode);
      let worst = 0, badFrac = 0, normRel = 0, n = 0;
      for (const [rx, ry, rw, rh, k] of [[0, 0, W, H, 1], [0, 0, W, H, 3], [17, 9, 101, 77, 1], [5, 11, W - 5, H - 11, 4], [W - 50, H - 40, 50, 40, 2]]) {
        const r = srRenderRegion(P, null, W, H, rx, ry, rw, rh, k, mag, blurPx, zc, -200, 250, mode, 99.9);
        const cpu = srRegionCanvas(r, r.norm, params), gpu = await gpuViewportRegion(g, params, rx, ry, rw, rh, k, 99.9, null);
        const a = cpu.getContext('2d').getImageData(0, 0, cpu.width, cpu.height).data, b = gpu.canvas.getContext('2d').getImageData(0, 0, gpu.canvas.width, gpu.canvas.height).data;
        if (a.length !== b.length) throw new Error('size mismatch');
        let bad = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); if (d > worst) worst = d; if (d > 12) bad++; }
        badFrac = Math.max(badFrac, bad / (a.length / 4)); normRel = Math.max(normRel, Math.abs(gpu.norm - r.norm) / Math.max(1e-6, r.norm)); n++;
      }
      gpuViewportFree(g);
      out.push({ label: `${mode} z=${zc} blur=${blurPx} mag=${mag}`, worst, badFrac, normRel });
    }
    return out;
  });
  for (const r of rows) {
    assert.ok(r.badFrac < 0.002, `${r.label}: ${(r.badFrac * 100).toFixed(3)} % of samples differ by > 12 levels (worst ${r.worst})`);
    assert.ok(r.normRel < 0.03, `${r.label}: display maximum differs by ${(r.normRel * 100).toFixed(1)} %`);
  }
  console.log(`  GPU sampler = CPU sampler in ${rows.length} cases (worst fraction differing ${(Math.max(...rows.map(r => r.badFrac)) * 100).toFixed(3)} %, worst display-max diff ${(Math.max(...rows.map(r => r.normRel)) * 100).toFixed(2)} %)`);

  // Several resident chunks: shrink the chunk size via the engine limit so 20000 locs span many chunks.
  const chunked = await page.evaluate(async () => {
    const rnd = mulberry32(3), n = 20000, locs = [];
    for (let i = 0; i < n; i++) locs.push({ x: rnd() * 80, y: rnd() * 60, z: rnd() * 400, lpx: 0.05, lpy: 0.05 });
    const mag = 6, W = 480, H = 360, P = packSrLocs(locs, 'z', true, 'precision');
    const params = { W, H, mag, blurPx: 0.3, zColor: true, zlo: 0, zhi: 400, renderMode: 'precision', lutName: 'viridis' };
    const eng = await getGpuEngine(), saved = eng.limits.maxStorageBufferBindingSize;
    const g1 = await gpuViewportInit(P, 'precision');
    eng.limits.maxStorageBufferBindingSize = 16 * 3000;   // 3000 locs per chunk
    const g2 = await gpuViewportInit(P, 'precision'); eng.limits.maxStorageBufferBindingSize = saved;
    const a = await gpuViewportRegion(g1, params, 0, 0, W, H, 2, 99.9, null), b = await gpuViewportRegion(g2, params, 0, 0, W, H, 2, 99.9, null);
    const da = a.canvas.getContext('2d').getImageData(0, 0, a.canvas.width, a.canvas.height).data, db = b.canvas.getContext('2d').getImageData(0, 0, b.canvas.width, b.canvas.height).data;
    let bad = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 12) bad++;
    const r = { chunks1: g1.chunks.length, chunks2: g2.chunks.length, bad: bad / (da.length / 4) }; gpuViewportFree(g1); gpuViewportFree(g2); return r;
  });
  assert.equal(chunked.chunks1, 1); assert.ok(chunked.chunks2 >= 7, `chunks ${chunked.chunks2}`); assert.ok(chunked.bad < 0.002, `chunked vs single ${chunked.bad}`);
  console.log(`  ${chunked.chunks2} resident chunks give the same image as one`);

  // Interactive: a 30000-px-wide panel is a viewport reconstruction served from the GPU; a zoomed patch comes from it too.
  const vp = await page.evaluate(async () => {
    const locs = [], rnd = mulberry32(3);
    for (let i = 0; i < 20000; i++) locs.push({ x: rnd() * 3000, y: rnd() * 40, frame: 0, lpx: 0.05, lpy: 0.05, photons: 500 });
    applyHeadlessResultToSession({ locs, w: 3000, h: 40, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false);
    await new Promise(r => setTimeout(r, 400));
    const info = { viewport: !!srFull._viewport, gpu: !!srFull.gpu, w: srFull.width, ov: srFull.overview.width };
    view.zoom = 2; view.cx = 15000; view.cy = 200; clampView(); drawView();
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 600));
    info.patch = srFull.patch && { k: srFull.patch.k, w: srFull.patch.img.width };
    return info;
  });
  assert.ok(vp.viewport && vp.gpu, `viewport served from the GPU: ${JSON.stringify(vp)}`);
  assert.ok(vp.patch && vp.patch.k === 1, `native patch from the GPU: ${JSON.stringify(vp.patch)}`);
  console.log(`  30000 px wide panel: GPU viewport, overview ${vp.ov} px, patch at k=${vp.patch.k}`);
  // The whole-image 'precision' GPU render (integer atomics, no compare-and-swap) against the CPU render, with and
  // without depth colour, and an appended second batch of locs (the cache's incremental path).
  const prec = await page.evaluate(async () => {
    const rnd = mulberry32(21), mk = n => Array.from({ length: n }, () => ({ x: rnd() * 80, y: rnd() * 60, z: rnd() * 600 - 300, lpx: 0.02 + rnd() * 0.08, lpy: 0.02 + rnd() * 0.08 }));
    const a = mk(6000), all = a.concat(mk(3000)), eng = await getGpuEngine(), out = [];
    const cmp = (c1, c2) => { const d1 = c1.getContext('2d').getImageData(0, 0, c1.width, c1.height).data, d2 = c2.getContext('2d').getImageData(0, 0, c2.width, c2.height).data;
      let bad = 0; for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]) > 24) bad++; return bad / (d1.length / 4); };
    for (const zc of [false, true]) {
      destroyGpuAccumCache();
      const args = locs => [locs, 80, 60, 6, 0.4, 'viridis', 99.9, zc, -300, 300, locs, 'z'];
      const g1 = await renderSuperResGpu(eng, ...args(a), 'precision'), c1 = await renderSuperRes(...args(a), () => {}, 'precision', 0, false);
      const g2 = await renderSuperResGpu(eng, ...args(all), 'precision'), c2 = await renderSuperRes(...args(all), () => {}, 'precision', 0, false);   // appended
      out.push({ zc, first: cmp(g1, c1), appended: cmp(g2, c2) });
    }
    return out;
  });
  for (const r of prec) assert.ok(r.first < 0.002 && r.appended < 0.002, `precision whole-image GPU vs CPU (z=${r.zc}): ${JSON.stringify(r)}`);
  console.log('  whole-image precision render: GPU = CPU, with depth colour and an appended batch');
  // An 8000×8000 px image (a 256 MB accumulator, over the default 128 MiB buffer) is drawn per view from the GPU,
  // not rendered whole on the CPU; a small one stays a whole-image render.
  const big = await page.evaluate(async () => {
    const rnd = mulberry32(4), locs = [];
    for (let i = 0; i < 30000; i++) locs.push({ x: rnd() * 800, y: rnd() * 800, frame: 0, lpx: 0.05, lpy: 0.05, photons: 500 });
    applyHeadlessResultToSession({ locs, w: 800, h: 800, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false); await new Promise(r => setTimeout(r, 300));
    const a = { viewport: !!srFull._viewport, gpu: !!srFull.gpu, w: srFull.width };
    $('mag').value = 2; await rerender(false); await new Promise(r => setTimeout(r, 300));
    return { a, small: { viewport: !!srFull._viewport, w: srFull.width } };
  });
  assert.ok(big.a.viewport && big.a.gpu && big.a.w === 8000, `8000 px image: ${JSON.stringify(big.a)}`);
  assert.ok(!big.small.viewport && big.small.w === 1600, `1600 px image: ${JSON.stringify(big.small)}`);
  console.log('  8000×8000 px image: viewport reconstruction on the GPU; 1600×1600 px: whole image');
  console.log('Viewport GPU: PASS');
} finally { await browser.close(); }
