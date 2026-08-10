# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **`tempClusteringMemory` — gap-frame tolerance for temporal clustering.**
  `clusterEvents()` (table module) currently requires strictly consecutive
  frame numbers to chain detections into one event (memory=0, hardcoded) —
  a molecule that blinks off for even one frame and back on starts a new
  chain instead of extending the old one. `tempClusteringMemory = N` would
  allow up to N missed frames between detections of the same chain. Needs a
  decision on how a gap should weight into the position average (does a
  skipped frame count as "still on" for the photon-weighted mean, or purely
  bridge the chain without contributing) before implementing.
- **For later: reconsider the detect/fit/export/table module split.** These
  four already share parameters and data in ways that make the boundary feel
  arbitrary in places — e.g. `PARAMS.gain`/`camoffset` sit under a `----
  export` comment header (`webSMLM.html`) even though the conversion now
  happens inside `fit`, and `table` reads the same already-converted
  `photons`/`bg`/`bgstd` that `export` does. Merging any two of them "because
  they're interwoven" risks snowballing (detect/fit are just as interwoven
  with each other and stay split, so that alone isn't a sufficient
  criterion) — needs an actual principle for where the lines go (kind of
  work vs. data flow) before touching it, not just an ad-hoc merge. At
  minimum, retitle the stale `---- export` `PARAMS` comment to `fit` once
  this is looked at.
