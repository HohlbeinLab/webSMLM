#!/usr/bin/env node
// GPU vs CPU real-data sanity check — drives window.webSMLM.analyze() the
// same way tools/webSMLM-cli.mjs does (page.setInputFiles + page.evaluate),
// against the large 3D STORM dataset already sitting in the git-ignored
// temp/ folder (see experimental_data/README.md's "Dataset II" for the
// camera parameters used below). This is a real stress test, not a toy —
// ~40,000 frames streamed from a ~4.9 GB file — so by default it only
// processes a bounded slice (fitFirstFrame/fitLastFrame, ordinary PARAMS
// overrides analyze() already accepts) for a predictable run time.
// Pass --full to drop the bound and process the entire stack.
//
// Skips (does not fail) if the file isn't present — this is real,
// git-ignored, multi-GB data that won't exist on a fresh clone.
//
// Usage: cd tests && npm install (once), then node bench-real-data.mjs [--full]
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { diffLocsExact, expectGpuUsed, p99Typed, printTable, speedup, verdict, writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const FULL = process.argv.includes('--full');
const TARGET = await resolveDataFile('STORM_STACK', join('19165061', 'Aquired STORM.tif'));
if (!TARGET) { console.log('Skipping real-data benchmark.'); process.exit(0); }

const BASE_CONFIG = {
  method: 'gaussmle',   // the only GPU-fit-accelerated method
  pxnm: 160, gain: 0.1248, camoffset: 100,   // this dataset's real camera parameters
  ...(FULL
    // --full genuinely needs a real ceiling: the desktop default (unset,
    // i.e. Infinity) leaves checkLocsMemory()'s own auto-stop as a no-op,
    // and this run additionally keeps BOTH passes' full loc sets resident
    // in-page at once for the diff (window._cpuLocs + the GPU pass's own
    // result) — confirmed directly this session: an uncapped --full run on
    // this exact ~40,000-frame/~3.3M-localization dataset reliably crashed
    // the tab (no RangeError, no catchable error — a real OOM tab kill) on
    // a 16GB machine; capping memBudgetGB well under total system RAM lets
    // the Run's own real, calculated-reserve stop trigger instead of
    // crashing outright. Raise/lower to match the machine actually running
    // this — 8 is what was verified here, not a universal constant.
    ? { memBudgetGB: 8 }
    : { fitFirstFrame: 1, fitLastFrame: 5000 }),
};

console.log(`Target: ${TARGET}`);
console.log(FULL ? 'Processing the FULL stack (--full) — this can take a long time.' : `Processing frames 1-5000 only (pass --full for the entire ~40,000-frame stack).`);

const { browser, page } = await launchPage();
try {
  await page.setInputFiles('#analyzeFileInput', TARGET);

  // Both passes' locs/auditCandidatePixels stay IN-PAGE (window._cpuLocs/
  // _cpuPixels), never returned — a real dataset at this scale (the
  // ~40,000-frame/~4.9GB stack this script targets) produces millions of
  // loc objects, and returning that many (even trimmed to 16 fields each)
  // as a page.evaluate() return value reliably crashes the tab: confirmed
  // directly this session on a SECOND, denser real dataset (~1.2M locs from
  // just 5000 frames) — the crash traced to the return-value construction
  // itself, not analyze() or auditCandidates, both of which complete fine
  // when nothing large crosses back over CDP. diffLocsExact()/p99Typed()
  // (MODULE: tests/lib/report.mjs, both plain/dependency-free) are shipped
  // into the page via .toString()+eval() so the SAME exact-audit algorithm
  // Node would run executes there instead — only the small resulting
  // metrics object crosses back.
  async function runCpuPass() {
    let lastPct = -10;
    page.removeAllListeners('console');
    page.on('console', msg => {
      const m = msg.text().match(/^\[progress\](\d+(?:\.\d+)?)/);
      if (m) { const pct = +m[1]; if (pct - lastPct >= 5) { process.stdout.write(`\r  CPU run: ${pct.toFixed(0)}%  `); lastPct = pct; } }
      else if (msg.type() === 'error') console.error('  [page error]', msg.text());
    });
    const result = await page.evaluate(async ({ cfg, fileInputId }) => {
      const config = Object.assign({}, cfg, { useGpu: false, auditCandidates: true });
      config.file = document.getElementById(fileInputId).files[0];
      config.onProgress = pct => console.log('[progress]' + pct);
      const r = await window.webSMLM.analyze(config);
      window._cpuLocs = r.locs;
      window._cpuPixels = r.auditCandidatePixels;
      return { nLocalizations: r.locs.length, timings: r.timings };
    }, { cfg: BASE_CONFIG, fileInputId: 'analyzeFileInput' });
    process.stdout.write('\n');
    return result;
  }

  async function runGpuPassAndDiff(diffSrc, p99Src) {
    let lastPct = -10;
    page.removeAllListeners('console');
    page.on('console', msg => {
      const m = msg.text().match(/^\[progress\](\d+(?:\.\d+)?)/);
      if (m) { const pct = +m[1]; if (pct - lastPct >= 5) { process.stdout.write(`\r  GPU run: ${pct.toFixed(0)}%  `); lastPct = pct; } }
      else if (msg.type() === 'error') console.error('  [page error]', msg.text());
    });
    const result = await page.evaluate(async ({ cfg, fileInputId, diffSrc, p99Src, nCandidates }) => {
      const config = Object.assign({}, cfg, { useGpu: true, auditCandidates: true });
      config.file = document.getElementById(fileInputId).files[0];
      config.onProgress = pct => console.log('[progress]' + pct);
      const r = await window.webSMLM.analyze(config);
      // Wrapped in parens: p99Typed.toString()/diffLocsExact.toString() give
      // back a bare function expression/declaration TEXT, with no variable
      // binding of its own — eval-ing that text directly (as a statement)
      // would silently discard an arrow function (p99Typed) as an unused
      // expression. Parens force both into an EXPRESSION eval() actually
      // returns, uniformly for a `const x=(...)=>{}` arrow or a plain
      // `function x(){}` declaration alike.
      const p99Typed = eval('(' + p99Src + ')');
      const diffLocsExact = eval('(' + diffSrc + ')');
      const diff = diffLocsExact(window._cpuLocs, r.locs, window._cpuPixels, r.auditCandidatePixels, nCandidates);
      delete window._cpuLocs; delete window._cpuPixels;
      return { nLocalizations: r.locs.length, timings: r.timings, execution: r.execution, logText: r.logText, diff };
    }, { cfg: BASE_CONFIG, fileInputId: 'analyzeFileInput', diffSrc, p99Src, nCandidates: cpu.timings.nCand });
    process.stdout.write('\n');
    return result;
  }

  console.log('\nRunning CPU pass...');
  const cpu = await runCpuPass();
  console.log(`CPU: ${cpu.nLocalizations} localizations in ${Math.round(cpu.timings.runMs)} ms (fit ${Math.round(cpu.timings.tFit)} ms).`);

  console.log('\nRunning GPU pass...');
  const gpuRun = await runGpuPassAndDiff(diffLocsExact.toString(), p99Typed.toString());
  console.log(`GPU: ${gpuRun.nLocalizations} localizations in ${Math.round(gpuRun.timings.runMs)} ms (fit ${Math.round(gpuRun.timings.tFit)} ms).`);
  // method:'gaussmle' + useGpu:true is the one case where GPU fit SHOULD
  // engage (webSMLM.html runCore(), ~line 10764) — turns the already-inferred
  // "GPU ran" (from the speed numbers) into an explicit, direct check.
  expectGpuUsed(gpuRun.logText, true);
  console.log('  (confirmed: logText contains a "GPU fit: ..." line)');

  const diff = gpuRun.diff;
  // A dataset this size clears runCore()'s worker-pool threshold on the CPU
  // side, so cpu.timings.tFit is SUMMED ACROSS EVERY WORKER THREAD (see
  // runCore()'s own comment on this — it "legitimately exceeds the wall
  // clock" by design), while the GPU path is a single dispatch stream with
  // no such multiplier. Comparing tFit directly is comparing apples to
  // oranges. wallSpeedup is the trustworthy number; fitSpeedup is kept as a
  // labelled, explicitly-caveated secondary column.
  const fitSp = speedup(cpu.timings.tFit, gpuRun.timings.tFit);
  const wallSp = speedup(cpu.timings.runMs, gpuRun.timings.runMs);
  const row = {
    label: FULL ? 'full stack' : 'frames 1-5000', nCand: cpu.timings.nCand, nLocs: cpu.nLocalizations,
    cpuFitMs: Math.round(cpu.timings.tFit), gpuFitMs: Math.round(gpuRun.timings.tFit),
    cpuRunMs: Math.round(cpu.timings.runMs), gpuRunMs: Math.round(gpuRun.timings.runMs),
    fitSpeedup: fitSp, wallSpeedup: wallSp,
    acceptDiscord: diff.acceptanceDiscordance, netBias: diff.netAcceptanceBias,
    posP99: diff.posP99, paramP99: diff.paramP99,
    maxDx: diff.maxDx,
    maxDPhotonsRel: diff.maxDPhotonsRel,
    verdict: diff.lengthMismatch ? `LENGTH MISMATCH (cpu ${diff.n} vs gpu ${diff.nGpu})` : verdict(wallSp, diff.withinTolerance),
  };

  console.log('');
  printTable([row], [
    { key: 'label', label: 'run', width: 14 },
    { key: 'nCand', label: 'candidates', width: 10 },
    { key: 'nLocs', label: 'locs', width: 8 },
    { key: 'cpuRunMs', label: 'CPU wall ms', width: 11 },
    { key: 'gpuRunMs', label: 'GPU wall ms', width: 11 },
    { key: 'wallSpeedup', label: 'WALL speedup', width: 12, fmt: v => v == null ? 'n/a' : v.toFixed(2) + 'x' },
    { key: 'fitSpeedup', label: 'fit-only(*)', width: 11, fmt: v => v == null ? 'n/a' : v.toFixed(2) + 'x' },
    { key: 'maxDx', label: 'maxΔpx', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'acceptDiscord', label: 'discord', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(1) },
    { key: 'netBias', label: 'netbias', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(1) },
    { key: 'posP99', label: 'p99px', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'paramP99', label: 'p99param', width: 9, fmt: v => v == null ? 'n/a' : v.toExponential(2) },
    { key: 'verdict', label: 'verdict', width: 26 },
  ]);
  console.log('(*) fit-only compares runCore()\'s own tFit field directly — misleading whenever the CPU side used its worker pool (tFit is summed across every worker thread there, not wall time); WALL speedup is the trustworthy number.');

  const fitStage = gpuRun.execution && gpuRun.execution.stages && gpuRun.execution.stages.fit;
  const fitFailed = !fitStage || fitStage.path !== 'gpu' || fitStage.fallbackCalls || (fitStage.reasons || []).includes('failed');
  const realFailed = cpu.timings.nCand !== gpuRun.timings.nCand || !diff.withinTolerance || fitFailed || (FULL && (!wallSp || wallSp < 2));
  if (realFailed) {
    if (cpu.timings.nCand !== gpuRun.timings.nCand) console.error(`Candidate count mismatch: CPU ${cpu.timings.nCand}, GPU ${gpuRun.timings.nCand}`);
    if (!diff.withinTolerance) console.error('CPU/GPU localization diff exceeded exact audit gates.');
    if (fitFailed) console.error(`GPU fit did not complete cleanly: ${JSON.stringify(fitStage || null)}`);
    if (FULL && (!wallSp || wallSp < 2)) console.error(`Full-stack GPU wall speedup below 2x gate: ${wallSp ? wallSp.toFixed(2) : 'n/a'}x`);
    process.exitCode = 1;
  }

  // Second, separate scenario: a bounded-frame FULL PIPELINE (localize +
  // drift correction + NeNA + FRC + plot export) together on real data,
  // CPU-only — the isolated method:'gaussmle'-only comparison above can't
  // catch an integration issue between these features on a real, noisy
  // dataset. Not a GPU/CPU speed comparison (no GPU column here on purpose).
  console.log('\nRunning full-pipeline scenario (drift + NeNA + FRC + plots, CPU)...');
  let lastPct2 = -10;
  page.removeAllListeners('console');
  page.on('console', msg => {
    const m = msg.text().match(/^\[progress\](\d+(?:\.\d+)?)/);
    if (m) { const pct = +m[1]; if (pct - lastPct2 >= 5) { process.stdout.write(`\r  pipeline run: ${pct.toFixed(0)}%  `); lastPct2 = pct; } }
    else if (msg.type() === 'error') console.error('  [page error]', msg.text());
  });
  const pipeline = await page.evaluate(async ({ fileInputId }) => {
    const config = {
      method: 'gaussmle', pxnm: 160, gain: 0.1248, camoffset: 100,
      fitFirstFrame: 1, fitLastFrame: 3000,
      correctDrift: true, computeNeNA: true, computeFRC: true, exportPlots: true,
    };
    config.file = document.getElementById(fileInputId).files[0];
    config.onProgress = pct => console.log('[progress]' + pct);
    const r = await window.webSMLM.analyze(config);
    return {
      nLocalizations: r.locs.length, runMs: r.timings.runMs,
      driftOk: !!(r.drift && !r.drift.stopped), nenaOk: !!(r.nena && !r.nena.err),
      frcOk: !!(r.frc && !r.frc.err), plotKeys: r.plots ? Object.keys(r.plots) : [],
    };
  }, { fileInputId: 'analyzeFileInput' });
  process.stdout.write('\n');
  console.log(`Pipeline: ${pipeline.nLocalizations} locs in ${Math.round(pipeline.runMs)} ms — drift ${pipeline.driftOk ? 'OK' : 'FAILED'}, NeNA ${pipeline.nenaOk ? 'OK' : 'FAILED'}, FRC ${pipeline.frcOk ? 'OK' : 'FAILED'}, plots: [${pipeline.plotKeys.join(', ')}]`);
  const pipelineFailed = !pipeline.driftOk || !pipeline.nenaOk || !pipeline.frcOk || !pipeline.plotKeys.length;

  const outFile = writeResults('bench-real-data', { target: TARGET, full: FULL, ...row, pipeline });
  console.log(`Full results written to ${outFile}`);
  if (pipelineFailed) { console.error('\nFull-pipeline scenario had a failing component — see above.'); process.exitCode = 1; }
} finally {
  await browser.close();
}
