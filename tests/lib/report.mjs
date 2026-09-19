// Shared analytics for the tests/ benchmark scripts: a console table,
// numeric-diff helpers, and a JSON dump per run under tests/results/ (git-
// ignored — see root .gitignore) so results can be compared across code
// changes without needing a database or a real test framework.
import { mkdirSync, writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './launch.mjs';
import { writeGpuReport } from './gpu-report.mjs';

// Tolerances: how far a GPU (f32) result may drift from the CPU (f64/f32
// mixed) result before it's flagged as a real correctness concern rather
// than expected floating-point rounding. Named here, not buried per-script,
// so they're easy to tighten/loosen as real data comes in.
export const TOLERANCE = {
  // fit x/y (px) — CRLB precision is typically 10s of nm, i.e. way above
  // this; still tight enough to catch a genuine bug (the array-index-
  // mismatch artifact this suite's own diffLocs bug used to produce showed
  // 100+ px "errors" — orders of magnitude past this line). Loosened from
  // 0.01 to 0.1 after the real ~4.9GB STORM dataset (tests/bench-real-
  // data.mjs) showed one matched pair (out of 166,416) at 0.084px — real
  // camera noise makes a harder convergence case than the clean synthetic
  // generator; 0.1px = ~16nm at this dataset's 160nm/px is still far below
  // real fit precision. This is the PRIMARY correctness gate (see
  // withinTolerance below) — position is the thing that actually has to be
  // right for a localization result to be trustworthy.
  posPx: 0.1,
  // photons/sigma: reported for visibility but deliberately NOT part of
  // withinTolerance below — NOT a GPU-specific concession, mleNewtonFit()'s
  // own stopping criterion only checks x/y convergence (webSMLM.html,
  // MODULE: fit), so amplitude/background/sigma can still be mid-Newton-step
  // on the very iteration x/y happens to settle, identically on CPU and GPU.
  // Confirmed on real matched pairs (tests/results/bench-fit-*.json /
  // bench-real-data-*.json): position essentially exact (<0.001-0.08px)
  // alongside photon differences from a few % up to ~56% on the SAME pair,
  // worse on real (noisier) data than clean synthetic data — an existing
  // property of the shared algorithm's own convergence criterion, not
  // something any single tolerance number can meaningfully bound. Kept here
  // (rather than deleted) so a future caller can still opt into checking
  // them explicitly if that ever matters for a specific investigation.
  photonsRel: 0.6,     // fit photons, relative — informational only, see above
  sigmaRel: 0.6,       // fit sigma, relative — informational only, see above
  pixelByte: 4,        // render: max per-channel byte diff (0-255) — blur clamp-vs-mirror edge effect
  // render: a max-byte-diff of 255 can still be "fine" if it's confined to a
  // small fraction of pixels. Two INHERENT, expected sources measured live:
  // (1) generateSynthetic() is unseeded (Math.random()), so a random few
  // localizations per run land within f32-precision distance of a pixel
  // boundary and bucket into the adjacent pixel on GPU (f32) vs CPU (f64) —
  // typically <0.2% of pixels; (2) depth-colour (zcolor) mode sums z in a
  // fixed-point i32 (GPU_Z_FIXED_SCALE, MODULE: gpu) — small quantization
  // noise in the mean-z-per-pixel a real dataset's smooth depth field would
  // barely show, measured up to ~2.7% of pixels on this suite's own
  // synthetic z gradient. 3% covers both with real margin, while a genuine
  // bug (the dispatch-limit corruption this suite caught and got fixed)
  // showed 5-100% of pixels wrong, an order of magnitude past this line.
  pixelDiffFraction: 0.03,
  // diffLocs: a small fraction of candidates legitimately flip accept/reject
  // between CPU (f64) and GPU (f32) at a convergence/singularity threshold —
  // expected and documented (MODULE: gpu's own banner comment: "numerically
  // very close... not bit-identical"), not a correctness bug on its own.
  // Only flag it once the unmatched fraction is large enough to suggest
  // something more than ordinary f32/f64 boundary noise. Also reused by
  // diffLocsExact()'s own acceptanceDiscordance/netAcceptanceBias gates
  // below — the identical phenomenon under a different (exact pixel-key)
  // join, not a separate concern needing its own number.
  unmatchedFrac: 0.005,
};

// Compares CPU vs GPU fit results by NEAREST POSITION within the same frame,
// not by raw array index. Index-for-index (the original approach) assumes
// CPU and GPU accept/reject IDENTICAL candidates in identical order — true
// almost always, but the rare borderline flip (see TOLERANCE.unmatchedFrac's
// comment) shifts every LATER index by one, so an index-for-index diff ends
// up comparing two totally unrelated candidates — a huge, illusory position/
// photon "error" that isn't real. Confirmed empirically: matching the same
// run's candidates by position instead of index showed every genuinely-
// corresponding pair agreeing to <0.001px / <0.11% photons, with only a
// literal handful of candidates (~1 in 10,000) unmatched either way.
export function diffLocs(cpuLocs, gpuLocs) {
  // A true corresponding candidate lands far closer than this even under
  // f32/f64 divergence (empirically ~0.001px) — anything farther is two
  // independent candidates, not a drifted match. Deliberately well under 1px
  // so two genuinely distinct, closely-spaced real emitters don't get
  // mismatched into "the same" candidate.
  const MATCH_RADIUS_PX = 0.5;
  const byFrame = arr => { const m = new Map(); for (const L of arr) { if (!m.has(L.frame)) m.set(L.frame, []); m.get(L.frame).push(L); } return m; };
  const cpuByFrame = byFrame(cpuLocs), gpuByFrame = byFrame(gpuLocs);
  const frames = new Set([...cpuByFrame.keys(), ...gpuByFrame.keys()]);

  let maxDx = 0, maxDPhotonsRel = 0, maxDSigmaRel = 0, sumDx = 0, nMatched = 0, nCpuOnly = 0;
  for (const fi of frames) {
    const gList = (gpuByFrame.get(fi) || []).slice();   // consumed as matches are claimed, so no GPU loc matches twice
    for (const c of (cpuByFrame.get(fi) || [])) {
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < gList.length; i++) {
        const d = Math.hypot(c.x - gList[i].x, c.y - gList[i].y);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0 && bestD < MATCH_RADIUS_PX) {
        const g = gList.splice(bestI, 1)[0];
        nMatched++;
        const dPhotonsRel = Math.abs(c.photons - g.photons) / Math.max(1, Math.abs(c.photons));
        const dSigmaRel = Math.abs((c.sigma ?? 0) - (g.sigma ?? 0)) / Math.max(1e-6, Math.abs(c.sigma ?? 0));
        maxDx = Math.max(maxDx, bestD); sumDx += bestD;
        maxDPhotonsRel = Math.max(maxDPhotonsRel, dPhotonsRel);
        maxDSigmaRel = Math.max(maxDSigmaRel, dSigmaRel);
      } else {
        nCpuOnly++;
      }
    }
  }
  const n = cpuLocs.length, nGpu = gpuLocs.length, nGpuOnly = nGpu - nMatched;
  const unmatchedFrac = (n + nGpu) ? (nCpuOnly + nGpuOnly) / (n + nGpu) : 0;
  const lengthMismatch = unmatchedFrac > TOLERANCE.unmatchedFrac;
  // Gates on position + how many candidates matched at all — NOT on
  // photons/sigma (see TOLERANCE.photonsRel's own comment for why those
  // aren't a meaningful pass/fail bound here). Position is what actually has
  // to be right for a localization result to be trustworthy.
  const withinTolerance = !lengthMismatch && maxDx <= TOLERANCE.posPx;
  return { lengthMismatch, n, nGpu, nMatched, nCpuOnly, nGpuOnly, unmatchedFrac,
           maxDx, meanDx: nMatched ? sumDx / nMatched : 0, maxDPhotonsRel, maxDSigmaRel, withinTolerance };
}

