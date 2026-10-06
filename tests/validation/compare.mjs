// What the app's own scorer does NOT provide: tool-vs-tool agreement (nearest-neighbour cross
// matching, Bland-Altman, Pearson r), a generic bootstrap CI, and the coincidence ceiling. Scoring
// against ground truth is NOT here: every tool goes through tests/lib/score.mjs's
// scoreLocsInPage() (the app's scoreTruthCore()), one scorer for one truth. Pure functions, no I/O;
// the demo() self-check at the bottom is runnable directly.

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function byFrame(arr) {
  const m = new Map();
  for (const p of arr) { if (!m.has(p.frame)) m.set(p.frame, []); m.get(p.frame).push(p); }
  return m;
}

// Generic bootstrap CI over a flat array of numeric values (e.g. per-pair
// position errors) -- resamples WITH replacement, n resamples, returns the
// (alpha/2, 1-alpha/2) percentiles of statFn(resample).
export function bootstrapCI(values, statFn, { n = 1000, seed = 1, alpha = 0.05 } = {}) {
  if (!values.length) return { point: null, lo: null, hi: null };
  const rng = makeRng(seed);
  const point = statFn(values);
  const N = values.length;
  const samples = [];
  for (let b = 0; b < n; b++) {
    const resample = new Array(N);
    for (let i = 0; i < N; i++) resample[i] = values[Math.floor(rng() * N)];
    samples.push(statFn(resample));
  }
  samples.sort((a, b) => a - b);
  return { point, lo: samples[Math.floor(n * alpha / 2)], hi: samples[Math.min(n - 1, Math.floor(n * (1 - alpha / 2)))] };
}

function pearson(x, y) {
  const n = x.length;
  if (!n) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : null;
}

// Per-frame greedy nearest-neighbor matching between two TOOLS' own loc
// sets (no ground truth involved) -- the basis for cross-tool agreement.
export function matchCrossTool(locsA, locsB, radiusNm) {
  const aByFrame = byFrame(locsA), bByFrame = byFrame(locsB);
  const frames = new Set([...aByFrame.keys(), ...bByFrame.keys()]);
  const pairs = [];
  for (const fi of frames) {
    const bList = (bByFrame.get(fi) || []).slice();
    for (const a of (aByFrame.get(fi) || [])) {
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < bList.length; i++) {
        const d = Math.hypot(a.xNm - bList[i].xNm, a.yNm - bList[i].yNm);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0 && bestD <= radiusNm) { const b = bList.splice(bestI, 1)[0]; pairs.push({ a, b, dNm: bestD }); }
    }
  }
  return pairs;
}

// Bland-Altman (paired mean bias +/- 1.96*SD limits of agreement) plus
// Pearson r, on one scalar field extracted the same way from both sides of
// each matched pair. bias = mean(accessor(b) - accessor(a)).
export function blandAltman(pairs, accessor) {
  if (!pairs.length) return { n: 0, bias: null, sd: null, loaLo: null, loaHi: null, pearsonR: null };
  const valsA = pairs.map(p => accessor(p.a)), valsB = pairs.map(p => accessor(p.b));
  const diffs = valsA.map((v, i) => valsB[i] - v);
  const n = diffs.length;
  const mean = diffs.reduce((s, v) => s + v, 0) / n;
  const variance = diffs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  return { n, bias: mean, sd, loaLo: mean - 1.96 * sd, loaHi: mean + 1.96 * sd, pearsonR: pearson(valsA, valsB) };
}

