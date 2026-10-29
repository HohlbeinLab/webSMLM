#!/usr/bin/env node
// stack.residentBytes (the decoded cache the Mem readout and Localize's memory
// guards subtract): a concatenated stack reports the sum of its parts; a folder
// of single-frame TIFFs decodes per call and caches nothing (0).
import { launchPage } from '../lib/launch.mjs';
import { encodeMultiFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';
import assert from 'node:assert/strict';

const W = 32, H = 24;
const b64 = frames => Buffer.from(encodeMultiFrameTiff16(frames, W, H)).toString('base64');
const multiA = b64([makeSyntheticFrame(W, H, 1), makeSyntheticFrame(W, H, 2), makeSyntheticFrame(W, H, 3)]);
const multiB = b64([makeSyntheticFrame(W, H, 4), makeSyntheticFrame(W, H, 5)]);
const single = [1, 2, 3].map(i => b64([makeSyntheticFrame(W, H, i)]));
const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async ({ multiA, multiB, single }) => {
    const file = (b, name) => new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], name);
    const a = await loadTiffFile(file(multiA, 'a.tif'), () => {}), b = await loadTiffFile(file(multiB, 'b.tif'), () => {});
    const cat = await loadTiffFilesAuto([file(multiA, 'a.tif'), file(multiB, 'b.tif')], () => {});
    const seq = await loadTiffFilesAuto(single.map((s, i) => file(s, `f${i}.tif`)), () => {});
    return { a: a.residentBytes, b: b.residentBytes, catN: cat.n, cat: cat.residentBytes, seqN: seq.n, seq: seq.residentBytes || 0 };
  }, { multiA, multiB, single });
  assert.ok(r.a > 0 && r.b > 0, JSON.stringify(r));
  assert.equal(r.catN, 5); assert.equal(r.cat, r.a + r.b, 'a concatenated stack reports the sum of its parts');
  assert.equal(r.seqN, 3); assert.equal(r.seq, 0, 'a folder of single-frame TIFFs caches nothing');
  console.log(`  concatenated stack: ${r.cat} bytes = ${r.a} + ${r.b}; single-frame folder: 0`);
  console.log('Resident bytes: PASS');
} finally { await browser.close(); }
