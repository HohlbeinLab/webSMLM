# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (~6400 lines). It loads a raw TIFF stack, detects/localizes emitters,
and renders a super-resolution image, **entirely client-side** (no upload, no server, no network
calls at runtime). `index.html` is just a redirect to `webSMLM.html` for the bare Pages URL.

`webSMLM.html` itself has **no build system, no package.json, no dependency install, and no test
runner.** "Running" the app = opening `webSMLM.html` in a browser (double-click, or the hosted
Pages copy). Do not introduce a bundler, framework, or npm dependency to the app itself — the
zero-install single-file property is the point. New third-party code must be inlined and its
license honoured in the head banner. (`tools/` is the one exception: a separate, optional
Node+Playwright CLI for headless/scripting use — see **pipeline** below — with its own scoped
`package.json`, deliberately kept out of `webSMLM.html` so the app's own property is untouched.)

## Editing model

All work happens inside `webSMLM.html`. It is organized into commented `MODULE:` banners; find the
relevant one before editing rather than scrolling:

- **params** — the `PARAMS` registry: single source of truth for every analysis/render/export
  parameter (name → `{label, min, max, step, default, int}`), read via `paramValue(id)`. Drives
  the HTML controls' min/max/default (`syncParamControls()`), Save/Load Settings, and — for
  parameters with no page control yet (worker-dispatch thresholds, preview timing, etc.) —
  `paramOverrides`, settable only via a loaded settings JSON. This is also the shape
  `window.webSMLM.analyze(config)`'s headless config takes (see **pipeline** below) — a new
  `PARAMS` entry is automatically available to both without extra wiring. Deliberately excludes
  pure display/layout (CSS) and per-dataset working state (`calFirst`/`calLast`/`zmin`/`zmax`).
- **in/out** — TIFF parsing; in-memory vs. streamed loading; contiguous ImageJ stacks are indexed
  arithmetically, multi-IFD (Micro-Manager MMStack) stacks by walking the IFD chain. Handles
  multi-GB files via `File.slice()` (never fully loaded). Also accepts a multi-file selection
  (Ctrl/Cmd+click several single-frame TIFFs) via `loadTiffSequence()` — natural-sorted by
  filename, decoded and concatenated into one stack, one file read at a time. `makeCroppedStack()`
  (raw-panel crop tool, `rawCropBtn`) is the simplest of this module's stack wrappers: it slices
  every fetched frame to a fixed `[x0,x1)×[y0,y1)` sub-rectangle and REPLACES the module-level
  `stack` with it (kept in `originalStack` while active, restored on "uncrop") — deliberately a
  full stack swap, not a search-region restriction threaded through detect/fit, so nothing
  downstream needs a coordinate offset added back and every consumer (FTM below, calibration,
  PCFO, workers, render/export) just sees a smaller stack the same way it'd see any smaller loaded
  file. FTM (`ftmEnabled`/
  `ftmWindow`, controls living in the **fit** module's `PARAMS` group and sidebar section despite
  the functions below sitting in in/out) is a per-pixel sliding-window temporal median
  subtraction — floored at `camoffset` and added back, not floored at zero, see **fit** below for
  why — used in **two** places sharing the same underlying math but otherwise independent:
  - **Scrubbing preview** — `ftmFrame()`/`ftmFrameParallel()`, one frame at a time (whichever's
    currently scrubbed), fetching only that frame's own `ftmWindow`-wide context. Parallelizes
    across the worker pool **spatially** (row bands, no overlap margin needed — each pixel's
    computation needs no neighbouring-pixel context, unlike detection). The raw-panel toggle
    (`rawFtmBtn`, inline in the panel title, shown only while `ftmEnabled` is checked — no
    load-time coupling, it can be toggled any time) drives `rawFtmView`; `showFrame()` swaps in
    the corrected frame via that flag before running the same detect/live-preview logic every
    other branch already uses. The raw panel **title stays fixed at "Raw frame"** always — only
    `rawFtmBtn`'s own label changes; don't reintroduce a dynamic title, it went through that and
    reverted to fixed for a reason (visual noise for no real information gain).
  - **Localize** — processes the stack in **chunks**, sized from half the `chunkmb` budget
    (headroom for holding both raw context and corrected output of one chunk at once) rather than
    a fixed constant, using the sliding-window median algorithm (`ftmSeriesGlobal`, O(window) per
    step, not one-shot medians). Which of two implementations runs depends on whether `runCore()`
    is using the worker pool at all this Run:
    - **No pool**: `makeFtmStack()` wraps the loaded stack so `runCore()`'s serial `getFrames()`
      calls receive FTM-corrected data transparently, caching each chunk so nearby requests reuse
      it instead of redundantly re-fetching/re-sorting nearly the same context. Main-thread, with
      a single-flight lock (kept for safety though this path only ever has one caller at a time).
    - **Pool in use**: a **barrier-phased loop** inside `runCore()` itself (search `fetchStack!==
      stack` there) processes the stack chunk by chunk, each chunk running a full-pool-parallel
      FTM-correction phase (`ftmChunkParallel()`, row-band split) to completion, THEN a
      full-pool-parallel detect/fit phase (the same frame-batch dispatch the non-FTM path uses,
      duplicated rather than shared to keep the non-FTM path provably untouched) to completion,
      before starting the next chunk's FTM phase — never both job types on the pool at once. This
      is required, not just faster: each worker has exactly one `onmessage` property, not a
      queue, so without the barrier an FTM-correction reply and a detect/fit reply could clobber
      each other's handler mid-flight. An earlier version ran chunk correction unconditionally on
      the main thread specifically to avoid needing this barrier — measured as the dominant cost
      on a fast fitter with large frames (~7.5s FTM vs. ~5.4s total detect/fit CPU on a
      256×256×1200 case, 8% worker utilisation); the barrier-phased version gets full parallelism
      for both phases instead. The timing log's `↑ N workers · X% utilisation` line covers the
      detect/fit phase only — its wall-clock denominator excludes the separately-reported FTM
      phase, or a run with substantial FTM time would look artificially starved.

    Both implementations must widen a chunk's context fetch beyond naive `coreStart±window/2`
    whenever the chunk's core range comes close enough to either end of the **whole stack** (not
    the Run's own `fitFirstFrame`/`fitLastFrame`) that a frame's own window gets clamped further
    than that naive padding accounts for — same clamp `ftmSeriesGlobal` applies per frame
    internally (`ftmFrame()`'s single-frame path already had this right; the chunked functions
    didn't, until a worker-vs-serial correctness A/B test caught the ~5%-photon-count-bias this
    produced for a stack's tail frames). Get this wrong and nothing crashes — the affected frames
    just get systematically undercounted photons, invisible unless you specifically compare
    against a known-correct reference.

    **Memory**: the barrier-phased loop's `ctxFrames` (raw context, dead once `ftmChunkParallel`
    returns `corrected`) must be explicitly dropped (`ctxFrames=null`, hence `let` not `const`)
    right after that call, not left reachable through the following detect/fit dispatch phase's
    own allocations (structured-clone `postMessage` per batch) in the same closure — `chunkmb`'s
    `/2` split only budgets for context+corrected coexisting, not context+corrected+in-flight
    batch clones too. Root cause of a real mobile OOM at `chunkmb=1000`; default is back to 500.
    `runCore()` also logs an estimated peak-MB figure (chunk working set, plus the already-cached
    stack's size if `memgb` let it cache whole — a *separate* budget stacking on top of `chunkmb`,
    not a shared ceiling with it) right after the chunk-size line, advisory above ~800 MB combined
    — gated on `memgb<=8` (its old ceiling; max is now 64 for workstation-scale caching) so a
    desktop user who's deliberately raised it isn't nagged every Run. This is visibility only: a
    mobile tab killed for memory pressure gets no JS-visible error at all (no exception, no
    `onerror`) — nothing here can detect or prevent that, only make a risky config visible before
    it happens instead of after.

  An earlier design ran FTM once over the whole stack up front and replaced `stack` itself; it
  was reverted because it needed the raw *and* corrected copies fully materialized in memory
  simultaneously, which doesn't work for a stack too big to hold both. All current paths avoid
  that by construction — bounded per-frame or per-chunk memory, never the whole stack twice.
- **simulation** — the built-in synthetic stack generator ("Simulate movie"): demo/validation/
  teaching data, not a core analysis path. Split out from in/out since it doesn't load anything.
- **detect** — per-frame band-pass, one of three filters selectable via `#detFilter`: à trous
  B-spline **wavelet** (default) or **DoG** (both thresholded by local maxima above `mean + k·σ`),
  or **uniform box filter** (difference of two box averages, thresholded by a plain intensity
  value + a σ_PSF-sized square dilation, per Huang et al. 2011). `detectSpots()` is the single
  dispatch point (used by both the main thread and workers) that picks the right band-pass +
  maxima function for the selected mode. Each filter's UI parameters are separate fields named
  `detection_<method>_<setting>` (e.g. `detection_DoG_thr`, `detection_box_thr`) shown/hidden by
  the sync IIFE keyed off `#detFilter` — don't reintroduce a single shared field across methods,
  their thresholds mean different things (k·σ multiplier vs. raw intensity).
- **fit** — phasor (fast, non-iterative), least-squares 2D-Gaussian, and Poisson-MLE 2D/3D
  (`gaussianMLE`/`gaussianMLEastig`, the default) localization. All four fitters take
  `gain,camoff` and convert every pixel to true photon units — `(raw-camoff)*gain` — before
  fitting, matching Picasso's architecture; position/width/ratio outputs are provably invariant
  to this affine transform (LS/phasor), while MLE's Poisson likelihood and CRLB (`lpx`/`lpy`)
  are only statistically correct when fit in photon units, so this is the one place gain/offset
  actually change a result rather than just rescaling it.
- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting.
- **workers** — frame-parallel detect/fit (see below).
- **export** — ThunderSTORM-compatible CSV. `photons`/`bg`/`bgstd` are already true photon units
  by the time they reach export (gain/offset are applied inside the fit, see **fit** above), so
  export/the table histogram do no further conversion — they still read `gain`/`camoff` only to
  log a "gain 1 / offset 0" warning when a user hasn't set real camera values.
- **3D calibration** — astigmatic: σ_x/σ_y vs z bead curves, JSON save/load. Astigmatism is the
  only method implemented; other 3D approaches (Double Helix, Biplane) would live here too.
- **drift** — AIM (adaptive intersection maximization), point-based, 2D+z.
- **locprecision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution,
  inline radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
- **sSMLM** — spectrally resolved SMLM: pairs 0th/1st-order localizations from a diffraction
  grating (ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer);
  Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022). `sSmlmCandidates()` enumerates same-frame
  candidates within a distance/angle window (angle mod 180° — undirected); `pairCore()`
  (`driftCore`-shaped) sorts by closeness to the expected angle and greedily accepts
  non-conflicting pairs. **2-point pairs only** (0th+1st) — multi-order chaining and FFT-based
  angle/distance auto-detection are `docs/REFACTOR_PLAN.md` follow-ups, not implemented; the
  interactive **Preview pairs** distance/angle histograms (reusing `computeHist()`/
  `drawHistogram()` from **table**) cover "find my window" instead. An unpaired localization is
  dropped from the result, not carried through unchanged. A pair's reported position is the 0th
  order's OWN x/y (undispersed — its centroid already is the true position), not the midpoint:
  the 1st order's offset varies per emitter with wavelength, so averaging would blur position by
  up to half that offset. Stores the inter-order distance in the paired loc's `z` — same trick the
  prior-art tool's own `ThunderSTORM.csv` output uses — so the existing `zcolor` depth-coded
  render path needs no changes (the **table** module relabels the `z` column to `dist` while
  `sSmlmOriginalLocs` shows pairing is active); **Pair** refuses if the current result already has
  real 3D `z`, and also sets `zmin`/`zmax` to the configured distance window (not the usual
  auto-fit) since every accepted pair's `z` already lies inside it by construction. Swaps
  `lastResult.locs` for the paired set, keeping `sSmlmOriginalLocs` as a backup — the same pattern
  **in/out**'s raw-panel crop tool uses for `originalStack`.
