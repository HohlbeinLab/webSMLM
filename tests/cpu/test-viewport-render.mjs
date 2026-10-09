#!/usr/bin/env node
// Viewport reconstruction: srRenderRegion() (every k-th pixel of a rectangle,
// evaluated straight from the locs) must equal the dense whole-image render's
// pixels (srAccumulate() + blurInto()) up to float rounding, in every render
// mode, with and without depth colour and blur, for sub-rectangles touching
// the image edges; the display maximum from a k=1 full pass must equal
// displayMax() of the dense normalization buffer. Then the interactive path:
// a stack whose reconstruction exceeds CANVAS_MAX_DIM renders as a viewport,
// a zoomed-in view gets a native-resolution patch.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const rows = await page.evaluate(() => {
    const rnd = mulberry32(7), W0 = 60, H0 = 45, locs = [];
    for (let i = 0; i < 4000; i++) { const cl = i % 40;
      locs.push({ x: (cl * 7.3) % W0 + rnd() * 1.5 - 0.2, y: (cl * 3.1) % H0 + rnd() * 1.5 - 0.2, z: rnd() * 600 - 300,
        lpx: rnd() < 0.1 ? NaN : 0.02 + rnd() * 0.1, lpy: 0.02 + rnd() * 0.1 }); }
    locs.push({ x: 0, y: 0, z: 0, lpx: 0.05, lpy: 0.05 }, { x: W0 - 0.01, y: H0 - 0.01, z: 10, lpx: 0.05, lpy: 0.05 });
    const sub = locs.filter((L, i) => i % 3 === 0), out = [];
    for (const mode of ['fixed', 'precision', 'dither']) for (const zc of [false, true]) for (const blurPx of [0, 0.25])
      for (const mag of [4, 7]) for (const useNorm of [false, true]) {
        const W = W0 * mag, H = H0 * mag, L = useNorm ? sub : locs, N = useNorm ? locs : null;
        const P = packSrLocs(L, 'z', zc, mode), PN = N ? packSrLocs(N, 'z', zc, 'fixed') : null, s = blurPx * mag * 0.3;
        const acc = mode === 'precision' ? new Float32Array(W * H) : new Uint16Array(W * H), zacc = zc ? new Float32Array(W * H) : null;
        srAccumulate(P, W, H, 0, 0, W, H, mag, blurPx, zc, -200, 250, mode, acc, zacc);
        let d = acc, z = zacc;
        if (mode === 'fixed' && blurPx > 0) { d = blur(acc, W, H, s); if (zc) z = blur(zacc, W, H, s); }
        let maxRel = 0;
        for (const [rx, ry, rw, rh, k] of [[0, 0, W, H, 1], [0, 0, W, H, 3], [17, 9, 101, 77, 1], [5, 11, W - 5, H - 11, 4], [W - 50, H - 40, 50, 40, 2]]) {
          const r = srRenderRegion(P, null, W, H, rx, ry, rw, rh, k, mag, blurPx, zc, -200, 250, mode, null);
          for (let b = 0; b < r.oh; b++) for (let a = 0; a < r.ow; a++) {
            const gi = (ry + b * k) * W + rx + a * k;
            maxRel = Math.max(maxRel, Math.abs(r.dv[b * r.ow + a] - d[gi]) / Math.max(1e-3, Math.abs(d[gi])));
            if (z) maxRel = Math.max(maxRel, Math.abs(r.zv[b * r.ow + a] - z[gi]) / Math.max(1e-2, Math.abs(z[gi])));
          }
        }
        let nb = d;
        if (PN) { const na = new Uint16Array(W * H); srAccumulate(PN, W, H, 0, 0, W, H, mag, blurPx, zc, -200, 250, 'fixed', na, null); nb = blurPx > 0 ? blur(na, W, H, s) : na; }
        const norm = srRenderRegion(P, PN, W, H, 0, 0, W, H, 1, mag, blurPx, zc, -200, 250, mode, 99.9).norm;
        out.push({ label: `${mode} z=${zc} blur=${blurPx} mag=${mag} norm=${useNorm}`, maxRel, norm, dense: displayMax(nb, 99.9) });
      }
    return out;
  });
  for (const r of rows) {
    assert.ok(r.maxRel < 1e-3, `${r.label}: sampler rel. error ${r.maxRel}`);
    assert.ok(Math.abs(r.norm - r.dense) <= 1e-6 * Math.max(1, r.dense), `${r.label}: norm ${r.norm} vs ${r.dense}`);
  }
  console.log(`  sampler = dense render in ${rows.length} cases (max rel. error ${Math.max(...rows.map(r => r.maxRel)).toExponential(1)})`);
  // Interactive: 3000×40 px frame × mag 10 = 30000 px wide -> viewport.
  const vp = await page.evaluate(async () => {
    const locs = []; const rnd = mulberry32(3);
    for (let i = 0; i < 20000; i++) locs.push({ x: rnd() * 3000, y: rnd() * 40, frame: 0, lpx: 0.05, lpy: 0.05, photons: 500 });
    applyHeadlessResultToSession({ locs, w: 3000, h: 40, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false);
    await new Promise(r => setTimeout(r, 400));   // the new frame aspect re-lays out the panels (refit) first
    const info = { viewport: !!srFull._viewport, w: srFull.width, h: srFull.height, ovW: srFull.overview.width };
    view.zoom = 2; view.cx = 15000; view.cy = 200; clampView(); drawView();
    await new Promise(r => setTimeout(r, SR_PATCH_DELAY_MS + 400));
    info.patch = srFull.patch && { k: srFull.patch.k, w: srFull.patch.img.width };
    return info;
  });
  assert.ok(vp.viewport, 'viewport mode'); assert.equal(vp.w, 30000); assert.ok(vp.ovW <= 4096);
  assert.ok(vp.patch && vp.patch.k === 1, `native patch after zoom: ${JSON.stringify(vp.patch)}`);
  console.log(`  30000×400 px reconstruction: viewport, overview ${vp.ovW} px wide, zoomed patch at k=${vp.patch.k}`);
  console.log('Viewport render: PASS');
} finally { await browser.close(); }
