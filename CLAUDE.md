# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It describes the **current** state of the codebase and standing conventions, not how it got there.
Shipped-feature history (bug reports, rejected approaches, before/after numbers) lives in
[`CHANGELOG.md`](CHANGELOG.md) and the commit history; forward-looking ideas live in
[`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md). When you change something, update the relevant
paragraph here to the new current behaviour; don't append a "reported… fixed…" story.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM): the
whole application — HTML, CSS, JavaScript and the two bundled decoders (pako, UTIF) — lives in
`webSMLM.html` (~23,500 lines). It loads a raw movie, detects/localizes emitters and renders a
super-resolution image, **entirely client-side** (no upload, no server, no network calls at runtime).
`index.html` only redirects to `webSMLM.html` for the bare Pages URL.

`webSMLM.html` has **no build system, no package.json, no dependency install**. Running the app =
opening the file in a browser. Don't introduce a bundler, framework or npm dependency into the app;
new third-party code is inlined with its licence honoured in the head banner. `tools/` (Node +
Playwright CLI and test tooling, with its own `package.json`) is the one exception and stays outside
the app.

## CellField (microtubule cell field) = generated insiliscope block

The `'microtubules'` structure's world model (cells, nuclei, cytoplasm, packing, microtubules, dye
lattice) is **not** webSMLM code: it is the [insiliscope](https://github.com/kjamartens/insiliscope)
C++ core compiled to WASM, embedded in `webSMLM.html` (MODULE: simulation) as a generated block between
`// ==== BEGIN insiliscope CellField block ====` / `// ==== END ... ====` (module text + a thin wrapper
defining `const CellField`). **Never hand-edit the block.** To change the model, change insiliscope; its
CI ("webSMLM block" workflow) builds and publishes `cellfield_block.js`; bring it in with
`node tools/sync_cellfield.mjs <cellfield_block.js>` in a commit of its own (build-letter bump as usual).
`node tools/sync_cellfield.mjs --check [<block.js>]` verifies the embedded block's checksum (and that it
equals the given file). Full step-by-step (getting the CI artifact, ABI/call-site check, smoke test, commit
conventions) is in [`docs/CELLFIELD_SYNC.md`](docs/CELLFIELD_SYNC.md). The former `cell_field_sim/` prototype, its viewer and `DEMOCAM_PORT.md` live in
insiliscope now (`web/`, `web/prototype/`, `spec/`); there is no copy to keep in sync here.

## Editing model

All work happens inside `webSMLM.html`, organized by `MODULE:` banners. The top-of-file **MODULE
INDEX** lists each banner's line number; refresh it (from `grep -n "MODULE:"`) with every build-letter
bump. The code carries "why" comments at non-obvious decisions; the module notes below are a map and a
home for cross-cutting facts, not a substitute for reading the code.

**Comment style**: a comment says what the code does now and, briefly, why — units, conventions,
pitfalls; a rejected alternative only when it guards against an easy regression (one line). No
"reported/requested" stories, quoted user messages, "used to / tried first / reverted" histories or
before/after measurements (those go in the commit message and `CHANGELOG.md`); a verification note is
one line naming its test. Explain a piece of reasoning once, where the code it governs lives, and
point to it from elsewhere. Fix a comment the code has outgrown rather than appending to it.

**Standing rule — every actionable control calls one plain top-level function** (`run()`,
`correctDrift()`, `plotSmfretTraces()`, …), never real logic inlined in an anonymous listener. The log
terminal `eval()`s in the file's top-level scope, so every such function is callable from it; that is
what makes GUI and command-line use interchangeable.

### Modules

