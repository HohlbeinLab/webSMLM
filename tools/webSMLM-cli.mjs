#!/usr/bin/env node
// webSMLM headless CLI — Layer 2 of the v0.10.0 pipeline (docs/REFACTOR_PLAN.md
// step 6). Drives a real, TRUE headless Chromium via Playwright: uploads a
// local file directly (page.setInputFiles(), no HTTP server / CORS / fetch()
// needed at all — unlike autorun's ?fileUrl=, which only exists because a
// URL can't otherwise name a local file), calls window.webSMLM.analyze()
// straight through page.evaluate(), and writes the result to --out. No
// Downloads-folder polling, no fixed filenames, no guessing whether headless
// downloads work — the result comes back as a normal function return value
// over the same CDP connection Playwright already holds open.
//
// Setup (once):
//   cd tools && npm install
// (npm install's postinstall runs `playwright install chromium` for you —
// downloads the browser binary Playwright drives, separate from any browser
// you already have installed.)
//
// Usage:
//   node webSMLM-cli.mjs --file /path/to/stack.tif --pxnm 99.2 --method gaussmle
//   node webSMLM-cli.mjs --file stack.tif --method mle3d --calibration calib.json --pxnm 160 --gain 0.1248 --camoffset 100
//   node webSMLM-cli.mjs --file stack.tif --method mle3d --calibration beadstack.tif --calStep 10 --pxnm 160
//   node webSMLM-cli.mjs --calibration beadstack.tif --calibrationOnly --calStep 10 --pxnm 160 --out ./calib-out
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --correctDrift --computeFRC --headed --out ./somewhere/else
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --estimateGainOffset --method gaussmle
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --cropX0 100 --cropY0 0 --cropX1 600 --cropY1 400
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --sSmlmPair --sSmlmDistMin 2200 --sSmlmDistMax 2800
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --correctDrift --sptTrack --sptFrameTime 0.05
//
// --calibration accepts EITHER a *.json (used as-is, today's behaviour) or a
// *.tif/*.tiff bead z-stack — dispatched on file extension. A .tif builds a
// fresh calibration via calibrationCore() before the main run (and writes it
// out as <name>_calib.json alongside the usual output, so it can be reused
// without rebuilding). --calibrationOnly builds/writes just the calibration
// and skips localizing entirely — --file is not required in that mode.
// --calFirst/--calLast/--calStep/--calRef control the calibration range/
// step/z=0 reference, same meaning as the interactive Calibrate controls;
// anything not given falls back to a default (whole stack / PARAMS.calStep
// =10nm / PARAMS.calRef=auto) with a warning logged to log.txt/the
// terminal — a silently-wrong z-step in particular would otherwise produce
// a badly wrong calibration with no indication anything was defaulted.
//
// --out defaults to a "webSMLM-out" folder NEXT TO --file (or --calibration
// in --calibrationOnly mode) — not the current working directory you happen
// to run this from — pass --out explicitly to put it somewhere else.
//
// Any other --key=value is passed straight through as a PARAMS override
// (docs/DOCUMENTATION.md §2) — e.g. --winr=6 --gain=0.5. Bare flags (no
// value) become `true` — useful for --correctDrift/--computeNeNA/
// --computeFRC/--calibrationOnly/--estimateGainOffset/--sSmlmPair/
// --sptTrack and any PARAMS bool.
// --sSmlmPair pairs 0th/1st-order spectral SMLM localizations after
// Localize (MODULE: sSMLM, docs/DOCUMENTATION.md §8) — the headless
// equivalent of clicking Pair. --sSmlmDistMin/--sSmlmDistMax/
// --sSmlmAngleCenter/--sSmlmAngleTol/--sSmlmRequireNarrower (ordinary PARAMS
// overrides) configure the window; pairing throws if the input already has
// real 3D z or is already-paired output (summary.json's "sSmlmPair" field
// records nPairs/meanDistance/stdDistance either way).
// --sptTrack links localizations into trajectories and computes a per-track
// diffusion coefficient after Localize (MODULE: spt, docs/DOCUMENTATION.md
// §8) — the headless equivalent of clicking Track. Unlike --sSmlmPair, runs
// AFTER --correctDrift/--computeNeNA/--computeFRC (a per-track D benefits
// from drift-corrected coordinates; pass --correctDrift first if you want
// that). --sptSearchRange/--sptMemory/--sptFrameTime/--sptLocError/
// --sptTrackLenMin (ordinary PARAMS overrides) configure it; result.csv
// gains track_id/D_coeff columns (summary.json's "spt" field records
// nTracks/nQualify/meanD/medianD).
// --estimateGainOffset runs PCFO gain/offset estimation (docs/DOCUMENTATION.md
// §2 Fit / §8) on --file itself before localizing, overriding --gain/--camoffset
// with the estimate (summary.json's "pcfo" field records what was found; falls
// back to whatever --gain/--camoffset were passed if PCFO can't fit, e.g. too
// few usable tiles) — the headless equivalent of clicking "Estimate", "Transfer
// estimates", then "Localize". --pcfoFrames/--pcfoK/--pcfoRnstd (PARAMS
// overrides) tune it.
// --cropX0/--cropY0/--cropX1/--cropY1 (any subset — an omitted bound defaults
// to that edge of the full frame) replace --file with just that native-pixel
// sub-rectangle before anything else touches it — the headless equivalent of
// the raw-panel crop tool: Localize (and PCFO, if also requested) only ever
// see the cropped region, both faster (smaller frames) and reproducible
// (logged, not a manual click). Throws if the resulting region is under 8x8 px.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---- argv parsing: --key value / --key=value / bare --flag => true ----
const SPECIAL = new Set(['file', 'calibration', 'out', 'headed']);
const argv = process.argv.slice(2);
const opts = { headed: false };   // opts.out is resolved below, once filePath is known
const configOverrides = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  let key, val;
  const eq = a.indexOf('=');
  if (eq !== -1) { key = a.slice(2, eq); val = a.slice(eq + 1); }
  else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { key = a.slice(2); val = argv[++i]; }
  else { key = a.slice(2); val = true; }
  if (SPECIAL.has(key)) opts[key] = val;
  else configOverrides[key] = val;
}

