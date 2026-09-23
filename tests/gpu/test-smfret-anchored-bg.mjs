#!/usr/bin/env node
// smFRET "Background from annulus" (smfretAnchorBg): spherical MLE with bg held
// at the aperture annulus estimate (gaussianMLEsphericFixedBg()) vs the free-bg
// fit, through the REAL smfretExtractIntensity(), on synthetic ground truth.
// Guards the three properties that motivated it: at low SNR and with a PSF
// wider than σ_PSF the anchored fit accepts more frames AND scatters less
// (free bg lets σ↑/bg↓ inflate N, which the aperture cross-check then turns
// into rejections); on empty frames it doesn't invent signal more often.
import { launchPage, htmlUrl } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => typeof gaussianMLEsphericFixedBg === 'function', null, { timeout: 30000 });
  const rows = await page.evaluate(() => {
    const W = 120, H = 100, gain = 1, cam = 100, seed = 1.3, BG = 25, READ = 3, N = 600, cx = 50, cy = 50, win = 7;
    const cases = [
      { name: 'low SNR', ph: 150, s: 1.3 },
      { name: 'high SNR', ph: 800, s: 1.3 },
      { name: 'wide PSF', ph: 800, s: 2.0 },
      { name: 'empty', ph: 0, s: 1.3 },
    ];
    return cases.map(c => {
      const free = [], anch = [];
      for (let k = 0; k < N; k++) {
        const img = new Float32Array(W * H), amp = c.ph / (2 * Math.PI * c.s * c.s);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
          img[y * W + x] = Math.max(0, cam + poisson(BG + amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * c.s * c.s))) + READ * gauss());
        const f = smfretExtractIntensity(img, W, H, cx, cy, win, seed, gain, cam, false, true, false, false, false).photons;
        const a = smfretExtractIntensity(img, W, H, cx, cy, win, seed, gain, cam, false, true, false, false, true).photons;
        if (f > 0) free.push(f); if (a > 0) anch.push(a);
      }
      const st = v => { const m = v.reduce((p, q) => p + q, 0) / Math.max(1, v.length);
        return { acc: v.length / N, mean: m, sd: Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, v.length - 1)) }; };
      return { ...c, free: st(free), anch: st(anch) };
    });
  });
  for (const r of rows) {
    const f = r.free, a = r.anch, rel = v => r.ph ? (v / r.ph).toFixed(2) : v.toFixed(0);
    console.log(`${r.name.padEnd(9)} free: acc ${(100 * f.acc).toFixed(0)}% mean ${rel(f.mean)} sd ${rel(f.sd)} | anchored: acc ${(100 * a.acc).toFixed(0)}% mean ${rel(a.mean)} sd ${rel(a.sd)}`);
  }
  const by = n => rows.find(r => r.name === n);
  for (const n of ['low SNR', 'wide PSF']) {
    assert.ok(by(n).anch.acc > by(n).free.acc + 0.1, `${n}: anchored should accept clearly more frames`);
    assert.ok(by(n).anch.sd < by(n).free.sd, `${n}: anchored should scatter less`);
  }
  const hi = by('high SNR');
  assert.ok(hi.anch.acc > 0.99, 'high SNR: anchored should accept ~every frame');
  assert.ok(Math.abs(hi.anch.mean / hi.ph - 1) < 0.12, `high SNR: anchored mean within 12% of truth (got ${(hi.anch.mean / hi.ph).toFixed(3)})`);
  // Empty frames: anchored bg accepts a noise-only window slightly more often
  // than free bg (measured ~2-3% vs ~1% over repeated runs) — a pinned
  // background makes a dim noise bump easier to fit. Bounded, not zero.
  assert.ok(by('empty').anch.acc <= 0.05, `empty frames: anchored false-positive rate too high (${(100 * by('empty').anch.acc).toFixed(1)}%)`);

  // --- Part 2: end-to-end through getSmfretTimeTraces(), CPU vs GPU, spherical
  // and rotated elliptical. Noisy ALEX movie; DA elongated ALONG the donor->
  // acceptor direction (a spectrally dispersed grating spot), DD round, AA
  // round-ish. Checks CPU/GPU parity of the anchored kernels and the anchored
  // elliptical fit's width-along-bearing against truth (the quantity used to
  // read spectral dispersion off the Jeffet data).
  const e2e = await page.evaluate(async () => {
    const W = 260, H = 220, NF = 40, NS = 20, gain = 1, cam = 100, BG = 20, READ = 3;
    const T = { DD: { N: 1500, sx: 1.3, sy: 1.3 }, DA: { N: 1500, major: 2.2, minor: 1.2 }, AA: { N: 1500, sx: 1.4, sy: 1.4 } };
    const sites = [];
    for (let i = 0; i < NS; i++) { const x = 30 + (i % 5) * 45, y = 30 + Math.floor(i / 5) * 45, b = i / NS * 2 * Math.PI * 1.7;
      sites.push({ x, y, x2: x + 12 * Math.cos(b), y2: y + 12 * Math.sin(b), bearing: b, dist: 1200, fromSmfretSOI: true, frame: 0 }); }
    function blob(buf, cx, cy, N, sx, sy, A) { const amp = N / (2 * Math.PI * sx * sy), c = Math.cos(A), s = Math.sin(A), R = Math.ceil(5 * Math.max(sx, sy));
      for (let y = Math.round(cy) - R; y <= Math.round(cy) + R; y++) for (let x = Math.round(cx) - R; x <= Math.round(cx) + R; x++) {
        const ux = x - cx, uy = y - cy, a = ux * c - uy * s, b = ux * s + uy * c; buf[y * W + x] += amp * Math.exp(-0.5 * (a * a / (sx * sx) + b * b / (sy * sy))); } }
    const frames = [];
    for (let fi = 0; fi < NF; fi++) { const lam = new Float32Array(W * H).fill(BG);
      for (const st of sites) { if (fi % 2 === 0) { blob(lam, st.x, st.y, T.DD.N, T.DD.sx, T.DD.sy, 0); blob(lam, st.x2, st.y2, T.DA.N, T.DA.major, T.DA.minor, -st.bearing); }
        else blob(lam, st.x2, st.y2, T.AA.N, T.AA.sx, T.AA.sy, 0); }
      const img = new Float32Array(W * H); for (let k = 0; k < img.length; k++) img[k] = Math.max(0, cam + poisson(lam[k]) + READ * gauss()); frames.push(img); }
    const myStack = { w: W, h: H, n: NF, async getFrames(a, b) { return frames.slice(a, b); } };
    // `method` FIRST: switching Fit method to the rotated elliptical fitter
    // auto-applies the 3D fit radius (applyWinrDefault()), which silently gave
    // one run winr=4 and the others 3 in an earlier version of this test.
    async function run(method, useGpu, anchor, fitMode = 'sidebar') {   // fitMode 'daAxes' = Analyse FRET on (smFRET's own pinned-axes fit); 'sidebar' = off (sidebar Fit method)
      for (const [id, v] of Object.entries({ method, smfretFretEnabled: fitMode === 'daAxes', smfretPairMethod: 'distAngle', psf: 1.3, winr2d: 3, winr3d: 3, winr: 3, gain, camoffset: cam, alexEnabled: true, alexFirstFrame: 'dirDonorExc', smfretApertureMode: false, smfretFloorZero: true, smfretAnchorBg: anchor, smfretApplyDrift: false, useGpu })) {
        const el = document.getElementById(id); if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v); el.dispatchEvent(new Event('change')); }
      stack = myStack; lastResult = { locs: sites, fromSmfretSOI: true, w: W, h: H, px: 100 }; smfretSOI = sites; smfretTraces = null; smfretTraceIdx = 0;
      const logBefore = document.getElementById('logText').textContent.length;
      await getSmfretTimeTraces();
      const logNew = document.getElementById('logText').textContent.slice(logBefore);   // the GPU path always logs its own "GPU extraction — M/N accepted" summary
      return { tr: smfretTraces.map(t => ({ DD: Array.from(t.photonsDD), DA: Array.from(t.photonsDA), AA: Array.from(t.photonsAA), sDD: Array.from(t.sigmaDD), sDA: Array.from(t.sigmaDA) })), gpuUsed: /GPU extraction/.test(logNew) };
    }
    const R = {};
    for (const [key, method, gpu, anchor, fitMode] of [['sphCPU', 'gaussmle', false, true], ['sphGPU', 'gaussmle', true, true], ['ellCPU', 'gaussmleEll', false, true], ['ellGPU', 'gaussmleEll', true, true], ['ellCPUfree', 'gaussmleEll', false, false], ['pinCPU', 'gaussmleEll', false, true, 'daAxes'], ['pinGPU', 'gaussmleEll', true, true, 'daAxes']])
      R[key] = await run(method, gpu, anchor, fitMode);
    function parity(a, b) { let n = 0, disc = 0, maxRel = 0, maxW = 0;
      for (let j = 0; j < a.tr.length; j++) for (const ch of ['DD', 'DA', 'AA']) for (let f = 0; f < a.tr[j][ch].length; f++) {
        const p = a.tr[j][ch][f], q = b.tr[j][ch][f]; if (!isFinite(p) || !isFinite(q)) continue;
        if ((p > 0) !== (q > 0)) { disc++; continue; } if (!(p > 0)) continue; n++; maxRel = Math.max(maxRel, Math.abs(p - q) / p);
        if (ch !== 'AA') { const w1 = a.tr[j]['s' + ch][f], w2 = b.tr[j]['s' + ch][f]; if (isFinite(w1) && isFinite(w2)) maxW = Math.max(maxW, Math.abs(w1 - w2)); } }
      return { n, disc, maxRel, maxW }; }
    function acc(r) { const m = v => { const q = v.filter(x => isFinite(x) && x > 0); return { mean: q.reduce((s, x) => s + x, 0) / Math.max(1, q.length), n: q.length }; };
      const all = k => r.tr.flatMap(t => t[k]); return { DAwidth: m(all('sDA')), DDwidth: m(all('sDD')), DAN: m(all('DA')), DDN: m(all('DD')) }; }
    return { gpu: !!navigator.gpu, gpuUsed: { sph: R.sphGPU.gpuUsed, ell: R.ellGPU.gpuUsed, pin: R.pinGPU.gpuUsed }, parSph: parity(R.sphCPU, R.sphGPU), parEll: parity(R.ellCPU, R.ellGPU), parPin: parity(R.pinCPU, R.pinGPU), accPin: acc(R.pinCPU),
      accEll: acc(R.ellCPU), accEllFree: acc(R.ellCPUfree), accSph: acc(R.sphCPU), truth: { DAmajor: T.DA.major, DD: T.DD.sx, N: T.DD.N } };
  });
  const f = (x, d = 3) => x.toFixed(d);
  console.log(`\nEnd-to-end (getSmfretTimeTraces, anchored bg):`);
  for (const [k, p] of [['spherical', e2e.parSph], ['elliptical', e2e.parEll], ['elliptical, axes along D-A', e2e.parPin]])
    console.log(`  CPU vs GPU ${k}: ${p.n} site-frames, accept discordance ${p.disc}, max rel photon diff ${p.maxRel.toExponential(1)}, max width diff ${p.maxW.toExponential(1)} px`);
  const A = e2e.accEll, F = e2e.accEllFree;
  console.log(`  elliptical DA width along D->A (true ${e2e.truth.DAmajor}): anchored ${f(A.DAwidth.mean)} (n=${A.DAwidth.n}) | free ${f(F.DAwidth.mean)} (n=${F.DAwidth.n})`);
  console.log(`  axes along D-A (default): DA width along D->A ${f(e2e.accPin.DAwidth.mean)} (n=${e2e.accPin.DAwidth.n})`);
  console.log(`  elliptical DD width (true ${e2e.truth.DD}): anchored ${f(A.DDwidth.mean)} | free ${f(F.DDwidth.mean)}`);
  console.log(`  photons DA/DD (true ${e2e.truth.N}): anchored ${f(A.DAN.mean, 0)}/${f(A.DDN.mean, 0)} | free ${f(F.DAN.mean, 0)}/${f(F.DDN.mean, 0)} | spherical anchored ${f(e2e.accSph.DAN.mean, 0)}/${f(e2e.accSph.DDN.mean, 0)}`);
  if (e2e.gpu) {
    assert.ok(e2e.gpuUsed.sph && e2e.gpuUsed.ell && e2e.gpuUsed.pin, 'GPU run did not actually take the GPU path');
    for (const p of [e2e.parSph, e2e.parEll, e2e.parPin]) {
      assert.ok(p.disc <= Math.max(2, 0.01 * p.n), `CPU/GPU accept discordance too high (${p.disc}/${p.n})`);
      assert.ok(p.maxRel < 1e-3 && p.maxW < 1e-3, `CPU/GPU anchored results differ (rel ${p.maxRel}, width ${p.maxW})`);
    }
  } else console.log('  (WebGPU unavailable — parity part skipped)');
  assert.ok(Math.abs(A.DAwidth.mean - e2e.truth.DAmajor) < 0.15, `anchored elliptical DA width along bearing off (${f(A.DAwidth.mean)} vs ${e2e.truth.DAmajor})`);
  assert.ok(Math.abs(e2e.accPin.DAwidth.mean - e2e.truth.DAmajor) < 0.15, `axes-along-D-A DA width off (${f(e2e.accPin.DAwidth.mean)} vs ${e2e.truth.DAmajor})`);
  assert.ok(A.DAwidth.n >= F.DAwidth.n, 'anchored elliptical should accept at least as many DA frames as free');
  console.log('smFRET anchored background: PASS');
} finally { await browser.close(); }
