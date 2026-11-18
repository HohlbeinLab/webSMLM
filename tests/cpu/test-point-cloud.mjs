#!/usr/bin/env node
// Point-cloud display (Render as = Point cloud), CPU path: pcRenderRegion() over the grid index
// (pcBuildGridCpu()) against the bitmap render (srAccumulate() + blurInto()) and against itself.
//  (a) at one output px per render px on whole-pixel origins the frame equals the bitmap, in every render
//      mode, with and without depth colour, for frames inside, across and beyond the image edges
//      ('fixed' with blur away from the edges: the point cloud does not mirror at the image edge);
//  (b) zoomed in by s×s, block sums of a 'precision' frame equal the bitmap's pixels;
//  (d) with Max points drawn below the visible count the subset is the same in two draws, the drawn
//      fraction is cap/V and the total brightness equals the uncapped frame's within sampling noise;
//  (e) the cells a frame reads hold every loc whose splat reaches it (pcVisibleLocs() vs brute force);
//  (f) locs added in batches (sorted grid + unsorted tail, several folds) give the frames, candidates and
//      capped subset of a single index over all of them, and folding the tail gives that index exactly;
//  (g) a Run in point-cloud mode on a small simulated movie (tests/lib/point-cloud-run.mjs) draws point-cloud
//      frames while it runs, renders no bitmap preview, and ends on the image a fresh point cloud gives;
//      Bitmap mode still previews the bitmap;
// and the interactive panel: a reconstruction gets a point-cloud frame at the panel's resolution, a new
// one after zooming, none with Render as = Bitmap. (c), GPU = CPU, is tests/gpu/test-point-cloud-gpu.mjs.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';
import { pointCloudRunCheck, assertPointCloudRun } from '../lib/point-cloud-run.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  await page.evaluate(() => { $('useGpu').checked = false; $('useGpu').dispatchEvent(new Event('change')); });
  const a = await page.evaluate(() => {
    const rnd = mulberry32(7), W0 = 60, H0 = 45, locs = [];
    for (let i = 0; i < 5000; i++) { const cl = i % 40;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 1.5 - 0.7, y: (cl * 3.1) % H0 + rnd() * 1.5 - 0.7, z: rnd() * 600 - 300, frame: i,
        lpx: rnd() < 0.1 ? NaN : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }
    locs.push({ x: -0.5, y: -0.5, z: 0, lpx: 0.05, lpy: 0.05 }, { x: W0 - 0.51, y: H0 - 0.51, z: 10, lpx: 0.05, lpy: 0.05 });
    const G = pcBuildGridCpu(locs, W0, H0, 'z'), out = [];
    for (const mode of ['fixed', 'precision', 'dither']) for (const zc of [false, true]) for (const blurPx of [0, 0.25]) for (const mag of [4, 7]) {
      const W = W0 * mag, H = H0 * mag, bmode = mode === 'dither' ? 'precision' : mode;   // dither draws the precision splat
      const P = packSrLocs(locs, 'z', zc, bmode, mag), sg = blurPx * mag * 0.3;
      const acc = bmode === 'precision' ? new Float32Array(W * H) : new Uint16Array(W * H), zacc = zc ? new Float32Array(W * H) : null;
      srAccumulate(P, W, H, 0, 0, W, H, mag, blurPx, zc, -200, 250, bmode, acc, zacc);
      let d = acc, z = zacc;
      const blurred = bmode === 'fixed' && blurPx > 0, rad = blurred ? Math.max(1, Math.ceil(sg * 3)) : 0;
      if (blurred) { d = blur(acc, W, H, sg); if (zc) z = blur(zacc, W, H, sg); }
      const p = { W, H, mag, blurPx, zColor: zc, zlo: -200, zhi: 250, renderMode: mode };
      let maxRel = 0, maxRelZ = 0, compared = 0;
      for (const [x0, y0, ow, oh] of [[0, 0, W, H], [-13, -7, 120, 90], [W - 70, H - 50, 100, 80], [31, 17, 64, 48]]) {
        const r = pcRenderRegion(G, p, x0, y0, 1, ow, oh, Infinity);
        for (let i = 0; i < oh; i++) for (let j = 0; j < ow; j++) {
          const gx = x0 + j, gy = y0 + i, k = i * ow + j;
          const inside = gx >= 0 && gy >= 0 && gx < W && gy < H;
          const ref = inside ? d[gy * W + gx] : 0, refz = inside && z ? z[gy * W + gx] : 0;
          if (inside && rad && (gx < rad || gy < rad || gx >= W - rad || gy >= H - rad)) continue;
          compared++;
          maxRel = Math.max(maxRel, Math.abs(r.dv[k] - ref) / Math.max(1e-3, Math.abs(ref)));
          if (zc) maxRelZ = Math.max(maxRelZ, Math.abs(r.zv[k] - refz) / Math.max(1e-2, Math.abs(refz)));
        }
      }
      out.push({ label: `${mode} z=${zc} blur=${blurPx} mag=${mag}`, maxRel, maxRelZ, compared });
    }
    return out;
  });
  // density to float rounding; the z-sums (signed z, so partly cancelling) to the viewport sampler's 1e-3
  for (const r of a) assert.ok(r.maxRel < 1e-5 && r.maxRelZ < 1e-3, `(a) ${r.label}: point cloud vs bitmap rel. error ${r.maxRel} (z ${r.maxRelZ})`);
  console.log(`  (a) point cloud at 1 px/render px = bitmap in ${a.length} cases (max rel. error density ${Math.max(...a.map(r => r.maxRel)).toExponential(1)}, z-sum ${Math.max(...a.map(r => r.maxRelZ)).toExponential(1)})`);

  const b = await page.evaluate(() => {
    const rnd = mulberry32(11), W0 = 50, H0 = 40, locs = [];
    for (let i = 0; i < 4000; i++) locs.push({ x: rnd() * W0 - 0.5, y: rnd() * H0 - 0.5, z: rnd() * 400, lpx: 0.05 + rnd() * 0.15, lpy: 0.05 + rnd() * 0.15, frame: i });
    const G = pcBuildGridCpu(locs, W0, H0, 'z'), out = [];
    for (const mag of [5, 8]) for (const zoom of [2, 3, 5]) {
      const W = W0 * mag, H = H0 * mag, P = packSrLocs(locs, 'z', false, 'precision', mag), acc = new Float32Array(W * H);
      srAccumulate(P, W, H, 0, 0, W, H, mag, 0.25, false, 0, 1, 'precision', acc, null);
      const p = { W, H, mag, blurPx: 0.25, zColor: false, zlo: 0, zhi: 1, renderMode: 'precision' };
      const rx = 23, ry = 19, rw = 60, rh = 50, s = 1 / zoom;
      const r = pcRenderRegion(G, p, rx, ry, s, rw * zoom, rh * zoom, Infinity);
      let worst = 0, mx = 0, tot = 0, totRef = 0;
      for (let i = 0; i < rh; i++) for (let j = 0; j < rw; j++) {
        let sum = 0; for (let a = 0; a < zoom; a++) for (let c = 0; c < zoom; c++) sum += r.dv[(i * zoom + a) * rw * zoom + j * zoom + c];
        sum *= s * s;                                 // density per render px -> mass in the block
        const ref = acc[(ry + i) * W + rx + j];
        worst = Math.max(worst, Math.abs(sum - ref)); mx = Math.max(mx, ref); tot += sum; totRef += ref;
      }
      out.push({ label: `mag=${mag} zoom=${zoom}`, worstRel: worst / mx, totalRel: Math.abs(tot - totRef) / totRef });
    }
    return out;
  });
  // within the ±3σ window truncation: the bitmap's window ends on whole render px, the frame's on output px
  for (const r of b) assert.ok(r.worstRel < 5e-3 && r.totalRel < 5e-3, `(b) ${r.label}: block sums vs bitmap ${JSON.stringify(r)}`);
  console.log(`  (b) ${b.length} zoomed-in precision frames: s×s block sums = bitmap (worst ${(Math.max(...b.map(r => r.worstRel)) * 100).toFixed(2)} % of the peak, total within ${(Math.max(...b.map(r => r.totalRel)) * 100).toFixed(3)} %)`);

  const d = await page.evaluate(() => {
    const rnd = mulberry32(5), W0 = 200, H0 = 150, n = 200000, locs = [];
    for (let i = 0; i < n; i++) locs.push({ x: rnd() * W0 - 0.5, y: rnd() * H0 - 0.5, z: 0, lpx: 0.05, lpy: 0.05, frame: i % 1000 });
    const G = pcBuildGridCpu(locs, W0, H0, null), mag = 4, W = W0 * mag, H = H0 * mag, out = [];
    for (const mode of ['precision', 'fixed']) {
      const p = { W, H, mag, blurPx: 0.25, zColor: false, zlo: 0, zhi: 1, renderMode: mode };
      const all = pcRenderRegion(G, p, 0, 0, 2, 400, 300, Infinity), c1 = pcRenderRegion(G, p, 0, 0, 2, 400, 300, 50000), c2 = pcRenderRegion(G, p, 0, 0, 2, 400, 300, 50000);
      let same = true, tA = 0, tC = 0; for (let k = 0; k < all.dv.length; k++) { if (c1.dv[k] !== c2.dv[k]) same = false; tA += all.dv[k]; tC += c1.dv[k]; }
      const pFrac = 50000 / c1.V;
      out.push({ mode, V: c1.V, drawn: c1.drawn, drawn2: c2.drawn, same, frac: c1.drawn / c1.V, pFrac, totalRel: (tC - tA) / tA,
        sd: Math.sqrt((1 - pFrac) / (pFrac * c1.V)), fracSd: Math.sqrt(pFrac * (1 - pFrac) / c1.V) });
    }
    return out;
  });
  for (const r of d) {
    assert.ok(r.same && r.drawn === r.drawn2, `(d) ${r.mode}: two capped draws differ`);
    assert.ok(Math.abs(r.frac - r.pFrac) < 5 * r.fracSd, `(d) ${r.mode}: drawn fraction ${r.frac} vs cap/V ${r.pFrac}`);
    assert.ok(Math.abs(r.totalRel) < 5 * r.sd, `(d) ${r.mode}: total brightness ${r.totalRel} vs sampling noise ${r.sd}`);
  }
  console.log(`  (d) cap 50,000 of ${d[0].V.toLocaleString()} in view: same subset twice, drawn fraction ${d.map(r => r.frac.toFixed(4)).join('/')} (cap/V ${d[0].pFrac.toFixed(4)}), total brightness within ${d.map(r => (r.totalRel * 100).toFixed(2) + ' %').join('/')} (noise ${(d[0].sd * 100).toFixed(2)} %)`);

  const e = await page.evaluate(() => {
    const rnd = mulberry32(3), W0 = 300, H0 = 200, locs = [];
    for (let i = 0; i < 60000; i++) locs.push({ x: rnd() * (W0 + 4) - 2.5, y: rnd() * (H0 + 4) - 2.5, lpx: rnd() < 0.05 ? NaN : rnd() * 0.4, lpy: rnd() * 0.4, frame: i });
    const G = pcBuildGridCpu(locs, W0, H0, null), out = []; let checked = 0;
    for (const mode of ['precision', 'fixed']) for (const mag of [3, 10]) for (const [x0, y0, s, ow, oh] of [
      [0, 0, 4, 300, 200], [100.3, 50.7, 0.05, 400, 300], [-20, -10, 0.5, 300, 200], [W0 * 10 - 150, H0 * 10 - 99, 0.37, 500, 400], [400.5, 222.25, 1, 64, 64]]) {
      const p = { W: W0 * mag, H: H0 * mag, mag, blurPx: 0.6, zColor: false, zlo: 0, zhi: 1, renderMode: mode };
      const q = pcVisibleLocs(G, p, x0, y0, s, ow, oh, false), bf = pcVisibleLocs(G, p, x0, y0, s, ow, oh, true);
      checked++;
      if (q.length !== bf.length || q.some((v, k) => v !== bf[k])) out.push({ mode, mag, x0, y0, s, q: q.length, bf: bf.length });
    }
    return { bad: out, checked, n: G.n, cells: G.GW + 'x' + G.GH };
  });
  assert.equal(e.bad.length, 0, `(e) grid query != brute force: ${JSON.stringify(e.bad)}`);
  console.log(`  (e) grid query = brute force in ${e.checked} frames (${e.n.toLocaleString()} locs, ${e.cells} cells)`);

  const f = await page.evaluate(() => {
    // locs arriving in batches (a Run's previews): grid + tail, folded whenever the tail would pass cap
    const rnd = mulberry32(21), W0 = 120, H0 = 90, n = 40000, locs = [];
    for (let i = 0; i < n; i++) { const cl = i % 50;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 3 - 1.4, y: (cl * 3.1) % H0 + rnd() * 3 - 1.4, z: rnd() * 500 - 250, frame: i >> 4,
        lpx: i > 35000 ? 0.3 : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }   // the last batches widen lpMax
    const one = pcBuildGridCpu(locs, W0, H0, 'z');
    let G = pcBuildGridCpu(locs, W0, H0, 'z', 1500), at = 1500, folds = 0, appends = 0;
    const cap = 4000;
    for (const b of [700, 2300, 5000, 900, 12000, 3100, 8000, 1, 3999]) {
      const pk = pcPackLocs(locs, W0, H0, 'z', at, Math.min(n, at + b)); at = Math.min(n, at + b);
      const fold = (G.tail ? G.tail.n : 0) + pk.n > cap;
      G = pcExtendCpu(G, pk, fold, cap); if (fold) folds++; else appends++;
    }
    G = pcExtendCpu(G, pcPackLocs(locs, W0, H0, 'z', at, n), false, Infinity);
    const out = [], tailAtEnd = G.tail.n;
    for (const mode of ['fixed', 'precision']) for (const zc of [false, true]) for (const [x0, y0, s, ow, oh, cp] of [
      [0, 0, 2, 480, 360, Infinity], [-30, -20, 0.7, 300, 200, Infinity], [300.3, 200.6, 0.15, 256, 192, Infinity], [0, 0, 2, 480, 360, 9000], [100, 80, 0.5, 400, 300, 3000]]) {
      const p = { W: W0 * 8, H: H0 * 8, mag: 8, blurPx: 0.3, zColor: zc, zlo: -200, zhi: 200, renderMode: mode };
      const a = pcRenderRegion(one, p, x0, y0, s, ow, oh, cp), b = pcRenderRegion(G, p, x0, y0, s, ow, oh, cp);
      let mx = 0, worst = 0; for (let k = 0; k < a.dv.length; k++) { mx = Math.max(mx, a.dv[k]); worst = Math.max(worst, Math.abs(a.dv[k] - b.dv[k])); }
      out.push({ label: `${mode} z=${zc} s=${s} cap=${cp}`, V: a.V, Vb: b.V, drawn: a.drawn, drawnB: b.drawn, rel: worst / Math.max(mx, 1e-30), capped: cp < a.V });
    }
    // folding the tail gives exactly the single index (the same sorted order)
    const F = pcFoldCpu(G, []); let same = F.n === one.n && !F.tail;
    for (const key of ['cellStart', 'x', 'y', 'c', 'lpx', 'lpy', 'rank']) for (let k = 0; same && k < one[key].length; k++) if (F[key][k] !== one[key][k]) same = false;
    return { out, folds, appends, tailAtEnd, same, lpMax: [G.lpMax, one.lpMax], n: one.n };
  });
  assert.ok(f.folds >= 2 && f.appends >= 2 && f.tailAtEnd > 0, `(f) batches: ${JSON.stringify({ folds: f.folds, appends: f.appends, tail: f.tailAtEnd })}`);
  assert.equal(f.lpMax[0], f.lpMax[1], '(f) lpMax of the grown index');
  for (const r of f.out) {
    assert.ok(r.V === r.Vb && r.drawn === r.drawnB, `(f) ${r.label}: candidates/drawn ${r.V}/${r.drawn} single vs ${r.Vb}/${r.drawnB} grown`);
    assert.ok(r.rel < 1e-5, `(f) ${r.label}: grown index frame vs single index rel. error ${r.rel}`);
  }
  assert.ok(f.same, '(f) folding the tail does not give the single index');
  const fc = f.out.filter(r => r.capped);
  console.log(`  (f) ${f.n.toLocaleString()} locs added in 11 batches (${f.folds} folds, ${f.tailAtEnd.toLocaleString()} left in the tail): ${f.out.length} frames = the single index's (max rel. error ${Math.max(...f.out.map(r => r.rel)).toExponential(1)}), same candidates and the same capped subset (${fc.map(r => r.drawn + '/' + r.V).join(', ')}); folding the tail = the single index exactly`);

  const ui = await page.evaluate(async () => {
    const locs = [], rnd = mulberry32(9);
    for (let i = 0; i < 30000; i++) locs.push({ x: rnd() * 120, y: rnd() * 90, frame: i, lpx: 0.05, lpy: 0.05, photons: 500 });
    $('renderAs').value = 'pointCloud'; $('renderAs').dispatchEvent(new Event('change'));
    applyHeadlessResultToSession({ locs, w: 120, h: 90, px: 100, mag: 8 });
    $('mag').value = 8; await rerender(false);
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 800));
    const d = $('sr'), f0 = srFull._pc && srFull._pc.frame;
    const info = { pc: !!srFull._pc, where: srFull._pc && srFull._pc.index.where, frame: f0 && { w: f0.img.width, h: f0.img.height }, panel: { w: d.width, h: d.height } };
    view.zoom *= 6; view.cx = 400; view.cy = 300; clampView(); drawView();
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 800));
    const f1 = srFull._pc.frame; info.zoomed = { s: f1.s, matches: f1.x0 === view.cx - d.clientWidth / view.zoom / 2 };
    // one device px per render px on whole pixels (default Fixed blur, away from the image edges): the
    // frame's colours equal the bitmap canvas's, display maximum included
    const dpr = d.width / d.clientWidth;
    view.zoom = 1 / dpr; view.cx = d.clientWidth / view.zoom / 2 + 37; view.cy = d.clientHeight / view.zoom / 2 + 21; drawView();
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 800));
    const f2 = srFull._pc.frame, ow = f2.img.width, oh = f2.img.height, t = document.createElement('canvas'); t.width = ow; t.height = oh;
    t.getContext('2d').drawImage(f2.img, 0, 0);
    const pa = t.getContext('2d').getImageData(0, 0, ow, oh).data, ba = srFull.getContext('2d').getImageData(f2.x0, f2.y0, ow, oh).data;
    let bad = 0; for (let k = 0; k < pa.length; k += 4) if (Math.max(Math.abs(pa[k] - ba[k]), Math.abs(pa[k + 1] - ba[k + 1]), Math.abs(pa[k + 2] - ba[k + 2])) > 2) bad++;
    info.same = { s: f2.s, x0: f2.x0, y0: f2.y0, badFrac: bad / (pa.length / 4), norm: srImageNorm(srFull) };
    $('renderAs').value = 'bitmap'; $('renderAs').dispatchEvent(new Event('change')); await rerender(true);
    info.bitmap = { pc: !!srFull._pc, index: !!_pcIndex };
    $('renderAs').value = 'pointCloud'; $('renderAs').dispatchEvent(new Event('change'));
    // a viewport bitmap (30000 px wide) gets a point cloud too, coloured with the overview's display maximum
    const wide = []; for (let i = 0; i < 20000; i++) wide.push({ x: rnd() * 3000, y: rnd() * 40, frame: i, lpx: 0.05, lpy: 0.05, photons: 500 });
    applyHeadlessResultToSession({ locs: wide, w: 3000, h: 40, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false);
    await new Promise(r => setTimeout(r, 400));
    view.zoom = 2; view.cx = 15000; view.cy = 200; clampView(); drawView();
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 800));
    info.viewport = { viewport: !!srFull._viewport, frame: !!(srFull._pc && srFull._pc.frame), norm: srFull._pc && srFull._pc.norm, vpNorm: srFull.norm, patch: !!srFull.patch };
    return info;
  });
  assert.ok(ui.pc && ui.frame && ui.frame.w === ui.panel.w && ui.frame.h === ui.panel.h, `panel frame: ${JSON.stringify(ui)}`);
  assert.ok(ui.zoomed.matches && ui.zoomed.s < 0.5, `zoomed frame: ${JSON.stringify(ui.zoomed)}`);
  assert.ok(ui.same.s === 1 && ui.same.norm > 0 && ui.same.badFrac < 0.001, `frame vs bitmap canvas at 1 px/render px: ${JSON.stringify(ui.same)}`);
  assert.ok(!ui.bitmap.pc && !ui.bitmap.index, `Render as = Bitmap: ${JSON.stringify(ui.bitmap)}`);
  assert.ok(ui.viewport.viewport && ui.viewport.frame && ui.viewport.norm === ui.viewport.vpNorm && ui.viewport.norm > 0 && !ui.viewport.patch, `viewport bitmap: ${JSON.stringify(ui.viewport)}`);
  console.log(`  panel: ${ui.frame.w}×${ui.frame.h} px point-cloud frame (${ui.where}), redrawn after zooming (s = ${ui.zoomed.s.toFixed(3)} render px per device px); at 1 px/render px its colours = the bitmap canvas (${(ui.same.badFrac * 100).toFixed(3)} % of px differ by > 2 levels); Bitmap mode drops it; a viewport bitmap gets one with the overview's display max`);
  console.log(assertPointCloudRun(assert, await pointCloudRunCheck(page, { useGpu: false }), 'CPU'));
  console.log('Point cloud (CPU): PASS');
} finally { await browser.close(); }