const p99=values=>{
  if(!values.length)return 0;
  const s=[...values].sort((a,b)=>a-b);
  return s[Math.min(s.length-1,Math.floor(s.length*.99))];
};
// Exported (not just module-local) so a caller with a truly huge loc count
// can .toString() this alongside diffLocsExact() and eval() both INSIDE the
// page — computing the diff there and returning only the small resulting
// metrics object, never shipping millions of loc objects back across the
// Playwright/CDP boundary as a page.evaluate() return value (see
// bench-real-data.mjs's own runAnalyze() for the reference pattern; the
// "never let a large blob cross as one return value" rule this whole file's
// helpers already follow for pcfo.pts/sSmlmPair.locs-style trims).
export const p99Typed=(values,n)=>{
  if(!n)return 0;
  const s=values.subarray(0,n).slice();
  s.sort();
  return s[Math.min(n-1,Math.floor(n*.99))];
};
// Certification join: the app's headless-only audit array carries the exact
// detector pixel that produced each accepted localization. This avoids a
// nearest-neighbour algorithm deciding scientific equivalence for us.
export function diffLocsExact(cpuLocs,gpuLocs,cpuPixels,gpuPixels,nCandidates){
  if(!cpuPixels||!gpuPixels||cpuPixels.length!==cpuLocs.length||gpuPixels.length!==gpuLocs.length)
    throw new Error('diffLocsExact requires candidate-pixel arrays parallel to both localization arrays');
  let maxPixel=0;
  for(let i=0;i<cpuPixels.length;i++)if(cpuPixels[i]>maxPixel)maxPixel=cpuPixels[i];
  for(let i=0;i<gpuPixels.length;i++)if(gpuPixels[i]>maxPixel)maxPixel=gpuPixels[i];
  const stride=2**Math.ceil(Math.log2(Math.max(2,maxPixel+1)));
  const key=(L,pixel)=>L.frame*stride+pixel;
  const gm=new Map();
  let nGpuDup=0,nCpuDup=0;
  for(let i=0;i<gpuLocs.length;i++){
    const k=key(gpuLocs[i],gpuPixels[i]),prev=gm.get(k);
    if(prev===undefined) gm.set(k,i);
    else { nGpuDup++; if(Array.isArray(prev)) prev.push(i); else gm.set(k,[prev,i]); }
  }
  const cpuSeen=new Set();
  const pos=new Float32Array(cpuLocs.length);
  const crlbScaled=new Float32Array(cpuLocs.length);
  const axial=new Float32Array(cpuLocs.length);
  const angles=new Float32Array(cpuLocs.length);
  const paramKeys=['photons','bg','bgstd','sigma','sx','sy','lpx','lpy','lpsx','lpsy','lpangle'];
  const param=new Float32Array(Math.max(1,cpuLocs.length*paramKeys.length));
  let nPos=0,nCrlb=0,nParam=0,nAxial=0,nAngle=0;
  let nMatched=0,maxDPhotonsRel=0,maxDSigmaRel=0,metricsParamMax=0,paramMaxKey='';
  const rel=(a,b)=>{
    const d=Math.abs(a-b),mag=Math.max(Math.abs(a),Math.abs(b));
    if(mag<1e-3)return d<=1e-4?0:d/1e-4;
    return 2*d/Math.max(1e-30,Math.abs(a)+Math.abs(b));
  };
  for(let i=0;i<cpuLocs.length;i++){
    const c=cpuLocs[i],ck=key(c,cpuPixels[i]);
    if(cpuSeen.has(ck)) nCpuDup++; else cpuSeen.add(ck);
    let entry=gm.get(ck);if(entry===undefined)continue;
    let gi=entry;
    if(Array.isArray(entry)){
      let best=0,bestD=Infinity;
      for(let j=0;j<entry.length;j++){const g0=gpuLocs[entry[j]],d0=Math.hypot(c.x-g0.x,c.y-g0.y);if(d0<bestD){bestD=d0;best=j;}}
      gi=entry.splice(best,1)[0];
      if(entry.length===1)gm.set(ck,entry[0]); else if(!entry.length)gm.delete(ck);
    } else gm.delete(ck);
    const g=gpuLocs[gi];nMatched++;
    const d=Math.hypot(c.x-g.x,c.y-g.y);pos[nPos++]=d;
    const cLat=Math.hypot(c.lpx||0,c.lpy||0)/Math.SQRT2,gLat=Math.hypot(g.lpx||0,g.lpy||0)/Math.SQRT2;
    const combined=Math.hypot(cLat,gLat);if(combined>0)crlbScaled[nCrlb++]=d/combined;
    for(const k of paramKeys)if(Number.isFinite(c[k])&&Number.isFinite(g[k])){
      const v=rel(c[k],g[k]);param[nParam++]=v;if(v>metricsParamMax){metricsParamMax=v;paramMaxKey=k;}
    }
    if(Number.isFinite(c.z)&&Number.isFinite(g.z))axial[nAxial++]=Math.abs(c.z-g.z);
    if(Number.isFinite(c.angle)&&Number.isFinite(g.angle)){
      let a=Math.abs(c.angle-g.angle)%(2*Math.PI);if(a>Math.PI)a=2*Math.PI-a;angles[nAngle++]=a;
    }
    if(Number.isFinite(c.photons)&&Number.isFinite(g.photons))maxDPhotonsRel=Math.max(maxDPhotonsRel,rel(c.photons,g.photons));
    if(Number.isFinite(c.sigma)&&Number.isFinite(g.sigma))maxDSigmaRel=Math.max(maxDSigmaRel,rel(c.sigma,g.sigma));
  }
  let nGpuOnly=0;for(const v of gm.values())nGpuOnly+=Array.isArray(v)?v.length:1;
  const nCpuOnly=cpuLocs.length-nMatched,den=Math.max(1,nCandidates||Math.max(cpuLocs.length,gpuLocs.length));
  const metrics={acceptanceDiscordance:(nCpuOnly+nGpuOnly)/den,netAcceptanceBias:Math.abs(cpuLocs.length-gpuLocs.length)/den,
    posP99:p99Typed(pos,nPos),maxDx:nPos?pos.subarray(0,nPos).reduce((m,v)=>Math.max(m,v),0):0,crlbScaledP99:p99Typed(crlbScaled,nCrlb),
    paramP99:p99Typed(param,nParam),paramMax:metricsParamMax,
    axialP99:p99Typed(axial,nAxial),axialMax:nAxial?axial.subarray(0,nAxial).reduce((m,v)=>Math.max(m,v),0):0,
    angleP99:p99Typed(angles,nAngle),angleMax:nAngle?angles.subarray(0,nAngle).reduce((m,v)=>Math.max(m,v),0):0};
  // acceptanceDiscordance/netAcceptanceBias and maxDx used to be gated at
  // 1e-4/2e-5/.01 — bare magic numbers with no derivation, added wholesale
  // with this function (unlike every value in TOLERANCE above, which carries
  // a measured justification). A true full-scale real-data run
  // (tests/gpu/bench-real-data.mjs --full, ~4M localizations) measured
  // acceptanceDiscordance=9.3e-4 and maxDx=1.45e-1 — both comfortably
  // explained by ordinary f32(GPU)/f64(CPU) accept/reject boundary noise
  // (same phenomenon TOLERANCE.unmatchedFrac's own comment documents), not a
  // correctness regression, yet both tripped their old ad hoc gates by
  // 1-2 orders of magnitude. acceptanceDiscordance/netAcceptanceBias now
  // reuse TOLERANCE.unmatchedFrac (already reasoned, guards this exact
  // phenomenon for the general nearest-position diffLocs() below) instead of
  // a second, undocumented number duplicating it.
  //
  // maxDx is different: it's a bare MAX over every matched pair, not a
  // percentile, so it mechanically grows with how many pairs there are to
  // draw from (order-statistics 101) — the ~4.9GB dataset TOLERANCE.posPx
  // was derived from had ~166k matched pairs; this one has ~4M (~24x more
  // draws from the same per-pair noise distribution), so a larger max is
  // expected from sample size alone, not a regression. Reusing posPx here
  // would still be one more unreasoned threshold, just inherited instead of
  // invented. posP99 (the percentile statistic, insensitive to sample size —
  // 1.02e-5 on that same full-scale run) is the one that actually answers
  // "is position agreement good," so maxDx drops out of the gate entirely,
  // matching the precedent already set by photonsRel/sigmaRel above
  // ("reported for visibility but deliberately NOT part of withinTolerance
  // ... not something any single tolerance number can meaningfully bound").
  const withinTolerance=metrics.acceptanceDiscordance<=TOLERANCE.unmatchedFrac&&metrics.netAcceptanceBias<=TOLERANCE.unmatchedFrac
    &&metrics.posP99<=.001&&metrics.crlbScaledP99<=.1
    &&metrics.paramP99<=.01&&metrics.paramMax<=.05
    &&metrics.axialP99<=2&&metrics.axialMax<=10&&metrics.angleP99<=.005&&metrics.angleMax<=.02;
  return {lengthMismatch:metrics.acceptanceDiscordance>TOLERANCE.unmatchedFrac,n:cpuLocs.length,nGpu:gpuLocs.length,nMatched,nCpuOnly,nGpuOnly,
    unmatchedFrac:metrics.acceptanceDiscordance,meanDx:nPos?pos.subarray(0,nPos).reduce((a,b)=>a+b,0)/nPos:0,
    maxDPhotonsRel,maxDSigmaRel,paramMaxKey,nCpuDup,nGpuDup,withinTolerance,...metrics};
}