const calibrationOnly = configOverrides.calibrationOnly === true || configOverrides.calibrationOnly === '1' || configOverrides.calibrationOnly === 'true';

if (!opts.file && !calibrationOnly) {
  console.error('error: --file <path-to-tiff> is required (unless --calibrationOnly)');
  process.exit(1);
}

const filePath = opts.file ? resolve(opts.file) : null;
const calibPath = opts.calibration ? resolve(opts.calibration) : null;
const calibIsJson = calibPath ? /\.json$/i.test(calibPath) : false;
const calibIsTiff = calibPath ? /\.tiff?$/i.test(calibPath) : false;
const calibrationJson = calibIsJson ? JSON.parse(readFileSync(calibPath, 'utf8')) : null;

if (calibrationOnly && !calibIsTiff) {
  console.error('error: --calibrationOnly needs --calibration <bead-stack.tif> (a .tif/.tiff to build a calibration from, not a .json)');
  process.exit(1);
}

// Default: next to the INPUT file (or the calibration stack, in
// --calibrationOnly mode), not the shell's current working directory —
// otherwise where output lands silently depends on where you happened to
// invoke this from, easy to lose track of. --out overrides explicitly.
const outDir = opts.out ? resolve(opts.out) : join(dirname(filePath || calibPath), 'webSMLM-out');
mkdirSync(outDir, { recursive: true });

// file:// works fine here — unlike autorun's fetch(fileUrl), setInputFiles()
// goes through the browser's native file-input machinery, not a network
// request, so there's no origin/CORS concern either way. One tradeoff: the
// worker pool's probe (getPool()) is known to fail on file:// in some
// browsers (a pre-existing, already-handled case — see MODULE: workers) and
// falls back to single-threaded; serve webSMLM.html over http instead if
// worker-pool speed matters more than avoiding a local server for a run.
const htmlUrl = pathToFileURL(join(repoRoot, 'webSMLM.html')).href;

