# webSMLM — Documentation

A detailed reference for every button, control, parameter and module —
complementary to the in-app **Quick guide**, which stays deliberately sparse
(a quick walkthrough, not a manual). This file is the place for the detail
that doesn't belong in a UI popover: exact defaults, min/max/step, what each
control actually does under the hood, and the on-disk file formats.

**Scope note:** this describes behaviour, not implementation — it should stay
accurate without needing a rewrite on every internal refactor. When editing
`webSMLM.html`, prefer expanding this file over adding a long inline comment;
a comment should only explain a non-obvious *why*, not *what* (see
`CLAUDE.md`). If a described default/range drifts out of sync with the
`PARAMS` registry, `PARAMS` is authoritative — this file describes it, not
the other way round.

**This file is also the source for the app's own in-app "more info…"
popups** (the `.hint` divs next to each sidebar control group — a third,
separate layer from both this manual and the sparse Quick guide modal).
Each popup's content lives inside a `<!-- HINT:<name> --> ... <!-- /HINT:<name>
-->` marker below, kept in sync with `webSMLM.html` by `tools/sync_hints.mjs`
— edit the marker, then run the script; never hand-edit a `.hint` div
directly (see `CLAUDE.md`'s **Documentation build** section for the full
mechanism).

Line/anchor references below point at `webSMLM.html` as of **v0.10.3**;
exact line numbers will drift as the file grows, but the `id=`/function names
they're built from won't.

---

## 1 · Exploring the user interface

### Header

Two small buttons live top-left of the whole page, outside the header
itself: `sideToggle` (⇤, collapse/re-open the sidebar — floats as an
overlay on re-open so toggling never resizes the canvases) and `sidePin`
(📌, dock a floating sidebar back into the normal layout).

The header (top-right, next to the title) holds two controls, neither a
`PARAMS` entry nor part of Save/Load Settings — both are pure display/
layout, not analysis parameters:

- A **colour theme** switch — three small icon buttons
  (`themeLightBtn`/`themeDarkBtn`/`themeContrastBtn`, ☀/☾/◐), one click
  each to switch between dark (the app's original look), light, and a
  high-contrast theme. Persisted via `localStorage` (`webSMLM_theme`),
  wrapped in `try`/`catch` — a blocked/unavailable store falls back to
  dark (this app's only theme before this existed) on read, and silently
  keeps working for the rest of the session (just not remembered next
  visit) on write; no error ever surfaces either way.
- `layoutToggleBtn` ("Stack panels"/"Side by side"), which switches the
  two main data panels between side-by-side and stacked (full-width, one
  above the other), overriding the automatic choice `initScrub()` makes
  from the loaded stack's own aspect ratio. Hidden below the ~860px mobile
  breakpoint, where the panels are already forced to one column
  unconditionally — the toggle would have nothing left to switch there.

A second, unrelated `localStorage` key (`webSMLM_lastVersion`) tracks which
release this browser last saw, independent of theme — see **Log window**
below for what it does.

### Sidebar — action buttons

| Button | id | Does |
|---|---|---|
| **Load movie/data** | `loadBtn` | Opens a file picker accepting EITHER a movie (one multi-frame TIFF, or Ctrl/Cmd+click several files to combine them into one stack, natural-sorted by filename — either several single-frame TIFFs, one file = one frame, e.g. a per-frame camera dump, OR several multi-frame TIFFs from ONE continuous acquisition split purely by size, each file = a chunk of frames; which one is auto-detected from the first file's own frame count) OR a single CSV previously written by **Save data**, detected by file extension. Selecting a CSV and a movie together is refused with a logged error — pick one type at a time. See **in/out**/**pipeline** below. |
| **Simulate movie** | `genBtn` | Generates a synthetic stack from the *Simulation settings* module — no file needed, useful for a quick smoke-test or teaching demo. |
| **Load settings** | `loadSetBtn` | Opens a `.json` file (as saved by **Save settings**) and applies every recognised `{id: value}` pair to the `PARAMS` registry — unknown/legacy keys are logged and ignored, not errored on. |
| **Save settings** | `saveSetBtn` | Dumps the *current* value of every `PARAMS` entry (not just ones with a page control) to a `webSMLM_settings.json` file — see [§4](#4-settings-json-format). |
| **Localize** | `runBtn` | Runs detection + fitting over the whole loaded/simulated stack — the main action. Disabled until a stack is loaded. |
| **Stop** | `stopBtn` | Requests an early stop of a running **Localize** or **3D calibration**. Localize keeps whatever localizations were gathered so far (a partial result is still valid). Calibration discards everything instead — a calibration fit needs the WHOLE configured z-range, so a partial one would be silently biased, not just smaller; press **3D calibration** again to restart with a narrower/correct frame range. |
| **Save data** | `saveBtn` | Exports the current (filtered) localizations as a ThunderSTORM-compatible CSV — see [§6](#6-csv-export-format). Disabled until there are localizations. |
| **Save plot/image** | `saveImgBtn` | Opens a chooser (if both panels have content) to export the raw/reconstruction/plot window shown. The raw frame or reconstruction always saves as a supersampled PNG. A plot (calibration/drift/NeNA/FRC/PCFO/line-profile/histogram) instead opens a save dialog offering **both** PNG and SVG as file types — pick the format in the dialog's own "Save as type" dropdown. (Browsers without a native save-file dialog, e.g. Safari/Firefox, fall back to a PNG download — SVG needs the native dialog to choose.) |
| **View data/filtering** | `tableBtn` | Opens the sortable, filterable localizations table — see [§5](#5-table--filter-grammar). Disabled until there are localizations. Loading a CSV back in (via **Load movie/data** above) works exactly as after a Run — table, reconstruction, NeNA/FRC/drift/re-export all function on it, using only what's in the CSV plus the *current* Pixel size / Magnification controls; there's no raw frame data, so `stack` is left untouched and re-detection/live preview stay unavailable for CSV-loaded data — see [§6](#6-csv-export-format). |
| **Quick guide** | `helpBtn` | Opens the in-app quick-reference modal (guided workflow, acknowledgements, licence). Shares its row with **View data/filtering**. |

### Sidebar — Pixel size (nm)

`pxnm` sits as a plain, always-visible row directly below the action
buttons/progress bar — deliberately NOT inside any collapsible module. It
used to live inside **Localisation settings** (collapsed by default)
alongside Gain/Camera offset; pinned out here instead (v1/first pass,
expected to be refined further) since it's easy to forget it's there while
buried in a closed section, despite feeding the scale bar, z, and every
exported CSV coordinate — see [§3](#export-params) for the full parameter
entry. Gain/Camera offset stay inside **Localisation settings** for now.

### Sidebar — collapsible modules

Each is a `<details>` element; opening one doesn't affect the others. All
carry their own **more info…** button, opening a popup with in-context help
(a shared `#infoModal`, same mechanism as the localizations table popup,
rather than expanding inline — inline hint text at the sidebar's own
font-size/contrast was hard to read for anything longer than a line or two)
— this section summarizes what's *in* each, not what the help text already
says.