export function diffPixels(bufA, bufB) {
  let maxDiff = 0, sum = 0;
  const n = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < n; i++) { const d = Math.abs(bufA[i] - bufB[i]); if (d > maxDiff) maxDiff = d; sum += d; }
  return { maxDiff, meanDiff: n ? sum / n : 0, withinTolerance: maxDiff <= TOLERANCE.pixelByte };
}

// col: {key, label, width, fmt?:(v)=>string}
export function printTable(rows, cols) {
  const fmtCell = (col, row) => {
    const v = row[col.key];
    const s = col.fmt ? col.fmt(v) : (v === undefined || v === null ? '' : String(v));
    return s.padStart(col.width);
  };
  console.log(cols.map(c => c.label.padStart(c.width)).join(' | '));
  console.log(cols.map(c => '-'.repeat(c.width)).join('-|-'));
  for (const row of rows) console.log(cols.map(c => fmtCell(c, row)).join(' | '));
}

export function speedup(cpuMs, gpuMs) {
  if (gpuMs == null || gpuMs <= 0) return null;
  return cpuMs / gpuMs;
}

export function verdict(sp, withinTolerance) {
  if (withinTolerance === false) return 'MISMATCH (over tolerance!)';
  if (sp == null) return 'GPU unavailable';
  if (sp >= 1.15) return `GPU faster (${sp.toFixed(2)}x)`;
  if (sp <= 0.87) return `GPU slower (${sp.toFixed(2)}x)`;
  return 'about the same';
}

