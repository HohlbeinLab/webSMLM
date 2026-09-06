# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (growing past 10400 lines; the file's own top-of-file **MODULE INDEX**
comment gives current per-module line numbers — re-`grep -n "MODULE:"` if it looks stale, and
refresh it alongside a build-letter bump when a change has moved things by more than a few
lines). It loads a raw TIFF stack, detects/localizes emitters, and renders a super-resolution
image, **entirely client-side** (no upload, no server, no network calls at runtime). `index.html`
is just a redirect to `webSMLM.html` for the bare Pages URL.

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

  `addNumberSteppers()` (runs once, right after `syncParamControls()`) wraps every `input.num` in a
  `.numstep` span with an appended `.numstep-btns` −/+ pair — Inkscape-style, always visible, not
  the browser's native number-input spinner (tried first; reverted — look varies across engines,
  and it's hover-reveal only, unreachable on a touchscreen). Reads each input's already-present
  `min`/`max`/`step` (set by `syncParamControls()` for `PARAMS`-mapped fields, or static HTML
  attributes for the ones `PARAMS` excludes), so any current or future `.num` field gets steppers
  for free with no per-input wiring. Clicking dispatches real `input`/`change` events, so every
  existing listener reacts exactly as it would to typing. `input.num` is left-aligned (not right)
  and narrower (64px) — value first, then the control that changes it.

  **Trailing "/N" text next to a numstep-wrapped field needs its own `vertical-align:middle`.**
  `.numstep` is `display:inline-flex;align-items:stretch;vertical-align:middle`, so it renders
  TALLER than a plain text baseline — a plain `<span>` right after it (e.g. the Frame scrubber's
  `#scrubTotal`, "/ total frames" next to `#scrubNum`) inherits ordinary baseline alignment and
  renders visibly lower than the numstep group's own vertical centre unless it also gets
  `vertical-align:middle`. That span also carries a space on each side of the `/` (` / 20000`) —
  safe since the parent already has `white-space:nowrap`.

