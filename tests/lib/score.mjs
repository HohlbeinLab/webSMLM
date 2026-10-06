// The harness's single scoring authority: ONE scorer (the app's own scoreTruthCore(), MODULE:
// validation) scores EVERY tool's localizations against ONE ground truth, so webSMLM's numbers and
// another tool's are comparable by construction. Nothing here does any numerics.
//
// The `locs` argument is a plain array passed in from Node — a tool's parsed CSV, not a page global.
// That is the entire point: scoreTruthCore() takes gtEvents as a parameter rather than reading the
// `groundTruthEvents` global, so it can score anything.
//
// LOC FIELDS scoreTruthCore() READS (what a caller must supply; everything else is ignored):
//   frame   REQUIRED, 0-based integer (it is read as `L.frame|0`, so a missing frame silently puts
//           every localization in frame 0 — the single easiest way to get a meaningless score).
//   x, y    REQUIRED, CAMERA PIXELS of the unrotated/uncropped movie (not nm).
//   z       nm, optional. Absent/non-finite on either side => that pair contributes no axial
//           statistics (a 2D tool scores fine, `has3d` comes back false).
//   x0,y0,z0  optional raw (pre-drift-correction) coordinates. When present they are used INSTEAD
//           of x/y/z, because the truth is drifted. A CSV has none, so a CSV of a drift-CORRECTED
//           session cannot be scored honestly — the scorer logs a warning about exactly that.
//   photons   optional, for the photometry ratio (fitted/true).
//   lpx, lpy  optional CRLB in camera px, lpz in nm — the "reported precision vs CRLB" columns.
//   zClamped  optional flag, counted for the axial-failure diagnostics.
//   nMerged   must NOT be present: its presence means temporally clustered locs and the scorer
//           refuses (per-frame matching is meaningless then).
import assert from 'node:assert/strict';

// cfg defaults mirror PARAMS' own validation_* defaults; pass overrides to change them.
// `_frameW`/`_frameH` come from the ground truth's own movie block — deliberately NOT from
// truthScoreConfig(), which reads the page's `stack` global and so would describe whatever movie
// happens to be loaded rather than the one this ground truth belongs to.
//
// `_runFirst`/`_runLast`/`_runStopped` are set from the movie too (0 .. frames-1, not stopped) and
// are NOT optional: without them scoreTruthCore() falls back to the span the LOCALIZATIONS happen to
// cover, so truth in frames where a tool found nothing is never counted as a false negative. Two
// tools would then be scored over two different denominators, which is the one thing this layer
// exists to prevent. A caller that genuinely scored a restricted range can override them.
//
// `cfg.gain`/`cfg.camoffset` are deliberately absent: an external tool's CSV carries no camera
// context, so there is nothing honest to compare the simulated camera against. The only thing that
// turns off is the scorer's gain/offset-mismatch warning (webSMLM.html, scoreTruthCore()); every
// number it reports is unaffected.
export const DEFAULT_SCORE_CFG = {
  validation_matchRadius: 250, validation_zBins: 20,
  validation_minPhotons: 300, validation_border: -1, validation_crowdRadius: 300,
  validation_matchMode: 'lateral', validation_axialTol: 500,
  validation_photonMode: 'absolute', validation_photonQuantile: 25,
  validation_borderMode: 'dontcare',
  _detBorder: 0,            // no Run behind an external tool's CSV, so no detector border to inherit
};

