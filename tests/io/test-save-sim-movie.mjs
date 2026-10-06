#!/usr/bin/env node
// Save sim. movie: encodeTiff16() round-trips a simulated movie exactly through Load data (classic
// TIFF and BigTIFF, sCMOS and EMCCD, whose frames are whole ADU), the file carries its pixel size
// and frame interval, saveSimulatedMovie() writes the TIFF and the ground-truth CSV, and the CSV
// rows match groundTruthByFrame() with the simulated drift added.
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const r = await page.evaluate(async () => {
    const set = (id, v) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change')); };
    set('frames', 40); set('simulation_fov', 48); set('simulation_seed', 5); set('simulation_mt_seed', 3); set('useGpu', false);
    set('driftpx', 2); set('pxnm', 100); set('frametime', 0.02);
    const out = [];
    for (const cam of ['scmos', 'emccd']) {
      set('simulation_cameraType', cam);
      await runSimulation();
      const st = simSaved.stack, frames = await st.getFrames(0, st.n);
      let nonInt = 0; for (const f of frames) for (const v of f) if (v !== Math.round(v) || v < 0 || v > 65535) nonInt++;
      for (const bigTiff of [false, true]) {
        const { parts, big } = encodeTiff16(frames, st.w, st.h, { pxNm: st.px, frameTimeS: 0.02, bigTiff });
        const logs = [];
        const back = await loadTiffFile(new File(parts, 'sim.tif'), m => logs.push(String(m)));
        const bf = await back.getFrames(0, back.n);
        let diff = 0; for (let i = 0; i < bf.length; i++) for (let j = 0; j < bf[i].length; j++) if (bf[i][j] !== frames[i][j]) diff++;
        out.push({ cam, big, nonInt, n: back.n, w: back.w, h: back.h, diff,
          scaleHint: logs.some(l => /pixel size ≈ 100\.0 nm\/px/.test(l)) && logs.some(l => /frame interval 20\.0 ms/.test(l)) });
      }
    }
    // Button flow with saveBlob captured, and the CSV checked against the ground truth.
    const saved = []; const orig = saveBlob;
    saveBlob = async (blob, name) => { saved.push({ name, text: name.endsWith('.csv') ? await blob.text() : null, size: blob.size }); return name; };
    try { await saveSimulatedMovie(); } finally { saveBlob = orig; }
    const csv = saved.find(s => s.name.endsWith('.csv')), rows = csv.text.trim().split('\n');
    const byFrame = groundTruthByFrame(simSaved.gt, simSaved.stack.n, 0, simSaved.stack.n - 1);
    let expected = 0; for (const a of byFrame.values()) expected += a.length;
    const f0 = [...byFrame.keys()].sort((a, b) => a - b)[0], g = byFrame.get(f0)[0], px = simSaved.stack.px;
    const first = rows[1].split(',').map(Number);
    return { out, names: saved.map(s => s.name), header: rows[0], nRows: rows.length - 1, expected,
      firstOk: first[0] === f0 + 1 && Math.abs(first[1] - (g.x * px + simSaved.drift.dx(f0))) < 0.06 && Math.abs(first[4] - g.x * px) < 0.06,
      driftUsed: Math.abs(simSaved.drift.dx(simSaved.stack.n - 1)) > 1 };
  });
  for (const o of r.out) {
    assert.equal(o.nonInt, 0, `${o.cam}: simulated frames are whole ADU in 0..65535`);
    assert.equal(o.diff, 0, `${o.cam} ${o.big ? 'BigTIFF' : 'TIFF'}: pixels round-trip`);
    assert.ok(o.scaleHint || o.big, `${o.cam}: pixel size/frame interval read back`);
    console.log(`  ${o.cam} ${o.big ? 'BigTIFF' : 'TIFF   '}: ${o.n} frames ${o.w}×${o.h} identical after Load data${o.scaleHint ? ', scale + finterval read back' : ''}`);
  }
  assert.deepEqual(r.names, ['webSMLM_simulated.tif', 'webSMLM_simulated_ground_truth.csv']);
  assert.equal(r.nRows, r.expected); assert.ok(r.firstOk && r.driftUsed, 'CSV positions: structure + simulated drift');
  console.log(`  Save sim. movie: TIFF + ground truth CSV (${r.nRows} emitter-frames, drift included)`);
  console.log('Save sim. movie: PASS');
} finally { await browser.close(); }
