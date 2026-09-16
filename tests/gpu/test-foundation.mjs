#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchPage } from '../lib/launch.mjs';
import { diffLocsExact } from '../lib/report.mjs';

const duplicateAudit = diffLocsExact(
  [{ frame: 0, x: 0, y: 0, lpx: 1, lpy: 1, photons: 10, bg: 1 }],
  [
    { frame: 0, x: 99, y: 99, lpx: 1, lpy: 1, photons: 10, bg: 1 },
    { frame: 0, x: 0, y: 0, lpx: 1, lpy: 1, photons: 10, bg: 1 },
  ],
  [7],
  [7, 7],
  1,
);
assert.equal(duplicateAudit.nGpuDup, 1, 'duplicate GPU audit keys must be reported');
assert.equal(duplicateAudit.nGpuOnly, 1, 'extra duplicate GPU entries must remain unmatched');
assert.equal(duplicateAudit.maxDx, 0, 'duplicate-key matching must not overwrite the correct pair');

const { browser, page } = await launchPage({ headless: true });
try {
  const stage = await page.evaluate(async () => {
    const stageTimings = {};
    const value = await window.runStage(
      'frc',
      { useGpu: false, stageTimings, onLog() {} },
      async () => 42,
      async () => 99,
      () => ({ eligible: true, reason: 'selected' }),
    );
    return { value, timing: stageTimings.frc };
  });
  assert.equal(stage.value, 42);
  assert.deepEqual(
    {
      path: stage.timing.path,
      reasons: stage.timing.reasons,
      cpuCalls: stage.timing.cpuCalls,
      gpuCalls: stage.timing.gpuCalls,
      fallbackCalls: stage.timing.fallbackCalls,
    },
    { path: 'cpu', reasons: ['disabled'], cpuCalls: 1, gpuCalls: 0, fallbackCalls: 0 },
    'a disabled GPU request must produce a structured CPU decision',
  );

  const fallbackStage=await page.evaluate(async()=>{
    const stageTimings={};
    const value=await runStage('frc',{useGpu:true,stageTimings,onLog(){}},async()=>7,async()=>{throw new Error('induced');},()=>({eligible:true,reason:'selected'}));
    return {value,timing:stageTimings.frc};
  });
  assert.equal(fallbackStage.value,7);
  assert.equal(fallbackStage.timing.path,'mixed');
  assert.equal(fallbackStage.timing.gpuCalls,1);
  assert.equal(fallbackStage.timing.cpuCalls,1);
  assert.equal(fallbackStage.timing.fallbackCalls,1);
  assert.deepEqual(fallbackStage.timing.reasons,['failed']);

  const frcRepeat = await page.evaluate(async () => {
    const locs = Array.from({ length: 512 }, (_, i) => ({
      frame: i % 64,
      x: 12 + ((i * 37) % 400) / 10,
      y: 9 + ((i * 61) % 360) / 10,
      photons: 800 + (i % 17),
      bg: 4,
      bgstd: 2,
      sigma: 1.3,
      lpx: 1,
      lpy: 1,
    }));
    const run = () => window.frcResolution(locs, 100, 10, undefined, () => {});
    const a = await run();
    const b = await run();
    let maxCurveDiff = 0;
    for (let i = 0; i < a.curve.frc.length; i++) {
      maxCurveDiff = Math.max(maxCurveDiff, Math.abs(a.curve.frc[i] - b.curve.frc[i]));
    }
    return { maxCurveDiff, resA: a.res, resB: b.res, nA: a.N, nB: b.N };
  });
  assert.equal(frcRepeat.nA, frcRepeat.nB);
  assert.equal(frcRepeat.maxCurveDiff, 0, 'FRC must be repeatable for identical ordered localizations');
  assert.equal(frcRepeat.resA, frcRepeat.resB, 'FRC resolution must be repeatable');

  const publicResult = await page.evaluate(async () => {
    const csv = [
      '"id","frame","x [nm]","y [nm]","sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"',
      '1,1,100,100,130,900,4,2,20',
      '2,2,200,150,130,850,4,2,21',
    ].join('\n');
    const file = new File([csv], 'foundation.csv', { type: 'text/csv' });
    const result = await window.webSMLM.analyze({ file, pxnm: 100, useGpu: false, mag: 5 });
    return {
      performance: result.performance,
      execution: result.execution,
      stageTimings: result.stageTimings,
    };
  });
  assert.equal(publicResult.performance.schemaVersion, 1);
  assert.ok(publicResult.performance.analyzeWallMs >= 0);
  for (const key of ['inputMs', 'calibrationMs', 'localizationMs', 'postprocessMs', 'csvMs', 'renderMs', 'pngEncodeMs', 'plotsMs']) {
    assert.ok(Number.isFinite(publicResult.performance.phases[key]), `performance.phases.${key} must be finite`);
  }
  assert.equal(publicResult.execution.gpuRequested, false);
  assert.equal(publicResult.execution.stages.render.path, 'cpu');
  assert.deepEqual(publicResult.execution.stages.render.reasons, ['disabled']);
  assert.equal(publicResult.stageTimings.render.path, 'cpu');

  console.log('foundation behavior: PASS');
} finally {
  await browser.close();
}