// Tags for the two live-progress channels forwarded from inside
// page.evaluate() (see below) — page.on('console') is real-time, unlike
// the eventual page.evaluate() return value, which only arrives once the
// whole run is done. Anything else logged by the page (a real console
// error, e.g.) passes through unprefixed.
const PROGRESS_TAG = ' WEBSMLM_PROGRESS ';
const LOG_TAG = ' WEBSMLM_LOG ';

// A standard, in-place terminal progress bar (\r-overwrite, no new line per
// update) — driven by onProgress, which fires as often as the run
// naturally yields (during drift correction that's once per segment, often
// many times a second — the bar itself is fine with that, \r is cheap).
// Shows the most recent onLog line next to the bar as a "currently
// running" status (e.g. "Run: 161 frames · Gaussian MLE 3D
// fit..." or "Drift correction (AIM): 100-frame segments, ..."), since
// those onLog lines already read as a phase description. \x1b[K (erase to
// end of line) after the content clears any leftover characters from a
// longer previous render, so a shorter status string doesn't leave stale
// text trailing it. Truncated to terminal width: an untruncated line that's
// wider than the terminal WRAPS, and \r then only returns to the start of
// the wrapped row, not the true line start — every high-frequency update
// (again, drift correction is the worst case) then staircases down the
// screen as a new "line" instead of overwriting, exactly the bug this bar
// exists to avoid. columns is undefined when stdout isn't a TTY (piped/
// redirected); 80 is a reasonable fallback there, though wrapping can't
// actually happen in that case anyway.
const BAR_WIDTH = 30;
let barActive = false, currentPhase = '';
function renderProgress(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round(BAR_WIDTH * p / 100);
  const bar = '#'.repeat(filled) + '-'.repeat(BAR_WIDTH - filled);
  const suffix = currentPhase ? `  ${currentPhase}` : '';
  let line = `  [${bar}] ${p.toFixed(0).padStart(3)}%${suffix}`;
  const width = (process.stdout.columns || 80) - 1;   // 1-col margin: some terminals wrap AT the last column too
  if (line.length > width) line = line.slice(0, Math.max(0, width - 1)) + '…';
  process.stdout.write(`\r${line}\x1b[K`);
  barActive = true;
}
function printLine(text) {
  if (barActive) { process.stdout.write('\n'); barActive = false; }
  console.log(text);
}

console.log(`Launching Chromium (${opts.headed ? 'headed' : 'headless'})...`);
const browser = await chromium.launch({ headless: !opts.headed });
const page = await browser.newPage();
page.on('console', msg => {
  const text = msg.text();
  if (text.startsWith(PROGRESS_TAG)) renderProgress(+text.slice(PROGRESS_TAG.length));
  else if (text.startsWith(LOG_TAG)) {
    const line = text.slice(LOG_TAG.length);
    currentPhase = line.trim();
    printLine(line);
  }
  else if (msg.type() === 'error') printLine('  [page error] ' + text);
});

