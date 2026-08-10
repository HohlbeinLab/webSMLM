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
// --computeFRC/--calibrationOnly and any PARAMS bool.
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
// naturally yields, not throttled here (the page's own decile-text log
// lines, e.g. "  10%", now flowing through LOG_TAG, are the throttled
// permanent-record counterpart of this live-only bar). printLine() always
// moves off the bar's line first so a log line never overwrites/garbles it.
const BAR_WIDTH = 30;
let barActive = false;
function renderProgress(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round(BAR_WIDTH * p / 100);
  const bar = '#'.repeat(filled) + '-'.repeat(BAR_WIDTH - filled);
  process.stdout.write(`\r  [${bar}] ${p.toFixed(0).padStart(3)}%`);
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
  else if (text.startsWith(LOG_TAG)) printLine(text.slice(LOG_TAG.length));
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
      } else if (key === 'correctDrift' || key === 'computeNeNA' || key === 'computeFRC' || key === 'calibrationOnly') {
        config[key] = raw === '1' || raw === 'true' || raw === true;
      } else if (key === 'calFirst' || key === 'calLast') {
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
    // tick), while onLog already carries its own throttled "  10%" text
    // lines (added inside runCore/driftCore/frcResolution/calibrationCore)
    // as the permanent record written to log.txt.
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
      drift: result.drift, nena: result.nena, frc: result.frc,
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
