import { posix } from 'node:path';

const file = (envKey, ...paths) => ({ envKey, paths });
const SPTPALM_REVISION = '452da48a9e4400b75abd11178d74e45bad80ecfc';
const sptPalmFile = (name, bytes) => ({
  name, bytes,
  url: `https://raw.githubusercontent.com/HohlbeinLab/sptPALM-Python/${SPTPALM_REVISION}/experimental_data/${name}`,
});
const SPTPALM_SHARED = [sptPalmFile('README.txt', 630), sptPalmFile('input_parameter.pkl', 1725)];
const CAS12A_TARGETING_FILES = [
  sptPalmFile('Cas12aTargeting_localisations_part1_MLE_thunder.csv', 13170171),
  sptPalmFile('Cas12aTargeting_localisations_part2_MLE_thunder.csv', 13733572),
  sptPalmFile('Cas12aTargeting_procBrightfield.tif', 60489),
  sptPalmFile('Cas12aTargeting_procBrightfield_segm.tif', 242866),
  sptPalmFile('Cas12aTargeting_procBrightfield_segm_Table.csv', 15368),
  ...SPTPALM_SHARED,
];
const CAS12A_SCRAMBLED_FILES = [
  sptPalmFile('Cas12aScrambled_localisations_part1_MLE_thunder.csv', 8749041),
  sptPalmFile('Cas12aScrambled_localisations_part2_MLE_thunder.csv', 5778837),
  sptPalmFile('Cas12aScrambled_procBrightfield.tif', 59273),
  sptPalmFile('Cas12aScrambled_procBrightfield_segm.tif', 238002),
  sptPalmFile('Cas12aScrambled_procBrightfield_segm_Table.csv', 27414),
  ...SPTPALM_SHARED,
];
const SPTPALM_PARAMETERS = {
  pxnm: 119, sptFrameTime: 0.01, sptLocError: 35,
  sptSearchRange: 800, sptMemory: 0, sptTrackLenMin: 2,
};

