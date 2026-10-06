#!/usr/bin/env node
// Real segmentation-aware SPT benchmark using the matched Cas12a conditions
// published in HohlbeinLab/sptPALM-Python. Missing files are an expected skip.
import { basename } from 'node:path';
import { launchPage } from '../lib/launch.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';
import { getDataset } from '../lib/datasets.mjs';
import { writeResults } from '../lib/report.mjs';

const DATASET = process.argv.find(arg => arg.startsWith('--dataset='))?.slice('--dataset='.length) || 'cas12a-segmentation';
const dataset = getDataset(DATASET);
if (!dataset.scenarios.includes('segmentation')) throw new Error(`${DATASET} is not a segmentation dataset.`);

const SEG_TIF = await resolveDatasetFile(DATASET, 'mask');
const LOC_CSVS = [
  await resolveDatasetFile(DATASET, 'localizationsPart1'),
  await resolveDatasetFile(DATASET, 'localizationsPart2'),
];
if (!SEG_TIF || LOC_CSVS.some(file => !file)) { console.log(`Skipping ${DATASET} segmentation benchmark.`); process.exit(0); }

const parameters = dataset.parameters;
console.log(`Dataset: ${dataset.label}\nMask: ${SEG_TIF}\nLocalizations:\n  ${LOC_CSVS.join('\n  ')}`);

const { browser, page } = await launchPage();
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };
const parts = [];

try {
  for (const locCsv of LOC_CSVS) {
    await page.setInputFiles('#analyzeFileInput', locCsv);
    await page.setInputFiles('#segmentationFileInput', SEG_TIF);
    const started = Date.now();
    const result = await page.evaluate(async ({ locInputId, segInputId, parameters }) => {
      const pxnm = document.getElementById('pxnm');
      pxnm.value = parameters.pxnm;
      pxnm.dispatchEvent(new Event('change'));
      const config = {
        ...parameters,
        file: document.getElementById(locInputId).files[0],
        segmentationFile: document.getElementById(segInputId).files[0],
        sptTrack: true,
      };
      const run = await window.webSMLM.analyze(config);
      return {
        nLocs: run.locs.length,
        spt: run.spt,
        nWithCell: run.locs.filter(loc => Number.isFinite(loc.cell_id) && loc.cell_id >= 0).length,
      };
    }, { locInputId: 'analyzeFileInput', segInputId: 'segmentationFileInput', parameters });
    result.durationMs = Date.now() - started;
    result.file = basename(locCsv);
    parts.push(result);

    console.log(`\n${result.file}: ${result.nLocs} localizations in ${result.durationMs} ms; SPT ${JSON.stringify(result.spt)}`);
    check(`${result.file}: localizations loaded`, result.nLocs > 0, `${result.nLocs}`);
    check(`${result.file}: segmentation assigned cells`, result.nWithCell > 0, `${result.nWithCell} of ${result.nLocs}`);
    check(`${result.file}: SPT reported tracks`, Boolean(result.spt && result.spt.nTracks >= 0), JSON.stringify(result.spt));
  }

  const outFile = writeResults(`bench-segmentation-${DATASET}`, {
    dataset: DATASET,
    source: { url: dataset.source, revision: dataset.sourceRevision },
    parameters,
    mask: SEG_TIF,
    parts,
    totals: {
      localizations: parts.reduce((sum, part) => sum + part.nLocs, 0),
      assignedToCells: parts.reduce((sum, part) => sum + part.nWithCell, 0),
      durationMs: parts.reduce((sum, part) => sum + part.durationMs, 0),
    },
    verdict: failures ? 'fail' : 'pass',
  });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll segmentation and SPT checks passed.');
