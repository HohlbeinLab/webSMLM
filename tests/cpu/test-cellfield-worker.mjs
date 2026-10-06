#!/usr/bin/env node
// The microtubule cell field built in its background worker (buildMicrotubuleStructureAsync())
// gives exactly the same dye sites, in the same order, as the main-thread build, for fixed seeds.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async () => {
    $('simulation_structureType').value = 'microtubules'; $('simulation_structureType').dispatchEvent(new Event('change'));
    const out = [];
    for (const seed of [7, 424242]) {
      $('simulation_mt_seed').value = seed; $('simulation_mt_seed').dispatchEvent(new Event('change'));
      const a = await buildMicrotubuleStructureAsync(72, 72), b = buildMicrotubuleStructure(72, 72);
      let diff = a.length === b.length ? 0 : -1;
      if (!diff) for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) diff++;
      out.push({ seed, n: a.length, diff, worker: !!getCellFieldWorker() });
    }
    return out;
  });
  for (const o of r) {
    assert.ok(o.worker, 'cell-field worker available');
    assert.ok(o.n > 0 && o.diff === 0, `seed ${o.seed}: ${o.n} sites, ${o.diff} differ`);
    console.log(`  seed ${o.seed}: ${o.n.toLocaleString()} sites identical (worker vs main thread)`);
  }
  console.log('Cell-field worker: PASS');
} finally { await browser.close(); }
