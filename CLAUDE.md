# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file describes the **current** state of the codebase and standing conventions — not a
chronological history of how it got there. Shipped-feature history (specific bug reports, rejected
approaches, exact before/after numbers) lives in [`CHANGELOG.md`](CHANGELOG.md), which is the place
to check "why did we do X" for anything not covered below; forward-looking ideas live in
[`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md). Keep this file that way: when you fix something,
update the relevant paragraph below to reflect the new *current* behavior rather than appending a new
"reported... fixed..." entry — the report itself belongs in the commit message and CHANGELOG.md.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (~20,800 lines; the file's own top-of-file **MODULE INDEX** comment gives
current per-module line numbers — re-`grep -n "MODULE:"` if it looks stale, and refresh it alongside
a build-letter bump when a change has moved things by more than a few lines). It loads a raw TIFF
stack, detects/localizes emitters, and renders a super-resolution image, **entirely client-side** (no
upload, no server, no network calls at runtime). `index.html` is just a redirect to `webSMLM.html`
for the bare Pages URL.

`webSMLM.html` itself has **no build system, no package.json, no dependency install, and no test
runner.** "Running" the app = opening `webSMLM.html` in a browser (double-click, or the hosted
Pages copy). Do not introduce a bundler, framework, or npm dependency to the app itself — the
zero-install single-file property is the point. New third-party code must be inlined and its
license honoured in the head banner. (`tools/` is the one exception: a separate, optional
Node+Playwright CLI for headless/scripting use — see **pipeline** below — with its own scoped
`package.json`, deliberately kept out of `webSMLM.html` so the app's own property is untouched.)

## Editing model

All work happens inside `webSMLM.html`. It is organized into commented `MODULE:` banners; find the
relevant one before editing rather than scrolling. The code itself carries extensive inline "why"
comments at nearly every non-obvious decision — the summaries below are a map to get oriented and a
place to record cross-cutting facts, not a substitute for reading the code's own comments once you're
in a module.

- **params** — the `PARAMS` registry: single source of truth for every analysis/render/export
  parameter (`name → {label, min, max, step, default, int}`), read via `paramValue(id)`. Drives the
  HTML controls' min/max/default (`syncParamControls()`), Save/Load Settings, and the headless
  `window.webSMLM.analyze(config)` config — a new `PARAMS` entry is automatically available to both
  with no extra wiring. Deliberately excludes pure display/layout (CSS) and per-dataset working state
  (`calFirst`/`calLast`/`zmin`/`zmax`).

  `addNumberSteppers()` wraps every `input.num` in a `.numstep` span with an always-visible
  Inkscape-style `.numstep-btns` −/+ pair (not the browser's native spinner — inconsistent look
  across engines, hover-reveal only, unreachable on touch). Reads each input's already-present
  `min`/`max`/`step`, so any current or future `.num` field gets steppers for free. Clicking
  dispatches real `input`/`change` events.

  `pxnm` ("Pixel size (nm)") and `frametime` ("Frame time (s)") are pinned always-visible near the
  top of the sidebar, outside any collapsible section — both are per-dataset acquisition properties
  several modules (spt, smFRET) depend on, not settings local to one module. `gain`/`camoffset`/**Get
  estimate** sit at the top of **Localisation settings**, right below **Real-time update**.

  **No checkbox or control label ends in "?"** — a plain house-style convention (e.g. **Apply
  segmentation**, **3D localisation**, **Analyse FRET**, **Position donor**). `select.sel:disabled`
  needs its own explicit `{opacity:.45;cursor:not-allowed}` rule — its `color:var(--fg)` defeats a
  browser's native disabled-dimming, so `.disabled=true` alone is invisible without it.

- **in/out** — TIFF/ND2/FITS parsing; in-memory vs. streamed loading; handles multi-GB files via
  `File.slice()` (never fully loaded). `loadTiffFile()`'s dispatch chain: FITS (`isFitsFile()`, magic
  byte) → ND2 (`isNd2File()`, magic `0x0ABECEDA`) → TIFF-in-disguise (`t256`/`t257` sanity-checked —
  UTIF returns one EMPTY ifd object, no exception, on non-TIFF bytes) → whole-file
  (`file.arrayBuffer()`) vs. streamed (`loadMultiIfdStreaming()`), gated by
  `effSliceMin=min(SLICE_MIN≈1.5GB, readBudget())` — ties the streaming threshold to **Budget raw
  movies (GB)** (`memgb`), which defaults to `0` (not `3`) on a memory-constrained device
  (`isMemoryConstrainedDevice()`, `MOBILE_MEM_DEFAULTS`/`syncParamControls()`, MODULE: params) — a
  `0` budget floors `effSliceMin` at `0`, so EVERY movie load on such a device takes the streamed
  path regardless of file size, never the whole-file-cached one. **`isMemoryConstrainedDevice()`
  deliberately checks the SMALLER of `window.innerWidth`/`innerHeight`, not width alone** — a phone
  held in landscape swaps its two CSS dimensions, so its WIDTH commonly exceeds the 860px threshold
  even though the device itself hasn't changed (a large iPhone's landscape viewport is ~926px wide) —
  exactly backwards for a device-class check, which should be orientation-independent.
  `isMobileViewport()` (width alone) is a SEPARATE function, still correct for its own purpose — the
  sidebar-drawer layout decision, which only cares about available horizontal space, not device
  class. See **pipeline**'s own paragraph below for the full `memBudgetGB`/`memgb`/`chunkmb` picture
  and the one-time mobile memory warning pop-up.

  A multi-file selection (`loadTiffFilesAuto()`) auto-detects strategy from `files[0]`'s own frame
  count: exactly 1 frame/file → `loadTiffSequence()` (file-per-frame, natural-sorted); more than 1 →
  `makeConcatStack()` (one acquisition split across files by size). Candidates are filtered by
  sniffing real magic bytes, never by extension. One detection path (`loadTiffFilesAuto()`) backs the
  interactive file input, calibration loading, and the headless `cfg.files`/`cfg.calibrationFiles`.

  `tiffScaleHint(ifd0, desc)` reads `finterval=`/pixel size from the `t270` description text (only
  when `unit=` says micrometers); it sanity-checks the FINAL resolved nm value (1–100000), not just
  the raw tag `>0` — a `0xFFFFFFFF` "unset" XResolution sentinel some writers emit otherwise produces
  a fabricated "≈0.0 nm/px" line. `mmMetadataHint(ifds)` separately reads Micro-Manager's own
  per-frame JSON metadata (tag 51123, `ifd.t51123.join('')` — UTIF stores an ASCII tag's value as an
  array holding the whole string) for camera identity/exposure/pixel-size, and estimates frame
  interval from a `MM_HINT_SAMPLE=25`-frame evenly-spaced sample's median inter-frame gap (not every
  frame — 40,000 `JSON.parse()` calls would measurably slow a large-stack load for no real gain).

  **Native ND2** (experimental): reverse-engineered directly from real sample bytes (not ported from
  a GPL reader) — a flat run of 16-byte-header chunks (`magic+dataOffset+dataLen+4 reserved`, then a
  `!`-terminated name, then payload, each padded to the next 4096-byte boundary);
  `readNd2ChunkHeader()` walks the whole chain (the required `ImageAttributesLV!` metadata sits near
  EOF, after all frame data). `parseNd2LvField()` recursively decodes Nikon's binary key-value
  format — a container's own `byteLen` must never be used as the parse boundary (it can include
  trailing padding); string fields are null-terminated UTF-16LE with no length prefix.

  **Native FITS** (experimental, camera-movie subset only — a single primary HDU, 2D image or
  2D+frame-axis cube, `BITPIX` ∈ {8,16,32,-32,-64}, general `BZERO`/`BSCALE`). **Row orientation**:
  FITS stores row 1 at the BOTTOM with index increasing upward (Pence et al. 2010, *A&A* 524, A42
  §5.1) — the opposite of TIFF/canvas's top-down convention — so `decodeOne()` reads output row `y`
  from source row `h-1-y` directly. `fitsParseHeader()` walks 80-byte cards until `END`, growing its
  read by one 2880-byte block at a time.

  `makeCroppedStack()` (raw-panel crop tool) slices every fetched frame to a fixed rectangle and
  REPLACES the module-level `stack` (kept in `originalStack` while active) — a full stack swap, not a
  search-region restriction threaded through detect/fit, so no downstream consumer needs a coordinate
  offset added back.

  **FTM** (`ftmEnabled`/`ftmWindow`, controls live in **fit**'s sidebar despite the functions living
  here) is a per-pixel sliding-window temporal median subtraction, floored at `camoffset` (not zero
  — see **fit**). Two independent uses: (1) scrubbing preview (`ftmFrame()`/`ftmFrameParallel()`, one
  frame at a time, row-band parallelized); (2) Localize — either `makeFtmStack()` (main-thread,
  single-flight, when no worker pool) or a **barrier-phased loop** inside `runCore()` (a full
  FTM-correction phase over the WHOLE worker pool, then a full detect/fit phase, per chunk — never
  both job types on the pool at once, since each worker has exactly one `onmessage` property, not a
  queue). Both context-fetch paths must widen beyond naive `coreStart±window/2` near either end of
  the WHOLE stack (not just the Run's own frame range), matching `ftmSeriesGlobal`'s own per-frame
  clamp — a stack's tail frames otherwise get a biased, too-narrow window.

- **simulation** — the built-in synthetic stack generator ("Simulate movie"): demo/validation/
  teaching data, not a core analysis path. Split out from in/out since it doesn't load anything.

- **detect** — per-frame band-pass, one of three filters selectable via `#detFilter`: à trous
  B-spline **wavelet** (default), **DoG** (both thresholded by local maxima above `mean+k·σ`), or a
  **uniform box filter** (difference of two box averages, thresholded by a plain intensity value plus
  a σ_PSF-sized square dilation, per Huang et al. 2011). `detectSpots()` is the single dispatch point
  (main thread and workers) that picks the right band-pass + maxima function. Each filter's own
  threshold field (`detection_<method>_<setting>`) is separate by design — the thresholds mean
  different things (k·σ multiplier vs. raw intensity), don't unify them.

- **fit** — phasor (fast, non-iterative), least-squares 2D-Gaussian, and Poisson-MLE 2D/3D/
  Elliptical (`gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`;
  `gaussianMLEspheric` is the default) localization. All fitters take `gain,camoff` and convert every
  pixel to true photon units — `(raw-camoff)*gain` — before fitting, matching Picasso's architecture;
  MLE's Poisson likelihood and CRLB (`lpx`/`lpy`) are only statistically correct fit in photon units.

  **Shared MLE accumulator**: the 3 MLE fitters run on one Fisher-scoring Newton driver
  (`mleNewtonFit(n, th, mstep, clampFn, ..., modelFn)`), the same shell Picasso 0.11.0's
  `_estimator_terms` uses; `gaussianFit` (LSQ, Gauss-Newton + backtracking) is deliberately separate
  (different per-pixel weighting, different solver). `gaussianMLEellipticangled` ("Gauss MLE rotated
  elliptical") adds a real new model — `[x,y,N,bg,σx,σy]` plus a rotation angle, fixed (from
  `sSmlmAngleCenter`, when **3D localisation** is unchecked) or free (when checked; the seed
  deliberately breaks σx==σy symmetry to avoid a singular angle Hessian) — motivated by sSMLM, which
  needed a real directional PSF-width measurement, not a symmetric-fit proxy. Point-sampled, not
  pixel-integrated, matching Picasso's own `_accumulate_rotated`.

  **Accept/reject drift gate** for all 5 fitters is bounded by `FIT_MAX_DRIFT_SIGMA_MULT`(2)×the SEED
  σ_PSF (`sigma0`, never the fit's own output — that would be circular), not by Fit radius (`winr`)
  — coupling the two gave different accepted counts at `winr` 3 vs 4 on identical, real crowded data.
  `MLE_MIN_SIGMA`/`MLE_MAX_SIGMA` (0.5/6, same bound as the LSQ fitters) reject any MLE result pinned
  at either σ bound. Both constants are stringified into the detect/fit worker via `WORKER_PRELUDE` —
  see the Web Worker gotcha below.

  `apertureGeometry(win)`/`percentile(sortedVals,p)` are a shared aperture-photometry helper: a
  circular signal disk (`r=(win-1)/2`) plus a separate background annulus (`r < distance <= r+2.5`),
  background estimated via that annulus's 56th percentile — published method (Martens et al., *J.
  Chem. Phys.* 148, 123311 (2018), SI §S11, "Aperture photometry to assess intensity and background
  levels," adapting Preus, Hildebrandt & Birkedal, *Biophys. J.* 111, 1278 (2016)), and this IS the
  paper's own intended background/intensity method for phasor's own values, not a separate
  smFRET-only technique (SI §S10 covers the phasor DFT itself; §S11 immediately follows it for
  exactly this purpose) — confirmed directly by the paper's co-author, resolving an earlier round's
  mistaken back-and-forth over whether phasor's own background should instead be some other,
  narrower, ROI-only estimate. The SI's own prose ("pixels with distance to the ROI center smaller
  than the ROI radius minus 2" = signal, "between [ROI radius minus 2] and [ROI radius plus 0.5]" =
  background, else excluded) uses "ROI radius" to mean `r+2`, NOT this codebase's own `r` — solving
  for `r` directly reproduces `apertureGeometry()`'s exact geometry (signal ≤ `r`, background out to
  `r+2.5`), independently cross-checked against the SI's own Figure S11: only its 15×15-pixel panel
  shows any EXCLUDED (black) corner pixels, which only happens when the background cutoff is `r+2.5`
  (a 15×15 box's own corner distance, 7·√2≈9.90, just exceeds `r+2.5=9.5` at that one size — every
  smaller panel's own corner distance stays under its own `r+2.5`, matching zero exclusions there).
  Used by both `phasorFit()` and smFRET's `apertureIntensity()` — one implementation, not two.
  `phasorApertureIntensity(img,w,h,cx,cy,win,gain,camoffset)` is this piece extracted out of
  `phasorFit()` (pure refactor, behavior unchanged) so the GPU-fit seed builder below can call it
  directly.

  **Phasor/Phasor 3D are GPU-accelerated** (`WGSL_FIT_PHASOR`, MODULE: gpu) — a real gap closed, not a
  deliberate exclusion (`GPU_FIT_METHODS` was just missing `'phasor'`/`'phasor3d'`). Unlike the
  Newton-iterated MLE kernels, Phasor is the one CLOSED-FORM fit here: no iteration, no Fisher matrix,
  and — since `phasorFit()` never returns `null` — no accept/reject gate at all, so CPU and GPU produce
  IDENTICAL candidate counts by construction (verified: `tests/gpu/bench-fit.mjs` shows exact zero
  discordance across every phasor case, unlike every MLE method's own inherent f32/f64 boundary
  noise). The row/col Fourier sums `phasorFit()` builds via two intermediate K-length arrays are
  algebraically equivalent to one direct double sum over the K×K window with per-pixel trig weights
  (swapping summation order, Σ_dx Σ_dy = Σ_dy Σ_dx — verified numerically to ~1e-14) — this removes the
  need for ANY per-candidate temporary array in the WGSL kernel, so it needs no per-Run kernel
  regeneration the way `wgslGaussJordan(n)` genuinely does for its own matrix size. Photons/bg/bgstd
  are NOT computed on the GPU at all: `phasorApertureIntensity()`'s own background annulus reaches
  `r+2.5` px, WIDER than the K×K fit window this kernel (or any other GPU-fit kernel) ever sees, so
  they're computed once per candidate on the CPU/worker side during seed-building
  (`buildFitSeedRowPhasor()`) and passed straight through as plain numbers — no new GPU buffer type
  needed. Measured (`tests/gpu/bench-fit.mjs`): 1.5×–35× speedup depending on candidate density and
  fit window size, comparable to or exceeding several MLE cases despite phasor doing genuinely less
  arithmetic per candidate — GPU dispatch overhead is amortized the same way across either kind of
  fit, by batching many frames' worth of candidates into one dispatch (`makeGpuFitAccumulator()`,
  MODULE: gpu).

  `winr2d`/`winr3d` are the fields actually shown in the sidebar; the underlying `winr` (still what
  every `$('winr')`-based mechanism — PARAMS, live-preview listeners, worker dispatch — reads) is
  hidden but kept mirroring whichever context is active by `applyWinrDefault()`
  (`currentIs3d()`-driven), which is non-clobbering once `winr` has been hand-edited away from its
  last auto-set value, and only dispatches a `change` event when the value is genuinely changing (a
  spurious `change` here used to re-trigger `locateBeadsForCalib()` while **Fix bead x,y** was
  checked, silently reverting the calibration graph back to the bead composite).

- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting. `LUT_CPS` maps: `fire`/`inferno`/`viridis`/`turbo` are smooth ramps for
  continuous data; `hsvBlue` is a cyclic full hue loop (**Pair** auto-selects it).

  `renderSuperRes()`'s accumulator buffers are DENSE (O(w·h·mag²), independent of localization
  count). `estimateRenderBytes(W,H,zColor,blurPx,renderMode)` is the pure, no-throw formula behind
  this — callable from `runCore()` (MODULE: pipeline) too, so a Run can reserve room for the render
  that will follow it BEFORE it happens, not just guess. `checkRenderSize()` is the thin wrapper that
  actually throws: refuses before any allocation if either side would exceed `CANVAS_MAX_DIM`(16384),
  or if `estimateRenderBytes(...) + reserveBytes` exceeds `memBudgetGB` — the opt-in TOTAL memory
  ceiling (default `Infinity`/unset on desktop, `0.5` on a memory-constrained device — see
  **pipeline**'s own paragraph for the full picture), a no-op until one is actually set on desktop.
  `reserveBytes` (default 0) is
  memory ALREADY committed elsewhere that this render has to coexist with (see below); `rerender()`
  leaves the PREVIOUS `srFull` on screen on failure rather than blanking. `LOC_ROW_BYTES` (right
  above `estimateRenderBytes()`) is the ONE shared per-localization-object byte estimate every memory
  guard in the app uses (`checkTableSize()`, MODULE: table; `checkLocsMemory()`, MODULE: pipeline;
  `renderSuperRes()` below) — not independently-typed copies that could drift apart.

  **`renderSuperRes()` passes its own `locs.length*LOC_ROW_BYTES + stackResidentBytes` into
  `checkRenderSize()` as `reserveBytes`, and separately skips the render worker (falls back to the
  single-threaded path) whenever dispatching would exceed budget ONLY because of the worker's own
  clone** — real, calculated combined accounting, not a device-class guess. A real, reported crash:
  an auto-stopped mobile Run (`checkLocsMemory()`) still sometimes crashed right AFTER its own
  graceful "Stopping now, N localizations kept" message, exactly when the panel's own reconstruction
  re-render ran next. Three compounding root causes: (1) `checkRenderSize()` used to compare the
  render buffer's own cost ALONE against `memBudgetGB`, with no idea a large, already-resident `locs`
  array existed at all — fixed by threading `reserveBytes` through it. (2) `dispatchRenderWorker()`
  sends `locs` to the render worker via plain `postMessage` — a STRUCTURED CLONE, no transfer list —
  so EVERY render (every throttled live preview during a Run, and the final one) transiently holds
  BOTH the original locs array AND a freshly-cloned copy at once, a SECOND, temporary `locsBytes` on
  top of whatever the first fix already confirmed fits — fixed by comparing `renderBytes +
  2*locsBytes + stackResidentBytes` against `budget` to decide worker-vs-single-threaded (the
  single-threaded fallback reads `locs` BY REFERENCE, no clone, at the cost of blocking the main
  thread a little longer for that one render; the loaded stack's own cache is never cloned for this
  dispatch, so it's added only once, not doubled). (3) asked about directly ("if a 3GB file is
  loaded, does memory consumption increase well above 3GB depending on loc count, or is 3GB only the
  file-size limit?") — a large whole-file-cached movie can itself already consume most of `memgb`
  (MODULE: in/out's own `loadTiff()` caching decision), invisible to BOTH checks above until
  `stackResidentBytes` (`stack.residentBytes||0`) was threaded through as an explicit parameter (NOT
  read from the module-level `stack` global — this function is also called headlessly from
  `analyze()`, whose own `stack` is a function-local variable shadowing the module-level one; reading
  the global here would silently use the wrong stack in that context, the exact gotcha
  `smfretSOICore()`'s own `checkStack` fix already ran into elsewhere). Every comparison uses
  whatever `memBudgetGB` is ACTUALLY set to — this naturally never triggers on a desktop-sized (or
  unset) budget and correctly does on a small one, on ANY device, with no `isMemoryConstrainedDevice()`
  heuristic needed for THIS specific decision at all (that check still drives `memBudgetGB`'s own
  device-specific default, and is used elsewhere too — see **workers**).

  `renderMode` (default `'fixed'`): `'fixed'` bins then applies one uniform blur (`rblur`, cost ∝
  buffer area); `'precision'` splats each loc as its own CRLB-sized Gaussian (`lpx`/`lpy`, capped at
  `MAX_SPLAT_SIGMA_PX`) — Live streaming's own starting default, since a live acquisition benefits
  from precision-aware splatting; `'dither'` stochastically jitters+bins for large/dense datasets.
  `splatGaussianLoc()` integrates the Gaussian's true probability mass over each pixel's footprint via
  `mleGInt()` (MODULE: fit) rather than point-sampling the PDF — point-sampling can lose almost an
  entire dataset's mass once σ<<1 SR-px (an uncalibrated `gain=1` sample can produce this). It's also
  SEPARABLE: per-row/per-column weight arrays (`gx[]`/`gy[]`, `O(nx+ny)` erf calls) are precomputed
  once, then the `O(nx·ny)` inner loop is a cheap multiply, not a repeated transcendental call.

  **`WGSL_RENDER_PRECISION`** (the GPU path for `'precision'` mode) had BOTH of these bugs until a
  real, reported "reconstruction looks washed out compared to a past run" investigation found it had
  silently diverged from the CPU `splatGaussianLoc()` it's supposed to mirror: (1) **correctness** —
  it point-sampled the Gaussian PDF (`exp(-(dx)²/2σ²)`) per pixel instead of integrating pixel mass,
  measured to capture only 66.4% of true mass at σ=0.3 SR-px (a common regime for real, well-focused
  data) vs. the CPU path's 100% — the exact bug the CPU path's own `mleGInt()` comment already
  documents as fixed, just never ported to the WGSL kernel; (2) **performance** — it recomputed a full
  `exp()` for both x and y on EVERY inner-loop pixel (true `O(nx·ny)` transcendental calls, up to
  ~1369 at the `MAX_SPLAT_SIGMA_PX`(6) cap) instead of the CPU path's separable precomputed rows/
  columns. Fixed by porting the same `gInt()` (erf-based pixel-integrated mass, reusing the same
  `erfApprox()` already duplicated into `WGSL_FIT_SPHERICAL` — WGSL kernel strings can't share
  functions across separately-compiled sources) and the same separable `gx[]`/`gy[]` precompute
  pattern into the WGSL kernel, bounded by a fixed-size `array<f32,40>` local (`MAX_WIN`, matching
  `MAX_SPLAT_SIGMA_PX`'s own derived worst case, `2·3·6+2=38` window cells/side). Verified via
  `tests/gpu/bench-render.mjs`: all 14 cases now pass pixel-exact (previously several MISMATCHed),
  precision-mode GPU speedup over CPU improved to 1.66×–4.32× across realistic cases (mean 4.77×; the
  smallest synthetic case, mag 5, still shows GPU dispatch overhead dominating at real scale — 0.37×,
  expected and unrelated to this fix). The CAS-loop float-atomic accumulation itself (`addAcc()`/
  `addZacc()` via `atomicCompareExchangeWeak`) was deliberately left UNCHANGED — a fixed-point `i32`
  alternative was already tried and found to introduce a real 6.5–7.1% pixel-value rounding bias, so
  the more expensive but exact CAS loop is a documented, necessary trade-off, not something this fix
  should touch.

  **`rerenderNow()`'s own `"SR render ... s"` timing log line is gated on `!isPreview`** — a real,
  reported complaint: a long Run fires this same render path many times over for its own periodic
  mid-Run preview (`run()`'s `onSrPreview` hook, `isPreview:true` there), so each one used to print its
  own line — several showing up back-to-back in the log for no actionable reason (the number itself
  was never wrong, it's just noise nobody needs a timing history of throwaway preview renders for).
  `isPreview` already existed as a parameter (used to gate the zmin/zmax auto-fill a few lines above,
  see that code's own comment) but this specific log line wasn't gated on it. The final render — a
  plain interactive Localize/settings-change/Run-completion `rerender()`, `isPreview` unset/false —
  still logs it; that one number is the real, load-bearing diagnostic.

  `setupPlot(cv, isPlot=false)` letterboxes a fixed 4:3 sub-rectangle for the ~13 non-frame plots this
  app draws on the raw/SR canvases (drift, NeNA, FRC, PCFO, line-profile, calibration, the shared
  histogram, spt's D/track-length/MSD plots, sSMLM's distance/angle histograms, smFRET's time
  trace/E-vs-S). `canvas#sr,canvas#raw{min-height:320px}` floors the canvas height so an extreme
  (very wide or very narrow) camera-frame aspect ratio can't crush these plots to an illegible sliver
  — `aspect-ratio` still wins for any normal, near-square dataset.

  Each `.card` now has TWO `<h4>`s: a title-only one (a direct `.card` child, ABOVE the canvas) and a
  separate icon-buttons/description one (INSIDE `.panel-body`, right after the canvas, BELOW it) —
  each with its own margin rule (`.card h4` vs. `.panel-body > h4`, same base selector, watch for the
  two silently cancelling if either is edited). `hideOtherRawToggleBtns(exceptId)` keeps the raw-panel
  mode toggles (drift/spt/sSMLM histogram mode, segmentation image/hist) mutually exclusive — any new
  raw-panel toggle must call it too, or switching directly between two plot dispatchers with no
  "reclaim point" in between can leave a stale toggle button stranded.

  `redrawRawContrast()` (the Contrast slider's own drag handler) must never call `drawRaw()`
  unconditionally — `if(!rawPixelData || rawSegView || rawIsPlot) return;` guards against dragging
  Contrast while ANY plot (not just the segmentation image, the original narrower guard) owns the raw
  panel, which would otherwise silently reclaim it back to a live frame.

  `SvgRecordingContext` duck-types the Canvas2D surface the 7 vector-shaped plots use for "Save
  plot/image"'s SVG export (paths/rects/circles/text/save/restore/translate/rotate/clip — no
  gradients/patterns/images/curves). Two gotchas specific to this recorder: (1) `.arc()` only ever
  feeds `.fill()` — its `.stroke()` never consumes arc state, so a stroke-only circle (radial
  gridlines, a polar plot's rings) renders nothing in SVG unless built as a many-segment polygon via
  plain `moveTo`/`lineTo` instead; (2) there is no `.closePath()` — close an outline with an explicit
  trailing `lineTo(startX,startY)`. `save()`/`translate()`/`rotate()` each push a FRESH nested `<g>`
  (mutating the current group's own transform would retroactively move already-drawn siblings).

  UI colour theme (`applyTheme(name)`, `dark`/`light`/`contrast`) drives ~17 CSS custom properties via
  `[data-theme]` on `<html>`, persisted in `localStorage` (every access try/catch-wrapped, silent
  fallback to `'dark'`) — deliberately not a `PARAMS` entry (pure display/layout). Raw-frame/
  reconstruction overlays and the `LUT_CPS` dropdown are deliberately untouched by the UI theme (they
  sit on arbitrary image/data pixels, not a themeable panel background). `plotColors()` reads theme
  colours live for on-screen plots; `_plotExportMode=true` (only inside `exportPanel()`'s plot branch)
  swaps to a fixed light export palette so a saved PNG reads well regardless of the active theme.

  **CSS conventions worth knowing before touching layout**: buttons/panel headers/icon buttons have
  their resting-state border colour-matched to their own background (a flat look, not `border:none`,
  so nothing's box model shifts) — hover/focus/active border-colour changes are the one remaining use
  of colour on a border. The raw/reconstruction canvas is the one exception needing a literal
  `border:none` (its background is fixed pure black, never matching any theme's card background, so
  colour-matching still left a visible ring). Value inputs (`input.num`/`.numflat`/`select.sel`,
  including the stepper-button pair) keep a REAL visible border (`var(--line)`) — an editable box has
  no other affordance signalling it's clickable, unlike a button/header. Slider thumbs are 10px
  (`.scrubslider`/`.dualrange`) — the JS-side `DUALRANGE_THUMB_PX` constant (three independent
  copies: `syncRawContrastUI()`/`syncSrContrastUI()`, `smfretSyncRangeUI()`) must be kept in sync with
  the CSS value by hand, since a native thumb's centre travels within `[thumbW/2, trackW-thumbW/2]`,
  not the full track. Below the 860px breakpoint, `input.num`/`select.sel`/`.numflat` jump to 16px
  font (iOS auto-zooms below that) while `label.row` text stays at 12px — a deliberate size mismatch,
  not a bug. `select.sel` is a FIXED `127px` (not a `%` of the row — matches the established
  half-width-button figure inside a `details.sim` section; `justify-content:space-between` on
  `label.row` still pushes it flush against the row's own right edge regardless of this width) —
  deliberately accepted trade-off: a handful of longer option labels (e.g. "Gauss MLE spherical",
  "Wavelet (B-spline)", "Via distances and angles") truncate in the closed dropdown at this width
  (no ellipsis, native `<select>` clipping) — the full label is always readable once opened.
  `select.sel` also sets an EXPLICIT `height:25px` (with `padding:2px 6px`) — a real, reported
  alignment bug: with just padding matching `button`'s own (no explicit height), a `<select>`
  rendered visibly taller (29px) than a `.numstep`-wrapped `input.num` (25px) or a `button` (27px),
  even with identical padding/font-size/border — neither `appearance:none` nor tightening the
  padding alone closed the gap, confirming the extra height was `<select>`'s own internal default
  line-height/box-model quirk, not native dropdown-arrow chrome; only overriding `height` directly
  fixes it. Matched to `input.num`'s own 25px (not button's 27px) since select and numstep-wrapped
  inputs are the two control types that actually interleave row-by-row within one `details.sim`
  section. `html{-webkit-text-size-adjust:100%;text-size-adjust:100%}` (right after the
  `box-sizing:border-box` reset) additionally opts the whole page out of mobile Safari/Chrome's own
  text-autosizing heuristic — confirmed via a real mobile screenshot to inflate a `<select>`'s own
  rendered text size above its neighbours' despite sharing the identical `font-size:12px` rule.
  **Every row's own value control shares one common RIGHT edge with plain buttons** (numstep input,
  `select.sel`, checkbox alike) — `details.sim` only ever pads its children on the LEFT (the indent
  read as "belonging to" the section), never the right, so nothing needs a special right-alignment
  rule at all; see the `label.row` nesting-depth gotcha below for a real, reported case where an
  extra `padding-right:4px` rule was removed after it turned out to cause exactly the misalignment
  it was meant to prevent.

  **`input[type=checkbox]` renders as a modern toggle switch, not the native tickbox** — requested,
  "blueish when on and greyish when off." Pure CSS on the real `<input type="checkbox">` itself
  (`appearance:none` turns it into a blank pill; `::before` is the sliding knob) — no wrapper
  markup, so every existing `:checked`/`change`-event listener keeps working unchanged. The knob
  stays a fixed light colour in BOTH states (only the TRACK changes colour — the standard iOS/
  Material convention), with a `var(--muted)` ring + a small drop shadow for its own edge
  definition against light theme's own near-white "off" track. **`box-sizing:border-box` on the
  `::before` is required, not redundant with the app-wide `*{box-sizing:border-box}` reset** — a
  bare `*` selector never matches `::before`/`::after` (they aren't real DOM elements; reaching
  them needs `*::before`, which this reset doesn't do) — without it, the knob's own border was
  added ON TOP of its size instead of inside it, pushing it 1px off-centre in the track, a real,
  reported bug caught by measuring the actual rendered box, not just eyeballing it.

- **workers** — frame-parallel detect/fit; see the Web Worker gotcha below. `getPool()`'s own worker
  COUNT is capped at `2` on a memory-constrained device (`isMemoryConstrainedDevice()`), not the
  desktop `min(12, hardwareConcurrency)` — a real, reported gap: each worker receives its own
  postMessage-CLONED copy of every frame batch dispatched to it (no transfer list), so pool size
  directly multiplies how much raw frame data is resident at once, completely independent of and
  unmonitored by `checkLocsMemory()` (MODULE: pipeline, which only estimates the growing locs array).
  A phone reporting `hardwareConcurrency=6-8` (common) previously had that many× a batch's own frame
  memory in flight simultaneously with no budget check on it at all.

- **export** — ThunderSTORM-compatible CSV. `photons`/`bg`/`bgstd` are already true photon units by
  export time (gain/offset applied inside the fit). `sigma_x`/`sigma_y`, `angle`, `x2`/`y2`/
  `pairAngle`, `cell_id`/`cell_area`, `track_id`/`D_coeff` are all optional CSV/table columns, present
  only when a loc actually carries that field. **The worker-pool message protocol (currently 15
  floats/loc) must be widened at all 3 sites together** — the worker's own `out.push(...)`, and BOTH
  `wk.onmessage` unpack loops (the plain pool-dispatch loop and the FTM barrier-phased loop, which
  duplicate this on purpose) — whenever a new per-loc field needs to survive a worker-pool Run, or
  it's silently dropped for that path only (the single-threaded fallback keeps it for free, so the bug
  is easy to miss).

  `buildCsvText()` returns `parts` — ~5000-row string chunks, never one joined string — specifically
  so a huge export never forces a single JS string through concatenation; interactive **Save data**
  already consumes this correctly (`new Blob(parts,...)`). `analyze()` (MODULE: headless API) used to
  undo that safety by returning `csvText:parts.join('')` unconditionally — a real, reported crash on a
  real ~12-million-localization dataset (`RangeError: Invalid string length`, measured directly against
  both Node's and Chrome's own V8: the real hard ceiling is `2**29-24 = 536,870,888` characters,
  identical in both). Fixed two ways: `analyze()` now always returns `csvParts` (always safe, any
  scale) alongside `csvText`, which is `null` instead of a broken/truncated string once the joined
  length would exceed `CSV_TEXT_MAX_CHARS` (a margin below that measured ceiling, not the ceiling
  itself — `parts.join('')` needs to allocate the whole result on top of `parts` already in memory, so
  joining right up to the hard number risks an allocation failure before the length check even helps).
  Separately, `config.exportCsvRows` streams `parts` through `config.onRecord('csv', [chunk])` instead
  of the return value at all — the same reasoning as `exportTrackData`/`exportSSmlmCandidates`/
  `exportCalibrationPoints`/`exportPcfoTiles` below (a headless caller's return value crosses the
  DevTools Protocol as one JSON blob), just applied to the one export every run produces rather than
  an opt-in analysis step's side output. `tools/webSMLM-cli.mjs` sets this unconditionally (not a CLI
  flag — every run wants its CSV written safely) and special-cases the `'csv'` `onRecord` kind to write
  each chunk verbatim into `result.csv` rather than NDJSON-wrapping it like the other four kinds.

- **3D calibration** — astigmatic σx/σy-vs-z bead curves, JSON save/load; the only 3D method
  implemented. `calibrationCore()`/`runCalibration()` follow the same `*Core()`+wrapper split as
  Localize, including Stop support.

- **drift** — AIM (adaptive intersection maximization, point-based, 2D+z) or Cross correlation
  (image-based FFT registration, needs no Localize run at all), selected by `driftMethod`.
  `driftCore()` branches between two structurally-different estimator functions sharing one return
  shape (`{fdx,fdy,segCenters,segdx,segdy,nSeg,...}`). Both support Stop mid-run (a partial curve
  previews but is never applied). `drawDriftCurve()`'s green/magenta/blue drift-x/y/z palette is this
  app's reference colour pairing, reused by other plots' own similarly-shaped curves (NeNA, spt's
  track-length fit).

  **AIM round 2's own reference used to include the segment being aligned, making round 2 unable to
  ever revise round 1's error** — `bestShift()`'s intersection score is bounded above by `Σcs[i]`
  whenever `ref` already contains the segment's own contribution, so zero additional shift always
  wins regardless of round 1's true error. Fixed via leave-one-out (`subFrom`/`addTo` around each
  segment's own scoring — O(N) total, not an O(nSeg²) full rebuild); this is a deliberate divergence
  from Picasso's own `aim.py`, which has the identical self-referential bug. The leave-one-out fix
  also needs `bestShift()`'s own `if(best<=0) return [0,0]` guard: a segment left with NO real
  evidence (`nSeg===1`, or the sole occupant of its spatial footprint) otherwise ties every candidate
  shift at 0 and spuriously resolves to the search window's own corner. Both the 2D and z passes need
  this — the z pass has the identical self-inclusion bug, not covered by any upstream fix.

  `driftSamplePct` subsamples a segment's own points (seeded, deterministic — `mulberry32`) before
  AIM's shift search; a real precision/speed trade (noisier histogram-intersection counts), not
  cosmetic, floored at `AIM_SAMPLE_FLOOR`(200).

  `correlationDrift2D()`'s segment 0 is ALWAYS the fixed reference by construction (never
  re-estimated, unlike AIM's own two-round refinement) — it must NOT be zero-meaned the way AIM's own
  output is; smFRET's own drift correction depends on this exact frame-0 anchoring.

  **`driftCore()` applies the correction by mutating `L.x`/`L.y`/`L.z` IN PLACE on the SAME loc
  objects/array** (reversibly — the original values are stashed in `L.x0`/`L.y0`/`L.z0` first, restored
  before every fresh estimate so re-running with different settings always estimates from the raw
  data). This collided with a real, reported bug in the GPU render's own accumulate cache
  (`_gpuAccumCache`, MODULE: gpu): its cache-HIT check is `locs===cachedLocs && n===cachedN` — correct
  for "an unrelated setting changed but locs itself is untouched," but unable to tell that apart from
  "the SAME array, SAME length, but every position was just rewritten" — so `rerender(true)` right
  after Drift correction silently kept showing the STALE, pre-correction accumulated image (position/
  NeNA/FRC all read `locs` directly and were correctly up to date, so only the rendered reconstruction
  itself went stale — a real reported symptom: "still looks washed out/motion-blurred after Drift
  correction," "fixed" by toggling render mode away and back only because `renderMode` happens to be
  part of the SAME cache key). The CPU render path never had this problem — its own persistent scratch
  buffers (`_srAcc` etc., MODULE: render) are reused for memory only, keyed on dimensions, and the
  accumulate loop over `locs` always reruns in full regardless. Fixed by having `driftCore()` itself
  call `destroyGpuAccumCache()` right after mutating positions, so the very next render is forced back
  onto its full-rebuild path — necessarily slower than an incremental append (every position changed,
  not just new locs added, so there is nothing to append onto), but that cost is unavoidable, not a
  regression: it is the real, previously-skipped work the stale cache was hiding.

- **locprecision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution, inline
  radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
  `drawNenaPlot()`'s green (full Endesfelder fit)/magenta (signal-Rayleigh term alone) pairing is the
  reference this app's other two-curve plots match.

- **sSMLM** ("(Caution!) Pairing (sSMLM & FRET)") — pairs 0th/1st-order localizations from a
  diffraction grating (or, via smFRET, a donor/acceptor prism split). "(Caution!)" flags this as one
  specific method with real assumptions, not a general technique (shared prefix with smFRET/spt).
  Ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer)
  (Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022).

  Role assignment (0th vs. 1st order) is DIRECTIONAL, not brightness-based — real-data investigation
  found photon count barely correlates with position at real emitter densities. `sSmlmAngleCenter` is
  a genuine signed bearing (±180°); `pairCore()` classifies a candidate as 0th order only if it has
  ≥1 outgoing edge on that bearing AND zero incoming evidence (opposite bearing). 2-point pairs only
  (0th+1st) — multi-order chaining is a `docs/REFACTOR_PLAN.md` follow-up.

  **Preview pairs** auto-runs `fitSSmlmDistAndAngle()`: a distance fit FIRST (a theoretical
  background PDF — the distance distribution between two random UNPAIRED points confined to the
  localizations' own bounding box, `(a,b)`/circle-equivalent `R=√(ab/π)`, NOT the full camera FOV —
  plus a Gaussian signal term, LM-fit mirroring `fitNeNA()`'s own engine, `sSmlmBgProfile` (rect/disk)
  a user choice, not auto-detected) sets Distance min/max; an angle fit SECOND (2°-bin peak +
  half-max-width walk, doubled as a validated safety margin against real data) then reads the
  just-fitted distance window and sets Primary angle/tolerance.

  **Background PDF citations** — rectangle (sides `a≤b`, 3 domain pieces): Philip, J. *The
  Probability Distribution of the Distance Between Two Random Points in a Box.* Technical Report
  TRITA-MAT-07-MA-10, KTH, Stockholm, 2007 (§4) — commonly mis-cited as "1991" (a footnote year on
  the same title page for an unrelated AMS classification scheme; the report itself is dated 2007,
  matching its own report number). Disk (single piece): Solomon, H. *Geometric Probability*, SIAM,
  1978, p. 129 (via MathWorld "Disk Line Picking"). Both formulas were independently verified (Monte
  Carlo + integration-to-1 + known closed-form mean) before being transcribed into code.

  Distance min/max carry a fixed ceiling (`10000` nm) — widened once for a real dual-view/
  image-splitter dataset, then REVERTED once the widened scan/clamp diluted a genuinely small
  (sub-µm) real peak on a wedge-prism/grating dataset. That large-displacement, disjoint-region case
  is now smFRET's own **channel matching** (`alignSmfretChannels()`) instead — a direct point-set
  registration method with no such cap, so this method no longer needs to cover both scales.

  The Angles view is a **polar (rose) plot**, not the shared cartesian histogram (a true peak
  straddling the 0°/360° wrap would otherwise split into two illegible edge bars): 0°=right,
  90°=top, increasing counterclockwise. Both the Distances histogram's min/max markers and the
  Angles plot's three selection lines (Primary angle, ±tolerance) are directly draggable — grabbing
  either end of a ±tolerance line's own diameter must fold to the same near-side representative
  first (mod 180°), or the far end reads a wildly wrong tolerance.

  `sSmlmPairContext` (`'sSmlm'`/`'smfret'`) governs what dragging a Distances/Angles marker does
  afterward: the plain sSMLM path re-renders the reconstruction (`syncSSmlmZRangeFromDist()`); the
  smFRET path instead live-re-pairs and re-marks the SOI composite's own overlay
  (`refreshSmfretPairingLive()`) WITHOUT touching the reconstruction panel — both listeners fire off
  the SAME field `change` event, so `syncSSmlmZRangeFromDist()` must explicitly check the context, not
  just "is something paired."

- **smFRET** ("(Caution!) Time traces and FRET") — finds sites of interest (SOI,
  `locateSmfretSOI()` → `smfretSOICore()`, the DOM-free half `analyze()`'s `config.smfretLocateSOI`
  calls too — average-then-detect-once, same reasoning as bead calibration), extracts DD/DA/AA
  intensity-vs-time traces (`getSmfretTimeTraces()`), and optionally pairs sites for FRET. Not
  squeezed into sSMLM or 3D calibration despite reusing sSMLM's own pairing machinery — a genuinely
  different optical setup (prism/polychroic split vs. a diffraction grating).

  **Analyse FRET** (`smfretFretEnabled`, default checked) is the point of the module's own two-part
  name: time traces work standalone (donor-channel-only leakage/bleaching measurements) with no
  pairing at all. With ALEX on, AA is sampled at the pair's own inferred acceptor position `(x2,y2)`
  once paired, falling back to the donor position `(x,y)` when unpaired (the only position available).

  **ALEX** (`alexEnabled`/`alexFirstFrame`) establishes a fixed period-2 frame parity — every
  ALEX-aware function (the SOI composite's own averaging, `getSmfretTimeTraces()`'s per-frame
  extraction, `smfretPoolE()`/`smfretPoolES()`) reads that parity; there is no general non-SOI
  frame-role tagging (a `docs/REFACTOR_PLAN.md` follow-up).

  **Two pairing methods**, `smfretPairMethod` (**Pairing method** dropdown):
  - **Via distances and angles** (`getSmfretPairingFromDonor()`) — a thin wrapper over sSMLM's own
    Preview+Pair, restricted to the donor-excitation composite. **Position donor** disambiguates
    which of the two 180°-apart bearing candidates a doubled-angle fit produces actually points
    donor→acceptor — data alone can't tell, this needs the user's own knowledge of the setup.
  - **Via channel matching** (`alignSmfretChannels()`) — direct point-set REGISTRATION between
    independently-detected DD and DA/AA populations, no histogram at all. Built because a
    histogram/background-model fit inherits a real confound in a wide-aspect FOV: two random points
    are geometrically more likely to be oriented along the FOV's own long axis, which can coincide
    with the true physical donor→acceptor bearing, making the real signal indistinguishable from
    background shape. `smfretFovSplitX(locs, w)` finds the physical channel-split gap from the SOI
    positions' own x-histogram (a raw pixel-intensity profile isn't informative enough — background
    illumination swamps it). A coarse displacement search (`smfretSearchDisplacement()`, spatial-hash
    accelerated) seeds a small ICP loop fitting a full 2D AFFINE transform (`smfretFitAffine()`,
    ordinary LSQ, `solveLin()`) — needed because a pure translation can't absorb a real inter-channel
    rotation/scale mismatch (confirmed on real data: the paired-distance CV grew with search
    tolerance under translation-only, the signature of a systematic, not random, residual). Shows an
    alignment-overlay QC visualization (a green/magenta backward-warp composite) automatically on
    success. The winning transform's own match set IS the pairing — no separate distance/angle
    `pairCore()` step afterward.

  **Extraction** (`getSmfretTimeTraces()`): either a free-position MLE fit (default,
  `gaussianMLEspheric`, x,y merely SEEDED at the known position — correctly fails/rejects on a frame
  with no real molecule) or aperture photometry (`smfretApertureMode`, no fit, the shared
  `apertureGeometry()`/`percentile()` from **fit**). A rejected/non-converged fit writes a real,
  meaningful `0` (not `NaN`) — the reject logic already IS the judgement that no molecule was on;
  `NaN` is reserved for "too close to this frame's own edge, no window to fit at all." The MLE default
  additionally rejects a result whose σ exceeds `2×σ_PSF` (smFRET-specific, on top of the shared
  `MLE_MAX_SIGMA` — a wide, dim, diffuse blob otherwise integrates a large spurious photon count with
  no localized bright pixel needed; kept local to smFRET since 3D calibration's own astigmatic fits
  legitimately need σ to range far more widely away from focus).

  **E(S) histogram**: 1D (`E=DA/(DD+DA)`) or 2D E-vs-S (`(DD+DA)/(AA+DD+DA)`, needs ALEX+AA), pooled
  across all sites/time, with `Min`/`Max DD+DA` and `Min`/`Max AA` burst-selection ranges (each
  channel must be individually `>0`, not just the sum — a rejected-fit `0` or an unfloored negative on
  just ONE channel otherwise clamps the ratio to an edge, 0 or 1, rather than being excluded). Under
  ALEX, DD/DA and AA live on strictly ALTERNATING frame indices by construction — pooling must pair a
  donor-excitation sample with its own ADJACENT acceptor-excitation frame's AA value (prefer `i+1`,
  fall back to `i-1`), never the same index. The 2D density uses hexagonal binning (axial hex-grid,
  cube-coordinate rounding) coloured via `getLUT('viridis')`, not a blurred raster — a deliberate
  redesign matching published smFRET burst-histogram figure conventions, with no colour bar (relative
  brightness only).

  **Apply drift correction** (`smfretApplyDrift`, default off) runs whichever `driftMethod`
  **Drift correction** is configured with — Cross correlation needs no Localize at all; AIM runs one
  silent, discarded whole-movie Localize first — then re-anchors AIM's own zero-meaned output to
  frame 0 (`fdx[0]`/`fdy[0]` subtracted off the whole array), since a site's fixed `(x,y)` IS frame 0
  by construction. Extraction reads `(x-fdx[fi], y-fdy[fi])` — SUBTRACTING the drift, the inverse of
  `driftCore()`'s own "add `fdx[f]` to correct" convention, since this recovers where a REFERENCE-
  frame position sits in the RAW current frame.

  The SOI composite marks (never filters — an earlier, stricter "remove the box" design was reverted)
  a paired site's ROI dark-orange (`#d2691e`, `markSmfretSoiPairedKeys()`) or gold (`#e8b400`) for an
  AA-SOURCED (channel-matching) match specifically — a real but structurally weaker guarantee than a
  same-image (distAngle) match, since it comes from a SEPARATE, independently-fit composite matched
  by nearest-neighbour tolerance rather than exact position equality.

  `drawSmfretTrace(idx)` follows the "left panel doubles as a plot surface" pattern (see the
  Left/right panel plot pattern gotcha below); its x-axis is time (s), not frame index
  (`time=frame_index×frametime` is exactly linear, so only tick GENERATION changed). ROI thumbnails
  (DD/DA/AA crops with a magenta fit crosshair) draw as a strip below the x-axis on the same canvas,
  fire-and-forget async, with their own staleness guards (`_smfretRoiGen`, a check against
  `rawPlotName`/`smfretTraceIdx` right before the actual draw) since the frame fetch they need can
  resolve after the raw panel has already moved on to something else.

- **spt** ("(Caution!) Single-particle tracking") — links per-frame localizations into trajectories
  and computes a per-track diffusion coefficient. A trackpy-**inspired** variant (same
  `search_range`/`memory` terminology and philosophy as the Python `trackpy` package), not a literal
  port — one specific, scope-limited method (a single average-per-track D, no MSD-vs-lag fit), same
  "(Caution!)" framing as sSMLM/smFRET. Ported from the user's own `sptPALM-Python` pipeline (L.
  lactis sptPALM, Martens et al., *Nat. Commun.* 10, 3552, 2019).

  `linkTracks()`: each frame's track↔candidate bipartite graph (edges within `sptSearchRange`, gated
  by `sptMemory` for gap-bridging) splits into connected components via union-find, each solved by a
  self-contained Hungarian assignment (`hungarianAssign()`) — falls back to greedy nearest-neighbor
  above `HUNGARIAN_MAX`(120) components rather than let O(n³) stall the tab (a documented scope
  limit). `trackDiffusionCoeffs()`: `D = MSD/(4·frametime) − locError²/frametime`, the gap-corrected
  MEAN of a track's own single-frame squared displacements — an average, explicitly NOT a
  MSD-vs-lag-time fit (matching the reference pipeline). D is linear in `1/frametime` and MSD itself
  is cached per track (`trackMSD`) — editing **Frame time**/**Localization error** after **Track**
  rescales instantly with no re-link; **Search range**/**Memory**/**Min track length** still need a
  fresh Track.

  **Tracks overlay** line thickness is `view.zoom` ALONE, never `mag*view.zoom` (a real, previously-
  shipped bug: `mag*view.zoom` draws one CAMERA pixel's width, unbounded at high zoom — giant spikes
  covering the reconstruction). `getVisibleTracksForOverlay()`'s deterministic seeded sample
  (`sptShowTracksPct`) must draw over the FULL id-ordered track list, not the length-filtered subset —
  otherwise raising `sptTrackLenMin` reshuffles which tracks a fixed percentage happens to keep.

  **Segmentation-aware tracking** (`applySegmentation`, loads an integer-labelled mask via
  `computeSegmentedImageData()`): `linkTracksPerCell()` runs `linkTracks()` SEPARATELY per qualifying
  cell (filtered by `areaPx` against Min./Max. cell area), so no track crosses a cell boundary.
  `segmentedImageLabels.refPxNm` is the pixel size the mask was loaded AT — the overlay scales the
  source-rect by `(current pxnm)/refPxNm`, NOT the reverse (a real, previously-shipped sign error —
  double-check the direction empirically again if this formula is ever touched). This is also wired
  headlessly via `config.segmentationFile`; `linkTracksPerCell()` must take `segLabels` as a
  parameter rather than reading the module-level `segmentedImageData` global directly, since
  `analyze()`'s own scope never touches that global (a real, previously-latent bug — the general
  lesson: a module-level global populated before every interactive call site is invisible until
  something calls the same function headlessly).

- **pipeline** — top-level orchestration wiring the UI buttons to the modules. Localize, drift
  correction and 3D calibration are each split into a DOM-free `*Core(config, stack, hooks)`
  function (`runCore`/`driftCore`/`calibrationCore`) plus a thin interactive wrapper
  (`run()`/`correctDrift()`/`runCalibration()`) that resolves DOM state into `config`, calls the
  core, then applies results back to globals/UI. `window.webSMLM.analyze(config)` — the headless
  entry point — calls the same cores directly with an explicit config and no DOM at all;
  `tools/webSMLM-cli.mjs` (Node + Playwright) drives `analyze()` from the command line. New
  analysis logic belongs in the relevant `*Core` when it should also work headlessly (most should);
  only DOM-reading/writing belongs in the wrapper. See `docs/DOCUMENTATION.md` §8 for the full
  headless API and `docs/REFACTOR_PLAN.md` for the design rationale.

  **`runCore()`'s own `checkLocsMemory()` genuinely STOPS a Run, not just warns** — a real, reported
  gap: an earlier warn-only version logged a message once the growing `locs` array crossed 70% of
  **Total memory budget (`memBudgetGB`)**, but nothing actually halted the Run, so a real ~30k-frame
  mobile Run still "silently crashed" (total data loss). `runCore()` now shadows its own `shouldStop`
  with `()=>shouldStopHook()||memStopTriggered` right
  after destructuring the hook — every existing `shouldStop()` call site (worker dispatch loops, the
  serial yield loop, the FTM barrier phase) picks up a memory-triggered stop for free, with the exact
  same "stop mid-way, keep the partial locs found so far" handling a manual Stop click already gets.
  This also means a headless `analyze()` call (which passes no `shouldStop` hook at all) now gets
  this same protection, a genuine improvement there, not just interactively.

  **`checkLocsMemory()`'s own STOP point is a CALCULATED reserve, not a guessed fraction of
  `memBudgetGB`** — first shipped at flat fractions (`0.95`, then `0.7`/`0.55` — each one just another
  guess, no more principled than the last, and asked about directly: "what is the reasoning behind
  the 55%?" didn't have a solid answer). Now: `stopAt = budget − renderBytesEstimate −
  frameBatchReserve − stackResidentBytes`, all three terms REAL numbers computed from THIS run's own
  configuration, not arbitrary safety margins —
  - `renderBytesEstimate` = `estimateRenderBytes(w*config.mag, h*config.mag, config.zcolor,
    config.rblur, config.renderMode)` (MODULE: render), computed ONCE up front: exactly what the
    reconstruction render that WILL run right after this Run stops or finishes will cost.
  - `frameBatchReserve` = `2*pool.length*BATCH*w*h*4` (0 on the serial no-worker path), set once
    `pool`/`BATCH` are resolved: decoded frames are always `Float32Array(w*h)` regardless of the
    source file's own bit depth (`decodeInto()`, MODULE: in/out), and every worker's own in-flight
    batch is postMessage-CLONED (main thread's own copy + each worker's clone, worst case across all
    workers at once) — the SAME clone cost `renderSuperRes()` accounts for, just for frame data
    instead of locs.
  - `stackResidentBytes` = `stack.residentBytes||0` — `stack` is already `runCore()`'s own explicit
    parameter, so this reads correctly in both the interactive and headless case with no shadowing
    risk. Asked about directly: "if a 3GB file is loaded, is memory consumption then increasing well
    above 3GB depending on loc count, or is 3GB only the limit for file size?" — a fair question that
    exposed a real, still-standing gap even after the render/frame-batch reserves above:
    `loadTiff()`'s own whole-file caching decision (MODULE: in/out) can let a single decoded movie
    consume most of `memgb` on its own (a real ~2.5 GB cache against a 3 GB budget is a normal,
    correctly-logged outcome), but this check used to compute its OWN reserve against the FULL
    nominal budget with no idea that cache already existed — so yes, combined peak memory COULD run
    well above the configured budget depending on loc count, until this term closed it.

  `locs` may use whatever's left of `budget` after those three reservations — still an ESTIMATE
  (`200` bytes/row, `LOC_ROW_BYTES`, likely itself an UNDERESTIMATE of a real 15-own-property loc
  object's V8 footprint — biasing this toward acting a little late, not early), but no longer an
  arbitrary safety margin: it's a real answer to "how much room does THIS run's own render,
  in-flight frame batches, and already-loaded movie actually need," computed from THIS run's own
  settings. A WARN heads-up fires at 80% of that SAME calculated `stopAt` — still one real number,
  just an earlier point on it. Reported: a real ~30k-frame mobile MLE-spherical Run crashed even at
  flat-fraction thresholds, right after auto-stopping's own graceful message — the render step right
  after a stop had no idea how much the already-resident locs array was using, which the calculated
  reserve now directly prevents (see **render**'s own paragraph on `checkRenderSize()`'s matching
  fix). Still an estimate, not a guarantee — no client-side JS can detect or prevent an OS-level tab
  kill for certain.

  **Never `delete` a property off a loc object post-hoc — set it to `undefined` instead.**
  `config.auditCandidates` (headless/test-only, keeps each accepted loc's originating detection-pixel
  index for cross-checking) used to `delete L._candidatePixel` on every loc once no longer needed. A
  real, reported crash at TRUE full scale (`tests/gpu/bench-real-data.mjs --full`, ~4M real
  localizations) traced to this: `delete` forces V8 to convert that object off its fast, shared,
  shape-based hidden-class representation onto a slow, per-object dictionary-mode (hash-table)
  representation — measured directly to roughly DOUBLE memory for a large loc array (675.2MB→
  1682.3MB, +150%, for 3M loc-shaped objects in isolation), which at true full scale pushed
  `totalJSHeap` to the tab's own heap limit right after Localize finished. Fixed by
  `L._candidatePixel=undefined` instead — behaviorally identical (every construction site already
  treats `undefined` as the "not audited" sentinel, never distinguishes it from "property absent"),
  but keeps every loc on its existing fast hidden class. General rule going forward: post-hoc-clearing
  a property that WAS present on a hot, large-N object array should always assign `undefined` (or a
  suitable sentinel), never `delete` — `delete` is fine on small, one-off, or genuinely short-lived
  objects (e.g. a single settings-migration object), never on a large homogeneous array of hot
  objects the app already relies on staying monomorphic (matching `LOC_ROW_BYTES`'s own fast-shape
  assumption above).

  **The `useGpuFit` branch's raw-panel live preview (`refreshRawPreview()`) keeps a small, bounded
  ring of recently-detected frames, not just the latest one.** A real, reported bug: the raw panel's
  magenta fit crosshairs stopped appearing inside the green detection boxes during a fast-detecting,
  GPU-fit-bound Run (dense real data, many CPU detect workers feeding one shared GPU fit pipeline).
  Root cause: `makeGpuFitAccumulator()` batches candidates from MANY frames into one accumulator slot
  before firing a single GPU dispatch (by design — see that function's own comment on why a
  one-dispatch-per-frame granularity was too small to pay off), and `makeGpuFitSlotPool()`'s own
  `acquire()` never blocks the detector — it hands out a temporary overflow slot rather than ever
  applying back-pressure — so detection can run arbitrarily far ahead of fitting with no natural
  limit. `refreshRawPreview()` used to always show the JUST-detected frame, filtering `locs` for an
  exact frame match — but that frame's own candidates essentially never have fit results back by the
  time the next preview tick fires, so the crosshair overlay stayed empty almost continuously on
  exactly the kind of Run where you'd most want to see it working. Fixed by retaining a small ring of
  `{fi, img, mx}` triples (one per recently-detected frame) and, on each preview tick, searching it
  backward for the newest frame that's either already fit (has entries in `locs`) or genuinely had no
  candidates to begin with (`mx.length===0`, nothing to wait for) — showing that frame's own image,
  boxes, and crosshairs together keeps them visually consistent, at the cost of the raw panel lagging
  slightly behind "now" while GPU fitting catches up. Deliberately capped SMALL and FIXED (`max(4,
  pool.length*2)`), not sized to the true backlog (unbounded in principle, per the no-back-pressure
  note above) — if the real lag ever exceeds the ring's depth, this just degrades to the pre-fix
  behaviour (latest frame, crosshairs pending) rather than let retained preview images grow without
  bound.

  **`memBudgetGB`/`memgb`/`chunkmb` are three independent settings** ("Total memory budget (GB)",
  "Budget raw movies (GB)", "Stream heap (MB)", all under "Memory & streaming"): `memBudgetGB` is the
  OPT-IN total-memory ceiling `checkLocsMemory()`/`checkRenderSize()`/`checkTableSize()` all compare
  against (default `Infinity`/unset on desktop — most setups never need one for the file sizes this
  app is typically used with); `memgb` only ever decides whole-file-cache-vs-stream at load time
  (`readBudget()`, MODULE: in/out), unrelated to the ceiling. `MOBILE_MEM_DEFAULTS`
  (`syncParamControls()`, MODULE: params) substitutes a much stricter profile for all three on a
  memory-constrained device only (`isMemoryConstrainedDevice()`) — `memBudgetGB:0.5` (a real,
  enforced ceiling from the very first load, not something a mobile user has to already know to set;
  tuned down from an initial `1` after real-world crash reports even at that value), `memgb:0` (floors
  `readBudget()` at 0, so EVERY movie load on such a device streams, never whole-file-caches,
  regardless of size), `chunkmb:250` (a smaller per-chunk working set, since streaming is the only
  path there, not an occasional fallback). Desktop/laptop keeps every one of these three fields' own
  ordinary default, completely unaffected by this table.

  **`maybeShowMemWarning()`** (declared right before `loadMovieFiles()`) is the complementary piece —
  no client-side JS can fully guarantee no OOM tab-kill on a sufficiently large/dense movie regardless
  of how conservative the starting defaults are, so on a memory-constrained device, loading a movie
  also shows a one-time (`_memWarnShown`, at most once per PAGE LOAD — a crash reloads the whole page
  anyway, which is itself a fresh load and naturally re-arms this) pop-up (`#memWarnModal`, wired in
  `wireHelp()` alongside the app's other modals) restating the three live values above and pointing at
  what to try next if analysis keeps failing (lower `memBudgetGB` further, narrow the analysed frame
  range, lower Magnification, use a smaller/cropped file); its own **Open Memory & streaming** button
  expands and scrolls to `#memBox` directly. Purely informational — never blocks the load itself.

  **A live "Mem: ..." readout** sits in the Log card's own title row (`#memReadout`, a
  `updateMemReadout()` polled every 2s via `setInterval` — "dynamic" here means "polled regularly,"
  not "recomputed on every triggering event") — asked directly: "can you dynamically display how
  much memory webSMLM is using, or is that off limits?" Honest answer, and what got built: on Safari
  it genuinely IS off limits — no `performance.memory` (Chrome/Edge-only, never implemented by
  WebKit, deliberately, for fingerprinting/side-channel reasons) and no `navigator.deviceMemory`
  (same) exist there, so there is no real number this page can ever read on that browser. The
  readout always shows webSMLM's own ESTIMATE (the exact same `LOC_ROW_BYTES`/`estimateRenderBytes()`
  math the guards above use, clearly labelled as an estimate in its own tooltip) and, only on
  browsers that actually expose them, the REAL measured JS heap usage plus an approximate total
  device RAM to genuinely rate it against — never fabricates either figure when unavailable.

  **`stack.residentBytes` closes a real, reported gap in the readout: it still showed ~0 right after
  loading a real multi-GB movie**, even though `loadTiff()` (MODULE: in/out) had just onLog'd its own
  "Decoded working set if fully cached: ~2.50 GB" line — the biggest single memory consumer for a
  whole-file-cached load, invisible to the readout because it only ever looked at
  `lastResult`/`locs`, with no idea a loaded STACK itself could be holding gigabytes. Every
  `loadTiff()` branch that actually decides to cache decoded frames now tags its own returned stack
  object with `residentBytes` — the SAME number it already computed and logged, not a second,
  independently-derived estimate: `needC`/`need` for the two full-cache branches; `fileSize` for the
  "exceeds budget, decode-per-frame from the still-resident raw buffer" branch; a live
  `get residentBytes(){return fileSize+cf*frameBytes}` on the internal streaming FALLBACK (`cf` can
  shrink after an allocation failure, so a plain property would go stale). `updateMemReadout()` reads
  `stack.residentBytes||0`. **Known, NOT-yet-covered gap**: `loadTiffSequence()`/`makeConcatStack()`
  (multi-file loads), `loadNd2File()`, and `loadFitsFile()` don't tag `residentBytes` yet — the
  readout under-reports for those specific load paths until they get the same treatment; the
  genuinely disk-backed `loadMultiIfdStreaming()` (MODULE: in/out) correctly has none to report (no
  persistent cache exists there at all).
  **A real, caught-before-shipping layout bug**: `.card h4 > span:first-child` (MODULE: params)
  gives a card's own FIRST `<h4>` child `white-space:nowrap`/`overflow:hidden`/ellipsis, meant for a
  short plain title — bundling the Log card's own buttons AND this new readout into that same first
  span (tried first) got squashed onto one unwrapping, clipped line the moment the readout made the
  row too long for a narrow viewport. Fixed by giving the Log h4 a SECOND child span (buttons +
  readout, own `flex-wrap:wrap`) instead of stuffing everything into the first — not subject to that
  rule at all, so it can actually wrap on a narrow screen instead of overflowing.

  **Standing rule — every actionable GUI control needs a plain top-level function behind it.** A
  button click, checkbox change, or any control that actually computes or changes data must call ONE
  plain top-level `function`/`async function`, never inline its real logic in an anonymous
  `addEventListener` closure (reading/writing a handful of DOM elements to reflect state — disabling
  a button, toggling a class — is fine to leave inline). The log terminal's `eval()` shares this
  file's own top-level scope, so any plain top-level function is automatically callable from the
  terminal with zero extra wiring; an inline handler is invisible to it. This is the actual mechanism
  behind "GUI and command-line support are interchangeable" — one implementation per action, not a
  parallel API kept in sync by hand.

  **The Log window is also an interactive JS terminal** (`#logTerminal`). `runTerminalStatement(text)`
  uses the same two-attempt strategy Node's own REPL uses (try as a captured expression first, else
  run as a plain body) via a direct `eval()` (not `new Function`) placed inside a function declared in
  this file's own single top-level `<script>` — so it shares the full lexical scope chain (every
  module-level `let`/`const`, not just `window`-attached names). `↑`/`↓` recall the combined list of
  every logged `{type:'cmd'}` command and past terminal input (`terminalHistoryList()`).
  `resolveTerminalConfig()` (1) backfills every `PARAMS` field a terminal-run config OMITS from LIVE
  session state via `paramValue()` (never a `PARAMS` default — so a recalled command reflects the
  session as it stands right now, not generic defaults), and (2) resolves a bare filename STRING back
  to a real registered `File`/`Blob` (`_terminalFileRegistry`/`registerTerminalFile()`, called at
  every point a real File actually enters the app) or falls back to `_lastTerminalFile` (last-write-
  wins) when the config has no `file`/`files` key at all — recalling ANY logged action and pressing
  Enter must reproduce that exact action, not throw a low-level type error or silently substitute
  generic defaults. `applyHeadlessResultToSession(result)` is the bridge that pushes a bare
  `analyze()`'s own result into the live interactive session (resets crop/drift/table state, sets
  `lastResult`, explicitly nulls the module-level `stack` even if an unrelated movie was loaded
  earlier — `analyze()`'s own `stack` is a function-local variable that never touches that global).

  **`logCmd(config, jsOverride)`** — most actionable functions (`estimateGainOffset()`,
  `runSptTrack()`, `correctDrift()`, …) take no arguments and read live session state; `jsOverride` is
  literal JS text logged/recalled/run instead of a generic `analyze({...})` reconstruction, since
  `analyze()` ALWAYS does load→detect/fit→… in one shot and has no way to run any of these in
  isolation — recalling a bare `analyze({...})` for one of these would silently re-Localize the whole
  stack, a real correctness/performance bug for exactly this class of action.
  `overrideWithFields(config, call)` builds a SELF-CONTAINED override: for every `config` key naming a
  real sidebar field, it prefixes `call` with a `$('id').value=...`/`.checked=...` assignment (skips a
  key with no matching element, e.g. a bookkeeping marker or `<input type=file>`) — recalling this
  loads the whole line into the terminal already editable, change a value, press Enter.

  **A multi-fact `onLog()` message is ONE call with embedded `"\n"`s and a plain, short `"  "`
  (2-space) continuation indent — never several separate `onLog()` calls hand-padded with just enough
  leading spaces to visually align under a shared label.** `wrapCommentLine()` (MODULE: params) marks
  and word-wraps every `"\n"`-split line independently at 80 columns, so a hand-counted indent only
  survives until that specific line is long enough to wrap a SECOND time — the wrapped remainder then
  starts flush after the marker with no indent at all, and outside this app's own monospace log box
  (a copy-paste, an exported log) the indent has nothing to align against regardless. A real, reported
  case: the GPU-fit diagnostic block (MODULE: pipeline, `runCore()`'s own "who actually did the work"
  section) used to be a dozen separate `onLog()` calls each padded to align under `"GPU fit:       "`
  — reads as a broken wall of misaligned fragments once copied out. Fixed by combining each related
  cluster into one call. Separately, `formatLogEntry()` strips a prose message's own leading `"\n"`
  (used by many action-start messages, e.g. `onLog('\nRun: ...')`, to open a visual gap before a new
  action's header) specifically when that entry lands right after a `cmd`/`term` entry, which already
  prints its own blank-line separator — without this a command and its own first result line printed
  with a spurious blank line between them, making it ambiguous which command a given comment actually
  belonged to (also reported directly).

  **`_sessionEpoch`/`newEpoch()`/`staleEpoch()`** — every long-running, state-writing action (Run,
  drift, calibration, spt, sSMLM/smFRET pairing, crop, load, simulate) captures
  `const myEpoch=newEpoch()` right after its own preconditions and checks `staleEpoch(myEpoch)`
  immediately before every LATER write to shared state, especially the first thing after an `await` —
  bailing out (discarding its own result entirely) if a newer action has bumped the epoch since. This
  exists because the terminal calls these functions directly, bypassing the DOM-only "button disabled
  while running" protection an interactive click has (a superseded async completion can otherwise
  silently overwrite a genuinely newer result). Deliberately does NOT try to force the superseded
  operation to actually stop early (no `stopRequested` dance — fragile, and simply discarding a stale
  result is just as correct), and deliberately does NOT epoch-guard a function's own button-enable/
  `finally` cleanup (a superseding action may not manage the same buttons, which would leave one stuck
  disabled forever instead).

  **Keyboard hotkeys** (`wireHotkeys()`): holding **Alt** shows numbered hint badges over the 10
  always-visible top-level action buttons (`HOTKEY_BUTTONS`, fixed on-screen order); **Alt+Shift**
  switches to the 10 collapsible sidebar `<details>` modules (`HOTKEY_SECTIONS`). Digit matching uses
  `e.code` (`"Digit1".."Digit0"`), never `e.key` — macOS remaps `e.key` for the digit row while Option
  is held. **Alt+T** focuses the log terminal (one fixed binding, checked before the digit lookup).
  **Alt+Shift+P/F/S** are three more fixed single bindings (Pixel size, Frame time, the Stack
  panels/Side by side toggle).

  `makeNavigator(cv, nav)` is the shared pan/zoom (drag/wheel/pinch/double-tap-to-fit) wiring for the
  raw/SR canvases (Pointer Events). `trackDragDistance(cv)` separately measures total on-screen
  movement since the last press (`wasDrag()`, past `CLICK_DRAG_PX`=5 CSS px) — a browser still fires a
  native `click` after a drag-to-pan sequence on the same element regardless of distance travelled, so
  every click-armed multi-point tool sharing that canvas (raw-panel crop, SR crop/measure/track-
  select) must check `wasDrag()` at the top of its own click handler or a pan can plant a stray
  corner/point.

- **liveStreaming** (`window.webSMLM.liveStream`) — Marked **experimental**. A Micro-Manager/
  pycromanager camera bridge; two ways in, both nested inside "Memory & streaming": an opt-in
  WebSocket the page connects OUT to (never listens), or an external Playwright-driven bridge
  (`tools/webSMLM-livestream-bridge.mjs`) pushing chunks via `window.webSMLM.liveStream.pushChunk()`.
  Each chunk is localized independently via `runCore()` (no cross-chunk context — FTM is unsupported
  here) and appended to a running total, repainting through the same `lastResult`/`rerender()`
  globals an interactive Localize run uses. No separate Start step — a session arms itself the moment
  streaming actually begins. The top-level **Stop** button ends a session either way. Committing a
  NEW table filter (or the crop tool) is refused while streaming — a filter is a one-time snapshot
  never re-applied to later chunks, so using one mid-stream would silently freeze the display while
  `lastResult.locs` kept growing underneath it.

- **table** — the sortable, cumulatively-filterable localizations table ("View data/filtering") and
  per-column histograms. Committed filters set `renderLocs`, driving the reconstruction live. The SR
  panel's crop tool pushes an x/y-range clause into the SAME `_tableFilters` array a typed filter
  would — reconstruction, export, NeNA and FRC all see a crop identically to any other filter.

  Filtering is CLI/JS-loggable: every `_tableFilters.push()` calls
  `logCmd({tableFilters: tableFilterExprList()})` — the FULL cumulative array each time (a curated
  snapshot, not a diff). `tableFiltersCore(locs, px, exprList)` is the pure, DOM-free replay half
  `config.tableFilters` calls headlessly.

  `tempClustering(XY|Z|Memory) <= N` is a different KIND of clause from an ordinary filter — it
  doesn't select a subset, it re-merges a blinking molecule's own detections into fewer, higher-
  precision "events" (`clusterEvents()`), changing the BASE row set. `getBaseLocs()` is the single
  place deciding raw-vs-clustered; `memoryFrames` (gap-bridging tolerance, default 0 = strict
  adjacency) can grow unboundedly with a real gap tolerance — no spatial-grid optimization has been
  needed yet, matching spt's own Hungarian-vs-greedy "don't optimize for a scale nobody's hit"
  precedent.

  `checkTableSize()` guards `locTableData()` against `memBudgetGB` the same way `checkRenderSize()`
  guards render buffers (each row estimated at ~200 bytes).

## Web Worker gotcha (read before touching detect/fit/workers)

Workers are **not** separate files. `workerSource()` builds worker code by calling `.toString()` on
the very functions the main thread uses, so detection/fitting logic exists once. Consequences:

- A worker gets a fresh global scope. Any module-level state a stringified function relies on must be
  re-declared in `WORKER_PRELUDE`, or the worker throws a `ReferenceError` and silently falls back to
  single-threaded. If you add a `let`/`const` at module scope that a detect/fit function reads, add it
  to `WORKER_PRELUDE` too (there is a runtime check listing `missing` names).
- Any helper a stringified function calls must itself be included in the `workerSource()` body.
- The same pool serves two unrelated message protocols: detect/fit's frame-batch dispatch and FTM's
  single-frame row-band preview — `onmessage` branches on `d.ftmFrame` before falling into the
  detect/fit path. A new worker job needs its own branch and its own `d.<flag>` field, not a
  repurposed existing one. FTM's *other* use (`makeFtmStack()`, feeding Localize) deliberately does
  **not** add a third message type — it runs on the main thread instead, since `runCore()`'s own
  worker-dispatch can have several workers mid-detect/fit while a chunk fetch is in flight, and a
  third job type on the same pool would overwrite a busy worker's `onmessage` (one property, not a
  queue) out from under it.

## Left/right panel plot pattern

The left panel (`raw` canvas) doubles as a plot surface. To show a plot instead of a frame, set
`rawFull=null; rawIsPlot=true; rawPlotName=<kind>` and draw directly on `$('raw')`; call
`syncSaveImg()`. Calibration/E-S-histogram plots render on the right (`sr`) canvas via `srIsPlot`.
Switching a panel back to a frame/reconstruction (`drawRawView`/`drawView`) must clear any plot-only
overlay state so a stale plot can't paint over live pixels. Every raw-panel mode-toggle button must
call `hideOtherRawToggleBtns(exceptId)` — see **render** above.

## Live preview (real-time detect/fit on the scrubbed frame)

`showFrame()` re-detects and re-fits whatever frame the raw-panel scrubber is on, so switching
detection/fit method or scrubbing shows results immediately without a full Run. Two paths, chosen by
the `#liveUpdate` checkbox:

- **checked** — reads the current UI controls live and calls `detectSpots()` fresh; throwaway, never
  written to `lastResult`/`locs`/`srFull`.
- **unchecked** — replays the *last full Run's* (or Calibration's) parameters from the cached
  `det:{sigma,k,win,border,exactBP,mode}` bundle on `lastResult`/`calib`, so the overlay matches what
  was actually localized.

Any control that affects detection/fit is wired into the live-preview listener array (search for
`.forEach(id=>{` near the settings-JSON code) — a new per-method parameter needs adding there too, or
it won't refresh the scrubbed-frame preview until the next full Run.

## Button label length

Sidebar/panel-title buttons must fit on one line at the sidebar's normal width — a label that wraps
reads as broken layout. Abbreviate rather than let a label wrap (`dist.`, `min`/`max`, `deg`) —
favour standard abbreviations over truncation that could be misread. Two-word-joined-by-punctuation
labels read `Word/word` with no surrounding spaces (**Save plot/image**, **View data/filtering**,
**Load movie/data**) — the established compact-label style here.

## `label.row` nesting-depth gotcha (indented sidebar sub-rows)

`details.sim>*:not(summary){padding-left:14px}` is a DIRECT-CHILD selector — it only matches an
element immediately inside a `details.sim`, not one nested a level deeper inside a wrapping `<div>`.
A `label.row` nested that way gets NO indent at all (flush against the details.sim's own left edge)
unless the wrapper itself separately supplies one — easy to miss since a nested row can still look
plausible at a glance. An indented sidebar sub-row should instead be a DIRECT child of its
`details.sim`, given its own `id` + inline `style="display:none;padding-left:40px"` (the extra push
past the baseline 14px, since it's a step further indented than an ordinary row), shown/hidden by the
same handler that toggles its sibling group. **Right-edge alignment needs no special-casing at all**
— `details.sim` only ever sets `padding-left`, never `padding-right`, so a row's own value control
(numstep input, `select.sel`, checkbox) naturally lands flush with a plain button's own right edge
regardless of nesting depth or indentation (a `details.sim>label.row{padding-right:4px}` rule used to
exist here specifically to "fix" this, but measured directly it caused the exact misalignment it
claimed to prevent — removed entirely, see the CSS conventions paragraph above).

## Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

## `getBoundingClientRect()` + scroll gotcha (position:fixed elements anchored to an in-flow one)

`#sideToggle`/`#sidePin` are `position:fixed`, but their `top` is derived from
`--header-content-bottom` (`measureHeader()`, `.header-actions.getBoundingClientRect().bottom`) —
VIEWPORT-relative, so it shifts as the page scrolls. A `position:fixed` element itself doesn't move on
scroll, so this must store the header's RESTING position, not whatever the viewport-relative rect
reads at the moment `measureHeader()` fires: add `window.scrollY` back — `rect.bottom + window.scrollY`
is scroll-invariant, `rect.bottom` alone is not. General rule: any `getBoundingClientRect()`
measurement feeding a `position:fixed` element's offset must add `window.scrollY`/`window.pageXOffset`
back in — a mobile browser's own `resize` event during an ordinary scroll (address bar collapsing) is
a real trigger for this to go wrong without it. A size (`--header-h`) doesn't need this, only
`.bottom`/`.top`/`.left`/`.right` reads do.

## Window resize must always re-fit the reconstruction/raw panels, not just when `atFit`

`refitCanvases()` (the debounced `window.resize`/`ResizeObserver` handler) always re-fits
unconditionally on a resize, regardless of `view.atFit`/`rawView.atFit` — `atFit` turns `false` the
moment a user zooms or pans once, which is almost always, so gating a resize's own re-fit on it would
stop re-fitting for the rest of the session after the first zoom/pan. A resize reshapes the PANEL, a
distinct action from zoom/pan, so the two must not share a gate. `atFit` is still set correctly by
`fitView()`/pan/zoom, it just doesn't gate the resize handler.

## Form controls need an explicit `font-family:inherit`

Browsers' own UA stylesheets give `button`/`input`/`select`/`textarea` a non-inheriting default font
(Chromium: plain Arial) — ordinary elements (`label`, `div`, `span`, …) inherit `body`'s own font
stack automatically, form controls never have. Fixed with one shared rule,
`button,input,select,textarea{font-family:inherit}`, right after the `*{box-sizing:border-box}` reset
at the top of the stylesheet. `#logTerminal`'s own deliberate monospace shorthand (an ID selector,
higher specificity) is unaffected.

## The sidebar-hidden left/right panel gap must stay symmetric

`.main{padding:10px 12px 10px 0}` has deliberately ZERO left padding — correct while the sidebar is
visible, since the visual gap on that side is meant to come from `.sidebar`'s own padding + the grid
gap, not `.main` itself. Once `body.side-hidden .sidebar{display:none}` removes the sidebar from the
grid, `.main`'s own left padding must be restored to match its right (`body.side-hidden
.main{padding-left:12px}`), or the raw panel's left gap collapses to just its `.card`'s own inner
padding while the SR panel's right gap stays unchanged. Scoped inside `@media (min-width:861px)` — on
mobile the sidebar is a `position:fixed` overlay drawer never part of the grid at all, and the
higher-specificity `body.side-hidden .main` selector would otherwise win over the mobile layout's own
already-symmetric `.main{padding:14px 14px}` rule and reintroduce an asymmetry mobile never had.

## `<noscript>` + `.textContent +=` gotcha

Never put a `<noscript>` inside an element that JS later reads via `.textContent` (especially `+=`,
which reads-then-overwrites). With scripting enabled, a browser parses `<noscript>...</noscript>`
content as RAWTEXT — a single opaque text node, not real child markup — so `.textContent` on an
ancestor includes that raw text (literal tags and all) even though the `<noscript>` itself renders as
nothing. Reading `.textContent` is harmless; the moment something WRITES `.textContent` through an
ancestor, the noscript element is destroyed and replaced by one flat text node, permanently baking
the raw warning text into the visible content regardless of whether scripting is actually enabled.
General rule: `<noscript>` is only safe near code that reads/writes `.textContent`/`.innerHTML` if
nothing ever WRITES through an ancestor of it.

**Log box / logged-text width split** (`#log`/`#logText`) — `#log` is the outer box (border/
background/scroll, no width cap); `#logText` is a plain child holding the actual text
(`max-width:80ch`, a standard terminal width). `log()`/`clearLogBtn`/`exportLogBtn` all read/write
`#logText`'s `.textContent`; `#log.scrollTop` (the outer box) is what `log()` sets to autoscroll,
since `#logText` has no scrollbar of its own. `#log`'s own height is a fixed 236px, sized for exactly
12 text lines (`12×18px` + `20px` padding) — a plain fixed height, not viewport-relative.

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
functions, stubbing their globals (`performance`, `log`, etc.), and running against synthetic ground
truth in the same `osascript -l JavaScript` (JXA) engine. JXA has no good JIT (~50–100× slower than
V8), so keep validation inputs small.

Playwright (`tools/node_modules`, Chromium bundled by default; WebKit can be installed with
`npx playwright install webkit` for a Safari-approximating cross-browser check) is the standard tool
for interactive/visual verification — write a throwaway script under your scratchpad or `tools/`
(prefixed `_tmp_` and deleted before considering work done), never commit one.

### `micromanager_plugin/webSMLM_Streaming` (Java) — rebuild locally to test, never commit the jar

Editing any `.java` file under `micromanager_plugin/webSMLM_Streaming/src/` does **not** update
`target/webSMLM_Streaming.jar` by itself — that jar is a build artifact, and a stale one left in
place after a source edit silently keeps running old code with no signal anything's out of date.
Rebuild it locally every time you need to actually test a Java-source change:

```sh
mvn package -Dmm.install.dir="C:\path\to\your\Micro-Manager-install"
```

(see `micromanager_plugin/webSMLM_Streaming/README.md`'s own *Building* section for the full
requirements — a local MM 2.0 install, JDK 11+, Maven 3.6+). If `mvn` isn't on `PATH`, compile and
jar manually via `javac`/`jar` using the same dependency jars `pom.xml` lists. Confirm the rebuilt jar
actually contains the change (`jar tf`/`javap`) rather than assuming the build succeeded.

`target/` is gitignored — the compiled jar is **never committed** (a binary rebuilt-and-recommitted
on every edit would grow the repo forever with undiffable blobs, and git alone can't prove a
committed jar matches the source next to it). Distribute a built jar via a GitHub Release asset, or
have users run the `mvn package` command themselves.

## Branch & release workflow

- **`main`** is live: it is served by GitHub Pages (`hohlbeinlab.github.io/webSMLM/webSMLM.html`) and
  archived on Zenodo. **`webSMLM_local`** is the dev branch — do work there.
- Only push to `main`, merge, or cut a release **when the user explicitly asks.** Release = commit on
  `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Cadence: **minor bumps (`0.x.0`) → cut a GitHub release + new Zenodo version DOI. Patch releases
  (`0.x.y`) → version bump + push to `main` only, no DOI.**
- Version lives in two spots in `webSMLM.html` (the `.pill` in the `<h1>`, and `#logText`'s own seed
  text) plus `CITATION.cff`. Dev builds are marked `vX.Y.Z-dev · build YYYY-MM-DDx`; clear the dev
  marker to `vX.Y.Z · proof-of-concept` on release. **Bump the build letter suffix (`a`→`b`→`c`…) on
  every round of changes the user is about to test** — it's the only visible signal (pill + log
  stamp) that a hard-refreshed page is actually running the latest edits, not a cached prior build.
  Past `z` in a single day, roll over spreadsheet-column-style (`z`→`aa`→`ab`…). **Every build-letter
  bump also gets its own commit on `webSMLM_local`** (no need to ask first — a standing instruction),
  so each testable round has real git history. This is independent of releasing: `webSMLM_local`
  accumulates fine-grained commits continuously; `main` only receives them in a batch, at an explicit
  release. **Same round: check the top-of-file MODULE INDEX comment against a fresh
  `grep -n "MODULE:"`** and refresh any line number that's drifted by more than a few lines.
- Every release also updates `CHANGELOG.md` (newest first; DOI column) and, where the release closes
  out or changes a roadmap item, `docs/REFACTOR_PLAN.md`. Pages typically redeploys ~1-2 min after a
  push; check with `gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`.
- **Read the Docs also rebuilds on every push to `main`** — a GitHub webhook (repo Settings →
  Webhooks, id `669780136`, events: `push`) targets RTD's own incoming-webhook URL, HMAC-signed with a
  secret held only on the GitHub and RTD sides. No API-based check exists for this the way Pages has
  one — after a release, either check the RTD project's own Builds page, or confirm the live site
  reflects the change a few minutes later.
- Push `webSMLM_local` to origin regularly (backup) — do not let commits accumulate only locally.
  This is independent of, and does not require asking about, pushing/merging into `main`.

## Reference material

- `README.md` — deliberately short: launch instructions, the guided workflow (kept in sync with the
  in-app **Quick guide** modal's own "Guided workflow" — update both together if either changes),
  data/privacy, scripting/headless, roadmap, distribution/citation, licence.
- `docs/DOCUMENTATION.md` — detailed reference for every button/control/`PARAMS` entry, the on-disk
  file formats (settings/calibration/CSV JSON), the headless API/CLI (§8), and every algorithm
  reference (§9) — the place to check or update for exact defaults, ranges and behaviour,
  complementary to the deliberately sparse in-app **Quick guide**. §1 also has a reference table of
  every actionable GUI control → its terminal-callable function name.
- `docs/REFACTOR_PLAN.md` — forward-looking roadmap only; shipped-feature history lives in
  `CHANGELOG.md` instead. Think in version numbers, not "phases".
- `CHANGELOG.md` — the per-release log, including specific settings/numbers and notable rejected
  approaches for any given release. This is where "why did we build/change X" for anything already
  shipped should be checked or added — not this file.
- `experimental_data/` — sample stacks (gitignored large files) with a README of public sources and
  their camera/pixel-size parameters.
- `tools/` — scripting/headless tooling for advanced users, not needed for interactive use:
  `webSMLM-cli.mjs` (Node + Playwright, true headless, the recommended one), `browser_sweep.py`/
  `browser-sweep.sh` (stdlib-only Python / bash, drive a real visible browser for a parameter sweep).
  See each script's header comment and `docs/DOCUMENTATION.md` §8.

## Documentation build

- `docs/DOCUMENTATION.md` is the only authored source for the detailed Read the Docs manual. The
  Read the Docs build is Markdown-native (Sphinx + MyST).
- `docs/readthedocs/build_docs.py` splits `DOCUMENTATION.md` at each level-2 (`##`) heading into
  separate temporary Markdown pages so the published manual has one Read the Docs page per major
  section. It also generates the documentation `index.md`/toctree, preserves cross-section
  references, and adjusts relative documentation-image paths.
- Generated files are disposable and **must not be edited or committed**: `docs/readthedocs/content/`,
  `docs/readthedocs/index.md`, `docs/readthedocs/_build/`. Documentation-content changes belong in
  `docs/DOCUMENTATION.md`; if the generated structure, links, or paths are wrong, fix
  `docs/readthedocs/build_docs.py` instead.
- Documentation images live once in `docs/images/`, referenced from `DOCUMENTATION.md` as
  `images/...`.
- Read the Docs runs the splitter before Sphinx via `.readthedocs.yaml`. For a local strict build
  from the repository root:
  ```
  python docs/readthedocs/build_docs.py
  python -m sphinx -W --keep-going -b html docs/readthedocs docs/readthedocs/_build/html
  ```
- If generated documentation is wrong, fix `docs/DOCUMENTATION.md` or, when the generation logic
  itself is responsible, `docs/readthedocs/build_docs.py`.
- **In-app "more info…" popups** (`.hint` divs) are synced FROM `docs/DOCUMENTATION.md`, not
  hand-authored independently — this is the single source, avoiding drift between two places
  describing the same controls. Each `.hint` div carries a stable `id="hint-<name>"`; the matching
  content lives inside a `<!-- HINT:<name> --> ... <!-- /HINT:<name> -->` marker in
  `DOCUMENTATION.md` (right after that control group's PARAMS table in §2), as **raw HTML**
  deliberately, not Markdown — byte-identical in both places. Edit a hint's content ONLY inside its
  `DOCUMENTATION.md` marker, then run `node tools/sync_hints.mjs` (rewrites `webSMLM.html`'s `.hint`
  divs to match) — never hand-edit a `.hint` div directly, it'll be overwritten on the next sync.
  `--check` exits 1 without writing if `webSMLM.html` would change, for a pre-commit/CI-style drift
  check. The `<span class="pill">module: X</span>` label at the top of each `.hint` div is NOT part
  of the synced content (fixed markup in `webSMLM.html`). The 10 `.hint` divs are
  `hint-memory` (also covers live streaming — no separate `hint-liveStreaming`),
  `hint-simulation`, `hint-pcfo`, `hint-calibration`, `hint-detectfit` (also covers **export**'s own
  Gain/Camera offset fields, moved to the top of Localisation settings — no separate `hint-export`),
  `hint-render`, `hint-drift` (also covers Localization precision/NeNA/FRC — no separate
  `hint-locprecision`), `hint-sSMLM`, `hint-smfret`, `hint-spt`. Each marker is placed as the INTRO to
  its DOCUMENTATION.md section, right after the PARAMS table — the surrounding prose picks up only
  where the popup leaves off. A popup's own internal paragraph order should match its sidebar's own
  top-to-bottom field order — check this whenever a sidebar section's field order changes.
- **Quick guide** (the in-app modal, `helpBtn`) is deliberately thin: intro blurb, the 5-step
  **Guided workflow**, **Acknowledgements**, **License & author** — no per-module walkthrough, no
  citation list (`docs/DOCUMENTATION.md` §9 is the maintained source for citations now). The modal's
  own text is hand-authored UI copy, not synced by `sync_hints.mjs`. `README.md`'s own "Guided
  workflow" section is a copy of this same 5-step list — update both together.
