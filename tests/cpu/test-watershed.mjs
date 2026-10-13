#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchPage } from '../lib/launch.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';

const { browser, page } = await launchPage();
try {
  const onePeak = await page.evaluate(() => Array.from(hWatershedLabels(
    Float32Array.from([0, 0, 0, 0, 10, 0, 0, 0, 0]), 3, 3,
    { hMin: 0, threshold: 1, peakFlooding: 100, invert: false },
  )));
  assert.equal(onePeak[4] > 0, true);
  assert.deepEqual(onePeak.map((v, i) => i === 4 ? 1 : v), [0, 0, 0, 0, 1, 0, 0, 0, 0]);

  const intensityCases = await page.evaluate(() => {
    const low = Float32Array.from([10,10,10,10,100,10,10,10,10]);
    const high = Float32Array.from(low, v => 1000 + 4*v);
    const run = (image, hMin, threshold, invert=false) => Array.from(hWatershedLabels(image,3,3,
      { hMin, threshold, peakFlooding:100, invert }));
    return { low:run(low,5,11), high:run(high,20,1044),
      dark:run(Float32Array.from(low, v => 110-v),5,11,true) };
  });
  for(const key of ['low','high','dark'])
    assert.deepEqual(intensityCases[key].map(v=>v?1:0), [0,0,0,0,1,0,0,0,0], key);

  // The published masks use tuned settings, not the macro's current 47 / 1 defaults.
  for (const [dataset, hMin] of [['cas12a-segmentation', 45], ['cas12a-scrambled', 25]]) {
    const brightfield = await resolveDatasetFile(dataset, 'brightfield');
    const mask = await resolveDatasetFile(dataset, 'mask');
    if (!brightfield || !mask) { console.log(`${dataset}: golden mask unavailable; skipped pixel parity`); continue; }
    await page.setInputFiles('#analyzeFileInput', brightfield);
    await page.setInputFiles('#segmentationFileInput', mask);
    const result = await page.evaluate(async hMin => {
      const source = await loadTiffFile(document.getElementById('analyzeFileInput').files[0], () => {});
      const reference = await loadTiffFile(document.getElementById('segmentationFileInput').files[0], () => {});
      const input = (await source.getFrames(0, 1))[0];
      const expected = (await reference.getFrames(0, 1))[0];
      const compare = (h, threshold) => {
        const actual = hWatershedLabels(input, source.w, source.h,
          { hMin:h, threshold, peakFlooding:100, invert:false });
        const forward = new Map(), backward = new Map();
        let mismatches = 0;
        for (let i = 0; i < actual.length; i++) {
          const a = actual[i], b = Math.round(expected[i]);
          if ((a === 0) !== (b === 0)) { mismatches++; continue; }
          if (!a) continue;
          if ((forward.has(b) && forward.get(b) !== a) || (backward.has(a) && backward.get(a) !== b)) { mismatches++; continue; }
          forward.set(b, a); backward.set(a, b);
        }
        return { mismatches, actualCells: backward.size, referenceCells: forward.size };
      };
      return { tuned:compare(hMin,0), macro:compare(47,1) };
    }, hMin);
    assert.equal(result.tuned.mismatches, 0, `${dataset}: ${JSON.stringify(result)}`);
    assert.equal(result.tuned.actualCells, result.tuned.referenceCells, dataset);
    console.log(`${dataset}: ${result.tuned.actualCells} cells match at H=${hMin}, threshold=0; published mask has ${result.macro.mismatches} pixel-level partition conflicts at 47/1`);
  }
} finally {
  await browser.close();
}
console.log('Watershed checks passed.');