export const DATASETS = Object.freeze({
  storm3d: {
    label: '3D STORM spectrin rings',
    source: 'https://figshare.com/articles/dataset/3D_STORM_spectrin_rings_in_neurons/19165061',
    localPath: '3D_STORM_spectrin_rings_in_neurons',
    files: {
      stack: file('STORM_STACK', 'Aquired STORM.tif'),
      localizations: file('LOCALIZATIONS_CSV', 'Processed localizations.csv'),
      calibration: file('Z_CALIBRATION', 'Z calibration (step 10nm).tif'),
    },
    parameters: { pxnm: 160, gain: 0.1248, camoffset: 100 },
    scenarios: ['localize-cpu', 'localize-gpu', 'drift', '3d-calibration'],
    benchmark: 'bench-real-data.mjs',
    scientificValidation: true,
    download: {
      type: 'figshare', articleId: 19165061,
      files: ['Aquired STORM.tif', 'Processed localizations.csv', 'Z calibration (step 10nm).tif'],
    },
    // Per downloaded file (key = file name); checked by tests/data/download.mjs after a fetch.
    sha256: {
      'Aquired STORM.tif': '3546f92ef97f91467d0716c63886c5696e2d11b06beecb38ecf4121b46f79dd0',
      'Processed localizations.csv': '1175231ad37e7009a6e02d374414c64a94d48082412f0936e3202fcf11d2154b',
      'Z calibration (step 10nm).tif': 'fc79ed67cd67d69ec3d96f71edad4e0b1a970e5cfc09a997b35d71515babf2d6',
    },
    bytes: {
      'Aquired STORM.tif': 5254602007,
      'Processed localizations.csv': 106640947,
      'Z calibration (step 10nm).tif': 21214535,
    },
  },
  gatta80r: {
    label: 'GATTA-PAINT 80R nanorulers',
    source: 'https://www.gattaquant.com/files/GATTA-PAINT-80R-RAW.zip',
    localPath: 'GATTA-PAINT-80R-RAW',
    files: {
      frames: file('GATTA_PAINT_DIR',
        'GATTA-PAINT-80R-RAW/GATTA-PAINT-80R-raw-tifs',
        'GATTA-PAINT-80R-raw-tifs'),
    },
    parameters: { pxnm: 99.2, exposureMs: 80 },
    scenarios: ['multi-file-load', 'localize-cpu', 'localize-gpu'],
    benchmark: 'bench-multi-file-load.mjs',
    scientificValidation: true,
    download: { type: 'zip', url: 'https://www.gattaquant.com/files/GATTA-PAINT-80R-RAW.zip' },
    // Of the downloaded archive (hashed from a streamed download; the server's file has been unchanged since 2014).
    sha256: '17262a2fba440f292d54580d99a2109a1c665fcb58be1d62f5d5b0eeaf4383bd',
    bytes: 445286085,
  },
  'epfl-as-beads': {
    label: 'EPFL 3D challenge astigmatism beads',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html',
    localPath: 'EPFL-SMLM-2016',
    files: { stack: file('EPFL_AS_BEADS', 'sequence-as-stack-Beads-AS-Exp.tif') },
    parameters: { pxnm: 100, gain: 1 / 6, camoffset: 100, calStep: 10, calRef: 76 },
    scenarios: ['calibration', 'load'],
    scientificValidation: true,
    download: {
      type: 'zip-file',
      url: 'https://bigwww.epfl.ch/srm/Data/challenge-3D-simulation/beads/Data/z-stack-Beads-AS-Exp-as-stack.zip',
      file: 'sequence-as-stack-Beads-AS-Exp.tif',
    },
  },
  'epfl-as-hd': {
    label: 'EPFL 3D challenge astigmatism high density',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html',
    localPath: 'EPFL-SMLM-2016',
    files: {
      stack: file('EPFL_AS_HD', 'sequence-as-stack-MT0.N1.HD-AS-Exp.tif'),
      positions: file('EPFL_AS_HD_POSITIONS', 'MT0.N1.HD-positions.csv'),
      activations: file('EPFL_AS_HD_ACTIVATIONS', 'MT0.N1.HD-activations.csv'),
    },
    parameters: { pxnm: 100, gain: 1 / 6, camoffset: 100, frames: 2500, width: 64, height: 64, psfSigmaPx: 1.3 },
    scenarios: ['localize-cpu', 'localize-gpu', 'ground-truth'],
    benchmark: 'bench-dataset-localize.mjs',
    scientificValidation: true,
    download: {
      type: 'zip-file',
      url: 'https://bigwww.epfl.ch/srm/Data/challenge-3D-simulation/MT0.N1.HD/Data/sequence-MT0.N1.HD-AS-Exp-as-stack.zip',
      file: 'sequence-as-stack-MT0.N1.HD-AS-Exp.tif',
      files: [
        { name: 'MT0.N1.HD-positions.csv', url: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/MT0.N1.HD/sample/positions.csv' },
        { name: 'MT0.N1.HD-activations.csv', url: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/MT0.N1.HD/sample/activations.csv' },
      ],
    },
  },
  'epfl-as-ld': {
    label: 'EPFL 3D challenge astigmatism low density',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html',
    localPath: 'EPFL-SMLM-2016',
    files: {
      stack: file('EPFL_AS_LD', 'sequence-as-stack-MT0.N1.LD-AS-Exp.tif'),
      positions: file('EPFL_AS_LD_POSITIONS', 'MT0.N1.LD-positions.csv'),
      activations: file('EPFL_AS_LD_ACTIVATIONS', 'MT0.N1.LD-activations.csv'),
    },
    parameters: { pxnm: 100, gain: 1 / 6, camoffset: 100, frames: 19996, width: 64, height: 64, psfSigmaPx: 1.3 },
    scenarios: ['localize-cpu', 'localize-gpu', 'ground-truth'],
    benchmark: 'bench-dataset-localize.mjs',
    scientificValidation: true,
    download: {
      type: 'zip-file',
      url: 'https://bigwww.epfl.ch/srm/Data/challenge-3D-simulation/MT0.N1.LD/Data/sequence-MT0.N1.LD-AS-Exp-as-stack.zip',
      file: 'sequence-as-stack-MT0.N1.LD-AS-Exp.tif',
      files: [
        { name: 'MT0.N1.LD-positions.csv', url: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/MT0.N1.LD/sample/positions.csv' },
        { name: 'MT0.N1.LD-activations.csv', url: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/MT0.N1.LD/sample/activations.csv' },
      ],
    },
  },
  'epfl-bp250': {
    label: 'EPFL biplane +250 low-density stack',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html',
    localPath: 'sequence-MT0.N1.LD-BP+250-as-stack',
    files: { stack: file('EPFL_BP250_STACK', 'sequence-as-stack-MT0.N1.LD-BP+250.tif') },
    parameters: {}, scenarios: ['load'], scientificValidation: false,
    download: {
      type: 'zip-file',
      url: 'https://bigwww.epfl.ch/srm/Data/challenge-3D-simulation/MT0.N1.LD/Data/sequence-MT0.N1.LD-BP+250-as-stack.zip',
      file: 'sequence-as-stack-MT0.N1.LD-BP+250.tif',
    },
  },
  'epfl-dh': {
    label: 'EPFL double-helix low-density stack',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html',
    localPath: 'sequence-MT0.N1.LD-DH-Exp-as-stack',
    files: { stack: file('EPFL_DH_STACK', 'sequence-as-stack-MT0.N1.LD-DH-Exp.tif') },
    parameters: {}, scenarios: ['load'], scientificValidation: false,
    download: {
      type: 'zip-file',
      url: 'https://bigwww.epfl.ch/srm/Data/challenge-3D-simulation/MT0.N1.LD/Data/sequence-MT0.N1.LD-DH-Exp-as-stack.zip',
      file: 'sequence-as-stack-MT0.N1.LD-DH-Exp.tif',
    },
  },
  'npc-beads': {
    label: 'NPC A647 3D beads sequence',
    source: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-real/NPC-A647-3D-Results/index.html',
    localPath: 'NPC-A647-3D-BEADS-as-sequence',
    files: { frames: file('NPC_BEADS_DIR', 'NPC-A647-3D-BEADS') },
    parameters: {}, scenarios: ['load'], scientificValidation: false,
    download: {
      type: 'zip',
      url: 'https://bigwww.epfl.ch/srm/dataset/challenge-3D-real/NPC-A647-3D-Results/NPC-A647-3D-BEADS-as-sequence.zip',
      archive: 'NPC-A647-3D-BEADS-as-sequence.zip', intoDestination: true,
    },
  },
  'cas12a-segmentation': {
    label: 'Cas12a targeting (sptPALM)',
    source: 'https://github.com/HohlbeinLab/sptPALM-Python/tree/main/experimental_data',
    sourceRevision: SPTPALM_REVISION,
    localPath: 'sptPALM-Python/experimental_data',
    files: {
      mask: file('IMPLB_SEGM', 'Cas12aTargeting_procBrightfield_segm.tif'),
      brightfield: file('CAS12A_TARGETING_BRIGHTFIELD', 'Cas12aTargeting_procBrightfield.tif'),
      segmentationTable: file('CAS12A_TARGETING_SEGMENTATION_TABLE', 'Cas12aTargeting_procBrightfield_segm_Table.csv'),
      localizationsPart1: file('IMPLB_CSV', 'Cas12aTargeting_localisations_part1_MLE_thunder.csv'),
      localizationsPart2: file('CAS12A_TARGETING_LOCS_2', 'Cas12aTargeting_localisations_part2_MLE_thunder.csv'),
      parameters: file('SPTPALM_INPUT_PARAMETERS', 'input_parameter.pkl'),
      readme: file('SPTPALM_DATA_README', 'README.txt'),
    },
    parameters: SPTPALM_PARAMETERS,
    scenarios: ['segmentation', 'spt'], benchmark: 'bench-segmentation.mjs', scientificValidation: true,
    download: { type: 'files', files: CAS12A_TARGETING_FILES },
    bytes: Object.fromEntries(CAS12A_TARGETING_FILES.map(entry => [entry.name, entry.bytes])),
  },
  'cas12a-scrambled': {
    label: 'Cas12a scrambled control (sptPALM)',
    source: 'https://github.com/HohlbeinLab/sptPALM-Python/tree/main/experimental_data',
    sourceRevision: SPTPALM_REVISION,
    localPath: 'sptPALM-Python/experimental_data',
    files: {
      mask: file('CAS12A_SCRAMBLED_MASK', 'Cas12aScrambled_procBrightfield_segm.tif'),
      brightfield: file('CAS12A_SCRAMBLED_BRIGHTFIELD', 'Cas12aScrambled_procBrightfield.tif'),
      segmentationTable: file('CAS12A_SCRAMBLED_SEGMENTATION_TABLE', 'Cas12aScrambled_procBrightfield_segm_Table.csv'),
      localizationsPart1: file('CAS12A_SCRAMBLED_LOCS_1', 'Cas12aScrambled_localisations_part1_MLE_thunder.csv'),
      localizationsPart2: file('CAS12A_SCRAMBLED_LOCS_2', 'Cas12aScrambled_localisations_part2_MLE_thunder.csv'),
      parameters: file('SPTPALM_INPUT_PARAMETERS', 'input_parameter.pkl'),
      readme: file('SPTPALM_DATA_README', 'README.txt'),
    },
    parameters: SPTPALM_PARAMETERS,
    scenarios: ['segmentation', 'spt'], benchmark: 'bench-segmentation.mjs', scientificValidation: true,
    download: { type: 'files', files: CAS12A_SCRAMBLED_FILES },
    bytes: Object.fromEntries(CAS12A_SCRAMBLED_FILES.map(entry => [entry.name, entry.bytes])),
  },
  ssmlm: {
    label: 'Spectrally resolved SMLM (Martens et al.)',
    source: 'https://doi.org/10.5281/zenodo.6778964',
    localPath: 'sSMLMA Data',
    files: { data: file('SSMLM_DATA_DIR', '.') },
    parameters: { sSmlmDistMin: 2200, sSmlmDistMax: 2800, sSmlmAngleTol: 5 },
    scenarios: ['multi-file-load', 'ssmlm'], scientificValidation: false,
    download: {
      type: 'zip',
      url: 'https://zenodo.org/api/records/6778964/files/sSMLMA%20Data.zip/content',
      archive: 'sSMLMA Data.zip', intoDestination: true, marker: '.download-complete',
    },
    bytes: 19269956401,
  },
  'smfret-alex': {
    label: 'Dual-view ALEX TIRF smFRET',
    localPath: 'smfret-alex',
    files: { stack: file('SMFRET_ALEX_STACK', 'alex50mW_1_MMStack_Default.ome.tif') },
    parameters: { exposureMs: 30, frameIntervalMs: 32.02 },
    scenarios: ['load', 'smfret'], scientificValidation: false,
  },
  bigtiff: {
    label: 'BigTIFF stack',
    localPath: 'bigtiff',
    files: { stack: file('BIGTIFF_STACK', '2 flake tae F2 006.tif') },
    parameters: { bitDepth: 11 },
    scenarios: ['load', 'streaming'], scientificValidation: false,
  },
});

export function getDataset(key) {
  const dataset = DATASETS[key];
  if (!dataset) throw new Error(`Unknown dataset "${key}". Run data:list to see available keys.`);
  return dataset;
}

export function datasetFile(datasetKey, role) {
  const dataset = getDataset(datasetKey);
  const entry = dataset.files[role];
  if (!entry) throw new Error(`Dataset "${datasetKey}" has no file role "${role}".`);
  return {
    envKey: entry.envKey,
    paths: entry.paths.map(relative => posix.join(dataset.localPath, relative)),
  };
}

export function parseGpuMode(args = process.argv.slice(2)) {
  const value = args.find(arg => arg.startsWith('--gpu='))?.slice('--gpu='.length) || 'both';
  if (!['cpu', 'gpu', 'both'].includes(value)) throw new Error('--gpu must be cpu, gpu, or both.');
  return value;
}

export function benchmarkScript(key) {
  const dataset = getDataset(key);
  if (!dataset.benchmark) throw new Error(`Dataset "${key}" is load-only; no benchmark is configured.`);
  return dataset.benchmark;
}