- **params** — `PARAMS` is the single source of truth for every analysis/render/export setting
  (`id → {label, min, max, step, default, int}`), read via `paramValue(id)`. It drives the controls
  (`syncParamControls()` writes min/max/step/value at startup), Save/Load settings and the headless
  `analyze(config)`; a new entry is available everywhere with no extra wiring. `id:null` entries have
  no control and resolve via `paramOverrides`. Types: `number` (default), `bool`, `enum`, and `text`
  (a raw string, e.g. `simulation_psfZernikeCustom`); every type-switch (`paramValue()`,
  `syncParamControls()`, `loadSettingsJson()`, `runAutorun()`) handles all four. Excluded: display/layout (CSS) and per-dataset working
  state (`calFirst`/`calLast`/`zmin`/`zmax`).
  - `addNumberSteppers()` wraps every `input.num` in `.numstep` with always-visible −/+ buttons
    (native spinners hidden), reading each field's own min/max/step and dispatching real events.
  - `pxnm` and `frametime` are pinned at the top of the sidebar (per-dataset acquisition properties);
    `gain`/`camoffset`/**Get estimate** sit at the top of **Localisation**.
  - No control label ends in "?". A disabled `select.sel` needs its explicit
    `{opacity:.45;cursor:not-allowed}` rule (its `color:var(--fg)` defeats native dimming).
  - Memory defaults: `memBudgetGB` (Total memory budget) is an opt-in ceiling (default Infinity),
    `memgb` (Budget raw movies) decides cache-vs-stream at load, `chunkmb` (Stream heap) sizes
    streamed chunks. On a memory-constrained device (`isMemoryConstrainedDevice()`: the *smaller*
    viewport side ≤ 860 px, so phones qualify in landscape) `MOBILE_MEM_DEFAULTS` substitutes 0.5 GB /
    0 / 250 MB (local override, never mutating `PARAMS`). `isMobileViewport()` (width only) is for
    layout.
  - `useGpu` defaults to **true** (each GPU stage falls back to CPU when unsupported or slower).

- **in/out** — TIFF/ND2/FITS loading. `loadTiffFile()` dispatch: FITS (magic "SIMPLE") → ND2 (magic
  `0x0ABECEDA`) → TIFF (require `t256`/`t257`: UTIF returns one empty IFD for non-TIFF bytes) →
  whole-file (`file.arrayBuffer()`) or streamed (`loadMultiIfdStreaming()`), split at
  `effSliceMin = min(~1.5 GB, readBudget())` (so `memgb=0` streams everything).
  - **BigTIFF** (magic 43, UTIF can't read it) always takes `loadMultiIfdStreaming()`, which reads
    both formats (8-byte offsets/counts, 20-byte entries); frame strips must be contiguous (checked
    on the first and last frame). Test: `tests/gpu/test-bigtiff.mjs`.
  - **Rotate movie** (`rotateMovie`, 0/90/180/270° clockwise, in "Memory, rotation, GPU & streaming"):
    `makeRotatedStack()` wraps the loaded stack like the crop wrapper (getFrames() only, no cache,
    90/270 swap w/h). `rotateNewStack()` applies the setting to every new load/simulation
    (`unrotatedStack`/`rotatedStack`); `applyMovieRotation()` re-wraps the current movie, drops a crop
    and clears all results (`clearAnalysisOutputs()`, then `presentStack()`, both shared with
    `loadMovieFiles()`). `analyze()` rotates before its crop. Live-streamed chunks aren't rotated.
    Test: `tests/gpu/test-rotate-movie.mjs`.
  - Multi-file selection (`loadTiffFilesAuto()`): first file has 1 frame → `loadTiffSequence()`
    (file per frame, natural-sorted); more → `makeConcatStack()` (one recording split by size). Files
    are filtered by magic bytes, not extension. The same path serves the file input, calibration and
    headless `files`/`calibrationFiles`.
  - Hints (logged, never applied): `tiffScaleHint()` (ImageJ pixel size only when `unit=` is
    micrometers, resolved value must be 1–100000 nm; `finterval=`), `mmMetadataHint()`
    (Micro-Manager tag 51123 JSON, `ifd.t51123.join('')`; frame interval from a 25-frame sample).
  - **ND2** (experimental, reverse-engineered, nothing ported from GPL readers): 16-byte chunk
    headers, `!`-terminated names, 4096-byte padding; `parseNd2LvField()` never uses a container's
    `byteLen` as a bound. **FITS** (experimental, camera-movie subset): row 1 is at the bottom, so
    output row `y` reads source row `h−1−y`.
  - Stacks may carry `residentBytes` (the decoded cache, for the memory guards and Mem readout;
    a getter on the streaming fallback). Not yet set by `loadTiffSequence()`/`makeConcatStack()`/
    `loadNd2File()`/`loadFitsFile()`. `framesTransferable` is set only on decode-per-call stacks:
    only those frames may be *transferred* to workers (a cached stack returns the same array every
    call; transferring it would detach the cache). Guarded by `tests/gpu/test-frame-cache-integrity.mjs`.
  - `makeCroppedStack()` (raw-panel crop) replaces `stack` with a sliced wrapper (original kept in
    `originalStack`), so nothing downstream needs offsets; crop bounds ride on the stack for logged
    commands (`cropCmdFields()`).
  - **FTM** (temporal median; controls in Localisation): scrub preview per frame
    (`ftmFrame()`/`ftmFrameParallel()`); Localize via `makeFtmStack()` (serial) or `runCore()`'s
    barrier-phased worker loop (FTM phase over the whole pool, then detect/fit, never both on the pool
    at once). Context windows clamp against the whole stack's ends. Output is floored at `camoffset`
    and stays in raw ADU space.

- **simulation** — "Simulate movie" and "Calib. 3D stack": synthetic movies with a known answer.
  Big enough for its own section: see **Simulation** below.

- **validation** — "Compare to GT" (`computeTruthScore()` → `scoreTruthCore()`, DOM-free, also
  `analyze({scoreVsTruth})`); config via `truthScoreConfig(cfg, det, run)` (frame size, the Run's
  detection border and frame range — `firstIdx`/`lastIdx`/`stopped` — so a restricted or stopped
  Run isn't scored as missing what it never looked at). Settings in `validationBox`
  ("Ground-truth comparison").
  - Matching is per frame, **lateral only** by default (`matchFrame()`/`gridNN()`), one-to-one
    within `validation_matchRadius`: matching on z would pair towards the flattering z and bias the
    axial error being measured, and it lets 2D and 3D share one path. Truth per frame is derived
    from `groundTruthEvents` with the simulator's own overlap rule (`groundTruthByFrame()`, carries
    `moleculeId`). Positions are compared before drift correction (`L.x0/L.y0`) against the drifted
    truth.
  - Three classes: *counted* (≥ `validation_minPhotons` that frame, outside `validation_border`),
    *don't care* (the rest, and every `haze` emitter: matched = neither TP nor FP, unmatched = not
    FN), and the counted hits/misses. **Match against all truth first, classify afterwards**
    (filtering first turns a real detection of a dim emitter into an FP). `minPhotons=0, border=0,
    crowdRadius=0` must reproduce the unclassified numbers exactly.
  - Headline numbers are **median and percentiles** (the axial error is heavy-tailed: the worst 1%
    of pairs can carry most of the sum of squares); gross axial failures are counted separately.
    Per molecule (`perMol`): recall, detections per molecule, averaged-position error. `effZ` = the
    widest contiguous z span with recall ≥ `EFF_Z_RECALL` (0.5, constant on purpose); the z bins
    count misses too (`zMiss`). It is a detection criterion, not the PSF's `zUsableNm`.
  - `validation_preset` (`webSMLM` | `challenge2016` | custom) writes `validation_matchMode`
    (`lateral` | `cylinder3D`), `validation_photonMode` (`absolute` | `quantile`),
    `validation_borderMode` (`dontcare` | `exclude`) and tolerances. `matchFrameCylinder()` is a
    separate matcher (full candidate list, ranked by 3D distance) — leave `matchFrame()` alone so
    the default numbers can't drift. `lateral` stays the default because the axial gate flatters
    the axial error.
  - Beyond position (per counted matched pair, `pr` arrays in `scoreTruthCore()`): Jaccard per z
    bin (FPs binned by FITTED z — they have no true one), `radiusSweep` (re-matches the stored
    per-frame `sweep` sets at 10–500 nm; the configured radius must reproduce tp/fp/fn exactly),
    `photometry` (fitted/true photons) and `crlbBins`/`precVsCrlb` (robust measured σ vs the median reported CRLB, per true-photon
    bin). These are measurements, not targets: never tune them towards 1. A
    Localisation gain/offset that differs from the simulated camera's is logged as a warning, since
    it shifts photometry and every CRLB figure.
  - `clearSimGroundTruth()` (from `clearAnalysisOutputs()`, CSV load, `resetAfterCropChange()`)
    drops the truth whenever the stack it describes is replaced, cropped or rotated.

- **detect** — `detectSpots()` dispatches one of three band-pass filters (`#detFilter`): à trous
  wavelet (default), DoG (both threshold `mean + k·σ`), or uniform box filter (plain intensity
  threshold + σ_PSF-sized dilation, Huang et al. 2011). Each filter has its own threshold field
  (`detection_<method>_thr`); they mean different things, don't unify them.

- **fit** — phasor (closed form), least-squares Gaussian, and Poisson-MLE spherical (default)/
  elliptical/rotated elliptical. All convert pixels to photons first (`(raw − camoffset)·gain`).
  - The three MLE fitters share `mleNewtonFit(n, th, mstep, clampFn, …, modelFn, fixed)` (as Picasso
    0.11's `_estimator_terms`); LSQ `gaussianFit()` is separate. Separable fast path for the
    spherical/axis-aligned models; the rotated model is point-sampled (as Picasso).
  - Convergence: x,y within `eps` (`PARAMS.mleEps`) **and** Newton decrement `λ² = g·d <
    MLE_CONV_DECREMENT_TOL` (0.05), from the raw pre-clamp step. The constant is duplicated as a
    literal in the four GPU fit kernels and `WORKER_PRELUDE`.
  - `fixed`: indices pinned by zeroing their Fisher row/column and gradient (reduced-system CRLB);
    used for the anchored background and the pinned angle, identically on the GPU.
  - Rejection: not converged; amplitude at its floor; σ pinned at `MLE_MIN_SIGMA`/`MLE_MAX_SIGMA`
    (0.5/6 px); position beyond `FIT_MAX_DRIFT_SIGMA_MULT` (2) × the *seed* σ_PSF (not the window
    radius). These constants are also in `WORKER_PRELUDE`.
  - `gaussianMLEellipticangled()`: fixed angle (from `sSmlmAngleCenter` when **3D localisation** is
    unticked) or free (7 params; seed split 1.05/0.95·σ0); optional `fixedBg` (seeded from second
    moments, `momentEllipseSeed()`) and `pinnedAngle`.
  - Aperture photometry: `apertureGeometry(win)` — signal disk `d ≤ r`, background annulus
    `r < d ≤ r+2.5`, 56th percentile (Martens et al. 2018 SI §S11; the SI's "ROI radius" is r+2).
    Used by `phasorFit()` (via `phasorApertureIntensity()`) and smFRET's `apertureIntensity()`.
  - Phasor has a GPU path with no accept/reject gate, so CPU/GPU counts match exactly; its overall
    Run speed-up is small (detection dominates) — report whole-Run numbers, not the fit stage alone.
  - `winr2d`/`winr3d` are the visible fields; hidden `winr` mirrors the active one
    (`applyWinrDefault()`, non-clobbering; dispatches `change` only on a real change).
  - The **Use GPU acceleration** checkbox sits in "Memory, rotation, GPU & streaming" (shared by fit, render,
    FRC).

  - **Excess noise F²** (`cameraExcessNoise`): `runCore()` hands every fitter `gain/F²` (fitting in
    F²-photon units, where EMCCD data is Poisson again) and `applyExcessNoise()` scales
    photons/bg/bgstd back by F²; positions are untouched, the CRLB widens by exactly F. Applied at
    every dispatch site that fits real data — worker, serial loop, live preview, GPU result loop
    (`makeGpuFitAccumulator()`; its seeds are packed with the already-divided gain). **A new fit
    dispatch path must do the same.** PCFO measures gain·F² on EMCCD data and warns instead of
    dividing.
  - PSF-model fitting (`psfmle`) and `detection_mergeRadius` live on the `psf_fitting` branch.

- **render** — accumulates locs into `srFull` (dense, O(W·H)); `view` is zoom/pan (zoom = CSS px
  per srFull px). Locs reach the renderer packed (`packSrLocs()`: Float64 x/y/colour/lpx/lpy,
  transferred to the render worker, no structured clone of loc objects); `srAccumulate()` is the
  one accumulator (whole image or a window), `srColorize()` the one colour map.
  - `renderMode`: `'fixed'` (default: bin + one blur `rblur`), `'precision'` (each loc splats its
    CRLB-sized Gaussian, integrated per pixel via `mleGInt()`, separable, σ capped at
    `MAX_SPLAT_SIGMA_PX`; live streaming starts in this mode), `'dither'` (stochastic, CPU only).
    The GPU kernels (`WGSL_RENDER_*`) must produce the same image as the CPU path; precision mode's
    float atomics use a CAS loop on purpose (fixed point biased pixels).
  - Memory: `estimateRenderBytes()` (whole image), `estimateReconBytes()` (the smaller of that and
    the viewport's, used by `runCore()`'s reserve and the Mem readout), `checkRenderSize()` throws
    before allocating (per-side `CANVAS_MAX_DIM` 16384; budget from `effectiveMemBudgetBytes()` —
    `memBudgetGB`, else 0.8 × the browser's reported heap limit, else Infinity). `renderSuperRes()`
    passes locs + `stackResidentBytes` as `reserveBytes` (a parameter, never the `stack` global,
    which `analyze()` shadows). `LOC_ROW_BYTES` (200) is the shared per-loc estimate.
  - **Viewport reconstruction** (interactive panel only, `allowViewport`): when `srRenderPlan()`
    says the image exceeds `CANVAS_MAX_DIM` or the budget, `srFull` becomes a plain object
    `{width, height, _viewport, overview, ovK, patch, norm, …}` — every srFull-px coordinate, the
    view, crop and measure tools work unchanged. `srRenderRegion()` evaluates the full render only
    at every k-th pixel of a rectangle, straight from the locs (bins, the `blurInto()` kernel with
    its mirrored edges via `srMirrorWeight()`, or splats): equal to the dense render's pixels up to
    float rounding, cost O(locs + samples) at any magnification. `overview` = whole image at stride
    `ovK` (≤ `SR_OVERVIEW_MAX` 4096/side); the display max comes from its samples. `patch` = the
    view ± ¼ at ≥ 1 sample per device px, requested `SR_PATCH_DELAY_MS` (150) after the last
    `drawView()` (`scheduleSrPatch()`/`requestSrPatch()`, one at a time), so pan/zoom only ever
    redraw bitmaps (60 fps measured at 16920×39000 px). The render worker keeps the packed locs
    (`vpInit`/`vpRegion` messages, `_rwVp`); no worker → main thread. Draw through `srDrawImage()`;
    export and line profile render their own region (`srViewportRegion()`). No GPU path. Test:
    `tests/gpu/test-viewport-render.mjs` (sampler vs dense render in every mode, display max, a
    30000-px-wide panel with its zoomed patch).
  - Magnification has no size cap in the panel; `analyze()` still lowers `cfg.mag` to
    `maxMagForFrame()` since `reconstruction.png` is one canvas. `mag` min is 1.
  - `rerender()` is async and serialized (one render at a time, latest request wins; `_srRenderSeq`
    discards stale results, also when `lastResult` was cleared mid-render). Previews
    (`isPreview`) never set zmin/zmax and don't log timing. On failure the previous image stays.
  - `setupPlot(cv, isPlot, ratio)` letterboxes plots (default 4:3; square for the polar plot;
    `null` = whole canvas, the smFRET trace); `canvas#sr,#raw{min-height:320px}` keeps plots usable at extreme frame aspects.
  - SVG export: `SvgRecordingContext` duck-types the Canvas2D subset the vector plots use. `arc()`
    only fills (stroke circles as polygons); no `closePath()` (close with `lineTo`); `save()`/
    `translate()`/`rotate()` push a fresh `<g>`.
  - UI theme (`applyTheme()`, dark/light/contrast, localStorage in try/catch) drives CSS variables;
    image overlays and the LUT list are theme-independent. `plotColors()` reads live theme colours;
    `_plotExportMode` switches to a fixed light palette for saved plots.
  - Every raw-panel plot dispatcher calls `hideOtherRawToggleBtns(exceptId)` (null when it has no
    toggle). `redrawRawContrast()` must not redraw while a plot or segmentation owns the panel.
  - Drift correction mutates positions in place, so `driftCore()` calls `destroyGpuAccumCache()`
    (the GPU cache keys on array identity + length).

- **workers** — frame-parallel detect/fit; see the Web Worker gotcha below. `getPool()`: up to
  `min(12, hardwareConcurrency)` workers, 2 on a memory-constrained device (each holds a cloned batch).
  A separate single render worker (`getRenderWorker()`, OffscreenCanvas) runs `renderSuperResPixels()`
  with its own `RENDER_WORKER_PRELUDE`. Both self-test on startup and fall back to single-threaded.
  Two more pools serve the simulator: the PSF pool (`psfWorkerSource()`/`getPsfWorkerPool()`: kernel
  planes, and `widthFit` for `psfUsableZRange()`) and the simulation pool (`simWorkerSource()`/
  `SIM_WORKER_PRELUDE`/`getSimWorkerPool()`: `simInit`/`simBatch` for movies, `calibInit`/`calibBatch`
  for bead stacks).

- **gpu** — WebGPU engine (experimental; probed once, disabled for the session on failure or device
  loss). `runStage()` picks CPU/GPU per stage and times both for the A/B table (`logStageTable()`).
  Fit batching: `makeGpuFitAccumulator()` (in `runCore()`) and `makeGpuFitSlotPool()` (lazy
  persistent slots); pipelines are cached as promises with explicit layouts. Kernel sizes come from
  the adapter's real limits; `tuneGpuWorkgroup()` measures the best workgroup size once per session.
  The free-angle rotated kernel needs `maxStorageBuffersPerShaderStage ≥ 7`. `WGSL_FRC_BIN`
  dispatches 2D (loc count can exceed 65,535 workgroups in one dimension). PCFO's tile FFTs
  (`pcfoTilePointsGpu()`, stage `pcfo`: mirror fill with the tile mean removed, batched row FFTs,
  per-tile transpose, masked power sum) match the CPU to ~1e-7; its jackknife is the exact
  O(n log n) `pcfoJackknife()`. Test: `tests/gpu/test-pcfo.mjs`. The simulator's two GPU stages
  (frames, PSF planes) are described under **Simulation**. WGSL strings can't share
  functions (e.g. `erfApprox()` is duplicated); no backticks or `${` in comments inside them.

- **export** — ThunderSTORM-compatible CSV (`buildCsvText()` returns ~5000-row `parts`, never one
  string). Optional columns appear only when a loc carries the field (`sigma_x/y`, `angle`, `x2/y2/
  pairAngle`, `sx0th…`, `sx_AA/sy_AA`, `cell_id/cell_area`, `track_id/D_coeff`). `analyze()` returns
  `csvParts` always and `csvText` only below `CSV_TEXT_MAX_CHARS`; `config.exportCsvRows` streams
  chunks via `onRecord('csv', …)` (the CLI always sets it). **The worker message protocol (15
  floats/loc) must be widened at all 3 sites together** — the worker's `out.push(...)` and both
  `wk.onmessage` unpack loops (plain pool and FTM barrier) — or a new per-loc field is silently lost
  on the worker path only.

- **3D calibration** — astigmatic σx/σy-vs-z bead curves plus the phasor magnitude-ratio model, JSON
  save/load; `calibrationCore()`/`runCalibration()` split, Stop discards everything (a partial
  z-range would bias the fit). "Fix bead x,y" (`locateBeadsForCalib()`) freezes positions from one
  composite.

- **drift** — AIM (point-based, 2D + z) or cross correlation (image-based, raw movie, no Localize
  needed), `driftMethod`; `driftCore()` restores raw coordinates (`x0/y0/z0`) before every estimate
  and applies corrections in place. Both support Stop (partial curve previewed, never applied).
  - AIM round 2 is **leave-one-out** (`subFrom`/`addTo`; deliberately differs from Picasso's
    `aim.py`), with `bestShift()`'s `best ≤ 0 → no shift` guard; segments are relative to `frame0`
    (the first frame present). The reference histogram is a dense grid (Map fallback, bit-identical).
  - `samplePct` ("Sampling (AIM & NeNA) %") is one shared control; AIM and NeNA each use their own
    seeded stream (`subsampleArray()`), floored at `AIM_SAMPLE_FLOOR`. FRC never subsamples (its
    resolution depends on density itself).
  - `correlationDrift2D()`: segment 0 is the fixed reference (no zero-mean re-referencing — smFRET
    relies on frame-0 anchoring); odd segment lengths are rounded up to even (`segFramesUsed`) because
    a period-2 ALEX alternation otherwise biases the correlation.
  - `drawDriftCurve()`'s green/magenta/blue palette is the app's reference pairing for two-curve plots.

- **locprecision** — NeNA (Endesfelder fit, `nenaPrecision()`) and FRC (`prepareFrc()`,
  `fft1d()` radix-4 port of indutny/fft.js, cached per N, power-of-two only, N 256–2048).
  Experimental. FRC pixel size: NeNA σ/2, else the mode of per-loc precision, else px/mag. `lastNena`
  feeds spt's "from NeNA" and resets on every load/crop.

- **sSMLM** ("(Caution!) Pairing for sSMLM or FRET") — pairs 0th/1st-order grating images (Martens et
  al., Nano Lett. 2022; port of HohlbeinLab/sSMLMAnalyzer). Roles by **direction**, not brightness:
  `sSmlmAngleCenter` is a signed bearing; a 0th-order candidate has an outgoing match on that bearing
  and none on the opposite one. Position = the 0th order's own; distance in `dist` (colour-by-
  distance). 2-point pairs only.
  - **Preview pairs** scans wide (0 to max(6000 nm, Distance max), angle 0±90°) and auto-fits:
    distance first (background PDF of random points in the locs' bounding box — rectangle, Philip
    2007 TRITA-MAT-07-MA-10 §4, often mis-cited as 1991; or disk, Solomon 1978 — plus a Gaussian,
    LM), then angle within that window (half-max width × 2). Distance min/max are capped at 10 µm
    (larger separations are channel matching's job).
  - The Angles view is a polar plot (0° right, CCW); distance markers and the angle diameters are
    draggable (the far end of a tolerance line folds to the near side, mod 180°).
  - `sSmlmPairContext` ('sSmlm'/'smfret') decides what a marker drag does: sSMLM rescales colours
    (`syncSSmlmZRangeFromDist()`), smFRET re-pairs and re-marks the SOI composite
    (`refreshSmfretPairingLive()`).

- **smFRET** ("(Caution!) Time traces and FRET", experimental) — sites of interest (SOI) from an
  averaged composite (`smfretSOICore()`, also `analyze()`'s `smfretLocateSOI`), per-site DD/DA/AA
  traces (`getSmfretTimeTraces()`), optional pairing and E(S).
  - **Analyse FRET** unticked disables only Pair DD + DA. **ALEX** (`alexEnabled`/`alexFirstFrame`)
    fixes frame parity; AA is read at the acceptor position once paired, else at the site.
  - Pairing methods: **Via distances and angles** (`getSmfretPairingFromDonor()`, sSMLM Preview +
    Pair on the donor-excitation composite, reading that section's Distance/Angle fields — the note
    `smfretDistAngleNote` under Pairing method links there, `openSSmlmSection()`; **Position donor**
    picks which of the two bearings points D→A) and **Via channel matching** (`alignSmfretChannels()`: x-gap split, displacement search,
    affine ICP; its matches are the pairing; shows a green/magenta alignment overlay). Paired sites are
    marked (never hidden) dark orange, AA-sourced matches gold. `smfretEnrichPairedWithAA()` adds
    AA widths (`sxAA/syAA`).
  - Extraction per frame: with Analyse FRET ticked the fit is automatic — distAngle pairing → rotated
    elliptical MLE with axes pinned to each site's D→A bearing; otherwise spherical MLE. Unticked →
    sidebar Fit method (spherical, LS, rotated elliptical) or aperture photometry. PSF from pairing
    (`smfretEstimatePsfFromPairing()`, `lastResult.smfretPsfEst`) seeds and gates each channel; it is
    not written into σ_PSF (that would re-run Localize SOI and drop the pairing).
  - **Background from annulus** (`smfretAnchorBg`, default on, CPU and GPU): background held at the
    annulus estimate plus one refinement pass (`apertureBackgroundMinusFit()`) — removes the σ↑/bg↓
    photon spikes of a free-background fit. Rejected fits report 0 (NaN only for an edge gap). Width
    gate 2× σ; aperture cross-check `SMFRET_AP_SANITY_MULT`/`NSIGMA`. Tests:
    `tests/gpu/test-smfret-anchored-bg.mjs`, `test-smfret-bearing-width.mjs`.
  - GPU batching (`smfretExtractTracesGpu()`, ≥ 500 candidates, not for LS/aperture) checks for
    device loss around every dispatch and logs the accepted count.
  - **Apply drift correction**: runs the configured drift method (AIM: a silent Localize pass,
    channels estimated separately under ALEX and merged per segment by point count; AIM output
    re-anchored to frame 0). Extraction reads `(x − fdx[f], y − fdy[f])`.
  - E(S): E = DA/(DD+DA), S = (DD+DA)/(AA+DD+DA); DD and DA each > 0 for fits (0 = rejected),
    only DD+DA > 0 for unfloored aperture photometry (`smfretDexValid()`, `signedIntensities`;
    E/S then shown on −0.5…1.5); AA paired with the adjacent
    frame under ALEX; Min/Max ranges per sample (Min AA default 1). 2D plot is hex-binned (viridis),
    with marginals. It shows in the SR panel; the toggle below it switches to the SOI composite
    (ALEX: DD+DA → AA → E/S).
  - The trace plot (raw panel) has intensity, E/S and width-vs-time plots on one time axis, plus ROI
    thumbnails (async, with staleness guards). It uses the whole panel (`setupPlot(cv,true,null)`):
    `.plot-tall` (min-height 480 px) and, for a tall frame, `aspect-ratio:1` while it's shown
    (`setRawPlot()` removes both); a wide panel (W/H ≥ 1.25) puts the thumbnails in a column right
    of the plots, else in a strip under the E/S plot. The x zoom/pan handlers read the plot range
    from `_smfretTraceGeom`. Intensities are `(raw − camoffset)·gain` on every path (fits and
    aperture), so the axis unit comes from the gain recorded on the traces (`smfretTraceUnit()`:
    photons, or ADU at gain 1; saved as `gain_photons_per_adu`/`intensity_unit`). **Plot traces** (`plotSmfretTraces()`) re-shows
    the in-memory traces; saved trace JSON loads via **Load data**. Save/load round-trips
    sigma arrays and ALEX parity.

- **spt** ("(Caution!) Single-particle tracking") — trackpy-inspired linking (`linkTracks()`:
  per-frame bipartite components via union-find, Hungarian assignment, greedy above
  `HUNGARIAN_MAX`=120), D per track `= MSD/(4·frametime) − locError²/frametime` from 1-step
  displacements (as the authors' sptPALM-Python pipeline), MSD cached so frametime/locError rescale
  without re-linking; ensemble MSD-vs-lag plot.
  - Tracks overlay: line width = `view.zoom` (one srFull pixel, never `mag·view.zoom`), clamped;
    the % sample draws once per track id over the full list (stable subsets).
  - Per-cell tracking (`linkTracksPerCell()`) takes `segLabels` as a parameter (headless-safe). The
    segmentation overlay scales by `pxnm/refPxNm` (refPxNm = pxnm at mask load).

- **pipeline** — Localize, drift and calibration are each a DOM-free `*Core(config, stack, hooks)`
  plus a thin interactive wrapper; `analyze()` calls the cores directly. New analysis logic belongs
  in a core when it should work headlessly. See `docs/DOCUMENTATION.md` §8.
  - `runCore()`'s `checkLocsMemory()` warns, then **stops** the Run (keeping partial locs) at a
    calculated reserve: budget − the following render − in-flight worker frame batches − the stack
    cache. It works through a shadowed `shouldStop`, so every existing stop check applies (also
    headlessly).
  - Never `delete` a property from hot, large loc arrays (V8 dictionary mode ~doubles memory); set
    `undefined`.
  - Raw preview during GPU-fit runs keeps a small ring of recent frames and shows the newest one
    whose fits are back.
  - `_sessionEpoch`: every long action captures `myEpoch = newEpoch()` and checks
    `staleEpoch(myEpoch)` before later writes (especially after an await); button re-enabling is not
    epoch-guarded.
  - Log: `log()` prose is marked `// ` (or `# ` in CLI style) and wrapped at 80 columns
    (`wrapCommentLine()`); multi-line messages use one `onLog()` with `"\n"` and a 2-space indent.
    `logCmd(config, jsOverride)` logs runnable commands (`jsOverride` for actions whose `analyze()`
    form would do more, e.g. `applyCropToRaw(...)`); `overrideWithFields()` puts the `$('id').value=`
    assignments on one line and the call on the next. Consecutive commands sit on adjacent lines.
  - The log terminal (`#logTerminal`, ≥ 2 lines tall) runs statements via direct `eval()`
    (`runTerminalStatement()`), with ↑/↓ history (navigates while a recalled entry is unedited).
    `resolveTerminalConfig()` backfills omitted PARAMS from live values and resolves filename strings
    to registered Files; `applyHeadlessResultToSession()` pushes an `analyze()` result into the page.
  - **Load data** (`loadFiles()`): movie, CSV, or JSON routed by its `format` field
    (`loadJsonFile()`: smFRET traces, settings, calibration; older files by their keys).
  - Hotkeys (`wireHotkeys()`, matched by `e.code`): Alt+1..0 action buttons, Alt+Shift+1..0 module
    sections, Alt+T terminal, Alt+P/F/S pixel size, frame time, panel layout (any Shift state).
  - `makeNavigator()` handles pan/zoom; click tools check `wasDrag()` so a pan doesn't plant points.
  - Mem readout (`updateMemReadout()`, polled): webSMLM's estimate, plus real heap/device RAM where
    the browser exposes them (not Safari). `maybeShowMemWarning()`: one pop-up per page load on
    constrained devices.
  - Open issue: a "crop zoom reverts" report remains; `refitCanvases()` logs a temporary diagnostic
    naming the trigger when it discards a non-fit view. Remove once explained.

- **liveStreaming** (`window.webSMLM.liveStream`, experimental) — chunks from a Micro-Manager bridge
  (`tools/webSMLM-livestream-bridge.mjs` via `#liveStreamChunkInput`, or an opt-in outbound
  WebSocket) are each localized by `runCore()` and appended; the first chunk arms a session, the
  top-level Stop ends it. No FTM. New table filters and crops are refused while streaming.

- **table** — "View data/filtering": column-oriented (`tableColumnInfo()`, `tableColumnValue()`,
  `tableRowFromLoc()` only for the ≤ `TABLE_CAP` shown rows; `topKSorted()` instead of full sorts), so
  10M+ locs stay workable. Filters are `(L, i) => bool`; `parseFilter(str, cols, valueOf)` is shared
  with the track table. The SR crop tool pushes an x/y clause into the same `_tableFilters`.
  `tempClustering(XY|Z|Memory)` clauses change the base row set (`clusterEvents()`,
  `getBaseLocs()`). Filters are logged as the full cumulative list; `tableFiltersCore()` replays them
  headlessly. `checkTableSize()` uses `TABLE_FILTER_ROW_BYTES` (32). `clearTableState()` empties
  and closes both tables (data, filters, rows, `renderLocs`); every action that discards or
  replaces the locs calls it (load, rotation, crop, simulation, Localize, pairing, tracking, CSV/
  headless load, streaming). Test: `tests/gpu/test-load-clears-state.mjs`. `commitSrCrop()` awaits the
  filtered render before zooming; the crop rectangle is drawn first, with a `tick()` so it paints.

## Simulation (MODULE: simulation — what "Simulate movie" does)

Demo/validation/teaching data, not a core analysis path, but everything **Compare to GT** relies
on. User walk-through: `docs/DOCUMENTATION.md` §2, "Simulation guide".

**Sidebar**: top level = Structure type, Frames, Emitter density preset, Physics detail preset,
then a 2×2 `.btnrow` (`simToolsRow`: Preview PSF, Calib. 3D stack, View ground truth, Compare to GT — disabled,
never hidden, when unavailable: `updatePsfModelUI()`, `setViewGtBtn()`); sub-groups Sample (incl.
Move view below Focus height, microtubules only) / Fluorophore / Background / Camera / PSF /
Ground-truth comparison (headers upper case, accent triangle). Rarely changed settings sit in their
own sub-group below a plain `.simsec` divider line (Sample, Background, Camera, PSF; PSF also has a
labelled "Performance" divider; `advPsfHead`/`advPerfHead` show with the Zernike model).
**Aberration preset** sits at the top level (between Frames and Emitter density), shown with the
Zernike model. Labels that
need a fixed break use `<span>…<br>…</span>`. Every `label.row` in `simBox` has a `title` hover tip — keep it that way.
A sidebar label and its PARAMS `label` are the same string; only fields that collide with an
analysis-side label carry a "Simulated" prefix. The PSF phase-mask rows are hidden
(`SHOW_PSF_PHASE_MASK=false`); their PARAMS and code path stay.

**Pipeline** (`runSimulation()` → `generateSynthetic()`), in order:
1. **Structure**: `buildStructure(structFov, structFov, zRange, rng)` dispatches on
   `simulation_structureType` — `microtubules` (default), `nup`, `filaments_ring`, `tiltedPlane`,
   `uniform3D`, `shell` — each returning `[x,y,z]` sites (camera px, nm). It always builds in 3D and
   flattens z to 0 when `simulation_3d` is off (default on, no sidebar control; settings JSON /
   `paramOverrides` only): don't reintroduce a separate 2D path. A new structure is one more case.
2. **Structure FOV**: `structFov` = `round(1.1·simulation_fov)` unless `simulation_structureFov` is
   explicitly overridden (no control), recentred by `(structFov−w)/2`, so drift brings structure in.
   Every out-of-frame consumer is bounds-safe. `dens`'s area is the structure's: density is a
   property of the sample.
3. **Labelling**: `simulation_labelEfficiency` is one seeded keep/drop over the sites, before blinking.
4. **Molecules** (`spawnMolecules()`): Poisson activation at `dens·area/(lifetime·meanBlinks)` —
   **`dens` must keep meaning mean emitters ON per µm² per frame under any kinetics**; ON ⇄ dark →
   bleached (`simulation_blinkBleachProb`, `simulation_offLifetime`), log-normal per-blink brightness
   (`simulation_photCV`). Illumination (`buildSimIllumination()`, **peak 1**, so `phot`/`simbg` are
   beam-centre values) is folded into `bright` once per emitter, which feeds both the frame and the
   truth's rate, so the two cannot disagree.
5. **Out-of-focus emitters** (`simulation_hazeRatio` > 0, Zernike only): a second blinking population
   from `max(zUsableNm,300)` to `simulation_hazeDepth`, through the ordinary kernel-stack splat;
   flagged `haze`, never scored.
6. **Background**: `simbg` stays the field **mean**; `buildSimBackgroundMap()` (cell ellipse + static
   haze, normalised to that mean) and `simBgScale()` (fade to a 30% floor) only reshape it; the
   illumination attenuates it without renormalising. Cell contrast is forced to 1 for
   `microtubules` (its ellipse is not the CellField's cells) and the field is disabled.
7. **Frames**: `simulateFramesParallel()` (sim pool) / `simulateFramesSerial()` / GPU
   (`runStage('simFrames', …)`), all through `splatSimFrame()` + `applySimCameraNoise()`.
8. **Camera** (one `cam` bundle from `readSimCameraModel()` through `simCtx`/`calibCtx`, both init
   messages and the GPU spec): sCMOS = Poisson → read noise (e⁻) → gain → fixed per-pixel offset map;
   EMCCD = QE + CIC → Poisson → `simNoiseGamma(n)` (scale 1) → read noise / EM gain. Both end in
   integer ADU clipped at 2^bits−1 (`simulation_bitDepth`), CPU and GPU alike.
   **Save sim. movie** (`saveSimulatedMovie()`): `simSaved` (set by Simulate movie / Calib. 3D stack,
   cleared by `clearSimGroundTruth()`) → `encodeTiff16()` (MODULE: export: uncompressed 16-bit, ImageJ
   description + resolution, BigTIFF past 4 GB) and `buildGroundTruthCsv()` (per emitter-frame via
   `groundTruthByFrame()`, drift added). Test: `tests/gpu/test-save-sim-movie.mjs`. **Poisson∘Gamma has variance 2λ — that is the √2 excess noise**, not a fudge;
   scale 1 keeps `simulation_gain` meaning photons/ADU.
9. **Ground truth**: `groundTruthEvents` (per blink: x, y, z, times, photons, `moleculeId`, `haze`),
   `simTrueDrift` (nm), `groundTruthLocs` (non-haze blinks with a fixed 1 nm `lpx/lpy`, so View ground truth
   renders crisp points in every render mode). `runSimulation()` clears `zmin`/`zmax` (else GT depth
   colour inherits a previous dataset's range) and drops the truth when **Rotate movie** is set
   (truth is in unrotated coordinates).

**PSF** (`simulation_psfModel`, `'zernike'` default; `'gaussian'` = fixed σ = 1.3 px, no z):
- Gibson-Lanni pupil + Zernike (`PSF_NZERNIKE`=28, n≤6; a 15-value custom string is zero-padded)
  + optional phase mask (`pupilMaskPhase()`: double helix as the phase of a Gauss-Laguerre
  superposition along l=2p+1, Pavani & Piestun; `laguerreL`+`pupilMaskPhase` are in
  `psfWorkerSource()`'s list).
- **One evaluator: chirp-Z** (`computePsfPupilCartesianForZPlane()`, `computePsfIntensityPlaneFFT()`,
  `psfCzt1d()`), with everything z/row-independent hoisted (`psfCztPlan()`, `psfPupilPlan()`;
  bit-identical to unplanned, ~3× faster). A 40-angle polar quadrature aliased beyond ~1.6 µm and
  dimmed every emitter ~17–20% on the 6 µm kernel: **don't reintroduce one** without an angular
  count that grows with the kernel radius. `tests/gpu/test-sim-gpu.mjs` pins the tail to Airy.
- GPU path `gpuPsfPlanes()` (same `useGpu` rule, falls back to the PSF pool): pupils composed on the
  CPU, the transform's defining sum as two dense matrix products (`WGSL_PSF_ROWS`/`WGSL_PSF_COLS`),
  ~1e-6 of peak from the CPU. The kernel cache key includes `useGpu`.
- `buildPsfKernelStack()`/`getOrBuildPsfKernelStack()` (cached) reports `zUsableNm` (single-valued
  width-ratio range; `psfUsableZRange()` fits planes with `gaussianFitElliptical()` on the PSF pool)
  and `psfZCramerRao()` (Fisher [x,y,N,bg,z], N and bg marginalised) — the PSF-agnostic yardstick
  (`zUsableNm` is meaningless for a double helix).
- Engineered presets `saddlePoint`/`extendedRange`/`extendedRangeStrong` stack astigmatism at
  j=5/13/25 (check with `psfIndexToNM`); **not called tetrapods** (no four-lobe shape).
- **3D placement = nearest kernel plane** (±½ z step; 2.9 nm RMS at 10 nm). A two-plane intensity
  blend is not a width interpolation: **don't reintroduce it** without a width-aware one.
- **Splat** (`splatZernikeEmitter()`, `simulation_psfInterp` nearest/linear/cubic(default)/fft): all
  os×os sub-cells of an emitter share one set of interpolation weights, so "interpolate each, then
  SUM" (sum: probability mass) = "sum each block once (`buildSummedKernel()`), interpolate once per
  camera pixel". `simSplatSetup()` computes indices/weights once, shared with the GPU packer; block
  sums are Float32; only planes an emitter uses are prepared (`prepareSimKernelPlanes()`, sparse).
- **Preview PSF** toggles (`previewPsf()`/`closePsfPreview()`): swaps the Frame slider for a z-plane
  slider and stashes the movie's contrast; any real frame draw, raw-panel plot or new stack leaves it.

**GPU frames**: `WGSL_SIM_FRAMES` fuses splat and noise, one thread per (pixel, frame), gathering the
frame's emitters in list order (no atomics, the CPU's summation order); batches ≤ 64 MB, k+1 packed
before k is read back; `simulateFramesGpu()`/`simulateCalibFramesGpu()` over one `gpuSimFrames()`.
Taken whenever `useGpu` is on (no threshold); not for 'fft' placement or the Gaussian model.
Measured 4–17× over 8 CPU workers on an Iris Xe (`bench-simulation.mjs`).

**Randomness and the byte-identity rule.** Emitters/events: `mulberry32(simulation_seed)` (0 =
unseeded); background and haze each draw from their own seed-derived stream after all emitter draws,
so switching them on never moves an in-focus emitter. **Camera noise is counter-based**
(`makeSimNoiseRng()`: pcg4d over noise seed, frame, pixel, counter), so any worker, batch order or GPU
thread gives the same pixel; `simNoiseGauss`/`Poisson`/`Gamma` exist once in JS and are mirrored line
for line in `WGSL_SIM_NOISE_FNS` — change one, change both. New random draws go only in branches the
old defaults never enter (the original single-blink loop is kept beside the new one for that). With
Physics detail = Basic, every newer field at its old value (structure `filaments_ring`,
`simulation_3d=false`, 300 frames, `dens` 0.05, flat illumination, z range 1000) and
`paramOverrides.simulation_structureFov` = `simulation_fov`, a seeded movie is byte-identical to the
counter-noise baseline (build 2026-09-21b). Re-check with a pixel hash after touching any of it.

**Presets write parameters, never replace them** (`wirePreset()`): `simulation_realism` (Physics
detail: Basic/Realistic/Full), `simulation_densityPreset` and `validation_preset` push values into
ordinary controls; an edit that differs flips them to `custom`, so `paramValue()`/settings JSON/
`analyze()` never need to know presets exist.

**Structures.** Filaments + ring: one sine drives y and z (a z error looks like a y error), and 1-D
crowding inflates lateral spread ~50% — quote accuracy from `uniform3D`. NPC
(`buildNupAttachmentPoints()`/`displaceByLinker()`/`buildNupLocalPoints()`/`buildNupStructure()`):
Nup96-SNAP (Thevathasan et al. 2019; parametrised as in CIR4MICS, Wanninger et al. 2023): 8 corners
× 4 copies on a half-circle arc (`NUP_CORNER_ARC_ANGLES`) × 2 rings = 64 sites, linker displacement
uniform in volume, pore axis along z with a gentle curvature bowl; only `simulation_nup_count` has a
control (geometry via settings JSON/`paramOverrides`); uses the seeded stream. Microtubules:
`buildMicrotubuleStructure()` → `CellField.buildWindow()` (see **CellField**), clipped to
±`simulation_zRange` around `simulation_mt_focusZ`, consuming nothing from the movie's `mulberry32`
stream. `simulation_mt_seed` 0 (default) = random per movie (`resolveMtSeed()`, logged). `mtStartPosition()`
gives each seed a fixed start: origin if a 3×3 probe of 2 µm sub-windows hits dyes in ≥5/9, else the
first such of 16 candidates from `mulberry32(seed^const)` within ±500 µm (best otherwise); depends on
the cell-field seed + settings only, ~1 s/try, cached; origin-first keeps already-covered seeds (1249)
unchanged. `simulation_mt_x/_y` (no control) are an OFFSET from it, moved with `moveMtViewStep()` →
`moveMtView()` (+y down, logged); seed below the Sample section's divider.

**Around it**: `toggleGtLocalizations()` swaps `srFull` directly (stashing the previous one and its
title/info, since `lastResult` is null before a Localize) and mirrors `rerender()`'s depth-colour
logic (auto-tick, `turbo`, cached `_zr`, `srFull._zColor`). `runCalibrationSimulation()` renders a
bead z-stack (`generateCalibrationStack()`, focus on the centre frame by construction), resets via
`clearAnalysisOutputs()`/`presentStack()`, and writes `calStep`/`calRef`; it is not rotated.
Simulate movie logs every non-default `simulation_*` field with `runSimulation()` so a recalled
command reproduces the movie. There is no headless generator (`analyze()` can only `scoreVsTruth`).

## Web Worker gotcha (read before touching detect/fit/workers)

Workers are built from the main thread's own functions (`workerSource()` stringifies them), so the
numerics exist once. Consequences:

- A worker has a fresh global scope: module-level state a stringified function reads must be
  re-declared in `WORKER_PRELUDE` (a runtime check lists `missing` names; otherwise the worker throws
  and the app silently runs single-threaded). The render worker has its own `RENDER_WORKER_PRELUDE`.
- Every helper a stringified function calls must be in the `workerSource()` body.
  `fft1d()` needs its radix-4 helpers and per-N cache: include `fftWorkerSource()`, never
  `fft1d.toString()` alone (the sim and PSF pools do).
- One pool, several message types (frame batches, FTM preview, FTM chunk, GPU detect), branched on a
  `d.<flag>`. A worker has one `onmessage`, not a queue: never put two job types on the pool at once
  (hence FTM's barrier phases).
- The worker source is a template literal: no backticks in comments inside it.
- The same holds one layer up for **explicit field lists across a postMessage**: the PSF worker and
  `buildPsfPlanesParallel()` spell the optical parameters out by hand (not `cfg`), so a new PSF
  parameter goes on both ends or pooled kernels silently ignore it (this once built every
  double-helix kernel unaberrated: six mask settings gave the same z-CRLB — the tell). Same for
  `simCtx`/`calibCtx` and for the helper lists of `simWorkerSource()`/`psfWorkerSource()` (a missing
  noise, mask or FFT helper kills the pool with a ReferenceError). When a physics result says a
  setting "does nothing", first check the setting reached the model.

## Left/right panel plot pattern

The raw (left) canvas doubles as a plot surface: set `rawFull=null; rawIsPlot=true; rawPlotName=…`,
draw on `$('raw')`, set `_replotRaw`, call `syncSaveImg()`. SR-panel plots (calibration, E/S) use
`srIsPlot`/`_replotSr` and `srTitle` identifies them. Returning to a frame/reconstruction
(`drawRawView`/`drawView`) must clear plot-only overlay state. A change that redraws a panel must
replot a plot rather than blank it (e.g. the Pixel size handler).

## Live preview (real-time detect/fit on the scrubbed frame)

`showFrame()` re-detects/re-fits the scrubbed frame. **Real-time update** checked: live UI values,
throwaway. Unchecked: replays the last Run's (or Calibration's) `det` bundle. A new detection/fit
setting must be added to the live-preview listener array (search `.forEach(id=>{` near the
settings-JSON code).

## UI conventions and CSS gotchas

- Every module header (`summary`), sidebar control row and button has a short `title` tooltip (one sentence: what it does,
  units, the key trade-off); the section's "more info…" hint carries the detail.
- Sidebar/panel buttons fit on one line; abbreviate rather than wrap. Compact labels read
  `Word/word` (**Save plot/image**, **View data/filtering**).
- An indented sidebar sub-row must be a **direct child** of its `details.sim`
  (`details.sim>*:not(summary)` gives the 14px indent), with `padding-left:40px` for the extra step.
  No right padding is needed: value controls and buttons share one right edge.
- Form controls need `font-family:inherit` (browsers default them to e.g. Arial).
- `select.sel` has an explicit `height:25px` (matches `input.num`); `html{text-size-adjust:100%}`
  stops mobile text autosizing. Below 860 px, inputs are 16px (no iOS zoom) while labels stay 12px.
- Checkboxes are CSS toggle switches on the real input; the knob's `::before` needs its own
  `box-sizing:border-box` (the `*` reset doesn't reach pseudo-elements).
- Slider thumbs are 10px; `DUALRANGE_THUMB_PX` (three JS copies) must match.
- Resting borders are colour-matched to their background; value inputs keep a visible
  `var(--line)` border; the canvases have none.
- A `getBoundingClientRect()` value feeding a `position:fixed` offset must add `window.scrollY`
  (`measureHeader()`).
- A real window/panel resize re-fits the views (`refitCanvases(which)`), regardless of `atFit`;
  its `ResizeObserver` watches the two canvases, not their container, and re-fits only the canvas
  that changed (the taller time-trace panel keeps the reconstruction's zoom); window resize and the
  layout toggle re-fit both.
- With the sidebar hidden on desktop, `.main` gets a matching left padding
  (`@media (min-width:861px){ body.side-hidden .main{padding-left:12px} }`).
- Never put a `<noscript>` inside an element whose `.textContent` is written.
- Log box: `#log` is the scrolling box (fixed 236px = 12 lines), `#logText` the text (80ch).
- Leading unary `**` is a SyntaxError: write `-((x-d)**2)`.

## Validating changes

- Syntax check without a browser:
  ```sh
  python3 - <<'PY'
  import re
  src=max(re.findall(r'<script[^>]*>(.*?)</script>', open('webSMLM.html').read(), re.S), key=len)
  open('/tmp/app.js','w').write(src)
  PY
  node -e "new Function(require('fs').readFileSync('/tmp/app.js','utf8')); console.log('SYNTAX OK')"
  # macOS without Node: osascript -l JavaScript -e "var s=$.NSString.stringWithContentsOfFileEncodingError('/tmp/app.js',4,null).js; try{ new Function(s); 'SYNTAX OK'; }catch(e){ 'ERR: '+e }"
  ```
  A syntax check doesn't catch an undefined identifier: after a merge, also click Simulate movie →
  Localize → Compare to GT → View ground truth in a real browser.
- Simulation: `tests/gpu/test-sim-gpu.mjs` (CPU/GPU agreement, noise statistics, PSF tail; the CPU
  half runs without WebGPU), `tests/gpu/bench-simulation.mjs`, a seeded pixel hash for the
  byte-identity rule, and `node tools/sync_cellfield.mjs --check`.
- `tests/gpu/*.mjs` (Node + Playwright, installed via `tools/`; see `tests/README.md`): correctness
  tests (`test-*.mjs`, e.g. foundation, gpu-correctness, frame-cache-integrity, frc-gpu, smFRET) and
  benchmarks (`bench-*.mjs`); `node tests/gpu/run-suite.mjs [--only=…]` or
  `npm --prefix tools run gpu:all`. Run the relevant ones after touching fit/render/GPU/smFRET code.
- Numeric additions: validate against synthetic ground truth (extracted functions in JXA are fine
  for small inputs; JXA is ~50–100× slower than V8).
- Interactive/visual checks: Playwright (Chromium bundled; `npx playwright install webkit` for a
  Safari-like check). Throwaway scripts go in the scratchpad or `tools/` prefixed `_tmp_`, deleted
  afterwards, never committed. For UI timing, measure real paints.

### `micromanager_plugin/webSMLM_Streaming` (Java) — rebuild locally to test, never commit the jar

Editing a `.java` file does not update `target/webSMLM_Streaming.jar`; rebuild before testing:

```sh
mvn package -Dmm.install.dir="C:\path\to\your\Micro-Manager-install"
```

(requirements in the plugin's README: MM 2.0, JDK 11+, Maven 3.6+; without `mvn`, use `javac`/`jar`
with the jars `pom.xml` lists). Confirm the jar contains the change (`jar tf`/`javap`). `target/` is
gitignored; distribute jars via a GitHub Release asset.

## Branch & release workflow

- **`main`** is live (GitHub Pages `hohlbeinlab.github.io/webSMLM/webSMLM.html`, archived on
  Zenodo). **`webSMLM_local`** is the dev branch — work there.
- Push to `main`, merge or release **only when the user explicitly asks.** Release = commit on
  `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Minor bumps (`0.x.0`): GitHub release + new Zenodo DOI. Patch releases (`0.x.y`): version bump +
  push to `main`, no DOI.
- The version lives in the `.pill` in `<h1>`, the version `log()` line near `applyTheme()` (update
  its text on every build bump) and `CITATION.cff`. Dev builds read `vX.Y.Z-dev · build
  YYYY-MM-DDx`; on release clear the marker to `vX.Y.Z · proof-of-concept`.
- **Bump the build letter (`a`→`b`→…, past `z`: `aa`, `ab`…) on every round the user will test**, and
  **commit each bump on `webSMLM_local`** (standing instruction, no need to ask). Same round: refresh
  the MODULE INDEX line numbers.
- Every release updates `CHANGELOG.md` (newest first; DOI column) and, where relevant,
  `docs/REFACTOR_PLAN.md`. Pages redeploys ~1–2 min after a push
  (`gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`). Read the Docs rebuilds on every push to
  `main` via a GitHub webhook (id `669780136`); check its Builds page or the live site.
- Push `webSMLM_local` to origin regularly (backup); this never requires asking.

## Reference material

- `README.md` — launch, the 5-step guided workflow (kept identical to the in-app Quick guide's),
  data/privacy, scripting, roadmap, citation, licence.
- `docs/DOCUMENTATION.md` — every control/`PARAMS` entry, file formats, the headless API/CLI (§8),
  algorithm references (§9); §1 maps GUI controls to terminal functions.
- `docs/REFACTOR_PLAN.md` — forward-looking roadmap only (think in version numbers, not phases).
- `CHANGELOG.md` — per-release log with settings, numbers and rejected approaches: the place for
  "why did we build/change X".
- `experimental_data/` — sample stacks (large files gitignored) with sources and camera parameters.
- `tools/` — `webSMLM-cli.mjs` (headless, recommended), `browser_sweep.py`/`browser-sweep.sh`
  (parameter sweeps in a visible browser), `sync_hints.mjs`, `sync_cellfield.mjs`, the livestream
  bridge.
- `docs/design/` — design memos written while building the simulator (PSF sampling, the Zernike
  implementation brief, a demoCam parity snapshot). Historical; not kept in sync with the code.
  (`docs/CELLFIELD_SYNC.md`, the CellField sync procedure, is current.)

## Documentation build

- `docs/DOCUMENTATION.md` is the only authored source of the Read the Docs manual (Sphinx + MyST).
  `docs/readthedocs/build_docs.py` splits it at each `##` heading into pages and builds the index;
  generated files (`docs/readthedocs/content/`, `index.md`, `_build/`) are never edited or
  committed — fix the source or the script. Images live in `docs/images/`. Local strict build:
  ```
  python docs/readthedocs/build_docs.py
  python -m sphinx -W --keep-going -b html docs/readthedocs docs/readthedocs/_build/html
  ```
- **In-app "more info…" popups** (`.hint` divs, `id="hint-<name>"`) are synced from
  `<!-- HINT:<name> --> … <!-- /HINT:<name> -->` markers in `DOCUMENTATION.md` (raw HTML, after each
  §2 PARAMS table). Edit only the marker, then run `node tools/sync_hints.mjs` (`--check` for a
  drift check). The `module: X` pill is fixed markup. The 16 hints: `hint-memory` (incl. live
  streaming), `hint-simulation` (top-level rows + overview) + five sub-group hints (`-type` = Sample
  incl. the NPC model, `-fluorophore`, `-background`, `-camera`, `-psf`; each covers the rows below its
  sub-group's divider too), `hint-pcfo`, `hint-calibration`, `hint-detectfit` (incl. gain/offset),
  `hint-render`, `hint-drift` (incl. NeNA/FRC), `hint-validation`, `hint-sSMLM`, `hint-smfret`,
  `hint-spt`. A popup's paragraph order follows its sidebar's field order.
- **Quick guide** (`helpBtn`) is thin, hand-authored UI copy: intro, the 5-step Guided workflow,
  Acknowledgements, Licence & author. `README.md`'s Guided workflow is a copy; update both together.
