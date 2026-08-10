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
//   node webSMLM-cli.mjs --file stack.tif --pxnm 100 --correctDrift --computeFRC --headed --out ./somewhere/else
//
// --out defaults to a "webSMLM-out" folder NEXT TO --file (not the current
// working directory you happen to run this from) — pass --out explicitly to
// put it somewhere else.
//
// Any --key=value not listed above is passed straight through as a PARAMS
// override (docs/DOCUMENTATION.md §2) — e.g. --winr=6 --gain=0.5. Bare flags
// (no value) become `true` — useful for --correctDrift/--computeNeNA/
// --computeFRC and any PARAMS bool.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
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

if (!opts.file) {
  console.error('error: --file <path-to-tiff> is required');
  process.exit(1);
}

const filePath = resolve(opts.file);
const calibrationJson = opts.calibration
  ? JSON.parse(readFileSync(resolve(opts.calibration), 'utf8'))
  : null;
// Default: next to the INPUT file, not the shell's current working directory
// — otherwise where output lands silently depends on where you happened to
// invoke this from, easy to lose track of. --out overrides explicitly.
const outDir = opts.out ? resolve(opts.out) : join(dirname(filePath), 'webSMLM-out');
mkdirSync(outDir, { recursive: true });

// file:// works fine here — unlike autorun's fetch(fileUrl), setInputFiles()
// goes through the browser's native file-input machinery, not a network
// request, so there's no origin/CORS concern either way. One tradeoff: the
// worker pool's probe (getPool()) is known to fail on file:// in some
// browsers (a pre-existing, already-handled case — see MODULE: workers) and
// falls back to single-threaded; serve webSMLM.html over http instead if
// worker-pool speed matters more than avoiding a local server for a run.
const htmlUrl = pathToFileURL(join(repoRoot, 'webSMLM.html')).href;

console.log(`Launching Chromium (${opts.headed ? 'headed' : 'headless'})...`);
const browser = await chromium.launch({ headless: !opts.headed });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error') console.error('  [page error]', msg.text()); });

try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);

  console.log(`Uploading ${filePath}...`);
  await page.setInputFiles('#analyzeFileInput', filePath);

  console.log('Running analyze()...');
  const result = await page.evaluate(async ({ rawConfig, calibrationJson, fileInputId }) => {
    const config = {};
    for (const key in rawConfig) {
      const spec = PARAMS[key];
      const raw = rawConfig[key];
      if (spec) {
        config[key] = spec.type === 'bool' ? (raw === '1' || raw === 'true' || raw === true)
                     : spec.type === 'enum' ? String(raw) : +raw;
      } else if (key === 'correctDrift' || key === 'computeNeNA' || key === 'computeFRC') {
        config[key] = raw === '1' || raw === 'true' || raw === true;
      }
    }
    config.file = document.getElementById(fileInputId).files[0];
    if (calibrationJson) config.calibrationJson = calibrationJson;
    const r = await window.webSMLM.analyze(config);
    // Trim: locs itself can be large and is redundant with csvText for file
    // output — keep only what a CLI run actually needs to write out.
    return {
      nLocalizations: r.locs.length, csvText: r.csvText, settingsText: r.settingsText,
      logText: r.logText, reconstructionPng: r.reconstructionPng, timings: r.timings,
      drift: r.drift, nena: r.nena, frc: r.frc,
    };
  }, { rawConfig: configOverrides, calibrationJson, fileInputId: 'analyzeFileInput' });

  writeFileSync(join(outDir, 'result.csv'), result.csvText);
  writeFileSync(join(outDir, 'settings.json'), result.settingsText);
  writeFileSync(join(outDir, 'log.txt'), result.logText);
  const pngData = result.reconstructionPng.replace(/^data:image\/png;base64,/, '');
  writeFileSync(join(outDir, 'reconstruction.png'), Buffer.from(pngData, 'base64'));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    nLocalizations: result.nLocalizations, timings: result.timings,
    drift: result.drift, nena: result.nena, frc: result.frc,
  }, null, 2));

  console.log(`Done: ${result.nLocalizations.toLocaleString()} localizations in ${Math.round(result.timings.runMs)} ms. Output in ${outDir}`);
} catch (err) {
  console.error('Failed:', err && err.message || err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