// Context for reading a Jaccard below 1: the fraction of emitter-frames (non-haze, using the
// simulator's own overlap rule: a blink contributes to every frame it overlaps) that have another
// emitter-frame within radiusPx in the same frame. A real localizer sees those as one blob, so it
// is not a tool defect. This is NOT a dropping rule -- nothing is removed from any score.
export function coincidenceCeiling(events, nFrames, radiusPx) {
  const byFrame = new Map();
  for (let i = 0; i < events.x.length; i++) {
    if (events.haze[i]) continue;
    const f0 = Math.max(0, Math.floor(events.tStart[i])), f1 = Math.min(nFrames - 1, Math.floor(events.tEnd[i]));
    for (let f = f0; f <= f1; f++) {
      if (!(Math.min(f + 1, events.tEnd[i]) - Math.max(f, events.tStart[i]) > 0)) continue;
      let a = byFrame.get(f); if (!a) byFrame.set(f, a = []);
      a.push(events.x[i], events.y[i]);
    }
  }
  const cell = Math.max(radiusPx, 1e-6);
  let total = 0, coincident = 0;
  for (const xy of byFrame.values()) {
    const grid = new Map(), n = xy.length / 2;
    for (let i = 0; i < n; i++) { const k = Math.floor(xy[2 * i] / cell) + ',' + Math.floor(xy[2 * i + 1] / cell); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    for (let i = 0; i < n; i++) {
      total++;
      const cx = Math.floor(xy[2 * i] / cell), cy = Math.floor(xy[2 * i + 1] / cell);
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++)
        for (const j of grid.get((cx + dx) + ',' + (cy + dy)) || [])
          if (j !== i && Math.hypot(xy[2 * i] - xy[2 * j], xy[2 * i + 1] - xy[2 * j + 1]) <= radiusPx) { hit = true; break; }
      if (hit) coincident++;
    }
  }
  return { emitterFrames: total, coincident, fraction: total ? coincident / total : 0, radiusPx };
}

// Self-check: known cross-tool offsets and a hand-built coincidence case. Run directly:
// `node tests/validation/compare.mjs`.
function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`compare.mjs self-check FAILED: ${msg}`); };
  // Tool B = tool A shifted +5 nm in x, +100 photons, and missing one loc: 3 pairs, exact bias.
  const a = [], b = [];
  for (let f = 0; f < 2; f++) for (const [x, y] of [[1000, 1000], [3000, 3000]]) a.push({ frame: f, xNm: x, yNm: y, photons: 1000 + f });
  for (const l of a.slice(0, 3)) b.push({ ...l, xNm: l.xNm + 5, photons: l.photons + 100 });
  const pairs = matchCrossTool(a, b, 50);
  assert(pairs.length === 3, `expected 3 cross pairs, got ${pairs.length}`);
  const bx = blandAltman(pairs, l => l.xNm), bp = blandAltman(pairs, l => l.photons);
  assert(Math.abs(bx.bias - 5) < 1e-9 && bx.sd < 1e-9, `x bias should be exactly 5, got ${bx.bias}`);
  assert(Math.abs(bp.bias - 100) < 1e-9, `photon bias should be 100, got ${bp.bias}`);
  assert(matchCrossTool(a, b, 1).length === 0, 'radius 1 nm must match nothing');
  assert(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12, 'pearson of a line is 1');
  const ci = bootstrapCI([1, 2, 3, 4, 5], v => v.reduce((s, x) => s + x, 0) / v.length);
  assert(ci.point === 3 && ci.lo <= 3 && ci.hi >= 3, 'bootstrap CI must bracket the mean');
  // Two blinks overlap frame 0 within 2 px, one is far away: 2 of 3 emitter-frames coincident.
  const ev = { x: [10, 11, 50], y: [10, 10, 50], tStart: [0, 0, 0], tEnd: [1, 1, 1], haze: [0, 0, 0] };
  const c = coincidenceCeiling(ev, 1, 2);
  assert(c.emitterFrames === 3 && c.coincident === 2, `coincidence should be 2/3, got ${c.coincident}/${c.emitterFrames}`);
  assert(coincidenceCeiling({ ...ev, haze: [0, 1, 0] }, 1, 2).coincident === 0, 'haze must not count');
  console.log('compare.mjs self-check: PASS');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) demo();