- **pipeline** — top-level orchestration wiring the UI buttons to the modules. Localize, drift
  correction and 3D calibration are each split into a DOM-free `*Core(config, stack, hooks)`
  function (`runCore`/`driftCore`/`calibrationCore`) plus a thin interactive wrapper
  (`run()`/`correctDrift()`/`runCalibration()`) that resolves DOM state into `config`, calls the
  core, then applies results back to globals/UI. `window.webSMLM.analyze(config)` — the headless
  entry point, v0.10.0 — calls the same cores directly with an explicit config and no DOM at all;
  `tools/webSMLM-cli.mjs` (Node + Playwright) drives `analyze()` from the command line, fully
  headless. New code belongs in the relevant `*Core` when it should also work headlessly (most
  analysis logic should); only DOM-reading/writing belongs in the wrapper. See
  `docs/DOCUMENTATION.md` §8 for the full headless API and `docs/REFACTOR_PLAN.md` for the design
  rationale (three-layer split: in-page API, CLI driver, URL-param autorun).
- **table** — the sortable, cumulatively-filterable localizations table ("View data + filtering")
  and per-column histograms. Committed filters set `renderLocs`, which drives the reconstruction
  live. The SR panel's crop tool (`cropBtn`, click two corners) is not a separate mechanism — it
  pushes an x/y-range clause into the same `_tableFilters` array a typed filter would, so
  reconstruction, export, NeNA and FRC all see a crop identically to any other filter. Typing
  `tempClusteringXY < 10` (nm) into the filter box is different in kind from an ordinary clause —
  it doesn't select a subset, it *merges* consecutive-frame detections of the same blinking
  molecule into fewer, higher-precision "events" (`clusterEvents()`), so it changes the BASE row
  set rather than which rows currently pass. `getBaseLocs()` is the single place that decides
  whether the base is raw `lastResult.locs` or clustered events; everything else (`_tableData`,
  `renderLocs`, export, NeNA, FRC) is unaware of the distinction and just consumes whichever it
  gets, the same loc-shape either way.