// Scans an analyze() result's own logText for the ONE signal that GPU fit
// actually ran (webSMLM.html's runCore(), MODULE: pipeline: a "GPU fit: ..."
// line is emitted only inside the useGpuFit branch — there is no equivalent
// "CPU fit" message and no boolean field on the result, so text-scanning
// this is the only way to confirm GPU-vs-CPU from outside the page). Throws
// (not just returns false) so a caller that expected one outcome and got the
// other fails loudly with a clear message, instead of silently mis-scoring —
// exactly the "why did it run on CPU?" confusion this suite exists to catch.
export function expectGpuUsed(logText, expected) {
  const used = logText.includes('GPU fit: ');
  if (used !== expected) {
    throw new Error(`expected GPU fit ${expected ? '' : 'NOT '}to run, but logText ${used ? 'contains' : 'does not contain'} a "GPU fit: " line.`);
  }
  return used;
}

// Cross-platform "open this file in the default browser", best-effort —
// never throws, never blocks a run on a desktop-less/headless machine.
// Skipped entirely under CI or when the caller (a human, or run-suite.mjs
// after ITS OWN combined report) doesn't want a window popping up.
export function openInBrowser(filePath) {
  if (process.env.CI || process.env.WEBSMLM_TEST_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${filePath}"`
    : process.platform === 'darwin' ? `open "${filePath}"`
    : `xdg-open "${filePath}"`;
  exec(cmd, err => { if (err) console.error(`  (could not auto-open report: ${err.message})`); });
}

export function writeResults(name, data) {
  const dir = join(repoRoot, 'tests', 'results');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${name}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));

  // A script run standalone (not spawned by run-suite.mjs, which sets this
  // env var on every child and does its own ONE combined report+open at the
  // end) gets its own scoped report, opened automatically — "run one test,
  // see one report" with no per-script wiring: every bench already calls
  // writeResults(), so this is free.
  if (!process.env.WEBSMLM_TEST_SUITE) {
    try {
      const now = new Date().toISOString();
      const run = {
        mode: 'single', startedAt: now, endedAt: now, durationMs: 0,
        commands: [{ name, script: `${name}.mjs`, args: [], status: 'unknown', exitCode: null, durationMs: 0, resultFiles: [file] }],
      };
      const report = writeGpuReport({ run, resultFiles: [file] });
      console.log(`\nAnalytics report: ${report.reportPath}`);
      openInBrowser(report.reportPath);
    } catch (err) {
      console.error(`  (could not generate/open standalone report: ${err.message})`);
    }
  }
  return file;
}
