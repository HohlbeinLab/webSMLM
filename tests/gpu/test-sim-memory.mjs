#!/usr/bin/env node
// Simulated movies in the memory accounting: the simulated stack reports its cached size (residentBytes) so the Mem
// readout and Localize's memory guards count it, the readout adds the cached PSF kernel, and on a memory-constrained
// (phone-sized) viewport a movie may take only SIM_MOVIE_CONSTRAINED_SHARE of the budget and the simulation and PSF
// worker pools are capped at 2.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const d = await page.evaluate(async () => {
    $('frames').value = 300; $('useGpu').checked = false;
    await runSimulation();
    const out = { n: stack.n, w: stack.w, resident: stack.residentBytes, kernel: psfKernelBytes(), mem: $('memReadout').textContent, title: $('memReadout').title };
    updateMemReadout(); out.mem = $('memReadout').textContent; out.title = $('memReadout').title;
    out.desk5000 = (($('frames').value = 5000), checkSimMovieSize());
    out.deskPool = (await getSimWorkerPool() || []).length;
    return out;
  });
  assert.equal(d.resident, d.n * d.w * d.w * 4, 'the simulated stack reports its cached frames');
  assert.ok(d.kernel > 1e6, `the cached PSF kernel is counted (${d.kernel})`);
  assert.match(d.title, /simulated movie/); assert.match(d.title, /cached simulation PSF kernel/);
  assert.ok(!/~0 MB est/.test(d.mem), `the readout is not empty after a simulation: ${d.mem}`);
  assert.equal(d.desk5000, true, '5000 frames of 128² px are accepted on a desktop');
  console.log(`  simulated stack: ${(d.resident / 1048576).toFixed(0)} MB counted, kernel ${(d.kernel / 1048576).toFixed(0)} MB, readout "${d.mem}"`);
  // Phone-sized viewport (smaller side <= 860 px): budget 0.5 GB, a movie may use half of it.
  await page.setViewportSize({ width: 420, height: 800 });
  await page.reload(); await page.waitForTimeout(1500);
  const m = await page.evaluate(async () => {
    const out = { constrained: isMemoryConstrainedDevice(), budgetGB: paramValue('memBudgetGB') };
    $('frames').value = 5000; out.n5000 = checkSimMovieSize();   // 328 MB > 0.25 GB
    out.log5000 = $('logText').textContent.slice(-400);
    $('frames').value = 1000; out.n1000 = checkSimMovieSize();   // 65 MB
    out.pool = (await getSimWorkerPool() || []).length; out.psfPool = (await getPsfWorkerPool() || []).length;
    return out;
  });
  assert.ok(m.constrained); assert.equal(m.n5000, false, 'the default 5000-frame movie is refused on a phone-sized device');
  assert.match(m.log5000, /!!! Simulate movie: .*can spare for a movie/s);
  assert.equal(m.n1000, true, '1000 frames fit');
  assert.ok(m.pool >= 1 && m.pool <= 2 && m.psfPool >= 1 && m.psfPool <= 2, `pools capped at 2: sim ${m.pool}, PSF ${m.psfPool}`);
  console.log(`  phone-sized viewport: budget ${m.budgetGB} GB, 5000 frames refused, 1000 accepted, pools ${m.pool}/${m.psfPool}`);
  console.log('Simulation memory: PASS');
} finally { await browser.close(); }