### Web Worker gotcha (read before touching detect/fit/workers)

Workers are **not** separate files. `workerSource()` builds worker code by calling `.toString()`
on the very functions the main thread uses, so detection/fitting logic exists once. Consequences:

- A worker gets a fresh global scope. Any module-level state a stringified function relies on must
  be re-declared in `WORKER_PRELUDE`, or the worker throws a `ReferenceError` and silently falls
  back to single-threaded. If you add a `let`/`const` at module scope that a detect/fit function
  reads, add it to `WORKER_PRELUDE` too (there is a runtime check listing `missing` names).
- Any helper a stringified function calls must itself be included in the `workerSource()` body.
- The same pool serves two unrelated message protocols: detect/fit's frame-batch dispatch
  (`d.frames`/`d.start`/…) and FTM's single-frame row-band preview (`d.ftmFrame`/`d.buf`/…) —
  `onmessage` branches on `d.ftmFrame` before falling into the detect/fit path. A new worker job
  needs its own branch and its own `d.<flag>` field, not a repurposed existing one. FTM's
  *other* use — `makeFtmStack()`, feeding `runCore()`'s Localize path — deliberately does **not**
  add a third message type: it runs its chunk correction on the main thread instead, precisely
  because `runCore()`'s own worker-dispatch can have several workers mid-detect/fit while a chunk
  fetch is in flight, and a third job type on the same pool would overwrite a busy worker's
  `onmessage` (one property, not a queue) out from under it. Don't "fix" this by giving chunk
  correction a worker branch without also solving that scheduling conflict properly.

