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

  `addNumberSteppers()` (runs once, right after `syncParamControls()`) wraps every `input.num`
  in a `.numstep` span with an appended `.numstep-btns` −/+ pair — Inkscape-style, always visible,
  not the browser's own native number-input spinner. Native was tried first (a genuine one-line
  global toggle, `color-scheme:dark`/`light` set per UI theme so the browser draws its own control
  theme-appropriate — that CSS stayed, it's harmless/useful for other native controls too) and
  reverted: look varies across engines, and it's hover-reveal only, effectively unreachable on a
  touchscreen with no hover state. `addNumberSteppers()` reads each input's already-present
  `min`/`max`/`step` — set by `syncParamControls()` for `PARAMS`-mapped fields, or plain static
  HTML attributes for the ones `PARAMS` deliberately excludes (`calFirst`/`calLast`/etc., see
  above) — so it needs no per-input wiring either: any current or future `.num` field gets
  steppers for free. Clicking dispatches real `input`/`change` events, so every existing listener
  (live preview, Save/Load Settings, …) reacts exactly as it would to typing. `input.num` itself
  is left-aligned (not right) and narrower (64px, was 80px) to match — value first, then the
  control that changes it, reading left to right, with no wasted width now that nothing overlays
  the digits.

  **Trailing "/N" text next to a numstep-wrapped field needs its own `vertical-align:middle`.**
  `.numstep` itself is `display:inline-flex;align-items:stretch;vertical-align:middle` (see the
  `<style>` block), so it renders TALLER than a plain text baseline — a plain `<span>` sitting
  right after it (e.g. the Frame scrubber's `#scrubTotal`, showing "/ total frames" next to
  `#scrubNum`) inherits ordinary baseline alignment by default and renders visibly LOWER than the
  numstep group's own vertical centre, a real, reported bug. Fix: give that trailing span its own
  `vertical-align:middle` too, matching `.numstep`'s. The same trailing span also gained a space on
  each side of the `/` (` / 20000`, not `/20000`) in the same round, by request — plain spaces are
  safe here since the parent already carries `white-space:nowrap`.

  **`pxnm` ("Pixel size (nm)") is pinned outside any collapsible `<details>`** — it used to sit
  inside the collapsed-by-default "Localisation settings" section, easy to never notice despite
  feeding the scale bar, z, and every exported CSV coordinate. Now a plain always-visible row in
  the sidebar's top `.group`, before "Memory & streaming" — a pure DOM relocation (same `id="pxnm"`,
  same `PARAMS` entry), so `syncParamControls()`/`paramValue()`/`addNumberSteppers()`/the existing
  `change` listener (`lastResult.px=...; rerender(true);`) all keep finding it by id with zero other
  code changes. Gain/Camera offset deliberately stay inside Localisation settings for now. Because
  this row sits OUTSIDE any `details.sim`, it doesn't match the `details.sim>label.row{padding-
  right:4px}` direct-child selector every other row relies on for numstep alignment — fixed with an
  explicit inline `style="padding-right:4px"` (same root cause as the `label.row` nesting-depth
  gotcha below, opposite direction: that one is nested too DEEP, this one sits OUTSIDE entirely).
- **in/out** — TIFF parsing; in-memory vs. streamed loading; contiguous ImageJ stacks are indexed
  arithmetically, multi-IFD (Micro-Manager MMStack) stacks by walking the IFD chain. Handles
  multi-GB files via `File.slice()` (never fully loaded). A multi-file selection (Ctrl/Cmd+click)
  goes through `loadTiffFilesAuto()`, which auto-detects which of two combining strategies
  applies — no separate UI control for this, it's inferred from `files[0]`'s own frame count, same
  "file[0] sets the rules the rest must match" convention already used for width/height: exactly 1
  frame → `loadTiffSequence()` (natural-sorted, one file = one frame — e.g. GATTAquant's
  per-frame camera dump); more than 1 → `makeConcatStack()` (each file loaded normally via
  `loadTiffFile()`, so each keeps whichever strategy — in-memory/sliced/streamed — its own size
  calls for, then concatenated end-to-end) — for one continuous acquisition split across several
  files purely by size, a DIFFERENT scenario from the per-frame case despite both starting from a
  multi-file selection. `makeConcatStack()` only implements `getFrames()` (never `getFrame()`,
  same convention as `makeCroppedStack()`/`makeFtmStack()`), routing a requested range across
  however many component stacks it spans via a prefix-sum frame-count table. Same `loadTiffFilesAuto()`
  entry point backs the interactive file input, calibration loading, and the headless
  `cfg.files`/`cfg.calibrationFiles` config (see **pipeline** below) — one detection path, three
  callers. Multi-file selection filters candidates by SNIFFING the real TIFF magic bytes
  (`isTiffFile()`, "II*\0"/"MM\0*") rather than trusting the filename extension — needed because
  some tools export (or a user renames) a TIFF stack with a non-.tif extension (`.nd2`, in the
  real case that found this: `experimental_data/example_stack100.nd2`, an ImageJ TIFF export from
  Christophe Leterrier's DECODE_NC repo, real bytes despite the name — see
  `docs/REFACTOR_PLAN.md`'s ND2 entry); the `#file` input's `accept` attribute lists `.nd2`
  alongside `.tif`/`.tiff` for exactly this. `loadTiff()`/`loadTiffFile()`'s fast path/
  `loadTiffSequence()`'s `decodeOne()` all additionally validate the raw ImageWidth/ImageLength
  tags (`t256`/`t257`) are present and positive before trusting a `UTIF.decode()` result — UTIF
  returns one EMPTY ifd object (no exception, no empty array) for genuinely non-TIFF bytes, so
  without this a real native ND2 binary (or any other unsupported format) would silently produce
  `NaN` dimensions instead of a clean error. Check `t256`/`t257`, NOT `.width`/`.height` — those
  are only set as a side effect of `UTIF.decodeImage()`, so checking them beforehand silently
  checks `undefined>0` and rejects every file, valid or not (a real regression, caught immediately
  by testing against the sample above rather than shipped). **Native Nikon ND2** (the genuine
  proprietary binary format, distinct from the TIFF-in-disguise case above) is also supported,
  shipped v0.11.2, **experimental** — no official spec exists, so this is a from-scratch decoder
  validated against only two real sample files (`experimental_data/*.nd2`, see
  `experimental_data/README.md`) plus one independent reference-library cross-check, not a broad
  corpus: `isNd2File()` sniffs the real magic (`0x0ABECEDA` LE u32 at byte 0) and
  `loadTiffFile()`'s first line dispatches to `loadNd2File()` — reaching all three existing callers
  (interactive, calibration, headless) with no caller-side changes, same "one detection path,
  three callers" precedent as the TIFF sniff above; `loadTiffFilesAuto()` also special-cases a lone
  `.nd2` selection (multi-file ND2 concatenation isn't supported yet). Reverse-engineered directly
  from those real bytes, not ported from any GPL reader. The file is a flat run of 16-byte-header
  chunks (`magic+dataOffset+dataLen+4 reserved`, then a `!`-terminated name, then payload), each
  padded to the next 4096-byte boundary; `readNd2ChunkHeader()` walks the WHOLE chain from byte 0
  to index every `ImageDataSeq|N!` frame offset — no shortcut, since the required
  `ImageAttributesLV!` metadata chunk sits near EOF, after all frame data (metadata chunk count is
  frame-count-independent, so cost scales with per-frame header count only). Each `ImageDataSeq|N!`
  payload is a 24-byte (`ND2_FRAME_HEADER_BYTES`) per-frame sub-header (contents unidentified,
  never parsed) THEN the pixel array — **the shipped parser initially had this backwards** (pixels
  assumed at byte 0, a trailer assumed after instead), which decoded without throwing
  (dimensions/frame-count stayed self-consistent) but silently corrupted row 0's first ~6 pixels
  into implausible spikes; caught from a live screenshot, confirmed/fixed by cross-validating
  byte-for-byte against the independent BSD-3-Clause `tlambert03/nd2` reference. **Get this offset
  wrong again and nothing will throw — only pixel VALUES will be wrong.** `parseNd2LvField()`
  recursively decodes Nikon's own binary key-value ("LV") format for `ImageAttributesLV!`/
  `ImageCalibrationLV|0!`: a container (type `0x0b`) holds `childCount(u32)+byteLen(u64)` then
  recurses exactly `childCount` times — **`byteLen` must never be used as the parse boundary**, it
  can include trailing padding and produce a bogus extra read with a garbage type byte. String
  fields (type `8`) are **null-terminated UTF-16LE with no length prefix**, unlike field names
  (explicit `nameLen`). `getFrames(s,e)` decodes each frame at its OWN explicit stored offset
  (never back-to-back — a chunk header+name sits between payloads). Pixel calibration
  (`ImageCalibrationLV|0!`'s `dCalibration`) and two more bonus metadata chunks —
  `CustomData|AcqTimesCache!` (per-frame timestamps → a MEDIAN-of-diffs frame-interval estimate,
  robust to a couple of near-zero leading placeholders seen in real files) and
  `CustomData|STORM_CAM_DATA_SHEET_XML-V1!` (camera model/bit-depth/ADU, informational only — NOT
  wired to `gain`/`camoffset`, since it's the camera's static datasheet figure, not the
  acquisition's actual EM gain setting) — are all logged, never auto-applied, matching this
  project's compute-once/apply-separately convention (NeNA→SPT, PCFO's Transfer estimates).
  Multi-channel and non-16-bit files throw a clear unsupported-format error. TIFF gets the
  analogous treatment via `tiffScaleHint(ifd0, desc)` (called from all three TIFF-decoding call
  sites): reads `finterval=` from the same `t270` description text already parsed for `images=N`,
  and — only when the description's `unit=` field says micrometers — `t282`/`t283`
  (XResolution/YResolution) for a pixel-size estimate; `t296` (ResolutionUnit) is deliberately
  never consulted, since ImageJ leaves it at 1 and puts the real unit in the description text
  instead. Two real ImageJ exports spell micrometers two different ways — `unit=micron` and a
  literal `unit=µm` (the SEVEN ASCII characters backslash-u-0-0-B-5-m, not an actual µ character,
  an ImageJ/Java encoding quirk only caught by inspecting the real string) — both recognised. All
  of this is genuinely log-only, no "Apply" button, by deliberate choice: one bundled sample's
  filename implies a 50 ms frame time but its own embedded `finterval` says 5 ms — that kind of
  conflict needs a human, not an auto-fill. `makeCroppedStack()`
  (raw-panel crop tool, `rawCropBtn`) is the simplest of this module's stack wrappers: it slices
  every fetched frame to a fixed `[x0,x1)×[y0,y1)` sub-rectangle and REPLACES the module-level
  `stack` with it (kept in `originalStack` while active, restored on "uncrop") — deliberately a
  full stack swap, not a search-region restriction threaded through detect/fit, so nothing
  downstream needs a coordinate offset added back and every consumer (FTM below, calibration,
  PCFO, workers, render/export) just sees a smaller stack the same way it'd see any smaller loaded
  file. Deselecting `rawCropBtn` while `lastResult` exists (i.e. there's a Run's worth of
  downstream results computed from the cropped region only) confirms first —
  `resetAfterCropChange()` erases `lastResult` (and sSMLM pairing state, same reset every fresh
  Run/Load/Simulate does) unconditionally, no undo, and this button sits right next to the raw
  panel's own title where a misclick reading something else in that panel is easy. FTM (`ftmEnabled`/
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
      phase, or a run with substantial FTM time would look artificially starved. Each chunk's
      detect/fit phase resolves its own `await new Promise(...)` via a `finishChunk()` that MUST
      check `shouldStop()` itself, not just rely on `dispatchChunk()`'s own `shouldStop()` bail-out
      — a real, reported bug (Stop during a Run with FTM+the worker pool both active would hang
      forever instead of stopping): every worker's `dispatchChunk()` returns immediately once
      `shouldStop()` is true, without ever advancing `cNext` to `coreEnd`, so a `finishChunk()`
      that only checked `cInflight===0 && (err||cNext>=coreEnd)` (missing the `shouldStop()` OR
      term the equivalent non-FTM loop's own `finish()` already had) saw `cInflight===0` but
      neither of the other two conditions true, and never called `resolveChunk()` — stalling the
      whole Run inside that `await`, not just skipping the rest of one chunk. Fixed by adding
      `shouldStop()` to `finishChunk()`'s own condition, matching `finish()`. A related, smaller
      bug fixed alongside it: stopping THIS early (before any detect/fit batch ever completed)
      left `tDetect+tFit===0`, and the timing log's percentage helper floors its denominator to
      `1e-9` to avoid `0/0`, so a genuine nonzero FTM time divided by that floor printed an absurd
      percentage (~2×10¹³%) instead of an honest "n/a" — the floor is now only used for the actual
      division, while a separate unfloored check decides whether to print a percentage at all.

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
- **fit** — phasor (fast, non-iterative), least-squares 2D-Gaussian, and Poisson-MLE 2D/3D/
  Elliptical (`gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`; `gaussianMLEspheric` is the
  default) localization. All fitters take `gain,camoff` and convert every pixel to true photon
  units — `(raw-camoff)*gain` — before fitting, matching Picasso's architecture; position/width/
  ratio outputs are provably invariant to this affine transform (LS/phasor), while MLE's Poisson
  likelihood and CRLB (`lpx`/`lpy`) are only statistically correct when fit in photon units, so
  this is the one place gain/offset actually change a result rather than just rescaling it.

  **Shared MLE accumulator**: `gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled` all run on
  ONE Fisher-scoring Newton driver, `mleNewtonFit(n, th, mstep, clampFn, ..., modelFn)` — before
  this existed, `gaussianMLEspheric` and `gaussianMLEelliptic` were two independently hand-written copies
  of the exact same loop, only their per-pixel MODEL (one shared σ vs independent σx/σy)
  differing. Checked directly against Picasso 0.11.0's own `picasso/fitting/gaussfit.py` (not
  assumed) before doing this: its `_estimator_terms(mle, value, data, var)` dispatch, reused
  across its SPHERICAL/ELLIPTIC/ROTATED models, is the SAME Fisher-scoring shell webSMLM's own
  `inv=1/model; cf=data*inv-1; hess+=du·du·inv` already implemented — confirmed algebraically
  equivalent, not just "similar" — so this refactor only had to extract that existing math once,
  not invent a new formulation. `modelFn(px,py,th,duOut)` returns the per-pixel model value and
  writes its Jacobian into a REUSED scratch array (the original code allocated a fresh `du` array
  per pixel; this is strictly cheaper, not just deduplicated) — `mleModelSpherical`/
  `mleModelElliptical` are erf-pixel-integrated (unchanged math, just extracted); the driver
  itself never needs to know what a parameter MEANS, only how the model responds to it, so a
  third/fourth model plugs in without touching the driver. `gaussianFit` (LSQ, Gauss-Newton +
  backtracking line search) is deliberately NOT part of this unification — different per-pixel
  weighting (plain squared residual, no `1/model` term) and a different outer solver, so folding
  it in isn't the same small, low-risk change the MLE-side refactor is.

  **`gaussianMLEellipticangled`** (`'gaussmleEll'`, "Gauss MLE 3D rotated elliptical" in the UI —
  renamed alongside `gaussianMLE`→`gaussianMLEspheric`/`gaussianMLEastig`→`gaussianMLEelliptic` to
  match Picasso's own SPHERICAL/ELLIPTIC/ROTATED naming, no behavior change from the rename itself)
  adds a genuinely new model: `[x,y,N,bg,σx,σy]` plus a rotation angle, either FIXED (6 free params, reusing
  `mleModelElliptical` with pixel offsets pre-rotated by the constant once, before the loop — same
  size/stability class as `gaussianMLEelliptic`, no angle Hessian row at all) or FREE (7 free params,
  angle is θ[6]). Motivated by sSMLM: every OTHER 2D method fits one symmetric σ, so `sigma1st`
  (see **sSMLM** below) was never a real directional measurement of the spectrally-smeared 1st
  order, just the closest available proxy. POINT-SAMPLED (`value=amp·exp(-½(arga²/σx²+argb²/σy²))
  +bg` at the pixel CENTER), not pixel-integrated like the other two models — a rotated Gaussian
  doesn't factor into closed-form per-axis erf integrals the way an axis-aligned one does; matches
  Picasso's own `_accumulate_rotated` formula exactly (read directly from its source), which uses
  the same point-sampled simplification for the same reason, not a shortcut invented here. `photons`
  is the amplitude converted to a true integrated photon count (`amp*2π·σx·σy`, same relation
  `gaussianFitElliptical` already uses for its own peak-amplitude elliptical model) — NOT the raw
  θ[2] amplitude the point-sampled model actually optimizes internally (`amp` is reported
  separately); an earlier version of this returned the raw amplitude as `photons` directly, caught
  by a synthetic test with a known integrated photon count before shipping — would have silently
  under-reported photon counts by the `2π·σx·σy` factor for every downstream consumer (CSV, table,
  any photon-weighted statistic). Free-angle mode has a real, documented gotcha carried over from
  Picasso's own model: the angle derivative vanishes identically when σx==σy, singularising the
  Hessian — the seed deliberately breaks that symmetry (`σx0=1.05·σ0, σy0=0.95·σ0`) whenever angle
  is free; a fixed angle never enters the optimisation, so this doesn't apply there. An
  unconstrained (σx,σy,angle) fit also has a real, expected 4-way degeneracy (swapping σx↔σy and
  adding ±90°/±180° to the angle describes the identical physical ellipse) — not a bug, confirmed
  by comparing a synthetic recovered fit against all 4 equivalent parameterisations, not just the
  raw angle value.

  **`PARAMS.localize3D`** ("3D localisation?", default checked) is the switch between the two angle
  modes, and is the ONLY thing that decides FIXED vs. FREE for `'gaussmleEll'` — there is no
  separate per-method setting. `updateMethodUI()` only shows the checkbox's row
  (`localize3DRow`) for `mle3d`/`gaussmleEll` (the two methods it actually affects); unchecked:
  angle FIXED at `paramValue('sSmlmAngleCenter')` (degrees → radians) — the sSMLM pairing step's
  own already-calibrated dispersion bearing (see **sSMLM**'s `fitSSmlmAngle()`) — and no z is
  computed (today's original sSMLM-only path, `wcal` stays `null` regardless of whether a
  calibration is loaded). Checked (the default): angle FREE (7 free params, recovers a genuine
  per-emitter rotation angle) AND — if a `gaussian_width` calibration is loaded — z is computed
  from the fitted `(σx,σy)` via `zFromWidths()`, the exact same call `mle3d` itself makes; this is
  the astigmatism-axis-alignment diagnostic noted below, now wired up rather than a stated
  follow-up: run `'gaussmleEll'` (checked) against real 3D calibration bead data and read back a
  genuine per-emitter angle instead of assuming axis alignment. `runCore()`
  computes `sSmlmAngleRad` as `config.localize3D ? null : (config.sSmlmAngleCenter||0)*Math.PI/180`
  — `null` selects free mode inside `gaussianMLEellipticangled` (its own default parameter),
  passed through to the worker payload alongside `zcal`/`wcal` unchanged; `showFrame()` keeps its
  own matching copy for live preview. The FIXED-angle chicken-and-egg gap (caught in review): the
  angle can only be FIT from an already-localized dataset's own pair geometry (position-only, needs
  no width info — any method works for that first pass), so unchecking `localize3D` for
  `'gaussmleEll'` is only meaningful as a SECOND Localize, after a first pass with a symmetric
  method feeds **Preview pairs**/**Fit angle & tol.** `sSmlmAngleCenter` defaults to 0°, and unlike
  `mle3d` there's no calibration file to hard-gate on for the fixed-angle path — a genuinely unset
  angle is indistinguishable from a real 0° bearing, so `runCore()` can only warn (`onLog`, once per
  Run, gated on `!config.localize3D`, same "flag a likely-forgotten setting, don't block" spirit as
  the gain-1/offset-0 warning elsewhere), not refuse, when `config.sSmlmAngleCenter` is still
  exactly its default. Free mode fits its own angle per emitter, so the warning doesn't apply there.

  `mle3d` itself also respects `localize3D`: unchecked, it's an axis-aligned elliptical 2D fit
  (`gaussianMLEelliptic`, angle implicitly 0) with no calibration requirement and no z — genuinely
  useful on its own now that **export**'s `sigma_x`/`sigma_y [nm]` CSV/table columns (see below)
  expose the per-axis widths directly, not just through sSMLM pairing. Checked (default), behavior
  is unchanged from before this control existed: calibration required (`run()`'s `needCal` guard,
  mirrored in `analyze()`), z computed via `zFromWidths()`. `run()`'s own `wcal` — and `analyze()`'s
  `wcalForRun` — are only ever built when `localize3D` is checked AND a `gaussian_width` calibration
  is present; `wcal`'s mere presence (not a second explicit flag) is what `runCore()`/the worker/
  `showFrame()` use to decide whether to call `zFromWidths()` at all, for both methods alike.

  **`updateMethodUI()` (MODULE: pipeline) resets the render colour map to Fire for `mle3d`/
  `gaussmleEll` too when `localize3D` is unchecked** — a real, reported bug: `updateMethodUI()`'s
  `is3d` branch sets `lut='turbo'` the moment either method is selected WITH `localize3D` checked
  (a sensible depth-friendly default); its sibling `else` branch already reset `lut` back to
  `'fire'` for `phasor`/`gaussmle` (see **render**'s LUT-default note), but originally left `mle3d`/
  `gaussmleEll` out — so unchecking `localize3D` after having had it checked left whatever
  turbo/hsvBlue choice the 3D state had set stuck in place on a plain 2D reconstruction with no z at
  all. Fixed by adding both to the `else` branch's reset condition; no extra `localize3D` check
  needed there — `is3dMethod&&localize3D` being false is the ONLY way either method reaches that
  branch, so being one of the two there already implies `localize3D` is unchecked. `gaussls` stays
  deliberately excluded from the auto-reset, unchanged.

  The `cal3dRow` "Load calibration…" control moved (from below the frame-range fields) to directly
  under `localize3DRow`, and only shows while BOTH `localize3D` is checked (or the method is
  `phasor3d`, which has no such checkbox) AND no calibration is active yet (`cal3d||cal3dW`) —
  `updateMethodUI()` re-runs after every calibration load/compute (`updateCalStatus()` calls it) so
  the box disappears the moment one lands. There's deliberately no in-page "replace calibration"
  affordance yet; a fresh page load or Load-settings round-trip is the reset path.
- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting. `LUT_CPS` control-point maps: `fire`/`inferno`/`viridis`/`turbo` are smooth
  hue ramps for continuously-varying data (intensity, real 3D depth); `hsvBlue` is a closed-loop
  full hue cycle (240°→cyan→green→yellow→red→magenta→violet→240° again, saturation/value pinned to
  1) matching a colour scheme from the sSMLM paper's own figures — unlike every other map here it's
  cyclic, so BOTH ends of the mapped range land on the same hue (blue) by design, not an artifact
  to fix; **Pair** auto-selects it. `drawDepthBar()` (the on-canvas colour-scale strip) anchors to
  the actual DATA's own right edge and vertical centre (`srFull._locMaxXpx`/`_locMidYpx`, cached
  once per `rerender()` in NATIVE px — not rescanned on every pan/zoom redraw — then converted
  through the current `view`/zoom on each draw), falling back to the bare top-right canvas corner
  only if there's no cached extent. A fixed corner alone looked disconnected: sSMLM's paired
  reconstruction is often a sparse subset of a much larger FOV, so the bar could end up floating in
  empty space far from the actual content it's meant to label. Ticks/labels extend left (into the
  panel) so they're never clipped by the canvas edge.

  `renderSuperRes()`'s accumulator buffers are DENSE, not sparse — one value per super-resolution
  pixel across the WHOLE `(w×mag)×(h×mag)` grid regardless of localization count, so memory scales
  as O(w·h·mag²), completely decoupled from data volume. `checkRenderSize()` runs before any
  allocation: refuses (throws) if either side would exceed `CANVAS_MAX_DIM` (16384, a hard
  per-browser canvas-creation wall) or if the estimated concurrent footprint (count/z accumulators,
  `blur()`'s scratch, the final `ImageData`, the canvas backing store) exceeds `memgb` — the SAME
  "Memory budget (GB)" setting stack loading uses, not a second one. `rerender()` catches the
  throw, logs what to change, and leaves the PREVIOUS `srFull` on screen rather than blanking; the
  headless `analyze()` path lets it propagate. The count accumulator (`acc`) is `Uint16Array`, not
  `Float32Array` (a hit count is always non-negative, halving the footprint); `zacc` (summed z,
  fractional) stays `Float32Array`. `Uint16Array` WRAPS silently past 65535 on a naive `+=1`, so the
  increment is guarded explicitly (`if(acc[idx]<65535) acc[idx]++`) with a one-line saturation
  warning, rather than risking silent density corruption on an extreme pile-up.

  `setupPlot(cv, isPlot=false)` (shared by every draw function on the raw/sr canvases) letterboxes
  a fixed 4/3 sub-rectangle, centred within the panel's own box, for plots — rather than changing
  the canvas's own size (a CSS-`aspect-ratio` approach was tried first and rejected: since CSS Grid
  stretches both cards in a row to match whichever sibling is taller, a panel's height ended up
  depending on whatever the OTHER panel was showing). The canvas's own CSS box always tracks
  `--frame-ar` (the loaded movie's own w/h), same as a real frame/reconstruction view, so a panel's
  height never changes depending on what it or its sibling shows; `isPlot=true` fills the whole
  canvas with `plotColors().bg`, computes a centred 4/3 sub-rect, stashes the offset in
  `_plotLetterboxOx/Oy`, and `ctx.translate()`s to it before returning the sub-rect's own W/H as if
  it were the whole canvas — so every plot-drawing function's own `{ctx,W,H}`-from-`(0,0)` code
  needed zero changes. `registerPlotHover()` folds the same offset into the `mL`/`mT` a caller hands
  it (once, centrally), since `drawPlotHover()`'s hit-testing reads real, untranslated
  `clientX`/`Y`. `drawRawView()`/`drawView()` never pass `isPlot`, so they keep filling the panel's
  full box as before.

  `.panel-body` (wrapping a canvas with its own trailing controls — `#scrubRow`/`#srFilterNote`/
  `#calViewRow`) is top-aligned, NOT centred, since raw/sr canvases are now always the same height
  (both track `--frame-ar` unconditionally) — centring each panel's own canvas+controls group
  independently shifted the two canvases out of vertical alignment by roughly half of whichever
  trailing control only one panel has at a given moment. Top-aligning puts both canvases flush
  against their own `h4`, so any leftover height from a trailing-content difference lands invisibly
  at the bottom of the shorter card instead of visibly offsetting its canvas.

  Every plot function reads colours from `plotColors()` (`{bg,grid,text,axis,bar}`) rather than a
  hardcoded hex value, driven by a module-level `_plotExportMode` flag. `false` (the normal,
  on-screen case) reads the values LIVE via `getComputedStyle(document.documentElement)` for
  `--panel`/`--line`/`--muted`/`--fg`/`--accent` — so plots automatically track whichever of the
  app's three UI themes (dark/light/contrast, see **params**' `applyTheme()`) is currently active,
  with no second palette to keep in sync by hand. `true` — a completely separate, FIXED light
  palette, independent of the UI theme — only inside `exportPanel()`'s "plot" branch, which flips
  the flag, redraws once via the panel's `_replotRaw`/`_replotSr`, snapshots via `cv.toBlob()`, then
  flips back and redraws again: a saved PNG reads better on a white background once pasted into a
  report regardless of which theme you're viewing the app in, so this branch never changes. A few
  accent colours (fit-line green/red/magenta, the exponential-fit orange, marker red) stay
  hardcoded across every theme AND the export palette, chosen to read clearly against any of them —
  verified visually against the contrast theme specifically when it shipped, since that palette
  wasn't designed against a pure-black/pure-white extreme the way dark/light were. Raw-frame/
  reconstruction overlays (ROI boxes, fit crosshairs, the scale bar, the depth-colour bar) and the
  `LUT_CPS` reconstruction colour-map dropdown are deliberately UNTOUCHED by the UI theme — they sit
  on top of arbitrary image/data pixels, not a themeable panel background, so a light UI theme
  wouldn't make the *frame* or *reconstruction* pixels lighter; `drawPlotHover()`'s tooltip is the
  same way, on purpose, despite overlaying theme-aware plot panels — it's the SAME function used for
  the raw-frame pixel-value hover readout (`fmtRawPixel`), which does sit on arbitrary image
  content, so it keeps one fixed high-contrast-against-anything box rather than becoming
  theme-aware for the plot case alone.

  **"Save plot / image"** (`saveImgBtn`, one button — export module) offers SVG as well as PNG,
  but ONLY for the 7 genuinely plot-shaped panels (calibration, drift, NeNA, FRC, PCFO,
  line-profile, the shared histogram) — never the raw frame or SR reconstruction, which are real
  pixel-density data with no meaningful vector form at real localization counts. There is no
  separate SVG button or in-page format picker: for a plot, `exportPanel()` delegates to
  `exportPlotEither()`, which renders BOTH a PNG blob and an SVG string ahead of time (both are
  cheap — one extra plot redraw each) and hands them to `savePlotEither()`, which opens ONE native
  `showSaveFilePicker()` dialog listing both "PNG image" and "SVG image" as `types` — the OS/browser
  dialog's own "Save as type" dropdown becomes the format picker, no custom UI needed. Since the
  handle it returns has no separate "which type was picked" field, the actual format is read back
  from the resolved file handle's own extension (`/\.svg$/i.test(h.name)`) to decide which of the
  two pre-rendered payloads to write. Falls back to PNG when no native picker is available (Safari/
  Firefox, or `file://` without picker support) — there is no in-page SVG option in that fallback.
  A raster panel (`exportPanel()`'s own, unchanged path) still calls the single-type `saveBlob()`
  helper as before — `savePlotEither()` is a second, plot-only sibling to it, not a replacement.

  `SvgRecordingContext` (render module, next to `setupPlot()`) is a small, purpose-built class that
  duck-types the exact Canvas2D surface those 7 functions use (paths/rects/circles/text/save/
  restore/translate/rotate/clip — no gradients, patterns, images or curves, none of which any of
  them call) and records real SVG DOM nodes instead of painting pixels — written from scratch
  rather than vendoring a general-purpose canvas→SVG shim, matching this project's own repeated
  preference for a small tailored implementation over a dependency carrying capability nothing here
  needs. `save()`/`translate()`/`rotate()` each push a FRESH nested `<g>` rather than mutating the
  current group's own `transform` — an SVG transform applies to ALL of a group's children, so
  mutating an already-populated group would retroactively move siblings drawn *before* the call
  too; pushing a new group per transform and having `restore()` truncate the stack back to the
  depth recorded at the matching `save()` reproduces real canvas transform-scoping exactly.
  `makeSvgPlotCanvas(w,h)` wraps a `SvgRecordingContext` as a plain object duck-typing the slice of
  `HTMLCanvasElement` that `setupPlot()` itself touches (`clientWidth`/`clientHeight`/`width`/
  `height`/`getContext`) — so `setupPlot()` and all 7 plot functions run completely UNCHANGED
  against it, no SVG-specific drawing code duplicated anywhere. The redirection itself is one
  module-level `_plotTarget` variable, consulted by each plot function's own hardcoded
  `setupPlot($('raw'|'sr'), true)` call (`_plotTarget||$('raw')`) — `null` normally (real DOM
  canvas), set only for the duration of the SVG render inside `exportPlotEither()`; the PNG render
  in the same function still screenshots the real on-screen canvas directly (matching the original
  single-format path's behaviour), so the on-screen view is only ever touched during the PNG
  redraw/restore, never during the SVG one. Reuses `_plotExportMode`'s light export palette (same
  reasoning as PNG: reads better pasted into a paper/report) and the existing `saveImgModal`
  left/right chooser when both panels have content — that chooser only decides WHICH window, not
  format; format is decided downstream by whichever of `exportPanel()`/`exportPlotEither()` the
  chosen window resolves to. SVG `<text>` stays real, editable text (not converted to outlines), so
  it re-renders with whatever font is available on the *viewing* system — a known, accepted
  trade-off versus PNG's baked-in glyph pixels, not something this solves.

  **UI colour theme** (`applyTheme(name)`, params module, `dark`/`light`/`contrast`) is set via
  `[data-theme]` on `<html>`, driving ~17 CSS custom properties (`--bg`/`--panel`/`--line`/`--fg`/
  `--muted`/`--accent`/`--accent2`/`--warn`/`--danger`(+`-hover`)/`--surface`(+`-hover`)/`--deep`/
  `--scrollbar-thumb`(+`-hover`)/`--shadow`/`--scrim`/`--row-stripe`/`--accent-tint`) that the whole
  `<style>` block reads from instead of hardcoded hex — three small icon buttons in the header's
  `.header-actions` (next to `layoutToggleBtn`, same area) switch it, `.active` marking the current
  one. Persisted via `localStorage` (a genuinely new mechanism for this project — Save/Load Settings
  is explicit JSON file export/import, not localStorage; still 100% client-side, so no conflict with
  the single-file/no-upload design) — every access wrapped in `try/catch`, since some browsers/
  extensions block storage entirely: a failed read falls back to `'dark'` (this app's only theme
  before this existed, so behaviour for a blocked-storage visitor is unchanged from before), a
  failed write is silently ignored (the theme still applies and works for the rest of the session,
  it just won't be remembered next visit) — no error ever surfaces to the user either way. A tiny
  separate inline `<script>` right after `</style>` (before `<body>`) pre-sets `[data-theme]` from
  the same key before first paint, purely to avoid a flash of the wrong theme; `applyTheme()` itself
  re-derives and re-applies the same value once the main script runs, so that snippet is
  belt-and-suspenders, nothing depends on it. Deliberately NOT a `PARAMS` entry — `PARAMS` already
  states it "deliberately excludes pure display/layout (CSS)" (see **params** above), and theme
  choice is exactly that, same as sidebar collapsed/floating state.

  **Quick guide** (`helpBtn`, renamed from "Help & guide") sits in the sidebar sharing `#tableBtn`'s
  own row, right of **View data + filtering**, styled with its own bespoke `.helpbtn` look (a
  surface+accent-border+accent-text combo, distinct from a plain default button) — see
  `CHANGELOG.md`'s v0.11.6 entry for the header-relocation detour this went through before landing
  here. `wireHelp()` finds it by `id="helpBtn"`, position- and class-independent.

  **`webSMLM_lastVersion`** (localStorage, right after the theme-init block above, same try/catch
  fail-safe) is a sibling of `webSMLM_theme` for a different purpose: on load, it parses the
  release number (`vX.Y.Z`) out of the `<h1>` pill's own text and compares it against whatever was
  previously saved for this browser, logging one line — `webSMLM updated: vA.B.C → vX.Y.Z — see
  what's new: <link to CHANGELOG.md on GitHub>` — when they differ, since the single-file/
  no-auto-update design otherwise gives a returning visitor no signal that anything shipped between
  visits. Deliberately parses only the leading `vX.Y.Z`, never the full pill text: the pill also
  carries a `-dev · build YYYY-MM-DDx` suffix while a release is in progress (see the branch/
  release workflow below) that changes on every build-letter bump — comparing the full string would
  fire this on nearly every reload during active local development (noise, not signal), while the
  live GitHub Pages copy never carries that suffix at all (`main` only receives a version stamp
  with the dev marker cleared, at an actual release), so comparing by the clean version number alone
  also happens to be exactly the right behaviour there with no extra branching needed. Only logs
  when a DIFFERENT version was previously recorded — a brand-new visitor (no saved key yet) just
  gets the current version silently recorded, not a confusing "updated from nothing" message.

  `axisScale(maxAbs)` gives an axis whose values commonly run large (PCFO's noise variance can be in
  the hundreds of thousands, ADU²) matplotlib-style "offset notation": ticks show a small (single
  digit + one decimal) scaled number, with a single `×10ⁿ` multiplier drawn once near the axis
  (`n = floor(log10(maxAbs))`). This is genuine SCIENTIFIC notation (one arbitrary power per axis),
  not engineering notation's multiple-of-3 rounding, which was tried first and rejected — it still
  left 3-digit ticks on PCFO's range (e.g. "750×10³"). Lives in **render** (not `drawPcfoPlot()`
  itself, the one plot currently needing it) so any other plot with the same large-number problem
  can reuse it.

  Every plot draws a real L-shaped axis border (left + bottom, `C.text`) plus a short (5px)
  outward-facing tick mark at each major tick, on both axes — every plot has this now, a
  consistency pass after **Drift vs frame** was found missing one entirely. The axis border is drawn
  LAST, after the data, so bars/points flush against an axis edge (NeNA in particular) can't be
  covered by it; `strokeStyle` switches to `C.text` for just the tick-mark stroke and restores to
  `C.grid` immediately after. Tick labels shift outward by the same 5px to clear the new marks.

  The side-by-side/stacked panel layout (`.canvases.stacked`, single column) is resolved by
  `applyLayout()`: `layoutOverride` (module-level, `null`/`true`/`false`) takes precedence over the
  `frameAspectWH.h/frameAspectWH.w<0.5` auto-heuristic once the user clicks **Stack panels**/**Side
  by side** (`layoutToggleBtn`), and sticks across further loads this session rather than the next
  load's own aspect ratio silently resetting the user's choice. `setFrameAspect(w,h)` is the single
  place that sets `frameAspectWH`, the CSS `--frame-ar` custom property (both panels track it, see
  above), AND calls `applyLayout()` — `initScrub()` calls it with the loaded stack's own `w`/`h`;
  loading a CSV directly (`csvFile`'s own change handler, MODULE: table) calls it with
  `parseCsvLocs()`'s own bounding-box `w`/`h` instead, since there's no stack at all in that path
  and `initScrub()` never runs. Before this, a CSV-only load left `--frame-ar` at whatever a
  previous stack happened to set it to (or the CSS default of square, 1:1, if none ever had) — a
  real, reported bug: a wide/narrow result stayed letterboxed in a wrong-shaped panel, with the fit
  view (and therefore the scale bar) sitting far from the actual plotted data instead of snug
  against it, and never auto-triggering the stacked-panels heuristic a similarly-shaped movie
  would. The reconstruction's own bounding box is always somewhat smaller than the original camera
  FOV (border-adjacent localizations are dropped during fitting) — expected, not something to
  correct for; it's still the right shape to fit the panel to.

  **`parseCsvLocs()` NEVER shifts loc coordinates** — `(0,0)` always means the same physical
  camera pixel it meant in the original file/session, full stop. This went through two rounds: an
  early version sized `w`/`h` off `maxX`/`maxY` ALONE (a leftover `+10` "never round a boundary loc
  outside the canvas" margin, applied only on the high side), so the bounding box's own low corner
  — essentially never exactly `(0,0)` — got a near-zero margin while the high corner got the full
  `+10`, i.e. an uncentred crop; a SECOND round (looked like the right fix at the time) "corrected"
  this by tracking `minX`/`minY` too and SHIFTING every loc by that amount so the bounding box sat
  with an equal margin on all sides — reasoned as safe because "there's no raw frame data for a
  CSV-only load to stay pixel-aligned with, so the shift doesn't lose or misalign anything." That
  reasoning broke down for a genuinely different, LATER feature: the segmentation overlay (MODULE:
  spt) uploads an image from a SEPARATE source (a different camera/session, e.g. brightfield vs.
  fluorescence) whose own pixel grid IS expressed in that same original coordinate frame — shifting
  the locs by an arbitrary, data-dependent amount (`minX`/`minY`, easily tens of px on real data)
  silently broke that alignment, a real, reported bug (segmented cells and their own localizations
  visibly not lining up — confirmed directly: reloading the SAME real dataset with the shift
  removed showed bacterial shapes tightly covered by matching segmentation colour, where the
  shifted version left a large uncovered band along one edge). Reverted the shift entirely — `w`/`h`
  are sized off `maxX`/`maxY` alone again (a `+10` margin on the high side only, same as the
  original pre-centring version), but the ASYMMETRIC-CROP concern that motivated the shift in the
  first place is now understood to be the WRONG problem to solve here: a CSV-only reconstruction
  being visually off-centre in its own panel is cosmetic and harmless; silently moving every loc's
  absolute position is not, the moment ANY external reference (a segmentation image today,
  conceivably something else later) depends on that position staying true to the original file.
  The click handler also calls
  `refitCanvases()` immediately, since the panel boxes just changed shape. `layoutToggleBtn` lives
  on the right of the **Log** card's own title bar (`clearLogBtn`/`exportLogBtn` grouped on the
  left), not a dedicated row above the canvases — that read as wasted vertical space for one small
  button.

  **Raw-frame display contrast** (`rawBlack`/`rawWhite`, the Contrast slider below the Frame
  scrubber, Picasso-inspired) is a FIXED [black,white] ADU range applied identically to every frame
  by `drawRaw()`, replacing an earlier per-frame auto-stretch (`t=(v-frameMin)/(frameMax-frameMin)`)
  that made brightness/contrast visibly shift as you scrubbed and let a single dead/hot pixel
  dominate a frame's own min or max. `estimateRawContrastRange(stack)` (called once right after a
  stack loads, before the first frame paints) establishes the slider's own bounds and initial handle
  positions: a TRUE global max would mean reading every pixel of every frame, the opposite of this
  loader's whole streamed/sliced design for large files, so it samples a bounded number (50) of
  seeded-random frames instead — the same `pickSeededFrames()` PCFO's own gain/offset estimate
  already uses — accepting a small chance of missing the single hottest pixel in an unsampled frame
  as a reasonable trade-off for a display convenience, not a measurement. The initial HANDLE
  positions are a separate question from that bound, deliberately NOT derived from the sampled
  frames: an earlier version defaulted them to a 0.5th/99.5th percentile over all the sampled
  frames' pixels pooled together (mirroring the reconstruction panel's own `lutpct` "Display max
  percentile" control) — measured wrong for sparse SMLM data specifically, since background pixels
  vastly outnumber the bright emitter pixels that actually matter, so a percentile-of-everything
  sits well below real signal peaks (white defaulted to ~32% of the true observed max on a real
  stack — every frame looked far dimmer than the old per-frame auto-stretch ever did). Fixed by
  defaulting to frame 0's own actual min/max instead, exactly reproducing what the old per-frame
  behaviour showed for the very first view — the new part is only that it then stays fixed across
  every other frame instead of recomputing per frame. There's no native two-thumb
  `<input type=range>`, so the slider itself (`.dualrange` CSS, `#rawBlack`/
  `#rawWhite`) is two ordinary range inputs stacked on the same track, each fully transparent except
  its own thumb (`pointer-events` split via `::-webkit-slider-thumb`/`::-moz-range-thumb`) so either
  handle can be grabbed independently without the other, or the track itself, intercepting the drag;
  each input's own handler clamps against the other's current value so they can't cross. Dragging a
  handle re-renders from `rawPixelData` (the exact ADU array `drawRaw()` last received) via
  `redrawRawContrast()` rather than re-fetching the frame from the stack, so dragging stays
  responsive regardless of stack size. The Frame scrubber (`#scrub`) got its own matching CSS
  restyle alongside this (same 4px `--line` track, same 14px `--accent` circular thumb) — plain
  native rendering left it visually inconsistent with the new Contrast slider directly below it
  (different track/thumb colour and thickness); `#scrub` keeps native click-anywhere-to-jump
  behaviour though (no `pointer-events` split — only one handle, nothing to protect the drag from).
  `rawContrastAutoBtn` ("Auto", `.logbtn` styling — same small-inline-button pattern as
  `clearLogBtn`/`exportLogBtn`) re-runs `estimateRawContrastRange(stack)` (the exact call a fresh
  load already makes) then `redrawRawContrast()`, since the estimate function itself only updates
  state/slider UI, not the on-screen frame — a manual reset back to the auto default after dragging
  either handle away from it. The slider itself is narrower than a full-width row control
  (`flex:0 1 55%` on `.dualrange`) to leave room for this button without crowding the "Black: X ·
  White: Y" readout. `applyCropToRaw()`/`uncropRaw()` (the raw-panel crop tool, see **in/out**
  above) each make this same call too, right before `showFrame(0)` — a crop/uncrop swaps `stack`
  for a genuinely different pixel population (the earlier fix that added `initScrub()` to both
  already handled the Frame scrubber; the Contrast slider's own range was left stale, still
  reflecting whatever was sampled before the crop, since it isn't re-derived from `stack` on every
  frame the way the old per-frame auto-stretch was — a real gap, since the whole point of a fixed
  range is that it does NOT recompute per frame, so nothing else was going to catch this).
  Deliberately excluded from `PARAMS`/Save-Load Settings/the
  headless `analyze()` config — same "pure display/layout" carve-out as UI theme choice and sidebar
  collapsed/floating state (see **params** above) — a display convenience local to one interactive
  session, not an analysis parameter.
- **workers** — frame-parallel detect/fit (see below).
- **export** — ThunderSTORM-compatible CSV. `photons`/`bg`/`bgstd` are already true photon units
  by the time they reach export (gain/offset are applied inside the fit, see **fit** above), so
  export/the table histogram do no further conversion — they still read `gain`/`camoff` only to
  log a "gain 1 / offset 0" warning when a user hasn't set real camera values. `"sigma_x [nm]"`/
  `"sigma_y [nm]"` (CSV) and `sigma_x`/`sigma_y` (table) are optional columns, present whenever
  ANY loc carries a real per-axis width (`isFinite(L.sx)&&isFinite(L.sy)`) — i.e. the Run used
  `mle3d` or `gaussmleEll` (see **fit**) — independent of, and in addition to, `sigma1st`/
  `sx0th`/`sy0th`/`sx1st`/`sy1st` below (those are sSMLM-pair-specific; these are per-loc, on
  every localization, paired or not). `parseCsvLocs()` reads them back into `L.sx`/`L.sy` for a
  round trip. Reaching this required a real fix, not just the column-building itself: the worker
  pool's own message protocol only ever packed `x,y,photons,bg,bgstd,sigma,z,zClamped,frame,
  lpx,lpy,lpz` (12 floats) per loc into the `Float64Array` it returns — `sigma` (the `mle3d`/
  `gaussmleEll` fitters' own `(sx+sy)/2`) but never `sx`/`sy` themselves — so a worker-pool Run
  (the common case for any real dataset) silently lost per-axis width entirely, even though the
  single-threaded fallback path (`locs.push(L)` directly) always kept it. Widened to 14 floats
  (`sx`,`sy` appended, `NaN` for methods that don't fit them) at all three sites that must move
  together — the worker's own `out.push(...)`, and both `wk.onmessage` unpack loops (the plain
  pool-dispatch loop and the FTM barrier-phased loop, which duplicate this on purpose, see
  **in/out**'s FTM entry) — a stride mismatch between any of the three is a silent data-corruption
  bug, not a crash. This also fixes a latent gap in **sSMLM**'s own pairing: `pairCore()` reads
  `L.sx`/`L.sy` straight off the input locs, so a worker-pool `'gaussmleEll'` Run's paired output
  was silently missing `sx0th`/`sy0th`/`sx1st`/`sy1st` before this — only ever populated when the
  single-threaded path happened to run.
- **3D calibration** — astigmatic: σ_x/σ_y vs z bead curves, JSON save/load. Astigmatism is the
  only method implemented; other 3D approaches (Double Helix, Biplane) would live here too.
  `calibrationCore()` takes the same `shouldStop` hook `runCore()` (Localize) does, checked at the
  same yield point as its progress/preview callbacks (a Stop click can only be observed while
  yielding); `runCalibration()` enables `stopBtn` and resets `stopRequested` the same way `run()`
  does. Unlike Localize there is no partial-result path on stop: the frame loop returns
  `{stopped:true}` immediately rather than falling through to the quadratic/phasor-ratio fit —
  fitting only the frames seen so far would silently produce a BIASED curve (missing the rest of
  the z-range), not a smaller-but-still-correct one, so `runCalibration()` discards everything and
  returns early rather than accepting a wrong calibration. Added after a real workflow slip
  (3D calibration accidentally triggered on an ordinary movie, with no way to cancel the resulting
  long run).
- **drift** — AIM (adaptive intersection maximization), point-based, 2D+z. `drawDriftCurve()`'s
  own green (`#0a7d32`)/magenta (`#c81cc8`)/blue (`#3572b0`) drift-x/y/z palette is treated as the
  project's reference colour pairing — other plots' own green/magenta curves (NeNA, **spt**'s
  track-length fit) were retroactively matched to it rather than picking independent colours, so a
  colour means the same thing across plots as much as it reasonably can.

  `drawDriftCurve()` is a thin dispatcher over two actual plot functions, chosen by module-level
  `driftPlotMode` (`'frame'` default, or `'xy'`): `drawDriftCurveVsFrame()` is the original view
  above (x/y/(z) vs frame index); `drawDriftCurveXY()` is a single trajectory — drift y vs drift x
  — with each segment coloured by frame (time) through `getLUT(paramValue('lut'))`, the SAME LUT
  the reconstruction panel's own z-colouring reads, reusing "time in frames" as the colour-coded
  quantity rather than adding a second colour-map control. Both axes of the xy view share ONE nm
  range (computed across x AND y together, like the vs-frame view's own shared value axis) so the
  path's shape is geometrically accurate — independently autoscaled axes would visually distort it.
  A small colour-bar legend (frame 0 → frame n−1) is drawn directly in the plot, since the gradient
  alone can't be read as a time axis without one. Deliberately x vs y only, even when 3D drift
  (`driftZ`) produced a real `fdz` — a genuine 3D trajectory (or x/z, y/z alternatives) is out of
  scope for now. `driftPlotModeBtn` (inline in the raw-panel title, next to `rawFtmBtn` — same
  show/hide-while-relevant pattern as `rawFtmBtn`/`sSmlmColorBtn`) toggles the mode and only shows
  while the drift plot itself is up; `drawRaw()` hides it again the moment the panel is reclaimed
  by a live frame, the same place that already resets the panel title back to "Raw frame".
  `correctDrift()` resets `driftPlotMode` to `'frame'` on every fresh correction, so a new result
  always opens on the default view rather than wherever a previous session's toggle left it; the
  existing **Show drift** button (`driftShowBtn`) re-shows whichever mode is CURRENTLY selected,
  not a reset. `drawDriftCurveXY()`'s colour-bar legend uses a manual `moveTo`/`lineTo` path
  `stroke()` for its border, not `strokeRect()` — the latter isn't part of `SvgRecordingContext`'s
  duck-typed surface (see **render** above), and the drift plot is one of the 7 SVG-exportable
  plots, so anything it draws must stay inside that surface or "Save plot / image" → SVG breaks for
  exactly this one view; caught by actually exercising the SVG export path, not just the on-screen
  canvas one. `renderDriftPlotHeadless()` (`config.exportPlots`) renders whatever `driftPlotMode`
  currently is, same as every other headless plot render piggybacking on interactive module state
  (`calView`, `_plotExportMode`) — there's no separate headless mode selector.
- **locprecision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution,
  inline radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
  `drawNenaPlot()`'s two overlaid curves are green (`#0a7d32`, the FULL Endesfelder fit — signal +
  short-range + long-range terms) and magenta (`#c81cc8`, the signal-Rayleigh term alone) —
  matching **drift**'s own green/magenta pairing; an earlier version used green for the signal term
  and red for the full fit, swapped for this consistency.
- **sSMLM** — spectrally resolved SMLM: pairs 0th/1st-order localizations from a diffraction
  grating (ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer);
  Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022). Role assignment (which point of a pair is
  0th vs 1st) is **directional, not brightness-based** — real-data investigation found photon count
  barely correlates with position (≈50/50 even at confident intensity gaps, likely PSF-overlap/
  crowding at real emitter densities), so `sSmlmAngleCenter` is a genuine SIGNED bearing (full
  ±180°) and `pairCore()` classifies each candidate by direction into `outEdges`/`hasIncoming`
  maps: a point qualifies as 0th order only if it has ≥1 outgoing edge (a candidate on the
  configured bearing) AND zero incoming evidence (a candidate on the opposite bearing, more likely
  someone else's 1st order) — self-disqualifying, no brightness needed; recovers more real pairs
  than the earlier brightness-gated approach (64.0% vs 59.0%). PSF width (σ, broader for the
  spectrally-smeared 1st order) showed only ~65–70% correlation with role — available as an
  optional, default-OFF extra filter (`sSmlmRequireNarrower`), not required. **2-point pairs only**
  (0th+1st) — multi-order chaining and FFT-based angle/distance auto-detection are
  `docs/REFACTOR_PLAN.md` follow-ups; the interactive **Preview pairs** distance/angle histograms
  (`computeHist()`/`drawHistogram()` from **table**) cover "find my window" instead — always
  fetched over a WIDE fixed scan (0–6000 nm, any angle), ignoring the current field values, so
  narrowing either one first can't hide the true peak. The **angle** histogram, unlike the distance
  one, DOES restrict to the current distance window (angle signal is only sharp within the real
  peak) and plots each candidate's `rawAngle` AND its exact reverse (`+180°`) — which of a
  candidate's two points gets the smaller array index (and therefore which direction `rawAngle`
  reports) is a row-order accident, not evenly split in real data, so plotting only the raw bearing
  looks wildly asymmetric; doubling it makes the two peaks equal. `fitSSmlmAngle()` (**Fit angle &
  tol.**) estimates `sSmlmAngleCenter`/`sSmlmAngleTol` from that same data — 2°-bin peak detection +
  half-max-width walk, THEN DOUBLED as a safety margin (the raw half-max width alone came out ~1°
  against real data, vs. the ~5° that actually worked by hand). Both histograms draw the currently
  configured window as markers (`computeHist()`'s optional 4th `markers` param), refreshed live on
  field edits and after a fit via `refreshSSmlmHistIfShown()`.

  **`sSmlmHistBtn`** ("Show histograms") is one button covering both the distance and angle
  histograms, with `sSmlmHistModeBtn` (inline in the raw-panel title) toggling which mode
  `drawSSmlmHist()` draws — a single mode-aware function, `sSmlmHistMode` `'dist'`/`'angle'` —
  labelled `"Distances"`/`"Angles"` (the OTHER mode's name, `driftPlotModeBtn`'s own convention).
  **Deliberately different from spt's own D/track-length histogram merge**: `drawSSmlmHist()`
  overrides `$('rawTitle')` to a single FIXED `"sSMLM histograms"` for both modes, right after
  `drawHistogram()` sets its own per-mode auto-title — spt's own merge keeps `drawHistogram()`'s
  per-mode title instead, by explicit request. `previewSSmlmPairs()` resets `sSmlmHistMode='dist'`
  before its own first draw — a fresh Preview always opens on Distances, same "fresh result opens
  on the default view" precedent `driftPlotMode`/`sptHistMode` follow. `refreshSSmlmHistIfShown()`
  is unaffected — already keyed off `histData.col`, not which button opened it.

  **Fit angle & tol.** and **Pair** share one button row; **Unpair** sits alone in the row below.

  An unpaired localization is dropped from the result. A pair's reported position is the 0th
  order's OWN x/y (undispersed — already the true position), not the midpoint: the 1st order's
  offset varies per emitter with wavelength, so averaging would blur position. Each paired row also
  carries `sigma1st` — the 1st order's own `sigma` — exported as a `"sigma1st [nm]"` CSV/table
  column whenever present. NOT a directional/long-axis width for most methods (every method except
  the two elliptical fitters, `mle3d`/`gaussmleEll`, fits one symmetric `sigma`, no `sx`/`sy` split);
  the closest available proxy for "how much wider the spectrally-smeared 1st order looks" in that
  case. When the Run used `mle3d` or `gaussmleEll` (MODULE: fit) instead, `pairCore()` also carries
  the real thing — `sx0th`/`sy0th`/`sx1st`/`sy1st` (from `L.sx`/`.sy` and `locs[q.down].sx`/`.sy`),
  exported as their own optional CSV/table columns the same way — a genuine per-axis width for BOTH
  orders, not just a proxy for the 1st. The 0th order's own `sx`≈`sy` is itself a useful
  fit-quality/role signal, not just bonus data — the whole point of using an elliptical method for
  sSMLM rather than only applying an elliptical fit after the fact to whichever point got classified
  as 1st order.

  Stores the inter-order distance in its own `dist` field — **deliberately never `z`**: an earlier
  design that aliased `z` was reverted, both to fix a real bug (drift correction's "Correct z too
  (3D)" used to key off the same `has3d` check the colour toggle used, so it would silently
  1-D-"correct" a paired result's spectral `dist` as if it were spatial depth — `driftZRow`'s
  visibility and `driftCore`'s own gate are keyed on real `z` alone now) and so a future 3D-fit +
  sSMLM combination could carry real depth AND spectral distance on the same loc without one
  clobbering the other. `renderSuperRes()`/`zRange()` take an explicit `colorField` parameter
  (`'z'` or `'dist'`) so the SAME depth-coded render path colours by either; `rerender()`/
  `analyze()` derive it as `hasZ ? 'z' : (hasDist ? 'dist' : null)`. The sidebar's **Colour by depth
  (z)**/**z min/max (nm)** labels switch wording live to "sSMLM distance" whenever
  `colorField==='dist'`, set from `rerender()` (and `updateMethodUI()`'s 3D branch directly, in
  case `rerender()` hasn't fired yet). **`pairCore()` itself throws** (not just the interactive
  wrapper) if the input already has real 3D `z`, OR already has a `dist` field (already-paired
  output) — applies to every caller uniformly. Interactively, **Pair** also sets `zmin`/`zmax` to
  the configured distance window, since every accepted pair's `dist` already lies inside it by
  construction. Three module-level vars track state: `sSmlmOriginalLocs` (the true raw backup,
  captured once — also the authoritative pairing input: Preview/Pair always read
  `sSmlmOriginalLocs || lastResult.locs`, never `lastResult.locs` alone, since that may currently
  be an already-paired subset with no 1st-order companions left to find), `sSmlmPairedLocs` (latest
  Pair result), and `sSmlmShowingRaw`. The reconstruction-panel toggle (`sSmlmColorBtn`, "Show
  spectral"/"Show standard") swaps `lastResult.locs` between them (plus `zcolor`) — a real data
  swap, not just a colour flip, without discarding the pairing the way Unpair does. **Headless**:
  `config.sSmlmPair` runs pairing right after Localize, before drift/NeNA/FRC; `pairCore()`'s own
  throws propagate immediately, and the result's `sSmlmPair` field records
  `nPairs`/`nInput`/`meanDistance`/`stdDistance`. `tools/webSMLM-cli.mjs`'s `--sSmlmPair` and
  `?autorun=`'s `sSmlmPair=1` both forward to it.
- **spt** (single particle tracking, v0.11.2) — links per-frame localizations into trajectories and
  computes a per-track diffusion coefficient. A trackpy-**inspired** variant (same
  `search_range`/`memory` terminology and linking philosophy as the Python `trackpy` package), not
  a literal port — no way to call real Python trackpy from a static HTML page. Ported from the
  user's own `sptPALM-Python` pipeline (L. lactis sptPALM, Martens et al., *Nat. Commun.* 10, 3552,
  2019). `linkTracks()` walks frames in order; each frame's track↔candidate bipartite graph (edges
  within `sptSearchRange`, gated by `sptMemory` for gap-bridging) splits into connected components
  ("subnetworks", trackpy's own term) via union-find, each solved by a self-contained
  Hungarian/Kuhn–Munkres implementation (`hungarianAssign()`) for the minimum-total-squared-
  displacement assignment — keeps crossing trajectories from swapping identity in the common case.
  NOT trackpy's own recursive exact-subnetwork solver; components above `HUNGARIAN_MAX` (120) fall
  back to greedy nearest-neighbor instead (one-time logged warning) rather than let O(n³) stall the
  tab on a pathologically dense frame — real single-molecule SPT data isn't expected to hit this,
  but it's a documented scope limit, not glossed over. Returns a NEW locs array (never mutates,
  same convention `pairCore()`/`driftCore()` use) with `track_id` set on EVERY localization, even
  length-1 tracks — length filtering happens only at the diffusion-coefficient step.
  `trackDiffusionCoeffs()` ports `diff_coeffs_per_track()`'s core MSD math: one D (µm²/s) per track
  with at least `sptTrackLenMin` localizations, from the gap-corrected mean of ALL of that track's
  own single-frame squared displacements — an average, explicitly NOT a linear MSD-vs-lag-time fit,
  matching the reference pipeline exactly — `D = MSD/(4·frametime) − locError²/frametime` (2D,
  static-localization-error-corrected). Unlike the reference pipeline there is no
  `sptTrackLenMax` truncation — every qualifying track's MSD uses all of its own steps, since
  webSMLM doesn't (yet) build the length-resolved histogram truncation existed for.
  `trackDiffusionCoeffs()` also collects `trackLengths` for EVERY linked track regardless of D
  qualification — `drawSptTrackLenHist()`'s log-Y-axis histogram of this is how a user judges
  whether `sptTrackLenMin` is set sensibly. `computeHist()`/`drawHistogram()` (table module) gained
  an optional 5th `logY` parameter for this — bars/ticks map through `log10(count)`, with a
  0-count bin pinned to the floor via `log10(max(1,c))=0`; `registerPlotHover()`'s hover readout is
  linear-interpolation-only, so log mode hands it log-space bounds and undoes the transform inside
  its own `fmt` callback rather than teaching the shared hover code a Y-scale option. A real,
  expected artifact of the D formula is that near-immobile or very-short tracks can compute a
  non-positive D — `drawSptDHist()` EXCLUDES these from the plotted log10(D) histogram (logged
  count, not silently dropped) rather than clamping them into one bin, which would pool unrelated
  tracks into a fake spike (a log-binned `np.histogram()`, the reference pipeline's own approach,
  avoids this implicitly by excluding out-of-range values). **Track** (`runSptTrack()`) is
  idempotent, safe to re-run any time — only sets/overwrites `track_id`/`D_coeff`, never
  reduces row count. Immediately draws the D histogram in the raw panel, fed `log10(D)` — D
  commonly spans orders of magnitude between bound/slow and free/fast populations, matching the
  reference pipeline's own default log axis; not yet nicely `10^x`-formatted tick labels (v1
  shortcut, `docs/REFACTOR_PLAN.md`). `sptDPlotMin`/`Max` are a DISPLAY-only axis window —
  `meanD`/`medianD` always reflect every qualifying track, never just the plotted window.

  **`sptHistBtn`** ("Show histograms") shows either the D or track-length histogram; `sptHistModeBtn`
  — inline in the raw-panel title, same `.logbtn`/`display:none`-until-relevant placement as
  `driftPlotModeBtn` (MODULE: drift) — toggles which of `drawSptDHist()`/`drawSptTrackLenHist()` is
  on screen. Labelled `"Diffusion"`/`"Track length"` (the OTHER mode's name, matching
  `driftPlotModeBtn`'s "shows what clicking gets you" convention) rather than an action verb — the
  one place this toggle words itself differently from its siblings, by explicit request.
  `sptHistMode` (module-level, `'D'` default) resets to `'D'` only at the top of a fresh
  `runSptTrack()` — same "fresh result opens on the default view" precedent `driftPlotMode` follows
  — `sptHistBtn`'s own click just reopens whichever mode was last active. `drawSptHist()` is the
  dispatcher (owns `sptHistModeBtn`'s visibility/label — neither `drawHistogram()` nor
  `drawSptDHist()`/`drawSptTrackLenHist()` touch the button directly). `sptHistBtn` is enabled off
  `trackLengths.length` — every linked track counts, regardless of D qualification; if a fresh Track
  run has zero qualifying D estimates, `runSptTrack()` sets `sptHistMode='length'` before calling
  `drawSptHist()` instead of leaving a disabled button, so a dataset with tracks but no D estimate
  still gets *a* useful histogram shown automatically. `refreshSptDHistIfShown()`/
  `refreshSptTrackLenHistIfShown()` (live-refresh on `sptFrameTime`/`sptTrackLenMin` edits) are each
  already keyed off `histData.col`, not the button that opened it.

  D = (MSD/4 − locErrorUm²)/frametime is exactly linear in 1/frametime, and MSD itself (cached per
  track in `trackDiffusionCoeffs()`'s `trackMSD` Map, plumbed through to `lastSpt.trackMSD`)
  depends on neither frametime nor locError. `recomputeSptD()` exploits this: editing **Frame
  time** or **Localization error** after **Track** rescales every track's D (table/CSV, `lastSpt`,
  the D histogram) directly from `trackMSD`, no re-linking — unlike **Search range**/**Memory**/
  **Min track length**, which change which tracks/steps exist and still need a fresh **Track**.
  The **Get from NeNA** button (`sptLocErrorFromNenaBtn`, right-aligned via `style="grid-column:2"`
  — a lone `.btnrow` child sits in the LEFT grid cell by default) has a programmatic
  `sptLocError.value` write that doesn't fire `change`, so its handler calls `recomputeSptD()`
  explicitly.

  `drawSptTrackLenHist()` fits an exponential decay (`fitTrackLifetime()`, count(L) ~ A·exp(−L/τ),
  a photobleaching-limited survival model) via WEIGHTED least-squares on ln(count) vs bin centre,
  weight = the bin's own count. **Weighting is required, not cosmetic**: bin counts are
  Poisson-distributed (Var(ln(count)) ~ 1/count) — an unweighted fit gives a count-of-2 tail bin
  the same say as a count-of-8000 peak bin, dragging the fit away from the short-track end; caught
  from a real rendered histogram where an unweighted fit sat nearly an order of magnitude below the
  first bar. Fit curve drawn magenta (`#c81cc8`, matching **drift**'s green/magenta pairing),
  attached as `histData.curve`/`curveLabel` (see **table**'s `computeHist()` entry). τ is reported
  in both locs and seconds; **locs≈frames only when `sptMemory=0`** — a bridged gap still counts as
  one "loc" despite spanning >1 frame, so the seconds figure is an approximation once
  gap-bridging is active, called out explicitly rather than presented as exact.

  `computeHist()`'s own `markers` parameter (already used by sSMLM's distance/angle histograms to
  mark their configured window) draws a vertical line at the CURRENT `sptTrackLenMin` — `trackLengths`
  itself never depends on that field (every linked track is collected regardless of qualification,
  precisely so this histogram can help pick it), so without a marker, editing the field while the
  histogram was open had nothing to visibly change. `sptTrackLenMin`'s own `change` listener calls
  the existing `refreshSptTrackLenHistIfShown()` (previously only wired to `sptFrameTime`, for its
  τ-in-seconds relabel) — redraws the marker at the new position, no re-**Track** triggered (the bars
  themselves are unaffected), verified via `histData.markers[0].x` tracking the field live.

  `track_id`/`D_coeff` are independent, optional table/CSV columns (same pattern as sSMLM's
  `dist`/`sigma1st`), so the filter grammar works on tracking data for free — the general **Save
  data** CSV gains these automatically once Track has run. **Save tracking data**
  (`sptSaveBtn`/`exportSptSummary()`) is a genuinely DIFFERENT export: `sptTrackSummary()`
  aggregates into one row per TRACK (`track_id`/`n_locs`/`D_coeff`/`mean_x`/`mean_y`) rather than
  per localization — built from the tracked locs directly, not `lastSpt`'s own arrays (those only
  cover qualifying tracks); every linked track gets a row here. **Headless**: `config.sptTrack`
  runs tracking AFTER drift/NeNA/FRC (the opposite order from `sSmlmPair`) — `sptCore()` never
  drops rows, so no row-count reason to run it early, but a per-track D benefits from
  drift-corrected coordinates. The result's `spt` field records `nTracks`/`nQualify`/`meanD`/
  `medianD` only — not the full per-track arrays (`trackMSD` is a `Map`, not JSON-serialisable,
  would silently become `{}`). `tools/webSMLM-cli.mjs`'s `--sptTrack`/`?autorun=`'s `sptTrack=1`
  forward to it. No length-RESOLVED D histogram, no colour-by-D/by-track rendering — tracked as
  `docs/REFACTOR_PLAN.md` follow-ups.

  **Cell-by-cell tracking is also wired headlessly**, `config.segmentationFile` — a File, loaded
  the same way `config.file`/`config.calibrationFile` are (`loadTiffFile()`, frame 0 only), through
  its own dedicated hidden `#segmentationFileInput` (separate from the interactive `#segFile`, same
  "don't also trigger the interactive change handler" reasoning as `#analyzeFileInput`/
  `#calibrationFileInput`). Its mere presence switches `sptCore()` to `segCtx`-based cell-by-cell
  tracking, same as checking **Apply segmentation?** interactively; `segAreaMin`/`segAreaMax` are
  ordinary `PARAMS` entries, no extra wiring needed for those two. A movie/mask size mismatch logs
  the same warning the interactive `loadSegmentedImage()` does but still proceeds. This surfaced (and
  fixed) a real, previously-latent bug: `linkTracksPerCell()` read per-cell area off the
  module-level `segmentedImageData` global directly instead of taking it as a parameter — harmless
  interactively (`drawSegmentedImage()` always populates that global right before this can run) but
  silently broken headlessly, since `analyze()` deliberately never touches that global (staying
  DOM-free like every other `*Core()` consumer) — every loc would have come back excluded with no
  error. Fixed by recomputing the area map from the passed-in `segLabels` via
  `computeSegmentedImageData()` (pure, already DOM-free) instead — a general lesson for any future
  `*Core()`-reachable function: a module-level global that happens to be populated before every
  interactive call site is invisible until something calls the same function headlessly.
  `tools/webSMLM-cli.mjs`'s `--segmentation <mask.tif>` forwards to it; `?autorun=` has no
  file-upload mechanism at all (even `calibrationFile` isn't reachable from it, a pre-existing gap)
  so it doesn't gain an equivalent.

  **Segmentation image** (`applySegmentation` checkbox, default unchecked; v1, "as a start" toward
  cell-segmentation-aware tracking — see `docs/REFACTOR_PLAN.md`). Checking it reveals **Load
  segmented image** (`segLoadBtn`/hidden `segFile` input, same `.tif`/`.tiff`/`.nd2` accept list as
  **Load movie**), which loads a separate integer-labelled mask image through the exact same
  `loadTiffFile()` any movie goes through — 0 = background, 1/2/3/… = cell number, adjacent
  same-valued pixels = one cell's own footprint. Only frame 0 is read (a segmentation mask is a
  single image; a multi-frame file logs a warning and uses frame 0 anyway, not an error). If a
  movie is already loaded and the mask's W×H doesn't match it, a warning is logged (pixel
  correspondence needed for eventual per-cell filtering would be off) but loading still proceeds —
  "warn, don't block" is standard for genuinely v1 territory.

  `computeSegmentedImageData()` does one pass over the label array, building `segmentedImageData`
  (module-level, one `{id,cx,cy,areaPx}` row per nonzero label — running cell number, centre of
  mass in pixels, pixel-count area) — verified numerically EXACT against an independent
  numpy/`np.unique`+`np.where` computation on the real bundled
  `experimental_data/bf_analysed_JH_procBrightfield_segm.tif` (111 cells, first three rows'
  area/centroid matched to full float precision).

  `drawSegmentedImage()` renders it into the raw panel through the SAME `rawFull`/`rawView` raster
  pipeline `drawRaw()` uses for an ordinary movie frame (fit/pan/zoom, and — since `exportPanel()`'s
  own PNG-vs-SVG dispatch is keyed off `rawFull` being non-null, not off `rawIsPlot` — a correct
  raster PNG export for free) rather than the plot mechanism (`rawIsPlot`/`_replotRaw`): this is
  real pixel-density image content with no meaningful vector form, same reasoning the raw movie
  frame itself is never one of the SVG-exportable plots. `rawPixelData` is repurposed to hold the
  integer label array instead of ADU while shown (`rawSegView`, a new module-level flag) —
  `fmtRawPixel()`'s hover readout branches on it to show "cell N"/"background" instead of an ADU
  value, and `redrawRawContrast()` no-ops instead of corrupting the label data through the
  grayscale contrast mapping if the Contrast slider is dragged while it's showing. The raw-panel
  crop tool is explicitly disabled while shown (cropping would operate on the wrong content) and
  re-enables automatically the moment the panel is reclaimed by a live frame — `drawRaw()` (called
  from every `showFrame()`, i.e. dragging/typing into the Frame scrubber) resets `rawSegView=false`
  and calls `setRawPlot(false)` exactly like it already does when reclaiming from a plot; no new
  "exit" mechanism was needed, just extending the one that already existed. Unchecking **Apply
  segmentation?** while the image is shown reverts to the live frame (or, with no movie loaded,
  clears the panel back to its own empty default) and drops `segmentedImageData`/
  `segmentedImageLabels`, disabling **Show image** again (and hiding its own raw-panel-title
  toggle, `segShowModeBtn` — see below).

  **Show image** (`segShowBtn` — shares a two-column `.btnrow` with **Load segm. image**) shows
  either the segmentation image or its cell-area histogram; a raw-panel-title toggle
  (`segShowModeBtn`, `.logbtn`, same show/hide-while-relevant pattern as `driftPlotModeBtn`/
  `sSmlmHistModeBtn`) flips a module-level `segShowMode` (`'image'`/`'hist'`, default `'image'`) and
  calls `drawSegShow()` again. Unlike the spt/sSMLM histogram toggles (both switching between two
  PLOTS sharing one `computeHist()`/`drawHistogram()` draw call, so a single dispatcher can own both
  the draw and the panel title), this one switches between a RASTER IMAGE (`drawSegmentedImage()`,
  the `rawFull`/`rawView` pipeline) and a PLOT (`drawSegAreaHist()`, the `rawIsPlot`/`computeHist()`
  pipeline) — two structurally different rendering paths with no shared draw primitive to factor
  out, so `drawSegShow()` is a thin dispatcher that just calls whichever existing function applies;
  each mode keeps setting its OWN panel title (`"Segmented image"` / `"Histogram: Cell area"`)
  rather than the fixed-title override the sSMLM merge uses. `segShowModeBtn`'s own label is the
  OTHER mode's name, synced by `syncSegShowModeBtn()` — split out from `drawSegShow()` so
  `loadSegmentedImage()` can reset `segShowMode='image'` and sync the toggle on a fresh load WITHOUT
  a redundant redraw of what `drawSegmentedImage()` already just drew inline. Hidden at the same two
  reclaim points every other raw-panel toggle uses: `drawRaw()` (scrubbing to a live frame) and the
  `applySegmentation` uncheck handler.

  `drawSegmentedImage()` also calls `setFrameAspect(w,h)` with the segmentation image's OWN
  dimensions, taking over `--frame-ar` (the CSS custom property BOTH panels' canvases track, see
  **render** above) regardless of what set it before. A real, reported bug otherwise: for a
  CSV-loaded result (no `stack`, so `initScrub()` never runs), `--frame-ar` was left at
  `parseCsvLocs()`'s own loc-bounding-box `w`/`h` — an APPROXIMATION, padded and never exactly the
  segmentation image's true dimensions — so the "Segmented image" panel got letterboxed inside a
  box shaped for the OTHER canvas, showing an empty gap along one edge that looked exactly like a
  data misalignment but wasn't one: checking the actual pixel data directly (a synthetic
  known-position test, then the real bundled segmentation image) confirmed both layers agree
  exactly — `segmentedImageLabels.arr`'s own first non-zero row and the closest real localization's
  own `y` both landed at row/coordinate ≈0, with no genuine gap in the DATA. The segmentation
  image's dimensions are treated as the more authoritative source for `--frame-ar` once one is
  loaded — a real, known camera FOV shape, unlike a loc-bounding-box guess that's only ever an
  approximation of the true dimensions to begin with (border-adjacent localizations are dropped
  during fitting, so it's always somewhat smaller than the real FOV regardless). The reconstruction
  panel may pick up a small letterbox gap of its own from this instead — the right trade, not a new
  problem, given which of the two shapes is actually known vs. approximated.

  `segmentedImageLabels` (`{arr,w,h}`, the loaded label array — distinct from `segmentedImageData`,
  the per-cell stats table both are built from) persists independently of whatever the raw panel
  currently shows, unlike `rawPixelData` (overwritten the moment a live frame reclaims the panel) —
  this is what **Show image**'s (`segShowBtn`) image mode re-displays (`drawSegmentedImage()` again,
  deterministic seed-0 recolouring so it's pixel-identical to the original load) without re-reading
  the file, and what the actual tracking integration below reads from. Its histogram mode plots
  `segmentedImageData.map(c=>c.areaPx)` via the shared `computeHist()`/`drawHistogram()` (linear count
  axis — cell areas aren't expected to fall off exponentially the way SPT track survival does, so no
  log axis or fit curve here, unlike `drawSptTrackLenHist()`).

  Cell colouring (`shuffledLabelColors()`) ports the *idea* behind the user's own
  `sptPALM-Python/helper_functions.py`'s `randomize_label_image()`: raster-order segmentation tools
  (e.g. `skimage.measure.label`) number cells in scan order, so physically ADJACENT cells often get
  CONSECUTIVE label values — through an ordinary continuous colour ramp, consecutive labels map to
  near-identical hues, so neighbours become hard to tell apart. The Python version shuffles which
  label value each cell receives (seeded, deterministic) before an external continuous-colormap
  call; this shuffles each label's RANK (0..N-1) instead via a seeded PRNG (`mulberry32`) and maps
  rank/N straight to a hue (`hsvToRgb`, s=0.85/v=0.95) — an equivalent decorrelation, and one that
  spaces hues evenly regardless of gaps in the original label values (the shuffle-then-relabel
  version needs the shuffled values themselves to be dense for that). Verified visually against the
  real bacteria dataset above — no two adjacent cells share a similar colour.

  **SR-panel "Show segm."/"Show recon."** (`srSegOverlayBtn`, next to "SMLM reconstruction", same
  inline-in-title-bar placement as `sSmlmColorBtn`'s "Show spectral") swaps the panel between the
  normal density reconstruction and the segmented cells (OPAQUE) with the SAME density reconstruction
  drawn on top of them, its own black background made highly transparent — so cell colour shows
  through wherever there's no real signal, while density stays clearly visible on top. Two earlier
  designs were tried and replaced, each on direct user feedback against a real dataset: a
  semi-transparent cell blend (`ctx.globalAlpha=0.28`) UNDER the opaque density reconstruction — cell
  borders unreadable under the fire colormap; then opaque cells with each localization as a plain
  white point on top, REPLACING the density image outright — reported as looking worse than just
  keeping the familiar reconstruction visible. Two offscreen canvases, both built in `drawView()`
  (MODULE: render):
  - `buildSegOverlayCanvas()` — at `segmentedImageLabels`' own CAMERA-pixel resolution (not
    `srFull`'s, which is camera px × `mag`), label 0 (background) fully transparent so panning past
    the segmentation's own edge shows black rather than a coloured fringe, every other pixel fully
    OPAQUE at its cell's colour via the SAME `shuffledLabelColors(seed=0)` call `drawSegmentedImage()`
    uses, so a cell's colour here always matches its colour in the "Segmented image" raw-panel view.
    Cached (`_segOverlayCanvas`/`_segOverlayForLabels`, keyed by object identity against
    `segmentedImageLabels`) — rebuilt only when a genuinely new segmentation image loads.
  - `buildTransparentReconCanvas()` — redraws `srFull` with alpha derived from each pixel's own
    LUMINANCE (`0.299r+0.587g+0.114b`, the same weighting `lineProfile()` already uses for its own
    sampling) rather than duplicating `renderSuperRes()`'s accumulation math a second time — every
    `LUT_CPS` ramp starts at `[0,0,0]` (fire, inferno, viridis, turbo, hsvBlue all confirmed), so
    "black" and "zero density" are the same condition for every colour map this app has, making
    luminance a safe, LUT-agnostic proxy. `*2.5` gain (first-pass, expected to be tuned) so a pixel
    reaches full opacity well before true peak density — "highly transparent" is meant to describe
    the near-zero-density background, not a permanently-washed-out reconstruction. `MIN_SIGNAL_ALPHA`
    (90) floors the alpha of any pixel with genuinely nonzero luminance — a real, reported problem
    with luminance-only alpha: every `LUT_CPS` ramp starts near-black by design, so a SPARSE/isolated
    localization (not part of a bright cluster) was already barely non-black to begin with, and
    `luminance*2.5` alone left it dim-coloured AND nearly transparent at once — compounding into
    genuinely invisible against a bright cell colour underneath, not just faint. The floor guarantees
    a visible grey speck for any real signal while true zero-density pixels stay fully `alpha=0`
    exactly as before (`lum>0` gates the floor, not a blanket minimum). Built directly at `srFull`'s
    OWN resolution so `drawView()` samples it with the exact same `sx,sy,sw,sh` as `srFull` itself, no
    extra `/mag` needed. Cached by object identity against `srFull`
    (`_transReconCanvas`/`_transReconForSrFull`) — a NEW `srFull` object only exists after
    `rerender()` actually rebuilds the reconstruction, so this rebuilds exactly when the density
    buffer itself would have.

  Neither canvas is gated on `segmentedImageLabels.w/h` exactly matching `lastResult.w/h` — an
  earlier version DID require exact equality and silently drew nothing otherwise, a real, reported
  bug (toggling the button on a real dataset did nothing, no explanation): real segmentation
  pipelines routinely produce a mask a few px off from the movie's own dimensions (padding/cropping
  in whatever tool made it), so exact equality left the button doing nothing for the common case, not
  just a genuine mismatch. Fixed by dropping the check and matching this app's own existing "warn,
  don't block" convention — the load-time size-mismatch warning (`loadSegmentedImage()`, checked
  against `stack.w/h`) already tells the user once when the sizes differ; drawing top-left aligned
  anyway just loses a thin strip at the far edge on a genuine mismatch (`ctx.drawImage()`'s own
  source rect naturally clips against the actual canvas bounds — no exception, no corruption).
  `srFull._zColor`'s depth-colour-bar legend stays shown while this mode is active (unlike the
  now-removed points-only design, the density image with its own LUT/z-colouring is genuinely still
  on screen here, so the legend stays meaningful).

  **`segmentedImageLabels.refPxNm` — segmentation/localization pixel-size decoupling.** A real,
  reported problem with the plain top-left-aligned overlay above: localization POSITIONS never
  depend on `pxnm` at all (`renderSuperRes()`'s `ix=Math.round(L.x*mag)` — plain camera-pixel
  coordinates, only the scale bar/`srInfo` nm readout derive from `pxnm`, see the live-update note
  below), so a user correcting `pxnm` AFTER loading the segmentation image — e.g. dialling it in
  until the segmented cell outlines visually line up with the reconstruction's own bacterial shapes —
  had no visible effect on the overlay at all, since nothing in `drawView()` read `pxnm`. Fixed by
  treating the `pxnm` value at LOAD time as the segmentation image's own effective calibration
  reference: `loadSegmentedImage()` stashes `segmentedImageLabels.refPxNm=paramValue('pxnm')` (ONLY
  on a genuine fresh load, not on **Show image** re-displaying the same already-loaded image — same
  "don't clobber on redisplay" reasoning as the **Max. cell area** auto-fill below). `drawView()`
  computes `segScale=(current pxnm)/refPxNm` and divides the segmentation canvas's `/mag` source-rect
  by it — `=1` (no visible change) whenever `pxnm` hasn't moved since load; as the user corrects
  `pxnm` UPWARD, `segScale>1` GROWS the segmentation's on-screen footprint relative to the (unmoving)
  localizations — each raw camera pixel the localizations sit on now spans more real nm, so a
  segmentation pixel (still `refPxNm` nm wide, unchanged) now corresponds to more of those larger
  camera pixels than it did at load time — and shrinks it symmetrically as `pxnm` is corrected
  downward. **The direction was wrong in the first shipped version** (`segScale=refPxNm/current`,
  shrinking as `pxnm` rose) — caught only by a real user checking it against actual data, not by the
  derivation on paper: double-check the direction empirically again if this formula is ever touched,
  don't trust re-derivation alone.

  Editing Pixel size (nm) while "Show recon." is active needed no new wiring: `$('pxnm')`'s existing
  `change` listener already does `lastResult.px=paramValue('pxnm'); rerender(true);` whenever a
  reconstruction exists, and `rerender()` unconditionally ends in `drawView()`, which includes this
  whole overlay block — so the scale bar/`srInfo` nm/px readout (independent of `segScale` above —
  localization positions themselves never depend on `pxnm`) redraws correctly with no extra code.

  **Cell-by-cell tracking** (`Min./Max. cell area (px)`, default 50/∞ — ∞ via the same
  `default:Infinity` PARAMS convention `fitLastFrame` already uses, an intentionally-blank HTML
  field, `paramValue()` falls back to it since `isFinite(parseFloat(''))` is false). Their two
  `label.row`s are direct children of `#sptBox` (own `id`s `segAreaMinRow`/`segAreaMaxRow`,
  `padding-left:40px`, toggled alongside `#segLoadRow` by the same **Apply segmentation?** handler)
  rather than nested inside `#segLoadRow` with its buttons — see the top-level `label.row`
  nesting-depth gotcha above for why nesting them there silently broke their own right-edge
  alignment (a real, reported bug) despite still LOOKING indented. A fresh **Load
  segm. image** (not **Show image**'s image mode, which re-displays the SAME already-loaded
  image and shouldn't silently overwrite a value the user has since adjusted) sets `segAreaMax` to
  `Math.max(...segmentedImageData.map(c=>c.areaPx))` — a real upper bound for that specific image
  instead of the generic ∞ default. Ports
  `apply_cell_segmentation_sptPALM.py`/`tracking_sptPALM.py`'s own `use_segmentations` branch from
  the user's `sptPALM-Python` pipeline. `cellIdForLoc(L,segLabels)` looks up a loc's raw label the
  same way `fmtRawPixel()`'s hover readout does; `linkTracksPerCell()` then groups locs by that
  label FILTERED through `segmentedImageData`'s own `areaPx` (`-1` — matching the reference
  pipeline's own sentinel, deliberately not `0`, which some other dataset's raw mask might
  legitimately use as a real label — for background OR a cell outside the area range, not just
  true background) and runs the existing `linkTracks()` SEPARATELY per qualifying cell, so a track
  can never cross a cell boundary. Each cell's own local `track_id` range is offset by a running
  counter (mirroring the reference pipeline's own `track_id_shift = max(tracks['track_id'])+1`) so
  the merged result stays globally unique. `sptCore()` takes an optional 5th `segCtx`
  (`{labels,areaMin,areaMax}`) parameter selecting `linkTracksPerCell()` over the plain
  `linkTracks()` call; `trackDiffusionCoeffs()` itself needed NO changes — it already skips any
  `track_id<0` loc, exactly what an excluded/background loc now carries. `runSptTrack()` only
  builds `segCtx` when **Apply segmentation?** is checked AND a segmentation image is actually
  loaded (checked-but-nothing-loaded logs a warning and falls back to plain whole-FOV tracking, not
  an error). `cell_id`/`cell_area [px]` become optional CSV/table columns exactly like
  `track_id`/`D_coeff` (present only once segmentation tracking has actually run; `parseCsvLocs()`
  reads them back for a full round trip).
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

  **Load movie/data** (`loadBtn`) is one button over ONE hidden `#file` input whose `accept` lists
  `.tif,.tiff,.nd2,.csv` together. Dispatch is by file EXTENSION alone (`/\.csv$/i`,
  case-insensitive) — real content sniffing for the movie side (`isTiffFile()`/`isNd2File()`
  magic-byte checks, MODULE: in/out) still happens further downstream, inside `loadMovieFiles()`'s
  own `loadTiffFilesAuto()`/`loadTiffFile()` call chain. `loadMovieFiles(fileList)` and
  `loadCsvFile(file)` are named functions the combined handler dispatches to. A selection mixing a
  CSV with movie file(s) is genuinely ambiguous (which did the user mean?) — refused outright with a
  logged error, NEITHER loader runs, rather than guessing via file count or order. An all-CSV
  selection with more than one file warns (doesn't block) and loads only `files[0]` — **Load data**
  never supported more than one file. `loadBtn`'s own disable-guard (Simulate/Localize in progress)
  correctly blocks a CSV load mid-run too — nothing stops `lastResult` being silently replaced by a
  CSV load while `runCore()` is still writing to it otherwise.

  `config.exportPlots` (also `--exportPlots`/`exportPlots=1` on the CLI/autorun) renders whichever
  of drift/NeNA/FRC/PCFO/calibration were actually computed this call into `result.plots`, each a
  `{pngDataUrl, svgText}` pair — reuses **render**'s `renderPlotBothFormats()`/`_plotTarget`
  redirection (the same mechanism "Save plot / image" uses interactively, see **render** below), so
  no visible browser window is needed, just a page context (which `analyze()` already runs inside).
  `drawNenaPlot(res)`/`drawFrcPlot(r)` already take an explicit result parameter, so those render
  directly; `drawDriftCurve()`/`drawPcfoPlot()`/`drawCalibration()` don't (they read
  `lastDrift`/`lastResult`, `pcfoLastPts`/`pcfoLastFit`/`pcfoLastR2`, `calib`/`calView` respectively)
  — three small `render*PlotHeadless()` wrappers next to each draw function stash the real
  module-level global(s), call `renderPlotBothFormats()`, then restore them. `calib` specifically
  needs this wrapper to live OUTSIDE `analyze()`'s own body: `analyze()` declares its own local
  `let calib=null` (shadowing the module-level one `drawCalibration()` reads), so a function that
  touches the real global has to be defined where that shadow doesn't apply. One flag renders
  everything available this run, not a per-plot toggle. The calibration plot needs a FRESH build
  this call (`calibrationFile`/`calibrationFiles`) — a bare `calibrationJson` only carries the
  derived model, not the point cloud the plot needs. The raw frame/reconstruction are never
  included (no vector form at real localization counts, same reasoning as the interactive button);
  the line-profile/histogram plots are inherently interactive (a user-drawn line / a chosen table
  column) with no headless equivalent to render from, so `exportPlots` doesn't cover them.
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
  gets, the same loc-shape either way. `checkTableSize()` guards `locTableData()` the same way
  `checkRenderSize()` guards **render**'s buffers — each table row is a small JS object (~10-12
  numeric fields), estimated at ~200 bytes/row (V8 per-object overhead, not just the raw field
  bytes) against `memgb`; throws if over budget, caught at all three build sites
  (`openTable()`/`rebuildTableData()`/the SR-crop click handler) so a too-large table fails with a
  log message and leaves whatever was on screen before, rather than risking an uncontrolled crash.
  Same `memgb`-is-a-per-feature-ceiling-not-a-shared-pool reasoning as the render guard: it was
  originally scoped to just the loaded stack's own frame cache, and there's no reliable in-browser
  signal for actually-free RAM to check against instead.

  `computeHist()`/`drawHistogram()` (the shared histogram plot, reused by table-column histograms,
  sSMLM's distance/angle histograms, and **spt**'s D/track-length histograms) can overlay a fit
  curve: `histData.curve`, a `x=>y` function sampled across the current view and drawn in the same
  bin-height units as the bars (so it overlays them with no separate rescaling), plus an optional
  `histData.curveLabel` legend string. Unlike `markers` (a `computeHist()` parameter, since marker
  positions are known before binning), `curve` isn't a `computeHist()` argument — a fit like
  `fitTrackLifetime()` needs the ALREADY-binned `histData` (bin centres/counts) to fit against, so
  the caller sets `histData.curve`/`curveLabel` directly after `computeHist()` returns, before
  calling `drawHistogram()`. Defaults to `null` (cleared by every `computeHist()` call), so every
  existing caller that never sets it renders identically to before.

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
at a time — but for a while each dispatcher (`drawDriftCurve()`/`drawSptHist()`/`drawSSmlmHist()`/
`drawSegShow()`'s `syncSegShowModeBtn()`) only knew how to show/label its OWN button, never to hide
the other three. That was invisible as long as switching between two plot-type views always passed
through one of the two "reclaim points" (`drawRaw()`/`drawSegmentedImage()`) that DO hide every
button but the relevant one — but a DIRECT switch between two plot dispatchers, with no reclaim
point in between (e.g. **Correct drift**/**Show drift**, leaving `driftPlotModeBtn` up, immediately
followed by **Preview pairs**) left the PREVIOUS toggle stranded on screen alongside the new one,
both visible and clickable at once — a real, reported bug. Fixed by having all four dispatchers
(plus `drawRaw()`/`drawSegmentedImage()` themselves, now routed through the same helper instead of
each hand-rolling its own 3-4-line hide block) call `hideOtherRawToggleBtns()` first. Any FUTURE
raw-panel toggle button must do the same — add its id to the helper's own list, and call it from
wherever that toggle's dispatcher shows/labels the button.

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

### `label.row` nesting-depth gotcha (indented sidebar sub-rows)

`details.sim>label.row{padding-right:4px}` (keeps a row's numstep +/- buttons flush with every
other row's own right edge) is a DIRECT-CHILD selector — it only matches a `label.row` that sits
immediately inside a `details.sim`, not one nested a level deeper inside a wrapping `<div>` (e.g. a
conditionally-shown sub-group like `#segLoadRow`). A `label.row` placed inside such a wrapper still
LOOKS indented (it inherits left padding from the wrapper's own `details.sim>*:not(summary)
{padding-left:14px}`), so the missing 4px right-padding is easy to miss — it reads as "close enough"
until compared pixel-for-pixel against a properly-indented row, where the numstep group sits 4px
further right than everywhere else (a real, reported bug: `segAreaMin`/`segAreaMax`, MODULE: spt,
originally lived inside `#segLoadRow` this way). An indented sidebar sub-row (the pattern
`ftmWindowRow` — Temporal median filtering's own "Window size" — established first) should instead
be a DIRECT child of its `details.sim`, given its own `id` + inline `style="display:none;
padding-left:40px"` (40px, not 14px — deliberately MORE than the generic per-section indent, so a
sub-row still reads as visually subordinate to a plain top-level row that also happens to sit inside
an indented section), and shown/hidden by the SAME handler that toggles its sibling group, not by
being physically nested inside it.

### Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

### Mobile input font-size vs. label font-size

Below the 860px breakpoint, `input.num`/`select.sel` jump to 16px (iOS auto-zooms on focusing a
smaller input; 16px is the threshold that stops it) while `label.row` text stays at the base 12px
— a real, known, deliberate size mismatch, not a bug to "fix" by shrinking the input back down.

### `<noscript>` + `.textContent +=` gotcha

Never put a `<noscript>` inside an element that JS later reads via `.textContent` (especially
`+=`, which reads-then-overwrites). With scripting enabled, a browser parses `<noscript>...
</noscript>` content as RAWTEXT — a single opaque text node, not real child markup — so
`.textContent` on an ancestor includes that raw text (literal `<span>` tags and all) even though
the `<noscript>` itself renders as nothing (default UA `display:none` when scripting is on).
Reading `.textContent` is harmless; but the moment something WRITES `.textContent` (as `log()`'s
own `.textContent += '\n'+m` does, MODULE: params — writing to `$('logText')` today, previously
`$('log')` itself before the box/text-width split below moved the seed content one level deeper),
the noscript element gets destroyed and replaced by one flat text node — permanently baking that
raw warning text into the log's own visible content on the very first `log()` call, every load,
regardless of whether scripting is actually enabled. This was a real, shipped bug: `#log`'s seed
HTML had its own `<noscript>⚠ JavaScript appears to be disabled…</noscript>` (meant as a redundant,
log-window-local echo of the real disabled-JS warning), and it showed up as literal visible text in
the log on ordinary loads with JS fully working. Fixed by removing it — the top-of-`<body>`
`<noscript>` banner (a big red full-page warning, never touched by any JS) already covers the
genuinely-disabled-JS case on its own; the log's own seed content is now just the plain build-stamp
text, with nothing noscript-wrapped inside it. The general rule: `<noscript>` is only safe near
code that reads/writes `.textContent`/`.innerHTML` if nothing ever WRITES through an ancestor of
it.

**Log box / logged-text width split** (`#log`/`#logText`) — a real, reported request: the log
card's own border/background used to be capped at `max-width:100ch` directly on `#log`, which left
its right edge short of the reconstruction panel's own right edge on a wide desktop window (the cap
existed to keep a long WRAPPED LINE readable, not to shrink the box itself — see the CSS comment
right above `.log` in the `<style>` block). Split into two elements: `#log` (the outer, still the
`class="log"` box — border/background/`overflow:auto`/scroll height, no width cap, so it fills the
card exactly like any other panel) wraps a plain child `#logText` (`max-width:80ch` — matching a
standard terminal's own width, by explicit follow-up request; the originally-shipped value was
100ch — no border/background of its own) that holds the actual text. `log()`/`clearLogBtn`/
`exportLogBtn` all read/write `#logText`'s `.textContent` now; `#log.scrollTop` (the outer box) is
still what `log()` sets to autoscroll, since `#logText` itself has no scrollbar of its own — it's
just a width-capped column
inside the real scroll container.

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
  secret held only on the GitHub and RTD sides, never in this repo). Before this, RTD had no
  webhook at all (confirmed via `gh api repos/HohlbeinLab/webSMLM/hooks` — only a Zenodo one existed,
  `events:["release"]`), so <https://websmlm.readthedocs.io/en/latest/> had been silently stale
  (still v0.10.3-era content) despite several rounds of `docs/DOCUMENTATION.md` work already having
  shipped to `main`. No API-based check exists for this the way Pages has one (`gh api .../pages/
  builds/latest`) — after a release, either check the RTD project's own Builds page, or just confirm
  the live site reflects the change a few minutes later.

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
- **In-app "more info…" popups** (`.hint` divs, the sidebar's own contextual help,
  distinct from both the deliberately-sparse Quick guide modal and this RTD manual)
  used to be hand-authored independently of `DOCUMENTATION.md` — a real, confirmed
  drift risk (both describe the same control groups, sometimes citing the same
  papers, with no mechanism keeping the wording in sync). `tools/sync_hints.mjs`
  (plain Node, zero dependencies — doesn't need `tools/`'s own `npm install`) fixes
  this by making `DOCUMENTATION.md` the single source: each `.hint` div carries a
  stable `id="hint-<name>"`; the matching content lives inside a
  `<!-- HINT:<name> --> ... <!-- /HINT:<name> -->` marker in `DOCUMENTATION.md`
  (placed right after that control group's PARAMS table in §2), as **raw HTML**
  deliberately, not Markdown — byte-identical in both places, no
  Markdown→HTML conversion step to itself go stale or introduce bugs. Verified
  the raw HTML passes through Sphinx/MyST's strict (`fail_on_warning: true`) build
  untouched (real `<ul>`/`<li>`/`<b>` in the rendered page, HTML comments
  invisible as expected). Edit a hint's content ONLY inside its
  `DOCUMENTATION.md` marker, then run `node tools/sync_hints.mjs` (rewrites
  `webSMLM.html`'s `.hint` divs to match, reindented to a flat style — cosmetically
  different from any hand-written nested indentation, not a content change) —
  never hand-edit a `.hint` div's content directly, it'll just be overwritten on
  the next sync. `--check` exits 1 without writing if `webSMLM.html` would change,
  for a pre-commit/CI-style verification that the two haven't drifted. The
  `<span class="pill">module: X</span>` label at the top of each `.hint` div is
  NOT part of the synced content (kept as fixed markup in `webSMLM.html`, so a
  marker doesn't need to know about that UI-only styling detail). All 11
  `.hint` divs (`hint-memory`/`hint-simulation`/`hint-pcfo`/`hint-calibration`/
  `hint-detectfit`/`hint-export`/`hint-render`/`hint-drift`/`hint-locprecision`/
  `hint-sSMLM`/`hint-spt`) are migrated to this mechanism. Each marker is
  placed as the INTRO to its DOCUMENTATION.md section (right after the PARAMS
  table, before any further manual-only depth) — the surrounding prose picks
  up only where the popup leaves off, not restating it.
- **Quick guide** (the in-app modal, `helpBtn`) is deliberately thin: just the intro blurb, the
  5-step **Guided workflow** (step 2 briefly names the fit-method families and points at the docs
  for depth), **Acknowledgements**, and **License & author** — no per-module walkthrough, no
  citation list; `docs/DOCUMENTATION.md` (§9 "References & further reading" for citations) is the
  maintained source for that depth now, and `DOCUMENTATION.md` is what the `.hint` popups link to
  when they need to point somewhere. The modal's own text is hand-authored UI copy, not synced by
  `sync_hints.mjs` (that mechanism only covers `.hint` divs). `README.md`'s own "Guided workflow"
  section is kept as a copy of this same 5-step list — update both together — see **Reference
  material** below.