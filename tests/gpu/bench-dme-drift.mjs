#!/usr/bin/env node
// DME drift (driftMethod 'dme') runtime on the GPU vs dataset size, both temporal models, on simulated
// origami-like sites with a known drift (slow + 15 nm step + 6 nm vibration with a 150-frame period, as in
// test-dme-drift.mjs). Prints the WebGPU adapter, runtime and RMS error per case.
//
//   node tests/gpu/bench-dme-drift.mjs                 # GPU, 100k / 300k / 1M / 3M localizations
//   node tests/gpu/bench-dme-drift.mjs --cpu           # also time the CPU path on the smallest case
//   node tests/gpu/bench-dme-drift.mjs --sizes=1e5,1e6 --frames=10000 --headed --out=dme.json
import { launchPage } from '../lib/launch.mjs';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const sizes = arg('sizes', '1e5,3e5,1e6,3e6').split(',').map(Number);
const F = Number(arg('frames', '10000'));
const withCpu = process.argv.includes('--cpu'), headed = process.argv.includes('--headed'), out = arg('out', null);

const { browser, page } = await launchPage({ headless: !headed });
try {
  const adapter = await page.evaluate(async () => {
    const e = await getGpuEngine(); const i = e && e.adapterInfo;
    return e && e.available ? { vendor: i?.vendor, architecture: i?.architecture, description: i?.description } : null;
  });
  console.log('WebGPU adapter:', JSON.stringify(adapter));
  if (!adapter) throw new Error('no WebGPU adapter');

  const rows = [];
  const runCase = (n, useGpu, mode) => page.evaluate(async ({ n, F, useGpu, mode }) => {
    const rnd = mulberry32(7), g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    const px = 100, sig = 10, perSite = 12 * 2.5;              // ~12 binding events of 1-4 frames per site
    const nSites = Math.round(n / perSite), A = Math.sqrt(nSites / 6 * 1e6);   // 6 sites per cluster, 1 cluster / um^2
    const drift = f => ({ x: 30 * Math.sin(2 * Math.PI * f / 1700) + (f > F * 0.55 ? 15 : 0) + 6 * Math.sin(2 * Math.PI * f / 150),
                          y: 20 * Math.cos(2 * Math.PI * f / 1300) - 16 * f / F });
    const D = Array.from({ length: F }, (_, f) => drift(f));
    const locs = [];
    for (let k = 0; k < nSites / 6; k++) { const cx = rnd() * A, cy = rnd() * A;
      for (let s = 0; s < 6; s++) { const sx = cx + (s % 3) * 20, sy = cy + Math.floor(s / 3) * 20;
        for (let e = 0; e < 12; e++) { const f0 = (rnd() * F) | 0, len = 1 + ((rnd() * 4) | 0);
          for (let f = f0; f < Math.min(F, f0 + len); f++)
            locs.push({ x: (sx + sig * g() + D[f].x) / px, y: (sy + sig * g() + D[f].y) / px, z: NaN, frame: f, lpx: sig / px, lpy: sig / px }); } } }
    locs.sort((a, b) => a.frame - b.frame);
    const rms = (est, key) => { let m = 0; for (let f = 0; f < F; f++) m += -est[f] * px - D[f][key]; m /= F;
      let s = 0; for (let f = 0; f < F; f++) { const e = -est[f] * px - D[f][key] - m; s += e * e; } return Math.sqrt(s / F); };
    const logs = [], t0 = performance.now();
    const d = await driftCore(locs, px, { driftMethod: 'dme', useGpu, driftDmeMode: mode }, { onLog: m => logs.push(m), onProgress: () => {} });
    const ms = performance.now() - t0;
    return { n: locs.length, F, useGpu, mode, s: ms / 1000, rmsX: rms(d.drift.fdx, 'x'), rmsY: rms(d.drift.fdy, 'y'),
             onGpu: logs.some(l => /on the GPU/.test(l)) && !logs.some(l => /continuing on the CPU|using the CPU/.test(l)),
             log: logs.find(l => /^DME:/.test(l)) };
  }, { n, F, useGpu, mode });

  await runCase(2e4, true, 'bins'); await runCase(2e4, true, 'learned');      // warm-up: shader compilation
  const cases = sizes.flatMap(n => [[n, true, 'bins'], [n, true, 'learned']]);
  if (withCpu) cases.push([sizes[0], false, 'bins'], [sizes[0], false, 'learned']);
  for (const [n, gpu, mode] of cases) {
    const r = await runCase(n, gpu, mode);
    rows.push(r);
    console.log(`N=${String(r.n).padStart(8)} F=${F} ${gpu ? 'GPU' : 'CPU'} ${mode.padEnd(7)} ${r.s.toFixed(2).padStart(7)} s  ` +
      `RMS ${r.rmsX.toFixed(2)} / ${r.rmsY.toFixed(2)} nm${gpu && !r.onGpu ? '  (NOT on the GPU)' : ''}\n    ${r.log}`);
  }
  if (out) writeFileSync(out, JSON.stringify({ adapter, F, rows }, null, 1));
} finally { await browser.close(); }
