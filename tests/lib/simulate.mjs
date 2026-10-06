// The harness's shared simulate layer: ONE way for every test and every cross-validated tool to
// get a webSMLM-simulated movie plus its ground truth. Nothing here does any numerics — it drives
// the app's own "Simulate movie" (runSimulation(), MODULE: simulation) inside the page and hands
// back the movie geometry, the ground truth in saveGroundTruth()'s own JSON shape, and (by
// default) the TIFF + ground-truth CSV on disk so a SUBPROCESS tool (Picasso, …) can read the very
// same movie webSMLM localized.
//
// Why the ground truth travels as saveGroundTruth()'s JSON rather than some harness-private shape:
// that file is lossless and loadGroundTruth() already defines the authoritative way back to the
// in-memory event objects, so tests/lib/score.mjs can mirror one documented conversion instead of
// inventing a second one. The JSON is produced by calling saveGroundTruth() with saveBlob() stubbed
// — the app's own serializer, so the shape cannot drift from the app's.
//
// Size note: a `_theory` background map is w*h numbers in that JSON, so a very large FOV makes a
// correspondingly large object cross the CDP bridge. Keep harness FOVs modest.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './launch.mjs';

// Presets WRITE other controls (wirePreset(), MODULE: simulation), so they must be applied before
// the fields they would otherwise overwrite. Order within `params` is otherwise respected.
const PRESET_FIRST = ['simulation_realism', 'simulation_densityPreset', 'validation_preset'];

const resultsDir = join(repoRoot, 'tests', 'results');

// params: {PARAMS id -> value}. Entries with a sidebar control are set through it (value/checked +
// a real 'change' event, the idiom tests/io/test-save-sim-movie.mjs uses); `id:null` entries
// (simulation_structureFov, simulation_3d, …) go into the page's `paramOverrides`, which is exactly
// how paramValue() resolves them.
export async function simulateInPage(page, params = {}, { writeFiles = true, name = 'sim' } = {}) {
  const ordered = [...PRESET_FIRST.filter(k => k in params), ...Object.keys(params).filter(k => !PRESET_FIRST.includes(k))];

  const r = await page.evaluate(async ({ entries }) => {
    for (const [id, v] of entries) {
      const spec = PARAMS[id];
      if (!spec) return { err: `unknown PARAMS id "${id}"` };
      const el = spec.id ? $(spec.id) : null;
      if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change')); }
      else paramOverrides[id] = v;
    }
    // Reproducibility guards, read back through paramValue() so a PARAMS default change can't
    // quietly slip an unseeded run past them (simulation_structureType defaults to microtubules).
    if (paramValue('simulation_seed') === 0)
      return { err: 'simulation_seed is 0 (= unseeded, Math.random()) — a harness run must pin it to a non-zero integer, or nothing it measures is reproducible.' };
    if (paramValue('simulation_structureType') === 'microtubules' && paramValue('simulation_mt_seed') === 0)
      return { err: 'simulation_structureType is "microtubules" and simulation_mt_seed is 0 (= a fresh random cell field per movie, seeded independently of simulation_seed) — pin simulation_mt_seed too.' };

    // runSimulation() catches its own failures and only LOGS them, so the log tail is the only
    // evidence of why nothing was produced (`log` is a const, so it can't be intercepted).
    const logBefore = $('logText').textContent.length;
    await runSimulation();
    if (!simSaved || !simSaved.gt)
      return { err: `Simulate movie produced no ground truth. Log tail: ${$('logText').textContent.slice(logBefore).trim().slice(-500)}` };

    const st = simSaved.stack;
    // Ground truth in saveGroundTruth()'s shape, via saveGroundTruth() itself.
    let gtJson = null;
    const origSave = saveBlob;
    saveBlob = async (blob, nm) => { gtJson = JSON.parse(await blob.text()); return nm; };
    try { await saveGroundTruth(); } finally { saveBlob = origSave; }
    if (!gtJson) return { err: 'saveGroundTruth() wrote nothing' };

    // Pixel hash of the frames as generated: byte-exact and type-independent, so two runs can be
    // compared for identity without any pixel data crossing the bridge (FNV-1a, 32-bit).
    const frames = await st.getFrames(0, st.n);
    let hash = 0x811c9dc5, nPx = 0;
    for (const f of frames) {
      const b = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
      for (let i = 0; i < b.length; i++) { hash = ((hash ^ b[i]) * 16777619) >>> 0; }
      nPx += f.length;
    }

    const mol = new Set(gtJson.events.moleculeId);
    return { w: st.w, h: st.h, frames: st.n, pxNm: st.px, frameTimeS: simSaved.frameTimeS,
             groundTruth: gtJson, nEvents: gtJson.events.x.length, nMolecules: mol.size,
             nHaze: gtJson.events.haze.reduce((s, v) => s + (v ? 1 : 0), 0),
             framesHash: hash.toString(16).padStart(8, '0'), nPixels: nPx,
             driftTotalPx: gtJson.drift ? gtJson.drift.totalPx : 0 };
  }, { entries: ordered.map(k => [k, params[k]]) });

  if (r.err) throw new Error(`simulateInPage: ${r.err}`);

  // The TIFF and the ground-truth CSV, written by the app's own Save sim. movie so the files are
  // byte-identical to a user's. saveBlob() prefers window.showSaveFilePicker, which headless Chrome
  // DOES expose on a file:// page but then rejects with AbortError (no user activation) — saveBlob
  // reads that as "cancelled" and saveSimulatedMovie() writes nothing at all. Removing the picker
  // for the duration puts saveBlob on its own documented fallback branch, an <a download> click,
  // which Playwright surfaces as a download event. Nothing about the bytes changes.
  r.tiffPath = null; r.gtCsvPath = null;
  if (writeFiles) {
    mkdirSync(resultsDir, { recursive: true });
    const got = [];
    const onDl = d => got.push(d);
    page.on('download', onDl);
    try {
      await page.evaluate(async () => {
        const picker = window.showSaveFilePicker;
        delete window.showSaveFilePicker;
        try { await saveSimulatedMovie(); } finally { if (picker) window.showSaveFilePicker = picker; }
      });
      const t0 = Date.now();
      while (got.length < 2 && Date.now() - t0 < 60000) await new Promise(res => setTimeout(res, 50));
      if (got.length < 2)
        throw new Error(`simulateInPage: expected Save sim. movie to produce 2 downloads (TIFF + ground-truth CSV), got ${got.length}.`);
    } finally { page.off('download', onDl); }
    for (const d of got) {
      const fn = d.suggestedFilename();
      const p = join(resultsDir, `${name}-${fn}`);
      await d.saveAs(p);
      if (fn.endsWith('.csv')) r.gtCsvPath = p; else r.tiffPath = p;
    }
  }
  return r;
}