### Left/right panel plot pattern

The left panel (`raw` canvas) doubles as a plot surface. To show a plot instead of a frame, set
`rawFull=null; rawIsPlot=true; rawPlotName=<kind>` and draw directly on `$('raw')`; call
`syncSaveImg()`. Calibration plots render on the right (`sr`) canvas via `srIsPlot`. Switching a
panel back to a frame/reconstruction (`drawRawView`/`drawView`) must clear any plot-only overlay
state so a stale plot can't paint over live pixels.

### Live preview (real-time detect/fit on the scrubbed frame)

`showFrame()` re-detects and re-fits whatever frame the raw-panel scrubber is on, so
switching detection/fit method or scrubbing shows results immediately without a full Run.
Two paths, chosen by the `#liveUpdate` checkbox:

- **checked** — reads the current UI controls live and calls `detectSpots()` fresh; this is a
  throwaway visualization, never written to `lastResult`/`locs`/`srFull`.
- **unchecked** — replays the *last full Run's* (or Calibration's) parameters from the cached
  `det:{sigma,k,win,border,exactBP,mode}` bundle on `lastResult`/`calib`, so the overlay matches
  what was actually localized rather than whatever the controls currently show.

Any control that affects detection/fit is wired into the live-preview listener array (search
for `.forEach(id=>{` near the settings-JSON code) — a new per-method parameter needs adding there
too, or changing it won't refresh the scrubbed-frame preview until the next full Run.