- **For later: let a settings JSON override a parameter's `min`/`max`/`step`,
  not just its value.** Today Save/Load Settings only round-trips
  `{id: value}` pairs (see `$('saveSetBtn')`/`$('setFile')`) — the bounds
  themselves live solely in the hardcoded `PARAMS` registry in
  `webSMLM.html` and can't be changed without editing the file. Letting a
  loaded JSON optionally carry `{id: {value, min, max, step}}` and apply the
  bounds to both the in-memory `PARAMS[id]` entry and the DOM control's
  `min`/`max`/`step` attributes (reusing `syncParamControls()`'s write path)
  would let someone with unusual data (e.g. a camera gain far outside
  today's 0.001–1000 range, or a much larger pixel size) relax a boundary
  for their own use without touching the source. Needs a decision on
  whether `saveSetBtn` should also emit bounds by default (so a saved file
  is a full self-describing spec) or only on request (keeping normal saves
  small/value-only).
- **For later: let Load Settings introduce whole new modules, not just
  parameter values.** Today a loaded JSON can only set values for
  parameters the registry already knows about (`PARAMS[id]` must exist —
  see `logParamValues`/`$('setFile')` handler). A further step would let a
  loaded file *extend* the registry itself — e.g. ship a new detection
  filter or fit method's parameters (and, harder, its code) bundled with a
  settings file, so a new module can be dropped in and used without a
  webSMLM.html edit. Needs real design (where does the new module's *code*
  come from in a single-file, no-build app? a `Function`-constructor'd
  snippet embedded in the JSON? a second file?) — flagged here as a
  direction, not scoped yet.
- **v0.10.0 — scriptable / headless pipeline** — run load → detect/fit →
  drift → export without clicking through the UI, so it can batch-process
  files and run an identical scenario across browsers for comparison. Builds
  directly on the v0.9.4 parameter registry — the config object is that
  registry's shape (i.e. the same `{id: value}` shape a settings JSON
  already round-trips — see `docs/DOCUMENTATION.md` §4).

  **Why this isn't a `--headless` flag on the file itself.** The closest
  prior art is ThunderSTORM's ImageJ macro support: `run("Run analysis",
  "filter=... threshold=...")` command strings, driven by
  `ImageJ --headless -macro script.ijm 'files=[...]'` from a terminal, with
  direct filesystem output (`saveAs("png", path)`, `run("Export results",
  "filepath=[...]")`). That works because ImageJ is a desktop JVM app — the
  same process runs with or without a display, with real filesystem access,
  and ships a native headless mode. webSMLM has no equivalent: it's JS that
  only exists inside a browser sandbox (Canvas, File API, Web Workers, no
  raw filesystem access) — there's no "run the HTML with no browser
  underneath" any more than there's a way to run a `.jar` with no JVM. The
  nearest equivalent of ImageJ's `--headless` is a **headless (windowless)
  Chromium**, driven by a script instead of a person — so the design splits
  into three layers instead of one flag:

  - **Layer 1 — in-page API** (the equivalent of ThunderSTORM's
    `run("Run analysis", "...")` command string): `window.webSMLM.analyze
    (config) → Promise<result>`. Takes a flat `{id: value}` config (only
    non-default values need to be given) and runs the *entire* pipeline —
    load → detect/fit → drift → CSV/log/settings text — without touching a
    DOM control, a dialog, or a Blob-download. Returns everything as
    in-memory data rather than triggering a download: `locs`, `csvText`,
    `logText`, `settingsText` (the config itself, echoed — see the
    "autogenerate three artifacts" point below), per-stage `timings`, and
    — since a headless Chromium still fully computes `<canvas>` pixels even
    with no visible window — PNGs for the reconstruction and any FRC/NeNA
    plots via `canvas.toDataURL('image/png')`. Returning data instead of
    downloading sidesteps "how do browser downloads work headlessly"
    entirely: the caller (Layer 0 or Layer 2 below) decides what to do with
    the result. Also: `analyzeBatch(files, config)` looping over multiple
    `File`s.
  - **Layer 2 — a companion driver script** (the equivalent of
    `ImageJ --headless -macro script.ijm 'files=[...]'` itself): a small
    Node tool using **Playwright** (not Puppeteer — better multi-browser
    support, and `page.setInputFiles()` is the key piece below) that
    launches headless Chromium, opens `webSMLM.html`, calls `analyze
    (config)` via `page.evaluate()`, and writes whatever comes back to
    disk. This is the actual terminal/flag-based tool:
    `node webSMLM-cli.mjs --file stack.tif --pxnm 160 --method mle3d --out
    ./results/`. Lives as separate repo tooling (its own `package.json` +
    Playwright dependency) — deliberately **not** part of `webSMLM.html`,
    so the app's own no-build-step/no-dependency property is untouched.
    Design detail: for a multi-GB stack, don't pipe file bytes through
    `page.evaluate()`'s structured-clone boundary — use
    `page.setInputFiles()` on a hidden `<input type=file>` so the browser's
    own `File`/`File.slice()` streaming (already relied on by the loader)
    does the work natively, exactly as for a human clicking "Load movie".
  - **Layer 0 — URL-param autorun**, simpler and complementary, not a
    replacement: `webSMLM.html?autorun=1&pxnm=160&method=mle3d&...` calling
    the *same* `analyze()` on page load. Works in a real double-clicked
    browser too, no Playwright needed — this is what powers the
    cross-browser benchmark mode below. Its real limit is that a local file
    can't be named in a URL for security reasons (only a fetchable remote
    URL, or Chromium launched with relaxed file-access flags — which only a
    driving script can set anyway, collapsing local-file batch use back to
    Layer 2).

  **Module-split question, settled**: run the entire HTML, not per-module.
  The single-file constraint is deliberate (see `CLAUDE.md`) and the
  modules aren't cleanly separable at the JS level today (shared globals,
  `WORKER_PRELUDE`) — there's no headless-specific benefit to splitting,
  since Chromium loads the whole file trivially fast regardless of "module
  boundaries." ThunderSTORM's own macro doesn't load "just the fitting
  module" either — it drives the same fully-loaded plugin.

  **Next steps, in order** (each one buildable/testable before the next):
  1. ✅ **Done.** Extract a DOM-free `runCore(config, fileOrStack)` from
     `run()` — returns `{locs, timings}` instead of touching `lastResult`/
     `log()`/`$()`/`setProg()` directly. `run()` itself becomes a thin UI
     wrapper: build `config` from `paramValue()` for every relevant `PARAMS`
     id, call `runCore`, then do all the existing DOM-touching side effects
     (log lines, stats bar, button enabling, `rerender()`) as before —
     interactive behaviour unchanged (validated by synthetic JXA tests on
     the serial path; the worker-parallel dispatch path still needs a real
     browser Localize run before being fully trusted).
  2. ✅ **Done.** Same extraction for CSV/log/settings text
     (`buildCsvText()`/`buildSettingsJson()`/`buildConfigFromParams()`) and
     for drift (`driftCore()`), plus `onLog` hooks added to `frcResolution`/
     `aimDriftZ` (the only two of the precision/drift helpers that still
     called `log()` directly — `nenaPrecision`/`aimDrift2D` were already
     clean).
  3. ✅ **Done.** `window.webSMLM.analyze(config)` assembled on top of the
     above, plus `analyzeBatch(files, config)` and a `canvas.toDataURL()`
     reconstruction PNG (via `renderSuperRes()`, which already creates its
     own detached canvas — no page `#sr` element needed). Takes
     `config.file`/`config.files` (a `File`/array, loaded via the existing
     `loadTiffFile`/`loadTiffSequence`) and `config.calibrationJson` (parsed
     calibration JSON — there's no interactive `cal3d`/`cal3dW` session state
     to fall back on headlessly, so a 3D method needs it supplied
     explicitly; `calibFromJson()` parses it the same way the `calFile`
     change handler does). **Known gap, not yet done:** FRC/NeNA return
     their numeric result only (`frc`/`nena` fields) — no plot PNG, since
     `drawFrcPlot`/`drawNenaPlot` are still tied to the interactive `#raw`
     canvas; extracting their plotting logic to target an arbitrary canvas
     is unstarted. **Validated against real data**: `analyze()` called from
     a browser console (`buildConfigFromParams()` snapshotting the live UI
     state, so it's an exact apples-to-apples comparison) against the
     GATTA-PAINT dataset produced the same localization count as an
     interactive Localize with identical settings.
  4. ✅ **Done.** `?autorun=1&fileUrl=...&pxnm=...&...` (Layer 0, see
     `docs/DOCUMENTATION.md` §8) runs `analyze()` automatically on page
     load, using the query string as a partial config, type-coerced per
     `PARAMS`. `fileUrl`/`calibrationUrl` are fetchable URLs, not local
     paths (unavoidable browser security constraint) — fetched as a
     `Blob`/parsed JSON, which `analyze()` accepts as-is. Result is logged
     and stashed on `window.webSMLM.lastAutorunResult`, not auto-downloaded
     or rendered — this is the "open this link, it just runs" case, not
     local-file batch processing (that's Layer 2). Validated synthetically
     (URL-param → config type-coercion and reserved-key filtering, against
     a stubbed `fetch`/`analyze` — the three risky/new pieces: the no-op
     guard, the missing-`fileUrl` error path, and full config resolution
     all matched exactly); not yet tried against a real URL in a browser.
  5. ✅ **Done, but differently than originally sketched here.** The
     original idea was an in-page `?bench=default` fixed *synthetic*
     scenario. Reconsidered: synthetic frames are generated in-memory and
     so skip the TIFF decode path entirely — but that's exactly where most
     of the cross-browser variance this project has actually measured
     lives (`README.md`: "Browser matters... Safari, then Chrome, then
     Firefox"; this session's own decode-fast-path work) — so a
     synthetic-only benchmark would miss the more interesting signal.
     Real data needs a real file, which argued against baking scenarios
     into the HTML at all. What got built instead, entirely outside
     `webSMLM.html`: **`&download=1`** on the existing `?autorun=1` (§8) —
     writes the same three artifacts a UI session produces by hand
     (settings/CSV/log) plus a timing/config summary and the reconstruction
     PNG, all under fixed filenames, to Downloads (dialog-free in every
     browser, since `saveBlob()`'s `showSaveFilePicker()` path needs a user
     gesture autorun doesn't have, so it falls through to a plain
     `<a download>`) — plus two parameter-sweep drivers that open a real
     browser once per value of a swept parameter (e.g. fit radius) against
     your own local copy of a reference dataset, poll Downloads for the
     result files, and collect them into a working folder with a summary
     CSV: **`tools/browser-sweep.sh`** (bash, with OS detection —
     macOS/Linux/Windows(Git Bash)/WSL — for the browser-launch command and
     Downloads-folder path; only macOS can auto-close each tab between
     runs, no cross-platform equivalent exists) and
     **`tools/browser_sweep.py`** (stdlib-only Python; its `webbrowser`
     module already abstracts the per-OS launch command, so it needs far
     less platform branching — arguably the easier of the two to read).
     Neither needs a dependency installed, but neither gets a true headless
     mode either (see below) and both rely on the Downloads folder
     behaving predictably — only the macOS path (both scripts) and the
     core plumbing (Python's local HTTP server + Downloads-dir detection,
     smoke-tested directly against this machine) are actually verified;
     Linux/Windows/WSL support is best-effort and unverified.
     **On headless**: real headless Chrome/Firefox exist (not Safari — no
     headless mode at all), but bolting `--headless` onto either script
     would be a guess, not a verified feature — historically headless
     Chrome blocks file downloads by default unless a controlling script
     explicitly enables them via the DevTools Protocol, and a bare
     CLI-launched headless instance isn't held open the way a real
     automation framework holds one open, so it may exit before the async
     analyze() pipeline (fetch → detect/fit → download, seconds to minutes)
     finishes. Both of those are exactly what Layer 2 (below) is for.
  6. ✅ **Done.** `tools/webSMLM-cli.mjs` + `tools/package.json` (Playwright,
     scoped to `tools/` — `webSMLM.html` itself stays dependency-free).
     `--file`/`--calibration` upload via `page.setInputFiles()` on a
     dedicated `#analyzeFileInput` (deliberately separate from the real
     `#file` input, which has its own `change` listener that would
     otherwise redundantly re-decode the same TIFF into the unrelated
     `stack` global); any other `--key=value` becomes a `PARAMS` override,
     type-coerced inside `page.evaluate()` against the page's own live
     `PARAMS` (no duplicated/driftable coercion logic on the Node side).
     `analyze()`'s result comes back as a normal return value over the CDP
     connection Playwright already holds — no Downloads-folder polling, no
     fixed filenames, no guessing whether headless downloads work, unlike
     the two sweep scripts (step 5). `--out` defaults to a folder next to
     `--file`, not the shell's CWD. **Validated directly against real data
     — true headless, no `--headed` needed**: 10,799 localizations from the
     GATTA-PAINT stack in 968 ms, all 5 output files written correctly
     (`result.csv` in the same ThunderSTORM format, `log.txt` matching the
     interactive log text, a valid 820×830 PNG); the `mle3d`-without-
     `calibrationJson` guard (added to `analyze()` in step 3) throws
     cleanly through to Node with a clear message and a non-zero exit
     code, confirmed directly. This test also surfaced (and it's since been
     fixed) that a CLI run with no `--gain`/`--camoffset` silently reported
     raw ADU as "photon" counts with no warning — `exportCSV()`'s wrapper
     had this check, but `analyze()` builds the CSV directly and never
     called it; `analyze()` now runs the same check itself and logs the
     same warning into `logText`, confirmed by re-running the CLI.
  7. Regression check via `analyze()`: fixed-seed synthetic stack → assert
     localization count and RMS error within bounds. There is currently no
     automated test suite at all; this would be the first one, and it falls
     out of the pipeline API for free.
  8. Extend the synthetic generator to also emit known z and known drift
     (ground truth), so 3D/drift/precision work can be validated
     quantitatively through the same regression check rather than by eye.

  **Autogenerate three artifacts.** A headless run should always produce
  the same three files the UI path produces by hand: **settings** (the
  config itself, in the `webSMLM-settings` JSON shape — `docs/
  DOCUMENTATION.md` §4), **data** (the CSV, §6), and the **log** — this
  falls out of `analyze()`'s return shape (step 3) for free; Layer 2's CLI
  just writes all three to `--out` unconditionally. Together with the CSV,
  the settings file recovers exactly the provenance a bare CSV doesn't
  carry (pixel size, gain, detection/fit method, …) — see the "Load data"
  discussion in `docs/DOCUMENTATION.md` §1/§6 for why that split (physical
  CSV + separate settings record, not one combined format) was chosen over
  embedding metadata in the CSV itself.
- Cross-validate **MLE 3D vs Phasor 3D** on real bead data — only checked
  against synthetic ground truth and mutual self-consistency so far.
- **3D detection beyond astigmatism** — Double Helix, Biplane, etc. could be
  added later as additional methods in the `3D calibration` module, alongside
  today's astigmatic σ_x/σ_y-vs-z approach.
- Cross-validate **NeNA and FRC** against established tools (ThunderSTORM,
  Picasso, FRCbar) — both still ship marked experimental.
- **3D FSC** (Fourier Shell Correlation) — the spherical-shell counterpart to
  2D FRC, once the 3D voxel-grid memory cost is bounded.
- **Multi-emitter fitting** for dense/overlapping PSFs. Single-emitter
  fitting biases positions where PSFs overlap, and a faster single-emitter
  fit can't fix that — a better initial guess doesn't help when there's no
  good single-emitter optimum to find in the first place (see the rejected
  phasor-seeding idea in the v0.3.0 changelog entry, which ran into exactly
  this).
- **Robust detection threshold.** `mean + k·σ_noise` is computed over the
  whole filtered frame including signal, so at high blink density the
  threshold rises and dim localizations get silently dropped — detection
  sensitivity is density-dependent. Consider MAD or a low percentile of the
  filtered image instead. Also: threshold statistics currently include
  border pixels that are never searched for maxima; and plateau handling
  needs a look — the local-maximum test uses strict `>`, so two equal
  adjacent pixels can both survive as separate localizations from one
  emitter.
- **σ_PSF estimation from the data**, instead of a fixed, user-supplied
  value.
- **Photon calibration beyond a single scalar gain/offset.** A scalar
  reasonably approximates an EMCCD chip, but most current SMLM runs on
  sCMOS, where gain, offset and read noise are all pixel-dependent (and
  non-uniform read noise also affects detection — a noisy pixel can
  masquerade as an emitter). Two options, increasing in rigor: (1) estimate
  gain from the data itself via a photon-transfer curve (variance-vs-mean
  across frames, slope = gain — feasible since every frame is already
  streamed through); (2) per-pixel gain/offset/variance calibration maps,
  with a noise model that uses them — see Huang et al., *Nat. Methods*
  **10**, 653–658 (2013), https://doi.org/10.1038/nmeth.2488.
- Optional **fiducial-based drift correction** when beads are present
  (simpler and more accurate than AIM for that specific case).
- **3D point-cloud view** — an interactive, rotatable scatter (orthographic
  projection, colour = z) as an alternative to the depth-coded 2D
  reconstruction, where localizations at different z that overlap in x/y
  currently blend together.
- Localizations-table filter grammar: parentheses/grouping; filtering
  presets.
- **Consider deprecating Phasor 2D/3D** in a future release. MLE 2D/3D are
  now the default and statistically superior (Poisson-optimal, reports a
  real CRLB uncertainty), and the worker pool has closed most of phasor's
  historical speed advantage for typical stacks. Phasor's own code is a
  modest ~200–250 lines out of ~5,800 (fit function, its distinct
  magnitude-ratio 3D calibration model, UI, worker/export wiring) — not
  huge, but removing it would simplify the calibration module down to one
  3D model instead of two co-existing ones that currently need guarding
  against each other. Weigh against phasor's one remaining real edge: it's
  still by far the fastest fitter, which could matter for extremely
  high-throughput or huge stacks where MLE's iterative cost adds up.
