# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (growing past 8000 lines; the file's own top-of-file **MODULE INDEX**
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
  by testing against the sample above rather than shipped). `makeCroppedStack()`
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
  allocation: refuses (throws) if either side would exceed `CANVAS_MAX_DIM` (16384 — a hard
  per-browser canvas-creation wall, not a soft budget) or if the estimated concurrent footprint
  (count accumulator + optional z-accumulator + `blur()`'s own dst/tmp scratch, when Render blur is
  on, + the final `ImageData` + the canvas's own backing store) exceeds the existing `memgb`
  control — the SAME "Memory budget (GB)" setting stack loading already uses, not a second one.
  `rerender()` catches the throw, logs what to change (lower Magnification, crop, or raise the
  budget), and leaves the PREVIOUS `srFull` on screen rather than blanking or crashing; the headless
  `analyze()` path lets it propagate, same "throws immediately" precedent as its other preconditions.
  The count accumulator (`acc`) is `Uint16Array`, not `Float32Array` — a per-pixel hit count is
  always a non-negative integer, so this halves that buffer's footprint for free; `zacc` (summed z
  in nm, genuinely fractional) stays `Float32Array`. `Uint16Array` WRAPS silently past 65535 on a
  naive `+=1` rather than clamping, so the increment is guarded explicitly (`if(acc[idx]<65535)
  acc[idx]++`) and a one-line warning is logged if any pixel saturates, rather than risking silent
  density corruption on an extreme (real-world-unlikely) localization pile-up.

  `setupPlot(cv, isPlot=false)` (shared by every draw function on the raw/sr canvases) letterboxes
  a fixed 4/3 sub-rectangle, centred within the panel's own box, for plots — rather than changing
  the CANVAS's own size. An earlier version instead gave `.is-plot` canvases their own
  `aspect-ratio:4/3` CSS (matplotlib's own default figure-size ratio), decoupled from the movie's
  real shape — which fixed axis stretching, but at a cost: since CSS Grid stretches both cards in a
  row to match whichever sibling is taller, a panel's HEIGHT then depended on whatever the OTHER
  panel happened to be showing, so switching one panel between a frame and a plot could make it
  (and its sibling) resize, which read as visually unstable. Now the canvas's own CSS box always
  tracks `--frame-ar` (the loaded movie's own w/h) exactly like a real frame/reconstruction view
  would — a panel's height genuinely never changes depending on what it (or its sibling) currently
  shows — and `isPlot=true` instead: fills the WHOLE canvas with `plotColors().bg` first, computes
  a centred 4/3 sub-rect within that box (shrunk to fit width or height, whichever binds), stashes
  the offset in `_plotLetterboxOx/Oy`, and `ctx.translate()`s to it before returning the sub-rect's
  own (smaller) W/H as if it were the whole canvas — so every existing plot-drawing function's own
  code, written against a `{ctx,W,H}` it assumes starts at `(0,0)`, needed ZERO changes; letterbox
  bars (top/bottom for a movie shorter-than-4/3, left/right for one taller) use the exact same bg
  colour as the plot itself, so the seam is invisible. `registerPlotHover()` folds the same
  `_plotLetterboxOx/Oy` into the `mL`/`mT` a caller hands it (once, centrally) since
  `drawPlotHover()`'s own hit-testing reads `clientX`/`Y` against the canvas's real, UNtranslated
  CSS box — every individual plot function's own `registerPlotHover(...)` call needed no change
  either. `drawRawView()`/`drawView()` (actual frame/reconstruction pixels) never pass `isPlot`, so
  they keep filling the panel's full box exactly as before.

  Since raw/sr canvases are now ALWAYS the same height (both track `--frame-ar` unconditionally),
  `.panel-body` (the div wrapping a canvas with its own trailing controls —
  `#scrubRow`/`#srFilterNote`/`#calViewRow`) is top-aligned, NOT centred: an earlier version of
  this same round centred each panel's canvas+controls group independently within its card, which
  shifted the two canvases OUT of alignment with each other by roughly half of whichever trailing
  control only one panel has at a given moment (raw's `#scrubRow` has no sr-side equivalent when
  `#srFilterNote`/`#calViewRow` are both hidden) — a real, reported "the two panels don't line up"
  regression, caught from a live drift-correction screenshot. Top-aligning puts both canvases flush
  against their own `h4` always, so they start at the same y regardless of trailing-content
  differences; any leftover height from that difference lands invisibly at the bottom of the
  shorter card instead of visibly offsetting its canvas.

  Every plot function reads colours from `plotColors()` (a `{bg,grid,text,axis,bar}` object) rather
  than a hardcoded hex value, driven by a module-level `_plotExportMode` flag — `false` (dark,
  `#161b22`/`#30363d`/`#8b949e`/`#e6edf3`/`#58a6ff`, matching the app's own `:root` custom
  properties) on screen always, since webSMLM has never had a separate light/dark app theme to
  hook a toggle into; `true` (the original light palette, `#f6f8fa`/etc.) only inside
  `exportPanel()`'s "plot" branch, which flips the flag, calls the panel's own `_replotRaw`/
  `_replotSr` to redraw once in light colours onto the SAME visible canvas, snapshots that via
  `cv.toBlob()`, then flips back and redraws again so the on-screen view is left exactly as it
  was — a saved PNG reads better with a white background once pasted into a paper/report, but the
  live view stays dark to match the rest of the UI. A few accent colours (fit-line green/red/
  magenta, the exponential-fit orange, marker red) stay hardcoded across both palettes — chosen to
  read clearly against either background, unlike the axis/grid/bar/background set.

  `axisScale(maxAbs)` gives an axis whose values commonly run large (PCFO's noise variance can be
  in the hundreds of thousands, ADU²) matplotlib-style "offset notation": full 6-digit tick labels
  used to visually collide with that axis's own rotated name text, so ticks instead show small
  (always a single digit plus one decimal) scaled numbers, with a single `×10ⁿ` multiplier drawn
  once near the axis — `n = floor(log10(maxAbs))`, the largest power of ten leaving ≥1 digit before
  the decimal point. This is genuine SCIENTIFIC notation (one arbitrary power per axis, picked to
  fit that axis's own range), not engineering notation's multiple-of-3 rounding, which was tried
  first and rejected: for a 500 000–750 000 ADU² range it would print "750×10³" — three digits, not
  the "1–2 digit" ticks this exists to produce. `drawPcfoPlot()` is the one plot that currently
  needs it (its noise-variance axis is the one that visually collided); the helper lives in
  **render** rather than that function so any other plot with the same large-number problem can
  reuse it without duplicating the log10/superscript logic.

  The side-by-side/stacked panel layout (`.canvases.stacked`, single column) is resolved by
  `applyLayout()`: `layoutOverride` (module-level, `null`/`true`/`false`) takes precedence over the
  `stack.h/stack.w<0.5` auto-heuristic once the user clicks **Stack panels**/**Side by side**
  (`layoutToggleBtn`) — the override then sticks across further loads this session rather than the
  next movie's own aspect ratio silently resetting the user's choice, replacing the old "code
  always decides" behaviour. `initScrub()` calls `applyLayout()` instead of setting the class
  directly; the click handler also calls `refitCanvases()` immediately, since the panel boxes just
  changed shape and the visible plot/frame shouldn't wait for the next unrelated redraw to catch
  up. `layoutToggleBtn` itself lives on the right of the **Log** card's own title bar (grouped
  there with `clearLogBtn`/`exportLogBtn` on the left of the same bar) rather than a dedicated row
  above the canvases — an earlier version used a standalone `.canvases-toolbar` row for just this
  one button, which read as wasted vertical space once the Log title bar had room for it instead.
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
  Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022). Role assignment (which point of a pair is
  0th vs 1st) is **directional, not brightness-based** — real-data investigation found photon
  count barely correlates with position (≈50/50 even at confident intensity gaps, likely
  PSF-overlap/crowding corrupting photon estimates at real emitter densities), so
  `sSmlmAngleCenter` is now a genuine SIGNED bearing (full ±180°, not an undirected line) and
  `sSmlmCandidates()` returns both the undirected `angle`/`dAngle` (for Preview's diagnostic
  histogram) and the raw unfolded `rawAngle` `pairCore()` needs. `pairCore()` classifies each
  candidate by direction into `outEdges`/`hasIncoming` maps, then a point qualifies as a 0th order
  only if it has ≥1 outgoing edge (a candidate on the configured bearing) AND zero incoming
  evidence (no candidate on the opposite bearing, which would mean it's more likely someone else's
  1st order) — self-disqualifying, no brightness needed; verified against real data to recover
  MORE pairs than the old brightness-gated approach (64.0% vs 59.0%) with only ~5% of points
  landing in the genuinely ambiguous "both sides" bucket it correctly excludes. PSF width (σ)
  showed a real but imperfect ~65–70% correlation with role (1st order is spectrally smeared,
  hence broader) and is available as an optional, default-OFF extra filter
  (`sSmlmRequireNarrower`) — not required, since it's still far from reliable enough to gate on by
  default. **2-point pairs only** (0th+1st) — multi-order chaining and FFT-based angle/distance
  auto-detection are `docs/REFACTOR_PLAN.md` follow-ups, not implemented; the interactive
  **Preview pairs** distance/angle histograms (reusing `computeHist()`/`drawHistogram()` from
  **table**) cover "find my window" instead — always fetched over a WIDE fixed scan (0–6000 nm,
  wider if `sSmlmDistMax` already exceeds that; any angle), ignoring the current field values, so
  narrowing either one first can't hide the true peak or clip the histogram to the wrong window.
  **Show dist. hist.** plots that full wide scan with the current Distance min/max overlaid as
  vertical markers (`computeHist()`'s new optional 4th `markers` param, `[{x,label}]`, read live at
  draw time); **Show angle hist.**, unlike the distance one, DOES restrict to the current distance
  window (angle signal is only sharp within the real peak — pooling the wide scan's off-peak
  distances would just dilute it with background) and plots each candidate's `rawAngle` AND its
  exact reverse (`+180°`, both `wrap360()`-ed into a window centred 90° off `sSmlmAngleCenter` so
  neither peak sits at the seam) — plotting only the raw single bearing looks wildly asymmetric,
  since which of a candidate's two points gets the smaller array index (and therefore which
  direction `rawAngle` reports) is a row-order accident, not evenly split in real data; doubling it
  makes the two peaks equal, as an undirected diagnostic should show. `fitSSmlmAngle()` (**Fit
  angle & tol.**) estimates `sSmlmAngleCenter`/`sSmlmAngleTol` from that same distance-windowed,
  doubled-bearing data — 2°-bin peak detection + half-max-width walk, THEN DOUBLED as a safety
  margin (verified against the real reference dataset: the raw half-max width alone came out ~1°,
  vs. the ~5° that actually worked well by hand — halfMaxTol*2 trades some precision back for
  recall closer to a hand-tuned window's). Both histograms also draw the CURRENTLY configured
  window as markers (`computeHist()`'s optional 4th `markers` param) — the distance one shows
  `sSmlmDistMin`/`Max` as two lines over the full wide scan; the angle one mirrors
  `sSmlmAngleCenter`±`sSmlmAngleTol` onto both plotted peaks. `refreshSSmlmHistIfShown()` (a
  `change` listener on all four fields, and also called directly at the end of `fitSSmlmAngle()`)
  redraws whichever histogram is on screen so the markers track the fields live — both from manual
  edits and right after a fit — without needing a manual re-click. An unpaired
  localization is dropped from the result,
  not carried through unchanged. A pair's reported position is the 0th order's OWN x/y (undispersed
  — its centroid already is the true position), not the midpoint: the 1st order's offset varies
  per emitter with wavelength, so averaging would blur position by up to half that offset. Each
  paired row also carries `sigma1st` — the 1st order's OWN `sigma` (already read once for
  `sSmlmRequireNarrower`'s comparison, threaded through instead of discarded), exported as a
  `"sigma1st [nm]"` CSV column and a `sigma1st` table column whenever any paired loc has it. NOT a
  directional/long-axis width: every 2D fit method (phasor/LS/2D MLE) fits one symmetric `sigma`,
  no `sx`/`sy` split the way the 3D astigmatic fit has — this is the closest available proxy for
  "how much wider the spectrally-smeared 1st order looks," not a true per-axis PSF decomposition.
  Stores the inter-order distance in its own `dist` field — **deliberately never `z`**, an earlier
  design that overwrote/aliased `z` was reverted (2026-08-17) specifically so a future 3D-fit +
  sSMLM combination could carry real depth AND spectral distance on the same loc without one
  silently clobbering the other; `pairCore()` never even sets `z` (the guard below guarantees it's
  always absent on its input already). `renderSuperRes()`/`zRange()` take an explicit `colorField`
  parameter (`'z'` or `'dist'`) instead of hardcoding `.z`, so the SAME depth-coded render path
  colours by either; `rerender()`/`analyze()` derive it as `hasZ ? 'z' : (hasDist ? 'dist' : null)`
  — only one is ever reachable today (see the guard below), so this is unambiguous, but the seam is
  real, not hypothetical. The sidebar's own **Colour by depth (z)**/**z min/max (nm)** labels
  (`zcolorLabel`/`zminLabel`/`zmaxLabel` spans) are set from the SAME `colorField` in `rerender()`
  — "z min (nm)" would be flatly wrong wording while these controls are actually constraining an
  sSMLM `dist`, so they read "sSMLM distance min (nm)" etc. instead whenever `colorField==='dist'`;
  `updateMethodUI()`'s 3D-method branch also sets the "z" wording directly (not just via a
  `rerender()` call, which may not have fired yet — e.g. switching method before any Localize).
  This split is also what fixed a genuine bug found while making it: drift
  correction's "Correct z too (3D)" option used to key off the same `has3d` check the colour toggle
  used, so it would show — and if ticked, silently 1-D-"correct" — a paired result's spectral
  `dist` as if it were spatial depth. `driftZRow`'s visibility (and `driftCore`'s own `has3d` gate)
  is keyed on real `z` alone now, never `dist`, which structurally can't happen once the two fields
  are genuinely independent. **`pairCore()` itself throws** (not just the interactive wrapper) if
  the input already has real 3D `z`, OR if it already has a `dist` field (i.e. is already-paired
  output) — the second guard is new alongside the `z`/`dist` split: with `z` no longer touched by
  pairing, re-pairing an already-paired result can no longer be caught as a side effect of the
  z-guard the way it used to be, so it needs its own explicit check. Both guards apply to every
  caller uniformly, interactive or headless. Interactively, **Pair** also
  sets `zmin`/`zmax` to the configured distance window (not the usual auto-fit) since every
  accepted pair's `dist` already lies inside it by construction. Three module-level vars track state:
  `sSmlmOriginalLocs` (the TRUE raw backup, captured once — same pattern **in/out**'s raw-panel
  crop tool uses for `originalStack` — and ALSO the authoritative pairing input: Preview/Pair
  always read `sSmlmOriginalLocs || lastResult.locs`, never `lastResult.locs` alone, since that may
  currently be an already-paired subset with no 1st-order companions left to find),
  `sSmlmPairedLocs` (latest Pair result, replaced on re-Pair), and `sSmlmShowingRaw` (which of the
  two `lastResult.locs` currently is). The reconstruction-panel toggle (`sSmlmColorBtn`, "Show
  spectral"/"Show standard") swaps `lastResult.locs` between them (plus `zcolor` to match) — a real
  data swap, not just a colour flip — so "Show standard" is the literal unpaired reconstruction,
  without discarding the pairing the way Unpair does. **Headless**: `config.sSmlmPair` (v0.11.1)
  runs pairing right after Localize, before drift/NeNA/FRC — same config-gated-optional-step
  pattern as `config.correctDrift`/`config.estimateGainOffset`; `pairCore()`'s own throws propagate
  immediately (no separate headless guard needed), and the result's `sSmlmPair` field records
  `nPairs`/`nInput`/`meanDistance`/`stdDistance`. `tools/webSMLM-cli.mjs`'s `--sSmlmPair` and
  `?autorun=`'s `sSmlmPair=1` both forward to it.
- **spt** (single particle tracking, v0.11.2) — links per-frame localizations into trajectories and
  computes a per-track diffusion coefficient. A trackpy-**inspired** variant (same
  `search_range`/`memory` terminology and linking philosophy as the Python `trackpy` package), not
  a literal port of its source — no way to call real Python trackpy from a static HTML page. Ported
  from the user's own `sptPALM-Python` pipeline (L. lactis sptPALM, Martens, van Beljouw, van der
  Els, Vink, Baas, Vogelaar, Brouns, van Baarlen, Kleerebezem & Hohlbein, *Nat. Commun.* 10, 3552,
  2019): `tracking_sptPALM.py`'s `tp.link_df(search_range=…, memory=…)` call, and
  `diff_coeffs_from_tracks_fast.py`'s `diff_coeffs_per_track()` for D. `linkTracks()` walks frames
  in order; each frame's track↔candidate bipartite graph (edges within `sptSearchRange`, gated by
  `sptMemory` for gap-bridging) is split into connected components ("subnetworks" — trackpy's own
  term) via union-find, each solved by a self-contained Hungarian/Kuhn–Munkres implementation
  (`hungarianAssign()`) for the minimum-total-squared-displacement assignment — keeps crossing
  trajectories from swapping identity in the common case (verified: a synthetic two-particle
  crossing test stays perfectly monotonic on both tracks). NOT a literal port of trackpy's own
  recursive exact-subnetwork solver, which handles arbitrarily large ambiguous clusters exactly;
  real single-molecule SPT data (PALM-style — only a sparse subset of molecules on at once) isn't
  expected to hit this, but components above `HUNGARIAN_MAX` (120) fall back to greedy
  nearest-neighbor instead, with a one-time logged warning, rather than let O(n³) stall the tab on
  a pathologically dense frame — a real, documented scope limit, not silently glossed over. Returns
  a NEW locs array (`linkTracks()`/`trackDiffusionCoeffs()`/`sptCore()` never mutate `locs`, same
  convention `pairCore()`/`driftCore()` use) with `track_id` set on EVERY localization (even
  length-1 tracks, matching trackpy's own behaviour — length filtering happens only at the
  diffusion-coefficient step, same division of responsibility the reference pipeline uses).
  `trackDiffusionCoeffs()` ports `diff_coeffs_per_track()`'s core MSD math (not its track-length
  handling — see below): one D (µm²/s) per track with at least `sptTrackLenMin` localizations, from
  the gap-corrected mean of ALL of that track's own single-frame squared displacements — an
  average, explicitly NOT a linear MSD-vs-lag-time fit, matching the reference pipeline exactly
  (its own separate `tp.utils.fit_powerlaw()` is a different, aggregate diagnostic this function
  doesn't reproduce) — `D = MSD/(4·frametime) − locError²/frametime` (2D,
  static-localization-error-corrected). Unlike the reference pipeline there is no `sptTrackLenMax`
  truncation: an earlier version capped each track to its first N localizations for equal per-track
  weighting in a length-resolved histogram, but webSMLM doesn't build that view (yet), so every
  qualifying track's MSD now uses all of its own steps — more data per track, no arbitrary cap.
  `trackDiffusionCoeffs()` also collects `trackLengths` for EVERY linked track regardless of
  whether it qualifies for a D estimate — `drawSptTrackLenHist()`'s log-Y-axis (count axis; track
  counts fall off steeply with length, and a linear axis would flatten the useful range into a
  sliver) histogram of this is exactly how a user judges whether `sptTrackLenMin` is set sensibly
  for their data, so it can't only show tracks already past that threshold. `computeHist()`/
  `drawHistogram()` (table module) gained an optional 5th `logY` parameter for this — bars/ticks
  map through `log10(count)`, with a 0-count bin naturally pinned to the axis floor via
  `log10(max(1,c))=0`; `registerPlotHover()`'s hover readout is linear-interpolation-only and
  transform-unaware, so log mode hands it log-space `yTop`/`yBot` bounds and undoes the transform
  inside its own `fmt` callback instead of teaching the shared hover code a Y-scale option. A real,
  expected artifact of the D formula is that near-immobile or very-short tracks can compute a
  non-positive D (MSD below the subtracted error term) — `drawSptDHist()` EXCLUDES these from the
  plotted log10(D) histogram (with a logged count, not silently dropped) rather than clamping them
  into one bin; an earlier version's clamp pooled potentially hundreds of unrelated tracks into a
  single artificial-looking spike with no biological meaning, which is what a log-binned
  `np.histogram()` call (the reference pipeline's own approach) avoids implicitly by just excluding
  out-of-range values. **Track** (`runSptTrack()`) is idempotent and safe to re-run any time —
  unlike sSMLM's Pair, it never reduces row count or aliases another field, only sets/overwrites
  `track_id`/`D_coeff`, so there's no `sSmlmOriginalLocs`-style original-vs-tracked state to
  manage. Immediately draws the D histogram in the raw panel via `computeHist()`/`drawHistogram()`,
  fed `log10(D)` values (`'log10(D)'` as the pseudo-column name) rather than raw D — D commonly
  spans orders of magnitude between bound/slow and free/fast populations, matching the reference
  pipeline's own default logarithmic axis; a real v1 shortcut, not yet nicely `10^x`-formatted tick
  labels (`docs/REFACTOR_PLAN.md`). `sptDPlotMin`/`Max` (µm²/s, defaults from
  `set_parameters_sptPALM.py`'s own histogram range) are a DISPLAY-only axis window —
  `drawSptDHist()` excludes tracks outside them from the plotted/binned histogram exactly like
  non-positive D, but `meanD`/`medianD` (logged by both `sptCore()` and `recomputeSptD()`) always
  reflect every qualifying track, never just the plotted window; the two fields live-refresh the
  histogram (if shown) on `change`, via the same `rawIsPlot && rawPlotName==='histogram' &&
  histData.col===…` shown-check pattern `refreshSSmlmHistIfShown()` already established, renamed
  `refreshSptDHistIfShown()`/`refreshSptTrackLenHistIfShown()` here.

  D = (MSD/4 − locErrorUm²)/frametime is exactly linear in 1/frametime, and MSD itself (cached per
  track, µm², in `trackDiffusionCoeffs()`'s returned `trackMSD` Map — plumbed through `sptCore()`
  into `lastSpt.trackMSD`) depends on neither frametime nor locError. `recomputeSptD()` exploits
  this: editing **Frame time** or **Localization error** after **Track** has run rescales every
  track's D (and `lastResult.locs`' own `D_coeff`, and `lastSpt.meanD`/`medianD`, and the D
  histogram if shown) directly from `trackMSD`, with no re-linking or re-summing of steps — unlike
  **Search range**/**Memory**/**Min track length**, which change which tracks/steps exist in the
  first place and still require a fresh **Track** click. The **from NeNA** button's programmatic
  `sptLocError.value` write doesn't itself fire a `change` event, so its handler calls
  `recomputeSptD()` explicitly rather than relying on the listener.

  `drawSptTrackLenHist()` fits an exponential decay (`fitTrackLifetime()`, count(L) ~
  A·exp(−L/τ) — a photobleaching-limited survival model) to its own already-built `histData` via
  unweighted least-squares on ln(count) vs bin centre (zero-count bins skipped, same
  non-positive-value-exclusion precedent as `drawSptDHist()`; a non-decaying or under-populated fit
  returns `null` and the histogram still renders, just without a curve). The fit is attached as
  `histData.curve`/`curveLabel` — see **table**'s `computeHist()`/`drawHistogram()` entry above for
  how the shared histogram plot draws that curve generically. τ is reported in both locs and
  seconds (`× sptFrameTime`) in the log and on-plot legend; **locs≈frames only when `sptMemory=0`**
  — a bridged gap still counts as one "loc" of track length despite spanning >1 frame, so the
  seconds figure is an approximation once gap-bridging is active, called out explicitly in the log
  line rather than presented as exact. **Frame time** changes live-refresh just this label (the
  histogram's own bins don't depend on frametime) via `refreshSptTrackLenHistIfShown()`.
  `sptLocError`'s **from NeNA** button transfers
  `lastNena.sigma` (a new stash `computeNeNA()` writes, locprecision module) into it — same
  compute-once/transfer-separately split PCFO's `pcfoLastGain`/`pcfoLastOffset` already use, never
  silently auto-applied. `track_id`/`D_coeff` are independent, optional table/CSV columns (same
  pattern this project already used for sSMLM's `dist`/`sigma1st`), so the existing filter grammar
  works on tracking data for free (e.g. `D_coeff > 1 and track_id > 0`). No cell-segmentation-aware
  tracking (the reference pipeline's `use_segmentations` branch — webSMLM has no concept of cell
  masks), no length-RESOLVED D histogram (D binned by track length, distinct from the plain
  track-length histogram above, which webSMLM does have), no colour-by-D/by-track rendering, and no
  headless exposure yet — all tracked as `docs/REFACTOR_PLAN.md` follow-ups, same "interactive
  first" precedent sSMLM's own headless exposure followed.
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
  them in a batch, at an explicit release, per the cadence above. **Same round: check the
  top-of-file MODULE INDEX comment against a fresh `grep -n "MODULE:"`** and refresh any line
  number that's drifted by more than a few lines — cheap to check every time, and it's the whole
  point of the index that it stays trustworthy rather than becoming another stale comment.
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