Both paths suppress the fit crosshairs (not the ROI boxes) outside `fitFirstFrame`/`fitLastFrame`
— `fitFrameRange()` is the single place deciding "in range" for both `showFrame()` and `runCore()`,
so scrubbing to a frame a Run would never touch can't show a misleading live-fit result there.

### Button label length

Sidebar/panel-title buttons must fit on one line at the sidebar's normal width — a label that
wraps reads as broken layout, not a design choice. Abbreviate rather than let a label wrap:
"Show dist. hist." not "Show distance hist." (see the sSMLM section's histogram-toggle button).
Favour standard, unambiguous abbreviations (`dist.`, `min`/`max`, `deg`) over truncation that
could be misread.

### Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

## Validating changes (no test framework)

There is no automated test suite. To sanity-check JS changes without a browser, use the local
JavaScript engine:

```sh
# Full-file syntax check: extract the largest <script> and parse it with new Function()
python3 - <<'PY'
import re
src=max(re.findall(r'<script[^>]*>(.*?)</script>', open('webSMLM.html').read(), re.S), key=len)
open('/tmp/app.js','w').write(src)
PY
osascript -l JavaScript -e "var s=$.NSString.stringWithContentsOfFileEncodingError('/tmp/app.js',4,null).js; try{ new Function(s); 'SYNTAX OK'; }catch(e){ 'ERR: '+e }"
```

Numeric additions (fit, NeNA, FRC, drift, calibration) are validated by extracting the specific
functions, stubbing their globals (`performance`, `log`, etc.), and running against synthetic
ground truth in the same `osascript -l JavaScript` (JXA) engine. JXA has no good JIT (~50–100×
slower than V8), so keep validation inputs small.

## Branch & release workflow

- **`main`** is live: it is served by GitHub Pages (`hohlbeinlab.github.io/webSMLM/webSMLM.html`)
  and archived on Zenodo. **`webSMLM_local`** is the dev branch — do work there.
- Only push to `main`, merge, or cut a release **when the user explicitly asks.** Release = commit
  on `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Cadence: **minor bumps (`0.x.0`) → cut a GitHub release + new Zenodo version DOI. Patch releases
  (`0.x.y`) → version bump + push to `main` only, no DOI.**
- Version lives in two spots in `webSMLM.html` (the `.pill` in the `<h1>`, and the `<noscript>`
  log-stamp line) plus `CITATION.cff`. Dev builds are marked `vX.Y.Z-dev · build YYYY-MM-DDx`;
  clear the dev marker to `vX.Y.Z · proof-of-concept` on release. **Bump the build letter suffix
  (`a`→`b`→`c`…) on every round of changes the user is about to test** — it's the only visible
  signal (pill + noscript stamp) that a hard-refreshed page is actually running the latest edits,
  not a cached prior build. **Every build-letter bump also gets its own commit on
  `webSMLM_local`** (no need to ask first — this one's a standing instruction), so each testable
  round has real git history, not just an accumulating uncommitted diff. This is independent of
  releasing: `webSMLM_local` accumulates fine-grained commits continuously; `main` only receives
  them in a batch, at an explicit release, per the cadence above.
- Every release also updates `CHANGELOG.md` (newest first; DOI column) and, where the release
  closes out or changes a roadmap item, `docs/REFACTOR_PLAN.md`. Pages typically redeploys ~1-2 min
  after a push; check with `gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`.

## Reference material

- `README.md` — user-facing feature list, performance figures, algorithm references.
- `docs/DOCUMENTATION.md` — detailed reference for every button/control/`PARAMS` entry, the
  on-disk file formats (settings/calibration/CSV JSON), and the headless API/CLI (§8) — the place
  to check or update for exact defaults, ranges and behaviour, complementary to the deliberately
  sparse in-app Help & guide.
- `docs/REFACTOR_PLAN.md` — forward-looking roadmap only; shipped-feature history lives in
  `CHANGELOG.md` instead. Think in version numbers, not "phases".
- `experimental_data/` — sample stacks (gitignored large files) with a README of public sources
  and their camera/pixel-size parameters.
- `tools/` — scripting/headless tooling for advanced users, not needed for interactive use:
  `webSMLM-cli.mjs` (Node + Playwright, true headless, the recommended one), `browser_sweep.py`/
  `browser-sweep.sh` (stdlib-only Python / bash, drive a real visible browser for a parameter
  sweep). See each script's header comment and `docs/DOCUMENTATION.md` §8.
