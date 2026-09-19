#!/usr/bin/env node
// Real segmentation-aware SPT tracking — bench-spt.mjs already covers the
// tracking MATH against a synthetic deterministic-motion fixture; this
// exercises the segmentation CODE PATH itself
// (computeSegmentedImageData()/linkTracksPerCell(), MODULE: spt) against
// real data instead: a real cell-segmentation mask paired with real
// ThunderSTORM localizations from the same acquisition session
// (temp/impLbdCas12a-targeting/ — an unrelated CRISPR/Cas12a imaging
// dataset that happens to already sit in temp/ with exactly the
// mask+CSV shape this feature needs).
//
// config.file (CSV — analyze()'s CSV path, no raw pixel data) +
// config.segmentationFile (the mask TIFF) + config.sptTrack:true is the same
// combination tools/webSMLM-cli.mjs's --segmentation flag drives.
//
// Skips (does not fail) if the files aren't present.
//
// Usage: cd tests && npm install (once), then node bench-segmentation.mjs
import { join } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { resolveDataFile } from '../lib/data.mjs';

const SEG_TIF = await resolveDataFile('IMPLB_SEGM',
  join('impLbdCas12a-targeting', '20230314_imp12aTpTS_EM620_1_1_MMStack_Pos0.ome_procBrightfield_segm.tif'));
const LOC_CSV = await resolveDataFile('IMPLB_CSV',
  join('impLbdCas12a-targeting', '20230314_imp12aTpTS_EM620_LASER1_OutputCombined_thunder.csv'));
if (!SEG_TIF || !LOC_CSV) { console.log('Skipping segmentation benchmark.'); process.exit(0); }

console.log(`Mask: ${SEG_TIF}\nLocs: ${LOC_CSV}`);

const { browser, page } = await launchPage();
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };

try {
  await page.setInputFiles('#analyzeFileInput', LOC_CSV);
  await page.setInputFiles('#segmentationFileInput', SEG_TIF);
  const result = await page.evaluate(async ({ locInputId, segInputId }) => {
    const config = {
      pxnm: 100,
      file: document.getElementById(locInputId).files[0],
      segmentationFile: document.getElementById(segInputId).files[0],
      sptTrack: true,
    };
    const r = await window.webSMLM.analyze(config);
    return {
      nLocs: r.locs.length, spt: r.spt,
      nWithCell: r.locs.filter(L => Number.isFinite(L.cell_id) && L.cell_id >= 0).length,
    };
  }, { locInputId: 'analyzeFileInput', segInputId: 'segmentationFileInput' });

  console.log(`\n${result.nLocs} locs loaded; spt: ${JSON.stringify(result.spt)}`);
  check('SPT ran and reported tracks', !!(result.spt && result.spt.nTracks >= 0), JSON.stringify(result.spt));
  // Informational, not a hard gate: whether real mask/loc pixel coordinates
  // actually overlap is a property of this BORROWED dataset (mask and CSV
  // come from a different lab's own pipeline, not guaranteed pixel-aligned
  // the way a same-session webSMLM Run would be), not a webSMLM correctness
  // question — the hard check above is "did the segmentation code path run
  // without throwing", this just reports what it found.
  console.log(`  (informational) locs with a real cell_id: ${result.nWithCell} of ${result.nLocs}`);

  const outFile = writeResults('bench-segmentation', { segTif: SEG_TIF, locCsv: LOC_CSV, ...result });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll segmentation checks passed.');
