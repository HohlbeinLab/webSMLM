#!/usr/bin/env node
// Repeat the same seeded CPU dataset in Chrome or Firefox to spot large
// browser-specific slowdowns. WebGPU is tested separately on real hardware.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchPage, repoRoot } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  if (process.env.WEBSMLM_BENCH_HTML) {
    await page.goto(pathToFileURL(resolve(process.env.WEBSMLM_BENCH_HTML)).href);
    await page.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);
  }
  const data = await page.evaluate(async () => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event('change'));
    };
    set('frames', 200); set('simulation_fov', 64); set('dens', 5);
    set('simulation_seed', 1337); set('simulation_mt_seed', 1337);
    document.getElementById('useGpu').checked = false;
    await runSimulation();
    const frame = (await stack.getFrames(0, 1))[0];
    let hash = 2166136261;
    for (const v of frame) hash = Math.imul(hash ^ Math.round(v), 16777619) >>> 0;
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const time = async fn => { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; };
      const pcfo = await time(() => pcfoCore({ pcfoFrames: 10, pcfoK: paramValue('pcfoK'), pcfoRnstd: paramValue('pcfoRnstd'), useGpu: false }, stack));
      const fit = await time(() => run());
      const render = await time(() => rerender(false, false));
      const frc = await time(() => runFrcStage({ useGpu: false, stageTimings: newStageTimings(), onLog: () => {} }, lastResult.locs, lastResult.px, lastResult.mag, () => {}, () => {}));
      runs.push({ pcfoMs: pcfo.ms, fitMs: _lastStageRun.cpu?.fit?.ms, runMs: fit.ms, renderMs: render.ms, frcMs: frc.ms, locs: lastResult.locs.length, frcError: frc.value?.err || null, pcfoPoints: pcfo.value?.pts?.length || 0 });
    }
    return { hash, frames: stack.n, width: stack.w, height: stack.h, runs };
  });
  assert.equal(data.frames, 200);
  assert.ok(data.runs.every(r => r.locs > 0 && r.pcfoPoints > 0 && Number.isFinite(r.fitMs) && !r.frcError), JSON.stringify(data));
  const name = `browser-stages-${process.env.WEBSMLM_BENCH_VARIANT || 'current'}-${process.env.WEBSMLM_BROWSER || 'chrome'}-${process.platform}.json`;
  const dir = join(repoRoot, 'tests', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ browser: process.env.WEBSMLM_BROWSER || 'chrome', file: join(dir, name), data }));
} finally { await browser.close(); }
