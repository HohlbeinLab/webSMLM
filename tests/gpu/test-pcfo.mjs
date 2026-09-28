#!/usr/bin/env node
// PCFO (Estimate gain/offset): pcfoJackknife() equals n separate
// pcfoRegress() calls (outliers included, so clipping bounds move per
// removal), and the GPU tile path (pcfoTilePointsGpu()) matches the CPU tile
// statistics and the resulting gain/offset on a simulated movie.
import { launchPage, checkGpu } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless:true });
try {
  const jk = await page.evaluate(() => {
    const rnd = mulberry32(11), pts = [];
    for (let i = 0; i < 700; i++) { const s = 100 + 400 * rnd(); pts.push({ imsig: s, noisevar: 3 * s + 50 + 30 * (rnd() - 0.5) }); }
    for (let i = 0; i < 20; i++) pts.push({ imsig: 100 + 400 * rnd(), noisevar: 1e4 * rnd() });   // hot/dead tiles
    const fast = pcfoJackknife(pts, 2.89), gains = [], offsets = [];
    for (let i = 0; i < pts.length; i++) { const r = pcfoRegress(pts.slice(0, i).concat(pts.slice(i + 1)), 2.89); if (r) { gains.push(1 / r.gain); offsets.push(r.offset); } }
    let d = 0; for (let i = 0; i < gains.length; i++) d = Math.max(d, Math.abs(fast.gains[i] - gains[i]) / Math.abs(gains[i]), Math.abs(fast.offsets[i] - offsets[i]) / Math.max(1, Math.abs(offsets[i])));
    return { n: gains.length, nFast: fast.gains.length, d };
  });
  assert.equal(jk.nFast, jk.n); assert.ok(jk.d < 1e-9, `jackknife max rel. diff ${jk.d}`);
  console.log(`  jackknife: ${jk.n} leave-one-out fits identical (max rel. diff ${jk.d.toExponential(1)})`);
  const gpu = await checkGpu(page);
  if (!gpu.available) { console.log('PCFO: PASS (GPU part skipped: WebGPU unavailable)'); process.exit(0); }
  const r = await page.evaluate(async () => {
    $('frames').value = 60; $('simulation_gain').value = 0.5;
    const st = await generateSynthetic();
    const S = pcfoTileSize(st.w, st.h), idx = pickSeededFrames(st.n, 30, 0xC0FFEE), k = 0.9;
    const engine = await getGpuEngine();
    const cpu = await pcfoTilePointsCpu(st, idx, S, k, () => {}), gpuPts = await pcfoTilePointsGpu(engine, st, idx, S, k, () => {});
    let d = 0; for (let i = 0; i < cpu.length; i++) d = Math.max(d, Math.abs(cpu[i].noisevar - gpuPts[i].noisevar) / cpu[i].noisevar, Math.abs(cpu[i].imsig - gpuPts[i].imsig) / cpu[i].imsig);
    const fc = pcfoRegress(cpu, 2.89), fg = pcfoRegress(gpuPts, 2.89);
    const run = async useGpu => { const t = newStageTimings(); const o = await pcfoCore({ pcfoFrames: 30, pcfoK: k, pcfoRnstd: 2.89, useGpu }, st, { stageTimings: t }); return { gain: o.gain, offset: o.offset, path: t.pcfo.path }; };
    return { nPts: cpu.length, d, gainCpu: 1 / fc.gain, gainGpu: 1 / fg.gain, offCpu: fc.offset, offGpu: fg.offset, coreCpu: await run(false), coreGpu: await run(true) };
  });
  assert.ok(r.d < 1e-4, `tile stats max rel. diff ${r.d}`);
  assert.ok(Math.abs(r.gainGpu - r.gainCpu) / r.gainCpu < 1e-4 && Math.abs(r.offGpu - r.offCpu) < 0.05, JSON.stringify(r));
  assert.equal(r.coreGpu.path, 'gpu'); assert.equal(r.coreCpu.path, 'cpu');
  console.log(`  GPU tiles: ${r.nPts} tiles, max rel. diff ${r.d.toExponential(1)}; gain ${r.gainCpu.toFixed(4)} (CPU) vs ${r.gainGpu.toFixed(4)} (GPU), offset ${r.offCpu.toFixed(2)} vs ${r.offGpu.toFixed(2)}`);
  console.log('PCFO: PASS');
} finally { await browser.close(); }
