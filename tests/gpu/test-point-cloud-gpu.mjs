#!/usr/bin/env node
// Point-cloud display on the GPU (pcGpuBuild()/pcGpuFrame()) against the CPU path it mirrors
// (pcBuildGridCpu()/pcRenderRegion(), tested against the bitmap in tests/cpu/test-point-cloud.mjs):
//  - the GPU index has exactly the CPU index's cell starts;
//  (c) frames agree in density and colour in 'fixed' (with and without blur) and 'precision', with and
//      without depth colour, zoomed out, at one px per render px and zoomed in, across the image edges;
//  (d) with Max points drawn below the visible count both draw the same number of the same candidates;
//  - an index spread over several resident chunks gives the frame of a single chunk;
//  - the interactive panel draws its point cloud from the GPU and keeps up with a zoom.
// Skips when WebGPU is unavailable.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

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
  console.log('Point cloud GPU: PASS');
} finally { await browser.close(); }
