#!/usr/bin/env node
// A real, reported data-corruption bug: runCore()'s own useGpuFit+worker-pool
// dispatch (MODULE: pipeline) used to TRANSFER (not clone) every fetched
// frame's own ArrayBuffer to its worker, unconditionally — correct and a
// real win for a stack that decodes a FRESH Float32Array per call (nothing
// else will ever need that exact object again), but silently WRONG for any
// stack whose own getFrame()/getFrames() returns a PERSISTENT, reused cache
// entry (a whole-file-cached load, MODULE: in/out, or "Simulate movie"'s own
// generateSynthetic() stack) — transferring detaches that array's buffer in
// the stack's own cache forever, with no exception raised anywhere (reading
// a detached buffer by index silently yields 0/undefined, it doesn't throw).
//
// This is exactly how smFRET's own "0/536,250 candidate fit(s) accepted"
// report happened: "Apply drift correction" runs one silent, whole-movie
// runCore() Localize pass first (to feed AIM) on the SAME stack object
// smfretExtractTracesGpu() reads again right afterward — whenever the
// eligibility conditions for this branch were met, that silent pass
// permanently zeroed the stack's own cached frames, and the very next stage
// fed the GPU fitter all-zero image data for every single candidate. Several
// rounds of unrelated drift-ESTIMATION fixes never touched this because the
// real cause was never the drift estimate at all.
//
// Fixed by a `framesTransferable` flag on the stack itself: only the "decode
// per frame from the still-resident raw file" stack (MODULE: in/out) sets
// it; runCore()'s dispatch now transfers only when the stack says it's safe,
// falling back to an ordinary clone (matching this SAME function's own
// non-useGpuFit dispatch, which was never affected: "no transfer list:
// frames are cloned, so any RAM cache survives").
//
// This test reproduces the exact shape: a stack that returns the SAME
// persistent Float32Array reference on every call (mirroring the
// whole-file-cache/simulated-movie contract) but does NOT set
// framesTransferable, runs a real GPU-fit runCore() Localize pass over it,
// then re-reads an already-processed frame the way a later stage would —
// asserting it comes back with its ORIGINAL, correct pixel data, not zeroed.
import { launchPage, htmlUrl } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => typeof runCore === 'function', null, { timeout: 30000 });

  const hasGpu = await page.evaluate(() => !!navigator.gpu);
  if (!hasGpu) { console.log('frame-cache integrity: SKIP (WebGPU unavailable)'); process.exit(0); }

  const result = await page.evaluate(async () => {
    const W = 128, H = 128, N = 200, sigma = 1.3, winr = 3, gain = 1, camoffset = 0;
    function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const rng = mulberry32(1);
    const emitters = []; for (let i = 0; i < 80; i++) emitters.push({ x: 10 + rng() * (W - 20), y: 10 + rng() * (H - 20) });
    function blob(buf, cx, cy, amp, s) {
      const r = Math.ceil(s * 4);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2;
          buf[y * W + x] += amp * Math.exp(-d2 / (2 * s * s));
        }
    }
    const BG = 10;
    // Persistent per-frame cache — mirrors makeStack(w,h,n,px, fi=>frames[fi])
    // (the whole-file-cache/generateSynthetic() shape) WITHOUT setting
    // framesTransferable, so this stack is exactly the "must not be
    // transferred" case the fix has to protect.
    const cache = new Map();
    function buildFrame(fi) {
      if (cache.has(fi)) return cache.get(fi);
      const b = new Float32Array(W * H).fill(BG);
      for (const e of emitters) blob(b, e.x, e.y, 2000, sigma);
      cache.set(fi, b);
      return b;
    }
    const stack = { w: W, h: H, n: N, async getFrames(a, b) { const out = []; for (let fi = a; fi < b; fi++) out.push(buildFrame(fi)); return out; } };
    const expectedFrame0Sum = buildFrame(0).reduce((a, v) => a + v, 0); // force-build + capture ground truth BEFORE any GPU dispatch touches it

    for (const [id, value] of Object.entries({ psf: sigma, winr, gain, camoffset, detFilter: 'wave', detection_wavelet_thr: 4, method: 'gaussmle', useGpu: true })) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
      el.dispatchEvent(new Event('change'));
    }
    const cfg = Object.assign(buildConfigFromParams(), { fitFirstFrame: 1, fitLastFrame: Infinity });
    const engine = await getGpuEngine();
    if (!engine || !engine.available) return { skip: true, reason: 'no GPU engine' };

    await runCore(cfg, stack, { zcal: null, wcal: null }, { onLog: () => {}, onProgress: () => {} });

    // Re-read frame 0 the way a LATER stage (e.g. smFRET's own extraction)
    // would — must still be the same, correct pixel data, not zeroed by a
    // detached buffer.
    const f0After = (await stack.getFrames(0, 1))[0];
    let sumAfter = 0; for (let i = 0; i < f0After.length; i++) sumAfter += f0After[i];
    return { expectedFrame0Sum, sumAfter };
  });

  if (result.skip) { console.log('frame-cache integrity: SKIP (' + result.reason + ')'); process.exit(0); }
  assert.ok(result.expectedFrame0Sum > 0, 'test setup sanity: frame 0 must have real signal before the GPU dispatch');
  assert.equal(result.sumAfter, result.expectedFrame0Sum,
    `frame 0's own cached pixel data was corrupted after a GPU-fit runCore() pass (expected sum ${result.expectedFrame0Sum}, got ${result.sumAfter}) — a detached-buffer regression of the framesTransferable fix`);
  console.log('frame-cache integrity: PASS');
} finally {
  await browser.close();
}
