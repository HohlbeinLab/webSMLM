#!/usr/bin/env node
// CRITICAL, per direct report: "some spiking in LS & MLE spherical, yet
// failed fits in MLE rotated elliptical (but less spiking)!! check with
// well defined simulations against aperture photometry."
//
// A real gap found while wiring this up: smfretExtractIntensity() used to
// ALWAYS call gaussianMLEspheric() internally for every non-elliptical,
// non-aperture method — "Least-squares 2D-Gaussian" had never actually run
// inside smFRET extraction at all, so "LS" and "MLE spherical" were almost
// certainly the SAME code path under two different sidebar labels. Fixed
// (see smfretExtractIntensity()'s own comment) before writing this test, so
// all 4 real extraction paths now genuinely differ: aperture photometry (no
// iterative fit, the reference), spherical MLE, least-squares (gaussianFit),
// rotated elliptical MLE.
//
// This builds a KNOWN, deliberately near-constant true photon-count movie
// (realistic Poisson shot noise + Gaussian read noise, same physical model
// generateSynthetic() uses via the app's own poisson()/gauss()) at several
// SNR regimes (low/mid/high photon count, plus a mildly-mismatched-PSF
// case), runs the real getSmfretTimeTraces() through all 4 methods on the
// IDENTICAL noise realization (frames generated once, cached), and reports:
// acceptance rate (fraction of non-zero/non-rejected frames) and "spiking"
// (extracted trace's own std-dev vs the true Poisson noise floor, plus a
// direct outlier count against the known true mean) per method.
//
// ROOT CAUSE FOUND (via a follow-up diagnostic calling gaussianMLEspheric()
// directly on individual "spike" frames, not committed as its own test):
// every spike shares the SAME signature — the fitted `sigma` is inflated
// well past the seed while `bg` is correspondingly deflated, and the
// reported total photon count (amp*2*pi*sigma^2) balloons because it scales
// with sigma^2. This is a genuine likelihood DEGENERACY, not a simple coding
// bug: at low SNR (these regimes put ~100-200 true signal photons against
// ~1500 total background photons in the fit window), a wider/dimmer peak
// plus a lower background can explain the same noisy pixels about as well
// as the true narrow peak plus the true background — the Newton solver
// converges (passes its own decrement + bounds checks) to this WRONG but
// locally-stable solution. The SHARED `FIT_MAX_DRIFT_SIGMA_MULT` (2x the
// seed sigma) does NOT reliably catch it: most observed spikes had a fitted
// sigma comfortably under that bound.
//
// FIXED (smfretExtractIntensity()/smfretExtractTracesGpu(), MODULE:
// smFRET), per direct follow-up guidance ("bg-sanity is probably the way to
// go... FRET is different to standard SMLM... we would be fine with just
// getting an amplitude of zero... is the psf width properly confined?"):
// two smFRET-specific reject checks on top of the shared fitter's own —
// (1) SMFRET_MAX_SIGMA_MULT (1.6, tighter than the shared 2.0) — smFRET
// re-fits the SAME known site against a PSF whose width should be
// essentially constant (no z-defocus), unlike the main pipeline's many
// distinct emitters/genuinely varying PSF shape, so a tighter anchor to the
// already-known seed sigma is justified here specifically; (2) an
// APERTURE-PHOTOMETRY SANITY CROSS-CHECK — apertureIntensity() has no
// iterative fit at all, so it can't fall into this degeneracy, making it a
// clean, independent reference (directly operationalizing a further report:
// "I also see spikes... on localisations where the intensity look just fine
// with aperture photometry"): reject when the fit's own photon count
// exceeds `SMFRET_AP_SANITY_MULT(1.5)*apRef +
// SMFRET_AP_SANITY_NSIGMA(4)*sqrt(apRef)` — a noise-PROPORTIONAL margin
// (not a flat one — a flat floor generous enough for real noise at LOW
// counts, tried first, was ALSO generous enough there to pass most
// degenerate fits straight through, since the check barely constrains
// anything when the floor and the true signal are comparable in size).
// Measured effect at these tuned constants (typical run, real noise so
// exact numbers vary run to run): spherical MLE's own "low" regime spike
// RATE roughly halved (~37%->~18-22% of accepted frames) and its stdRatio
// dropped from ~12x to ~4-5x the Poisson floor, at the cost of a real,
// accepted trade-off — lower acceptance (~58%->~40-60%) — exactly the
// "rather get zero than a wrong spike" preference requested. Retuning
// TIGHTER (1.3/3) was tried and reverted: it improved the "low" regime
// further but, at the "wide" (mildly PSF-mismatched) regime, mostly
// rejected GOOD frames rather than catching more real spikes (accepted
// count dropped by half with almost no drop in the raw spike count) — the
// aperture cross-check has a real, inherent blind spot: a fit correctly
// recovering a genuinely wider-than-seed PSF also legitimately reports more
// total photons than a fixed-radius aperture fully captures, indistinguishable
// from the degeneracy by this check alone at a tighter margin. The
// degeneracy is NOT fully eliminated (stdRatio stays well above 1x even
// after this fix) — a fundamental Fisher-information limit at genuinely low
// SNR, not something any accept/reject threshold alone can remove — this is
// a real, substantial mitigation, not a complete fix. The elliptical
// fitter's own LOWER spike count remains a real but MECHANISTIC side effect
// of having more free parameters (sx, sy, angle each get their own bound
// check, so a marginal fit has more chances to trip at least one), not
// evidence it's better at specifically detecting this degeneracy.
import { launchPage, htmlUrl } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => typeof getSmfretTimeTraces === 'function' && typeof poisson === 'function', null, { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const W = 260, H = 100, N_FRAMES = 300;
    // winr=3 (7x7 window, radius 3px) — a REALISTIC value matching typical
    // real usage (winr=3 for psf~1.3 is what the real dataset investigated
    // earlier this session actually used), not inflated to fit an
    // unrealistic "wide" PSF. A first attempt used winr=8 to comfortably
    // contain a deliberately-wide sigma=2.6 test regime — that inflated
    // window ALSO inflated aperture photometry's own signal disk radius
    // (apertureGeometry(win): r=(win-1)/2, the SAME radius the fit window
    // uses), which sums background-photon shot noise over a MUCH larger
    // area than a well-matched sigma~1.3 PSF actually needs — a real
    // aperture-photometry principle (there IS an optimal aperture radius,
    // not "as large as possible"), confirmed directly: with winr=8, aperture
    // showed WORSE noise (5.5x the Poisson floor) than every fitted method
    // at the SAME regime, an artifact of the oversized window, not a real
    // aperture-vs-fit comparison. A realistic window size (matched to the
    // PSF actually being measured, as any real user would set it) removes
    // this confound entirely.
    const sigmaSeed = 1.3, winr = 3, win = 2 * winr + 1, gain = 1, camoffset = 100;
    const BG_PHOTONS = 30, READ_NOISE_E = 3; // typical sCMOS-ish background + read noise

    // 4 well-separated (>=40px apart, comfortably clear of the 7px fit
    // window and the PSF's own real extent) sites, each a distinct,
    // deliberately hard regime:
    const REGIMES = [
      { name: 'low',   photons: 150,  sigma: 1.3 },  // borderline-detectable
      { name: 'mid',   photons: 800,  sigma: 1.3 },  // comfortable SNR
      { name: 'high',  photons: 4000, sigma: 1.3 },  // bright
      { name: 'wide',  photons: 1500, sigma: 1.7 },  // mildly wider than the seed guess — a realistic PSF-mismatch case, not an extreme one requiring an oversized window
    ];
    const sites = REGIMES.map((r, i) => ({ x: 40 + i * 55, y: 50, ...r }));

    function gaussianBlob(buf, cx, cy, totalPhotons, sig) {
      const amp = totalPhotons / (2 * Math.PI * sig * sig);
      const r = Math.ceil(sig * 5);
      const x0 = Math.max(0, Math.round(cx) - r), x1 = Math.min(W - 1, Math.round(cx) + r);
      const y0 = Math.max(0, Math.round(cy) - r), y1 = Math.min(H - 1, Math.round(cy) + r);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        buf[y * W + x] += amp * Math.exp(-d2 / (2 * sig * sig));
      }
    }

    // Frames generated ONCE and cached — every method under comparison must
    // see the EXACT SAME noise realization for a fair, paired comparison
    // (regenerating per call would let random noise differences masquerade
    // as method differences).
    const frameCache = [];
    for (let fi = 0; fi < N_FRAMES; fi++) {
      const photonImg = new Float32Array(W * H).fill(BG_PHOTONS);
      for (const s of sites) gaussianBlob(photonImg, s.x, s.y, s.photons, s.sigma);
      const buf = new Float32Array(W * H);
      for (let i = 0; i < buf.length; i++) {
        // Same physical model as generateSynthetic(): Poisson shot noise +
        // Gaussian read noise (electrons) combine before the gain
        // conversion to ADU, then the fixed camera offset is added.
        const adu = camoffset + (poisson(photonImg[i]) + READ_NOISE_E * gauss()) / gain;
        buf[i] = Math.max(0, adu);
      }
      frameCache.push(buf);
    }
    const myStack = { w: W, h: H, n: N_FRAMES, async getFrames(a, b) { return frameCache.slice(a, b); } };

    async function runMethod(methodLabel, domSettings) {
      for (const [id, value] of Object.entries({ psf: sigmaSeed, winr, gain, camoffset, alexEnabled: false, smfretFloorZero: false, smfretApplyDrift: false, useGpu: false, ...domSettings })) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
        el.dispatchEvent(new Event('change'));
      }
      stack = myStack;
      const soi = sites.map(s => ({ x: s.x, y: s.y, frame: 0 }));
      lastResult = { locs: soi, fromSmfretSOI: false, w: W, h: H, px: 100 };
      smfretSOI = soi;
      smfretTraces = null;
      smfretTraceIdx = 0;
      await getSmfretTimeTraces();

      return sites.map((s, i) => {
        const arr = Array.from(smfretTraces[i].photonsDD);
        const accepted = arr.filter(v => isFinite(v) && v > 0);
        const trueMean = s.photons;
        const trueStd = Math.sqrt(trueMean); // Poisson shot-noise floor on the TRUE photon count itself (a lower bound — background/read noise add a bit more, but this is the dominant term at these levels and a fair, method-independent yardstick)
        const acceptRate = accepted.length / arr.length;
        const extractedMean = accepted.length ? accepted.reduce((a, b) => a + b, 0) / accepted.length : NaN;
        const extractedStd = accepted.length > 1 ? Math.sqrt(accepted.reduce((a, b) => a + (b - extractedMean) ** 2, 0) / (accepted.length - 1)) : NaN;
        // A "spike": an accepted frame more than 6 true-Poisson-sigma away
        // from the TRUE mean — real Poisson noise essentially never does
        // this (6-sigma is astronomically unlikely for a normal-ish
        // distribution), so any real occurrence is a fitting artifact, not
        // genuine shot noise.
        const spikes = accepted.filter(v => Math.abs(v - trueMean) > 6 * trueStd).length;
        return { regime: s.name, trueMean, trueStd, acceptRate, extractedMean, extractedStd, stdRatio: extractedStd / trueStd, spikes, nAccepted: accepted.length, nTotal: arr.length };
      });
    }

    const results = {};
    // Analyse FRET off: this test compares the sidebar Fit methods themselves (with it
    // on, smFRET picks its own fit — spherical for these unpaired sites).
    results.aperture = await runMethod('aperture', { smfretApertureMode: true });
    results.sphericalMLE = await runMethod('sphericalMLE', { smfretApertureMode: false, method: 'gaussmle', smfretFretEnabled: false });
    results.leastSquares = await runMethod('leastSquares', { smfretApertureMode: false, method: 'gaussls', smfretFretEnabled: false });
    results.ellipticalMLE = await runMethod('ellipticalMLE', { smfretApertureMode: false, method: 'gaussmleEll', smfretFretEnabled: false });
    return results;
  });

  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== Summary (regime: acceptRate, stdRatio vs Poisson floor, spikes/nAccepted) ===');
  for (const [method, regimes] of Object.entries(result)) {
    console.log(`\n${method}:`);
    for (const r of regimes) {
      console.log(`  ${r.regime.padEnd(6)} accept=${(r.acceptRate * 100).toFixed(1)}%  stdRatio=${r.stdRatio.toFixed(2)}x  spikes=${r.spikes}/${r.nAccepted}  mean=${r.extractedMean.toFixed(1)} (true ${r.trueMean})`);
    }
  }
} finally {
  await browser.close();
}
