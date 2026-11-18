#!/usr/bin/env node
// Point-cloud display on the GPU (pcGpuBuild()/pcGpuFrame()) against the CPU path it mirrors
// (pcBuildGridCpu()/pcRenderRegion(), tested against the bitmap in tests/cpu/test-point-cloud.mjs):
//  - the GPU index has exactly the CPU index's cell starts;
//  (c) frames agree in density and colour in 'fixed' (with and without blur) and 'precision', with and
//      without depth colour, zoomed out, at one px per render px and zoomed in, across the image edges;
//  (d) with Max points drawn below the visible count both draw the same number of the same candidates;
//  - an index spread over several resident chunks gives the frame of a single chunk;
//  (f) locs added in batches (pcGpuExtend(): tail written after the grid, several folds on the GPU, chunked)
//      give exactly the density, candidates and capped subset of a single GPU index, and the folded index has
//      the CPU index's cell starts;
//  - the interactive panel draws its point cloud from the GPU and keeps up with a zoom;
//  (g) a GPU Run in point-cloud mode draws point-cloud frames while it runs, renders no bitmap preview and
//      ends on the image a fresh point cloud gives (tests/lib/point-cloud-run.mjs).
// Skips when WebGPU is unavailable.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';
import { pointCloudRunCheck, assertPointCloudRun } from '../lib/point-cloud-run.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  const has = await page.evaluate(async () => { const e = await getGpuEngine(); return !!(e && e.available); });
  if (!has) { console.log('  no WebGPU adapter: skipped'); console.log('Point cloud GPU: SKIP'); process.exit(0); }
  const r = await page.evaluate(async () => {
    const eng = await getGpuEngine(), rnd = mulberry32(13), W0 = 160, H0 = 120, locs = [];
    for (let i = 0; i < 40000; i++) { const cl = i % 60;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 2 - 0.9, y: (cl * 3.1) % H0 + rnd() * 2 - 0.9, z: rnd() * 600 - 300, frame: i,
        lpx: rnd() < 0.1 ? NaN : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }
    const G = pcBuildGridCpu(locs, W0, H0, 'z'), g = await pcGpuBuild(eng, pcPackLocs(locs, W0, H0, 'z'));
    let startsEqual = g.cellStart.length === G.cellStart.length;
    for (let k = 0; startsEqual && k < G.cellStart.length; k++) if (g.cellStart[k] !== G.cellStart[k]) startsEqual = false;
    const rows = [];
    for (const mode of ['fixed', 'precision']) for (const zc of [false, true]) for (const blurPx of [0, 0.3]) for (const [x0, y0, s, ow, oh, cap] of [
      [0, 0, 2.5, 512, 384, Infinity], [-20, -15, 1, 400, 300, Infinity], [300.4, 200.6, 0.2, 320, 240, Infinity], [0, 0, 2, 640, 480, 5000]]) {
      const mag = 6, p = { W: W0 * mag, H: H0 * mag, mag, blurPx, zColor: zc, zlo: -200, zhi: 250, renderMode: mode, lutName: 'viridis' };
      const c = pcRenderRegion(G, p, x0, y0, s, ow, oh, cap);
      let norm = 0; for (const v of c.dv) if (v > norm) norm = v; norm *= 0.5;
      const gr = await pcGpuFrame(g, p, x0, y0, s, ow, oh, cap, norm, { density: true });
      const cpuCv = srRegionCanvas(c, norm, p);
      const a = cpuCv.getContext('2d').getImageData(0, 0, ow, oh).data, b = gr.canvas.getContext('2d').getImageData(0, 0, ow, oh).data;
      let bad = 0, worst = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); if (d > worst) worst = d; if (d > 12) bad++; }
      // f32 positions on the GPU: a loc within ~1e-4 camera px of a bin edge can land in the next output px
      let tc = 0, tg = 0, mx = 0, dBad = 0; for (let k = 0; k < c.dv.length; k++) { tc += c.dv[k]; tg += gr.density[k]; mx = Math.max(mx, c.dv[k]); }
      for (let k = 0; k < c.dv.length; k++) if (Math.abs(c.dv[k] - gr.density[k]) > 1e-3 * mx) dBad++;
      rows.push({ label: `${mode} z=${zc} blur=${blurPx} s=${s} cap=${cap}`, badFrac: bad / (a.length / 4), worst, densBad: dBad / c.dv.length, totalRel: Math.abs(tg - tc) / tc,
        V: c.V, Vg: gr.V, drawn: c.drawn, drawnG: gr.drawn, capped: cap < c.V });
    }
    pcGpuFree(g);
    return { startsEqual, n: G.n, rows };
  });
  assert.ok(r.startsEqual, 'GPU index cell starts differ from the CPU index');
  console.log(`  GPU index of ${r.n.toLocaleString()} locs: cell starts = CPU index`);
  for (const x of r.rows) {
    assert.ok(x.badFrac < 0.002, `(c) ${x.label}: ${(x.badFrac * 100).toFixed(3)} % of px differ by > 12 levels (worst ${x.worst})`);
    assert.ok(x.densBad < 0.002 && x.totalRel < 1e-3, `(c) ${x.label}: ${x.densBad} of px off by > 0.1 % of the peak, total ${x.totalRel}`);
    assert.ok(x.V === x.Vg, `(c) ${x.label}: candidates CPU ${x.V}, GPU ${x.Vg}`);
    if (x.capped) assert.ok(x.drawn === x.drawnG, `(d) ${x.label}: drawn CPU ${x.drawn}, GPU ${x.drawnG}`);
  }
  const capped = r.rows.filter(x => x.capped);
  console.log(`  (c) GPU frame = CPU frame in ${r.rows.length} cases (worst fraction of px differing ${(Math.max(...r.rows.map(x => x.badFrac)) * 100).toFixed(3)} %, px off by > 0.1 % of the peak in density ${(Math.max(...r.rows.map(x => x.densBad)) * 100).toFixed(3)} %, total within ${(Math.max(...r.rows.map(x => x.totalRel)) * 100).toFixed(3)} %)`);
  console.log(`  (d) capped frames: GPU and CPU draw the same ${capped[0].drawn.toLocaleString()} of ${capped[0].V.toLocaleString()} candidates (${capped.length} cases)`);

  const chunked = await page.evaluate(async () => {
    const eng = await getGpuEngine(), rnd = mulberry32(3), locs = [];
    for (let i = 0; i < 20000; i++) locs.push({ x: rnd() * 80, y: rnd() * 60, z: rnd() * 400, lpx: 0.05, lpy: 0.05, frame: i });
    const pk = pcPackLocs(locs, 80, 60, 'z'), saved = eng.limits.maxStorageBufferBindingSize;
    const g1 = await pcGpuBuild(eng, pk);
    eng.limits.maxStorageBufferBindingSize = 16 * 3000;   // 3000 locs per chunk
    let g2; try { g2 = await pcGpuBuild(eng, pk); } finally { eng.limits.maxStorageBufferBindingSize = saved; }
    const p = { W: 480, H: 360, mag: 6, blurPx: 0.3, zColor: true, zlo: 0, zhi: 400, renderMode: 'precision', lutName: 'viridis' };
    const a = await pcGpuFrame(g1, p, -10, -10, 0.8, 640, 480, Infinity, 1, { density: true }), b = await pcGpuFrame(g2, p, -10, -10, 0.8, 640, 480, Infinity, 1, { density: true });
    let worst = 0, mx = 0; for (let k = 0; k < a.density.length; k++) { worst = Math.max(worst, Math.abs(a.density[k] - b.density[k])); mx = Math.max(mx, a.density[k]); }
    const out = { chunks1: g1.chunks.length, chunks2: g2.chunks.length, rel: worst / mx };
    pcGpuFree(g1); pcGpuFree(g2); return out;
  });
  assert.equal(chunked.chunks1, 1); assert.ok(chunked.chunks2 >= 7, `chunks ${chunked.chunks2}`); assert.ok(chunked.rel < 1e-5, `chunked vs single ${chunked.rel}`);
  console.log(`  ${chunked.chunks2} resident chunks give the frame of one (density within ${chunked.rel.toExponential(1)})`);

  const grown = await page.evaluate(async () => {
    const eng = await getGpuEngine(), rnd = mulberry32(21), W0 = 120, H0 = 90, n = 40000, locs = [];
    for (let i = 0; i < n; i++) { const cl = i % 50;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 3 - 1.4, y: (cl * 3.1) % H0 + rnd() * 3 - 1.4, z: rnd() * 500 - 250, frame: i >> 4,
        lpx: i > 35000 ? 0.3 : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }
    const one = await pcGpuBuild(eng, pcPackLocs(locs, W0, H0, 'z')), saved = eng.limits.maxStorageBufferBindingSize;
    let g, folds = 0, appends = 0, at = 1500;
    eng.limits.maxStorageBufferBindingSize = 16 * 9000;   // 9000 locs per chunk: the grid spans several
    try {
      g = await pcGpuBuild(eng, pcPackLocs(locs, W0, H0, 'z', 0, at));
      for (const b of [700, 2300, 5000, 900, 12000, 3100, 8000, 1, 3999]) {
        const pk = pcPackLocs(locs, W0, H0, 'z', at, Math.min(n, at + b)); at = Math.min(n, at + b);
        const fold = (g.tail ? g.tail.n : 0) + pk.n > 4000;
        await pcGpuExtend(g, pk, fold, 4000); if (fold) folds++; else appends++;
      }
      await pcGpuExtend(g, pcPackLocs(locs, W0, H0, 'z', at, n), false, Infinity);
    } finally { eng.limits.maxStorageBufferBindingSize = saved; }
    const rows = [], tailAtEnd = g.tail ? g.tail.n : 0, chunks = g.chunks.length;
    for (const mode of ['fixed', 'precision']) for (const zc of [false, true]) for (const [x0, y0, s, ow, oh, cp] of [
      [0, 0, 2, 480, 360, Infinity], [-30, -20, 0.7, 300, 200, Infinity], [300.3, 200.6, 0.15, 256, 192, Infinity], [0, 0, 2, 480, 360, 9000], [100, 80, 0.5, 400, 300, 3000]]) {
      const p = { W: W0 * 8, H: H0 * 8, mag: 8, blurPx: 0.3, zColor: zc, zlo: -200, zhi: 200, renderMode: mode, lutName: 'viridis' };
      const a = await pcGpuFrame(one, p, x0, y0, s, ow, oh, cp, 1, { density: true }), b = await pcGpuFrame(g, p, x0, y0, s, ow, oh, cp, 1, { density: true });
      let diff = 0; for (let k = 0; k < a.density.length; k++) if (a.density[k] !== b.density[k]) diff++;
      rows.push({ label: `${mode} z=${zc} s=${s} cap=${cp}`, V: a.V, Vb: b.V, drawn: a.drawn, drawnB: b.drawn, diff, capped: cp < a.V });
    }
    await pcGpuExtend(g, pcPackLocs(locs, W0, H0, 'z', n, n), true, Infinity);   // a final render's fold
    const G = pcBuildGridCpu(locs, W0, H0, 'z');
    let starts = !g.tail && g.n === G.n; for (let k = 0; starts && k < G.cellStart.length; k++) if (g.cellStart[k] !== G.cellStart[k]) starts = false;
    pcGpuFree(one); pcGpuFree(g);
    return { rows, folds, appends, tailAtEnd, chunks, starts, n: G.n };
  });
  assert.ok(grown.folds >= 2 && grown.appends >= 2 && grown.tailAtEnd > 0 && grown.chunks >= 3, `(f) batches: ${JSON.stringify({ ...grown, rows: undefined })}`);
  for (const x of grown.rows) {
    assert.ok(x.V === x.Vb && x.drawn === x.drawnB, `(f) ${x.label}: candidates/drawn ${x.V}/${x.drawn} single vs ${x.Vb}/${x.drawnB} grown`);
    assert.equal(x.diff, 0, `(f) ${x.label}: ${x.diff} px of the grown index's density differ from the single index's`);
  }
  assert.ok(grown.starts, '(f) the folded GPU index has other cell starts than the CPU index');
  console.log(`  (f) ${grown.n.toLocaleString()} locs added in 11 batches on the GPU (${grown.folds} folds, ${grown.chunks} chunks, ${grown.tailAtEnd.toLocaleString()} left in the tail): ${grown.rows.length} frames with exactly the single index's density, candidates and capped subset (${grown.rows.filter(x => x.capped).map(x => x.drawn + '/' + x.V).join(', ')}); folded = the CPU index's cell starts`);

  const ui = await page.evaluate(async () => {
    const locs = [], rnd = mulberry32(9);
    for (let i = 0; i < 50000; i++) locs.push({ x: rnd() * 200, y: rnd() * 150, frame: i, lpx: 0.05, lpy: 0.05, photons: 500 });
    $('useGpu').checked = true; $('useGpu').dispatchEvent(new Event('change'));
    $('renderAs').value = 'pointCloud'; $('renderAs').dispatchEvent(new Event('change'));
    applyHeadlessResultToSession({ locs, w: 200, h: 150, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false);
    await new Promise(r => setTimeout(r, 500));
    const d = $('sr'), pc = srFull._pc, f0 = pc && pc.frame;
    const info = { gpu: !!(pc && pc.index.gpu), frame: f0 && { w: f0.img.width, h: f0.img.height }, panel: { w: d.width, h: d.height } };
    view.zoom *= 8; view.cx = 1000; view.cy = 700; clampView(); drawView();
    await new Promise(r => setTimeout(r, 300));   // a GPU index draws at once, no settle delay
    const f1 = srFull._pc.frame; info.zoomed = { s: f1.s, matches: f1.x0 === view.cx - d.clientWidth / view.zoom / 2 };
    return info;
  });
  assert.ok(ui.gpu && ui.frame && ui.frame.w === ui.panel.w, `GPU panel frame: ${JSON.stringify(ui)}`);
  assert.ok(ui.zoomed.matches, `zoomed GPU frame: ${JSON.stringify(ui.zoomed)}`);
  console.log(`  panel: ${ui.frame.w}×${ui.frame.h} px point-cloud frame from the GPU index, redrawn on zoom (s = ${ui.zoomed.s.toFixed(3)})`);
  console.log(assertPointCloudRun(assert, await pointCloudRunCheck(page, { useGpu: true, method: 'gaussls', frames: 3000 }), 'GPU'));
  console.log('Point cloud GPU: PASS');
} finally { await browser.close(); }