- **Memory & streaming** (`memBox`) — `memgb`/`chunkmb`. See
  [§3](#in-out-params)/[§2](#in-out).
- **Simulation settings** (`simBox`) — only relevant when using **Simulate
  movie**. See [§3](#simulation-params)/[§2](#simulation).
- **Gain & offset estimation** (`pcfoBox`) — **Estimate**/**Transfer
  estimates**. Placed here, before **3D calibration**, since both are
  one-off "derive a number from data, then use it below" steps run before
  the main Localize. See [§3](#pcfo-params)/[§2](#fit).
- **3D calibration** (`calibBox`) — **Calibrate**/**Save calib.**. See
  [§3](#3d-calibration-params)/[§7](#7-calibration-json-format)/[§2](#3d-calibration).
- **Localisation settings** (`locBox`) — fit method, detection filter, FTM,
  frame range, and Gain/Camera offset; two separate "more info…" popups
  cover them (one for everything through **Fit radius**, a second for
  Gain/Camera offset after it — `pxnm` itself moved out to its own
  always-visible sidebar row, see above). See
  [§3](#detect-params)/[§3](#fit-params)/[§3](#export-params).
- **Rendering settings** (`renderBox`) — magnification, colour map, and
  (3D/sSMLM-paired results only) depth/distance colouring. See
  [§3](#render-params)/[§2](#render).
- **Drift correction (AIM)** (`driftBox`) — **Correct drift**/**Show
  drift**. See [§3](#drift-params)/[§2](#drift).
- **Localization precision (NeNA & FRC)** (`precBox`) — **NeNA**/**FRC**.
  See [§3](#locprecision-params)/[§2](#locprecision).
- **Spectral SMLM analysis** (`sSmlmBox`) — pairs 0th/1st-order
  localizations from a diffraction grating; enabled as soon as there are
  localizations (Run or **Load data**), not gated on a specific fit method.
  See [§3](#ssmlm-params)/[§2](#ssmlm).
- **Single particle tracking** (`sptBox`) — links localizations into
  trajectories and computes a per-track diffusion coefficient; enabled as
  soon as there are localizations, same gating as Spectral SMLM analysis.
  See [§3](#spt-params)/[§2](#spt).

### Main data panels

`#canvases` (the grid wrapping both) gets a `.stacked` class — switching it
from side-by-side (`minmax(0,1fr) minmax(0,1fr)` columns) to a single column —
whenever the loaded stack's `h/w < 0.5` (the default suggestion, applied via
`applyLayout()` — called from `initScrub()` alongside the `--frame-ar`
custom property both canvases share); a very wide/short frame would
otherwise render tiny twice over (squeezed to half width on top of already
being short). The **Stack panels**/**Side by side** button
(`layoutToggleBtn` — see **Header** above) overrides this: once
clicked, `layoutOverride` (true/false) takes over from the `h/w<0.5`
heuristic and sticks across further loads this session, rather than every
new movie silently resetting the user's own choice — `applyLayout()` is the
single place that resolves override-vs-heuristic into the actual class. A
`ResizeObserver` on `#canvases` (not just a `window` `resize` listener,
which only fires for actual viewport changes) redraws both panels' backing
stores whenever their on-screen box size changes for *any* reason — this
toggle, the sidebar dock/float/collapse buttons, or an actual window resize.

A line plot or histogram drawn on either canvas (the raw/SR panel plot
pattern below) does NOT resize the panel itself — the canvas always keeps
tracking `--frame-ar` exactly like a real frame/reconstruction view, so a
panel's height never changes depending on whether it (or its sibling) is
currently showing a frame or a plot. Instead, `setupPlot(cv,true)` (every
plot-drawing function passes `true`; the frame/reconstruction drawers
don't) letterboxes a fixed 4/3 sub-rectangle centred within the panel's own
(unchanged) box — filling the whole canvas with the plot's own background
colour first so the letterbox bars are invisible, then translating so the
plot's own drawing code (unaware of any of this) draws into the sub-rect as
if it were the whole canvas. 4/3 matches matplotlib's own default figure
size. Each canvas's own controls (`#scrubRow`/`#srFilterNote`/`#calViewRow`)
are wrapped with it in a `.panel-body` div, which is top-aligned (NOT
centered) — since raw/sr canvases are now always exactly the same height,
centering each panel's own canvas+controls group independently used to
shift the two canvases out of alignment with each other by roughly half of
whichever trailing control only one panel has (raw's `#scrubRow` has no sr
equivalent when `#srFilterNote`/`#calViewRow` are both hidden). Top-aligning
keeps both canvases flush against their own title row always, so they start
at the same y regardless of what trailing content either panel has.

Every plot function reads its colours from `plotColors()` rather than a
hardcoded hex value: dark on screen (`#161b22` background, matching the
app's own permanently-dark chrome — there's no separate light/dark app
theme to switch between), light (`#f6f8fa`, the original palette) only for
`exportPanel()`'s "plot" branch — which flips the shared `_plotExportMode`
flag, calls the panel's own `_replotRaw`/`_replotSr` to redraw once in
light colours, snapshots that, then flips back and redraws again so the
on-screen view is left exactly as it was. A saved PNG is meant for a
paper/report, where a white background reads better; the live view stays
dark to match the rest of the UI.
- **Raw frame** (`raw` canvas) — the loaded stack's current frame with
  detected ROIs (green) and accepted localizations (magenta crosshairs)
  overlaid; doubles as a **plot surface** for FRC/NeNA/drift/calibration
  curves and column histograms when there's nothing to show as a frame
  (`rawIsPlot`/`rawPlotName`). `measureBtn`/`cropBtn` (line-profile and crop
  tools) live in the *reconstruction* panel's header but draw their overlay
  on whichever panel is currently a live reconstruction. `rawFtmBtn`,
  inline in the panel title next to "Raw frame" (shown only while
  `ftmEnabled` is checked, its own label reading "Show FTM corrected" /
  "Show raw"), toggles the panel between the raw frame and its live
  FTM-corrected preview — the title itself stays fixed at "Raw frame" — see
  [§3](#3-parameters-params-registry)'s FTM section. Hovering shows a
  crosshair + readout of the pixel under the cursor — `x=`/`y=` (native pixel
  index, 0-based) and its value in ADU, plus the photon-converted equivalent
  once `gain`/`camoffset` are set away from the uncalibrated 1/0 default
  (`rawPixelData`, the array `drawRaw()` was actually given — raw camera data,
  or FTM-corrected when the raw/FTM toggle is on — kept separately from
  `rawFull`, which is only a lossy min/max-normalized 8-bit render). Reuses
  the same hover mechanism as the plot surfaces above (`registerPlotHover`/
  `drawPlotHover`); no readout while zoomed out past fit and hovering the
  letterboxed border outside the actual frame. `rawCropBtn`, inline in this
  panel's own title (enabled as soon as a stack is loaded, unlike `cropBtn`
  below), is a **second, unrelated crop tool** — click two corners to
  **replace the loaded `stack`** with just that native-pixel region
  (`makeCroppedStack()`, MODULE: in/out) rather than filtering an existing
  result: Localize, scrubbing, FTM, calibration, PCFO all then only ever see
  the cropped region, the same way they'd see any smaller loaded file — real
  speed-up, not a display filter, and logged (`Cropped to x…`). Same
  click-two-corners/toggle-to-undo interaction as `cropBtn`, but deselecting
  restores the *original* stack (kept in `originalStack` while a crop is
  active) rather than removing a table filter — see
  [§2](#2-module-reference)'s **in/out** entry and
  [§8](#8-headless-api-window-websmlm)'s `cropX0`/`cropY0`/`cropX1`/`cropY1`
  for the headless equivalent. Cropping/uncropping also re-estimates the
  Contrast slider below (see next) against the newly active stack, so it
  never keeps showing the range sampled from the frame size that was active
  before the crop.

  **Contrast** (below the Frame scrubber, Picasso-style) is a fixed
  [black,white] ADU display range — two overlapping range-slider handles
  (`#rawBlack`/`#rawWhite`) — applied identically to every frame, rather
  than the auto-stretch-per-frame most viewers default to (which makes
  brightness visibly shift as you scrub and lets one dead/hot pixel dominate
  a single frame's own min/max). It's initialised once per loaded stack from
  a bounded random sample of frames (for the slider's own outer bound) and
  frame 0's own actual min/max (for the initial handle positions); dragging
  either handle redraws instantly from the last-fetched frame's pixel data,
  no re-fetch. **Auto** (`rawContrastAutoBtn`) resets both handles back to
  that same estimate on demand. Purely a display convenience, local to the
  current session — deliberately **not** a `PARAMS` entry, not part of
  Save/Load Settings, and not exposed to the headless `analyze()` config
  (same carve-out as UI theme/panel-layout choice, [§3](#3-parameters-params-registry)).
- **SMLM reconstruction** (`sr` canvas) — the accumulated super-resolution
  render, or (before a Run) a quick averaged data projection, or the 3D
  calibration curve plot (`srIsPlot`). `calViewBtn` toggles that plot between
  σ-width and phasor-magnitude views (3D calibration only).

### Log window

Every module writes its progress/results/warnings here (`log`) — the one
place to check what a Run, Calibrate, drift correction, NeNA/FRC, or a file
load actually did. `clearLogBtn`/`exportLogBtn` (grouped with the "Log"
title on the left of its own title bar) clear it or save it as a `.txt`
file; `layoutToggleBtn` sits on the right of the same title bar (see
**Header** above for what it does — it's placed here in the layout only for
spacing, not because it's log-specific). The single shared progress bar
(`#bar`/`#prog`, below the action buttons) is fed by every long-running
operation (Localize, Calibrate, drift, NeNA, FRC, file loads).

On every load, the page also compares the release number in the `<h1>`
pill against whichever version this browser last saw (`localStorage`'s
`webSMLM_lastVersion` — see **Header** above) and, if different, logs one
line — `webSMLM updated: vA.B.C → vX.Y.Z` — linking to the GitHub
changelog; a brand-new visitor just has the current version silently
recorded, no message. Ignores the `-dev`/build-letter suffix, so this only
fires on a genuine release change, not routine local development reloads.

---

## 2 · Module reference

Mirrors the `MODULE:` banners in `webSMLM.html`, in source order. Each entry
is what to know before touching that module, not a restatement of its code.

### PARAMS registry (`params`) {#params}

See [§3](#3-parameters-params-registry). `paramValue(id)` is
the only correct way to read a parameter (handles the DOM-control vs.
`paramOverrides` vs. registry-default fallback, plus int rounding).

### Load movie (`in/out`) {#in-out}

TIFF parsing. Bit depth (8/16/32-bit) and endianness are handled
automatically; 16-bit is preserved, never flattened to 8-bit. TIFF
headers are parsed first to get frame count/dimensions, then the decoded
working-set size is estimated (`frames × width × height × 4 bytes`)
against `memgb` to decide in-memory vs. streamed loading (`memgb`
budget); large (above ~4 GB) ImageJ stacks — where 32-bit TIFF offsets
can no longer address further, so the whole stack is written as a single
directory entry with every frame laid out contiguously after it — are
indexed arithmetically from that entry, unlike ordinary/multi-IFD
(Micro-Manager MMStack) stacks, which walk the IFD chain frame by frame —
never fully loaded, read via `File.slice()`. `loadTiffFilesAuto()` handles a multi-file
selection, auto-detecting which of two cases it is from the first
(naturally-sorted) file's own frame count: exactly 1 frame → every file is
one frame (`loadTiffSequence()`, natural-sorted and concatenated — e.g. a
per-frame camera dump); more than 1 → every file is its own chunk of ONE
continuous acquisition split across files purely by size (`makeConcatStack()`,
each file loaded normally via `loadTiffFile()` so it keeps whichever
strategy — in-memory/sliced/streamed — its own size calls for, then
concatenated end-to-end). No separate control for which case applies; it's
inferred automatically. Multi-file candidates are filtered by sniffing the
real TIFF magic bytes (`isTiffFile()`), not the filename extension — a
file merely *named* `.tif` isn't required, and a file that IS TIFF-formatted
underneath loads correctly regardless of its extension (`#file`'s `accept`
also lists `.nd2`, since a real sample turned out to be a mislabeled TIFF
export — see `docs/REFACTOR_PLAN.md`'s ND2 entry); genuinely unparseable
content fails with a clear error (`loadTiff()` validates the raw
ImageWidth/ImageLength tags before trusting a decode) rather than
producing `NaN`-sized buffers downstream. Genuine native Nikon `.nd2`
binaries (not just the TIFF-in-disguise case above) are also supported —
`isNd2File()` sniffs the real magic bytes and `loadTiffFile()` dispatches
to a dedicated `loadNd2File()` parser, reaching the interactive `#file`
input, calibration file loading, and headless `analyze()`'s
`cfg.file`/`cfg.calibrationFile` alike with no extra wiring. Single
channel, 16-bit, uncompressed only; multi-channel or other bit depths
throw a clear unsupported-format error. See **in/out** in `CLAUDE.md` for
the file-format details. `runFTM()` (optional, `ftmEnabled`)
runs right after either loader finishes, replacing `stack` with a fresh
`makeStack()`-backed one holding the temporal-median-corrected frames —
see [§3](#3-parameters-params-registry)'s FTM table for the full behaviour.
`makeCroppedStack(rawStack,x0,y0,x1,y1)` is the raw-panel crop tool's
(`rawCropBtn`) own wrapper, same idea: every fetched frame is sliced to
the `[x0,x1)×[y0,y1)` sub-rectangle, with that corner becoming the new
`(0,0)` — deliberately a full stack *replacement*, not a search-region
restriction threaded through detection/fitting, so nothing downstream
needs a coordinate offset added back; a smaller `stack` is indistinguishable
from having loaded a smaller file to begin with. No caching layer — each
fetch re-slices from whatever `rawStack` already does, so "uncrop"
(`originalStack`, kept only while a crop is active) and re-scrubbing both
just re-fetch from the original, same as the first load did. Composes for
free with everything above it (FTM wraps whatever `stack` currently is,
so cropping first then enabling FTM correctly runs the temporal median
over the smaller frames too) since nothing else in the codebase assumes a
particular frame size.

### Simulation settings (`simulation`) {#simulation}

The built-in synthetic stack generator ("Simulate
movie"). Demo/validation/teaching data, not a core analysis path. Emitters
follow a Poisson-process arrival/exponential-lifetime model over a
physical areal density (`dens`), run through a forward camera model
(shot noise → read noise → gain → fixed-pattern offset), decoupled from
the fit-side `gain`/`camoffset` so ground truth and the fit's assumed
camera can be matched or intentionally mismatched — see
[§3](#3-parameters-params-registry)/Simulation. Stores the true per-frame
drift (`simTrueDrift`) for scoring drift correction and the true emitter
events (`groundTruthEvents`) for future recovery comparisons.

### Localisation settings (`detect`) {#detect}

Per-frame band-pass, one of three filters selectable via
`detFilter`: wavelet (default), DoG, or uniform box — each thresholded
differently (see [§3](#3-parameters-params-registry)/Detect). `detectSpots()`
is the single dispatch point used by both the main thread and workers.
DoG blurs each frame at a small scale (0.8×σ_PSF) and a large scale
(3×σ_PSF), subtracting the large-scale blur from the small-scale one —
`DoG = G(0.8σ) − G(3σ)` — removing flat background/slow gradients while
keeping PSF-sized spots; candidates are then strict 8-neighbour local
maxima above `mean + k·σ_noise` of the filtered image (σ_noise is the
filtered image's own spread, not σ_PSF).

### Localisation settings (`fit`) {#fit}

Phasor (fast, non-iterative), Gaussian least-squares, and
Gaussian Poisson-MLE 2D/3D (`gaussianMLEspheric`/`gaussianMLEelliptic`, the
default). All convert ADU→photons via `gain`/`camoffset` before fitting.
MLE fitters reject a candidate outright (return `null`) rather than
keeping a degenerate result: not converged within the iteration budget,
amplitude pinned at the enforced floor (background mistaken for a spot),
or a non-finite CRLB (singular Fisher matrix). `gaussianMLEelliptic` also
returns `lpsx`/`lpsy` (fit precision of the σx/σy widths), consumed by
`zFromWidths()` to estimate `lpz` — an approximate z-precision via error
propagation through the calibration curve's local slope (not a true joint
CRLB, since z isn't a parameter of the pixel-level fit). A fifth method,
**Gauss MLE 3D rotated elliptical** (`gaussmleEll`, `gaussianMLEellipticangled()`),
fits an independent σx/σy at either a FREE or a FIXED rotation angle,
chosen by the **3D localisation?** checkbox (`localize3D`, shown for this
method and `mle3d`, default checked — see
[§3](#3-parameters-params-registry)): checked = FREE angle (a genuine
per-emitter rotation, recovered by the fit itself — useful as an
astigmatism-axis-alignment diagnostic against real 3D calibration bead
data) plus z from a loaded `gaussian_width` calibration, exactly like
`mle3d`; unchecked = angle FIXED at the sSMLM pairing step's own
calibrated dispersion bearing (`sSmlmAngleCenter`,
[§3/sSMLM](#ssmlm-params)),
no z — the original sSMLM-only path, for a spectrally-elongated 1st-order
PSF. Renamed from "Gaussian MLE Elliptical (sSMLM)"; `mle3d`'s own UI
label is now **Gauss MLE 3D elliptical** (`gaussianMLEelliptic()`, axis-
aligned) and `gaussmle`'s is **Gauss MLE 2D spherical**
(`gaussianMLEspheric()`) — matching Picasso's own SPHERICAL/ELLIPTIC/
ROTATED naming, no change to the underlying fit math from the rename
itself. `mle3d` also respects `localize3D`: unchecked, it runs the same
axis-aligned elliptical fit with no calibration requirement and no z —
just a 2D elliptical fit reporting σx/σy directly (see the CSV
`sigma_x`/`sigma_y [nm]` columns, [§6](#6-csv-export-format)). Either
way, use **Pair** afterward to get real per-axis widths for both the 0th
and 1st order of an sSMLM pair, not just the plain symmetric-σ proxy
every other method reports.
`gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled` all share one
Fisher-scoring Newton driver (`mleNewtonFit()`) rather than three
independently-coded copies. On the built-in synthetic model at 900
photons/emitter, Phasor reaches ~19 nm precision and Gaussian LS ~16 nm
(figures for that synthetic model specifically — real data depends on
your own photon count, background and PSF; Phasor's speed advantage over
either Gaussian method is covered in the **Fit method** popup above).
`pcfoCore()` is a
separate, one-off tool living in this module: Rieger–Heintzman PCFO
gain/offset estimation from a loaded/simulated stack directly (no
calibration acquisition needed) — see
[§3/Gain-offset estimation (PCFO)](#pcfo-params). Its
interactive wrapper is `estimateGainOffset()` (the **Estimate** button;
`transferPcfoEstimate()`, the separate **Transfer estimates** button, then
applies the result to `gain`/`camoffset`); `pcfoCore()` itself is DOM-free,
same `*Core(config, stack,
hooks)` split as `runCore`/`driftCore`/`calibrationCore`, reachable
headlessly via `config.estimateGainOffset` ([§8](#8-headless-api-window-websmlm)).

### Rendering settings (`render`) {#render}

Accumulates localizations into an offscreen buffer `srFull`;
a `view` (zoom/pan) transform draws the visible region + scale bar. Colour
maps, blur and display scaling apply without refitting. `srIsRecon` tracks
whether `srFull` is the real per-localization reconstruction (vs. the
pre-Run data projection or a calibration bead composite) — gates the crop
tool and the nm-per-pixel conversion (`srNmPerPx()`).

`renderSuperRes()`'s accumulator buffers are DENSE — one value per
super-resolution pixel across the *whole* `(w×mag)×(h×mag)` grid,
regardless of how many localizations there actually are (500 locs and 5
million locs allocate the identical buffer size for a given frame size +
Magnification) — so memory scales as **O(frame area × mag²)**, entirely
decoupled from data volume. `checkRenderSize()` runs before any
allocation and throws if either side would exceed `CANVAS_MAX_DIM`
(16384 px — a hard per-browser canvas-creation limit, not a soft budget)
or if the estimated peak concurrent footprint (the count accumulator +
an optional z-accumulator with `zcolor` + `blur()`'s own transient
dst/tmp scratch with `rblur>0` + the final `ImageData` output + the
canvas's own backing store) exceeds `memgb` — the *same* Memory budget
control stack loading already uses (§3, Memory & streaming), not a
second, separate setting. `rerender()` (interactive) catches the throw,
logs what to change (lower Magnification, crop the region, or raise the
budget), and leaves whatever reconstruction was already on screen in
place rather than blanking the panel or crashing the tab; the headless
`analyze()` path does not catch it, letting it propagate — the same
"throws immediately" precedent its other preconditions (e.g. a
too-small crop region) already follow.

The count accumulator (`acc`) is a `Uint16Array`, not `Float32Array` — a
per-pixel hit count is always a non-negative integer, so this halves
that buffer's footprint at no precision cost; `zacc` (a *sum* of z
values in nm, genuinely fractional) stays `Float32Array`. A plain
`Uint16Array` silently *wraps* past 65535 on overflow rather than
clamping, which would otherwise corrupt density data on an extreme
pile-up (many tens of thousands of localizations landing on the exact
same reconstructed pixel) — the increment is guarded explicitly
(`if(acc[idx]<65535) acc[idx]++`, else count it as saturated) and a
single warning is logged per render if any pixel actually saturates,
rather than risking that silent corruption.

### Localisation settings (`export`) {#export}

ThunderSTORM-compatible CSV, see [§6](#6-csv-export-format).
`photons`/`bg`/`bgstd` are already true photon units by the time they
reach export (conversion happens inside the fit) — export does no further
conversion, only warns when gain/offset look like they were never set.

### Worker dispatch (`workers`) {#workers}

Frame-parallel detect/fit. Workers are **not** separate
files: `workerSource()` builds worker code by stringifying the exact
functions the main thread uses, so any module-level `let`/`const` a
stringified function reads must also be re-declared in `WORKER_PRELUDE`, or
the worker throws and silently falls back to single-threaded. Batch sizing
is controlled by the `workerBatch*`/`workerMin*` params above.

### 3D calibration (`3D calibration`) {#3d-calibration}

Astigmatic σ_x/σ_y-vs-z curves from a bead z-stack;
astigmatism is the only 3D method implemented (Double Helix/Biplane would
live here too, per `docs/REFACTOR_PLAN.md`). Every bead is fit both by LS
(real σ_x/σ_y) and phasor (magnitude ratio), so a saved calibration file
can carry both models, tagged, with a guard stopping a 3D fit from running
against the wrong one. **Fix bead x,y** (`calFixedXY`) freezes each bead's
lateral position from a composite of the calibration range before fitting
widths per frame — see [§7](#7-calibration-json-format).

### Drift correction (AIM) (`drift`) {#drift}

AIM (adaptive intersection maximization), point-based, no
FFT, 2D+z. Segments localizations in time (`driftSeg`), grid-searches the
shift that maximizes coincident localizations against the accumulated
reference (`driftRoi`), then a parabolic sub-pixel peak refine.

### Localization precision (NeNA & FRC) (`locprecision`) {#locprecision}

NeNA (nearest-neighbour precision, Endesfelder fit)
and FRC (Fourier ring correlation image resolution, inline radix-2 FFT).
Marked **experimental**, not yet cross-validated against established
tools. FRC's sampling grid size is derived from a 3-tier fallback (NeNA
precision σ/2 → per-localization-precision histogram mode → reconstruction
pixel size), with NeNA rejected if implausibly larger than the mode tier
(a sign clustering has removed the genuine repeat-detection pairs NeNA
needs, letting its fit latch onto inter-molecule spacing instead).

### Spectral SMLM analysis (`sSMLM`) {#ssmlm}

Spectrally resolved SMLM: a diffraction grating in the
emission path splits each emitter into a 0th (undispersed) and a 1st-order
PSF, offset by a wavelength-dependent distance at a fixed, known
orientation; pairing them per frame recovers the emitter position, with
the distance itself a wavelength proxy. Ported from
[`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer)
(ImageJ/Java + MATLAB) — see Martens, Gobes, Archontakis, Brillas,
Zijlstra, Albertazzi & Hohlbein, *Nano Lett.* **22**(21), 8618–8625 (2022),
[10.1021/acs.nanolett.2c03140](https://doi.org/10.1021/acs.nanolett.2c03140).
`sSmlmCandidates(locs, px, distMin, distMax, angleCenter, angleTol,
onProgress)` enumerates same-frame candidate pairs within the given
distance window and within `angleTol` of `angleCenter` OR
`angleCenter+180°` (either point could turn out to be the upstream one —
see below), returning both the undirected line angle/deviation (`angle`,
`dAngle`, `sAngle` — what **Preview pairs**' diagnostic histogram plots)
and the raw, unfolded, directed bearing (`rawAngle`) `pairCore` needs.

Role assignment (which point of a candidate is 0th vs 1st order) is
**directional, not brightness-based** — an earlier version required the
paired point to be dimmer (physically plausible: the grating splits each
emitter's intensity), but real-data investigation found photon count
barely correlates with which side of a pair is which (≈50/50 even at
confident intensity gaps, most likely PSF-overlap/crowding corrupting
photon estimates at real emitter densities — a hypothesis that a genuinely
symmetric ±1st-order signal explained the same data was also tested and
ruled out, since the "wrong-side" population's intensity-*ratio* profile
turned out statistically indistinguishable from the real side, which a
genuinely weaker physical order shouldn't produce). `sSmlmAngleCenter` is
therefore a genuine SIGNED bearing (full ±180°) — the 1st order's fixed
direction from its 0th order, the same for every emitter in the image —
rather than an undirected line. `pairCore(locs, px, config, hooks)`
classifies each candidate by comparing its `rawAngle` to `angleCenter`:
whichever point is upstream on that bearing is the 0th-order candidate,
the other its 1st. A point only qualifies as 0th order if it has **at
least one** such outgoing candidate **and zero** candidates on the
*opposite* bearing (which would mean it looks like it could itself be
sitting where a 1st order would be, i.e. more likely someone else's 1st
order than a genuine 0th) — self-disqualifying, no external reference
signal needed. Closest-to-expected-bearing wins any remaining ties when a
single downstream point is claimed by more than one qualifying upstream
candidate. This was verified against the real reference dataset to
recover *more* pairs than the old brightness-gated approach (64.0% vs
59.0%), with only ~5% of points landing in the genuinely ambiguous
"candidate on both sides" bucket it correctly excludes — and a
mean-position sanity check (mean of all accepted 0th-order positions vs.
mean of all their matched 1st-order positions) reproduces the configured
~2500 nm/~2° separation almost exactly, confirming the pairs found are
self-consistent rather than an artifact. PSF width (σ) showed a real but
imperfect ~65–70% correlation with role (consistent with the 1st order's
spectral smearing broadening its PSF relative to the undispersed 0th) and
is available as an optional, default-off extra confidence gate
(`sSmlmRequireNarrower` — requires the qualified 0th candidate's own σ to
be smaller than its chosen 1st order's) rather than a requirement, since
it's still well short of reliable enough to gate on by default.
**2-point pairs only for now**
(0th+1st) — multi-order chaining, and FFT-based automatic angle/distance
detection (`sSMLMAnalyzer`'s `AngleAnalyzer.java` renders localizations to
an image and 2D-FFTs it to find the dominant periodic peak), are tracked
as follow-ups in `docs/REFACTOR_PLAN.md`, not implemented here — the
**Preview pairs** distance/angle histograms cover the same "find my
window" need more simply for a first version, verified against a real
~2M-localization reference dataset (`experimental_data/README.md`) before
building the rest around it. A localization that finds no partner within
the window is dropped from the result entirely — the output only ever
contains accepted pairs. Each accepted pair's reported position is the
**0th order's own** x/y, not the midpoint between the two: the 0th order
is undispersed, so its centroid already IS the emitter's true image
position, while the 1st order sits a wavelength-dependent (i.e.
emitter-to-emitter varying) distance away — averaging the two would blur
position by up to half that spectrally-varying offset instead of reporting
it precisely. Each paired row also carries `sigma1st` — the 1st order's own
`sigma` (`locs[e.down].sigma`, already read once for `sSmlmRequireNarrower`'s
comparison above, threaded through here instead of discarded), exported as
a `sigma1st [nm]` CSV column (see §6) and shown as a `sigma1st` table
column (see §5) whenever present — not a directional/long-axis width, since
no 2D fit method computes one, but the closest available proxy for how much
wider the spectrally-smeared 1st order looks vs. the 0th. Pairing stores
the inter-order distance in its OWN `dist` field — deliberately **never**
`z`, an earlier design that aliased `z` was reverted (2026-08-17) so a
future 3D-fit + sSMLM combination could carry real depth AND spectral
distance on the same loc without one overwriting the other; `pairCore()`
never even sets `z`. The **render** module's `renderSuperRes()`/`zRange()`
take an explicit `colorField` (`'z'` or `'dist'`) instead of hardcoding
`.z`, so the same depth-coded path colours by either; the interactive
wrapper and `analyze()` (see §8) each derive it as `hasZ ? 'z' : (hasDist ?
'dist' : null)` — only one is ever reachable today, but the seam is real.
This split also fixed a genuine bug: drift correction's "Correct z too
(3D)" option used to key off the same check the colour toggle used, so a
paired result could show it and — if ticked — silently 1-D-"correct" its
spectral `dist` as if it were spatial depth; drift's z-row/gate is keyed on
real `z` alone now, never `dist`, which can't happen once the fields are
genuinely independent. **`pairCore()` itself throws** (not just the
interactive wrapper — every caller, headless included, gets the same
protection) if the input already has real 3D `z`, OR already has a `dist`
field (i.e. is already-paired output); the second guard is new alongside
the split — with `z` no longer touched by pairing, re-pairing an
already-paired result can no longer be caught as a side effect of the
z-guard the way it used to be. `runSSmlmPair()`/`unpairSSmlm()` swap
`lastResult.locs` for the paired/original set. Three
module-level variables track pairing state: `sSmlmOriginalLocs` is the TRUE
raw/unpaired backup, captured once on the first successful Pair (the same
pattern the raw-panel crop tool uses for `originalStack`) — it is also the
*authoritative pairing input*: Preview/Pair always compute from
`sSmlmOriginalLocs || lastResult.locs`, never from `lastResult.locs`
directly, since that may currently BE the already-paired subset (pairing
or previewing against an already-paired set would search for 1st-order
companions among points that no longer have any).
`sSmlmPairedLocs` is the most recent successful Pair result, replaced on
every re-Pair without touching `sSmlmOriginalLocs`. `sSmlmShowingRaw`
tracks which of the two is currently assigned to `lastResult.locs`. The
**table** module's `locTableData()` shows `dist` and `z` as independent,
optional columns (present whenever any loc has a finite value), not one
aliasing/relabelling the other. **Pair** also turns on `zcolor`
and sets `zmin`/`zmax` to the *configured* `sSmlmDistMin`/`sSmlmDistMax`
(not `rerender()`'s usual 1st–99th-percentile auto-fit) — every accepted
pair's distance is already within that window by construction, so it's the
natural colour-scale range, and it re-syncs on every Pair (e.g. after
narrowing the window post-calibration-fix).
`syncSSmlmZRangeFromDist()` keeps this live even *without* re-pairing: a
`change` listener on `sSmlmDistMin`/`sSmlmDistMax` re-applies the same
`zmin`/`zmax` assignment and calls `rerender(true)` whenever those fields
change while the paired ("spectral") view is showing — a no-op before the
first Pair, and while the "standard" (raw) view is toggled on, since
neither has a colour scale to update. A "Show spectral"/"Show standard"
button inline in the reconstruction panel title (`sSmlmColorBtn`, same
pattern as the raw panel's FTM toggle) genuinely swaps which loc set is
drawn — `lastResult.locs = sSmlmShowingRaw ? sSmlmOriginalLocs :
sSmlmPairedLocs`, plus `zcolor` set to match — not just the colour flag;
"Show standard" shows the literal unpaired reconstruction (the same data
Unpair would restore), without discarding the pairing the way Unpair does,
so toggling back to "Show spectral" is instant. Paired locs are already
`lastResult.locs` while shown, so the top-level **View data/filtering**
button works on them directly — no separate table for sSMLM. **Headless**
(v0.11.1): `config.sSmlmPair` runs pairing right after Localize, before
drift/NeNA/FRC — see §8.

### Single particle tracking (`spt`) {#spt}

Links per-frame
localizations into trajectories and computes a per-track diffusion
coefficient. A trackpy-**inspired** variant (same `search_range`/`memory`
terminology and linking philosophy as the Python `trackpy` package), not a
literal port of its source — there's no way to call real Python trackpy
from a static HTML page. Ported from the user's own `sptPALM-Python`
pipeline (L. lactis sptPALM, Martens et al., *Nat. Commun.* 10, 3552,
2019): `tracking_sptPALM.py`'s `tp.link_df(search_range=…, memory=…)`
call, and `diff_coeffs_from_tracks_fast.py`'s `diff_coeffs_per_track()`
for D. Each frame's track↔candidate bipartite graph (edges within
**SPT search range**, gated by **SPT memory** for gap-bridging) is split
into small connected clusters ("subnetworks" — trackpy's own term) and
each solved via the Hungarian/Kuhn–Munkres algorithm for the
minimum-total-squared-displacement assignment, which keeps crossing
trajectories from swapping identity in the common case — NOT trackpy's
own recursive exact-subnetwork solver for arbitrarily large ambiguous
clusters; a pathologically dense frame falls back to a faster
nearest-neighbor assignment instead (logged once), a real, documented
scope limit real single-molecule SPT data isn't expected to hit. Every
localization gets a `track_id` (even length-1 tracks); track-length
filtering happens only at the diffusion-coefficient step. **Track** is
idempotent and safe to re-run any time — it only sets/overwrites
`track_id`/`D_coeff`, never drops or replaces rows, so there's no
original-vs-tracked state to manage the way sSMLM's Pair/Unpair needs.
One D (µm²/s) is computed per track with at least **SPT min track
length** localizations, from the gap-corrected mean of ALL of that
track's own single-frame squared displacements — an average, not a
linear MSD-vs-lag-time fit, matching the reference pipeline's own
`diff_coeffs_per_track()` exactly — corrected for **SPT localization
error**: D = MSD/(4·frame time) − error²/frame time. Unlike the reference
pipeline there is no max-track-length truncation: an earlier webSMLM
version capped each track's MSD to its first N localizations for equal
per-track weighting in a length-resolved histogram, but that view isn't
built (yet), so every qualifying track's MSD now uses all of its own
steps. A near-immobile or very-short track can compute a non-positive D
(a real artifact of the localization-error correction, not a bug) —
**Track** excludes these from the plotted histogram (logging the excluded
count) rather than clamping them into one bin, which would pool unrelated
tracks into a fake spike. **Track** immediately plots a histogram of D
(log<sub>10</sub>-binned — D commonly spans orders of magnitude between
bound/slow and free/fast populations, matching the reference pipeline's
own logarithmic default) in the raw panel, reusing the table module's own
`computeHist()`/`drawHistogram()`; **Show histograms** redraws it later
without re-tracking (merges what used to be two separate buttons — see the
paragraph after the next one for the toggle that replaced the second one).
**D plot min/max** (µm²/s, defaults 0.004–10 from the
reference pipeline's own histogram range) constrain the D histogram's
own display window only — tracks outside it are excluded from the plot
the same way non-positive D is, but the logged mean/median D always cover
every qualifying track. Editing **Frame time** or **Localization error**
after **Track** has run rescales every already-computed D (D is exactly
linear in 1/frame time once the underlying per-track MSD is fixed) —
including the D shown in the table/CSV and the D histogram if it's
currently open — without needing to click **Track** again; only
**Search range**/**Memory**/**Min track length** actually change which
tracks or steps exist, so only those still require a fresh **Track**.
A toggle button next to the raw panel's own title — labelled **Diffusion**
or **Track length** (whichever the click would switch TO) — swaps between
the D histogram above and the track-length one: it plots the distribution
of every linked track's length (regardless of whether it met **SPT min
track length**) with a log-scaled count axis — track counts fall off
steeply with length, so a linear axis would flatten the useful range into
a sliver — overlaid with an exponential decay fit (a photobleaching-limited
survival model, count ~ e<sup>−L/τ</sup>) whose lifetime τ is logged and
shown on the plot in both localizations and seconds (via **Frame time** —
an approximation once **Memory** &gt; 0, since a bridged gap still counts
as one "loc" of length despite spanning more than one frame). **Show
histograms** opens on the D view by default; if a fresh **Track** run has
no track meeting **Min track length** for a D estimate, it opens on the
track-length view instead. A vertical marker shows the
CURRENT **Min track length** threshold and moves live as that field is
edited, without needing a fresh **Track** click — the underlying bars don't
move (every linked track is plotted regardless of whether it qualifies),
only the marker does. Use this histogram to judge whether **SPT min track
length** is set sensibly for a given dataset.
`track_id`/`D_coeff` become independent,
optional table/CSV columns (§5/§6) the same way sSMLM's `dist`/`sigma1st`
do, so the existing filter grammar works on tracking data for free.
Headless exposure ([§8](#8-headless-api-window-websmlm)'s
`config.sptTrack`, shipped alongside the rest of v0.11.2) runs **Track**
after drift/NeNA/FRC, not before, since a per-track D benefits from
drift-corrected coordinates and tracking never drops rows the way
sSMLM's pairing does. **Show tracks** (v0.11.7) plots a subset of tracks
directly on the **SMLM reconstruction** — a thin polyline per track, a small
filled circle marking its own start point (diameter = 2× the line
thickness, same colour as the line), and its `track_id` in white on a
semi-transparent backing box for legibility, growing larger the further you
zoom in. Magenta by default. Click a track (anywhere along its own line) to
select it — it highlights magenta in colour-by-D mode, or the same green
the raw panel's own ROI boxes use otherwise. Only tracks meeting **Min
track length** are eligible (blocking the shortest tracks relieves most of
the plotting burden on a dense dataset on its own); **Show tracks (%)**
(default 10%) then samples a further, fixed percentage of the remainder —
deterministically, via a fixed-seed PRNG draw per `track_id` (not derived
from the data), so the same dataset always shows the same track
identities at a given percentage: raising the percentage only reveals
MORE tracks rather than reshuffling which ones were already shown, and
raising **Min track length** only ever removes tracks. Line
thickness tracks the reconstruction's own effective resolution rather
than a fixed screen size — one reconstruction pixel's on-screen width at
the current zoom (`"Pixel size (nm)"/"Magnification"` nm, physically),
so tracks read thin zoomed out and more visible zoomed in, capped at 6px
(with smooth rounded turns) so zooming in a long way to inspect one
track doesn't grow it into an oversized,
spiky shape. **Colour tracks by mean D** (checked by default)
switches each track's colour to the same ramp as the **Fire (hot)**
render LUT instead, normalised against **D plot min/max** (reusing the
D-histogram's own display-range fields rather than a second min/max
pair) — a track with no qualifying D estimate draws a neutral grey, and
a colour-scale legend (centred along the panel's right edge) appears while
it's checked. Turning the overlay on also
switches the reconstruction's own colour map to **Grey**, so the tracks'
own colouring isn't visually competing with a coloured density map — the
same convention the reference pipeline's own track-visualisation figure
uses (plain grayscale background, coloured tracks on top). A toggle next
to the **SMLM reconstruction** title (**Show tracks**/**Hide
tracks**) switches the overlay on/off without re-plotting; ported from
the visual design (not the code — this is a from-scratch canvas overlay,
not a matplotlib port) of the user's own `sptPALM-Python` pipeline's
`plot_single_cell_analysis_sptPALM.py` (`plot_tracks_in_cells()`, which
colours tracks by D via matplotlib's `hot` colormap the same way) and
`plot_cells_locs_sptPALM.py` (magenta for in-track localizations).
**Show track data** (v0.11.7) opens a sortable, filterable table of the
per-track summary — see below for the filter grammar. No
length-RESOLVED D histogram (D binned by track length — distinct from the
plain track-length histogram above) yet — see `docs/REFACTOR_PLAN.md`.

**Segmentation image** (`applySegmentation`, default unchecked) is
cell-segmentation-aware tracking: checking it reveals **Load segm. image**
(loads a separate integer-labelled mask — 0 = background, 1/2/3/… = cell
number — through the same file types **Load movie** accepts, shown in the
raw panel recoloured so adjacent cells are visually distinct) and **Show
image** (re-shows the already-loaded mask without reloading the
file; opens on the segmentation image by default, with a toggle next to the
raw panel's own title — labelled **Area histogram** — to switch to a
histogram of cell areas, px, and back). `segmentedImageData` (one row per
cell: id, centre of mass in px, area in px) drives that area histogram and
**Min./Max. cell area (px)** (default 50/∞), which gate which cells'
localizations actually get tracked — a fresh **Load segm. image** sets
**Max. cell area** to the largest cell actually found in that image (a
sensible starting upper bound instead of an abstract "no limit"); re-showing
an already-loaded image does not touch it, so it won't silently overwrite a
value you've since adjusted by hand. Headless exposure ([§8](#8-headless-api-window-websmlm)'s
`config.segmentationFile`, v0.11.6) mirrors this: its mere presence switches
`config.sptTrack` to cell-by-cell tracking, same `segAreaMin`/`segAreaMax`
gating either way.

Once a segmentation image is loaded, **SMLM reconstruction**'s own panel
title gains a **Show segm.** button — swaps the panel from the usual density
reconstruction to the segmented cells (opaque, same colours as the raw-panel
view) with the SAME reconstruction drawn on top, its own black background
made highly transparent, so you can visually confirm localizations line up
with the cells before running **Track** on them (click again — now labelled
**Show recon.** — to go back). Drawn top-left aligned against the
reconstruction regardless of whether the segmentation image's own pixel
dimensions exactly match the loaded movie's — same "warn, don't block"
convention as the load-time size-mismatch warning (a genuine mismatch just
loses a thin strip at the far edge).

Localization positions never depend on Pixel size (nm) — only the scale bar
and nm readouts do (and those already update live, same as the ordinary
reconstruction). If you correct Pixel size (nm) *after* loading the
segmentation image — e.g. dialling it in until the segmented cell outlines
visually match the reconstruction's own shapes — the segmentation's on-screen
size rescales accordingly relative to the (unmoving) localizations, using the
Pixel size (nm) value at the moment the segmentation image was loaded as its
own reference: correcting it upward grows the segmentation's apparent
coverage relative to the localizations, correcting it downward shrinks it.
This reference is captured only on a genuine **Load segm. image**, not on
**Show image** re-displaying the same already-loaded image.

The reconstruction shown in this mode also floors the alpha of any pixel
with real signal, however faint — a sparse, isolated localization is only
barely non-black to begin with (every colour map starts near-black by
design), so without a floor it could end up both dim-coloured and nearly
transparent at once and effectively disappear against a bright cell colour.

With segmentation applied, **Track** (`sptCore()`'s `segCtx` path,
`linkTracksPerCell()`) links each qualifying cell's own localizations
SEPARATELY — a track can never cross a cell boundary — rather than one
whole-field-of-view `linkTracks()` pass, matching the user's own
`sptPALM-Python` pipeline's `apply_cell_segmentation_sptPALM.py`/
`tracking_sptPALM.py` (`use_segmentations` branch): a loc's `cell_id` is
its FILTERED cell membership (`-1` — matching that pipeline's own
sentinel, not `0` — for background or a cell outside the area range, never
tracked), and, only once segmentation is applied, `cell_area [px]` sits
alongside it as an optional CSV/table column, the same pattern
`track_id`/`D_coeff` already use. Each cell's own local track numbering is
offset so `track_id` stays globally unique across the whole result.

### Pipeline (`pipeline`) {#pipeline}

Top-level orchestration wiring the UI buttons to the
modules; `run()` is the Localize entry point.

### View data/filtering (`table`) {#table}

The sortable, cumulatively-filterable localizations table
("View data/filtering") and per-column histograms, see
[§5](#5-table--filter-grammar). `getBaseLocs()` is the single place that
decides whether the table's base row set is raw `lastResult.locs` or
`clusterEvents()`-derived merged events; everything downstream (render,
export, NeNA, FRC) is unaware of the distinction.

---

## 3 · Parameters (`PARAMS` registry)

Single source of truth for every analysis/render/export tunable —
`webSMLM.html`'s `params` module (`const PARAMS = {...}`, search for it
directly; this table mirrors it). `id: null` means no page control yet — only
settable via a loaded settings JSON (`paramOverrides`), the same mechanism
the headless config (`window.webSMLM.analyze(config)`, see
[§8](#8-headless-api-window-websmlm)) also uses. Deliberately excluded from this
registry: pure CSS/layout, and per-dataset working state that resets from the
loaded stack rather than being a reusable default (`calFirst`, `calLast`,
`zmin`, `zmax`).

### Memory & streaming (`in/out`) {#in-out-params}

*Module:* **in/out** — see [§2](#in-out).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `memgb` | Memory budget (GB) | number | 0.5 | 64 | 0.5 | 3 |
| `chunkmb` | Stream heap chunk (MB) | number | 50 | 2000 | 50 | 500 |

**In-app "more info…" popup** (`hint-memory` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:memory -->
<ul>
  <li><b>Budget</b> — if the decoded stack fits, keep it all in RAM; re-runs then skip decoding entirely. Beyond it, frames are decoded as the analysis reaches them and discarded (“streaming”), so memory stays bounded but re-runs re-decode.</li>
  <li><b>Heap</b> — chunk size for streaming, used only when every frame must go through the TIFF decoder. Contiguous ImageJ stacks decode one frame at a time and ignore this.</li>
</ul>
<!-- /HINT:memory -->

### Simulation settings (`simulation`) {#simulation-params}

*Module:* **simulation** — see [§2](#simulation).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `frames` | Simulated frame count | number (int) | 50 | 800 | 50 | 300 |
| `simulation_pxnm` | Simulation pixel size (nm) | number | 10 | 500 | 1 | 100 |
| `dens` | Emitter density (emitters/µm²/frame) | number | 0 | 5 | 0.01 | 0.05 |
| `phot` | Simulated photons/emitter/frame | number (int) | 0 | 50000 | 50 | 900 |
| `simlifetime` | Simulated ON lifetime (frames, mean) | number | 0.1 | 20 | 0.1 | 1 |
| `simulation_gain` | Simulation camera gain (photons/ADU) | number | 0.001 | 1000 | 0.01 | 0.34 |
| `simulation_offset` | Simulation camera offset (ADU) | number | 0 | 65535 | 1 | 100 |
| `simulation_offset_std` | Simulation offset std (ADU, per-pixel) | number | 0 | 200 | 0.5 | 3 |
| `simulation_readnoise` | Simulation read noise σ (e⁻) | number | 0 | 200 | 0.1 | 2.7 |
| `simbg` | Simulation background (photons/px) | number | 0 | 500 | 1 | 0 |
| `driftpx` | Simulated total drift (px) | number | 0 | 30 | 0.5 | 0 |

**In-app "more info…" popup** (`hint-simulation` in `webSMLM.html`; synced
by `tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:simulation -->
<p><b>Emitter density</b> is a physical areal density — the average number of ON emitters per µm² in any
given frame — independent of how densely the ground-truth structure is sampled. Emitters arrive as a
Poisson process at randomly chosen structure sites; each turns on exactly once: a fractional start time
(drawn from up to 5×lifetime before frame 0, so the exponential's tail can already be mid-event at frame 0)
and an exponentially-distributed ON duration (mean = <b>ON lifetime</b>). <b>Photons/emitter/frame</b> is
scaled by the fraction of a frame the emitter was actually on, so e.g. a half-frame overlap emits half the
photons.</p>
<p><b>Background</b> (photons/px, Poisson like the signal) is added at every pixel independently, every
frame. <b>Camera gain/offset/offset std/read noise</b>
forward-model a real sensor: Gaussian read noise (σ in electrons) is added to the photon count before the
gain conversion, then a per-pixel offset map (Gaussian around the mean offset, fixed for the whole stack)
is added — independent of the fit-side camera gain/offset used for localization. For a clean
self-consistency test with the <b>Gain/offset estimation</b> section's own readout-noise field, combine
read noise and offset std in quadrature (√(read_noise²+offset_std²), offset std converted to photons via
this panel's gain) — a static per-pixel offset pattern looks identical to read noise in a single frame's
Fourier content, so leaving it out biases the fitted offset the same way.</p>
<p><b>Drift (px, total)</b> — total sample drift over all frames, in a random direction (linear from
frame 0). 0 = none. Used to test drift correction — the true drift is stored for scoring.</p>
<!-- /HINT:simulation -->

`dens` is a **physical areal density** (ON emitters/µm²/frame), not tied to
how densely the internal ground-truth structure (`buildStructure()`) happens
to sample candidate points. Emitters arrive as a Poisson process over the
whole field of view at randomly chosen structure sites; each turns on
**exactly once** (no repeated blinking) — a fractional start time (drawn
from up to 5×`simlifetime` before frame 0, so the exponential's early tail
can already be mid-event at frame 0) and an exponentially-distributed ON
duration (mean = `simlifetime`). `phot` is per-emitter, per (fully-occupied)
frame — an emitter's actual output in a given frame scales by its overlap
fraction with that frame, so e.g. a half-frame overlap emits half `phot`.
`simbg` is a **per-pixel** rate (every pixel gets `simbg` photons of
background independently, every frame — not a total budget spread across
the frame), Poisson like the signal.

The forward **camera model** — decoupled from the fit-side `gain`/
`camoffset` (the [Export](#export-params) fields), so
simulated ground truth and the fit's assumed camera can be matched (for a
clean self-test) or intentionally mismatched (to test robustness) — applies,
per pixel, in this order: Poisson shot noise on (background + PSF signal) →
Gaussian read noise (`simulation_readnoise`, electrons) added before the
gain conversion → `simulation_gain` converts photons+read-noise to ADU → a
**fixed per-pixel offset map** (`simulation_offset` mean, `simulation_offset_std`
Gaussian spread, generated once per stack and reused every frame — modelling
real sensor fixed-pattern offset noise) is added → clamped ≥ 0.
`simulation_pxnm` is this panel's own pixel size (kept separate from the
shared `pxnm` render/load control so **Simulation settings** is
self-contained); the shared `pxnm` control is synced to it automatically
after a stack is generated, so the scale bar / a re-run config stay
consistent. Ground-truth emitter events (`x,y,tStart,tEnd,photonsTotal`) are
stored in `groundTruthEvents` for comparison against recovered
localizations. `driftpx` (as before) accumulates linearly over all frames in
a random direction; the true per-frame drift is stored (`simTrueDrift`) for
scoring drift correction. See the **simulation** module.

### Localisation settings (`detect`) {#detect-params}

*Module:* **detect** — see [§2](#detect).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `detFilter` | Detection filter | enum | — | — | — | `wave` (options: `wave`, `dog`, `box`) |
| `detection_wavelet_thr` | Wavelet threshold (k·σ_noise) | number | 1 | 8 | 0.5 | 4 |
| `detection_DoG_thr` | DoG threshold (k·σ_noise) | number | 1 | 8 | 0.5 | 4 |
| `detection_box_thr` | Uniform box filter threshold (intensity) | number | 0 | 65535 | 1 | 25 |
| `detection_DoG_exactbp` | Exact band-pass (DoG only) | bool | — | — | — | false |
| `psf` | σ_PSF — PSF width (px) | number | 0.8 | 5 | 0.1 | 1.3 |
| `winr` | Fit radius (px) — window size = 2·winr+1 | number (int) | 2 | 10 | 1 | 4 |

The in-app "more info…" popup for these fields (`hint-detectfit`) is shared
with **Fit** below — one popup covers `liveUpdate` through `winr` as a
single control group in the sidebar.

### Localisation settings (`fit`) {#fit-params}

*Module:* **fit** — see [§2](#fit).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `method` | Fit method | enum | — | — | — | `gaussmle` (options: `phasor`, `phasor3d`, `gaussls`, `gaussmle`, `mle3d`, `gaussmleEll` — UI labels "Phasor 2D", "Phasor 3D", "Gaussian LS 2D", "Gauss MLE 2D spherical", "Gauss MLE 3D elliptical", "Gauss MLE 3D rotated elliptical") |
| `localize3D` | 3D localisation? | bool | — | — | — | true (only shown/meaningful for `mle3d`/`gaussmleEll` — see §2/fit) |
| `fitFirstFrame` | First frame (1-based, inclusive) | number (int) | 1 | — | 1 | 1 |
| `fitLastFrame` | Last frame (1-based, inclusive) | number (int) | 1 | — | 1 | `Infinity` (blank field — see below) |
| `mleEps` | MLE convergence tolerance (px) | number | 1e-6 | 0.1 | 0.0001 | 0.001 |
| `ftmEnabled` | Temporal median filtering | bool | — | — | — | false |
| `ftmWindow` | Window size | number (int) | 3 | 2000 | 1 | 50 |

**In-app "more info…" popup** (`hint-detectfit` in `webSMLM.html`, shared
with **Detect** above; synced by `tools/sync_hints.mjs` — edit here, then
run the script, never edit the `.hint` div directly):

<!-- HINT:detectfit -->
<p><b>Fit method</b> — σ_noise below is the spread of the filtered image, not the PSF width.</p>
<ul>
  <li><b>Phasor 2D/3D</b> — ~100–250× faster per candidate (265× on the GATTA-PAINT test stack). No per-localization uncertainty; 3D needs a phasor-magnitude calibration.</li>
  <li><b>Gaussian LS 2D</b> — ordinary least-squares; ≈ slightly better precision than phasor, much slower.</li>
  <li><b>Gauss MLE 2D spherical</b> (default) — Poisson-optimal, one symmetric σ, reports a real CRLB uncertainty; cost ≈ LS.</li>
  <li><b>Gauss MLE 3D elliptical</b> / <b>Gauss MLE 3D rotated elliptical</b> — independent σx/σy (axis-aligned, or at a rotation angle) instead of one symmetric σ; see <b>3D localisation?</b> below.</li>
</ul>
<p><b>3D localisation?</b> (only shown for the two elliptical methods above) — <b>checked</b> (default): a free rotation angle recovered per emitter, plus z from a loaded calibration, same as MLE 3D. <b>Unchecked</b>: a calibration-free fit with no z — for MLE 3D elliptical this is a plain 2D elliptical fit; for the rotated method the angle is instead fixed to the sSMLM pairing step's own dispersion bearing (Spectral SMLM analysis → Primary angle).</p>
<p><b>Detection filter</b> — Wavelet and DoG both band-pass the frame (suppress smooth background, enhance PSF-sized spots); candidates are strict local maxima above <b>k·σ_noise</b>. The three filters respond very differently, so <b>re-tune the threshold</b> when switching between them.</p>
<ul>
  <li><b>Wavelet (B-spline)</b> (default) — the à trous cubic-B-spline wavelet used by ThunderSTORM: no σ (scale is fixed by the wavelet levels), roughly 2× faster to filter, and the recommended choice.</li>
  <li><b>DoG band-pass</b> — a difference of Gaussians whose scale is tuned by σ_PSF; its <b>Exact band-pass</b> option replaces the fast box approximation of the background with a true Gaussian (~2× slower, but exactly reproducible — on the GATTA-PAINT test stack it changes 0.38% of detections).</li>
  <li><b>Uniform box filter</b> — a difference of two box (uniform) averages sized off σ_PSF, following Huang, Schwartz, Byars &amp; Lidke (2011); unlike the other two it thresholds on a plain <b>intensity</b> value, not k·σ_noise, so its default (25) needs re-tuning to your camera's counts.</li>
</ul>
<p><b>Temporal median filtering</b> (FTM) is a per-pixel background correction — for a given frame, each pixel's value across a <b>window</b> of nearby frames (centred on that frame; clamped, not shrunk, at the very first/last few frames, so every frame still gets a full-width window) has its <b>median</b> subtracted — a robust estimate of that pixel's slowly-varying background at this point in time. Since a blinking emitter occupies far less than half the window at any one pixel, the median tracks the background, not the signal, so what's left after subtraction is mostly signal above background. Checking this box:</p>
<ul>
  <li>Adds a <b>raw / FTM-corrected</b> toggle next to the raw panel title, computing the correction live for whichever frame you're scrubbed to.</li>
  <li>Makes <b>Localize itself run on FTM-corrected frames</b> — processed in worker-parallel chunks when a worker pool is available, main-thread otherwise; either way the whole stack is never held twice (raw + corrected) in memory at once.</li>
</ul>
<p><b>Values that would go negative after subtraction are floored at the camera offset instead</b> (a background estimate briefly above the true noise floor is expected, not an error) — this keeps the corrected pixel in the same units the fit's own gain/offset conversion expects, so photon counts aren't double-corrected. It's still <i>not</i> quite the same noise distribution the fit functions otherwise assume (Poisson-MLE in particular models a Poisson-distributed background around some positive mean; a hard floor truncates that slightly, which can bias fitted background/photon counts and reported uncertainty low in very dim regions). Choose the <b>window size</b> so the "signal occupies less than half the window" assumption above actually holds for your data (too small and the median starts tracking — and cancelling — real signal); the loaded stack must have at least that many frames.</p>
<p><small>The technique originates with
<a href="https://doi.org/10.1038/nmeth.2448" target="_blank" rel="noopener">Nieuwenhuizen et al.,
<i>Nat. Methods</i> 10, 557–562 (2013)</a>; ported here from the Hohlbein Lab's own newer
implementation, <a href="https://github.com/HohlbeinLab/FTM2" target="_blank" rel="noopener">FTM2</a>
(<a href="https://doi.org/10.1098/rsta.2020.0164" target="_blank" rel="noopener">Jabermoradi et al.,
<i>Phil. Trans. R. Soc. A</i> 380(2220), 20200164, 2022</a>).</small></p>
<!-- /HINT:detectfit -->

`fitLastFrame` defaults to `Infinity`, not a finite placeholder: an
`<input type=number>` sanitizes a non-finite value to a blank field, and a
blank field reads back (via `paramValue()`'s `isFinite` fallback) as "the
whole stack" — so if `initScrub()`'s per-load reset were ever skipped, or a
user manually clears the field, the safe fallback is no restriction, never a
silent restriction down to (near-)nothing. Both fields reset to `1`/the
loaded stack's frame count on every new load. Restricting the range means
the skipped frames are never even fetched/decoded, not just excluded from
the result afterward — see the **pipeline** module / `runCore()`.

**`ftmEnabled`/`ftmWindow` — temporal median filtering (FTM)** — see the
popup above for what checking it does (the raw/FTM-corrected toggle,
`rawFtmBtn`, and Localize itself running on corrected frames). Both share
the same underlying correction: for a given frame, each
pixel's value across a `ftmWindow`-frame window of context (centred on that
frame; clamped, not shrunk, at the two ends of the stack, so every frame
still gets a full-width window) has its **median** subtracted, then
**floored at `camoffset`** (not 0) and has `camoffset` added back — see
"gain/camoffset interaction" below for why. Requires the loaded stack to
have at least `ftmWindow` frames — falls back to raw data, with a logged
warning, otherwise. Can be checked at any time — before, during, or after
loading a stack — with no load-time coupling.

An earlier design ran this once over the *whole* stack right after loading
and replaced `stack` itself; it was reverted because it needed the raw and
corrected copies fully materialized in memory at the same time, which
doesn't work for a stack too big to hold both — see
`docs/REFACTOR_PLAN.md`. Both current paths avoid that by never holding
more than a bounded amount of raw/corrected data at once:

- **Scrubbing preview** (`ftmFrame()`/`ftmFrameParallel()`) computes exactly
  one frame at a time, fetching only that frame's own `ftmWindow`-wide
  context. Parallelizes **spatially** across the worker pool (row bands, no
  overlap/border margin needed, since each pixel's computation depends only
  on its own value across the context window, never on neighbouring
  pixels). Measured (500-frame synthetic stacks, window 50, 8 workers): ~23
  ms at 128×128, ~35 ms at 256×256, ~130 ms at 512×512, ~510 ms at
  1024×1024 — fine for occasional scrubbing at smaller frame sizes, but
  noticeably laggy for rapid dragging on large frames. `showFrame()`
  substitutes the corrected frame in place of the raw one (via
  `rawFtmView`, the toggle's on/off state) before running the same
  detect/live-preview logic every other branch already uses — ROI boxes
  and live-fit crosshairs on the corrected preview reflect it too. The raw
  panel **title stays fixed at "Raw frame"** regardless of the toggle
  state — only the button's own label changes; unchecking `ftmEnabled`
  hides the button and resets the toggle back to raw.
- **Localize** processes the stack in **chunks**, sized from the
  `chunkmb` "Stream heap chunk" budget (half of it, since a chunk's raw
  context and corrected output are both resident at once) rather than a
  fixed constant, so chunking scales with frame size and the user's own
  memory tuning. Two implementations share the same per-pixel sliding-
  window median algorithm (`ftmSeriesGlobal` — O(window) per step, not a
  full resort), chosen by whether `runCore()` is using the worker pool at
  all for this Run:
  - **No worker pool** (`makeFtmStack()`): wraps the stack so its existing
    serial frame-fetch calls transparently receive FTM-corrected data,
    chunked and cached so a run of nearby requests is served from one
    chunk computation instead of redundantly re-fetching/re-sorting
    nearly the same context each time. Runs on the main thread — nothing
    else is contending for it in this path.
  - **Worker pool in use**: a dedicated **barrier-phased loop** inside
    `runCore()`, alternating a full-pool-parallel **FTM-correction phase**
    (`ftmChunkParallel()`, row-band split, same reasoning as the scrubbing
    preview) with a full-pool-parallel **detect/fit phase** (the same
    frame-batch dispatch the non-FTM path uses) for each chunk in turn,
    with a hard barrier between the two phases on every chunk — the pool
    is never asked to do both jobs at once. This matters because each
    worker has exactly **one** `onmessage` slot, not a job queue: without
    the barrier, an FTM-correction reply and a detect/fit reply could
    clobber each other's handler mid-flight. An earlier version ran chunk
    correction unconditionally on the main thread (to sidestep that
    conflict without a barrier) — measured as the dominant cost on a fast
    fitter with large frames (~7.5 s FTM vs. ~5.4 s total detect/fit CPU
    on a 256×256×1200 case, 8% worker utilisation). The barrier-phased
    design gets full parallelism for both phases instead, at the cost of
    losing the small pipelining overlap ("fetch/correct the next chunk"
    while "fitting the previous one") the non-FTM continuous-dispatch
    loop gets for free — benchmark-confirmed small next to what
    parallelizing the FTM phase itself buys back.

  Both implementations need to fetch a *little* more context than
  `±ftmWindow/2` around a chunk's core frames whenever that chunk's core
  range comes close enough to either end of the **whole stack** (not the
  Run's own `fitFirstFrame`/`fitLastFrame` range) that a frame's own
  window would otherwise be clamped further than the chunk's own edge
  padding accounts for — the same per-frame clamp `ftmSeriesGlobal`
  applies internally, just computed once for the chunk's own worst-case
  frame instead of the chunk's own start/end. Getting this wrong doesn't
  crash or obviously misbehave — it silently starves the last few frames
  of a stack of part of their correct background window, biasing their
  photon counts by a few percent — so a barrier-phased-worker-vs-serial
  A/B correctness check (not eyeballing loc counts, which stayed close)
  is what caught it.

  **Memory**: `chunkmb`'s `/2` split assumes only a chunk's raw context and
  corrected output need to coexist — true for the FTM-correction phase
  itself, but the barrier-phased worker loop used to keep the (by then dead)
  context array reachable through the *following* detect/fit dispatch phase
  too (same `while`-loop iteration/closure), which has its own separate
  memory cost (structured-clone `postMessage` per batch) — so real peak
  memory could run over the intended `chunkmb` budget for the back half of
  every chunk. Root cause of a real mobile OOM at `chunkmb=1000` (§3's
  default moved back to 500 after this was found); fixed by dropping the
  context reference the moment the corrected output is in hand, before the
  detect/fit phase's own allocations start. `runCore()` also logs an
  estimated peak-memory figure right after the chunk-size line (`~chunkmb`
  MB for FTM's own working set, plus the already-decoded stack's size if
  `memgb` let the whole thing cache in RAM — a **separate** budget that
  adds on top of `chunkmb`, not a shared ceiling with it) with an advisory
  above ~800 MB combined — gated on `memgb` staying at/below 8 GB (its old
  ceiling before [§3](#3-parameters-params-registry) raised the max to 64 GB
  for workstation-scale caching), so a desktop user who's deliberately raised
  it isn't nagged every Run once they've already said they have headroom.
  This is visibility only, not prevention: a mobile tab killed for memory
  pressure gets **no** JS-visible error at all (no exception, no `onerror`,
  the page just reloads blank) — there is no reliable way to detect or head
  off an OOM kill from inside the page, only to avoid approaching the
  ceiling in the first place and explain what happened when a Run
  mysteriously stops with no further log line.

Runs on raw ADU data in both paths, before gain/camoffset conversion
inside the fit functions. Those functions convert every pixel via
`(raw−camoffset)×gain`; since FTM-corrected pixels are *already*
background-subtracted, floor-at-0 would let that conversion subtract
`camoffset` a **second** time, systematically undercounting photons by
`camoffset×gain`. Flooring/re-adding `camoffset` instead (see above)
makes the fit's own `−camoffset` cancel back out, leaving just `×gain` on
the true signal-above-background — floored at 0 in photon space, same as
intended. The floor is still not quite the same noise distribution the
Poisson-MLE fitters otherwise assume (which models a Poisson-distributed
background around some *positive* mean), which can bias fitted
background/photon counts and reported uncertainty low in very dim
regions.

**Log output**: when FTM is active, a Run's log gains a
`Temporal median filtering ON (window=N) — Localize runs on FTM-corrected
frames.` line up front, and the timing breakdown gains an `FTM filter` line
— wall time spent computing chunks, not time spent waiting on another
already-in-flight chunk (serial path) or on the barrier-phased pool
(worker path) — alongside `frame access`/`detect`/`fit`, also returned as
`timings.ftmMs` from `runCore()`. In the worker path, the `↑ N workers ·
X% utilisation` line covers the detect/fit phase only (its wall-clock
denominator excludes the separately barrier-phased FTM stage, which is
reported on its own line instead) — folding the two together would make a
run with substantial FTM time look artificially starved.

### Gain & offset estimation (PCFO) (`fit`) {#pcfo-params}

*Module:* **fit** — see [§2](#fit).

Sidebar section label: **Gain & offset estimation**.

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `pcfoFrames` | Frames sampled | number (int) | 1 | 5000 | 10 | 200 |
| `pcfoK` | k_thresh (spatial freq.) | number | 0.1 | 1 | 0.05 | 0.9 |
| `pcfoRnstd` | Readout noise σ (e⁻) | number | 0 | 200 | 0.01 | 2.89 |

**In-app "more info…" popup** (`hint-pcfo` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:pcfo -->
<p>Estimates camera gain (photons/ADU) and offset (ADU) directly from the loaded stack via the
Rieger–Heintzman photon-conversion-factor method (PCFO; Heintzmann, Relich, Nieuwenhuizen, Lidke &amp;
Rieger, <a href="https://arxiv.org/abs/1611.05654" target="_blank" rel="noopener">arXiv:1611.05654</a>) —
no separate calibration acquisition needed. Tiles a sample of frames, measures mean signal vs.
high-spatial-frequency (noise-only) variance per tile, and fits gain/offset by linear regression, and
draws a diagnostic signal-vs-noise-variance scatter + fitted line (R²) on the raw panel so the underlying
linearity assumption can be checked visually rather than trusted blindly. <b>Estimate</b> only computes —
it doesn't touch the Gain / Camera offset fields in Localisation settings itself; <b>Transfer estimates</b>
(disabled until a successful Estimate) copies the last result into them.</p>
<ul>
  <li><b>Frames sampled</b> — how many seeded-random frames to average over.</li>
  <li><b>k_thresh</b> — spatial-frequency cutoff (fraction of Nyquist) above which content is assumed
  noise-only; 0.9 follows the Rieger–Heintzman default.</li>
  <li><b>Readout noise σ</b> — camera dark-frame std, in electrons; set to 0 if unknown/negligible. Must
  include ANY spatially-white, frame-invariant noise, not just true per-frame read noise — a static
  per-pixel offset pattern (fixed-pattern noise) looks identical to read noise in a single frame's
  Fourier content, so it biases the fitted offset the same way if left out. If both are present, combine
  them in quadrature (√(read_noise²+offset_std²), in photon-equivalent units); the default (2.89) matches
  the Simulation panel's own default read noise (2.7 e⁻) and per-pixel offset std (3 ADU) combined this
  way, for a clean self-test.</li>
</ul>
<p>Tile size isn't a setting — it's chosen automatically from the field of view (aiming for a ~4×4 grid,
rounded to a power of two since the noise-variance estimate needs an FFT, floored at 64px, and never below
2×2) so there's nothing to re-tune per stack.</p>
<!-- /HINT:pcfo -->

Implementation detail beyond the popup above: tiles are pooled and robustly
outlier-clipped (Tukey fences on `noisevar`, `pcfoClipPoints()` — a single
dead/saturated/masked tile can otherwise dominate an ordinary least-squares
fit) before a plain OLS linear regression (`pcfoRegress()`): the slope gives
gain, the intercept (combined with `pcfoRnstd`) gives offset. A leave-one-out
jackknife over the pooled points gives a rough ± uncertainty on both. The
diagnostic scatter (`drawPcfoPlot()`, the same left-panel-plot pattern as
calibration/FRC/NeNA curves) logs a low-linearity warning when R² < 0.3 (too
low a photon count is the most common cause; saturation, non-uniform
illumination or non-Poissonian noise are less common ones). Noise variance
(ADU²) commonly runs into the hundreds of thousands, where full tick labels
used to visually collide with the axis's own rotated name; both axes scale
into small (1 digit + 1 decimal) numbers plus a single `×10ⁿ` multiplier
instead (`axisScale()`, render module — see **render** in `CLAUDE.md`). See
the **fit** module (`pcfoCore()`) and
[§8](#8-headless-api-window-websmlm) (`config.estimateGainOffset`) for the
headless equivalent.

### Rendering settings (`render`) {#render-params}

*Module:* **render** — see [§2](#render).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `pxnm` | Pixel size (nm) | number | 1 | 2000 | 1 | 100 |
| `mag` | Magnification | number (int) | 4 | 25 | 1 | 10 |
| `rblur` | Render blur σ_render (px) | number | 0 | 1 | 0.05 | 0.25 |
| `lut` | Colour map | enum | — | — | — | `fire` (options: `fire`, `inferno`, `viridis`, `turbo`, `hsvBlue`, `grey`) |
| `lutpct` | Display max percentile | enum | — | — | — | `99.9` (options: `99.9`, `99.5`, `99`, `100`) |
| `zcolor` | Colour by depth (z) | bool | — | — | — | false |

**In-app "more info…" popup** (`hint-render` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:render -->
<ul>
  <li><b>Colour map</b> — Inferno/Viridis are perceptually uniform; Fire is the classic SMLM look.</li>
  <li><b>Display max</b> clips the brightest pixels so a single hot spot can't dim the rest.</li>
  <li><b>Colour by depth (z)</b> (3D results) sets each pixel's hue from the mean z and its brightness from density; <b>z min / z max</b> set the colour range and render anything outside it black — narrow the window to optically section through the volume. After an sSMLM <b>Pair</b>, this same toggle reads "Colour by distance (sSMLM)" and colours by inter-order spectral distance instead of real z.</li>
</ul>
<p>All render settings apply instantly — no refit. Scroll/pinch to zoom, drag to pan, double-click/tap to reset.</p>
<!-- /HINT:render -->

`hsvBlue` is a closed-loop full HSV hue cycle (240°, blue → cyan → green →
yellow → red → magenta → violet → 240° again, saturation/value pinned to 1)
matching a colour scheme used in the sSMLM paper's own figures — the only
cyclic map here, so the two ends of the mapped range deliberately land on
the same hue rather than two different ones; **Pair** (see **sSMLM**)
auto-selects it. The on-canvas colour-scale strip (`drawDepthBar()`) anchors
to the actual DATA's own right edge and vertical centre rather than a fixed
canvas corner — sSMLM's paired result usually only plots a sparse subset of
the full field of view, so a fixed corner could leave the bar floating in
empty space, disconnected from the content it's meant to label. The extent
is cached once per render (`srFull._locMaxXpx`/`_locMidYpx`, in native px)
and converted through the current zoom/pan on each draw, rather than
rescanning every localization on every pan/zoom redraw; falls back to the
bare top-right corner if there's no cached extent (e.g. a plot, not a real
reconstruction).

### Localisation settings (`export`) {#export-params}

Camera ADU→photon conversion fields specifically.

*Module:* **export** — see [§2](#export).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `gain` | Camera gain (photons/ADU) | number | 0.001 | 1000 | 0.01 | 1 |
| `camoffset` | Camera offset (ADU) | number | 0 | 65535 | 1 | 0 |

**In-app "more info…" popup** (`hint-export` in `webSMLM.html`, shown
alongside `pxnm` — see **Render** above — since all three sit together in
the sidebar's Localisation settings; synced by `tools/sync_hints.mjs` —
edit here, then run the script, never edit the `.hint` div directly):

<!-- HINT:export -->
<ul>
  <li><b>Pixel size (nm)</b> sets the physical scale used by the scale bar, z, and the exported CSV coordinates.</li>
  <li>With gain 1 the exported “intensity [photon]” is really <b>ADU</b> (analog-to-digital unit — the camera's raw pixel count, before any photon conversion), and the uncertainty column (∝ 1/√N) is not physically meaningful.</li>
  <li>A single scalar gain suits <b>EMCCD</b>; on <b>sCMOS</b> gain, offset and read noise vary per pixel, so a scalar is only an approximation — see <code>docs/REFACTOR_PLAN.md</code>.</li>
</ul>
<!-- /HINT:export -->

Applied inside every fit function itself — `(raw−camoffset)×gain` — before
the pixel is used, so `photons`/`bg`/`bgstd` downstream (table, CSV, MLE's
CRLB) are already true photon units. See the **fit** module.

### Worker dispatch (`workers`) {#workers-params}

No page control — settings-JSON only.

*Module:* **workers** — see [§2](#workers).

| id | Label | Min | Max | Step | Default |
|---|---|---|---|---|---|
| `workerMinFrames` | Minimum frame count before parallelizing | 1 | — | 1 | 64 |
| `workerMinPxFrame` | Minimum pixels/frame before parallelizing | 1 | — | 1000 | 20000 |
| `workerMinTotalPx` | Minimum total volume (px) before parallelizing | 1 | — | 1,000,000 | 30,000,000 |
| `workerBatchTarget` | Target batches per worker | 1 | 64 | 1 | 24 |
| `workerBatchMin` | Minimum batch size (frames) | 1 | 256 | 1 | 8 |
| `workerBatchMax` | Maximum batch size (frames) | 1 | 1024 | 1 | 32 |

Dispatch condition: `frames ≥ workerMinFrames AND (pixels/frame ≥
workerMinPxFrame OR total pixels ≥ workerMinTotalPx)` — `workerMinFrames` is
a hard floor (short stacks always stay single-threaded, not worth the
overhead), while the per-frame-size and total-volume checks are an *or*, so
a many-small-frame stack (e.g. thousands of 64×64 frames) still parallelizes
via the volume threshold even though no single frame crosses the per-frame
one. See the **workers** module.

`workerBatchTarget`/`workerBatchMax` also bound how often the raw-panel live
preview can refresh during a worker-parallel Run: a batch's fit results only
become available once the whole batch completes, so batch size is a hard
floor on preview freshness independent of `rawPreviewMs` below.

### 3D calibration (`3D calibration`) {#3d-calibration-params}

*Module:* **3D calibration** — see [§2](#3d-calibration).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `calStep` | Calibration z-step (nm) | number | 0.1 | — | 1 | 10 |
| `calRef` | Calibration z=0 reference frame (0=auto) | number (int) | 0 | — | 1 | 0 |
| `calFixedXY` | Fix bead x,y | bool | — | — | — | false |

**In-app "more info…" popup** (`hint-calibration` in `webSMLM.html`; synced
by `tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:calibration -->
<p>Load a bead z-stack (stage scanned through focus). Uses the detection settings above. Crop the range to ~±500 nm around focus for a good fit.</p>
<ul>
  <li>Detects every spot per frame.</li>
  <li>Fits an elliptical Gaussian → σ_x / σ_y vs z.</li>
  <li>Fits σ = a(z−c)² + b to each axis.</li>
</ul>
<p><b>Fix bead x,y</b> — at large defocus the PSF can flatten, ring or split into two maxima, so per-frame detection can jitter or mis-pick the centre and corrupt the width curve. Ticking this:</p>
<ul>
  <li>Averages every frame in the range into one composite (shown in the raw panel).</li>
  <li>Runs detection once on that stable image, fixing each bead's x,y from it — re-run automatically whenever the range, threshold, σ_PSF, fit radius or filter changes.</li>
  <li>Calibrate then only fits amplitude/σx/σy/background per frame at those fixed positions, so x,y — the two most failure-prone degrees of freedom — never move.</li>
</ul>
<!-- /HINT:calibration -->

### Drift correction (AIM) (`drift`) {#drift-params}

*Module:* **drift** — see [§2](#drift).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `driftSeg` | Drift segment size (frames) | number (int) | 5 | 2000 | 5 | 100 |
| `driftRoi` | Drift search radius (nm) | number | 10 | 1000 | 10 | 120 |
| `driftZ` | Correct z too (3D) | bool | — | — | — | true |

**In-app "more info…" popup** (`hint-drift` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:drift -->
<p>Point-based drift correction — adaptive intersection maximization (AIM; Ma et al., <i>Sci. Adv.</i> 2024, after <code>picasso/aim.py</code>; see <a href="https://websmlm.readthedocs.io/en/latest/content/09-references-further-reading.html" target="_blank" rel="noopener">References &amp; further reading</a>). <b>Localize first, then Correct drift.</b></p>
<ul>
  <li>The search radius must exceed the drift <b>increment per segment</b> — shrink the segment for faster drift.</li>
  <li>Each run re-estimates from the raw localisations, so segment size / search radius can be swept and compared.</li>
  <li>Corrected coordinates are used by the render and CSV; the raw coordinates are kept.</li>
  <li><b>Show drift</b> plots drift vs. frame by default; a small toggle in the raw panel's own title bar ("Show x/y path") switches to a single x/y trajectory instead, coloured by frame (time) using the current reconstruction colour map.</li>
</ul>
<!-- /HINT:drift -->

### Localization precision (NeNA & FRC) (`locprecision`) {#locprecision-params}

*Module:* **locprecision** — see [§2](#locprecision).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `frc3d` | 3D shells (FSC) | bool | — | — | — | false (not yet implemented — UI placeholder) |

**In-app "more info…" popup** (`hint-locprecision` in `webSMLM.html`; synced
by `tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:locprecision -->
<ul>
  <li><b>NeNA</b> estimates the mean per-localization precision from the nearest-neighbour distance distribution — data-driven, and the honest single number for the phasor fit (which has no per-localization uncertainty). It assumes the labelled structure is <b>static</b>: consecutive-frame displacements must be localization error, not motion. A <b>diffusing probe</b> — e.g. Nile Red and similar solvatochromic dyes that partition into and move within membranes — adds diffusion to the distance and <b>inflates σ</b>. Fixed-target methods like <b>DNA-PAINT</b> (imager binding a static docking strand, as in the GATTAquant nanorulers) satisfy the assumption.</li>
  <li><b>FRC</b> reports image resolution at the <b>1/7</b> threshold by splitting the localisations into two independent halves (odd/even frames), rendering each and correlating over Fourier rings; <b>FSC</b> is the 3D shell version, once z exists.</li>
</ul>
<p>FRC folds in labelling density and drift while NeNA does not, so reporting both is diagnostic (they disagree when drift remains). Results go to the Log — run localisations first.</p>
<p><i>NeNA and FRC are new in 0.8.0 and still <b>experimental</b> — cross-check against established tools before relying on the numbers; FSC 3D is not yet implemented.</i></p>
<!-- /HINT:locprecision -->

### Spectral SMLM analysis (`sSMLM`) {#ssmlm-params}

Spectrally resolved SMLM, diffraction-grating pair finding.

*Module:* **sSMLM** — see [§2](#ssmlm).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `sSmlmDistMin` | sSMLM pair distance min (nm) | number | 0 | 20000 | 50 | 2200 |
| `sSmlmDistMax` | sSMLM pair distance max (nm) | number | 0 | 20000 | 50 | 2800 |
| `sSmlmAngleCenter` | sSMLM pair primary angle (deg) | number | -180 | 180 | 1 | 0 |
| `sSmlmAngleTol` | sSMLM pair angle tolerance (± deg) | number | 0 | 90 | 1 | 5 |
| `sSmlmRequireNarrower` | Require narrower 0th order (σ) | bool | — | — | — | false |

**In-app "more info…" popup** (`hint-sSMLM` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:sSMLM -->
<p>Pairs 0th/1st-order localizations from a diffraction grating placed in the emission path — each emitter appears twice per frame, offset by a wavelength-dependent distance at a <b>fixed, known bearing</b> (not just orientation — <b>Primary angle</b> is a genuine direction, e.g. 0° always means the 1st order sits to the same side of every 0th order in the image). A point qualifies as a 0th order only if it has a candidate on that bearing AND no candidate on the opposite bearing (which would mean it's more likely someone else's 1st order) — this needs no brightness signal, since real data shows brightness alone doesn't reliably tell 0th from 1st order here. The paired position is the <b>0th order's own</b> — undispersed, so its centroid is the true emitter position — not the midpoint between the two (that would blur position by up to half the per-emitter spectral offset). The inter-order distance is stored in its own <b>dist</b> field (never <b>z</b> — kept independent so a future 3D-fit result could carry real depth and spectral distance at once), so the depth-coding render option (Rendering settings → Colour by depth/distance) shows it directly as a wavelength proxy with no other change needed. Localizations that don't find an unambiguous pair within the window are dropped from the result entirely.</p>
<p>Localizing with <b>Gauss MLE 3D rotated elliptical</b> first (Fit method, above — <b>3D localisation?</b> unchecked fixes its angle to Primary angle below, exactly this section's own bearing) gives BOTH orders a genuine per-axis σx/σy after <b>Pair</b>, instead of the single symmetric-σ proxy (<code>sigma1st</code>) every other method reports for the spectrally-smeared 1st order.</p>
<p><b>Preview pairs</b> only computes — <b>Show histograms</b> draws them: a distance histogram (every candidate pair in range, any angle) by default, or an angle histogram restricted to the current distance window via the toggle next to the raw panel's own title (labelled <b>Distances</b>/<b>Angles</b>, whichever it would switch to), so you can find your own setup's true peak instead of guessing. Both histograms are accumulated across ALL frames (only same-frame localizations are ever compared to each other — the accumulation just pools every frame's own candidates into one plot). Narrow <b>Distance min/max</b> and <b>Primary angle</b>/<b>tolerance</b> to that peak, then click <b>Pair</b> to commit — or click <b>Fit angle &amp; tol.</b> to fill Primary angle/Angle tolerance in automatically from the angle histogram's peak (its half-max width), a conservative starting point you can widen by hand.</p>
<p><b>Pair</b> replaces the current localizations with one row per accepted pair (refuses if the current result already has real 3D <b>z</b> from an astigmatic fit method, or is already-paired output). <b>Unpair</b> restores the original, unpaired localizations.</p>
<p><b>Require narrower 0th order (σ)</b> is an optional extra confidence gate: the 0th order is undispersed while the 1st is spectrally smeared, so it tends to have the narrower PSF — but only ~65–70% reliably on real data, so this is off by default rather than required.</p>
<p><i>2-point pairs only (0th+1st) for now — multi-order chaining is not yet implemented, see <code>docs/REFACTOR_PLAN.md</code>.</i> Ported from <a href="https://github.com/HohlbeinLab/sSMLMAnalyzer" target="_blank" rel="noopener">HohlbeinLab/sSMLMAnalyzer</a> — see <a href="https://websmlm.readthedocs.io/en/latest/content/09-references-further-reading.html" target="_blank" rel="noopener">References &amp; further reading</a>.</p>
<!-- /HINT:sSMLM -->

`sSmlmAngleCenter` ("Primary angle" in the UI) is a genuine SIGNED bearing
(the 1st order's fixed direction from its 0th order), not an undirected
line — see §2's **sSMLM** entry for why. The distance/angle defaults match
the deposited reference dataset's own grating dispersion
(`experimental_data/sSMLM_Fig2_locs.csv`) — a different setup's dispersion
sits elsewhere, so don't trust these blind. **Preview pairs** fetches
candidates over a WIDE, fixed scan — distance 0–6000 nm (wider still if
Distance max is already past that) at any angle — ignoring the
Distance/Angle fields entirely, reusing the table module's own
`computeHist()`/`drawHistogram()` (fed candidate values instead of a table
column). **Show histograms** (one button, merging what used to be two —
a toggle next to the raw panel's own title, labelled **Distances** or
**Angles**, switches between the two views; **Distances** shown first)
plots the full wide scan with the *currently configured* Distance min/max
overlaid as vertical reference lines (read live, so editing the fields
and re-clicking moves the lines without a fresh Preview) — showing the
whole distance picture, not just whatever's inside the window, makes it
visible whether the window is actually sitting on the real peak. The
**Angles** view, by contrast, *does* restrict to the currently configured
distance window (also read
live) — the angle signal is only sharp within the real peak, so pooling
in the wide scan's off-peak distances would just dilute it with
background — and plots each candidate's bearing AND its exact reverse
(`rawAngle`/`rawAngle+180`, both wrapped into a 360°-window centred 90°
away from `sSmlmAngleCenter` so neither the forward nor the backward peak
sits at the plot's own seam): a candidate's *raw* single bearing depends
on which of its two points happens to have the smaller array index, an
accident of row order that (verified against the real reference CSV) is
not evenly split and would otherwise make the two peaks look wildly,
misleadingly unequal; plotting both directions makes them come out equal,
as an undirected diagnostic should. Both histograms accumulate same-frame
candidates across every frame in the stack (never cross-frame pairs) —
one pooled plot, not one frame's worth. **Fit angle & tol.** estimates
Primary angle/Angle tolerance directly from that same distance-windowed,
doubled-bearing data: peak-bin detection (2° bins) + half-max-width walk,
DOUBLED as a safety margin (the raw half-max width alone measured ~1° on
the real reference dataset, vs. the ~5° that actually worked well by
hand), then fills both fields in — a simple, defensible estimate (not a
full Gaussian fit, matching the bar this app's other auxiliary estimates
like PCFO/NeNA set), still usually conservative, meant as a starting point
you can widen further by hand rather than a final answer. Both histograms
also overlay the currently configured window as vertical marker lines —
distance min/max on the distance histogram, primary angle ± tolerance
(mirrored onto both plotted peaks) on the angle one — and refresh live as
you edit any of the four fields while that histogram is on screen (or
immediately after clicking **Fit angle & tol.**), no manual re-click
needed. Narrow these fields (by hand or via the fit) to the real peak,
then commit with **Pair**. See
[§2](#2-module-reference)'s **sSMLM** entry for the full pairing algorithm
and why this workflow — rather than automatic angle detection — was chosen
for the first implementation.

### Single particle tracking (`spt`) {#spt-params}

*Module:* **spt** — see [§2](#spt).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `sptSearchRange` | SPT search range (nm) | number | 10 | 5000 | 10 | 800 |
| `sptMemory` | SPT memory (frames) | number (int) | 0 | 20 | 1 | 0 |
| `sptFrameTime` | SPT frame time (s) | number | 0.0001 | 10 | 0.001 | 0.01 |
| `sptLocError` | SPT localization error (nm) | number | 0 | 500 | 1 | 35 |
| `sptTrackLenMin` | SPT min track length (locs) | number (int) | 2 | 1000 | 1 | 5 |
| `sptDPlotMin` | SPT D plot min (µm²/s) | number | 0.0001 | 1000 | 0.001 | 0.004 |
| `sptDPlotMax` | SPT D plot max (µm²/s) | number | 0.0001 | 1000 | 0.1 | 10 |
| `sptShowTracksPct` | Show tracks (%) | number | 0.1 | 100 | 1 | 10 |
| `sptTracksColorByD` | Colour tracks by mean D | bool | — | — | — | true |
| `segAreaMin` | Min. cell area (px) | number (int) | 0 | — | 1 | 50 |
| `segAreaMax` | Max. cell area (px) | number (int) | 0 | — | 1 | ∞ (blank field) |

**In-app "more info…" popup** (`hint-spt` in `webSMLM.html`; synced by
`tools/sync_hints.mjs` — edit here, then run the script, never edit the
`.hint` div directly):

<!-- HINT:spt -->
<p>Links each frame's localizations onto the previous frames' active tracks — a trackpy-<b>inspired</b> variant (same <code>search_range</code>/<code>memory</code> terminology and linking philosophy as the Python <code>trackpy</code> package), not a literal port of its source, since there's no way to call real Python trackpy from a static HTML page. Frame-to-frame candidates within <b>Search range</b> are grouped into small connected clusters and each solved via an optimal (minimum total squared displacement) assignment, which keeps crossing trajectories from swapping identity in the common case. <b>Memory</b> lets a track skip up to that many frames with no detection and still be relinked when it reappears.</p>
<p>Every localization gets a <code>track_id</code> (even length-1 tracks); track-length filtering happens only at the diffusion-coefficient step. <b>Track</b> is safe to re-run any time — it only sets/overwrites <code>track_id</code>/<code>D_coeff</code>, never drops or replaces rows, so there's no separate "original vs. tracked" state to manage the way sSMLM's Pair/Unpair needs.</p>
<p>One diffusion coefficient (D, µm²/s) is computed per track with at least <b>Min track length</b> localizations, from the gap-corrected mean of ALL of that track's own single-frame squared displacements (an average, not a linear MSD-vs-lag-time fit) — corrected for <b>Localization error</b>: D = MSD/(4·frame time) − error²/frame time. Changing <b>Frame time</b> or <b>Localization error</b> after <b>Track</b> has run instantly rescales every already-computed D (and the shown histogram) from cached per-track MSDs, no re-tracking needed — only <b>Search range</b>/<b>Memory</b>/<b>Min track length</b> require a fresh <b>Track</b> click, since those change which tracks/steps exist in the first place.</p>
<p><b>Track</b> immediately plots a histogram of D (log<sub>10</sub>-binned — D commonly spans orders of magnitude between bound/slow and free/fast populations) in the raw panel; a track whose corrected D comes out non-positive (near-immobile/very-short tracks, where MSD can end up below the subtracted error term) is excluded from that histogram rather than pooled into a fake spike, with the excluded count logged. <b>D plot min/max</b> set the histogram's own display range (tracks outside it are likewise excluded from the plot only — the logged mean/median D always reflect every qualifying track, not just the plotted window); defaults match the reference pipeline's own histogram range. <b>Show histograms</b> redraws it later without re-tracking. A toggle next to the raw panel's own title (labelled <b>Diffusion</b> or <b>Track length</b>, whichever it would switch to) swaps to the underlying track-length distribution instead (every linked track, log-scaled count axis since it usually falls off steeply) with an overlaid exponential fit (count ~ e<sup>−L/τ</sup>, a photobleaching-limited survival model) — τ is logged in both locs and seconds (via <b>Frame time</b>); a marker shows the current <b>Min track length</b> and moves live as that field is edited (no re-Track needed — only the marker moves, the bars themselves don't depend on it), so use the histogram to judge whether it's set sensibly for this data. If a fresh <b>Track</b> run has no track meeting <b>Min track length</b> for a D estimate, <b>Show histograms</b> opens on the track-length view instead of an empty D plot.</p>
<p><b>Show tracks</b> plots a subset of tracks as lines directly on the <b>SMLM reconstruction</b> (thickness = one reconstruction pixel's own on-screen size at the current zoom, capped so zooming in a long way can't blow a track up into an oversized shape), a filled circle marking each track's own start point (diameter = 2x the line thickness, same colour as the line), and its track number in white on a semi-transparent grey backing box (matching the scale bar's own) for legibility — growing larger the further you zoom in — legible tracks require zooming in, since real data is usually dense. Only tracks meeting <b>Min track length</b> are eligible (the same threshold Track's own D estimate uses); <b>Show tracks (%)</b> (default 10%) then samples a fixed, reproducible percentage of those, so a dense dataset stays plottable — raising it never reshuffles the tracks already shown, it only reveals more, and the exact same track identities come up every time for a given dataset. <b>Colour tracks by mean D</b> (checked by default) colours each track by its own mean diffusion coefficient (the same colour ramp as <b>Fire (hot)</b>, normalised against <b>D plot min/max</b>, with a colour-scale legend centred along the panel's right edge while it's checked — a track with no qualifying D estimate, e.g. too short, is drawn a neutral grey instead); uncheck it for plain magenta tracks instead. Click a track (anywhere along its own line) to select it — it highlights magenta in colour-by-D mode, or the same green the raw panel's own ROI boxes use otherwise; click it again, or a different track, to change the selection. Turning the overlay on also switches the reconstruction to the <b>Grey</b> colour map, so the tracks' own colouring doesn't compete with a coloured density map. A toggle next to the <b>SMLM reconstruction</b> title (<b>Show tracks</b>/<b>Hide tracks</b>) switches the overlay on and off without re-plotting.</p>
<p><b>Show track data</b> opens a sortable, filterable table of the per-track summary — one row per track (<code>track_id</code>, <code>n_locs</code>, <code>D_coeff</code>, mean x/y, first/last frame), the same rows <b>Save track data</b> writes to CSV, not one row per localization (see <b>View data/filtering</b> for that). Click a column header to sort by it; type a filter (e.g. <code>n_locs &gt; 10</code>, joinable with <code>and</code>/<code>or</code>) and press Enter to apply it — cumulative, removable filter chips, same grammar as the main table. A v1 kept deliberately simple for now (no histogram-of-column, no link back to the reconstruction yet).</p>
<p>Ported from the user's own <code>sptPALM-Python</code> pipeline (L. lactis sptPALM) — see <a href="https://websmlm.readthedocs.io/en/latest/content/09-references-further-reading.html" target="_blank" rel="noopener">References &amp; further reading</a>. No length-resolved D histogram yet — see <code>docs/REFACTOR_PLAN.md</code>.</p>
<p><b>Apply segmentation?</b> (default unchecked) reveals <b>Load segm. image</b> — loads a separate integer-labelled mask (0 = background, 1/2/3/… = cell number, same file types as <b>Load movie</b>), shown in the raw panel recoloured so adjacent cells are visually distinct, and builds an internal per-cell table (id, centre of mass, area in px). <b>Show image</b> re-shows it later without reloading the file, opening on the segmentation image by default; a toggle next to the raw panel's own title switches to a histogram of the cell-area distribution (px) and back — use it to judge <b>Min./Max. cell area (px)</b>, which gate which cells actually get tracked (default 50–∞).</p>
<p>Once a segmentation image is loaded, <b>SMLM reconstruction</b>'s panel title gains a <b>Show segm.</b> button — swaps the panel to the segmented cells (opaque, same colours as the raw-panel view) with the same reconstruction drawn on top, its black background made highly transparent (sparse localizations get a minimum visible brightness so they don't disappear against a bright cell colour), so you can check localizations line up with their cells before tracking (click again, now <b>Show recon.</b>, to go back). If you correct <b>Pixel size (nm)</b> after loading the segmentation image, the segmentation's on-screen size rescales relative to the (unmoving) localizations — using its value at load time as the reference, since localization positions themselves never depend on it: correcting it upward grows the segmentation's apparent coverage, downward shrinks it.</p>
<p>With segmentation applied, <b>Track</b> links each qualifying cell's own localizations SEPARATELY (a track can never cross a cell boundary), rather than one whole-field-of-view pass — ported from the user's own <code>sptPALM-Python</code> pipeline's <code>apply_cell_segmentation_sptPALM.py</code>/<code>tracking_sptPALM.py</code> (<code>use_segmentations</code> branch). Every localization gets a <code>cell_id</code> (−1 if it's background or inside a cell outside the area range — never tracked) and, only once segmentation is applied, a <code>cell_area [px]</code> column alongside it in **Save data**/the table.</p>
<!-- /HINT:spt -->

Defaults are ported from the user's own `sptPALM-Python` pipeline's
`set_parameters_sptPALM.py` (L. lactis sptPALM), converted from that
pipeline's µm convention to webSMLM's own nm convention for spatial params
(0.8 µm → 800 nm, 0.035 µm → 35 nm) — a different setup's own step sizes and
localization precision will sit elsewhere, so treat these as a starting
point, not a universal default. `sptFrameTime` is not auto-applied from the
loaded stack — set it to match your own movie's real acquisition interval.
A TIFF/ND2 file's own embedded frame interval, when present, is logged on
load (never auto-applied — see **in/out** in `CLAUDE.md`), which can help;
but treat it as one input, not the final word — the bundled
`experimental_data/` L. lactis test file is a real example of why: its
filename implies 50 ms/frame, but its own embedded `finterval` tag says
5 ms, an unresolved 10× discrepancy (see `experimental_data/README.md`'s
lactis entry). See [§2](#2-module-reference)'s **spt** entry for the full
linking/diffusion-coefficient algorithm.

### Pipeline behaviour (`pipeline`) {#pipeline-behaviour-params}

*Module:* **pipeline** — see [§2](#pipeline).

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `liveUpdate` | Real-time update | bool | — | — | — | true |

### Pipeline: preview / export tuning (`pipeline`) {#pipeline-tuning-params}

No page control — settings-JSON only.

*Module:* **pipeline** — see [§2](#pipeline).

| id | Label | Min | Max | Step | Default |
|---|---|---|---|---|---|
| `rawPreviewMs` | Raw-panel live-preview interval (ms) | 16 | 2000 | 10 | 200 |
| `srPreviewMs` | Reconstruction live-preview interval (ms) | 50 | 5000 | 50 | 800 |
| `srPreviewMaxMs` | Reconstruction live-preview interval ceiling (ms) | 800 | 60000 | 1000 | 15000 |
| `stackProjCap` | Data-projection frame sample cap | 10 | 5000 | 10 | 300 |
| `exportMinLong` | PNG export minimum long edge (px) | 500 | 8000 | 100 | 2000 |

`rawPreviewMs` gates the raw (left) panel's live redraw during a Run —
time-based rather than a frame count, so updates land at a steady cadence
regardless of per-frame detect/fit cost. `srPreviewMs` is the *starting*
reconstruction preview interval; it adaptively grows (up to `srPreviewMaxMs`)
as each preview's own render cost grows through a long Run, so preview
overhead stays a roughly bounded fraction of wall time instead of growing
unboundedly. See the **pipeline** module / `run()`.

---

## 4 · Settings JSON format

Written by **Save settings**, read by **Load settings**.

```json
{
  "format": "webSMLM-settings",
  "version": 2,
  "created": "2026-08-08T12:00:00.000Z",
  "values": { "pxnm": 160, "gain": 0.1248, "camoffset": 100, "winr": 4, "...": "..." }
}
```

- `values` is `{id: value}` for **every** `PARAMS` entry (not just ones with
  a page control) — the only way to set the no-page-control entries
  (`workerBatch*`, `srPreview*`, etc.) is a loaded file like this.
- On load, unrecognised keys are logged (`"not recognised — ignored"`) and
  skipped rather than erroring — old files stay loadable across versions.
- DOM-backed entries dispatch a real `change` event when set, so any
  existing listener (live preview, "Fix bead x,y" retrigger, …) reacts
  exactly as if the user had edited the control by hand.
- Today this only round-trips `{id: value}` — not `min`/`max`/`step`, which
  live solely in the hardcoded registry (see `docs/REFACTOR_PLAN.md` for the
  planned extension).

---

## 5 · Table & filter grammar

Opened by **View data/filtering**. Base row set is `getBaseLocs()` — raw
localizations, or (if a `tempClusteringXY`/`tempClusteringZ` clause is
active) merged events from `clusterEvents()`.

Building the table's rows is checked against the **Memory budget (GB)**
setting first (`checkTableSize()`, ~200 bytes/row estimated — a small JS
object per row costs meaningfully more than its raw numeric fields once V8's
own per-object overhead is counted) — the same size-before-allocating
philosophy the **render** module's reconstruction buffers use, reusing the
same `memgb` control rather than a second, separate one. If a huge
localization count would exceed it, the table doesn't open (or, if already
open, doesn't rebuild) and a log line explains why, rather than risking a
tab crash — raise the budget, or narrow the result with a filter/crop/
temporal-clustering clause first.

**Columns** (present depends on the result): `id`, `frame`, `x`, `y`, `z`
(a real 3D fit only), `dist` (sSMLM paired results only — the inter-order
distance; an INDEPENDENT column from `z`, not an alias of it — see §2
sSMLM), `sigma_xy`, `sigma_z` (MLE 3D only, an approximate z-precision —
not available for Phasor 3D), `sigma1st` (sSMLM paired results only — the
1st order's own sigma, see §2 sSMLM/§6), `intensity`, `offset`, `bkgstd`,
`uncertainty`, `nmerged` (only once clustering is active), `track_id` (once
**Track** has run — every localization gets one, see §2 spt), `D_coeff`
(µm²/s, only on localizations whose track met **SPT min track length**).

**Filter syntax:** `field op value`, chained with `and`/`or`
(e.g. `intensity > 1000 and uncertainty < 20`); `op` ∈ `> < >= <= == = !=`.
Enter commits a clause; clauses stack cumulatively (ANDed as a whole).
Typing `reset` clears all of them. An autocomplete dropdown suggests
matching field names as you type (↑/↓ to move, Enter/Tab to accept),
sourced from the current table's own columns plus the two clustering
pseudo-fields below.

**Clustering pseudo-fields** — `tempClusteringXY < N` (nm) and
`tempClusteringZ < N` (nm) are recognised specially *before* the normal
column grammar: rather than selecting a subset of existing rows, they change
the base row set itself, merging consecutive-frame detections of the same
blinking molecule into higher-precision "events" (photon-weighted position,
summed photons, inverse-variance-combined uncertainty). One threshold per
axis — a new value replaces the old, doesn't stack. `tempClusteringMemory`
(gap-frame tolerance) is not implemented yet (`docs/REFACTOR_PLAN.md`); a
gap frame always breaks the chain today.

**Crop tool** (SR panel, next to the line-profile tool) — click two corners
to push an x/y-range clause into the *same* `_tableFilters` array a typed
filter uses, so a crop affects reconstruction/export/NeNA/FRC identically to
any other filter. Disabled while the SR panel isn't showing a real
per-localization reconstruction (`srIsRecon`). Committing a crop also zooms/
pans the SR view to fit the cropped rectangle — the same "fit within" math
`fitZoom()` uses for the whole image, applied to the rect instead, so the
rectangle's longer axis (relative to the panel's own aspect ratio) reaches
that panel edge and the shorter one is letterboxed, rather than leaving the
crop sitting small inside the old, now mostly-empty view. Double-click/tap
the panel to return to the whole-image fit — removing the crop (deselecting
the tool, or **Reset filter**) restores the un-cropped data but leaves the
view zoomed/panned where the crop left it.

**Plot histogram of** — draws the selected column's distribution in the raw
(left) panel, over whatever rows currently pass the active filters.

---

## 6 · CSV export format

Written by **Save data** (`exportCSV()`), ThunderSTORM-compatible:

```
"id","frame","x [nm]","y [nm]",["z [nm]",]"sigma [nm]"[,"sigma_x [nm]","sigma_y [nm]"],"intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"[,"sigma_z [nm]"][,"dist [nm]"][,"sigma1st [nm]"][,"sx0th [nm]","sy0th [nm]","sx1st [nm]","sy1st [nm]"][,"n_merged [frames]"][,"track_id"][,"D_coeff [um^2/s]"][,"cell_id","cell_area [px]"]
```

- `z [nm]` only present for a real 3D result (a 3D fit method).
- `sigma [nm]` is kept under that literal name (not `sigma_xy`, which the
  in-app table uses) specifically for ThunderSTORM compatibility.
- `sigma_x [nm]`/`sigma_y [nm]` are present on EVERY localization (not just
  an sSMLM-paired subset) whenever the Run used an elliptical fit method
  (`mle3d`/`gaussmleEll`, see §2/fit) — the fitted per-axis width directly,
  independent of `sigma1st [nm]`/`sx0th [nm]` etc. below (those are
  sSMLM-**Pair**-specific). Round-trips through **Load data**.
- `sigma_z [nm]`, `dist [nm]`, `sigma1st [nm]`, `sx0th [nm]`/`sy0th [nm]`/
  `sx1st [nm]`/`sy1st [nm]`, `track_id`, `D_coeff [um^2/s]`, `cell_id`/
  `cell_area [px]` (each when available) and `n_merged [frames]` (when
  temporal clustering is active) are webSMLM-specific additions appended
  after the standard columns — safe for a strict ThunderSTORM reader to
  ignore.
- `cell_id`/`cell_area [px]` are present only after **Track** ran with
  **Apply segmentation?** checked (see §2 spt) — `cell_id` is `-1` for a
  localization that's background or inside a cell outside **Min./Max. cell
  area**, never a real cell number for those (matching `sptPALM-Python`'s
  own `apply_cell_segmentation_sptPALM.py` sentinel convention). Round-trips
  through **Load data**.
- `dist [nm]` is sSMLM-**Pair**-specific: the inter-order distance
  (see §2 sSMLM) — an INDEPENDENT column from `z [nm]`, never a substitute
  for it; `pairCore()` never sets `z`, so a paired-only export has `dist`
  but not `z`. Round-trips through **Load data** (`parseCsvLocs()`).
- `sigma1st [nm]` is sSMLM-**Pair**-specific: the 1st order's own `sigma`
  (see §2 sSMLM), carried through from `pairCore()` rather than the pair's
  reported `sigma [nm]`, which is still the 0th order's. Not a directional/
  long-axis width for most methods — every method except `mle3d`/`gaussmleEll`
  fits one symmetric `sigma`; this is the closest available proxy for how
  much wider the spectrally-smeared 1st order looks in that case. Round-trips
  through **Load data** (`parseCsvLocs()`) like `sigma_z`/`dist`/`n_merged` do.
- `sx0th [nm]`/`sy0th [nm]`/`sx1st [nm]`/`sy1st [nm]` are also sSMLM-
  **Pair**-specific, but only present when the Run used an elliptical fit
  method (`mle3d`/**Gauss MLE 3D rotated elliptical** — `gaussmleEll`,
  renamed from "Gaussian MLE Elliptical (sSMLM)") — a real per-axis width
  for BOTH orders (not just a proxy for the 1st the way `sigma1st` is),
  since those methods fit an independent σx/σy for every localization, not
  just a symmetric `sigma`. Round-trips through **Load data** the same way.
- `track_id` and `D_coeff [um^2/s]` are spt-**Track**-specific (see §2 spt)
  — independent optional columns, present whenever any localization has
  them; `track_id` is on every tracked localization, `D_coeff` only on
  those whose track met **SPT min track length**. `um^2` (not `µm²`) is
  deliberately plain ASCII in the header, matching ThunderSTORM's own
  ASCII-only unit-bracket convention elsewhere in this format. Both
  round-trip through **Load data** (`parseCsvLocs()`).
- Exports the *currently filtered* subset (`renderLocs||lastResult.locs`),
  the same set the reconstruction shows — logged explicitly when a filter is
  active, together with the unfiltered total.
- `intensity`/`offset`/`bkgstd` are already true photon units (gain/offset
  applied inside the fit) — if gain is still 1 and offset 0 (i.e. never set),
  a warning is logged that the exported "photon" values are really raw ADU.

**Loading it back** — **Load data** (`parseCsvLocs()`) is the reverse: reads
the header to find which optional columns are present, then rebuilds a full
`lastResult` usable exactly like a completed Run's. Two things don't survive
the round trip losslessly:
- `lpx`/`lpy` (the two separate CRLB/precision components) collapse to a
  single combined `uncertainty [nm]` in the CSV; loading sets
  `lpx = lpy = uncertainty/px`, which reproduces the *same* combined value if
  re-exported, but the original x/y asymmetry (and whether it came from a
  real CRLB or the LS/phasor formula estimate) is gone.
- There's no camera frame size in a CSV, so the internal `w`/`h` (used only
  to size the reconstruction canvas) are derived from the loaded data's own
  bounding box (a +10 px margin on the high side only). Loc `x`/`y` are
  **never shifted** — `(0,0)` always means the same physical camera pixel it
  meant in the original file/session, so a re-export after loading a CSV
  back in reports exactly the same `x`/`y` values as the original. This
  matters beyond cosmetics: a segmentation image (§2 spt) loaded separately
  is expressed in that same original coordinate frame, and needs the
  localizations to stay there too for the two to overlay correctly. An
  earlier version DID re-centre the bounding box (shifting every loc so the
  low/high margins matched) purely for a tidier look on a CSV-only load with
  no raw frame to compare against — reverted once the segmentation overlay
  made that assumption wrong: the shifted coordinates no longer lined up
  with an externally-supplied segmentation image.

---

## 7 · Calibration JSON format

Written by **Save calib.** (`exportCalibration()`), read by **Load
calibration…** for a 3D fit method.

```json
{
  "format": "webSMLM-astig-calibration", "version": 2, "created": "...",
  "source_file": "...", "fixed_xy": false,
  "pixel_size_nm": 160, "z_step_nm": 10, "frames": { "first": 1, "last": 80 },
  "z_ref_nm": 0, "z_range_nm": { "min": -400, "max": 400 }, "n_points": 1234,
  "calibration_methods": [
    { "id": "phasor_magnitude", "label": "...", "used_by": ["phasor3d"], "model": "phasor_z_from_ratio" },
    { "id": "gaussian_width", "label": "...", "used_by": ["ls3d","mle3d"], "model": "sigma_x_nm/sigma_y_nm" }
  ],
  "sigma_x_nm": { "a": "...", "c": "...", "b": "...", "A": "...", "B": "...", "C": "..."},
  "sigma_y_nm": { "a": "...", "c": "...", "b": "...", "A": "...", "B": "...", "C": "..."},
  "phasor_ratio": { "a": "...", "c": "...", "b": "...", "A": "...", "B": "...", "C": "..."},
  "phasor_z_from_ratio": { "coef": "[...]", "basis": "ratio", "rmin": "...", "rmax": "...", "rms_nm": "..."},
  "note": "..."
}
```

- Can carry **both** calibration models at once (Phasor's magnitude-ratio
  model and the Gaussian-width model MLE 3D uses) — every bead is fit both
  ways regardless of which method calibration was run for, so a single file
  covers either downstream method. `calibration_methods` is an array of
  `{id, label, used_by, model}` objects, one per model actually present.
- `sigma_x_nm`/`sigma_y_nm`/`phasor_ratio` each pack the same quadratic fit
  twice: `a`/`c`/`b` is the vertex form `σ(z) = a(z−c)² + b` (nm, `z`
  relative to the σx=σy focal crossing) that `zFromWidths()` actually
  consumes; `A`/`B`/`C` is the same curve in raw polynomial form.
- Loading infers which models are present even from an older file with no
  `calibration_methods` list (checks for the model blocks themselves), and
  warns if the currently-selected fit method needs a model the file doesn't
  contain.
- Can also be **built headlessly**, from a bead z-stack instead of clicking
  **Calibrate** — see `config.calibrationFile`/`--calibration <stack>.tif` in
  §8 below.

---

## 8 · Headless API (`window.webSMLM`)

The Layer 1 entry point of the scriptable/headless pipeline
(`docs/REFACTOR_PLAN.md`). Runs the whole load → detect/fit → drift →
CSV/log/settings pipeline in one call, without touching a DOM control, a
dialog, or a Blob-download — every result comes back as in-memory data, for
a driving script (a headless-Chromium automation, Layer 2) or a future
URL-param autorun (Layer 0) to write to disk or inspect directly.

```js
const result = await window.webSMLM.analyze({
  file: fileObjectOrHandle,        // or files: [File, ...] for a multi-file sequence
  pxnm: 160, gain: 0.1248, camoffset: 100, method: 'mle3d',
  calibrationJson: parsedCalibJson,   // required for phasor3d/mle3d — see §7
  correctDrift: true, computeNeNA: true, computeFRC: true,
});
```

- `config` is **partial** — only values that differ from the `PARAMS`
  registry defaults need to appear; `defaultConfig()` (also exposed) fills
  the rest with `PARAMS[id].default`, no DOM read at all.
- `config.file`/`config.files` — a `File` or an array of `File`s (same
  multi-file support as Ctrl/Cmd+click **Load movie**, including the
  auto-detected "several single-frame files" vs. "several chunks of one
  continuous acquisition" cases — see **in/out**), loaded via the existing
  `loadTiffFile`/`loadTiffFilesAuto`. One of the two is required.
- `config.cropX0`/`config.cropY0`/`config.cropX1`/`config.cropY1` — not
  `PARAMS` entries (per-dataset pixel geometry, same treatment as `calFirst`/
  `calLast`). If any is given, `config.file`/`config.files` is immediately
  replaced with just that native-pixel `[x0,x1)×[y0,y1)` sub-rectangle
  (`makeCroppedStack()`, [§2](#2-module-reference)'s **in/out** entry) before
  anything else — `estimateGainOffset`, `runCore` — touches it, the headless
  equivalent of the raw-panel crop tool. An omitted bound defaults to that
  edge of the full frame (`0`/`0`/width/height). Throws if the resulting
  region is under 8×8 px.
- `config.calibrationJson` — a **parsed** calibration JSON object (§7), not
  a file/string. There's no interactive session's loaded calibration to fall
  back on headlessly, so a 3D method needs this explicitly; `analyze()`
  throws immediately (mirroring `run()`'s own precondition check) if the
  selected `method` needs a model the calibration doesn't contain.
- `config.calibrationFile`/`config.calibrationFiles` — a bead z-stack
  `File`/`File`s, alternative to `calibrationJson`: builds a **fresh**
  calibration via `calibrationCore()` (the same DOM-free extraction
  `runCore` got) before the main run, instead of loading one from JSON.
  `config.calFirst`/`config.calLast` (not `PARAMS` entries — per-dataset
  state, same exception as interactively) default to the whole calibration
  stack when omitted; `calStep`/`calRef`/`calFixedXY` are ordinary `PARAMS`
  fields. Anything not explicitly given gets an `onLog` warning naming the
  default used — a silently-wrong `calStep` in particular would otherwise
  produce a badly wrong calibration with no indication anything defaulted.
  `calFixedXY` needs an interactive `locateBeadsForCalib()` session's fixed
  bead positions and so isn't supported headlessly — leave it `false`.
- `config.calibrationOnly` — build/return only the calibration, skipping the
  main analysis entirely; `config.file`/`config.files` aren't required in
  this mode. Returns `{calib, calibJsonText, logText}` only (every other
  result field is omitted).
- `config.correctDrift` / `config.computeNeNA` / `config.computeFRC` —
  booleans, not `PARAMS` entries, gating optional pipeline stages.
- `config.sSmlmPair` (v0.11.1) — boolean, not a `PARAMS` entry. Runs
  `pairCore()` (spectral SMLM pairing, see **sSMLM** in `CLAUDE.md`) right
  after Localize, before drift/NeNA/FRC — the headless equivalent of
  clicking **Pair**. `config.sSmlmDistMin`/`sSmlmDistMax`/`sSmlmAngleCenter`/
  `sSmlmAngleTol`/`sSmlmRequireNarrower` (ordinary `PARAMS` fields) configure
  the window. `pairCore()` itself throws — propagating as a rejected
  `analyze()` promise, same "throws immediately" precedent as this API's
  other preconditions — if the localizations already have real 3D `z` (a 3D
  fit method) or already have a `dist` field (already-paired output).
  `result.sSmlmPair` records `{nPairs, nInput, meanDistance, stdDistance}`
  (`null` if `sSmlmPair` wasn't requested); on success `result.locs` (and
  therefore `result.csvText`/`result.reconstructionPng`) reflect the
  *paired* set, same as an interactive Pair replacing `lastResult.locs`.
- `config.sptTrack` (v0.11.2) — boolean, not a `PARAMS` entry. Runs
  `sptCore()` (single particle tracking, see **spt** in `CLAUDE.md`) — the
  headless equivalent of clicking **Track**. Unlike `sSmlmPair`, runs AFTER
  `correctDrift`/`computeNeNA`/`computeFRC` rather than before: tracking
  never drops rows (`track_id`/`D_coeff` are added columns, every
  localization keeps its own row), so there's no row-count reason to run it
  early the way pairing's own row reduction motivates, but a per-track
  diffusion coefficient benefits from drift-corrected coordinates.
  `config.sptSearchRange`/`sptMemory`/`sptFrameTime`/`sptLocError`/
  `sptTrackLenMin` (ordinary `PARAMS` fields) configure it. `result.spt`
  records `{nTracks, nQualify, meanD, medianD}` (`null` if `sptTrack` wasn't
  requested) — deliberately a small summary, not `sptCore()`'s own full
  `diffCoeffs`/`trackIds`/`trackLengths` arrays (`trackMSD` in particular is
  a `Map`, not JSON-serialisable — would silently become `{}` under
  `JSON.stringify()` if returned as-is); `result.locs`/`result.csvText`
  gain `track_id`/`D_coeff` columns the same way an interactive Track adds
  them to `lastResult.locs`, row count unchanged.
- `config.segmentationFile` (v0.11.6) — a `File`, not a `PARAMS` entry. Its
  mere presence switches `sptTrack` (above) from one whole-field-of-view
  tracking pass to cell-by-cell tracking, the headless equivalent of
  checking **Apply segmentation?** + **Load segm. image** — a track can
  never cross a cell boundary. Loaded the same way `config.file`/
  `config.calibrationFile` are; only frame 0 is read (a segmentation mask is
  a single image). A size mismatch against the loaded movie logs a warning
  but still proceeds. `config.segAreaMin`/`segAreaMax` (ordinary `PARAMS`
  fields, default 50/no limit) gate which cells' localizations actually get
  tracked; `result.locs`/`result.csvText` gain `cell_id`/`cell_area`
  columns once this is set. Ignored if `sptTrack` itself wasn't requested.
- `config.estimateGainOffset` — boolean, not a `PARAMS` entry. Runs
  `pcfoCore()` (PCFO gain/offset estimation, [§3/Gain-offset estimation
  (PCFO)](#pcfo-params)) on the SAME stack `config.file`/
  `config.files` just loaded, **before** the main run, then overrides
  `config.gain`/`config.camoffset` with the estimate — the headless
  equivalent of clicking **Estimate**, **Transfer estimates**, then
  **Localize**.
  `pcfoFrames`/`pcfoK`/`pcfoRnstd` are ordinary `PARAMS` fields tuning it. If
  PCFO can't fit (too few usable tiles — e.g. a very small frame), `config.gain`/
  `config.camoffset` are left as given (or their `PARAMS` defaults) and
  `result.pcfo` is `null`, same as the interactive button leaving the fields
  untouched on failure. Not available in `config.calibrationOnly` mode (no
  stack is loaded there).
- `config.exportPlots` — boolean, not a `PARAMS` entry. Renders whichever of
  drift/NeNA/FRC/PCFO/calibration were actually computed this call (i.e.
  `correctDrift`/`computeNeNA`/`computeFRC`/`estimateGainOffset`/
  `calibrationFile`(`s`) were also set) as BOTH a PNG and an SVG, returned in
  `result.plots` — one flag for everything available this run, not a toggle
  per plot. No visible browser window is needed (same headless-safe
  rendering `reconstructionPng` already uses, via a detached `<canvas>`/an
  SVG recorder — see **render** in `CLAUDE.md`). The raw frame/reconstruction
  are never included (no vector form at real localization counts, same
  reasoning as the interactive **Save plot/image** button); the
  line-profile/histogram plots are inherently interactive (a user-drawn line
  / a chosen table column) with no headless equivalent to render from. The
  calibration plot needs a FRESH build this call (`calibrationFile`/
  `calibrationFiles`) — a bare `calibrationJson` only carries the derived
  model, not the point cloud the plot needs. Works in `config.calibrationOnly`
  mode too (renders just the calibration plot, if requested).
- `config.onProgress(pct)` — optional, called the same way `setProg()` would
  be interactively (0–100), for a driving script's own progress reporting.
- `config.onLog(msg)` — optional, called for every line `analyze()` would
  otherwise only collect into `logText` — a driving script can watch the run
  live instead of waiting for the whole thing to finish and reading
  `result.logText` after the fact. Every hook inside the pipeline
  (`loadTiffFile`/`loadTiffFilesAuto`, `runCore`, `driftCore`,
  `frcResolution`, `calibrationCore`) defaults to the real interactive
  `log()`/`setProg()` when not given one explicitly, so nothing that would
  show in the interactive Log window goes missing headlessly — `analyze()`
  just always supplies its own collector, whether or not you also supply
  `onLog`. `onLog` carries diagnostics/summaries only, not progress — a
  numeric-only percentage adds nothing once read back as text (tried, then
  reverted: it just repeated the same handful of numbers for every phase
  with no other information), so `onProgress` is the only progress channel.

**Returns** `{locs, csvText, logText, settingsText, timings, reconstructionPng, drift, nena, frc, w, h, px, mag, calib, calibJsonText, pcfo, sSmlmPair, spt, plots}`:
- `plots` is `null` unless `config.exportPlots` was set; otherwise an object
  with only the keys for what was actually computed this run — e.g.
  `{drift, nena}` if only `correctDrift`/`computeNeNA` were requested. Each
  value is `{pngDataUrl, svgText}`: `pngDataUrl` is a
  `data:image/png;base64,...` URL like `reconstructionPng`; `svgText` is a
  ready-to-write SVG document string (no encoding needed).
- `pcfo` is `{gain, gainStd, offset, offsetStd, r2, pts, fit}` (`pcfoCore()`'s
  return shape) when `estimateGainOffset` was requested and PCFO found
  enough usable tiles to fit, else `null`. `gain`/`offset` are what
  `config.gain`/`config.camoffset` were overridden to (so already reflected
  in `settingsText`/every downstream photon-unit conversion); `pts` is the
  full per-tile signal/noise-variance point cloud PCFO fit, for a driving
  script that wants to build its own diagnostic plot.
- `calib`/`calibJsonText` are only non-null when `calibrationFile`/
  `calibrationFiles` was given — a freshly-built calibration is worth
  writing out for reuse (`calibJsonText` is the same `*.calib.json` text
  `buildCalibJson()`/**Save calib.** produces), unlike one that was already
  loaded from an existing `calibrationJson`.
- `csvText`/`settingsText`/`logText` are ready-to-write strings — the same
  three artifacts (§4, §6) a UI session produces by hand via Save
  settings/Save data/Export log, assembled without ever touching those
  buttons.
- `reconstructionPng` is a `data:image/png;base64,...` URL, rendered via
  `renderSuperRes()` — which already creates its own detached `<canvas>`
  internally, so this needs no page canvas element at all, headless or not.
- `nena`/`frc` are the **numeric** result objects only (`nenaPrecision()`/
  `frcResolution()`'s return shape) when requested — **no plot image yet**;
  `drawFrcPlot`/`drawNenaPlot` are still tied to the interactive `#raw`
  canvas, so a plot PNG for either is a follow-up, not implemented here.
- `drift` is `driftCore()`'s return value (`{drift, nFrames, ms}`) when
  `correctDrift` was requested — `locs` already reflects the corrected
  positions (drift correction mutates in place), so `csvText`/the
  reconstruction/NeNA/FRC all see corrected coordinates automatically, same
  as the interactive pipeline.
- `sSmlmPair` is `{nPairs, nInput, meanDistance, stdDistance}` when
  `sSmlmPair` was requested, else `null` — `locs` already reflects the
  *paired* set (fewer rows, each carrying `dist` instead of the raw pair's
  two separate rows), so `csvText`/`reconstructionPng`/any subsequent
  `correctDrift`/`computeNeNA`/`computeFRC` all see the paired result
  automatically, same as the interactive pipeline. Runs BEFORE those other
  optional stages (see **sSMLM** in `CLAUDE.md`).
- `spt` is `{nTracks, nQualify, meanD, medianD}` when `sptTrack` was
  requested, else `null` — `locs` already reflects the tracked result
  (`track_id`/`D_coeff` added, row count unchanged), so `csvText` gains
  those two columns automatically. Runs AFTER `correctDrift`/`computeNeNA`/
  `computeFRC` (see **spt** in `CLAUDE.md`), the opposite order from
  `sSmlmPair`.

`window.webSMLM.analyzeBatch(files, config)` loops `analyze()` over
multiple files with the same config (no per-file override yet). Sequential,
not parallel — `getPool()`'s worker pool is memoised process-wide, so
concurrent `analyze()` calls would contend for the same workers rather than
speeding anything up. Fails fast: one bad file rejects the whole batch.

### URL-param autorun (Layer 0)

`webSMLM.html?autorun=1&fileUrl=https://.../stack.tif&pxnm=160&method=mle3d&...`
runs `analyze()` automatically once the page finishes loading — no console,
no driving script, works by just opening the link in any browser.

- Every query-string key that matches a `PARAMS` id becomes that config
  field, type-coerced the same way the registry describes it (`number` →
  `+val`, `bool` → `val==='1'||val==='true'`, `enum` → the string as-is).
  Unrecognised keys are silently ignored, same tolerance as a loaded
  settings JSON.
- `correctDrift`/`computeNeNA`/`computeFRC`/`estimateGainOffset`/`sSmlmPair`/
  `sptTrack`/`exportPlots` work as `=1`/`=true` flags too, same as passing
  them to `analyze()` directly. `cropX0`/`cropY0`/`cropX1`/`cropY1` work as
  plain numeric params the same way.
- `fileUrl` (required to actually run) and `calibrationJson` come from
  **`fileUrl`/`calibrationUrl`** query params instead — both must be
  fetchable URLs, not local paths (the browser has no way to name a local
  file in a URL for security reasons; a driving script gets around this
  entirely by supplying the file via `page.setInputFiles()` and calling
  `analyze()` directly instead of using autorun). Both are fetched as a
  `Blob`/parsed JSON respectively — a `Blob` is a drop-in for `analyze()`'s
  `config.file`, since the loaders only need `.size`/`.slice()`/
  `.arrayBuffer()`, all of which `Blob` has.
- The result isn't rendered into the page — it's logged (`result.logText`)
  and stashed on `window.webSMLM.lastAutorunResult` for inspection from the
  console or read back by a driving script via `page.evaluate()`.
- `&download=1` also writes five files under **fixed filenames**, every
  run, to the Downloads folder — the same three artifacts a UI session
  produces by hand (`webSMLM_autorun_settings.json`, `_result.csv`,
  `_log.txt`) plus a timing/config summary (`_result.json`: config used +
  `nLocalizations` + `timings`) and the reconstruction
  (`_reconstruction.png`, `result.reconstructionPng` decoded to a real
  file). Written sequentially in that order, so a poller can watch for the
  PNG (written last) as a proxy for "all five are done" — `saveBlob()`'s
  `<a download>` fallback returns right after triggering the click, not
  once the browser has actually finished writing the file. This is for a
  plain script that can't reach into the page's JS heap the way
  `page.evaluate()` can, but *can* poll the filesystem — see
  `tools/browser-sweep.sh` (bash) or `tools/browser_sweep.py` (stdlib-only
  Python, arguably the easier one to read — its `webbrowser` module
  abstracts the per-OS launch command the bash version hand-rolls), both
  parameter-sweep drivers that open a real browser once per value, wait for
  these files, and collect them into a working folder. Works dialog-free in
  every browser: `saveBlob()`'s `showSaveFilePicker()` path (Chrome/Edge)
  requires a user gesture, which autorun doesn't have, so it rejects and
  falls through to a plain `<a download>` automatically.
- `?autorun=0`/`?autorun=false` (or omitting it) skips autorun entirely —
  the page behaves exactly as it always has.

### Command-line tools (`tools/`)

Three scripts drive webSMLM from outside the browser entirely — none of
them touch `webSMLM.html` itself, which stays dependency-free either way.

**`tools/webSMLM-cli.mjs`** (Layer 2) — the recommended one: a real,
**true-headless** Chromium via [Playwright](https://playwright.dev), no
browser window ever opens. Uploads the input file directly
(`page.setInputFiles()` — no HTTP server, no `fetch()`, no CORS concern at
all, unlike autorun's `?fileUrl=`) and calls `analyze()` straight through
`page.evaluate()`, so the result comes back as a normal return value —  no
Downloads-folder polling, no fixed filenames, no guessing whether headless
downloads work.

```bash
cd tools
npm install                # once — also downloads Chromium for Playwright to drive
node webSMLM-cli.mjs --file /path/to/stack.tif --pxnm 160 --method gaussmle
```

Writes `result.csv`, `settings.json`, `log.txt`, `reconstruction.png` and
`summary.json` (localization count + timings + drift/NeNA/FRC/PCFO results)
to `--out` — which defaults to a `webSMLM-out` folder **next to `--file`**,
not wherever the shell happens to be, unless given explicitly. `--exportPlots`
also writes `<key>_plot.png`/`<key>_plot.svg` for each of drift/NeNA/FRC/
PCFO/calibration that was actually requested this run (see
`config.exportPlots` above) — e.g. `--correctDrift --computeNeNA
--exportPlots` writes `drift_plot.png`/`.svg` and `nena_plot.png`/`.svg`. Any
`--key=value` not listed in the script's header comment is passed straight
through as a `PARAMS` override (§3) — e.g. `--winr=6 --gain=0.1248
--camoffset=100`; `--correctDrift`/`--computeNeNA`/`--computeFRC`/
`--estimateGainOffset`/`--sSmlmPair`/`--sptTrack`/`--exportPlots` are bare
boolean flags — the last-but-three runs PCFO gain/offset estimation on `--file` itself before
localizing and overrides `--gain`/`--camoffset` with the estimate
(`summary.json`'s `pcfo` field records what was found:
`gain`/`gainStd`/`offset`/`offsetStd`/`r2`, `pts` trimmed since it's
redundant with the log's own summary line and can run into the thousands);
`--pcfoFrames`/`--pcfoK`/`--pcfoRnstd` (`PARAMS` overrides) tune it — see
[§8](#8-headless-api-window-websmlm)'s `config.estimateGainOffset`.
`--sSmlmPair` pairs 0th/1st-order spectral SMLM localizations right after
Localize (`--sSmlmDistMin`/`--sSmlmDistMax`/`--sSmlmAngleCenter`/
`--sSmlmAngleTol`/`--sSmlmRequireNarrower`, ordinary `PARAMS` overrides,
configure the window; `summary.json`'s `sSmlmPair` field records
`nPairs`/`nInput`/`meanDistance`/`stdDistance`) — see
[§8](#8-headless-api-window-websmlm)'s `config.sSmlmPair`. `--sptTrack`
links localizations into trajectories and computes a per-track diffusion
coefficient, AFTER `--correctDrift`/`--computeNeNA`/`--computeFRC` (the
opposite order from `--sSmlmPair` — a per-track D benefits from drift-
corrected coordinates) — `--sptSearchRange`/`--sptMemory`/
`--sptFrameTime`/`--sptLocError`/`--sptTrackLenMin` (ordinary `PARAMS`
overrides) configure it; `result.csv` gains `track_id`/`D_coeff` columns,
and `summary.json`'s `spt` field records `nTracks`/`nQualify`/`meanD`/
`medianD` — see [§8](#8-headless-api-window-websmlm)'s `config.sptTrack`.
`--segmentation <mask.tif/.tiff/.nd2>` switches `--sptTrack` to cell-by-cell
tracking — a track can never cross a cell boundary. Only frame 0 is read (a
segmentation mask is a single image); a size mismatch against `--file` logs
a warning but still proceeds. `--segAreaMin`/`--segAreaMax` (ordinary
`PARAMS` overrides, default 50/no limit) gate which cells' localizations
actually get tracked; `result.csv` gains `cell_id`/`cell_area` columns.
Ignored without `--sptTrack` — see
[§8](#8-headless-api-window-websmlm)'s `config.segmentationFile`.
`--cropX0`/`--cropY0`/`--cropX1`/`--cropY1` (any subset — an omitted bound
defaults to that edge of the full frame) replace `--file` with just that
native-pixel sub-rectangle before anything else touches it, the headless
equivalent of the raw-panel crop tool — see
[§8](#8-headless-api-window-websmlm)'s `config.cropX0` for the full behaviour.
`--headed` opens a real (non-headless) window — note that the
window itself stays visually idle throughout, since `analyze()` never
touches the DOM while running, by design (that's what makes it safe to run
headless in the first place). Progress and log lines instead stream to the
**terminal** live as the run progresses, via `page.on('console')` —
real-time, unlike `page.evaluate()`'s return value, which only arrives once
the whole run is done — so `--headed` is really only useful for confirming
the page loaded without error or for manually opening DevTools mid-run, not
for watching progress. Two channels, both forwarded live: an in-place
(`\r`-overwriting, terminal-width-truncated) progress bar driven by every
`onProgress` call, with the most recent `onLog` line shown next to it as a
"currently running" status; every `onLog` line (file-load diagnostics, the
`Run:`/timing summary, warnings) is also printed on its own line as it
arrives and lands verbatim in `log.txt`, so the terminal view and the saved
log always match — `onLog` carries no percentage text, `onProgress`/the bar
is the only place progress shows.

`--calibration <path>` **overloads on file extension**: a `.json` supplies
`config.calibrationJson` (used as-is), a `.tif`/`.tiff` supplies
`config.calibrationFile` — a bead z-stack `analyze()` builds a **fresh**
calibration from before the main run (via `calibrationCore()`), then also
writes it out as `<name>_calib.json` alongside the usual output, so it can
be reused without rebuilding:

```bash
node webSMLM-cli.mjs --file stack.tif --method mle3d --calibration calib.json --pxnm 160 --gain 0.1248 --camoffset 100
node webSMLM-cli.mjs --file stack.tif --method mle3d --calibration beadstack.tif --calStep 10 --pxnm 160
```

`--calFirst`/`--calLast`/`--calStep`/`--calRef` set the calibration
range/step/z=0 reference (same meaning as the interactive Calibrate
controls); anything not given defaults (whole stack / `PARAMS.calStep`
=10 nm / `PARAMS.calRef`=auto) with a warning printed/logged, since a
silently-wrong `--calStep` in particular would otherwise produce a badly
wrong calibration with no indication anything defaulted. `--calibrationOnly`
builds/writes just the calibration and skips localizing entirely — `--file`
isn't required in that mode:

```bash
node webSMLM-cli.mjs --calibration beadstack.tif --calibrationOnly --calStep 10 --pxnm 160 --out ./calib-out
```

**`tools/browser_sweep.py`** (stdlib-only Python) and **`tools/browser-sweep.sh`**
(bash, with OS detection for macOS/Linux/Windows) — simpler alternatives
that need no `npm install`, but drive a real *visible* browser (no true
headless mode) through a sweep of one parameter's values (e.g. fit radius),
via `?autorun=1&download=1&...` + polling the Downloads folder for the
files it writes (see above). Good for "try several settings and compare
timings" without installing anything; reach for the CLI instead for a
single run, true headless operation, or CI.

---

## 9 · References & further reading

What this tool borrows from, and where to read more.

**Phasor localization**
- "Phasor based single-molecule localization microscopy in 3D (pSMLM-3D): an algorithm for MHz localization rates using standard CPUs," K. J. A. Martens, A. N. Bader, S. Baas, B. Rieger, J. Hohlbein, *J. Chem. Phys.* **148**, 123311 (2018). [doi:10.1063/1.5005899](https://doi.org/10.1063/1.5005899)
- "Integrating engineered point spread functions into the phasor-based SMLM framework," K. J. A. Martens et al., *Methods* (2020).

**Spot detection & thresholding**
- "ThunderSTORM: a comprehensive ImageJ plug-in for PALM and STORM data analysis and super-resolution imaging," M. Ovesný, P. Křížek, J. Borkovec, Z. Švindrych, G. M. Hagen, *Bioinformatics* **30**(16), 2389–2390 (2014). [doi:10.1093/bioinformatics/btu202](https://doi.org/10.1093/bioinformatics/btu202)
- "Wavelet analysis for single molecule localization microscopy," I. Izeddin et al., *Opt. Express* **20**(3), 2081–2095 (2012). [doi:10.1364/OE.20.002081](https://doi.org/10.1364/OE.20.002081)
- "Simultaneous multiple-emitter fitting for single molecule super-resolution imaging," F. Huang, S. L. Schwartz, J. M. Byars, K. A. Lidke, *Biomed. Opt. Express* **2**(5), 1377–1393 (2011). [doi:10.1364/BOE.2.001377](https://doi.org/10.1364/BOE.2.001377)

**Fitting & precision (why LS ≠ MLE)**
- "Precise nanometer localization analysis for individual fluorescent probes," R. E. Thompson, D. R. Larson, W. W. Webb, *Biophys. J.* **82**(5), 2775–2783 (2002). [doi:10.1016/S0006-3495(02)75618-X](https://doi.org/10.1016/S0006-3495(02)75618-X)
- "Optimized localization analysis for single-molecule tracking and super-resolution microscopy," K. I. Mortensen, L. S. Churchman, J. A. Spudich, H. Flyvbjerg, *Nat. Methods* **7**, 377–381 (2010). [doi:10.1038/nmeth.1447](https://doi.org/10.1038/nmeth.1447)
- "Fast, single-molecule localization that achieves theoretically minimum uncertainty," C. S. Smith, N. Joseph, B. Rieger, K. A. Lidke, *Nat. Methods* **7**, 373–375 (2010). [doi:10.1038/nmeth.1449](https://doi.org/10.1038/nmeth.1449)
- MLE implementation ported from **Picasso**'s `picasso/gaussmle.py` — see Picasso reference below.

**Gain/offset estimation (PCFO)**
- "Calibrating photon counts from a single image," R. Heintzmann, P. K. Relich, R. P. J. Nieuwenhuizen, K. A. Lidke, B. Rieger, *arXiv:1611.05654*. [arxiv.org/abs/1611.05654](https://arxiv.org/abs/1611.05654)

**Localization precision (NeNA)**
- "A simple method to estimate the average localization precision of a single-molecule localization microscopy experiment," U. Endesfelder, S. Malkusch, F. Fricke, M. Heilemann, *Histochem. Cell Biol.* **141**, 629–638 (2014). [doi:10.1007/s00418-014-1192-3](https://doi.org/10.1007/s00418-014-1192-3)

**Image resolution (FRC)**
- "Measuring image resolution in optical nanoscopy," R. P. J. Nieuwenhuizen, K. A. Lidke, M. Bates, D. L. Puig, D. Grünwald, S. Stallinga, B. Rieger, *Nat. Methods* **10**, 557–562 (2013). [doi:10.1038/nmeth.2448](https://doi.org/10.1038/nmeth.2448)

**Temporal median filtering (FTM)**
- Originates with the Nieuwenhuizen et al. paper above; ported from the Hohlbein Lab's own newer implementation, [FTM2](https://github.com/HohlbeinLab/FTM2), used in "Enabling single-molecule localization microscopy in turbid food emulsions," A. Jabermoradi, S. Yang, M. I. Gobes, J. P. M. van Duynhoven, J. Hohlbein, *Phil. Trans. R. Soc. A* **380**(2220), 20200164 (2022). [doi:10.1098/rsta.2020.0164](https://doi.org/10.1098/rsta.2020.0164)

**Drift correction (AIM)**
- "Toward drift-free high-throughput nanoscopy through adaptive intersection maximization," H. Ma, M. Chen, P. Nguyen, Y. Liu, *Sci. Adv.* **10**(21), eadm7765 (2024). [doi:10.1126/sciadv.adm7765](https://doi.org/10.1126/sciadv.adm7765)
- Adapted from **Picasso**'s `picasso/aim.py` (parabolic sub-pixel peak fit replaces the FFT phase refinement; linear interpolation replaces the spline) — see Picasso reference below.

**Picasso** (reference implementation for the ported MLE and AIM drift code above, [github.com/jungmannlab/picasso](https://github.com/jungmannlab/picasso))
- "Super-resolution microscopy with DNA-PAINT," J. Schnitzbauer, M. T. Strauss, T. Schlichthaerle, F. Schueder, R. Jungmann, *Nat. Protoc.* **12**, 1198–1228 (2017). [doi:10.1038/nprot.2017.024](https://doi.org/10.1038/nprot.2017.024)

**Overview**
- "Single-molecule localization microscopy," M. Lelek et al., *Nat. Rev. Methods Primers* **1**, 39 (2021). [doi:10.1038/s43586-021-00038-x](https://doi.org/10.1038/s43586-021-00038-x)

---

## 10 · Changelog

Per-release history — new features, fixes and notable implementation
detail for every shipped version — lives in
[`CHANGELOG.md`](https://github.com/HohlbeinLab/webSMLM/blob/main/CHANGELOG.md)
on GitHub, not duplicated here. This manual describes current behaviour
only; check the changelog for what changed and when.
