#!/usr/bin/env node
// Pixel-centre convention (LOC_PX_EDGE): a loc at x = i (the fitters' and
// Picasso's centre of camera pixel i) must appear at the centre of pixel i
// wherever it meets the pixel-edge frame (pixel i spans [i, i+1)):
//   - the reconstruction, CPU and (when WebGPU works) GPU: the brightest srFull
//     pixel is the middle of camera pixel i's mag×mag block;
//   - the table's x/y and Save localisations: (i + 0.5)·pixel size;
//   - a segmentation mask: pixel i.
import { launchPage, checkGpu } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const gpu = await checkGpu(page);
  const r = await page.evaluate(async (gpuOk) => {
    const out = {};
    $('pxnm').value = 100; $('mag').value = 5; $('rblur').value = 0; $('renderMode').value = 'fixed';
    const locs = [{ frame: 0, x: 6, y: 3, photons: 1000, bg: 1, bgstd: 1, sigma: 1, lpx: 0.001, lpy: 0.001 }];   // tiny precision: 'dither' then cannot leave the pixel
    lastResult = { locs, w: 12, h: 8, px: 100, mag: 5, det: null, fromCsv: true, csvCoordinatePx: 100 };
    const brightest = () => {
      const c = srFull.getContext('2d').getImageData(0, 0, srFull.width, srFull.height).data;
      let best = -1, bi = -1;
      for (let i = 0; i < c.length / 4; i++) { const v = c[4 * i] + c[4 * i + 1] + c[4 * i + 2]; if (v > best) { best = v; bi = i; } }
      return [bi % srFull.width, Math.floor(bi / srFull.width)];
    };
    for (const mode of ['fixed', 'precision', 'dither']) for (const useGpu of gpuOk && mode !== 'dither' ? [false, true] : [false]) {
      $('renderMode').value = mode; $('useGpu').checked = useGpu;
      await rerender();
      out[mode + (useGpu ? ' GPU' : ' CPU')] = brightest();
    }
    const info = tableColumnInfo(locs, false);
    out.table = [tableColumnValue(locs[0], 0, 'x', info), tableColumnValue(locs[0], 0, 'y', info)];
    const csvRow = buildCsvText(locs, 100, 1.3).parts.join('').split('\n')[1].split(',');
    out.csv = [+csvRow[2], +csvRow[3]];
    const labels = { arr: new Int32Array(12 * 8), w: 12, h: 8 }; labels.arr[3 * 12 + 6] = 7;
    out.mask = cellIdForLoc(locs[0], labels);
    return out;
  }, gpu.available);
  // Camera pixel 6 = srFull pixels 30..34 at mag 5, middle 32; pixel 3 -> 15..19, middle 17.
  const renders = Object.keys(r).filter(k => / (CPU|GPU)$/.test(k));
  for (const k of renders) assert.deepEqual(r[k], [32, 17], `${k} render: ${r[k]}`);
  assert.deepEqual(r.table, [650, 350]);
  assert.deepEqual(r.csv, [650, 350]);
  assert.equal(r.mask, 7);
  console.log(`  loc at pixel (6,3)'s centre: reconstruction middle of its 5×5 block (${renders.join(', ')}), table/CSV 650/350 nm, mask pixel (6,3)`);
  console.log('Pixel convention: PASS');
} finally { await browser.close(); }