// `opts.chunk` (default 100000): above this many locs the array crosses the CDP bridge in pieces,
// staged in window.__scoreLocs and read back inside the page, so no single message scales with the
// loc count. At or below it the single-shot path is used (unchanged).
export async function scoreLocsInPage(page, locs, groundTruth, cfg = {}, { chunk = 100000 } = {}) {
  assert.ok(Array.isArray(locs) && locs.length, 'scoreLocsInPage: locs must be a non-empty array');
  assert.ok(groundTruth && groundTruth.events && groundTruth.movie,
    'scoreLocsInPage: groundTruth must be a webSMLM-groundtruth object (events + movie), as simulateInPage() returns');

  const staged = locs.length > chunk;
  if (staged) {
    await page.evaluate(() => { window.__scoreLocs = []; });
    for (let i = 0; i < locs.length; i += chunk)
      await page.evaluate(c => { for (const l of c) window.__scoreLocs.push(l); }, locs.slice(i, i + chunk));
  }
  let r;
  try {
  r = await page.evaluate(async ({ locs, gt, cfg, staged }) => {
    if (staged) locs = window.__scoreLocs;
    const m = gt.movie, E = gt.events, N = E.x.length;
    // Column-wise -> array-of-objects, mirroring loadGroundTruth()'s own conversion exactly
    // (including the derived photonsTotal). loadGroundTruth() itself is NOT called: it is
    // DOM-guarded (refuses without a matching, unrotated, uncropped stack) and mutates globals.
    const ev = new Array(N);
    for (let i = 0; i < N; i++) {
      const t0 = E.tStart[i], t1 = E.tEnd[i], rate = E.rate[i];
      ev[i] = { x: E.x[i], y: E.y[i], z: E.z[i], tStart: t0, tEnd: t1, rate,
                moleculeId: E.moleculeId[i], haze: !!E.haze[i],
                photonsTotal: rate * Math.max(0, Math.min(t1, m.frames) - Math.max(t0, 0)) };
    }
    ev._movie = { w: m.w, h: m.h, frames: m.frames, pxNm: m.pxNm };
    if (gt.theory) ev._theory = { ...gt.theory, bg: { ...gt.theory.bg, map: gt.theory.bg.map ? Float32Array.from(gt.theory.bg.map) : null } };
    // trueDrift is an ACCESSOR object, not arrays: scoreTruthCore() calls trueDrift.dx(f)/dy(f) and
    // reads .total. dx/dy are in NANOMETRES (the scorer divides by px), .total is in camera px.
    // Same rehydration loadGroundTruth() performs.
    const d = gt.drift;
    const trueDrift = d ? { n: m.frames, px: m.pxNm, total: d.totalPx,
                            dx: f => d.dxNm[Math.min(f, d.dxNm.length - 1)] || 0,
                            dy: f => d.dyNm[Math.min(f, d.dyNm.length - 1)] || 0 } : null;

    const scfg = { _runFirst: 0, _runLast: m.frames - 1, _runStopped: false, ...cfg, _frameW: m.w, _frameH: m.h };
    const logs = [];
    const onLog = msg => logs.push(String(msg));
    scfg._crlbModel = await truthCrlbModelFor(ev, onLog);      // null without _theory; tolerated
    const res = await scoreTruthCore(locs, ev, m.frames, m.pxNm, trueDrift, scfg, { onLog });
    if (res.err) return { err: res.err, logs };

    // CDP payload rule: dx/dy (px) and dz/zTrue (nm) are one entry PER TRUE POSITIVE — tens of
    // thousands at realistic scale — and so are photonPairs.{true,fitted} and each z bin's own
    // dz/lat arrays. Dropped here, inside the page; every statistic computed from them (bias,
    // RMSE, medians, percentiles, per-bin bias/spread/lat50, photometry, crlbBins) is already in
    // the result, and nResiduals records how many pairs backed them.
    const { dx, dy, dz, zTrue, photonPairs, bins, ...rest } = res;
    return { ...rest, nResiduals: dx.length,
             bins: bins ? bins.map(({ dz: _d, lat: _l, ...b }) => b) : null,
             hasCrlbModel: !!scfg._crlbModel, logs };
  }, { locs: staged ? null : locs, gt: groundTruth, cfg: { ...DEFAULT_SCORE_CFG, ...cfg }, staged });
  } finally { if (staged) await page.evaluate(() => { window.__scoreLocs = null; }); }

  if (r.err) throw new Error(`scoreLocsInPage: ${r.err}`);
  return r;
}

// The ground-truth CSV written by Save sim. movie (buildGroundTruthCsv()) as scorer-ready locs:
// the simulator's OWN per-emitter-frame answer, in the same units a tool's CSV would arrive in.
// Columns: frame(1-based), x,y,z [nm], x_structure,y_structure [nm], photons, molecule_id,
// out_of_focus. x/y include the simulated drift, which is what the scorer compares against.
// Haze rows are dropped, matching groundTruthLocs (generateSynthetic() filters `haze`).
export function locsFromGroundTruthCsv(text, pxNm) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  const lp = 1 / pxNm;                 // 1 nm in camera px, the lpx/lpy generateSynthetic() pins
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (+c[8]) continue;               // out_of_focus (haze)
    out.push({ frame: +c[0] - 1, x: +c[1] / pxNm, y: +c[2] / pxNm, z: c[3] === '' ? NaN : +c[3],
               photons: c[6] === '' ? NaN : +c[6], lpx: lp, lpy: lp,
               moleculeId: c[7] === '' ? null : +c[7] });   // not read by the scorer; lets a caller subset by molecule
  }
  return out;
}
