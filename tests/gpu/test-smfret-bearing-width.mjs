#!/usr/bin/env node
// Ground-truth verification for smFRET's sigma-vs-time "width along the
// donor->acceptor bearing" feature (smfretWidthAlongBearing(), MODULE:
// smFRET) — raised directly: "it seems in elliptical fit, the 'wrong'
// width is plotted... I am looking for the width that aligns with the
// orientation of the line connecting DD and DA."
//
// The projection FORMULA itself was already re-derived algebraically this
// session and confirmed invariant under the well-known elliptical-Gaussian
// relabeling ambiguity ((sx,sy,angle) and (sy,sx,angle+90 deg) describe the
// identical physical ellipse) — so if a real discrepancy exists, it's in
// the FITTED (sx,sy,angle) values feeding that formula, not the formula
// itself. This test builds a synthetic multi-site, multi-bearing dataset
// with a KNOWN true elliptical PSF per channel (DD/DA/AA, each a distinct
// (sx,sy,angle)) and NO noise, runs the real getSmfretTimeTraces() through
// BOTH the CPU and GPU-batched extraction paths (enough sites x frames to
// clear the GPU eligibility threshold), and compares each site's own
// extracted sigmaDD/sigmaDA/sigmaAA against the analytically true width
// along that site's own bearing (computed via the SAME
// smfretWidthAlongBearing() the app itself uses, fed the TRUE params —
// this specifically checks fitting recovery + GPU/CPU consistency, not the
// formula, which is already verified separately).
import { launchPage, htmlUrl } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => typeof getSmfretTimeTraces === 'function' && typeof smfretWidthAlongBearing === 'function', null, { timeout: 30000 });

  async function runCase(useGpu) {
    return await page.evaluate(async (useGpu) => {
      const W = 260, H = 220, N_FRAMES = 30, N_SITES = 20;
      const sigma = 1.3, winr = 4, win = 2 * winr + 1, gain = 1, camoffset = 0;
      const BG = 5;

      // True per-channel ellipse (px, radians) — deliberately different for
      // each channel so a mix-up between them would be visible.
      const TRUE = {
        DD: { sx: 1.4, sy: 0.9, angle: 0.35 },
        DA: { sx: 1.1, sy: 1.7, angle: -0.6 },
        AA: { sx: 1.8, sy: 1.2, angle: 1.0 },
      };

      function ellipticalBlob(buf, cx, cy, amp, sx, sy, angleRad) {
        const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
        const rmax = Math.ceil(4 * Math.max(sx, sy));
        const x0 = Math.max(0, Math.round(cx) - rmax), x1 = Math.min(W - 1, Math.round(cx) + rmax);
        const y0 = Math.max(0, Math.round(cy) - rmax), y1 = Math.min(H - 1, Math.round(cy) + rmax);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const ux = x - cx, uy = y - cy;
          const arga = ux * cosA - uy * sinA, argb = ux * sinA + uy * cosA;
          buf[y * W + x] += amp * Math.exp(-0.5 * (arga * arga / (sx * sx) + argb * argb / (sy * sy)));
        }
      }

      // 20 sites on a well-separated grid (5x4, 40px spacing) — a first
      // attempt placed them all close together on a small ring to get many
      // distinct bearings cheaply, but that let DIFFERENT sites' own PSFs
      // (donor and acceptor positions alike) land within a few px of each
      // other, contaminating each other's fit windows with genuine
      // overlapping-emitter signal (confirmed directly: several sites showed
      // 0 accepted frames specifically on channels whose position happened
      // to coincide with a NEIGHBOUR's) — a test-geometry bug, not an app
      // one. Grid spacing (40px) is comfortably larger than the fit window
      // (9px) plus any individual PSF's own real extent (~4*max(sx,sy)~8px),
      // so no cross-site contamination is possible here; the small
      // donor->acceptor offset (12px) still varies in a distinct bearing
      // per site, covering many (bearing, angle) combinations in one run.
      const sites = [];
      const cols = 5, spacing = 40, margin = 30, dist = 12;
      for (let i = 0; i < N_SITES; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const x = margin + col * spacing, y = margin + row * spacing;
        const bearing = i / N_SITES * 2 * Math.PI * 1.7; // varied bearings, independent of grid placement
        const x2 = x + dist * Math.cos(bearing), y2 = y + dist * Math.sin(bearing);
        sites.push({ x, y, x2, y2, dist: dist * 100 /* nm, arbitrary px-size, just needs to be finite for smfretHasDDDAPairing() */, fromSmfretSOI: true, frame: 0 });
      }

      // Analyse FRET off -> sidebar Fit method (free-angle rotated elliptical):
      // each channel's ellipse here is deliberately TILTED away from its D->A
      // bearing, which the Analyse-FRET axes-along-D-A fit can't represent (by design — it assumes
      // dispersion-aligned axes); this test checks the free-angle projection.
      // smfretAnchorBg off: this test checks the bearing projection and the
      // CPU/GPU angle convention on noiseless data with a peak ~1000x the
      // background, where the annulus picks up PSF tail (bg 5 -> ~7.6) and
      // biases widths by ~0.01 px. The anchored fit's own width accuracy is
      // covered at realistic SNR by test-smfret-anchored-bg.mjs.
      const AMP = 5000;
      const myStack = {
        w: W, h: H, n: N_FRAMES,
        async getFrames(a, b) {
          const out = [];
          for (let fi = a; fi < b; fi++) {
            const buf = new Float32Array(W * H).fill(BG);
            const isDonorExc = (fi % 2) === 0;
            for (const s of sites) {
              if (isDonorExc) {
                ellipticalBlob(buf, s.x, s.y, AMP, TRUE.DD.sx, TRUE.DD.sy, TRUE.DD.angle);
                ellipticalBlob(buf, s.x2, s.y2, AMP, TRUE.DA.sx, TRUE.DA.sy, TRUE.DA.angle);
              } else {
                ellipticalBlob(buf, s.x2, s.y2, AMP, TRUE.AA.sx, TRUE.AA.sy, TRUE.AA.angle);
              }
            }
            out.push(buf);
          }
          return out;
        },
      };

      for (const [id, value] of Object.entries({ psf: sigma, winr, gain, camoffset, method: 'gaussmleEll', smfretFretEnabled: false, alexEnabled: true, alexFirstFrame: 'dirDonorExc', smfretApertureMode: false, smfretFloorZero: false, smfretAnchorBg: false, smfretApplyDrift: false, useGpu })) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
        el.dispatchEvent(new Event('change'));
      }

      // Bare assignment, NOT window.* — stack/lastResult/smfretSOI/smfretTraces
      // are top-level `let` bindings in the page's own classic (non-module)
      // script, which do NOT become window properties; a page.evaluate()
      // callback runs in that same global scope, so a plain assignment
      // (no let/const/var, no window.) correctly reaches the real bindings
      // getSmfretTimeTraces() itself reads.
      stack = myStack;
      lastResult = { locs: sites, fromSmfretSOI: true, w: W, h: H, px: 100 };
      smfretSOI = sites;
      smfretTraces = null;
      smfretTraceIdx = 0;

      await getSmfretTimeTraces();

      // Compare each site's own extracted sigma against the TRUE width
      // along its own bearing (same smfretWidthAlongBearing() the app
      // itself uses, fed the TRUE params) — px units throughout (site.x/y
      // are px, sigmaDD/etc are stored in px too, pre-nm-conversion).
      const errors = [];
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i], t = smfretTraces[i];
        const bearing = Math.atan2(s.y2 - s.y, s.x2 - s.x);
        const trueDD = smfretWidthAlongBearing(TRUE.DD.sx, TRUE.DD.sy, TRUE.DD.angle, bearing);
        const trueDA = smfretWidthAlongBearing(TRUE.DA.sx, TRUE.DA.sy, TRUE.DA.angle, bearing);
        const trueAA = smfretWidthAlongBearing(TRUE.AA.sx, TRUE.AA.sy, TRUE.AA.angle, bearing);
        // Only compare frames that actually have a real (non-NaN, non-zero-rejected) value.
        const meanFinite = arr => { const v = Array.from(arr).filter(x => isFinite(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
        errors.push({
          site: i,
          ddErr: Math.abs(meanFinite(t.sigmaDD) - trueDD),
          daErr: Math.abs(meanFinite(t.sigmaDA) - trueDA),
          aaErr: Math.abs(meanFinite(t.sigmaAA) - trueAA),
          ddN: Array.from(t.sigmaDD).filter(x => isFinite(x) && x > 0).length,
          daN: Array.from(t.sigmaDA).filter(x => isFinite(x) && x > 0).length,
          aaN: Array.from(t.sigmaAA).filter(x => isFinite(x) && x > 0).length,
        });
      }
      return { errors, hasGpu: !!navigator.gpu };
    }, useGpu);
  }

  const cpuResult = await runCase(false);
  const gpuResult = await runCase(true);
  if (!gpuResult.hasGpu) { console.log('bearing-width test: SKIP (WebGPU unavailable) — CPU-only results below for info.'); }

  function summarize(label, result) {
    const maxErr = Math.max(...result.errors.flatMap(e => [e.ddErr, e.daErr, e.aaErr]));
    const minAccepted = Math.min(...result.errors.flatMap(e => [e.ddN, e.daN, e.aaN]));
    console.log(`${label}: max |error| = ${maxErr.toFixed(5)} px across ${result.errors.length} sites x 3 channels, min accepted-frame count = ${minAccepted}`);
    return { maxErr, minAccepted };
  }

  const cpuSummary = summarize('CPU', cpuResult);
  assert.ok(cpuSummary.minAccepted > 0, 'CPU: at least one site/channel had zero accepted frames — extraction is not working at all');
  assert.ok(cpuSummary.maxErr < 0.01, `CPU: bearing-projected width error too large (${cpuSummary.maxErr.toFixed(5)} px) — fitting or projection is wrong`);

  if (gpuResult.hasGpu) {
    const gpuSummary = summarize('GPU', gpuResult);
    assert.ok(gpuSummary.minAccepted > 0, 'GPU: at least one site/channel had zero accepted frames');
    assert.ok(gpuSummary.maxErr < 0.01, `GPU: bearing-projected width error too large (${gpuSummary.maxErr.toFixed(5)} px) — GPU elliptical kernel's own angle convention may not match the CPU one`);
  }

  console.log('smFRET bearing-width: PASS');
} finally {
  await browser.close();
}
