#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as webSMLMRunner from '../validation/run-webSMLM.mjs';
import * as picassoRunner from '../validation/run-picasso.mjs';
import * as crossReport from '../lib/cross-report.mjs';
import { diffCell, judge, METRICS } from '../lib/report-html.mjs';
import { epflDatasetTruth, parseEpflActivations } from '../validation/cross-validate.mjs';

// Polarity: the glyph follows the DECLARED direction, not the sign of the delta. Both directions.
const g = (m, v, b) => (diffCell(m, v, b).match(/class="(up|dn|eq)"/) || [])[1];
assert.equal(METRICS.jaccard.polarity, 'higher');
assert.equal(METRICS.rmse_lat_nm.polarity, 'lower');
assert.equal(g('jaccard', 0.8, 0.7), 'up', 'jaccard up is better');
assert.equal(g('jaccard', 0.6, 0.7), 'dn', 'jaccard down is worse');
assert.equal(g('rmse_lat_nm', 12, 14), 'up', 'rmse down is better');
assert.equal(g('rmse_lat_nm', 16, 14), 'dn', 'rmse up is worse');
assert.equal(g('jaccard', 0.7, 0.7), 'eq');
assert.equal(judge('runtime_s', -1, 0.01), 'better');
assert.match(diffCell('rmse_lat_nm', 16, 14), /^\+14\.3% /);
assert.match(diffCell('jaccard', null, 0.7), /n\/a/);
assert.match(diffCell('jaccard', 0.8, 0.7), />better</);
assert.doesNotMatch(diffCell('jaccard', 0.8, 0.7), /&#9650;|&#9660;/);
assert.throws(() => diffCell('undeclared_metric', 1, 2), /no declared polarity/);
console.log('diffCell polarity (higher- and lower-is-better): PASS');

const truth = {
  pxnm: 100,
  gainPhotonsPerADU: 1,
  offsetADU: 100,
  sigmaPx: 1.3,
  nFrames: 30,
  emitters: Array.from({ length: 30 }, (_, id) => ({ id })),
  tiffBuffer: Buffer.from('fixture'),
};

assert.equal(typeof webSMLMRunner.webSMLMParameters, 'function', 'webSMLM runner must expose its effective parameters');
assert.equal(typeof picassoRunner.picassoParameters, 'function', 'Picasso runner must expose its effective parameters');
assert.equal(typeof crossReport.buildCrossValidationResult, 'function', 'cross-validation output must serialize per-tool parameters');

const webSMLM = webSMLMRunner.webSMLMParameters(truth);
const picasso = picassoRunner.picassoParameters(truth, { boxSide: 7, gradient: 400 });
const expectedWebSMLM = {
  fitMethod: 'gaussmle',
  pixelSizeNm: 100,
  gainPhotonsPerADU: 1,
  offsetADU: 100,
  psfSigmaPx: 1.3,
  // winr is ceil(3*sigma) per Smith et al. 2010's box rule, not a constant: 3*1.3 -> 4, box 2*4+1 = 9.
  winr: 4,
  boxSidePx: 9,
  detection: { method: 'Wavelet', threshold: 4, unit: 'k*sigma_noise' },
  frames: 30,
  emitters: 30,
  gpuMode: 'adaptive (enabled)',
};
const expectedPicasso = {
  fitMethod: 'mle-spherical',
  pixelSizeNm: 100,
  gainPhotonsPerADU: 1,
  offsetADU: 100,
  // Picasso is handed the real sigma via --psf, so it is reported, not null.
  psfSigmaPx: 1.3,
  boxSidePx: 7,
  detection: { method: 'Net gradient', threshold: 400, unit: 'gradient' },
  frames: 30,
  emitters: 30,
  gpuMode: 'n/a',
};
assert.deepEqual(webSMLM, expectedWebSMLM);
assert.deepEqual(picasso, expectedPicasso);
const comparison = {
  matchRadiusNm: 390,
  tools: {
    webSMLM: { skipped: false, tp: 890, fp: 10, fn: 10, precision: 0.98, recall: 0.98, jaccardCI: { point: 0.96, lo: 0.95, hi: 0.97 }, rmseXYCI: { point: 8, lo: 7, hi: 9 }, biasX: 1, biasY: -1, wallMs: 100 },
    picasso: { skipped: false, tp: 880, fp: 20, fn: 20, precision: 0.97, recall: 0.97, jaccardCI: { point: 0.94, lo: 0.93, hi: 0.95 }, rmseXYCI: { point: 9, lo: 8, hi: 10 }, biasX: 2, biasY: -2, wallMs: 120 },
  },
  crossTool: {
    n: 870,
    x: { n: 870, bias: 1, sd: 2, loaLo: -2.92, loaHi: 4.92, pearsonR: 0.99 },
    y: { n: 870, bias: -1, sd: 2, loaLo: -4.92, loaHi: 2.92, pearsonR: 0.99 },
    photons: { n: 870, bias: 5, sd: 10, loaLo: -14.6, loaHi: 24.6, pearsonR: 0.98 },
  },
};

const data = crossReport.buildCrossValidationResult(truth, comparison, {
  webSMLM: { parameters: webSMLM },
  picasso: { parameters: picasso },
});
data.truthSource = 'webSMLM physical simulator with fixed seed 20261001';
data.provenance = { simParams: { simulation_structureType: 'uniform3D', dens: 0.3, frames: 30 } };

const epfl = parseEpflActivations('Ground-truth,frame,xnano,ynano,znano,intensity\n1, 2, 100, 250, -30, 800\n', 100);
assert.deepEqual(epfl, {
  x: [1], y: [2.5], z: [-30], tStart: [1], tEnd: [2], rate: [800], moleculeId: [1], haze: [0],
});

const oldEpflPath = process.env.WEBSMLM_TEST_DATA_EPFL_AS_HD_ACTIVATIONS;
process.env.WEBSMLM_TEST_DATA_EPFL_AS_HD_ACTIVATIONS = join(tmpdir(), 'websmlm-missing-epfl-activations.csv');
const missingDataLog = [];
const originalLog = console.log;
try {
  console.log = (...parts) => missingDataLog.push(parts.join(' '));
  assert.equal(await epflDatasetTruth('epfl-as-hd'), null);
} finally {
  console.log = originalLog;
  if (oldEpflPath == null) delete process.env.WEBSMLM_TEST_DATA_EPFL_AS_HD_ACTIVATIONS;
  else process.env.WEBSMLM_TEST_DATA_EPFL_AS_HD_ACTIVATIONS = oldEpflPath;
}
assert.match(missingDataLog.join('\n'), /EPFL_AS_HD_ACTIVATIONS not found/i);

assert.deepEqual(data.parameters, { webSMLM: expectedWebSMLM, picasso: expectedPicasso });
assert.equal(data.truth.tiffBuffer, undefined, 'raw TIFF bytes must stay out of result JSON');

const dir = mkdtempSync(join(tmpdir(), 'websmlm-cross-report-'));
try {
  const resultFile = join(dir, 'picasso-compare.json');
  writeFileSync(resultFile, JSON.stringify(data, null, 2));
  const { reportPath } = crossReport.writeCrossReport({
    resultsDir: dir,
    resultFiles: [resultFile],
    run: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:00:01.000Z',
      durationMs: 1000,
      commands: [],
    },
  });
  const html = readFileSync(reportPath, 'utf8');
  assert.match(html, /Parameters used for each tool/);
  assert.match(html, /Pixel size/);
  assert.match(html, /Gain \(photons per analog-to-digital unit\)/);
  assert.match(html, /Camera offset \(analog-to-digital units\)/);
  assert.match(html, /Point-spread-function sigma 1\.3 pixels; fit box 7 pixels/);
  assert.match(html, />30<\/td>/);
  assert.match(html, /adaptive \(enabled\)/);
  assert.match(html, /mle-spherical/);
  assert.match(html, /Wavelet.*4.*k.sigma_noise/i);
  assert.match(html, /Net gradient.*400/i);
  assert.match(html, /Accuracy and performance against the same reference/);
  assert.match(html, /Difference \(webSMLM minus Picasso\)/);
  assert.match(html, /Jaccard overlap score/);
  assert.match(html, /Lateral root mean square error \(nm\)/);
  assert.match(html, /Matched localization pairs/);
  assert.match(html, /Mean difference \(Picasso minus webSMLM\)/);
  assert.match(html, /Standard deviation of differences/);
  assert.match(html, /95% agreement interval/);
  assert.match(html, /How to read these results/);
  assert.match(html, /webSMLM physical simulator with fixed seed 20261001/);
  assert.match(html, /Uniform three-dimensional simulation, density 0\.3, 30 frames/);
  assert.match(html, /Picasso is an offline analysis tool/);
  assert.doesNotMatch(html, />rmse_lat_nm</);
  assert.doesNotMatch(html, />sd</i);
  assert.match(html, /Run provenance/);
  assert.match(html, /Agreement between tools for matched localizations/);
  assert.doesNotMatch(html, /https?:\/\//, 'report must make no external request');
  // fixture: jaccard 0.96 vs 0.94 (higher is better) and rmse 8 vs 9 (lower is better): both better
  assert.match(html, /\+0\.020 <span class="up"/);
  assert.match(html, /-11\.1% <span class="up"/);
  console.log('Picasso cross-report parameters: PASS');

} finally {
  rmSync(dir, { recursive: true, force: true });
}
