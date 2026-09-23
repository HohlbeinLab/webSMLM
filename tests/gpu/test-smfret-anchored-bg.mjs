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
  assert.ok(by('empty').anch.acc <= by('empty').free.acc + 0.02, 'empty frames: anchored must not create signal more often');
  console.log('smFRET anchored background: PASS');
} finally { await browser.close(); }
