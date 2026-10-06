#!/usr/bin/env node
// Rotate movie (Memory, GPU & streaming): makeRotatedStack() pixel mapping for
// 90/180/270° clockwise, the interactive flow (load -> rotate clears results
// and re-wraps the loaded movie, a later load keeps the setting) and
// analyze({rotateMovie}) localizing on the rotated frames.
import { launchPage } from '../lib/launch.mjs';
import { encodeMultiFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';
import assert from 'node:assert/strict';

const W = 37, H = 23, NF = 3;
const frames = Array.from({ length: NF }, (_, i) => makeSyntheticFrame(W, H, 5 + i));
// Reference clockwise rotation, written independently of the app's index maps.
function rotRef(f, deg) {
  let w = W, h = H, a = Array.from(f);
  for (let r = 0; r < deg / 90; r++) {            // one 90° cw step: new(x', y') = old(y', h-1-x')
    const nw = h, nh = w, out = new Array(nw * nh);
    for (let yy = 0; yy < nh; yy++) for (let xx = 0; xx < nw; xx++) out[yy * nw + xx] = a[(h - 1 - xx) * w + yy];
    a = out; w = nw; h = nh;
  }
  return { w, h, a };
}
const data = Buffer.from(encodeMultiFrameTiff16(frames, W, H)).toString('base64');
const { browser, page } = await launchPage({ headless: true });
try {
  for (const deg of [90, 180, 270]) {
    const got = await page.evaluate(async ({ data, deg }) => {
      const st = await loadTiffFile(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'r.tif'), () => {});
      const r = makeRotatedStack(st, deg);
      return { w: r.w, h: r.h, frames: (await r.getFrames(0, r.n)).map(g => Array.from(g)) };
    }, { data, deg });
    for (let i = 0; i < NF; i++) {
      const ref = rotRef(frames[i], deg);
      assert.equal(got.w, ref.w); assert.equal(got.h, ref.h);
      assert.deepEqual(got.frames[i], ref.a, `${deg}°: frame ${i}`);
    }
    console.log(`  ${deg}°: ${got.w}×${got.h}, ${NF} frames match`);
  }
  // Interactive: load, Localize, rotate 90 -> results cleared, 23×37 stack; 0 -> back.
  const flow = await page.evaluate(async ({ data }) => {
    const file = () => new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'r.tif');
    await loadFiles([file()]);
    const before = [stack.w, stack.h];
    lastResult = { locs: [], w: stack.w, h: stack.h };   // stands in for a Run's result
    $('rotateMovie').value = '90'; await applyMovieRotation();
    const rotated = [stack.w, stack.h, lastResult, $('runBtn').disabled, stack.rotation];
    await loadFiles([file()]);                          // a new load keeps the setting
    const reload = [stack.w, stack.h];
    $('rotateMovie').value = '0'; await applyMovieRotation();
    return { before, rotated, reload, back: [stack.w, stack.h, stack === unrotatedStack] };
  }, { data });
  assert.deepEqual(flow.before, [W, H]);
  assert.deepEqual(flow.rotated, [H, W, null, false, 90]);
  assert.deepEqual(flow.reload, [H, W]);
  assert.deepEqual(flow.back, [W, H, true]);
  console.log('  interactive: rotate clears results, re-wraps, persists across loads, 0° restores');
  // Headless: analyze() rotates before localizing.
  const hl = await page.evaluate(async ({ data }) => {
    const r = await analyze({ file: new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'r.tif'), rotateMovie: '270', onLog: () => {} });
    return [r.w, r.h];
  }, { data });
  assert.deepEqual(hl, [H, W]);
  console.log('  analyze({rotateMovie:"270"}): localized on the rotated frames');
  console.log('Rotate movie: PASS');
} finally { await browser.close(); }
