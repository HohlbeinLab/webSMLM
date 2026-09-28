#!/usr/bin/env node
// BigTIFF loading (magic 43) through loadTiffFile() -> loadMultiIfdStreaming():
// little- and big-endian, single- and multi-strip frames, a multi-file
// selection of single-frame BigTIFFs, and a clear error for compression.
// Frames are compared pixel for pixel with what was written.
import { launchPage } from '../lib/launch.mjs';
import { encodeBigTiff16, encodeMultiFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';
import assert from 'node:assert/strict';

const W = 37, H = 23, NF = 5;
const frames = Array.from({ length: NF }, (_, i) => makeSyntheticFrame(W, H, 11 + i));
const cases = [
  { name: 'LE, one strip', bytes: encodeBigTiff16(frames, W, H) },
  { name: 'LE, 4-row strips', bytes: encodeBigTiff16(frames, W, H, { stripRows: 4 }) },
  { name: 'BE, 3-row strips', bytes: encodeBigTiff16(frames, W, H, { littleEndian: false, stripRows: 3 }) },
];
const b64 = buf => Buffer.from(buf).toString('base64');
const { browser, page } = await launchPage({ headless: true });
try {
  const expect = frames.map(f => Array.from(f));
  for (const c of cases) {
    const got = await page.evaluate(async ({ data }) => {
      const f = new File([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], 'x.tif');
      const st = await loadTiffFile(f, () => {});
      const fr = await st.getFrames(0, st.n);
      return { n: st.n, w: st.w, h: st.h, frames: fr.map(g => Array.from(g)), isTiff: await isTiffFile(f) };
    }, { data: b64(c.bytes) });
    assert.equal(got.n, NF, c.name); assert.equal(got.w, W); assert.equal(got.h, H); assert.ok(got.isTiff);
    assert.deepEqual(got.frames, expect, `${c.name}: pixels`);
    console.log(`  ${c.name}: ${NF} frames match`);
  }
  // Multi-file selection of single-frame BigTIFFs -> one stack.
  const multi = await page.evaluate(async ({ list }) => {
    const files = list.map((d, i) => new File([Uint8Array.from(atob(d), ch => ch.charCodeAt(0))], `f${i}.tif`));
    const st = await loadTiffFilesAuto(files, () => {});
    return { n: st.n, frames: (await st.getFrames(0, st.n)).map(g => Array.from(g)) };
  }, { list: frames.map(f => b64(encodeBigTiff16([f], W, H))) });
  assert.equal(multi.n, NF); assert.deepEqual(multi.frames, expect, 'multi-file pixels');
  console.log(`  multi-file (${NF} single-frame BigTIFFs): match`);
  // Compressed BigTIFF: clear error.
  const err = await page.evaluate(async ({ data }) => {
    try { await loadTiffFile(new File([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], 'c.tif'), () => {}); return null; }
    catch (e) { return e.message; }
  }, { data: b64(encodeBigTiff16(frames, W, H, { compression: 8 })) });
  assert.match(err || '', /compressed/i); console.log(`  compressed: "${err}"`);
  // Classic multi-IFD TIFF through the same streamed reader (Budget raw movies 0).
  const classic = await page.evaluate(async ({ data }) => {
    $('memgb').value = 0;
    const st = await loadTiffFile(new File([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], 'k.tif'), () => {});
    return { sliced: !!st.sliced, frames: (await st.getFrames(0, st.n)).map(g => Array.from(g)) };
  }, { data: b64(encodeMultiFrameTiff16(frames, W, H)) });
  assert.ok(classic.sliced); assert.deepEqual(classic.frames, expect, 'classic streamed pixels');
  console.log('  classic TIFF via the streamed reader: match');
  console.log('BigTIFF loading: PASS');
} finally { await browser.close(); }
