#!/usr/bin/env node
// Detection/raw-input foundation: correctness first, speed second.
//
// This is the gate for the residency work (webSMLM.html MODULE: in/out +
// MODULE: gpu). It grows with that work; today it covers:
//
//   1. getRawBlock() — the raw Uint16 block that replaces getFrames()'s
//      per-frame Float32Array copy — must carry EXACTLY the same pixel values
//      the decoded path produces. This is the foundation of the whole chain: if
//      the bytes reaching the GPU differ from the bytes the CPU detector sees,
//      every downstream comparison is meaningless.
//
// Skips (does not fail) if the file isn't present — real, git-ignored data.
//
// Usage: cd tests && npm install (once), then node bench-detect.mjs
import { join } from 'node:path';
import { launchPage, checkGpu } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const TARGET = await resolveDataFile('STORM_STACK', join('19165061', 'Aquired STORM.tif'));
if (!TARGET) { console.log('Skipping detect benchmark.'); process.exit(0); }

const { browser, page } = await launchPage();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

try {
  const gpu = await checkGpu(page);
  console.log(`WebGPU: ${gpu.available ? 'available' : 'NOT available'}`);

  await page.setInputFiles('#file', TARGET);
  await page.waitForFunction(() => typeof stack !== 'undefined' && stack && stack.n > 0, null, { timeout: 900000 });

  const r = await page.evaluate(async () => {
    const S = 100, E = 108;   // a small interior range: enough frames to catch a stride error, cheap to read twice
    if (!stack.getRawBlock) return { unsupported: true, why: stack.rawBlockWhy || 'this stack type has no raw-block path' };
    const [frames, blk] = await Promise.all([stack.getFrames(S, E), stack.getRawBlock(S, E)]);
    const w = stack.w, h = stack.h, npx = w * h;
    let maxDiff = 0, nDiff = 0, firstBad = null;
    for (let f = 0; f < frames.length; f++) {
      const dec = frames[f];
      for (let i = 0; i < npx; i++) {
        // Raw ADU is what detectSpots() consumes, and decodeInto()'s fast path is
        // a widening Uint16 -> Float32 set(), so these must be EXACTLY equal —
        // any difference is a stride or offset bug, not rounding.
        const d = Math.abs(dec[i] - blk.raw16[f * npx + i]);
        if (d > 0) { nDiff++; if (firstBad === null) firstBad = `frame ${f} px ${i}: decoded ${dec[i]} vs raw ${blk.raw16[f * npx + i]}`; }
        if (d > maxDiff) maxDiff = d;
      }
    }
    return {
      unsupported: false, w, h, nFrames: frames.length,
      blockFrames: blk.nFrames, bytesPerFrame: blk.bytesPerFrame,
      elems: blk.raw16.length, expectElems: npx * (E - S),
      maxDiff, nDiff, firstBad,
    };
  });

  if (r.unsupported) {
    console.log(`\ngetRawBlock() not offered for this stack: ${r.why}`);
    console.log('That is a supported outcome — the CPU path handles it — but this dataset was expected to qualify.');
    failures++;
  } else {
    console.log(`\nRaw block vs decoded frames — ${r.nFrames} frames of ${r.w}×${r.h}:`);
    check('block reports the requested frame count', r.blockFrames === r.nFrames, `${r.blockFrames}`);
    check('block element count matches w*h*nFrames', r.elems === r.expectElems, `${r.elems} vs ${r.expectElems}`);
    check('bytesPerFrame is w*h*2', r.bytesPerFrame === r.w * r.h * 2, `${r.bytesPerFrame}`);
    check('every pixel identical to the decoded path', r.nDiff === 0, r.nDiff ? `${r.nDiff} differ, first: ${r.firstBad}` : 'exact');
  }

  const outFile = writeResults('bench-detect', { target: TARGET, rawBlock: r });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll detect-path checks passed.');
