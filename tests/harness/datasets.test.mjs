import assert from 'node:assert/strict';
import test from 'node:test';

import { DATASETS, benchmarkScript, datasetFile, parseGpuMode } from '../lib/datasets.mjs';

test('documented benchmark datasets expose paths, parameters, and scenarios', () => {
  for (const key of ['storm3d', 'gatta80r', 'epfl-as-beads', 'epfl-as-hd', 'epfl-as-ld', 'epfl-bp250', 'epfl-dh', 'npc-beads', 'cas12a-segmentation', 'cas12a-scrambled', 'ssmlm', 'smfret-alex', 'bigtiff']) {
    assert.ok(DATASETS[key], `missing ${key}`);
    assert.ok(DATASETS[key].localPath, `${key} needs a localPath`);
    assert.ok(DATASETS[key].scenarios.length, `${key} needs scenarios`);
  }

  assert.deepEqual(DATASETS.storm3d.parameters, {
    pxnm: 160,
    gain: 0.1248,
    camoffset: 100,
  });
  assert.equal(DATASETS.gatta80r.parameters.pxnm, 99.2);
  assert.deepEqual(Object.keys(DATASETS['epfl-as-hd'].files), ['stack', 'positions', 'activations']);
  assert.deepEqual(Object.keys(DATASETS['epfl-as-ld'].files), ['stack', 'positions', 'activations']);
  assert.equal(DATASETS['epfl-as-hd'].parameters.frames, 2500);
  assert.equal(DATASETS['epfl-as-ld'].parameters.frames, 19996);
  assert.deepEqual(DATASETS['cas12a-segmentation'].parameters, {
    pxnm: 119, sptFrameTime: 0.01, sptLocError: 35,
    sptSearchRange: 800, sptMemory: 0, sptTrackLenMin: 2,
  });
  assert.equal(DATASETS['cas12a-segmentation'].download.type, 'files');
  assert.equal(DATASETS['cas12a-segmentation'].download.files.length, 7);
  assert.equal(DATASETS['cas12a-scrambled'].download.files.length, 7);
  assert.equal(DATASETS['npc-beads'].scientificValidation, false);
  assert.deepEqual(Object.entries(DATASETS).filter(([, dataset]) => dataset.download).map(([key]) => key).sort(), [
    'cas12a-scrambled', 'cas12a-segmentation', 'epfl-as-beads', 'epfl-as-hd', 'epfl-as-ld', 'epfl-bp250', 'epfl-dh', 'gatta80r', 'npc-beads', 'ssmlm', 'storm3d',
  ]);
});

test('datasetFile resolves a role without embedding temp or repo paths', () => {
  assert.deepEqual(datasetFile('storm3d', 'stack'), {
    envKey: 'STORM_STACK',
    paths: ['3D_STORM_spectrin_rings_in_neurons/Aquired STORM.tif'],
  });
  assert.throws(() => datasetFile('storm3d', 'missing'), /has no file role/);
  assert.throws(() => datasetFile('unknown', 'stack'), /Unknown dataset/);
});

test('parseGpuMode accepts cpu, gpu, and both', () => {
  assert.equal(parseGpuMode([]), 'both');
  assert.equal(parseGpuMode(['--gpu=cpu']), 'cpu');
  assert.equal(parseGpuMode(['--gpu=gpu']), 'gpu');
  assert.throws(() => parseGpuMode(['--gpu=nope']), /cpu, gpu, or both/);
});

test('benchmarkScript maps supported real-data scenarios', () => {
  assert.equal(benchmarkScript('storm3d'), 'bench-real-data.mjs');
  assert.equal(benchmarkScript('gatta80r'), 'bench-multi-file-load.mjs');
  assert.equal(benchmarkScript('epfl-as-hd'), 'bench-dataset-localize.mjs');
  assert.equal(benchmarkScript('epfl-as-ld'), 'bench-dataset-localize.mjs');
  assert.equal(benchmarkScript('cas12a-segmentation'), 'bench-segmentation.mjs');
  assert.equal(benchmarkScript('cas12a-scrambled'), 'bench-segmentation.mjs');
  assert.throws(() => benchmarkScript('npc-beads'), /load-only/);
});
