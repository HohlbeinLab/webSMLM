#!/usr/bin/env node
// Changing Pixel size while the FRC or NeNA plot is shown recomputes it in the new scale: the resolution, the
// sampling pixel and the Nyquist limit (FRC) and sigma (NeNA) all follow the camera pixel size (positions are in camera px).
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async () => {
    const rnd = mulberry32(8), locs = [];
    for (let i = 0; i < 6000; i++) { const c = i % 60, t = rnd() * 6.28, rad = 4 * Math.sqrt(rnd());
      locs.push({ x: 20 + (c * 7.1) % 60 + Math.cos(t) * rad * 0.1, y: 20 + (c * 3.7) % 60 + Math.sin(t) * rad * 0.1, frame: i % 500, lpx: 0.03, lpy: 0.03, photons: 800, sigma: 1.3, bg: 20, bgstd: 3 }); }
    applyHeadlessResultToSession({ locs, w: 100, h: 100, px: 100, mag: 10 });
    $('mag').value = 10; await rerender(false);
    $('useGpu').checked = false;
    await computeFRC();
    const a = { name: rawPlotName, info: $('rawInfo').textContent };
    const t0 = $('logText').textContent.length;
    $('pxnm').value = 160; $('pxnm').dispatchEvent(new Event('change'));
    for (let i = 0; i < 100 && $('frcBtn').disabled === false && $('logText').textContent.length === t0; i++) await new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 400 && $('frcBtn').disabled; i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 200));
    const logTail = $('logText').textContent.slice(t0);
    return { a, plotAfter: rawPlotName, recomputed: /FRC resolution \(Fourier ring correlation/.test(logTail), px: lastResult.px, info: $('rawInfo').textContent };
  });
  assert.equal(r.a.name, 'frc', 'FRC plot shown');
  assert.ok(r.recomputed, `a pixel size change recomputes the FRC: ${JSON.stringify(r)}`);
  assert.equal(r.px, 160); assert.equal(r.plotAfter, 'frc');
  const res = t => +/res = ([\d.]+)/.exec(t)[1], ratio = res(r.info) / res(r.a.info);
  assert.ok(ratio > 1.3 && ratio < 1.9, `the resolution follows the pixel size (x${ratio.toFixed(2)} for 100 -> 160 nm)`);
  console.log(`  FRC recomputed on a pixel size change (${r.info}, x${ratio.toFixed(2)})`);
  // NeNA: the precision in nm follows the pixel size too.
  const ne = await page.evaluate(async () => {
    $('pxnm').value = 100; $('pxnm').dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 400 && $('frcBtn').disabled; i++) await new Promise(r => setTimeout(r, 50));
    await computeNeNA(); const name = rawPlotName, s1 = lastNena && lastNena.sigma, t0 = $('logText').textContent.length;
    $('pxnm').value = 160; $('pxnm').dispatchEvent(new Event('change'));
    for (let i = 0; i < 400 && (lastNena.sigma === s1); i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 200));
    return { name, s1, s2: lastNena.sigma, after: rawPlotName, recomputed: /NeNA precision \(nearest-neighbour/.test($('logText').textContent.slice(t0)) };
  });
  assert.equal(ne.name, 'nena'); assert.equal(ne.after, 'nena'); assert.ok(ne.recomputed, `NeNA recomputed: ${JSON.stringify(ne)}`);
  assert.ok(ne.s2 / ne.s1 > 1.3 && ne.s2 / ne.s1 < 1.9, `NeNA sigma follows the pixel size: ${ne.s1} -> ${ne.s2}`);
  console.log(`  NeNA recomputed on a pixel size change (sigma ${ne.s1.toFixed(1)} -> ${ne.s2.toFixed(1)} nm)`);
  console.log('FRC/NeNA pixel size: PASS');
} finally { await browser.close(); }
