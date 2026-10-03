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
  // The GPU FRC path (taken from 512² sampling up, which needs a sampling pixel of about a fifth of the field of
  // view per 100 sampling px: repeat detections 10 nm apart over a 10 µm field give 2048²): same recompute, same
  // resolution as the CPU path, and the log says which path ran.
  const gpu = await page.evaluate(async () => {
    const eng = await getGpuEngine(); if (!eng || !eng.available) return { skipped: true };
    const rnd = mulberry32(31), locs = [], g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    for (let m = 0; m < 4000; m++) { const x = rnd() * 100, y = rnd() * 100, f = (m * 7) % 400;
      for (let k = 0; k < 3; k++) locs.push({ x: x + 0.1 * g(), y: y + 0.1 * g(), frame: f + k, lpx: 0.1, lpy: 0.1, photons: 800, sigma: 1.3, bg: 20, bgstd: 3 }); }
    applyHeadlessResultToSession({ locs, w: 100, h: 100, px: 100, mag: 10 });
    $('pxnm').value = 100; $('mag').value = 10; await rerender(false);
    const run = async useGpu => { $('useGpu').checked = useGpu; const t0 = $('logText').textContent.length; await computeFRC();
      const tail = $('logText').textContent.slice(t0), m = /FRC execution: (\w+)/.exec(tail), r = /resolution = ([\d.]+)/.exec(tail) || /Nyquist ([\d.]+) nm/.exec(tail);
      return { path: m && m[1], res: r && +r[1], N: (/(\d+)² px/.exec(tail) || [])[1] }; };
    const cpu = await run(false), gp = await run(true);
    $('useGpu').checked = true;
    const t1 = $('logText').textContent.length; $('pxnm').value = 160; $('pxnm').dispatchEvent(new Event('change'));
    for (let i = 0; i < 600 && !/FRC execution/.test($('logText').textContent.slice(t1)); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    const tail = $('logText').textContent.slice(t1);
    return { cpu, gp, after: { path: (/FRC execution: (\w+)/.exec(tail) || [])[1], res: (/resolution = ([\d.]+)/.exec(tail) || [])[1], plot: rawPlotName } };
  });
  if (gpu.skipped) console.log('  no WebGPU adapter: GPU FRC path skipped');
  else {
    assert.equal(gpu.cpu.path, 'cpu'); assert.equal(gpu.gp.path, 'gpu', `the GPU path ran: ${JSON.stringify(gpu)}`);
    assert.ok(Math.abs(gpu.gp.res - gpu.cpu.res) / gpu.cpu.res < 0.02, `GPU = CPU resolution: ${gpu.gp.res} vs ${gpu.cpu.res}`);
    assert.equal(gpu.after.path, 'gpu', `recomputed on the GPU after a pixel size change: ${JSON.stringify(gpu.after)}`);
    assert.ok(+gpu.after.res / gpu.gp.res > 1.3 && +gpu.after.res / gpu.gp.res < 1.9, `GPU FRC follows the pixel size: ${gpu.gp.res} -> ${gpu.after.res}`);
    console.log(`  GPU FRC (${gpu.gp.N}² px): ${gpu.gp.res} nm = CPU ${gpu.cpu.res} nm; after 100 -> 160 nm px: ${gpu.after.res} nm, recomputed on the GPU`);
  }
  console.log('FRC/NeNA pixel size: PASS');
} finally { await browser.close(); }
