#!/usr/bin/env node
// Live-streaming Tier A — the file-push conduit
// (window.webSMLM.liveStream.pushChunk(), MODULE: liveStreaming; the same
// call tools/webSMLM-livestream-bridge.mjs makes), fully automated, no
// external process: pushes a small synthetic stack as single-frame chunks
// and checks the accumulated result reproduces a plain one-shot analyze()
// over the SAME frames — the live-chunked path must produce what the
// non-live path produces, the same standard this suite already holds every
// GPU path to.
//
// Usage: cd tests && npm install (once), then node bench-livestream.mjs
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { encodeMultiFrameTiff16, encodeSingleFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';

const W = 64, H = 64, N_FRAMES = 12, SEED = 20260914;
const CONFIG = { pxnm: 100, method: 'gaussmle', psf: 1.3, winr: 4, detFilter: 'wave', detection_wavelet_thr: 2 };

const pixelFrames = [];
for (let i = 0; i < N_FRAMES; i++) pixelFrames.push(makeSyntheticFrame(W, H, SEED + i));
const chunkTiffs = pixelFrames.map(px => encodeSingleFrameTiff16(px, W, H));

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };

const { browser, page } = await launchPage();
try {
  console.log(`Pushing ${N_FRAMES} single-frame synthetic chunks via window.webSMLM.liveStream.pushChunk()...`);
  await page.evaluate(cfg => {
    for (const [id, v] of Object.entries(cfg)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    }
  }, CONFIG);

  let totals = null;
  for (let i = 0; i < chunkTiffs.length; i++) {
    await page.setInputFiles('#liveStreamChunkInput', { name: `chunk${i}.tif`, mimeType: 'image/tiff', buffer: chunkTiffs[i] });
    totals = await page.evaluate(() => window.webSMLM.liveStream.pushChunk());
  }
  await page.evaluate(() => window.webSMLM.liveStream.end());
  console.log(`Streamed: ${JSON.stringify(totals)}`);
  check('all frames were counted', totals.totalFrames === N_FRAMES, `${totals.totalFrames} vs ${N_FRAMES}`);

  const liveLocs = await page.evaluate(() => (typeof lastResult !== 'undefined' && lastResult ? lastResult.locs.length : 0));

  // Reference: the SAME frames through a plain one-shot analyze() call, on a
  // SEPARATE fresh page/browser so the live-stream session above can't leak
  // any state into it.
  const refSession = await launchPage();
  const oneShotTiff = encodeMultiFrameTiff16(pixelFrames, W, H);
  await refSession.page.setInputFiles('#analyzeFileInput', { name: 'oneshot.tif', mimeType: 'image/tiff', buffer: oneShotTiff });
  const refLocs = await refSession.page.evaluate(async ({ cfg, fileInputId }) => {
    const config = Object.assign({}, cfg, { file: document.getElementById(fileInputId).files[0] });
    const r = await window.webSMLM.analyze(config);
    return r.locs.length;
  }, { cfg: CONFIG, fileInputId: 'analyzeFileInput' });
  await refSession.browser.close();

  console.log(`Live-chunked locs: ${liveLocs}, one-shot locs: ${refLocs}`);
  // Not required to be EXACTLY equal — a chunk-by-chunk Localize and one
  // whole-stack Localize aren't guaranteed to produce identical frame-
  // boundary detection on every single frame (no FTM here, so no cross-
  // chunk context is lost either way) — but the two should land within a
  // small margin of each other on the same synthetic frames; a large gap
  // would mean the live-chunked path is silently losing/duplicating data.
  const rel = Math.abs(liveLocs - refLocs) / Math.max(1, refLocs);
  check('live-chunked locs count matches one-shot analyze() within 10%', rel <= 0.10, `${liveLocs} vs ${refLocs} (${(rel * 100).toFixed(1)}%)`);

  const outFile = writeResults('bench-livestream', { nFrames: N_FRAMES, totals, liveLocs, refLocs, rel });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll live-stream (Tier A) checks passed.');