- **in/out** — TIFF parsing; in-memory vs. streamed loading; contiguous ImageJ stacks are indexed
  arithmetically, multi-IFD (Micro-Manager MMStack) stacks by walking the IFD chain. Handles
  multi-GB files via `File.slice()` (never fully loaded). `loadTiffFile()`'s choice between the
  whole-file (`file.arrayBuffer()`) and streamed (`loadMultiIfdStreaming()`) path is gated on
  `effSliceMin = Math.min(SLICE_MIN, readBudget())` — `SLICE_MIN` (~1.5 GB) alone used to be the
  ONLY gate, disconnected from `readBudget()`/`memgb` (the SAME "Memory budget (GB)" control that
  gates decoded-frame caching further downstream). **Fixed a real bug**: a moderate file (147 MB
  bundled sample; a 680 MB real-world one) stayed under 1.5 GB and always took the whole-file path
  (reading the entire raw file AND indexing every frame's IFD up front, before any budget check),
  while a much larger file (4.9 GB) was always forced onto the chunked streaming path regardless of
  its own size — on memory-constrained mobile Safari (no JS-visible OOM signal, see FTM's memory
  note below) this made the SMALLER file the riskier load. Tying the threshold to `readBudget()`
  lets a user lower **Memory budget (GB)** and have it apply here too; unchanged at the 3 GB
  default (`min(1.5GB,3GB)=1.5GB`) so desktop behaviour is untouched. Verified via Playwright: a
  forced-low budget routes the same 147 MB sample through `loadMultiIfdStreaming()` instead,
  producing byte-identical pixel data. Both call sites log a one-line advisory —
  `"Streaming instead of loading whole: X file exceeds the Y Memory budget…"` — but ONLY when the
  tightened budget (not a file genuinely over the fixed 1.5 GB ceiling) is what forced streaming,
  so it doesn't fire redundantly alongside the other path's own message.

  **`memgb`'s own DEFAULT is also lowered on mobile** (`syncParamControls()`, MODULE: params) — the
  fix above only helps once a user has actually lowered **Memory budget (GB)**; at the unchanged
  3 GB default the 680 MB mobile-sized file still crashed silently. `syncParamControls()`
  special-cases `memgb`: on a narrow viewport (`isMobileViewport()`, `window.innerWidth<=860` — the
  same signal the mobile sidebar drawer uses) it defaults to `0.5` (its UI-allowed minimum) instead
  of `3`. **1 GB was tried first and is wrong** — `680 MB<1 GB` still doesn't clear the threshold,
  only `0.5` (512 MB) does; re-verify against a real number if this default is ever revisited.
  Deliberately a LOCAL override inside the sync loop (`const def = ... ? 0.5 : spec.default`), NOT
  `spec.default=0.5` — the latter would permanently mutate the shared `PARAMS.memgb` object
  (`PARAMS[id]` is a reference, not a copy). Only the INITIAL default changes; a loaded settings
  JSON's own `memgb` still overrides it as always.

  A multi-file selection (Ctrl/Cmd+click) goes through `loadTiffFilesAuto()`, which auto-detects
  which of two combining strategies applies from `files[0]`'s own frame count (same "file[0] sets
  the rules" convention used for width/height): exactly 1 frame → `loadTiffSequence()`
  (natural-sorted, one file = one frame — e.g. a per-frame camera dump); more than 1 →
  `makeConcatStack()` (each file loaded normally via `loadTiffFile()`, keeping whichever loading
  strategy its own size calls for, then concatenated end-to-end) — for one continuous acquisition
  split across several files purely by size, a different scenario from the per-frame case.
  `makeConcatStack()` only implements `getFrames()` (never `getFrame()`, same convention as
  `makeCroppedStack()`/`makeFtmStack()`), routing a requested range across component stacks via a
  prefix-sum frame-count table. The same `loadTiffFilesAuto()` entry point backs the interactive
  file input, calibration loading, and the headless `cfg.files`/`cfg.calibrationFiles` config (see
  **pipeline**) — one detection path, three callers. Multi-file selection filters candidates by
  SNIFFING the real TIFF magic bytes (`isTiffFile()`, "II*\0"/"MM\0*") rather than trusting the
  filename extension; the `#file` input's `accept` lists `.nd2` alongside `.tif`/`.tiff` for
  exactly this.

  `loadTiff()`/`loadTiffFile()`'s fast path and `loadTiffSequence()`'s `decodeOne()` all validate
  the raw ImageWidth/ImageLength tags (`t256`/`t257`) are present and positive before trusting a
  `UTIF.decode()` result — UTIF returns one EMPTY ifd object (no exception) for non-TIFF bytes, so
  without this an unsupported binary would silently produce `NaN` dimensions instead of a clean
  error. **Check `t256`/`t257`, not `.width`/`.height`** — those are only set as a side effect of
  `UTIF.decodeImage()`, so checking them beforehand silently checks `undefined>0` and rejects every
  file, valid or not (a real regression caught before shipping).

  **Native Nikon ND2** (distinct from the TIFF-in-disguise case above), shipped v0.11.2,
  **experimental** — `isNd2File()` sniffs the real magic (`0x0ABECEDA` LE u32 at byte 0) and
  `loadTiffFile()`'s first line dispatches to `loadNd2File()`, reaching all three existing callers
  (interactive, calibration, headless) with no caller-side changes; `loadTiffFilesAuto()` also
  special-cases a lone `.nd2` selection (multi-file ND2 concatenation isn't supported yet).
  Reverse-engineered directly from real sample bytes, not ported from any GPL reader (see also the
  independent BSD-3-Clause `tlambert03/nd2` reference). The file is a flat run of 16-byte-header
  chunks (`magic+dataOffset+dataLen+4 reserved`, then a `!`-terminated name, then payload), each
  padded to the next 4096-byte boundary; `readNd2ChunkHeader()` walks the WHOLE chain from byte 0
  to index every `ImageDataSeq|N!` frame offset — no shortcut, since the required
  `ImageAttributesLV!` metadata chunk sits near EOF, after all frame data. Each `ImageDataSeq|N!`
  payload is a 24-byte (`ND2_FRAME_HEADER_BYTES`) per-frame sub-header (unidentified, never parsed)
  then the pixel array. `parseNd2LvField()` recursively decodes Nikon's binary key-value ("LV")
  format for `ImageAttributesLV!`/`ImageCalibrationLV|0!`: a container (type `0x0b`) holds
  `childCount(u32)+byteLen(u64)` then recurses exactly `childCount` times — **`byteLen` must never
  be used as the parse boundary**, it can include trailing padding and produce a bogus extra read
  with a garbage type byte. String fields (type `8`) are **null-terminated UTF-16LE with no length
  prefix**, unlike field names (explicit `nameLen`). `getFrames(s,e)` decodes each frame at its own
  explicit stored offset (never back-to-back). Pixel calibration (`ImageCalibrationLV|0!`'s
  `dCalibration`) and two bonus metadata chunks — `CustomData|AcqTimesCache!` (per-frame
  timestamps → a MEDIAN-of-diffs frame-interval estimate, robust to near-zero leading placeholders
  seen in real files) and `CustomData|STORM_CAM_DATA_SHEET_XML-V1!` (camera datasheet info, NOT
  wired to `gain`/`camoffset`) — are also parsed. TIFF gets the analogous treatment via
  `tiffScaleHint(ifd0, desc)`: reads `finterval=` from the `t270` description text, and — only when
  `unit=` says micrometers — `t282`/`t283` (XResolution/YResolution) for a pixel-size estimate;
  `t296` (ResolutionUnit) is deliberately never consulted.

  `makeCroppedStack()` (raw-panel crop tool, `rawCropBtn`) is the simplest stack wrapper: slices
  every fetched frame to a fixed `[x0,x1)×[y0,y1)` sub-rectangle and REPLACES the module-level
  `stack` with it (kept in `originalStack` while active, restored on "uncrop") — a full stack swap
  rather than a search-region restriction threaded through detect/fit, so no downstream consumer
  needs a coordinate offset added back. Deselecting `rawCropBtn` while `lastResult` exists confirms
  first — `resetAfterCropChange()` erases `lastResult` (and sSMLM pairing state) unconditionally,
  no undo.

  **FTM** (`ftmEnabled`/`ftmWindow`, controls in the **fit** module's `PARAMS`/sidebar despite the
  functions living here) is a per-pixel sliding-window temporal median subtraction — floored at
  `camoffset` and added back, not floored at zero, see **fit** for why — used in two places sharing
  the same math but otherwise independent:
  - **Scrubbing preview** — `ftmFrame()`/`ftmFrameParallel()`, one frame at a time, fetching only
    that frame's own `ftmWindow`-wide context. Parallelizes across the worker pool spatially (row
    bands, no overlap margin needed — each pixel needs no neighbouring-pixel context). The
    raw-panel toggle (`rawFtmBtn`, shown only while `ftmEnabled` is checked) drives `rawFtmView`;
    `showFrame()` swaps in the corrected frame before running the usual detect/live-preview logic.
    The raw panel title stays fixed at "Raw frame" always — only `rawFtmBtn`'s own label changes
    (a dynamic title was tried and reverted: visual noise for no information gain).
  - **Localize** — processes the stack in chunks sized from half the `chunkmb` budget (headroom
    for raw context + corrected output coexisting), using the sliding-window median algorithm
    (`ftmSeriesGlobal`, O(window) per step). Two implementations, chosen by whether `runCore()`
    uses the worker pool this Run:
    - **No pool**: `makeFtmStack()` wraps the loaded stack so `runCore()`'s serial `getFrames()`
      calls receive FTM-corrected data transparently, caching each chunk. Main-thread, with a
      single-flight lock.
    - **Pool in use**: a **barrier-phased loop** inside `runCore()` (search `fetchStack!==stack`)
      processes chunk by chunk — each chunk runs a full-pool-parallel FTM-correction phase
      (`ftmChunkParallel()`, row-band split) to completion, THEN a full-pool-parallel detect/fit
      phase (duplicated rather than shared, to keep the non-FTM path provably untouched) to
      completion, before the next chunk's FTM phase — never both job types on the pool at once.
      **Required, not just faster**: each worker has exactly one `onmessage` property, not a
      queue, so without the barrier an FTM-correction reply and a detect/fit reply could clobber
      each other's handler mid-flight. The timing log's `↑ N workers · X% utilisation` line covers
      the detect/fit phase only, excluding the separately-reported FTM phase. Each chunk's
      detect/fit phase's `finishChunk()` MUST check `shouldStop()` itself, not just rely on
      `dispatchChunk()`'s own bail-out.

    Both implementations must widen a chunk's context fetch beyond naive `coreStart±window/2`
    whenever the chunk's core range comes close enough to either end of the **whole stack** (not
    the Run's own `fitFirstFrame`/`fitLastFrame`) that a frame's window gets clamped further than
    that padding accounts for — same clamp `ftmSeriesGlobal` applies per frame internally
    (`ftmFrame()`'s single-frame path already had this right; the chunked functions didn't, until a
    worker-vs-serial A/B test caught a ~5%-photon-count-bias for a stack's tail frames).

    **Memory**: the barrier-phased loop's `ctxFrames` (raw context, dead once `ftmChunkParallel`
    returns `corrected`) must be explicitly dropped (`ctxFrames=null`, hence `let` not `const`)
    right after that call, not left reachable through the following dispatch phase's own
    allocations in the same closure — `chunkmb`'s `/2` split only budgets for context+corrected
    coexisting, not context+corrected+in-flight batch clones too. `runCore()` also logs an
    estimated peak-MB figure (chunk working set plus the already-cached stack's size, a *separate*
    budget stacking on top of `chunkmb`) right after the chunk-size line, advisory above ~800 MB —
    gated on `memgb<=8` (max is now 64, for workstation-scale caching) so a desktop user who's
    deliberately raised it isn't nagged every Run. Visibility only: a mobile tab killed for memory
    pressure gets no JS-visible error at all — nothing here can detect or prevent that.

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

- **fit** — phasor (fast, non-iterative), least-squares 2D-Gaussian, and Poisson-MLE 2D/3D/
  Elliptical (`gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`;
  `gaussianMLEspheric` is the default) localization. All fitters take `gain,camoff` and convert
  every pixel to true photon units — `(raw-camoff)*gain` — before fitting, matching Picasso's
  architecture; position/width/ratio outputs are provably invariant to this affine transform
  (LS/phasor), while MLE's Poisson likelihood and CRLB (`lpx`/`lpy`) are only statistically correct
  when fit in photon units, so this is the one place gain/offset actually change a result rather
  than just rescaling it.

  **Accept/reject drift gate decoupled from `winr`** (reported): all 5 fitters (`gaussianFit`,
  `gaussianFitElliptical`, `gaussianMLEspheric`, `gaussianMLEelliptic`, `gaussianMLEellipticangled`)
  reject a converged fit whose position drifted too far from its seed — previously bounded by `r`
  (Fit radius/`winr` itself), so widening the window for more background context also silently
  loosened (or, via harder convergence in a busier/crowded window, sometimes effectively tightened)
  that gate, with no reliable direction — the same visual set of spots in real, faint, crowded smFRET
  data gave different accepted counts at `winr` 3 vs 4. Now bounded by `FIT_MAX_DRIFT_SIGMA_MULT`
  (2, declared once near MODULE: fit's own banner) times the SEED σ_PSF (`sigma0` — never the fit's
  own output sx/sy, which would be circular) — a physically meaningful, window-size-independent test.
  A constant, not a live `PARAMS` value: all 5 fitters are stringified into the detect/fit worker
  (`workerSource()`), so a tunable value would need threading through that worker's own dispatch
  protocol at every call site instead of one shared declaration (+ one `WORKER_PRELUDE` line) —
  promote to a real setting later if 2× ever proves wrong for real data. `sigma0` is already a
  parameter on every one of these 5 functions, so this needed zero signature or call-site changes.

  **`apertureGeometry(win)`/`percentile(sortedVals,p)`** (v0.12.1-dev, right before `phasorFit()`) are
  a shared aperture-photometry helper — a CIRCULAR signal disk (`distance from centre <= r`,
  `r=(win-1)/2`, the same half-width every fitter here already uses) plus a SEPARATE, non-overlapping
  background annulus just outside it (`r < distance <= r+2.5`), background estimated via that
  annulus's 56th PERCENTILE (not mean or median) — published, previously-validated method (Martens et
  al., *J. Chem. Phys.* 148, 123311 (2018), Supplementary Information §S11 "Aperture photometry to
  assess intensity and background levels," itself adapting Preus, Hildebrandt & Birkedal, *Biophys.
  J.* 111, 1278 (2016), "Optimal Background Estimators in Single-Molecule FRET Microscopy" — directly
  on-topic for the smFRET use case below). **Reverse-engineered pixel-exact from the SI's own Figure
  S11 reference maps, not its prose formula** — the SI's own text names a "ROI radius" that turned out
  to be consistently 2px LARGER than the window's actual half-width `r`, for reasons the SI itself
  never explains; rendered the SI's PDF at 600 DPI (`pdftoppm`) and counted signal/background pixels
  exactly against the 7×7 and 9×9 reference maps (both independently confirming the `r`/`r+2.5`
  boundary) and the 15×15 map's own excluded corners (confirming the exclusion cutoff) before trusting
  the geometry — the prose alone would have produced a signal disk far too small to match the
  published figures. `apertureGeometry(win)` caches the `(dx,dy)` offset lists per window size (same
  `win` reused across every call in one Localize run or one smFRET Get time traces run);
  `percentile()` is the standard linear-interpolation convention (numpy's/MATLAB's default). **A real
  bug caught before shipping**: the background annulus reaches `r+2.5`, WIDER than the `win×win` box
  itself — the first draft only scanned `dx,dy` in `[-r,r]` (carried over by habit from an earlier
  box-based version's own loop bounds), silently never visiting the outer part of the annulus at all;
  fixed by scanning out to `Math.ceil(r+2.5)` instead.

  Used by **two** callers, consolidated into ONE implementation on request ("best to not have too many
  different methods") rather than two independently-evolved ad-hoc ones:
  - `phasorFit()` (below) — its own `photons`/`bg`/`bgstd` now come from this geometry instead of its
    PREVIOUS approach (a square `win×win` box's own outermost ring, background = plain MEAN) — see
    `phasorFit()`'s own comment for the re-verified synthetic accuracy number (a genuine improvement,
    not just "comparable," since a real, separate annulus removes most of the old ring's own
    real-signal leakage bias). Position/phasor-magnitude math (`col`/`row`/`tot`, the Fourier
    transform of the FULL box) is completely unrelated and untouched.
  - `apertureIntensity()` (MODULE: smFRET) — smFRET's own fit-free "Aperture photometry (no fit)"
    option for Get time traces; see that module's own paragraph for how it got here (a square-box
    ring-MEAN first, then a ring-MEDIAN that empirically made things WORSE before this literature
    version replaced both).

  Both stringified into the detect/fit worker (`apertureGeometry.toString()`/`percentile.toString()`
  added to `workerSource()`'s function list, `_apWin`/`_apSignal`/`_apBackground` added to
  `WORKER_PRELUDE` — the Web Worker gotcha: `phasorFit` is itself worker-dispatched for a Phasor
  2D/3D Localize run, so anything it newly depends on must reach the worker too, or it throws
  `ReferenceError` the first time a worker-pool Run actually exercises it).

  **`winr2d`/`winr3d`** (Fit radius 2D/3D) are the two fields actually shown in the sidebar;
  `applyWinrDefault()` (MODULE: pipeline, called from `updateMethodUI()`'s own `currentIs3d()`)
  keeps the underlying `winr` field mirroring whichever one is relevant as the 2D/3D context
  changes — a symmetric 2D PSF at this codebase's typical σ_PSF (~1.3 px) is well-fit by a
  narrower window (default 3) than an astigmatic 3D PSF's elongated axis (default 4), so one
  global `winr` default (previously 4, now 3) couldn't serve both. `winr`'s own sidebar row is
  hidden (`style="display:none"`, reported: three near-identical-looking fields on screen at once
  read as confusingly redundant, since two of the three always showed the same number) but stays
  in the DOM — every existing `$('winr')`-based mechanism (PARAMS, live-preview listener arrays,
  the worker-dispatch value) needed zero changes; edit **Fit radius 2D**/**Fit radius 3D** directly
  instead, they now double as "the active value for that mode". `applyWinrDefault()` itself is
  still internally NON-CLOBBERING, unlike `updateMethodUI()`'s own LUT auto-default just below
  (which always overwrites on every method switch, since LUT is a display preference with nothing
  to protect): it only overwrites `winr` if its current value still equals `_winrAutoSetValue`
  (what the mechanism itself last wrote there) — with no UI path left to hand-edit `winr` itself,
  this now just means editing the *inactive* one of `winr2d`/`winr3d` has no visible effect until
  you actually switch into that context, which is the wanted behaviour. `currentIs3d()` means real
  z coming out, not just a 3D-capable
  method selected (`mle3d`/`gaussmleEll` with **3D localisation?** unchecked still counts as 2D
  here) — extracted as its own function so `winr2d`/`winr3d`'s own `change` listeners can reuse the
  identical logic `updateMethodUI()` already had, rather than a second copy. Headless `analyze()`
  sets `winr` directly, same as always — this auto-apply is interactive-UI-only.

  **Shared MLE accumulator**: `gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`
  all run on ONE Fisher-scoring Newton driver, `mleNewtonFit(n, th, mstep, clampFn, ..., modelFn)` —
  checked directly against Picasso 0.11.0's `picasso/fitting/gaussfit.py`, whose
  `_estimator_terms(mle, value, data, var)` dispatch is the same Fisher-scoring shell
  (`inv=1/model; cf=data*inv-1; hess+=du·du·inv`) webSMLM already implemented. `modelFn(px,py,th,
  duOut)` returns the per-pixel model value and writes its Jacobian into a reused scratch array —
  `mleModelSpherical`/`mleModelElliptical` are erf-pixel-integrated (unchanged math, just
  extracted); the driver never needs to know what a parameter MEANS, only how the model responds to
  it, so a third/fourth model plugs in without touching the driver. `gaussianFit` (LSQ, Gauss-Newton
  + backtracking line search) is deliberately NOT part of this unification — different per-pixel
  weighting (plain squared residual, no `1/model` term) and a different outer solver.

  **`gaussianMLEellipticangled`** (`'gaussmleEll'`, "Gauss MLE 3D rotated elliptical" in the UI)
  adds a genuinely new model: `[x,y,N,bg,σx,σy]` plus a rotation angle, either FIXED (6 free params,
  reusing `mleModelElliptical` with pixel offsets pre-rotated by the constant once — same
  size/stability class as `gaussianMLEelliptic`, no angle Hessian row) or FREE (7 free params, angle
  is θ[6]). Motivated by sSMLM: every other 2D method fits one symmetric σ, so `sigma1st` (see
  **sSMLM**) was never a real directional measurement of the spectrally-smeared 1st order, just the
  closest available proxy. POINT-SAMPLED (`value=amp·exp(-½(arga²/σx²+argb²/σy²))+bg` at the pixel
  CENTER), not pixel-integrated like the other two models — a rotated Gaussian doesn't factor into
  closed-form per-axis erf integrals the way an axis-aligned one does; matches Picasso's own
  `_accumulate_rotated` formula exactly. `photons` is the amplitude converted to a true integrated
  photon count (`amp*2π·σx·σy`, same relation `gaussianFitElliptical` uses) — NOT the raw θ[2]
  amplitude the point-sampled model actually optimizes internally (`amp` reported separately).
  **Free-angle gotcha** carried over from Picasso: the angle derivative vanishes identically when
  σx==σy, singularising the Hessian — the seed deliberately breaks that symmetry
  (`σx0=1.05·σ0, σy0=0.95·σ0`) whenever angle is free; a fixed angle never enters the optimisation,
  so this doesn't apply there. An unconstrained (σx,σy,angle) fit also has a real, expected 4-way
  degeneracy (swapping σx↔σy and adding ±90°/±180° to the angle describes the identical physical
  ellipse) — not a bug, confirmed against all 4 equivalent parameterisations of a synthetic fit.

  **`PARAMS.localize3D`** ("3D localisation?", default checked) is the switch between the two angle
  modes for `'gaussmleEll'` — no separate per-method setting. `updateMethodUI()` only shows the
  checkbox's row (`localize3DRow`) for `mle3d`/`gaussmleEll`; unchecked: angle FIXED at
  `paramValue('sSmlmAngleCenter')` (degrees → radians, the sSMLM pairing step's own calibrated
  dispersion bearing, see `fitSSmlmAngle()`) and no z is computed (`wcal` stays `null` regardless of
  calibration). Checked (default): angle FREE (recovers a genuine per-emitter rotation angle) AND —
  if a `gaussian_width` calibration is loaded — z is computed from the fitted `(σx,σy)` via
  `zFromWidths()`, the same call `mle3d` makes; this doubles as the astigmatism-axis-alignment
  diagnostic: run `'gaussmleEll'` against real 3D calibration bead data and read back a genuine
  per-emitter angle instead of assuming axis alignment. `runCore()` computes `sSmlmAngleRad` as
  `config.localize3D ? null : (config.sSmlmAngleCenter||0)*Math.PI/180` — `null` selects free mode
  inside `gaussianMLEellipticangled`. **Chicken-and-egg gap**: the angle can only be FIT from an
  already-localized dataset's own pair geometry (position-only, any method works for that first
  pass), so unchecking `localize3D` for `'gaussmleEll'` is only meaningful as a SECOND Localize,
  after a first pass with a symmetric method feeds **Preview pairs**/**Fit angle & tol.**
  `sSmlmAngleCenter` defaults to 0°, and unlike `mle3d` there's no calibration file to hard-gate on
  — a genuinely unset angle is indistinguishable from a real 0° bearing, so `runCore()` can only
  warn (`onLog`, once per Run, gated on `!config.localize3D`), not refuse, when
  `config.sSmlmAngleCenter` is still exactly its default.

  `mle3d` itself also respects `localize3D`: unchecked, it's an axis-aligned elliptical 2D fit
  (`gaussianMLEelliptic`, angle implicitly 0) with no calibration requirement and no z — useful on
  its own now that **export**'s `sigma_x`/`sigma_y [nm]` columns expose per-axis widths directly.
  Checked (default), behavior is unchanged from before this control existed: calibration required
  (`run()`'s `needCal` guard, mirrored in `analyze()`), z via `zFromWidths()`. `run()`'s `wcal` (and
  `analyze()`'s `wcalForRun`) are only built when `localize3D` is checked AND a `gaussian_width`
  calibration is present; `wcal`'s mere presence (not a second flag) decides whether
  `runCore()`/the worker/`showFrame()` call `zFromWidths()` at all, for both methods alike.

  The `cal3dRow` "Load calibration…" control sits directly under `localize3DRow`, showing only
  while BOTH `localize3D` is checked (or method is `phasor3d`) AND no calibration is active yet
  (`cal3d||cal3dW`) — `updateMethodUI()` re-runs after every calibration load/compute so the box
  disappears the moment one lands. No in-page "replace calibration" affordance yet; a fresh page
  load or Load-settings round-trip is the reset path.

- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting. `LUT_CPS` control-point maps: `fire`/`inferno`/`viridis`/`turbo` are smooth
  hue ramps for continuously-varying data (intensity, real 3D depth); `hsvBlue` is a closed-loop
  full hue cycle (240°→cyan→green→yellow→red→magenta→violet→240°, saturation/value pinned to 1) —
  unlike every other map here it's cyclic, so BOTH ends of the mapped range land on the same hue
  (blue) by design, not an artifact; **Pair** auto-selects it. `drawDepthBar()` (the on-canvas
  colour-scale strip) anchors to the actual DATA's own right edge and vertical centre
  (`srFull._locMaxXpx`/`_locMidYpx`, cached once per `rerender()` in native px, converted through
  the current `view`/zoom on each draw), falling back to the bare top-right canvas corner only if
  there's no cached extent — a fixed corner alone looked disconnected, since sSMLM's paired
  reconstruction is often a subset of a larger FOV. Ticks/labels extend left (into the panel) so
  they're never clipped by the canvas edge.

  `renderSuperRes()`'s accumulator buffers are DENSE, not sparse — one value per super-resolution
  pixel across the WHOLE `(w×mag)×(h×mag)` grid regardless of localization count, so memory scales
  as O(w·h·mag²), completely decoupled from data volume. `checkRenderSize()` runs before any
  allocation: refuses (throws) if either side would exceed `CANVAS_MAX_DIM` (16384, a hard
  per-browser canvas-creation wall) or if the estimated concurrent footprint (count/z accumulators,
  `blur()`'s scratch, the final `ImageData`, the canvas backing store) exceeds `memgb` — the SAME
  "Memory budget (GB)" setting stack loading uses. `rerender()` catches the throw, logs what to
  change, and leaves the PREVIOUS `srFull` on screen rather than blanking; the headless `analyze()`
  path lets it propagate. The count accumulator (`acc`) is `Uint16Array`, not `Float32Array` (a hit
  count is always non-negative, halving the footprint); `zacc` (summed z, fractional) stays
  `Float32Array`. `Uint16Array` WRAPS silently past 65535 on a naive `+=1`, so the increment is
  guarded explicitly (`if(acc[idx]<65535) acc[idx]++`) with a one-line saturation warning.

  **`renderMode`** (`PARAMS.renderMode`, default `'precision'`) picks how `renderSuperResPixels()`
  turns locs into pixels: `'precision'` splats each loc as its own bounded (±3σ) Gaussian sized by
  its real CRLB (`lpx`/`lpy`; `rblur` is the fallback width for a method with none, e.g. phasor) —
  Picasso's own default convention — with σ additionally capped at `MAX_SPLAT_SIGMA_PX` (6 SR-px)
  since the ±3σ bound alone doesn't stop σ itself (∝ precision×mag) from growing unbounded for a
  badly-localized outlier or high mag, which otherwise dominates render cost out of proportion to
  its share of the dataset (measured on a real 4.2M-loc dataset). `'fixed'` is the original
  behaviour: bin then apply one uniform blur (`rblur`) to the whole buffer — cost ∝ buffer area, not
  loc count. `'dither'` is a stochastic alternative to `'precision'` for large/dense datasets:
  jitters each loc by one seeded draw from N(0, its own σ) and bins — O(1)/loc instead of O(σ²)/loc,
  10-24x faster on real dense data (Average-Shifted-Histogram/Monte-Carlo-KDE argument: each loc is
  one sample from its own posterior, converging to the true density once many overlap) — but grainy
  on sparse data, so not the default. Buffer dtype/allocation (`renderSuperRes()`'s main-thread
  fallback AND the render worker's own copy) key off `renderMode` too: `Uint16Array` for
  `'fixed'`/`'dither'` (integer hit count), `Float32Array` for `'precision'` (fractional Gaussian
  mass); a mode switch must reallocate, never reuse the other dtype.

  `setupPlot(cv, isPlot=false)` (shared by every draw function on the raw/sr canvases) letterboxes
  a fixed 4/3 sub-rectangle, centred within the panel's own box, for plots — rather than changing
  the canvas's own size (a CSS-`aspect-ratio` approach was tried first and rejected: CSS Grid
  stretches both cards in a row to match whichever sibling is taller, so a panel's height ended up
  depending on the OTHER panel's content). The canvas's own CSS box always tracks `--frame-ar` (the
  loaded movie's own w/h); `isPlot=true` fills the whole canvas with `plotColors().bg`, computes a
  centred 4/3 sub-rect, stashes the offset in `_plotLetterboxOx/Oy`, and `ctx.translate()`s to it
  before returning the sub-rect's own W/H as if it were the whole canvas — so every plot-drawing
  function's own `{ctx,W,H}`-from-`(0,0)` code needed zero changes. `registerPlotHover()` folds the
  same offset into the `mL`/`mT` a caller hands it, since `drawPlotHover()`'s hit-testing reads
  real, untranslated `clientX`/`Y`. `drawRawView()`/`drawView()` never pass `isPlot`.

  `.panel-body` (wrapping a canvas with its trailing controls — `#scrubRow`/`#srFilterNote`/
  `#calViewRow`) is top-aligned, NOT centred, since raw/sr canvases are always the same height
  (both track `--frame-ar` unconditionally) — centring each panel's canvas+controls group
  independently shifted the two canvases out of vertical alignment by roughly half of whichever
  trailing control only one panel has. Top-aligning puts both canvases flush against their own
  `h4`, so any leftover height difference lands invisibly at the bottom of the shorter card.

  Every plot function reads colours from `plotColors()` (`{bg,grid,text,axis,bar}`) rather than a
  hardcoded hex value, driven by a module-level `_plotExportMode` flag. `false` (normal, on-screen)
  reads the values LIVE via `getComputedStyle(document.documentElement)` for
  `--panel`/`--line`/`--muted`/`--fg`/`--accent`, so plots automatically track whichever of the
  app's three UI themes (dark/light/contrast, see **params**' `applyTheme()`) is active. `true` — a
  completely separate, FIXED light palette, independent of the UI theme — only inside
  `exportPanel()`'s "plot" branch, which flips the flag, redraws once via the panel's
  `_replotRaw`/`_replotSr`, snapshots via `cv.toBlob()`, then flips back and redraws again: a saved
  PNG reads better on a white background regardless of which theme is active on screen. A few
  accent colours (fit-line green/red/magenta, the exponential-fit orange, marker red) stay
  hardcoded across every theme AND the export palette, chosen to read clearly against any of them.
  Raw-frame/reconstruction overlays (ROI boxes, fit crosshairs, the scale bar, the depth-colour bar)
  and the `LUT_CPS` colour-map dropdown are deliberately UNTOUCHED by the UI theme — they sit on
  top of arbitrary image/data pixels, not a themeable panel background; `drawPlotHover()`'s tooltip
  is the same way on purpose, since it's the SAME function used for the raw-frame pixel-value hover
  readout (`fmtRawPixel`), which does sit on arbitrary image content.

  **"Save plot/image"** (`saveImgBtn`, export module) offers SVG as well as PNG, but ONLY for the
  7 genuinely plot-shaped panels (calibration, drift, NeNA, FRC, PCFO, line-profile, the shared
  histogram) — never the raw frame or SR reconstruction, real pixel-density data with no
  meaningful vector form at real localization counts. No separate SVG button or in-page format
  picker: for a plot, `exportPanel()` delegates to `exportPlotEither()`, which renders BOTH a PNG
  blob and an SVG string ahead of time and hands them to `savePlotEither()`, which opens ONE native
  `showSaveFilePicker()` dialog listing both "PNG image" and "SVG image" as `types` — the OS/browser
  dialog's own "Save as type" dropdown becomes the format picker. Since the returned handle has no
  "which type was picked" field, the actual format is read back from the resolved file handle's own
  extension (`/\.svg$/i.test(h.name)`). Falls back to PNG when no native picker is available
  (Safari/Firefox, or `file://` without picker support). A raster panel still calls the single-type
  `saveBlob()` helper as before — `savePlotEither()` is a second, plot-only sibling to it.

  `SvgRecordingContext` (next to `setupPlot()`) is a small, purpose-built class that duck-types the
  exact Canvas2D surface those 7 functions use (paths/rects/circles/text/save/restore/translate/
  rotate/clip — no gradients, patterns, images or curves) and records real SVG DOM nodes instead of
  painting pixels — written from scratch rather than vendoring a general canvas→SVG shim.
  `save()`/`translate()`/`rotate()` each push a FRESH nested `<g>` rather than mutating the current
  group's own `transform` — an SVG transform applies to ALL of a group's children, so mutating an
  already-populated group would retroactively move siblings drawn *before* the call; pushing a new
  group per transform and having `restore()` truncate the stack back to the depth recorded at the
  matching `save()` reproduces real canvas transform-scoping exactly. `makeSvgPlotCanvas(w,h)` wraps
  a `SvgRecordingContext` as a plain object duck-typing the slice of `HTMLCanvasElement` that
  `setupPlot()` touches (`clientWidth`/`clientHeight`/`width`/`height`/`getContext`), so
  `setupPlot()` and all 7 plot functions run completely UNCHANGED against it. The redirection is one
  module-level `_plotTarget` variable, consulted by each plot function's own hardcoded
  `setupPlot($('raw'|'sr'), true)` call (`_plotTarget||$('raw')`) — `null` normally, set only for
  the duration of the SVG render inside `exportPlotEither()`; the PNG render in the same function
  still screenshots the real on-screen canvas directly. Reuses `_plotExportMode`'s light export
  palette and the existing `saveImgModal` left/right chooser when both panels have content — that
  chooser only decides WHICH window; format is decided downstream. SVG `<text>` stays real, editable
  text (not outlines), so it re-renders with whatever font is available on the *viewing* system — a
  known, accepted trade-off versus PNG's baked-in glyph pixels.

  **UI colour theme** (`applyTheme(name)`, params module, `dark`/`light`/`contrast`) is set via
  `[data-theme]` on `<html>`, driving ~17 CSS custom properties (`--bg`/`--panel`/`--line`/`--fg`/
  `--muted`/`--accent`/`--accent2`/`--warn`/`--danger`(+`-hover`)/`--surface`(+`-hover`)/`--deep`/
  `--scrollbar-thumb`(+`-hover`)/`--shadow`/`--scrim`/`--row-stripe`/`--accent-tint`) — three icon
  buttons in `.header-actions` switch it, `.active` marking the current one. Persisted via
  `localStorage` (genuinely new for this project — Save/Load Settings is explicit JSON, not
  localStorage; still 100% client-side) — every access wrapped in `try/catch`: a failed read falls
  back to `'dark'`, a failed write is silently ignored, no error ever surfaces. A tiny inline
  `<script>` right after `</style>` pre-sets `[data-theme]` from the same key before first paint to
  avoid a flash of the wrong theme; `applyTheme()` re-derives and re-applies the same value once the
  main script runs. Deliberately NOT a `PARAMS` entry — pure display/layout, same as sidebar
  collapsed/floating state.

  **Quick guide** (`helpBtn`) sits in the sidebar sharing `#tableBtn`'s row, right of **View
  data/filtering**, styled with its own bespoke `.helpbtn` look; `wireHelp()` finds it by
  `id="helpBtn"`, position- and class-independent.

  **`webSMLM_lastVersion`** (localStorage, same try/catch fail-safe as the theme) is a sibling of
  `webSMLM_theme`: on load it parses the release number (`vX.Y.Z`) out of the `<h1>` pill's own
  text and compares it against whatever was previously saved for this browser, logging
  `webSMLM updated: vA.B.C → vX.Y.Z — see what's new: <CHANGELOG.md link>` when they differ, since
  the single-file/no-auto-update design otherwise gives a returning visitor no signal that anything
  shipped between visits. Deliberately parses only the leading `vX.Y.Z`, never the full pill text —
  the pill also carries a `-dev · build YYYY-MM-DDx` suffix that changes on every build-letter bump.

  `axisScale(maxAbs)` gives an axis whose values commonly run large, matplotlib-style "offset
  notation": ticks show a small (single digit + one decimal) scaled number, with a single `×10ⁿ`
  multiplier drawn once near the axis (`n = floor(log10(maxAbs))`). Lives in **render** (not
  `drawPcfoPlot()`, the one plot currently needing it) so any other plot with the same large-number
  problem can reuse it.

  Every plot draws a real L-shaped axis border (left + bottom, `C.text`) plus a short (5px)
  outward-facing tick mark at each major tick, on both axes. The border is drawn LAST, after the
  data, so bars/points flush against an axis edge (NeNA in particular) can't be covered by it. Tick
  labels shift outward by the same 5px to clear the marks.

  The side-by-side/stacked panel layout (`.canvases.stacked`, single column) is resolved by
  `applyLayout()`: `layoutOverride` (module-level, `null`/`true`/`false`) takes precedence over the
  `frameAspectWH.h/frameAspectWH.w<0.5` auto-heuristic once the user clicks **Stack panels**/**Side
  by side** (`layoutToggleBtn`), and sticks across further loads this session. `setFrameAspect(w,h)`
  is the single place that sets `frameAspectWH`, the CSS `--frame-ar` custom property, AND calls
  `applyLayout()` — `initScrub()` calls it with the loaded stack's own `w`/`h`; a CSV load
  (`csvFile`'s change handler, MODULE: table) calls it with `parseCsvLocs()`'s own bounding-box
  `w`/`h` instead, since there's no stack in that path. The reconstruction's own bounding box is
  always somewhat smaller than the original camera FOV (border-adjacent localizations are dropped
  during fitting).

  **`parseCsvLocs()` NEVER shifts loc coordinates** — `(0,0)` always means the same physical camera
  pixel it meant in the original file/session, full stop.

  **Raw-frame display contrast** (`rawBlack`/`rawWhite`, the Contrast slider, Picasso-inspired) is
  a FIXED [black,white] ADU range applied identically to every frame by `drawRaw()`, replacing an
  earlier per-frame auto-stretch that made brightness/contrast visibly shift as you scrubbed and let
  a single dead/hot pixel dominate a frame's own min or max. `estimateRawContrastRange(stack)`
  (called once right after a stack loads) establishes the slider's bounds/initial handles by
  sampling a bounded number (50) of seeded-random frames — the same `pickSeededFrames()` PCFO's own
  gain/offset estimate uses — a reasonable trade-off for a display convenience, not a measurement.
  `applyCropToRaw()`/`uncropRaw()` each make this same call too, right before `showFrame(0)`, since
  a crop/uncrop swaps `stack` for a genuinely different pixel population. Deliberately excluded from
  `PARAMS`/Save-Load Settings/the headless `analyze()` config — same "pure display/layout" carve-out
  as UI theme and sidebar state — a display convenience local to one interactive session.
- **workers** — frame-parallel detect/fit (see below).
- **export** — ThunderSTORM-compatible CSV. `photons`/`bg`/`bgstd` are already true photon units
  by the time they reach export (gain/offset applied inside the fit, see **fit**), so export/the
  table histogram do no further conversion — they read `gain`/`camoff` only to log a "gain 1 /
  offset 0" warning when a user hasn't set real camera values. `"sigma_x [nm]"`/`"sigma_y [nm]"`
  (CSV) and `sigma_x`/`sigma_y` (table) are optional columns, present whenever ANY loc carries a
  real per-axis width (`isFinite(L.sx)&&isFinite(L.sy)`, i.e. the Run used `mle3d` or `gaussmleEll`)
  — independent of `sigma1st`/`sx0th`/`sy0th`/`sx1st`/`sy1st` (sSMLM-pair-specific; these are
  per-loc, paired or not). `parseCsvLocs()` reads them back into `L.sx`/`L.sy` for a round trip.
  `"angle [deg]"` (CSV) / `angle` (table) is the same kind of optional column, present only when
  `gaussianMLEellipticangled` set `L.angle` (radians on the loc, converted to/from degrees at the
  CSV/table boundary) — the fitted ellipse rotation itself, previously computed but never surfaced
  anywhere: with `localize3D` checked it's a genuine per-emitter angle, with it unchecked every loc
  shares the same FIXED `sSmlmAngleCenter` value (still exported, but not a per-emitter measurement).
  **Required a real fix**: the worker pool's message protocol only packed `x,y,photons,bg,bgstd,
  sigma,z,zClamped,frame,lpx,lpy,lpz` (12 floats) per loc — `sigma` (`(sx+sy)/2`) but never `sx`/`sy`
  themselves — so a worker-pool Run silently lost per-axis width entirely, even though the
  single-threaded fallback (`locs.push(L)` directly) always kept it. Widened to 14 floats (`sx`,`sy`
  appended, `NaN` for methods that don't fit them) at all three sites that must move together — the
  worker's own `out.push(...)`, and both `wk.onmessage` unpack loops (the plain pool-dispatch loop
  and the FTM barrier-phased loop, which duplicate this on purpose, see **in/out**'s FTM entry) — a
  stride mismatch between any of the three is a silent data-corruption bug, not a crash. Widened
  again to 15 floats (`angle` appended, radians, `NaN` unless the Run used `gaussmleEll`) so the
  fitted ellipse rotation survives a worker-pool Run too — same three-site convention, same risk.
- **3D calibration** — astigmatic: σ_x/σ_y vs z bead curves, JSON save/load. Astigmatism is the
  only method implemented; other 3D approaches (Double Helix, Biplane) would live here too.
  `calibrationCore()` takes the same `shouldStop` hook `runCore()` (Localize) does, checked at the
  same yield point as its progress/preview callbacks (a Stop click can only be observed while
  yielding); `runCalibration()` enables `stopBtn` and resets `stopRequested` the same way `run()`
  does.
- **drift** — AIM (adaptive intersection maximization), point-based, 2D+z. `drawDriftCurve()`'s
  own green (`#0a7d32`)/magenta (`#c81cc8`)/blue (`#3572b0`) drift-x/y/z palette is treated as the
  project's reference colour pairing — other plots' own green/magenta curves (NeNA, **spt**'s
  track-length fit) were retroactively matched to it so a colour means the same thing across plots.

  `drawDriftCurve()` is a thin dispatcher over two plot functions, chosen by module-level
  `driftPlotMode` (`'frame'` default, or `'xy'`): `drawDriftCurveVsFrame()` is x/y/(z) vs frame
  index; `drawDriftCurveXY()` is a single trajectory (drift y vs drift x), each segment coloured by
  frame (time) through `getLUT(paramValue('lut'))`.

  **Stop support** (v0.11.10 — AIM's two rounds can take a while, and a user tuning
  `driftSeg`/`driftRoi` wants to see the curve to judge settings before a run they might discard).
  `aimDrift2D()`/`aimDriftZ()`'s two rounds are checked against `shouldStop()` per segment; Round 1
  is inherently sequential (`dx[k]` depends on `dx[k-1]`), so a stop there truncates to a genuine
  prefix of correctly-estimated segments. Round 2 needs EVERY segment's round-1 result to build its
  `full` reference, so a Round-1 stop skips Round 2 entirely; a Round-2 stop keeps whatever segments
  it already re-estimated and falls back to each remaining segment's own round-1 value. `fdx`/`fdy`
  stay sized to the FULL requested frame range regardless, reusing the existing tail-interpolation
  logic past the stop point, with `stopped`/`stoppedAtFrame` on the result so `driftCore()` and the
  interactive plot can tell a genuine measurement from the flat continuation. `driftCore()` treats a
  stop in EITHER the 2D or z pass as the WHOLE run being incomplete — never applying a complete 2D
  correction alongside a partial/missing z one — and skips applying ANY correction to `locs` in that
  case, exactly as if Correct drift had never been clicked. `correctDrift()` still shows the partial
  curve (dashed vertical marker + "stopped here — flat beyond" label, `rawInfo` leading with
  "PREVIEW ONLY, not applied") so judging convergence still works without committing. Headless
  `analyze()` never passes a `shouldStop` hook, so `stopped` is always `false` there.

  **`driftSamplePct`** ("AIM sample %", default 100, v0.11.11 — AIM becomes slow on a large
  dataset). `bestShift()` iterates its `(2R+1)²` shift-search grid once per OCCUPIED BIN of the
  segment being aligned — not per raw point, and not against `ref`'s size — so fewer points in that
  segment directly cuts both this loop and the bin-map build, roughly proportional to the
  percentage. `subsampleSegments(seg, samplePct)` does the actual thinning, called from both
  `aimDrift2D()` and `aimDriftZ()` after their per-segment grouping — mutates `seg` in place, one
  shared seeded RNG (`mulberry32(AIM_SAMPLE_SEED)`) across the whole call so a given (locs order, %)
  pair always samples the same points (same precedent as **spt**'s `getVisibleTracksForOverlay()`).
  Unlike that overlay sampling, this is NOT purely cosmetic: fewer points means noisier
  histogram-intersection counts feeding the sub-pixel parabolic peak fit, trading real estimation
  precision for speed — default stays 100. `AIM_SAMPLE_FLOOR` (200) guards the failure mode: a
  segment already at or below the floor is left untouched, and an above-floor segment falls back to
  its full point set if post-sampling count would drop below the floor — verified against synthetic
  linear-drift ground truth (300k pts, 100 segments): 20% sampling raised drift-estimate RMS error
  only modestly (3.94→4.41 px), while 5% (below the floor) correctly fell back to the full segment
  and reproduced the 100% result exactly.

- **locprecision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution,
  inline radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
  `drawNenaPlot()`'s two overlaid curves are green (`#0a7d32`, the FULL Endesfelder fit — signal +
  short-range + long-range terms) and magenta (`#c81cc8`, the signal-Rayleigh term alone).

- **sSMLM** — spectrally resolved SMLM: pairs 0th/1st-order localizations from a diffraction
  grating (ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer);
  Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022). Role assignment (which point of a pair is
  0th vs 1st) is **directional, not brightness-based** — real-data investigation found photon count
  barely correlates with position (≈50/50 even at confident intensity gaps, likely PSF-overlap/
  crowding at real emitter densities), so `sSmlmAngleCenter` is a genuine SIGNED bearing (full
  ±180°) and `pairCore()` classifies each candidate by direction into `outEdges`/`hasIncoming`
  maps: a point qualifies as 0th order only if it has ≥1 outgoing edge (a candidate on the
  configured bearing) AND zero incoming evidence (opposite bearing, more likely someone else's 1st
  order) — self-disqualifying, no brightness needed. PSF width (σ, broader for the spectrally
  smeared 1st order) showed only ~65–70% correlation with role — available as an optional,
  default-OFF extra filter (`sSmlmRequireNarrower`), not required. **2-point pairs only** (0th+1st)
  — multi-order chaining and FFT-based angle/distance auto-detection are `docs/REFACTOR_PLAN.md`
  follow-ups; the interactive **Preview pairs** distance/angle histograms
  (`computeHist()`/`drawHistogram()` from **table**) cover "find my window" instead — always
  fetched over a WIDE fixed scan (0–6000 nm, any angle), ignoring the current field values, so
  narrowing either one first can't hide the true peak. The **angle** histogram, unlike the distance
  one, restricts to the current distance window (angle signal is only sharp within the real peak)
  and plots each candidate's `rawAngle` AND its exact reverse (`+180°`) — which of a candidate's two
  points gets the smaller array index (and so which direction `rawAngle` reports) is a row-order
  accident, not evenly split in real data, so plotting only the raw bearing looks wildly asymmetric;
  doubling it makes the two peaks equal. `fitSSmlmAngle()` (**Fit angle & tol.**) estimates
  `sSmlmAngleCenter`/`sSmlmAngleTol` from that same data — 2°-bin peak detection + half-max-width
  walk, THEN DOUBLED as a safety margin (the raw half-max width alone came out ~1° against real
  data, vs. the ~5° that actually worked by hand). Both histograms draw the currently configured
  window as markers (`computeHist()`'s optional 4th `markers` param), refreshed live on field edits
  and after a fit via `refreshSSmlmHistIfShown()`.

  **The distance histogram's own min/max markers are directly draggable** (requested) — a dedicated
  IIFE (MODULE: table, physically right before the existing "Column-histogram X-axis zoom" IIFE)
  hit-tests a `pointerdown` against both marker's current on-screen position (`valueToPx()`,
  correctly folding in `setupPlot()`'s own 4:3 letterbox offset `_plotLetterboxOx` the same way
  `registerPlotHover()` does — the OTHER zoom/pan IIFE's own `dataX()` doesn't bother, fine for a
  symmetric pan but would silently misplace an absolute hit-test like this one). **Must be
  registered BEFORE that other IIFE, not just given `{capture:true}`**: for a pointerdown dispatched
  directly ON the target element (not a descendant), listeners fire in REGISTRATION order regardless
  of the capture flag — there's no real capture-vs-bubble distinction once
  `target===currentTarget`. Registering this block first is what lets its own
  `e.stopImmediatePropagation()` actually pre-empt the other IIFE's pointerdown when a press starts
  on a marker; capture-phase-but-registered-after was tried first and silently lost the race (caught
  by an explicit regression check: the OTHER histogram types' own zoom stopped responding once
  verified against a real page — Playwright's synthesized pointer events couldn't validate plain
  drag-to-pan at all, even on a completely unmodified baseline, so wheel-zoom was the actual
  regression signal used). During a drag, only a cheap `drawSSmlmHist()` redraw runs per
  pointermove (it re-reads the live field value directly, no event needed) — the real `change`
  event fires exactly once, on release, so whatever else reacts to `sSmlmDistMin`/`Max`
  (`syncSSmlmZRangeFromDist()`'s possible `rerender()` if already paired) doesn't run on every
  pointer tick. Clamped so one marker can't cross the other (`MIN_SEPARATION_NM`) or leave
  `PARAMS.sSmlmDistMin`/`Max`'s own bounds. Hovering near a marker (no press) sets
  `cv.style.cursor='ew-resize'` as a grabbability affordance a canvas-drawn line doesn't get for
  free otherwise.

  **`sSmlmHistBtn`** ("Show histograms") is one button covering both the distance and angle
  histograms, with `sSmlmHistModeBtn` toggling which mode `drawSSmlmHist()` draws — `sSmlmHistMode`
  `'dist'`/`'angle'` — labelled `"Distances"`/`"Angles"` (the OTHER mode's name, `driftPlotModeBtn`'s
  convention). **Deliberately different from spt's own D/track-length histogram merge**:
  `drawSSmlmHist()` overrides `$('rawTitle')` to a single FIXED `"sSMLM histograms"` for both modes
  — spt's own merge keeps `drawHistogram()`'s per-mode title instead, by explicit request.
  `previewSSmlmPairs()` resets `sSmlmHistMode='dist'` before its own first draw — a fresh Preview
  always opens on Distances, same precedent `driftPlotMode`/`sptHistMode` follow.

  **Fit angle & tol.** and **Pair** share one button row; **Unpair** sits alone in the row below. An
  unpaired localization is dropped from the result. A pair's reported position is the 0th order's
  OWN x/y (undispersed — already the true position), not the midpoint: the 1st order's offset
  varies per emitter with wavelength, so averaging would blur position.

  Stores the inter-order distance in its own `dist` field so a future 3D-fit + sSMLM combination
  could carry real depth AND spectral distance on the same loc without one clobbering the other.
  `renderSuperRes()`/`zRange()` take an explicit `colorField` parameter (`'z'` or `'dist'`) so the
  SAME depth-coded render path colours by either; `rerender()`/`analyze()` derive it as
  `hasZ ? 'z' : (hasDist ? 'dist' : null)`. The sidebar's **Colour by depth (z)**/**z min/max (nm)**
  labels switch wording live to "sSMLM distance" whenever `colorField==='dist'`. **`pairCore()`
  itself throws** (not just the interactive wrapper) if the input already has real 3D `z`, OR
  already has a `dist` field (already-paired output). Interactively, **Pair** also sets
  `zmin`/`zmax` to the configured distance window, since every accepted pair's `dist` already lies
  inside it by construction. Three module-level vars track state: `sSmlmOriginalLocs` (the true raw
  backup, captured once — also the authoritative pairing input: Preview/Pair always read
  `sSmlmOriginalLocs || lastResult.locs`, never `lastResult.locs` alone, since that may currently be
  an already-paired subset with no 1st-order companions left to find), `sSmlmPairedLocs` (latest
  Pair result), and `sSmlmShowingRaw`. The reconstruction-panel toggle (`sSmlmColorBtn`, "Show
  spectral"/"Show standard") swaps `lastResult.locs` between them (plus `zcolor`) — a real data
  swap, without discarding the pairing the way Unpair does. **Headless**: `config.sSmlmPair` runs
  pairing right after Localize, before drift/NeNA/FRC; `pairCore()`'s throws propagate immediately,
  and the result's `sSmlmPair` field records `nPairs`/`nInput`/`meanDistance`/`stdDistance`.
  `tools/webSMLM-cli.mjs`'s `--sSmlmPair` and `?autorun=`'s `sSmlmPair=1` both forward to it.

  **`previewSSmlmPairs()` now calls `logCmd()`** too (v0.12.1-dev, reported — Preview pairs computed
  a real, `sSmlmLastCands`-backed histogram that "Save plot/image" already exports, but never
  recorded a command for it) — deliberately does NOT log `sSmlmDistMin`: the wide diagnostic scan
  ignores it entirely, so including it would misleadingly suggest it mattered to what just ran.
  **Headless**: `config.sSmlmPreview` runs the identical wide scan (`sSmlmCandidates()` directly,
  0–6000 nm or wider, any angle) independently of `config.sSmlmPair` — either, both, or neither can
  be requested — recording `result.sSmlmPreview={nCandidates,scanMax}`; `config.exportPlots` (once
  `plots` exists, later in `analyze()`) additionally renders the SAME distance-histogram PNG/SVG
  "Save plot/image" would, markers included (`renderHistogramPlotHeadless()` gained an optional 4th
  `markers` param for exactly this — `computeHist()` already took one, `config.exportHistograms`'s
  own plain-column case just never needed it before). `sSmlmPreviewCands` (the raw candidate array)
  is stashed in a local var between where it's computed (alongside `sSmlmPair`, before drift/NeNA/
  FRC) and where `plots` is actually built (near the end) — the same "compute early, render late"
  shape `drift`/`nena`/`frc`/`pcfo` already use for their own `exportPlots` entries.

- **smFRET** (v0.12.1-dev) — Marked **experimental**, v1: "sites of interest" (SOI) detection plus a
  simple per-site time-trace readout, the first step of `docs/REFACTOR_PLAN.md`'s own smFRET/ALEX
  integration sketch. Not squeezed into sSMLM (a genuinely different optical setup motivating this —
  a prism + polychroic beam-splitter, not sSMLM's own diffraction grating) or 3D calibration, though
  **Localize SOI** (`locateSmfretSOI()`) reuses that module's own `averageFrames()`/`detectSpots()`/
  `gaussianFitElliptical()` chain verbatim — averages the first `smfretAvgFrames` frames (clamped to
  the stack's own length, `Math.min(stack.n,...)`) into one composite, detects once, fits each
  maximum, same "average, then detect once" reasoning `locateBeadsForCalib()` already uses (real
  molecule positions stay bright across an average the way transient noise doesn't). The FIRST run
  is a manual button click; once `smfretSOI!==null` (a composite is already showing), changing
  `smfretAvgFrames` or any detection/fit field also wired to `locateBeadsForCalib()`'s own listeners
  re-runs it automatically too — real SOI signals are commonly faint, so hand-tuning the threshold
  with live feedback matters here in practice, unlike a bright/well-separated bead calibration.
  Results (`smfretSOI`, `{x,y,sx,sy,sigma,photons,bg,bgstd,frame:0}` per site — the fitter's own full
  output, not just position) display the same way a bead composite does: `srFull`/`srSpots`/
  `srLocs` in the reconstruction (right) panel, `setSrRecon(false)` (reference view, not a real
  reconstruction). Not yet its own `MODULE:` banner — lives at the sSMLM/spt physical boundary,
  small enough for now; promote it once it grows (matching **liveStreaming**'s own precedent).
  Real motivating dataset: a prism/polychroic-split immobile DNA-FRET sample
  (`experimental_data/Donor-1b …prisms9393…tif`) — donor-heavy, so most detected SOI likely have
  little/no acceptor signal; not yet established whether real pairs are even present in it.

  **Every successful `locateSmfretSOI()` run also writes `lastResult`** (`{locs:smfretSOI, w, h,
  px:paramValue('pxnm'), mag:paramValue('mag'), det:null, fromSmfretSOI:true}`, reported — SOI data
  had no way into the table/export/sSMLM pairing machinery otherwise) — the same minimal shape
  `loadCsvFile()` uses for locs with no real per-frame Run behind them (`det:null`, so `showFrame()`'s
  own frame-overlay logic correctly skips trying to match it against the stack). This is what makes
  **Spectral SMLM analysis**'s existing **Preview pairs**/**Pair** usable on SOI data with ZERO
  changes to `pairCore()`/`sSmlmCandidates()` themselves — exactly the `docs/REFACTOR_PLAN.md`
  smFRET/ALEX sketch's own "linking a DD candidate to its DA partner = sSMLM's own pairing" idea,
  now wired rather than just proposed. Every SOI site gets the SAME `frame:0` (an arbitrary shared
  constant, not a real per-frame index) specifically because `sSmlmCandidates()` groups candidates
  by `loc.frame` and only ever compares within one group — giving them all the same value collapses
  the WHOLE SOI set into one group, so every candidate is compared against every other one, correct
  for a position set with no real temporal structure. `fromSmfretSOI:true` is a marker tag on the
  `lastResult` object itself (not a `PARAMS` field) letting `smfretFixSOI`'s own uncheck handler
  (below) tell "this lastResult is SOI's own" from "this happens to be a real Localize/CSV result
  that predates SOI" — only the former gets discarded on uncheck. `pairCore()`'s own guards (real z
  / already-`dist`-paired input) both pass trivially on fresh SOI locs, needing no special-casing.
  **REPLACES whatever `lastResult` held before** (a real Run, a loaded CSV, an earlier SOI pass) —
  no confirmation, same "no prompt, but name what's about to go" convention `run()`'s own pre-Localize
  reset already uses (mirrored here: warns once when clobbering a REAL prior result, but not on every
  routine auto-rerun re-clearing its own previous SOI pass, checked via `!lastResult.fromSmfretSOI`).
  Deliberately does NOT call `rerender()` — the SR panel keeps showing the composite/ROI overlay
  untouched; only an actual **Pair** (if the user gets that far) switches it to a real reconstruction,
  exactly as it already does for an ordinary Localize result. Verified via Playwright against the
  real prism/polychroic dataset: `lastResult.locs` matches `smfretSOI` 1:1, `View data/filtering`
  shows all sites with `sigma_x`/`sigma_y` columns (free, since every SOI loc carries real `sx`/`sy`
  — the same optional-column convention `mle3d`/`gaussmleEll` results already trigger), **Preview
  pairs** runs to completion against them, and unchecking `smfretFixSOI` tears the whole thing back
  down (`lastResult=null`, table/save/sSMLM buttons disabled again).

  **`locateSmfretSOI()` now calls `logCmd()`** (reported — clicking it produced no recorded command
  at all, unlike every other action that writes `lastResult`) — logs `{smfretLocateSOI:true,
  smfretAvgFrames, psf, winr, detFilter, <active threshold field>, pxnm}`, genuinely replayable now
  that `config.smfretLocateSOI` exists (see below), not a cosmetic-only log line.

  **`smfretSOICore(config, stack, checkStack=true)`** (v0.12.1-dev) is the pure, DOM-free half of
  `locateSmfretSOI()` — the averaging+detect+fit loop, extracted so `analyze()`'s own
  `config.smfretLocateSOI` can call the identical logic (MODULE: pipeline's own `*Core()`/wrapper
  split). Mutually exclusive with the normal per-frame `runCore()` path in `analyze()` — set, it
  REPLACES the whole Localize step (matching the interactive button's own "replaces whatever the
  current result was" behavior), producing `r={w,h,timings:null}` the same minimal shape a `.csv`
  input already uses. **`checkStack` surfaced a real, previously-latent bug**: `averageFrames()`
  (its own inner loop, called by `smfretSOICore()`) aborts early if the module-level `stack` global
  no longer matches the one it was given — correct for the INTERACTIVE case (a user can swap stacks
  mid-average), but `analyze()`'s own `stack` is a separate, function-local variable of the same
  name that SHADOWS the module-level one — the global stays `null` in a fresh headless page, so the
  check was `null!==<real stack>` on every single call, 100% of the time, returning `null`
  immediately. `smfretSOICore()` never worked headlessly until this was caught (same "a module-level
  global populated before every interactive call site is invisible until something calls the same
  function headlessly" lesson as **spt**'s own `segmentedImageData` bug). Fixed by adding an explicit
  `checkStack` parameter to `averageFrames()` itself (default `true`, so every existing interactive
  call site — this one, `locateBeadsForCalib()`, `showStackProjection()` — is untouched), threaded
  through as `false` only from `analyze()`'s own call site.

  **`smfretFixSOI`** ("Fix SOI x,y for time traces", default unchecked) is a STATUS flag, not an
  independent on/off switch like 3D calibration's own `calFixedXY` — `locateSmfretSOI()` itself
  checks it (no `change` dispatch) on every successful run, explicit click or auto-rerun alike;
  there's no way to distinguish "just auto-checked" from "user clicked it", so only the UNCHECK
  direction has a real handler: it clears `smfretSOI`/`smfretTraces`, restores the reconstruction
  panel's general overview, and hides the site scrubber (below) in favour of the ordinary Frame one
  — same "uncheck to discard and restore" shape as `calFixedXY`'s own uncheck branch, just without
  its check-to-trigger direction. `initScrub()` resets it to unchecked on every fresh stack load,
  same reasoning as `smfretSOI` itself (scoped to one loaded stack, not sticky).

  **Get time traces** (`getSmfretTimeTraces()`) extracts every `smfretSOI` site's intensity — its
  known x,y only picks which `win×win` window to look at, never re-detected by scanning the whole
  frame — in EVERY frame of the loaded movie. Sequential over frames (`await stack.getFrames(fi,
  fi+1)` per frame, `await tick()` every ~50ms) — not worker-parallelized, matching the "simple
  check" scope of this feature; a real performance concern only once dataset sizes grow past what
  prompted this. Wired to the shared progress bar (`setProg(100*(fi+1)/n)`, `setProg(null)` in a
  `finally`) — reported: many sites × many frames, most of which won't contain a real localization
  for a given faint site (extraction still runs there regardless, same cost either way), can take a
  while with zero visual feedback otherwise, the same `onProgress`→`setProg` convention `sptCore()`/
  `pairCore()`/`driftCore()`/`calibrationCore()` already use. `smfretTimeTracesBtn` disables for the
  duration (re-enabled in the same `finally`, gated on `smfretSOI` still being non-empty — mirrors
  `runSptTrack()`'s own disable/`finally`-re-enable shape).

  **Two extraction methods, chosen by `smfretApertureMode`** ("Aperture photometry (no fit)",
  default unchecked, v0.12.1-dev). This went through THREE iterations while diagnosing a real,
  reported bug: on a real donor-heavy prism/polychroic dataset, several sites' time traces showed
  isolated single-frame "spikes" (amplitude 10-120x the surrounding frames) with NO corresponding
  brightness in the raw pixels at all (checked directly — the raw ADU values under the fit window on
  a spike frame looked identical to calm neighbouring frames).

  1. **Originally**: `gaussianFitEllipticalFixedXY()` (MODULE: fit — the exact fixed-position fitter
     3D calibration's own `calFixedXY` mode still uses, unmodified). Root cause of the spikes: an
     UNWEIGHTED nonlinear least-squares fit, fine for `calFixedXY`'s own bright, well-isolated
     calibration beads, but real smFRET candidate sites are often only detectable at all because
     **Localize SOI** averages many frames first — a SINGLE frame's own fit window can be close to
     flat background noise, and fitting a Gaussian PSF shape to that is ill-posed; the optimizer
     occasionally converged to a spurious narrow/high-amplitude "fake" peak (σ shrinking toward its
     0.5 px floor) that happened to fit one frame's random noise pattern unusually well.
  2. **Then**: reported feedback — there is no reason to FIX x,y at all here, unlike calibration's
     own bright/well-isolated beads; a standard 2D MLE fit with x,y merely SEEDED at the known
     position (free to move) should simply fail to converge, or get rejected, on a frame with no
     real molecule — that IS the desired behaviour, not something to special-case around. Switched
     the default to `gaussianMLEspheric()` (MODULE: fit — the exact same fitter an ordinary Localize
     run uses) seeded at the site's rounded position, x,y left free. This alone cut the worst site's
     max/median ratio from 117x to ~25x and correctly turned most of the remaining bad frames into
     NaN gaps (the fitter's own existing accept/reject logic — non-convergence, amplitude pinned at
     its floor, position drifted too far from the seed) — but not all the way: gain/camoffset are now
     applied (`paramValue('gain')`/`paramValue('camoffset')`), so `smfretTraces`' `photons` field is
     now true photon units, no longer the deliberately-uncorrected raw ADU the fixed-position fitter
     produced.
  3. **Then**: direct pixel inspection of a remaining spike (site 5, frame 23: fitted photons=27,326,
     raw 7×7 box sum barely moving between frames) revealed the fitted σ was 5.95 px — essentially
     UNBOUNDED, since `mleClampSpherical()`/`mleClampElliptical()` (right above `gaussianMLEspheric`)
     previously had NO ceiling on σ at all, unlike their LSQ siblings which already clamp to [0.5,6].
     A wide, dim, diffuse "blob" spread across the whole window integrates to a large total photon
     count from pure noise, with no localized bright pixel needed at all — a real, different failure
     mode from the floor-pinned one. Fixed at TWO levels:
     - **Shared, app-wide** (affects every caller of the 3 MLE fitters — `gaussianMLEspheric`/
       `gaussianMLEelliptic`/`gaussianMLEellipticangled`): added `MLE_MAX_SIGMA=6` (MODULE: fit, right
       after `MLE_MIN_SIGMA=0.5` — the SAME ceiling value the LSQ fitters already use, not a new
       number invented here) to both clamp functions, and extended all three fitters' own
       accept/reject line to also reject a result with σ (or σx/σy) pinned at EITHER `MLE_MIN_SIGMA`
       or `MLE_MAX_SIGMA` — symmetric with the existing amplitude-floor reject already there.
       `MLE_MAX_SIGMA` added to `WORKER_PRELUDE` alongside `MLE_MIN_SIGMA`/`FIT_MAX_DRIFT_SIGMA_MULT`
       (the Web Worker gotcha — a module-level `const` a stringified fitter reads must be re-declared
       there too). Deliberately conservative: reuses an EXISTING, already-shipped bound rather than
       picking a new one, and only rejects a result already pinned exactly at a floor/ceiling — a
       genuinely well-converged fit essentially never lands there by chance.
     - **smFRET-specific, on top** (`getSmfretTimeTraces()` itself, not the shared fitter): the
       shared 6px ceiling alone still wasn't tight enough — checked against the real dataset, a σ of
       3-4px (comfortably under 6, against a 1.3px seed) is ALREADY wide enough, relative to the fit
       window's own half-width, that a large fraction of the model's Gaussian mass extrapolates past
       the window edge, so the reported total "photons" stops being meaningfully constrained by the
       actually-observed pixels. Added `if(L && L.sigma<=FIT_MAX_DRIFT_SIGMA_MULT*sigma) traces[j]
       .photons[fi]=L.photons;` — reusing `FIT_MAX_DRIFT_SIGMA_MULT`'s (2) own "how far can a trusted
       result differ from its seed" reasoning, generalized from position to width. Empirically
       checked, not guessed: of 564 accepted fits across all 14 real sites, only 13 (2.3%) exceed
       2×σ_PSF, and EVERY one of those 13 is a clear photon-count outlier (median 8686 vs. the kept
       population's 2112) — a clean separation, not a borderline cutoff. Deliberately scoped to
       smFRET's OWN code, not folded into the shared fitter — 3D calibration's own astigmatic fits
       legitimately need σ to range far more widely away from focus, so tightening the SHARED ceiling
       to 2×σ_PSF would risk rejecting valid calibration data; this narrower check only applies where
       x,y is merely seeded (not genuinely being scanned across a real z-range).

  End-to-end result on the same real dataset: max/median ratios that were 1.4-120x with the original
  fixed-position LSQ fit are now 1.2-9.1x with the final free-position MLE + both sigma-plausibility
  gates — most sites' remaining variation now looks like genuine single-molecule blinking (extended
  ON stretches, then a NaN-gap-heavy tail consistent with photobleaching) rather than isolated
  divergent spikes.

  **`smfretApertureMode`** checked runs `apertureIntensity(img,w,h,cx,cy,win,gain)` (right above
  `getSmfretTimeTraces()`) instead: a linear operation with no iterative optimizer, so it structurally
  cannot diverge the way either fit can, at the cost of not reporting a per-frame width. `camoffset`
  cancels out exactly in a background-SUBTRACTED linear sum (no need to pass it separately) — only
  `gain` remains, applied as a final multiplicative scale so both methods report the same
  true-photon-unit convention. As of the aperture-photometry consolidation below (see **fit**'s own
  `apertureGeometry()`/`percentile()` paragraph), this calls the SAME shared circular-disk +
  background-annulus + 56th-percentile geometry `phasorFit()` itself now uses — not the square-box
  ring-mean version this paragraph originally described, superseded on request ("best to not have too
  many different methods"). Registered as an ordinary `PARAMS` bool entry (`type:'bool'`), so it's automatically part of
  Save/Load Settings like every other `PARAMS` field — `getSmfretTimeTraces()` itself still has no
  headless equivalent (unaffected by this). Its own `change` listener auto-reruns `getSmfretTimeTraces()`
  when traces are ALREADY showing (`if(smfretTraces) getSmfretTimeTraces();`) — reported: toggling
  the checkbox while a trace was on screen had no visible effect until "Get time traces" was clicked
  again, easy to miss since the checkbox itself gives no other feedback. Gated on `smfretTraces`
  specifically (not merely `smfretSOI`), matching Localize SOI's own settings-change listeners'
  "refresh an existing result, don't auto-START a fresh one" convention — checked and confirmed via
  Playwright NOT to auto-start a run before Get time traces has ever been clicked once.

  **Three more reported fixes, same round.** (1) A REJECTED/non-converged `gaussianMLEspheric` fit
  now writes `0` into `traces[j].photons[fi]`, not the array's `NaN` fill default — the reject logic
  already IS the best-available judgement that no real molecule was on at that site that frame, a
  real, physically meaningful ZERO intensity, not missing data; `NaN` is now reserved for the
  genuinely different "too close to THIS frame's own edge" case just above it (no window to even
  attempt a fit on). `drawSmfretTrace()`'s NaN-breaks-the-line logic and its own `nGaps` counter both
  benefit for free — a rejected fit no longer shows as a break in the curve, and "N frame(s) not fit"
  now means exactly that, not "fit ran and said no." (2) `apertureIntensity()` is now floored at 0
  (`Math.max(0, ...)`) — a negative photon count has no physical meaning regardless of where a
  negative raw result might come from (see the geometry rewrite below for what actually caused it).
  (3) Editing **Frame time (s)** while a Time trace was showing left the plot's own x-axis stale (it
  reads `frametime` fresh on every draw, per `drawSmfretTrace()`'s own comment, but nothing previously
  triggered that redraw when `frametime` itself changed — spt's own `frametime` listeners only ever
  refreshed spt's own displays). Fixed with one more `$('frametime').addEventListener('change', ...)`
  guarded by `smfretOwnsRawPanel()`, same gating convention `liveStreamOwnsRawPanel()` already
  established for its own scrubber redraws.

  **`apertureIntensity()` rewritten on a published, previously-validated method** (v0.12.1-dev, same
  round) — the ORIGINAL version (square `win×win` box, background = MEAN of that same box's own
  outermost ring) was ad-hoc, and its background ring sitting flush against the signal region's own
  edge meant real PSF tail could leak into it, biasing background high (occasionally producing a
  negative "intensity" before the floor above was added). Switching that ring's estimator from mean
  to MEDIAN was tried first (median seems like the more "robust" choice) and made things WORSE, not
  better — empirically checked against the real dataset: several sites' spikiness increased, one
  drastically (ratio 92x → 3313x), because the ring is only ~24 pixels for `win=7`, and a median's
  own sampling variance for that few samples (~1.57x a mean's, for the same N — a standard result)
  outweighs whatever real-signal-contamination bias it was meant to fix; a noisier estimator on a
  small sample is the wrong fix for a geometry problem. The user pointed to the RIGHT fix instead —
  and then, on a follow-up request to avoid maintaining two different aperture-photometry
  implementations, `apertureIntensity()`'s own geometry/percentile logic was further consolidated
  with `phasorFit()`'s own (below) into ONE shared `apertureGeometry()`/`percentile()` pair — see
  **fit**'s own paragraph on them above for the full method, citations, reverse-engineering story,
  and the worker-stringification bug that needed catching along the way.

  **`drawSmfretTrace(idx)`** plots one site's intensity-vs-frame curve in the raw (left) panel,
  following the exact "left panel doubles as a plot surface" pattern drift/NeNA/FRC already use
  (`rawFull=null; setRawPlot(true); rawPlotName='smfretTrace'`, `setupPlot()` for the 4:3
  letterbox, `_replotRaw` for resize/theme redraws, `registerPlotHover()` for the hover readout) —
  structurally a simplified `drawDriftCurveVsFrame()` (one curve, no drift-specific dashed-stop
  marker), breaking the line at any `NaN` sample instead of interpolating across a gap or drawing
  to a non-finite coordinate. **Y-axis ticks use `axisScale()`** (reported — full 5-6 digit ADU
  values visually collided with the rotated "intensity (ADU)" axis title, the exact same failure
  `drawPcfoPlot()`'s own large-value axis already needed `axisScale()` for): small 1-2 digit ticks
  plus one `×10ⁿ` multiplier drawn once near the axis, same placement convention (`mL, mT-8`).
  **`smfretOwnsRawPanel()`** (`smfretTraces!==null && !smfretShowRawFrame`) is the same
  "another feature owns the raw panel" pattern `liveStreamOwnsRawPanel()` established for its own
  scrubber — checked by the SAME shared `scrubByWheel` routing (MODULE: pipeline) that already
  branches on `liveStreamOwnsRawPanel()`, redirecting shift+wheel/slider-wheel to the dedicated
  `#smfretTraceScrubRow` (mirroring `#liveStreamScrubRow`'s own structure: a range input + a
  number+total pair) instead of the ordinary `#scrubRow`. A fresh `locateSmfretSOI()` run
  invalidates any trace view already showing (positions may have shifted) — reclaims the panel back
  to the ordinary Frame scrubber the same way unchecking `smfretFixSOI` does (hide
  `#smfretTraceScrubRow`, show `#scrubRow`, `showFrame()`).

  **`smfretTraceModeBtn`** ("Show raw frame"/"Show time trace", v0.12.1-dev) toggles the raw panel
  between the trace plot and the live raw frame WITHOUT discarding `smfretTraces`/`smfretTraceIdx` —
  reported: once a trace was showing, there was no way back to browsing raw frames short of
  discarding the whole SOI/trace state (unchecking `smfretFixSOI` or re-running Localize SOI), making
  it hard to visually cross-check a trace against the frame it actually came from. `smfretShowRawFrame`
  (module-level bool, default `false`, reset to `false` every time a fresh Get time traces run
  completes — same "fresh action reopens on its own default view" convention `driftPlotMode`/
  `sSmlmHistMode`/`sptHistMode` already use) is the switch `smfretOwnsRawPanel()` itself now also
  checks. The button's own click handler mirrors the exact show/hide pairs `locateSmfretSOI()`'s own
  trace-invalidation branch and the `smfretFixSOI` uncheck handler already use (swap
  `#scrubRow`/`#smfretTraceScrubRow` visibility, call `showFrame()` or `drawSmfretTrace()`) — just
  without nulling `smfretTraces` itself. **Deliberately NOT added to `hideOtherRawToggleBtns()`'s
  mutual-exclusion list** — that list is for buttons that switch BETWEEN DIFFERENT raw-panel
  features (drift/spt/sSMLM/segmentation); `smfretTraceModeBtn` instead toggles between two views of
  THIS SAME feature's own content, the same precedent `rawFtmBtn` (raw/FTM-corrected) already
  established, so it must survive `drawRaw()`'s own `hideOtherRawToggleBtns(null)` call when the
  raw-frame sub-view is showing. Shown (`style.display=''`) only in `getSmfretTimeTraces()`'s own
  success branch, right alongside `#smfretTraceScrubRow`; hidden at the same three places that null
  `smfretTraces` (the `locateSmfretSOI()` invalidation branch, the `smfretFixSOI` uncheck handler, and
  `initScrub()`'s fresh-stack-load reset) — `drawSmfretTrace()`'s own `hideOtherRawToggleBtns(null)`
  call correctly leaves it alone either way, per the paragraph above.

  **`.scrubslider`** (MODULE: params, the
  5 CSS rules right after the navigator comment) is the shared class giving every single-handle
  scrubber (`#scrub`/`#liveStreamScrub`/`#smfretTraceScrub`) its custom themed thumb/track — reported:
  this used to be a hardcoded id list instead of a class, so `#smfretTraceScrub`, despite copying
  `#liveStreamScrubRow`'s own markup exactly, still rendered with the browser's plain native thumb
  until its id was separately added to all 5 rules; a shared class means a FUTURE scrubber just
  needs `class="scrubslider"` to get the right look with no CSS change required at all.

  **`drawSmfretTrace()`'s x-axis is TIME (s), not frame index** (reported — a raw frame-number axis
  is meaningless without knowing the acquisition's own frame time). Exploits that
  `time = frame_index × frametime` is exactly linear: the existing per-frame pixel-mapping function
  `X(f)` needed NO change at all (it still maps a frame index to an x pixel) — only the TICK
  generation changed, from iterating frame-based `niceTicks` to iterating time-based `niceTicks(0,
  (n-1)*frametime, 6)` and converting each "nice" time value back to an equivalent (possibly
  fractional) frame index via `t/frametime` before handing it to the unchanged `X()`. `frametime`
  (`paramValue('frametime')`, "Frame time (s)") is read fresh on every draw, so editing it live
  redraws the trace in the new units via the usual `_replotRaw` mechanism. Tick VALUES are chosen in
  time directly (not translated from "nice" frame numbers) so they land on round seconds rather than
  whatever odd time a nice frame number happens to produce; `decT` (tick decimal places) scales up
  for short (<10s) traces, where whole seconds alone would collapse most ticks to "0". The hover
  tooltip shows both (`t = X.XX s (frame N)`) so the underlying frame is still recoverable.
  **`yScale.label`'s font (the `axisScale()` `×10ⁿ` multiplier, top-left)** was 11px against the
  12px tick labels/axis titles it sits beside — reported as reading too small next to them; bumped to
  match at 12px. The identical `axisScale()`-multiplier font-size fix was also applied to
  `drawPcfoPlot()` and the shared `drawHistogram()` (table/spt/sSMLM histograms) for the same
  app-wide consistency, not just this one plot.

  **The SOI composite draws each site's 1-based index next to its ROI box** (v0.12.1-dev, requested
  — "same visual style as plotting tracks in the single particle tracking module"), via a new
  `numbered` parameter on the shared `drawSpotOverlays(ctx,v,spots,locs,DW,DH,numbered=false)`
  (MODULE: render) — the SAME function that also draws 3D calibration's own bead-composite overlay
  and the raw-panel live-detect overlay, at 3 call sites total. Reuses `drawTracksOverlay()`'s
  (MODULE: spt) EXACT label style: font size `Math.max(9,Math.min(14,5.5*(fitZ>0?v.zoom/fitZ:1)))`
  (scales with how far zoomed in past `fitZoom()`, clamped [9,14]px, dataset/mag-independent), white
  text on an `rgba(0,0,0,.6)` backing box sized via `ctx.measureText()`'s bounding-box metrics, offset
  from the crosshair centre (`+7,-7` here vs. tracks' own `+3,-3` — SOI's crosshair itself, unlike a
  track's start-point dot, has no filled marker to clear, so a slightly larger offset reads better
  against the crosshair's own arms). Only the SR-panel call site passes `numbered:true`, and only
  conditionally: `srLocs===smfretSOI` — an OBJECT-IDENTITY check, not a bare `smfretSOI!==null` one,
  because `smfretSOI` is a session-scoped global that is never cleared when 3D calibration's own bead
  composite is later shown for the same loaded stack (`locateBeadsForCalib()` sets its own, DIFFERENT
  `fitted` array into `srLocs`) — a bare non-null check would have kept numbering calibration's own
  beads too, stale, after an earlier smFRET run in the same session. Applied identically at both
  `drawView()`'s own SR-panel draw and the PNG-export code path (`isSR` branch) so a saved composite
  image matches what's on screen.

- **spt** (single particle tracking, v0.11.2) — links per-frame localizations into trajectories and
  computes a per-track diffusion coefficient. A trackpy-**inspired** variant (same
  `search_range`/`memory` terminology and linking philosophy as the Python `trackpy` package), not
  a literal port. Ported from the user's own `sptPALM-Python` pipeline (L. lactis sptPALM, Martens
  et al., *Nat. Commun.* 10, 3552, 2019). `linkTracks()` walks frames in order; each frame's
  track↔candidate bipartite graph (edges within `sptSearchRange`, gated by `sptMemory` for
  gap-bridging) splits into connected components ("subnetworks") via union-find, each solved by a
  self-contained Hungarian/Kuhn–Munkres implementation (`hungarianAssign()`) for the
  minimum-total-squared-displacement assignment. NOT trackpy's own recursive exact-subnetwork
  solver; components above `HUNGARIAN_MAX` (120) fall back to greedy nearest-neighbor instead
  (one-time logged warning) rather than let O(n³) stall the tab — a documented scope limit, not
  expected to matter for real single-molecule SPT density. Returns a NEW locs array (never
  mutates) with `track_id` set on EVERY localization, even length-1 tracks — length filtering
  happens only at the diffusion-coefficient step. `trackDiffusionCoeffs()` ports
  `diff_coeffs_per_track()`'s core MSD math: one D (µm²/s) per track with at least
  `sptTrackLenMin` localizations, from the gap-corrected mean of ALL of that track's own
  single-frame squared displacements — an average, explicitly NOT a linear MSD-vs-lag-time fit,
  matching the reference pipeline — `D = MSD/(4·frametime) − locError²/frametime` (2D,
  static-localization-error-corrected). Unlike the reference pipeline there is no
  `sptTrackLenMax` truncation. `trackDiffusionCoeffs()` also collects `trackLengths` for EVERY
  linked track regardless of D qualification — `drawSptTrackLenHist()`'s log-Y-axis histogram of
  this is how a user judges whether `sptTrackLenMin` is set sensibly (`computeHist()`/
  `drawHistogram()` gained a `logY` parameter for this: bars/ticks map through `log10(count)`,
  with a 0-count bin pinned to the floor via `log10(max(1,c))=0`; the hover readout hands log-space
  bounds to its own `fmt` callback rather than teaching the shared hover code a Y-scale option). A
  real, expected artifact of the D formula is that near-immobile or very-short tracks can compute a
  non-positive D — `drawSptDHist()` EXCLUDES these from the plotted log10(D) histogram (logged
  count, not silently dropped) rather than pooling them into one fake-spike bin. **Track**
  (`runSptTrack()`) is idempotent, safe to re-run any time. Immediately draws the D histogram,
  fed `log10(D)` (D commonly spans orders of magnitude); not yet nicely `10^x`-formatted tick
  labels (v1 shortcut, `docs/REFACTOR_PLAN.md`). `sptDPlotMin`/`Max` are a DISPLAY-only axis
  window — `meanD`/`medianD` always reflect every qualifying track.

  **`sptHistBtn`** ("Show histograms") shows either the D or track-length histogram;
  `sptHistModeBtn` (same `.logbtn` placement as `driftPlotModeBtn`) toggles which of
  `drawSptDHist()`/`drawSptTrackLenHist()` is on screen, labelled with the OTHER mode's name.
  `sptHistMode` resets to `'D'` only at the top of a fresh `runSptTrack()`. `sptHistBtn` is enabled
  off `trackLengths.length`; if a fresh Track run has zero qualifying D estimates, it sets
  `sptHistMode='length'` first so a dataset with tracks but no D estimate still shows a useful
  histogram automatically.

  D = (MSD/4 − locErrorUm²)/frametime is exactly linear in 1/frametime, and MSD itself (cached per
  track in `trackDiffusionCoeffs()`'s `trackMSD` Map, plumbed to `lastSpt.trackMSD`) depends on
  neither frametime nor locError. `recomputeSptD()` exploits this: editing **Frame time** or
  **Localization error** after **Track** rescales every track's D directly from `trackMSD`, no
  re-linking — unlike **Search range**/**Memory**/**Min track length**, which still need a fresh
  **Track**. **Get from NeNA** (`sptLocErrorFromNenaBtn`) writes `sptLocError.value`
  programmatically, which doesn't fire `change`, so its handler calls `recomputeSptD()` explicitly.

  **`frametime`** (Frame time (s), renamed from `sptFrameTime`, v0.12.1-dev) moved OUT of this
  module's own `sptBox` to a pinned, always-visible sidebar row next to `pxnm` — same precedent and
  reasoning as `pxnm`'s own earlier relocation (see MODULE: params' comment on it): a per-dataset
  acquisition property, not something spt-specific, despite spt being its only current consumer.
  PARAMS registry position follows `pxnm` (both under the `// ---- render ----` comment group) for
  developer discoverability, but its DOCUMENTATION.md table entry stays under spt's own §3 section
  — its real functional home — exactly mirroring how `pxnm`'s own table entry stays under
  "Rendering settings" despite its pinned UI position; §1's sidebar section covers the physical
  relocation for both fields together. **Renaming, not just relocating** (unlike `pxnm`, which kept
  its id): a plain relocation would have left an SPT-specific id (`sptFrameTime`) on a control that
  no longer lives in the SPT section, confusing for anyone reading `PARAMS`/a settings file cold.
  Three TEMPORARY back-compat aliases cover the old key, each logging one deprecation warning and
  removable once external scripts/settings have migrated: (1) `analyze()`'s own top-of-function
  check (`config.sptFrameTime→cfg.frametime`, since `Object.assign(defaultConfig(),config)` would
  otherwise leave the caller's real value shadowed by `frametime`'s own default, with no error) —
  this alone also covers `tools/webSMLM-cli.mjs`'s `--sptFrameTime`, since the CLI forwards raw
  `--key value` pairs straight into `config`; (2) the Load Settings handler's own alias, applied to
  the parsed JSON's `values` object BEFORE the `for(const id in v)` loop, so an old saved file's
  `sptFrameTime` isn't silently dropped as an "unknown/legacy key"; (3) `runAutorun()`'s URL-param
  loop, which needed its own explicit `if(key==='sptFrameTime')` branch since `PARAMS['sptFrameTime']`
  no longer resolving means the loop's generic `spec`-driven path can't find it either. Fresh Save
  settings/Save data always write the new `frametime` key — the alias is read-only compatibility,
  never round-tripped back out.

  `drawSptTrackLenHist()` fits an exponential decay (`fitTrackLifetime()`, count(L) ~ A·exp(−L/τ),
  a photobleaching-limited survival model) via WEIGHTED least-squares on ln(count) vs bin centre,
  weight = the bin's own count. **Weighting is required, not cosmetic**: bin counts are
  Poisson-distributed (Var(ln(count)) ~ 1/count) — an unweighted fit gave a count-of-2 tail bin the
  same say as a count-of-8000 peak bin, dragging the fit an order of magnitude below the first bar.
  Fit curve drawn magenta (`#c81cc8`, matching **drift**'s pairing), attached as
  `histData.curve`/`curveLabel`. τ is reported in both locs and seconds; **locs≈frames only when
  `sptMemory=0`** — a bridged gap still counts as one "loc" despite spanning >1 frame, so the
  seconds figure is an approximation once gap-bridging is active. `computeHist()`'s `markers`
  parameter draws a vertical line at the current `sptTrackLenMin` (`trackLengths` never depends on
  that field, precisely so the marker can help pick it) — its `change` listener calls
  `refreshSptTrackLenHistIfShown()` to redraw the marker live, no re-Track needed.

  `track_id`/`D_coeff` are independent, optional table/CSV columns (same pattern as sSMLM's
  `dist`/`sigma1st`), so the filter grammar works on tracking data for free. **Save track data**
  (`sptSaveBtn`/`exportSptSummary()`) is a genuinely DIFFERENT export: `sptTrackSummary()`
  aggregates into one row per TRACK (`track_id`/`n_locs`/`D_coeff`/`mean_x`/`mean_y`) built from
  the tracked locs directly, not `lastSpt`'s own (D-qualifying-only) arrays. **Headless**:
  `config.sptTrack` runs tracking AFTER drift/NeNA/FRC (opposite order from `sSmlmPair`) since a
  per-track D benefits from drift-corrected coordinates; the result's `spt` field records
  `nTracks`/`nQualify`/`meanD`/`medianD` only (`trackMSD` is a `Map`, not JSON-serialisable).
  `tools/webSMLM-cli.mjs`'s `--sptTrack`/`?autorun=`'s `sptTrack=1` forward to it. No
  length-RESOLVED D histogram — tracked as `docs/REFACTOR_PLAN.md` follow-up.

  **Tracks overlay** (`srTracksOverlayBtn` "Show tracks"/"Hide tracks" next to the SR-panel title;
  `sptShowTracksBtn` in the sidebar turns it ON) plots a filtered/sampled subset of tracks as thin
  polylines over the reconstruction (`drawTracksOverlay()`), styled to match the user's own
  `sptPALM-Python`: plain magenta (`#ff3bff`) by default, or — `sptTracksColorByD` (checked by
  default) — each track coloured by its own mean D via `getLUT('fire')`, normalised against
  `sptDPlotMin`/`Max`; a track with no qualifying D draws neutral `#666`. A filled circle marks
  each track's start point (radius = 2× line width); the track number sits beside it in white on a
  `rgba(0,0,0,.6)` backing box, font size scaling with `view.zoom/fitZoom()` (not `view.zoom`
  alone, so it's dataset/`mag`-independent), clamped `[9,14]px`. Clicking a track's polyline
  selects it (`trackHitTest()`, point-to-segment distance, `8/view.zoom` tolerance) — the selected
  track overrides to magenta (colour-by-D mode) or `#3fb950` green (plain mode). `selectedTrackId`
  resets at the same five call sites `srTracksOverlayOn` does. Turning the overlay on also switches
  the reconstruction to the `grey` LUT (`switchLutToGreyForTracks()`).

  **Line thickness is `view.zoom` alone, NOT `mag*view.zoom`** — one `srFull` pixel's own
  on-screen size = `view.zoom`; `mag*view.zoom` draws one CAMERA pixel's width and is unbounded at
  high zoom — get this wrong again and it reproduces a real bug (giant spikes covering the
  reconstruction when zoomed in on one track).

  **`drawTracksColorBar()`** (D legend) anchors to the PANEL itself (`x=DW-28-bw, y=(DH-bh)/2`,
  `bw`/`bh`=`16`/`180`) — not `drawDepthBar()`'s data-extent anchor (tried first, read as squeezed
  into the corner); shifts left by `bw+24` when a real depth-colour bar shares the margin. **Must
  set `ctx.lineWidth=1` explicitly before its own `strokeRect()`** — `ctx.lineWidth` is canvas
  STATE, not reset between draw calls, and this runs immediately after `drawTracksOverlay()` in the
  same `drawView()` call, so without the reset its border silently inherited the tracks' own
  zoom-dependent line width (a real bug: the legend border thickened along with the track lines at
  high zoom). Same lesson for `textBaseline`: the unit label sets it to `'bottom'` explicitly
  rather than inheriting `'middle'` from the tick-label loop above it.

  `getTracksOverlayData()` groups `lastResult.locs` by `track_id` (excluding `track_id<0`) sorted
  by frame, cached by object identity against `lastResult.locs`. **`getVisibleTracksForOverlay()`**
  then narrows the list before drawing: `sptTrackLenMin` drops short tracks, then
  `sptShowTracksPct` (default 10%) samples a fixed percentage of the survivors deterministically —
  `mulberry32(TRACKS_OVERLAY_SEED)` draws one float **per track in the FULL, unfiltered id-ordered
  list**, keeping a track iff its draw is `<pct/100` AND it meets `sptTrackLenMin`. **The draw must
  run over the full list, not the length-filtered subset**, or raising `sptTrackLenMin` would
  reshuffle which tracks the RNG assigns to survivors — verified with a monotonicity sweep: the
  same dataset always shows the same track identities at a given percentage; raising the percentage
  only adds tracks; raising `sptTrackLenMin` only removes tracks. Cached against (list identity,
  minLen, pct); all three controls live-refresh via `refreshTracksOverlayIfShown()`.

  **`sptShowTrackDataBtn`** ("Show track data") opens `trackTableModal`: a sortable, filterable
  table of `sptTrackSummary()`'s per-track rows, reusing the main table's `parseFilter()` grammar
  and filter-autocomplete (`wireFilterAutocomplete()`, factored out for both boxes to share) rather
  than reimplementing it. Deliberately a SEPARATE, minimal implementation otherwise (own state/draw
  functions) rather than generalising the main table's own machinery, which is entangled with
  reconstruction filtering/temporal clustering/crop that a per-track summary has no equivalent of
  yet. `#trackTable` shares `#locTable`'s CSS via one combined selector list. Rebuilds fresh from
  `lastResult.locs` on every open; committed filters persist across close/open. Enabled/disabled by
  the same `!r.trackLengths.length` condition as `sptSaveBtn`/`sptShowTracksBtn`.

  **Cell-by-cell tracking is also wired headlessly** via `config.segmentationFile` (a File, loaded
  like `config.file`/`config.calibrationFile`, through its own hidden `#segmentationFileInput`).
  Its mere presence switches `sptCore()` to `segCtx`-based cell-by-cell tracking, same as checking
  **Apply segmentation?** interactively. This surfaced (and fixed) a real, previously-latent bug:
  `linkTracksPerCell()` read per-cell area off the module-level `segmentedImageData` global
  directly instead of taking it as a parameter — harmless interactively (always populated before
  this can run) but silently broken headlessly, since `analyze()` never touches that global —
  every loc would have come back excluded with no error. Fixed by recomputing the area map from
  the passed-in `segLabels` via `computeSegmentedImageData()` (pure, DOM-free) instead — a general
  lesson for any future `*Core()`-reachable function: a module-level global populated before every
  interactive call site is invisible until something calls the same function headlessly.
  `tools/webSMLM-cli.mjs`'s `--segmentation <mask.tif>` forwards to it; `?autorun=` has no
  file-upload mechanism at all, so it doesn't gain an equivalent.

  **Segmentation image** (`applySegmentation` checkbox, default unchecked; v1 toward
  cell-segmentation-aware tracking). Checking it reveals **Load segmented image**
  (`segLoadBtn`/hidden `segFile`, same accept list as **Load movie**), loading a separate
  integer-labelled mask through the same `loadTiffFile()` any movie goes through — 0=background,
  1/2/3/…=cell number. Only frame 0 is read (warns, doesn't error, on a multi-frame file). A
  movie/mask W×H mismatch logs a warning but loading still proceeds ("warn, don't block").

  `computeSegmentedImageData()` does one pass over the label array, building `segmentedImageData`
  (one `{id,cx,cy,areaPx}` row per nonzero label) — verified numerically EXACT against an
  independent numpy computation on the real bundled
  `experimental_data/bf_analysed_JH_procBrightfield_segm.tif` (111 cells).

  `drawSegmentedImage()` renders it through the SAME `rawFull`/`rawView` raster pipeline
  `drawRaw()` uses for an ordinary frame (fit/pan/zoom, and a correct raster PNG export for free,
  since `exportPanel()`'s PNG-vs-SVG dispatch keys off `rawFull` being non-null) rather than the
  plot mechanism — this is real pixel-density content with no meaningful vector form.
  `rawPixelData` is repurposed to hold the integer label array while shown (`rawSegView` flag) —
  `fmtRawPixel()`'s hover branches on it to show "cell N"/"background"; `redrawRawContrast()`
  no-ops instead of corrupting the label data through grayscale contrast mapping. The raw-panel
  crop tool is disabled while shown and re-enables automatically once a live frame reclaims the
  panel (`drawRaw()` resets `rawSegView=false`/`setRawPlot(false)`, same mechanism used for
  reclaiming from a plot). Unchecking **Apply segmentation?** reverts to the live frame and drops
  `segmentedImageData`/`segmentedImageLabels`.

  **Show image** (`segShowBtn`) shows either the segmentation image or its cell-area histogram; a
  raw-panel-title toggle (`segShowModeBtn`) flips `segShowMode` (`'image'`/`'hist'`) and calls
  `drawSegShow()` again. Unlike the spt/sSMLM histogram toggles (switching between two PLOTS
  sharing one draw call), this switches between a RASTER IMAGE (`drawSegmentedImage()`) and a PLOT
  (`drawSegAreaHist()`) — two structurally different rendering paths with no shared draw primitive,
  so `drawSegShow()` is a thin dispatcher; each mode keeps its own panel title. Hidden at the same
  two reclaim points every other raw-panel toggle uses.

  `drawSegmentedImage()` also calls `setFrameAspect(w,h)` with the segmentation image's OWN
  dimensions, taking over `--frame-ar` regardless of what set it before — a real bug otherwise: for
  a CSV-loaded result (no `stack`), `--frame-ar` was left at `parseCsvLocs()`'s own APPROXIMATE
  loc-bounding-box, so the panel got letterboxed with a gap that looked like a data misalignment.
  The segmentation image's dimensions are the more authoritative source once one is loaded — the
  reconstruction panel may pick up a small letterbox gap of its own instead, the right trade.

  `segmentedImageLabels` (`{arr,w,h}`, distinct from the per-cell stats table
  `segmentedImageData`) persists independently of whatever the raw panel currently shows, unlike
  `rawPixelData` — this is what **Show image** re-displays (deterministic seed-0 recolouring, so
  pixel-identical to the original load) without re-reading the file, and what tracking reads from.

  Cell colouring (`shuffledLabelColors()`) ports the *idea* behind the user's own
  `sptPALM-Python/helper_functions.py`'s `randomize_label_image()`: raster-order segmentation tools
  number cells in scan order, so physically adjacent cells often get consecutive label values,
  which map to near-identical hues through an ordinary continuous colour ramp. This shuffles each
  label's RANK (0..N-1) via a seeded PRNG (`mulberry32`) and maps rank/N straight to a hue
  (`hsvToRgb`, s=0.85/v=0.95) — spaces hues evenly regardless of gaps in the original label values.
  Verified visually against the real bacteria dataset — no two adjacent cells share a similar
  colour.

  **SR-panel "Show segm."/"Show recon."** (`srSegOverlayBtn`) swaps the panel between the normal
  density reconstruction and the segmented cells (OPAQUE) with the SAME density reconstruction
  drawn on top, its black background made highly transparent — cell colour shows through wherever
  there's no real signal, density stays visible on top (two earlier designs — a semi-transparent
  blend, then opaque cells with plain white points — were tried and rejected on direct feedback).
  Two offscreen canvases, both built in `drawView()`:
  - `buildSegOverlayCanvas()` — at `segmentedImageLabels`' own CAMERA-pixel resolution, label 0
    transparent, every other pixel OPAQUE via the same `shuffledLabelColors(seed=0)` call
    `drawSegmentedImage()` uses. Cached by object identity against `segmentedImageLabels`.
  - `buildTransparentReconCanvas()` — redraws `srFull` with alpha derived from each pixel's own
    LUMINANCE (`0.299r+0.587g+0.114b`, safe since every `LUT_CPS` ramp starts at `[0,0,0]`). `*2.5`
    gain so a pixel reaches full opacity well before true peak density; `MIN_SIGNAL_ALPHA` (90)
    floors the alpha of any nonzero-luminance pixel — without it a sparse/isolated localization
    (already near-black by LUT design) went dim AND nearly transparent at once, invisible against a
    bright cell colour underneath. Cached by object identity against `srFull`.

  Neither canvas is gated on `segmentedImageLabels.w/h` exactly matching `lastResult.w/h` — real
  segmentation masks are routinely a few px off from the movie's own dimensions, and requiring
  exact equality (an earlier version did) silently drew nothing for that common case. Matches this
  app's "warn, don't block" convention — `ctx.drawImage()` clips naturally at a genuine mismatch.

  **`segmentedImageLabels.refPxNm`** — localization POSITIONS never depend on `pxnm` (only the
  scale bar/`srInfo` readout do), so correcting **Pixel size (nm)** after loading a segmentation
  image had no visible effect on the overlay, a real bug. Fixed by treating the `pxnm` value at
  LOAD time as the segmentation image's own calibration reference (`refPxNm`, stashed only on a
  fresh load); `drawView()` scales the segmentation canvas's source-rect by
  `(current pxnm)/refPxNm`. **The direction was wrong in the first shipped version** (inverted,
  `refPxNm/current`) — caught only by checking against real data: double-check the direction
  empirically again if this formula is ever touched. Editing Pixel size (nm) while active needs no
  new wiring — the existing `pxnm` `change` listener already triggers `rerender()`→`drawView()`.

  **Cell-by-cell tracking** (`Min./Max. cell area (px)`, default 50/∞, same `default:Infinity`
  convention `fitLastFrame` uses). Their two `label.row`s are direct children of `#sptBox`
  (`segAreaMinRow`/`segAreaMaxRow`, `padding-left:40px`) rather than nested inside `#segLoadRow` —
  see the `label.row` nesting-depth gotcha above for why nesting there silently broke their
  right-edge alignment despite still looking indented. A fresh **Load segm. image** sets
  `segAreaMax` to `Math.max(...segmentedImageData.map(c=>c.areaPx))` — a real upper bound for that
  image. Ports `apply_cell_segmentation_sptPALM.py`/`tracking_sptPALM.py`'s own `use_segmentations`
  branch. `cellIdForLoc(L,segLabels)` looks up a loc's raw label the same way `fmtRawPixel()`'s
  hover does; `linkTracksPerCell()` groups locs by that label FILTERED through
  `segmentedImageData`'s own `areaPx` (`-1` sentinel, deliberately not `0`, which some dataset's
  raw mask might legitimately use as a real label — for background OR an out-of-range cell) and
  runs `linkTracks()` SEPARATELY per qualifying cell, so a track can never cross a cell boundary.
  Each cell's local `track_id` range is offset by a running counter (mirroring the reference
  pipeline's `track_id_shift = max(tracks['track_id'])+1`) so the merged result stays globally
  unique. `sptCore()` takes an optional 5th `segCtx` (`{labels,areaMin,areaMax}`) parameter
  selecting `linkTracksPerCell()` over the plain `linkTracks()` call; `trackDiffusionCoeffs()`
  needed no changes — it already skips `track_id<0`. `runSptTrack()` only builds `segCtx` when
  **Apply segmentation?** is checked AND an image is actually loaded (falls back to plain
  whole-FOV tracking with a warning otherwise). `cell_id`/`cell_area [px]` become optional CSV/
  table columns exactly like `track_id`/`D_coeff`.
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

  **`makeNavigator(cv, nav)`** is the shared pan/zoom (drag/wheel/pinch/double-tap-to-fit) wiring
  for both the raw and SR canvases (Pointer Events, one code path for mouse/trackpad/pen/touch).
  **`trackDragDistance(cv)`** (v0.12.1-dev, right after `makeNavigator()`'s own definition) fixes a
  real, reported bug in every click-based multi-point tool riding the SAME canvas — raw-panel crop
  (`rawCropBtn`), and the SR panel's crop/measure/track-select (MODULE: table's own `cropBtn`/
  `measureBtn`/tracks-overlay click handlers): a browser still fires a native `click` event after a
  `pointerdown`→`pointermove`(drag)→`pointerup` sequence on the same element, no matter how far the
  pointer travelled in between — `makeNavigator()`'s own drag-to-pan does exactly that sequence.
  Without this, dragging to pan a zoomed-in view while one of those tools was armed silently planted
  a stray corner/point wherever the drag happened to end; repeated drags on the raw crop tool in
  particular could crop the stack down to a tiny sliver with each new "corner" chaining off the
  previous accidental one, with no way back short of reloading — the crop tool deliberately stays
  armed after a completed crop (see **in/out**'s own `makeCroppedStack()` paragraph), so a user
  reaching for a plain pan-drag next had no reason to expect this. `trackDragDistance(cv)` wires a
  SEPARATE, passive `pointerdown`/`pointermove` pair (alongside, not replacing, `makeNavigator()`'s
  own) purely to measure total on-screen movement since the last press; the returned `wasDrag()`
  (true past `CLICK_DRAG_PX`, 5 CSS px) lets each tool's own `click` handler bail out instead of
  treating the event as a genuine single-point click. `srWasDrag`/`rawWasDrag` are the two instances,
  checked at the very top of `$('sr')`/`$('raw')`'s own `click` listeners — a near-stationary press
  still measures near-zero distance, so an ordinary two-click crop/measure is unaffected.

  **Keyboard hotkeys** (`wireHotkeys()`, v0.11.9): holding **Alt** (Option on Mac) shows numbered
  hint badges over the 10 always-visible top-level action buttons (`HOTKEY_BUTTONS`, on-screen
  order); tapping the matching digit clicks that button. Adding **Shift** switches the hint set to
  `HOTKEY_SECTIONS`, the 10 collapsible sidebar `<details>` modules — the digit toggles that
  section's `.open` and, on open, scrolls to and `.focus()`es its `<summary>` so the next Tab press
  lands on the section's first input (a closed `<details>`'s descendants aren't in the tab order
  until `.open` flips true). Alt, not Ctrl — Ctrl+1..9 is already bound to browser tab-switching on
  Windows/Linux; being modifier-gated also means no focused-input guard is needed against the app's
  many free-typable numeric fields. Both digit lists are FIXED to on-screen position (a hint simply
  doesn't render for a disabled button or off-screen section, but the mapping never renumbers), so
  muscle memory (e.g. Alt+5 = Localize) stays valid regardless of app state. **Digit matching uses
  `e.code`, not `e.key`** — a real bug caught before release: macOS remaps `e.key` for the digit
  row while Option is held (Option+2 sends `"™"`, not `"2"`), so an `e.key`-based version showed
  hint badges but silently never fired on Mac; `e.code` (`"Digit1".."Digit0"`) is the physical key,
  unaffected by modifier-driven remapping. `.hotkeyHint` badges are a FIXED blue (`#0969da`) rather
  than `var(--accent)`, same "overlay stays fixed across themes" convention as raw-frame overlays
  and the tracks-colour legend. Known gap: on the mobile/floating sidebar drawer (collapsed by
  default), Alt+Shift+N still opens the target `<details>` underneath, just invisibly until the
  drawer itself is shown.

  **Load movie/data** (`loadBtn`) is one button over ONE hidden `#file` input whose `accept` lists
  `.tif,.tiff,.nd2,.csv` together. Dispatch is by file EXTENSION alone (`/\.csv$/i`) — real content
  sniffing for the movie side (`isTiffFile()`/`isNd2File()`) still happens downstream, inside
  `loadMovieFiles()`'s own `loadTiffFilesAuto()`/`loadTiffFile()` call chain. `loadMovieFiles
  (fileList)` and `loadCsvFile(file)` are named functions the combined handler dispatches to. A
  selection mixing a CSV with movie file(s) is refused outright with a logged error, rather than
  guessing via file count or order. An all-CSV selection with more than one file warns (doesn't
  block) and loads only `files[0]`.

  **`analyze()`'s `config.file` now also accepts a `.csv`** (v0.11.13, same extension-only
  dispatch), parsed via `parseCsvLocs()` instead of `loadTiffFile()` — Localize/crop/
  `estimateGainOffset`/calibration are all skipped (no raw pixel data to act on), but everything
  downstream (`sSmlmPair`/`correctDrift`/`computeNeNA`/`computeFRC`/`sptTrack`/export/render) runs
  unchanged, since none of those `*Core()` functions ever took a `stack` to begin with — only
  `locs`/`pxnm`. `timings` comes back `null` (no Run to time); `tools/webSMLM-cli.mjs` handles that
  (a real, previously-crashing gap — its own summary line unconditionally read `timings.runMs`).
  `loadCsvFile()` now calls `logCmd()` too, matching `loadMovieFiles()`'s own convention — until
  this, a CSV load was the one **Load movie/data** path that recorded no command at all, a real,
  reported gap (spotted from the log output itself: prose with no command line above it) that also
  happened to be genuinely justified before this — there was no headless equivalent to record.

  `config.exportPlots` (also `--exportPlots`/`exportPlots=1`) renders whichever of drift/NeNA/FRC/
  PCFO/calibration were actually computed this call into `result.plots`, each a `{pngDataUrl,
  svgText}` pair — reuses **render**'s `renderPlotBothFormats()`/`_plotTarget` redirection (the
  same mechanism "Save plot/image" uses interactively), so no visible browser window is needed.
  `drawNenaPlot(res)`/`drawFrcPlot(r)` already take an explicit result parameter; `drawDriftCurve()`
  /`drawPcfoPlot()`/`drawCalibration()` don't (they read module-level globals) — three small
  `render*PlotHeadless()` wrappers stash the real global(s), call `renderPlotBothFormats()`, then
  restore them. `calib`'s wrapper specifically must live OUTSIDE `analyze()`'s own body: `analyze()`
  declares its own local `let calib=null` shadowing the module-level one `drawCalibration()` reads.
  The calibration plot needs a FRESH build this call — a bare `calibrationJson` only carries the
  derived model, not the point cloud the plot needs. The raw frame/reconstruction are never
  included (no vector form at real localization counts); the line-profile plot (a user-drawn line)
  has no headless equivalent.

  **`config.exportHistograms`** (`string[]`, also `--exportHistograms photons,sigma,bg` — comma
  -separated, no spaces) covers the "no headless equivalent" gap for the shared column histogram:
  since `computeHist()`/`drawHistogram()` already takes an explicit `vals` array (no table/DOM
  state needed), `renderHistogramPlotHeadless(col, vals, unit)` stashes `histData`/`histView`
  (which `computeHist()` itself sets), computes the requested histogram, renders via
  `renderPlotBothFormats(drawHistogram)`, then restores prior state. A separate flag from
  `exportPlots`, usable with or without it, with an explicit column LIST (not a fixed default set).
  Results land in `result.plots` as flat `hist_<column>` keys (not a nested `plots.histograms`
  object), so `tools/webSMLM-cli.mjs`'s already-generic `writePlots()` needed zero changes.
  `x`/`y`/`z`/`dist`/`sigma`/`sigma_x`/`sigma_y` convert to nm before histogramming (matching the
  CSV/table convention); every other column histograms as-is. A column that's absent or entirely
  non-finite logs a warning and is silently skipped, not a hard error.

  **`config.exportTrackData`/`exportSSmlmCandidates`/`exportCalibrationPoints`/`exportPcfoTiles`**
  (v0.11.10, `docs/DOCUMENTATION.md` §8 has the full schema) stream a per-record dataset too
  large/detailed for `analyze()`'s own return value — a per-track MSD-vs-lag curve, an sSMLM
  candidate pair, a calibration bead point, a PCFO tile point — through a new
  `config.onRecord(kind, batch)` hook in bounded batches (`makeRecordEmitter()`, 2000/batch), never
  accumulated in-page or put on the return value (which crosses the DevTools Protocol as one JSON
  blob when CLI-driven — exactly why `pcfo.pts`/`sSmlmPair.locs` are already trimmed out of
  `tools/webSMLM-cli.mjs`'s own return handling). `sptCore()`/`pairCore()`/`calibrationCore()`/
  `pcfoCore()` each accept the matching flag + `hooks.onRecord`; `computeEnsembleMsd()` (MODULE:
  spt) now also returns `perTrackMsd` (`Map<track_id,[{lag,tamsd}]>`) for exactly this — previously
  computed then discarded once pooled into the ensemble mean. `tools/webSMLM-cli.mjs` is the
  reference consumer: `--exportTrackData`/etc. forward `onRecord` via the SAME live `console.log()`
  channel `onProgress`/`onLog` use, appended to a per-kind `.ndjson` file via
  `fs.createWriteStream()`.
- **liveStreaming** (`window.webSMLM.liveStream`) — Marked **experimental**: real, but younger and
  less battle-tested than the rest of the app (several real bugs found and fixed via actual
  openframe-rig/Playwright testing this same 0.12.0 cycle — Stop not wired for streaming, the locs
  table staying disabled all session, an adaptive-cadence timing gap). A Micro-Manager/pycromanager
  camera bridge, physically right after **pipeline** (whose `runCore()` it calls per chunk) and split into its own
  indexed `MODULE:` banner for its size, not moved elsewhere in the file. Distinct from, and named
  to avoid colliding with, both the in/out module's own unrelated TIFF chunked/streamed-loading
  flag (`chunkmb`/`loadMultiIfdStreaming()`/`stack.streaming`) and the headless API's NDJSON
  "streaming per-record exports" (`onRecord`/`makeRecordEmitter()`, above) — three genuinely
  different features that all happen to use the word "stream". Two ways in, both nested inside
  `memBox` ("Memory & streaming"): an opt-in WebSocket the page itself connects OUT to (never
  listens), for hooking into a tab already open (`tools/test_livestream_demo.py`); or an external
  Playwright-driven bridge (`tools/webSMLM-livestream-bridge.mjs`, e.g. driving a Gladoscopy RT
  node) via a hidden `#liveStreamChunkInput` file conduit. Either way, each chunk is localized
  independently via `runCore()` (no cross-chunk context, so FTM is unsupported in this mode) and
  appended to a running total, repainting the reconstruction through the same `lastResult`/
  `rerender()` globals an interactive Localize run already uses. No separate Start step: a
  session (`liveStreamState`) arms itself the moment streaming actually begins — Connect, or the
  first pushed chunk — using whatever pxnm/gain/method/etc. the sidebar is set to at that moment.
  The top-level **Stop** button is the one control that ends a session either way (closing the
  WebSocket first if one's open); an earlier separate Disconnect button was folded into it and
  removed once Stop covered everything it did. The raw panel gets its own scrubbable frame history
  (`liveStreamShowRawFrame()`), auto-following the newest frame unless paused by a manual scrub,
  capped to **Memory budget (GB)** via a ring buffer (`liveStreamState.rawFrames`) since an
  open-ended acquisition can't keep every raw frame in memory. The periodic cadence render is
  adaptively time-based (`liveStreamState.previewInterval`, seeded from `srPreviewMs`/scaled to
  ~10x its own measured cost up to `srPreviewMaxMs` — the same mechanism a normal Localize run's
  live preview uses; a manual "Render every N frames" setting was removed since its effective
  cadence depended on external chunk size, not anything this app controls), guarded by
  `liveStreamState.renderBusy` so a fast chunk stream can't pile up renders faster than the single
  dedicated render worker can finish them, plus a conservative idle/pause detector and a session's
  own final render on end so the displayed reconstruction never lags behind `lastResult.locs`.
  `liveStreamOwnsRawPanel()` is the single shared "does streaming currently own the raw panel"
  check, used by the Contrast-auto handler and wheel-scrub routing — `initScrub()` deliberately does
  NOT use it: a fresh stack/CSV load must always reclaim the panel from a stopped session's leftover
  scrub-back history, a narrower check by design, not an oversight. **View data/filtering** (the
  locs table) is available mid-session too (same "any locs exist" gate as drift/NeNA/FRC) for
  browsing/sorting/histograms, but committing a NEW filter (or the reconstruction panel's crop
  tool, same `_tableFilters` mechanism) is refused while streaming — a filter is a one-time
  snapshot never re-applied to later chunks, so using one mid-stream would silently freeze the
  displayed reconstruction while `lastResult.locs` kept growing underneath it. **Clear
  localizations** (`liveStreamClearBtn`, `clearLiveStreamingLocalizations()`) resets `allLocs`/
  `frameOffset`/`rawFrames`/the reconstruction to empty without touching `.active` — chunks keep
  arriving through the call, no reconnect needed.
- **table** — the sortable, cumulatively-filterable localizations table ("View data/filtering")
  and per-column histograms. Committed filters set `renderLocs`, which drives the reconstruction
  live. The SR panel's crop tool (`cropBtn`, click two corners) is not a separate mechanism — it
  pushes an x/y-range clause into the same `_tableFilters` array a typed filter would, so
  reconstruction, export, NeNA and FRC all see a crop identically to any other filter. Typing
  `tempClusteringXY < 10` (nm) into the filter box is different in kind from an ordinary clause —
  it doesn't select a subset, it *merges* a blinking molecule's own detections into fewer,
  higher-precision "events" (`clusterEvents()`), changing the BASE row set rather than which rows
  currently pass. `getBaseLocs()` is the single place deciding whether the base is raw
  `lastResult.locs` or clustered events; everything else consumes whichever it gets, the same
  loc-shape either way.

  **Filtering is now CLI/JS-loggable** (v0.12.1-dev, on request — "repeat filtering steps"). Every
  successful `_tableFilters.push()` — the ordinary-clause branch and the tempClustering branch in
  `commitFilter()`, and the crop tool's own push — now calls `logCmd({tableFilters:
  tableFilterExprList()})`, where `tableFilterExprList()` maps `_tableFilters` to
  `f.exprCLI||f.expr`: the FULL cumulative array every time, so the most recently logged line
  always reproduces the exact current filter state (same "curated snapshot, not a diff" convention
  `run()`'s own `logCmd()` already uses). An ordinary or tempClustering entry's own `.expr` is
  already valid, replayable filter syntax (it's literally what was typed); the crop tool's own
  `.expr` is a pretty DISPLAY string ("crop: x 1234–5678 nm, y ...") `parseFilter()` can't parse, so
  it gained a second `.exprCLI` field — the equivalent `x >= .. and x <= .. and y >= .. and y <= ..`
  clause, built from the same `x0/x1/y0/y1` the crop tool already computes — used only for
  logging/replay; the chip's own on-screen display still reads the pretty `.expr`, unchanged.
  `resetFilters()` deliberately does NOT log anything — clearing filters isn't itself "a step to
  repeat," and an absent `tableFilters` key is already the headless default.

  **`tableFiltersCore(locs, px, exprList)`** (right after `commitFilter()`) is the pure, DOM-free
  half — `config.tableFilters` (MODULE: headless API) calls it with the exact array `logCmd()`
  above records, so an entire interactive filtering session (typed clauses, crop, temporal
  clustering, in whatever order they were committed) replays headlessly. Walks `exprList` in order:
  a `tempClustering(XY|Z|Memory)` entry updates local `{xy,z,memory}` state (replace, not stack, per
  axis — same semantics `commitFilter()`'s own `_tableFilters=_tableFilters.filter(f=>f.cluster
  !==axis)` line has) and rebuilds the base via the already-pure `clusterEvents()`; everything else
  parses via the already-pure `parseFilter(expr, cols)` against the CURRENT base's columns and ANDs
  into a running predicate; throws a plain `Error` on an unparseable clause (same "config
  validation propagates immediately" convention `analyze()` uses elsewhere). Deliberately NOT
  called FROM `commitFilter()` itself — the interactive path's own incremental one-clause-at-a-time
  UI updates (chips, live count, rebuilding `_tableData` only when the base actually changes) don't
  collapse into a single batch call cleanly; this is the "`*Core()`" DOM-free half existing
  *alongside* the interactive one, not a replacement for it. Verified end-to-end: replaying a real
  interactive session's own logged `tableFilters` array (an ordinary clause + a tempClustering
  clause, and separately a crop) through a fresh headless `analyze()` reproduces the EXACT same
  filtered row count as the interactive session's own `_tableFiltered.length` — 442/442 and 112/112
  on a real test file — and a real `tools/webSMLM-cli.mjs --tableFilters "..."` run matches too.

  **`locTableData(baseLocs, isClustered, px)`** gained an optional 3rd `px` parameter (default
  `px??lastResult.px`) so `tableFiltersCore()` above can call it with no `lastResult`/interactive
  session at all — all 3 existing interactive call sites (`rebuildTableData()`, `openTable()`, the
  crop tool) omit the 3rd argument and are completely unaffected.

  **Column headers put a unit suffix ("[nm]" etc.) on its OWN line, not appended inline**
  (`<br><span class="col-unit">[...]</span>` in the shared `<th>` template both `#locTable` and
  `#trackTable` build — see the CSS comment right above `.col-unit`) — reported: with many optional
  columns active at once (sigma_x/sigma_y, angle, track_id, `nmerged` once clustering is on, ...),
  every header reading "name [unit]" on one line made the table wide enough that later columns
  (`nmerged` in particular) needed horizontal scrolling to see at all. The table's own default
  auto-layout sizes each column to its widest LINE of content, so splitting the unit onto its own
  (usually shorter) line lets a column shrink to whichever is narrower — the bare name or the
  bracketed unit — instead of always needing room for both on one line; verified via Playwright at a
  cramped 900px viewport that all 10 columns of a `tempClusteringXY`-filtered table (including
  `nmerged`) now fit with no scrolling, and separately that `#trackTable` (sharing this exact
  template) renders the same way. The sort arrow (▲/▼) moved to sit right after the column NAME
  (previously after the unit) so it stays on the same line as the text people actually scan first.

  **`tempClusteringMemory <= N`** (frames, or `<= inf`, shipped — was the one remaining planned
  pseudo-field) is `clusterEvents()`'s new `memoryFrames` parameter (default 0, preserving the
  original hardcoded strict-adjacency behavior bit-for-bit — verified via Playwright: 0 produces the
  exact same event SET, by position/photons/frame/nMerged, as a frozen copy of the pre-memory
  algorithm on a real dataset). Restructured the per-frame loop so a chain's eligibility is a
  computed check (`f - c.lastFrame - 1 <= memoryFrames`) against the CURRENT frame, evaluated at the
  TOP of each frame's processing, rather than an immediate close-if-not-extended decision at the
  tail of the frame it failed to extend at — a chain surviving the check just gets another chance to
  match; one that's exceeded its gap tolerance is finalized before any distance search runs. Same
  reasoning resolves the design question `docs/REFACTOR_PLAN.md` had flagged as blocking this (how a
  gap should weight into the position average): a gap frame has no localization at all, so there's
  nothing to add into the running sums either way — the only real choice was whether matching should
  use the chain's full photon-weighted history or something more recency-weighted, and it stays the
  full history unchanged, since this app already has a dedicated drift-correction step (AIM) that's
  the intended place to handle real stage drift before clustering with a large/unlimited memory.
  Parsed by `commitFilter()`'s own regex, extended to accept `inf`/`infinity` (case-insensitive) as a
  value token for all three clustering pseudo-fields, not just Memory — it degrades correctly through
  the existing `d>xyPx`/`Math.abs(...)>zNm` checks (never true) for XY/Z too, so no special-casing
  was needed there. Memory alone (no XY/Z clause) does nothing — `getBaseLocs()` still gates on
  `xy||z` — `commitFilter()` warns rather than silently no-opping when a user sets Memory first.
  **Unlimited memory changes the performance profile for real**: at `memoryFrames=0`, `open` (the
  in-progress chains) self-prunes every frame; with real gap tolerance it only shrinks via merges, so
  it can grow to the total number of distinct physical sites over the whole clustered range — the
  existing "would want a spatial grid… if ever fed a pathologically dense frame" comment is now much
  more likely to actually matter, but the grid wasn't built pre-emptively (same "don't optimize for a
  scale nobody's hit yet" precedent as SPT's own Hungarian-vs-greedy fallback). `checkTableSize()` guards `locTableData()` the same way
  `checkRenderSize()` guards **render**'s buffers — each row estimated at ~200 bytes (V8 per-object
  overhead) against `memgb`; throws if over budget, caught at all three build sites so a too-large
  table fails with a log message and leaves whatever was on screen before.

  `computeHist()`/`drawHistogram()` (reused by table-column histograms, sSMLM's distance/angle
  histograms, and **spt**'s D/track-length histograms) can overlay a fit curve: `histData.curve`, a
  `x=>y` function sampled across the current view in the same bin-height units as the bars, plus an
  optional `histData.curveLabel`. Unlike `markers` (a `computeHist()` parameter, positions known
  before binning), `curve` isn't a `computeHist()` argument — a fit like `fitTrackLifetime()` needs
  the ALREADY-binned `histData` to fit against, so the caller sets `histData.curve`/`curveLabel`
  after `computeHist()` returns, before `drawHistogram()`. Defaults to `null`.

  `computeHist()`'s x-axis range (`hi`) carries a 5% right-edge headroom (`hi = lo +
  (dmax-lo)*1.05`), mirroring the Y-axis's own `ymax*=1.08` factor: without it, `hi===dmax`
  exactly, so the tallest/rightmost bin's right edge fuses visually with the plot's own border. A
  real bug on **spt**'s track-length histogram: a long-tail outlier track was effectively
  invisible, indistinguishable from the axis line — binning was never the problem (`b>=nb` already
  clips into the last bin), only the missing visual margin was.

The list above is in the file's actual physical order (as of v0.11.1, **workers** and
**export** were swapped to match — see `docs/REFACTOR_PLAN.md` for the reasoning and how it was
verified safe: both are pure declarations, no cross-referencing top-level state, so JS hoisting
made the physical move a no-op for behavior).

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

**The four raw-panel mode-toggle buttons must call `hideOtherRawToggleBtns(exceptId)` (MODULE:
render, next to `drawRaw()`).** `driftPlotModeBtn`/`sptHistModeBtn`/`sSmlmHistModeBtn`/
`segShowModeBtn` are mutually exclusive by construction — only one plot/image can occupy the panel
at a time. A DIRECT switch between two plot dispatchers with no "reclaim point" in between (e.g.
**Correct drift**/**Show drift**, leaving `driftPlotModeBtn` up, immediately followed by **Preview
pairs**) used to leave the PREVIOUS toggle stranded on screen alongside the new one — a real,
reported bug, since each dispatcher only knew how to show/label its OWN button. Fixed by having
all four dispatchers (plus `drawRaw()`/`drawSegmentedImage()`) call `hideOtherRawToggleBtns()`
first. Any FUTURE raw-panel toggle button must do the same — add its id to the helper's list.

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
"Fit angle & tol." not "Fit angle & tolerance" (see **sSMLM**). Favour standard, unambiguous
abbreviations (`dist.`, `min`/`max`, `deg`) over truncation that could be misread.

Two-word-joined-by-punctuation labels read `Word/word` with no surrounding spaces (**Save
plot/image**, **View data/filtering**, **Load movie/data**) — matches the compact house style
already used elsewhere (`sigma_x`/`sigma_y`, `min`/`max`). A `+` joining two nouns (as
"View data + filtering" used to) reads as addition/combination rather than an either/or or
belongs-together pairing; `/` is the established connector for that here.

### `label.row` nesting-depth gotcha (indented sidebar sub-rows)

`details.sim>label.row{padding-right:4px}` (keeps a row's numstep +/- buttons flush with every
other row's own right edge) is a DIRECT-CHILD selector — it only matches a `label.row` immediately
inside a `details.sim`, not one nested a level deeper inside a wrapping `<div>` (e.g. a
conditionally-shown sub-group like `#segLoadRow`). Such a nested row still LOOKS indented
(inherits left padding from the wrapper's own `details.sim>*:not(summary){padding-left:14px}`), so
the missing 4px right-padding is easy to miss until compared pixel-for-pixel against a
properly-indented row (a real bug: `segAreaMin`/`segAreaMax`, MODULE: spt, originally lived inside
`#segLoadRow` this way). An indented sidebar sub-row (the `ftmWindowRow` pattern) should instead be
a DIRECT child of its `details.sim`, given its own `id` + inline
`style="display:none;padding-left:40px"` (40px, not 14px, so it still reads as subordinate to a
plain top-level row), shown/hidden by the SAME handler that toggles its sibling group. The opposite
direction breaks the same way: a row placed OUTSIDE any `details.sim` (e.g. `pxnm`, pinned
always-visible) also needs its own explicit `style="padding-right:4px"`.

### Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

### `getBoundingClientRect()` + scroll gotcha (position:fixed elements anchored to an in-flow one)

`#sideToggle`/`#sidePin` (the mobile/floating sidebar drawer's toggle/pin buttons) are
`position:fixed`, but their `top` is `calc(var(--header-content-bottom) - ...)`, where
`--header-content-bottom` is set by `measureHeader()` from
`.header-actions.getBoundingClientRect().bottom` — VIEWPORT-relative, so it shifts as the page
scrolls. A `position:fixed` element itself doesn't move on scroll, so this must store the header's
RESTING position (as if scrolled to the top), not whatever the viewport-relative rect reads at the
moment `measureHeader()` fires. Add `window.scrollY` back: `rect.bottom + window.scrollY` is
scroll-invariant, `rect.bottom` alone is not. A real bug without it: `measureHeader()` also runs on
every `resize` event, and mobile browsers fire a `resize` when their address bar collapses/expands
DURING an ordinary scroll — so a resize firing while scrolled away from the top baked in a deeply
negative `--header-content-bottom`, pushing the toggle permanently off-screen until the next
correct remeasurement. General rule: any `getBoundingClientRect()` measurement feeding a
`position:fixed` element's offset must add `window.scrollY`/`window.pageXOffset` back in.
`--header-h` (a size, not a position) doesn't need this — only `.bottom`/`.top`/`.left`/`.right`
reads do.

### Window resize must always re-fit the reconstruction/raw panels, not just when `atFit`

`refitCanvases()` (the debounced `window.resize`/`ResizeObserver` handler, MODULE: pipeline) used
to only call `fitView()`/`fitRawView()` when `view.atFit`/`rawView.atFit` was still `true` —
reasoned as "don't clobber a user's manual zoom/pan on an unrelated redraw." But `atFit` turns
`false` the moment the user zooms or pans ONCE, and on any real dataset a user almost always does
— so resizing the window stopped re-fitting the reconstruction for the rest of the session after
the first zoom/pan, a real bug. Fixed by making a window/panel RESIZE always re-fit
unconditionally, regardless of `atFit` — a resize reshapes the PANEL, a distinct action from
zoom/pan, so the two shouldn't share a gate. `atFit` is still set correctly by `fitView()`/pan/zoom,
it just no longer gates anything.

### Mobile input font-size vs. label font-size

Below the 860px breakpoint, `input.num`/`select.sel` jump to 16px (iOS auto-zooms on focusing a
smaller input; 16px is the threshold that stops it) while `label.row` text stays at the base 12px
— a real, known, deliberate size mismatch, not a bug to "fix" by shrinking the input back down.

### `<noscript>` + `.textContent +=` gotcha

Never put a `<noscript>` inside an element that JS later reads via `.textContent` (especially
`+=`, which reads-then-overwrites). With scripting enabled, a browser parses `<noscript>...
</noscript>` content as RAWTEXT — a single opaque text node, not real child markup — so
`.textContent` on an ancestor includes that raw text (literal tags and all) even though the
`<noscript>` itself renders as nothing. Reading `.textContent` is harmless; but the moment
something WRITES `.textContent` (as `log()`'s own `.textContent += '\n'+m` does, writing to
`$('logText')`), the noscript element gets destroyed and replaced by one flat text node —
permanently baking that raw warning text into the log's own visible content on the very first
`log()` call, regardless of whether scripting is actually enabled. This was a real, shipped bug:
`#log`'s seed HTML had its own `<noscript>⚠ JavaScript appears to be disabled…</noscript>` (a
redundant, log-local echo of the real disabled-JS warning), and it showed up as literal visible
text with JS fully working. Fixed by removing it — the top-of-`<body>` `<noscript>` banner (a big
red full-page warning, never touched by any JS) already covers the genuinely-disabled-JS case.
General rule: `<noscript>` is only safe near code that reads/writes `.textContent`/`.innerHTML` if
nothing ever WRITES through an ancestor of it.

**Log box / logged-text width split** (`#log`/`#logText`) — the log card's border/background used
to be capped at `max-width:100ch` directly on `#log`, leaving its right edge short of the
reconstruction panel's own edge on a wide window (the cap was meant to keep a wrapped LINE
readable, not shrink the box). Split into `#log` (the outer box — border/background/scroll, no
width cap) wrapping a plain child `#logText` (`max-width:80ch`, matching a standard terminal width)
that holds the actual text. `log()`/`clearLogBtn`/`exportLogBtn` all read/write `#logText`'s
`.textContent` now; `#log.scrollTop` (the outer box) is still what `log()` sets to autoscroll,
since `#logText` has no scrollbar of its own.

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

### `micromanager_plugin/webSMLM_Streaming` (Java) — rebuild locally to test, never commit the jar

Editing any `.java` file under `micromanager_plugin/webSMLM_Streaming/src/` does **not** update
`target/webSMLM_Streaming.jar` by itself — that jar is a build artifact, and a stale one left in
place after a source edit is worse than no jar at all (it silently keeps running the old code,
with no signal that anything's out of date). **Rebuild it locally every time you need to actually
test a Java-source change**:

```sh
mvn package -Dmm.install.dir="C:\path\to\your\Micro-Manager-install"
```

(see `micromanager_plugin/webSMLM_Streaming/README.md`'s own *Building* section for the full
requirements — a local MM 2.0 install for the MM/ImageJ/scijava system-scoped jars, JDK 11+, Maven
3.6+). If `mvn` isn't on `PATH` in the current environment, don't skip the rebuild — compile and
jar manually instead, e.g. via `javac`/`jar` straight out of the JDK, using the same dependency
jars `pom.xml` lists (the MM install's own `MMJ_.jar`/`MMCoreJ.jar`/`ij.jar`/
`scijava-common-*.jar`, plus Java-WebSocket/guava/slf4j-api from `~/.m2/repository` if already
cached there from a prior `mvn` run) — compile all four source files together, then jar up the
compiled classes plus Java-WebSocket's own extracted classes (guava/slf4j-api stay `provided`,
i.e. compile-time only, matching `pom.xml`'s shade config — don't bundle them). Confirm the rebuilt
jar actually contains the change (e.g. `jar tf target/webSMLM_Streaming.jar` lists the expected
classes, or `javap -cp target/webSMLM_Streaming.jar <class>` shows the new/changed method) rather
than assuming the build succeeded.

**`target/` is gitignored — the compiled jar is never committed** (an earlier version of this
plugin shipped it in-tree; dropped on review: a binary rebuilt-and-recommitted on every edit grows
the repo forever with undiffable blobs, and git alone can't prove a committed jar actually matches
the source it sits next to). Distribute a built jar to end users via a GitHub Release asset (or
have them run the `mvn package` command above themselves) instead of expecting one to already be
in the repo.

## Branch & release workflow

- **`main`** is live: it is served by GitHub Pages (`hohlbeinlab.github.io/webSMLM/webSMLM.html`)
  and archived on Zenodo. **`webSMLM_local`** is the dev branch — do work there.
- Only push to `main`, merge, or cut a release **when the user explicitly asks.** Release = commit
  on `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Cadence: **minor bumps (`0.x.0`) → cut a GitHub release + new Zenodo version DOI. Patch releases
  (`0.x.y`) → version bump + push to `main` only, no DOI.**
- Version lives in two spots in `webSMLM.html` (the `.pill` in the `<h1>`, and `#logText`'s own
  seed text — a child of `#log` itself since the box/logged-text width split, see the `<noscript>`
  gotcha section) plus `CITATION.cff`. Dev builds are marked `vX.Y.Z-dev · build YYYY-MM-DDx`;
  clear the dev marker to `vX.Y.Z · proof-of-concept` on release. **Bump the build letter suffix
  (`a`→`b`→`c`…) on every round of changes the user is about to test** — it's the only visible
  signal (pill + log stamp) that a hard-refreshed page is actually running the latest edits, not a
  cached prior build. Past `z` in a single day, roll over spreadsheet-column-style (`z`→`aa`→`ab`…)
  rather than moving to a new date — first needed 2026-08-24, which shipped enough same-day rounds
  to exhaust the single-letter alphabet. **Every build-letter bump also gets its own commit on
  `webSMLM_local`** (no need to ask first — this one's a standing instruction), so each testable
  round has real git history, not just an accumulating uncommitted diff. This is independent of
  releasing: `webSMLM_local` accumulates fine-grained commits continuously; `main` only receives
  them in a batch, at an explicit release, per the cadence above. **Same round: check the
  top-of-file MODULE INDEX comment against a fresh `grep -n "MODULE:"`** and refresh any line
  number that's drifted by more than a few lines — cheap to check every time, and it's the whole
  point of the index that it stays trustworthy rather than becoming another stale comment.
- Every release also updates `CHANGELOG.md` (newest first; DOI column) and, where the release
  closes out or changes a roadmap item, `docs/REFACTOR_PLAN.md`. Pages typically redeploys ~1-2 min
  after a push; check with `gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`.
- **Read the Docs also rebuilds on every push to `main`** as of 2026-08-24 — a GitHub webhook
  (repo Settings → Webhooks, id `669780136`, events: `push`) targets RTD's own incoming-webhook URL
  for this project (`https://app.readthedocs.org/api/v2/webhook/websmlm/331808/`, HMAC-signed with a
  secret held only on the GitHub and RTD sides, never in this repo). No API-based check exists for
  this the way Pages has one (`gh api .../pages/builds/latest`) — after a release, either check the
  RTD project's own Builds page, or confirm the live site reflects the change a few minutes later.

## Reference material

- `README.md` — deliberately short: launch instructions, the guided workflow (kept in sync with the
  in-app **Quick guide** modal's own "Guided workflow" — update both together if either changes),
  data/privacy, scripting/headless, roadmap, distribution/citation, licence. Trimmed of its own
  former "What it does" feature list, performance table, algorithm reference list and "Known
  limitations" section (v0.11.6) — those are fully covered by `docs/DOCUMENTATION.md` (features,
  §9 references) and `docs/REFACTOR_PLAN.md` (limitations/roadmap) respectively now, so keeping a
  third, drifting copy in the README stopped being worth it.
- `docs/DOCUMENTATION.md` — detailed reference for every button/control/`PARAMS` entry, the
  on-disk file formats (settings/calibration/CSV JSON), the headless API/CLI (§8), and every
  algorithm reference (§9) — the place to check or update for exact defaults, ranges and
  behaviour, complementary to the deliberately sparse in-app **Quick guide**.
- `docs/REFACTOR_PLAN.md` — forward-looking roadmap only; shipped-feature history lives in
  `CHANGELOG.md` instead. Think in version numbers, not "phases".
- `experimental_data/` — sample stacks (gitignored large files) with a README of public sources
  and their camera/pixel-size parameters.
- `tools/` — scripting/headless tooling for advanced users, not needed for interactive use:
  `webSMLM-cli.mjs` (Node + Playwright, true headless, the recommended one), `browser_sweep.py`/
  `browser-sweep.sh` (stdlib-only Python / bash, drive a real visible browser for a parameter
  sweep). See each script's header comment and `docs/DOCUMENTATION.md` §8.

## Documentation build
- `docs/DOCUMENTATION.md` is the only authored source for the detailed Read the Docs
  manual. The Read the Docs build is Markdown-native (Sphinx + MyST).
- `docs/readthedocs/build_docs.py` splits `DOCUMENTATION.md` at each level-2 (`##`)
  heading into separate temporary Markdown pages so the published manual has one
  Read the Docs page per major section. It also generates the documentation
  `index.md`/toctree, preserves cross-section references, and adjusts relative
  documentation-image paths.
- Generated files are disposable and **must not be edited or committed**:
  `docs/readthedocs/content/`
  `docs/readthedocs/index.md`
  `docs/readthedocs/_build/`
  Documentation-content changes belong in `docs/DOCUMENTATION.md`; if the generated
  structure, links, or paths are wrong, fix `docs/readthedocs/build_docs.py` instead.
- Documentation images live once in `docs/images/` and are referenced from
  `DOCUMENTATION.md` as `images/...`.
- Read the Docs runs the splitter before Sphinx via `.readthedocs.yaml`. For a
  local strict build from the repository root:
      python docs/readthedocs/build_docs.py
      python -m sphinx -W --keep-going -b html docs/readthedocs docs/readthedocs/_build/html
- If generated documentation is wrong, fix `docs/DOCUMENTATION.md` or, when the
  generation logic itself is responsible, `docs/readthedocs/build_docs.py`.
- **In-app "more info…" popups** (`.hint` divs, the sidebar's own contextual help, distinct from
  both the Quick guide modal and this RTD manual) used to be hand-authored independently of
  `DOCUMENTATION.md` — a real drift risk (both describe the same controls, sometimes citing the
  same papers). `tools/sync_hints.mjs` (plain Node, zero dependencies) fixes this by making
  `DOCUMENTATION.md` the single source: each `.hint` div carries a stable `id="hint-<name>"`; the
  matching content lives inside a `<!-- HINT:<name> --> ... <!-- /HINT:<name> -->` marker in
  `DOCUMENTATION.md` (right after that control group's PARAMS table in §2), as **raw HTML**
  deliberately, not Markdown — byte-identical in both places, no Markdown→HTML conversion step to
  itself go stale. Edit a hint's content ONLY inside its `DOCUMENTATION.md` marker, then run
  `node tools/sync_hints.mjs` (rewrites `webSMLM.html`'s `.hint` divs to match, reindented flat) —
  never hand-edit a `.hint` div directly, it'll be overwritten on the next sync. `--check` exits 1
  without writing if `webSMLM.html` would change, for a pre-commit/CI-style drift check. The
  `<span class="pill">module: X</span>` label at the top of each `.hint` div is NOT part of the
  synced content (kept as fixed markup in `webSMLM.html`). All 12 `.hint` divs
  (`hint-memory`/`hint-liveStreaming`/`hint-simulation`/`hint-pcfo`/`hint-calibration`/
  `hint-detectfit`/`hint-export`/`hint-render`/`hint-drift`/`hint-locprecision`/`hint-sSMLM`/
  `hint-spt`) use this mechanism. Each
  marker is placed as the INTRO to its DOCUMENTATION.md section, right after the PARAMS table — the
  surrounding prose picks up only where the popup leaves off, not restating it.
- **Quick guide** (the in-app modal, `helpBtn`) is deliberately thin: just the intro blurb, the
  5-step **Guided workflow** (step 2 briefly names the fit-method families and points at the docs
  for depth), **Acknowledgements**, and **License & author** — no per-module walkthrough, no
  citation list; `docs/DOCUMENTATION.md` (§9 "References & further reading" for citations) is the
  maintained source for that depth now, and `DOCUMENTATION.md` is what the `.hint` popups link to
  when they need to point somewhere. The modal's own text is hand-authored UI copy, not synced by
  `sync_hints.mjs` (that mechanism only covers `.hint` divs). `README.md`'s own "Guided workflow"
  section is kept as a copy of this same 5-step list — update both together — see **Reference
  material** below.