try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);

  if (filePath) {
    console.log(`Uploading ${filePath}...`);
    await page.setInputFiles('#analyzeFileInput', filePath);
  }
  if (calibIsTiff) {
    console.log(`Uploading calibration stack ${calibPath}...`);
    await page.setInputFiles('#calibrationFileInput', calibPath);
  }

  console.log('Running analyze()...');
  const result = await page.evaluate(async ({ rawConfig, calibrationJson, calibIsTiff, fileInputId, calFileInputId, progressTag, logTag }) => {
    const config = {};
    for (const key in rawConfig) {
      const spec = PARAMS[key];
      const raw = rawConfig[key];
      if (spec) {
        config[key] = spec.type === 'bool' ? (raw === '1' || raw === 'true' || raw === true)
                     : spec.type === 'enum' ? String(raw) : +raw;
      } else if (key === 'correctDrift' || key === 'computeNeNA' || key === 'computeFRC' || key === 'calibrationOnly' || key === 'estimateGainOffset' || key === 'sSmlmPair' || key === 'sptTrack') {
        config[key] = raw === '1' || raw === 'true' || raw === true;
      } else if (key === 'calFirst' || key === 'calLast' || key === 'cropX0' || key === 'cropY0' || key === 'cropX1' || key === 'cropY1') {
        config[key] = +raw;
      }
    }
    const fileEl = document.getElementById(fileInputId);
    if (fileEl.files.length) config.file = fileEl.files[0];
    if (calibrationJson) config.calibrationJson = calibrationJson;
    if (calibIsTiff) config.calibrationFile = document.getElementById(calFileInputId).files[0];
    // Forward both live via console.log — page.on('console') on the Node
    // side (real-time) sees these as the run progresses, unlike the
    // eventual return value below, which only arrives once fully done.
    // onProgress is forwarded unthrottled: the Node side renders it as an
    // in-place bar (cheap to update often, unlike printing a new line per
    // tick); onLog carries only real diagnostic/summary text, no
    // percentage lines — the bar is the only place progress shows.
    config.onProgress = pct => console.log(progressTag + pct);
    config.onLog = m => console.log(logTag + m);
    const r = await window.webSMLM.analyze(config);
    if (config.calibrationOnly) return { calibrationOnly: true, calibJsonText: r.calibJsonText, logText: r.logText };
    // Trim: locs itself can be large and is redundant with csvText for file
    // output — keep only what a CLI run actually needs to write out.
    return {
      nLocalizations: r.locs.length, csvText: r.csvText, settingsText: r.settingsText,
      logText: r.logText, reconstructionPng: r.reconstructionPng, timings: r.timings,
      drift: r.drift, nena: r.nena, frc: r.frc, calibJsonText: r.calibJsonText,
      // pts (one point per tile per sampled frame) is redundant with the log's
      // gain/offset/R² summary and can run into the thousands — trimmed here
      // the same way locs itself is dropped in favor of csvText above.
      pcfo: r.pcfo ? { gain: r.pcfo.gain, gainStd: r.pcfo.gainStd, offset: r.pcfo.offset, offsetStd: r.pcfo.offsetStd, r2: r.pcfo.r2 } : null,
      // sSmlmPair.locs is redundant with csvText's own "dist [nm]" column —
      // trimmed the same way pairCore's own locs array is above.
      sSmlmPair: r.sSmlmPair ? { nPairs: r.sSmlmPair.nPairs, nInput: r.sSmlmPair.nInput, meanDistance: r.sSmlmPair.meanDistance, stdDistance: r.sSmlmPair.stdDistance } : null,
      // spt is already a small summary (no per-track arrays) — analyze()
      // itself only returns {nTracks, nQualify, meanD, medianD}, so unlike
      // sSmlmPair/pcfo above there's nothing further to trim here.
      spt: r.spt,
    };
  }, { rawConfig: configOverrides, calibrationJson, calibIsTiff, fileInputId: 'analyzeFileInput', calFileInputId: 'calibrationFileInput', progressTag: PROGRESS_TAG, logTag: LOG_TAG });

  const calibOutName = (calibPath ? basename(calibPath).replace(/\.(ome\.)?tiff?$/i, '') : 'webSMLM') + '_calib.json';

  if (result.calibrationOnly) {
    writeFileSync(join(outDir, 'log.txt'), result.logText);
    writeFileSync(join(outDir, calibOutName), result.calibJsonText);
    printLine(`Done: calibration written to ${join(outDir, calibOutName)}`);
  } else {
    writeFileSync(join(outDir, 'result.csv'), result.csvText);
    writeFileSync(join(outDir, 'settings.json'), result.settingsText);
    writeFileSync(join(outDir, 'log.txt'), result.logText);
    const pngData = result.reconstructionPng.replace(/^data:image\/png;base64,/, '');
    writeFileSync(join(outDir, 'reconstruction.png'), Buffer.from(pngData, 'base64'));
    if (result.calibJsonText) writeFileSync(join(outDir, calibOutName), result.calibJsonText);
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
      nLocalizations: result.nLocalizations, timings: result.timings,
      drift: result.drift, nena: result.nena, frc: result.frc, pcfo: result.pcfo,
      sSmlmPair: result.sSmlmPair, spt: result.spt,
    }, null, 2));

    printLine(`Done: ${result.nLocalizations.toLocaleString()} localizations in ${Math.round(result.timings.runMs)} ms. Output in ${outDir}`);
  }
} catch (err) {
  if (barActive) { process.stdout.write('\n'); barActive = false; }
  console.error('Failed:', err && err.message || err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
