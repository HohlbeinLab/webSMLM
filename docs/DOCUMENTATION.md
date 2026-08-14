# webSMLM — Documentation

A detailed reference for every button, control, parameter and module —
complementary to the in-app **Help & guide**, which stays deliberately sparse
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

Line/anchor references below point at `webSMLM.html` as of **v0.10.1-dev**;
exact line numbers will drift as the file grows, but the `id=`/function names
they're built from won't.

---

## 1 · UI tour

### Sidebar — action buttons (top to bottom)

| Row | Button | id | Does |
|---|---|---|---|
| 1 | **Load movie** | `loadBtn` | Opens a file picker for one multi-frame TIFF, or Ctrl/Cmd+click several single-frame TIFFs to concatenate them (natural-sorted by filename) into one stack — see **in/out** below. |
| 1 | **Simulate movie** | `genBtn` | Generates a synthetic stack from the *Simulation settings* module — no file needed, useful for a quick smoke-test or teaching demo. |
| 2 | **Load settings** | `loadSetBtn` | Opens a `.json` file (as saved by **Save settings**) and applies every recognised `{id: value}` pair to the `PARAMS` registry — unknown/legacy keys are logged and ignored, not errored on. |
| 2 | **Save settings** | `saveSetBtn` | Dumps the *current* value of every `PARAMS` entry (not just ones with a page control) to a `webSMLM_settings.json` file — see [§4](#4-settings-json-format). |
| 3 | **Localize** | `runBtn` | Runs detection + fitting over the whole loaded/simulated stack — the main action. Disabled until a stack is loaded. |
| 3 | **Stop** | `stopBtn` | Requests an early stop of a running Localize/Calibrate; localizations gathered so far are kept, not discarded. |
| 4 | **Save data** | `saveBtn` | Exports the current (filtered) localizations as a ThunderSTORM-compatible CSV — see [§6](#6-csv-export-format). Disabled until there are localizations. |
| 4 | **Save image** | `saveImgBtn` | Opens a chooser (if both panels have content) to export the raw or reconstruction window as a supersampled PNG. |
| 5 | **Load data** | `loadCsvBtn` | Loads a CSV previously written by **Save data** back into a full working result — table, reconstruction, NeNA/FRC/drift/re-export all work on it exactly as after a Run. Uses only what's in the CSV plus the *current* Pixel size / Magnification controls; there's no raw frame data, so `stack` is left untouched and re-detection/live preview stay unavailable for CSV-loaded data — see [§6](#6-csv-export-format). |
| 5 | **View data + filtering** | `tableBtn` | Opens the sortable, filterable localizations table — see [§5](#5-table--filter-grammar). Disabled until there are localizations. |
| 6 | **Help & guide** | `helpBtn` | Opens the in-app quick-reference modal (references, acknowledgements, license). Right-aligned, alone in its own row. |

Two more buttons live outside this action stack, top-left of the whole page:
`sideToggle` (⇤, collapse/re-open the sidebar — floats as an overlay on
re-open so toggling never resizes the canvases) and `sidePin` (📌, dock a
floating sidebar back into the normal layout).

### Sidebar — collapsible modules (below the action buttons)

Each is a `<details>` element; opening one doesn't affect the others. All
carry their own **…further info…** disclosure with in-context help — this
section summarizes what's *in* each, not what the help text already says.

- **Memory & streaming** (`memBox`) — `memgb` (RAM budget before falling
  back to streaming) and `chunkmb` (streaming chunk size). See **in/out**.
- **Simulation settings** (`simBox`) — `frames`, `dens`, `phot`, `driftpx`;
  only relevant when using **Simulate movie**.
- **3D calibration** (`calibBox`) — `calFirst`/`calLast`/`calStep`/`calRef`
  (per-dataset working state, *not* in `PARAMS` — resets from the loaded
  stack), `calFixedXY`, and the **Calibrate**/**Save calib.** buttons
  (`calBtn`/`calSaveBtn`). See [§7](#7-calibration-json-format), **3D
  calibration** module.
- **Localisation settings** (`locBox`) — two sub-groups in one collapsible,
  separated by an internal rule. **Detection/fit**: `method` (fit algorithm
  select), `fitFirstFrame`/`fitLastFrame` (1-based inclusive frame range
  Localize processes — the rest of the loaded stack is skipped entirely, not
  just excluded from the result; reset to `1`/the loaded stack's frame count
  on every new load, same as `calFirst`/`calLast`), `loadCalBtn` (load a 3D
  calibration JSON, only shown for a 3D method), `detFilter` (detection
  filter select), `liveUpdate`, per-filter threshold fields
  (`detection_wavelet_thr` / `detection_DoG_thr` / `detection_box_thr`, only
  one visible at a time), `detection_DoG_exactbp`, `psf`, `winr` — see
  **detect** / **fit** modules. **Camera / export (ADU→photon conversion)**:
  `pxnm` (pixel size — also sets the physical scale for the scale bar, z and
  the exported CSV coordinates), `gain`, `camoffset` — applied inside every
  fit function as `(raw−camoffset)×gain` before fitting, see **fit** /
  **export** modules.
- **Rendering settings** (`renderBox`) — `mag`, `rblur`, `lut`, `lutpct`,
  `zcolor` (3D results only), `zmin`/`zmax` (3D results only, per-dataset
  working state, *not* in `PARAMS`). See **render** module.
- **Drift correction (AIM)** (`driftBox`) — `driftSeg`, `driftRoi`,
  `driftZ`, and **Correct drift**/**Show drift** (`driftBtn`/`driftShowBtn`).
  See **drift** module.
- **Localization precision (NeNA / FRC)** (`precBox`) — `frc3d` (UI
  placeholder, FSC not implemented), and **NeNA**/**FRC**
  (`nenaBtn`/`frcBtn`). See **locprecision** module.

### Main panels

- **Raw frame** (`raw` canvas) — the loaded stack's current frame with
  detected ROIs (green) and accepted localizations (magenta crosshairs)
  overlaid; doubles as a **plot surface** for FRC/NeNA/drift/calibration
  curves and column histograms when there's nothing to show as a frame
  (`rawIsPlot`/`rawPlotName`). `measureBtn`/`cropBtn` (line-profile and crop
  tools) live in the *reconstruction* panel's header but draw their overlay
  on whichever panel is currently a live reconstruction.
- **SMLM reconstruction** (`sr` canvas) — the accumulated super-resolution
  render, or (before a Run) a quick averaged data projection, or the 3D
  calibration curve plot (`srIsPlot`). `calViewBtn` toggles that plot between
  σ-width and phasor-magnitude views (3D calibration only).
- **Stats bar** — Frames / Localizations / Loc-per-frame / Compute (s),
  filled in after a Run.
- **Log** (`log`) — every module writes here; `clearLogBtn`/`exportLogBtn`
  clear it or save it as a `.txt` file. The single shared progress bar
  (`#bar`/`#prog`, below the action buttons) is fed by every long-running
  operation (Localize, Calibrate, drift, NeNA, FRC, file loads).

---

## 2 · Parameters (`PARAMS` registry)

Single source of truth for every analysis/render/export tunable —
`webSMLM.html`'s `params` module (`const PARAMS = {...}`, search for it
directly; this table mirrors it). `id: null` means no page control yet — only
settable via a loaded settings JSON (`paramOverrides`), and the mechanism the
future v0.10.0 headless config will reuse. Deliberately excluded from this
registry: pure CSS/layout, and per-dataset working state that resets from the
loaded stack rather than being a reusable default (`calFirst`, `calLast`,
`zmin`, `zmax`).

### Detect

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `detFilter` | Detection filter | enum | — | — | — | `wave` (options: `wave`, `dog`, `box`) |
| `detection_wavelet_thr` | Wavelet threshold (k·σ_noise) | number | 1 | 8 | 0.5 | 4 |
| `detection_DoG_thr` | DoG threshold (k·σ_noise) | number | 1 | 8 | 0.5 | 4 |
| `detection_box_thr` | Uniform box filter threshold (intensity) | number | 0 | 65535 | 1 | 25 |
| `detection_DoG_exactbp` | Exact band-pass (DoG only) | bool | — | — | — | false |
| `psf` | σ_PSF — PSF width (px) | number | 0.8 | 5 | 0.1 | 1.3 |
| `winr` | Fit radius (px) — window size = 2·winr+1 | number (int) | 2 | 10 | 1 | 4 |

### Fit

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `method` | Fit method | enum | — | — | — | `gaussmle` (options: `phasor`, `phasor3d`, `gaussls`, `gaussmle`, `mle3d`) |
| `fitFirstFrame` | First frame (1-based, inclusive) | number (int) | 1 | — | 1 | 1 |
| `fitLastFrame` | Last frame (1-based, inclusive) | number (int) | 1 | — | 1 | `Infinity` (blank field — see below) |
| `mleEps` | MLE convergence tolerance (px) | number | 1e-6 | 0.1 | 0.0001 | 0.001 |

`fitLastFrame` defaults to `Infinity`, not a finite placeholder: an
`<input type=number>` sanitizes a non-finite value to a blank field, and a
blank field reads back (via `paramValue()`'s `isFinite` fallback) as "the
whole stack" — so if `initScrub()`'s per-load reset were ever skipped, or a
user manually clears the field, the safe fallback is no restriction, never a
silent restriction down to (near-)nothing. Both fields reset to `1`/the
loaded stack's frame count on every new load. Restricting the range means
the skipped frames are never even fetched/decoded, not just excluded from
the result afterward — see the **pipeline** module / `runCore()`.

### Render

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `pxnm` | Pixel size (nm) | number | 1 | 2000 | 1 | 100 |
| `mag` | Magnification | number (int) | 4 | 25 | 1 | 10 |
| `rblur` | Render blur σ_render (px) | number | 0 | 1 | 0.05 | 0.25 |
| `lut` | Colour map | enum | — | — | — | `fire` (options: `fire`, `inferno`, `viridis`, `turbo`, `grey`) |
| `lutpct` | Display max percentile | enum | — | — | — | `99.9` (options: `99.9`, `99.5`, `99`, `100`) |
| `zcolor` | Colour by depth (z) | bool | — | — | — | false |

### Export (camera ADU→photon conversion)

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `gain` | Camera gain (photons/ADU) | number | 0.001 | 1000 | 0.01 | 1 |
| `camoffset` | Camera offset (ADU) | number | 0 | 65535 | 1 | 0 |

Applied inside every fit function itself — `(raw−camoffset)×gain` — before
the pixel is used, so `photons`/`bg`/`bgstd` downstream (table, CSV, MLE's
CRLB) are already true photon units. See the **fit** module.

### 3D calibration

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `calStep` | Calibration z-step (nm) | number | 0.1 | — | 1 | 10 |
| `calRef` | Calibration z=0 reference frame (0=auto) | number (int) | 0 | — | 1 | 0 |
| `calFixedXY` | Fix bead x,y | bool | — | — | — | false |

### Drift

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `driftSeg` | Drift segment size (frames) | number (int) | 5 | 2000 | 5 | 100 |
| `driftRoi` | Drift search radius (nm) | number | 10 | 1000 | 10 | 120 |
| `driftZ` | Correct z too (3D) | bool | — | — | — | true |

### Precision

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `frc3d` | 3D shells (FSC) | bool | — | — | — | false (not yet implemented — UI placeholder) |

### Memory / streaming

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `memgb` | Memory budget (GB) | number | 0.5 | 8 | 0.5 | 3 |
| `chunkmb` | Stream heap chunk (MB) | number | 50 | 2000 | 50 | 500 |

### Simulation

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `frames` | Simulated frame count | number (int) | 50 | 800 | 50 | 300 |
| `dens` | Simulated blink density | number | 0.003 | 0.04 | 0.001 | 0.010 |
| `phot` | Simulated photons/emitter | number (int) | 200 | 2500 | 50 | 900 |
| `driftpx` | Simulated total drift (px) | number | 0 | 30 | 0.5 | 0 |

### Pipeline behaviour

| id | Label | Type | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| `liveUpdate` | Real-time update | bool | — | — | — | true |

### Worker dispatch (no page control — settings-JSON only)

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

### Pipeline: preview / export tuning (no page control — settings-JSON only)

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

## 3 · Module reference

Mirrors the `MODULE:` banners in `webSMLM.html`, in source order. Each entry
is what to know before touching that module, not a restatement of its code.

- **params** — see [§2](#2-parameters-params-registry). `paramValue(id)` is
  the only correct way to read a parameter (handles the DOM-control vs.
  `paramOverrides` vs. registry-default fallback, plus int rounding).
- **in/out** — TIFF parsing. In-memory vs. streamed loading (`memgb`
  budget); contiguous ImageJ stacks are indexed arithmetically, multi-IFD
  (Micro-Manager MMStack) stacks by walking the IFD chain — never fully
  loaded, read via `File.slice()`. `loadTiffSequence()` accepts a multi-file
  selection (several single-frame TIFFs), natural-sorted by filename and
  decoded/concatenated into one stack.
- **simulation** — the built-in synthetic stack generator ("Simulate
  movie"). Demo/validation/teaching data, not a core analysis path; stores
  the true per-frame drift (`simTrueDrift`) for scoring drift correction.
- **detect** — per-frame band-pass, one of three filters selectable via
  `detFilter`: wavelet (default), DoG, or uniform box — each thresholded
  differently (see [§2](#2-parameters-params-registry)/Detect). `detectSpots()`
  is the single dispatch point used by both the main thread and workers.
- **fit** — phasor (fast, non-iterative), Gaussian least-squares, and
  Gaussian Poisson-MLE 2D/3D (`gaussianMLE`/`gaussianMLEastig`, the
  default). All convert ADU→photons via `gain`/`camoffset` before fitting.
  MLE fitters reject a candidate outright (return `null`) rather than
  keeping a degenerate result: not converged within the iteration budget,
  amplitude pinned at the enforced floor (background mistaken for a spot),
  or a non-finite CRLB (singular Fisher matrix). `gaussianMLEastig` also
  returns `lpsx`/`lpsy` (fit precision of the σx/σy widths), consumed by
  `zFromWidths()` to estimate `lpz` — an approximate z-precision via error
  propagation through the calibration curve's local slope (not a true joint
  CRLB, since z isn't a parameter of the pixel-level fit).
- **render** — accumulates localizations into an offscreen buffer `srFull`;
  a `view` (zoom/pan) transform draws the visible region + scale bar. Colour
  maps, blur and display scaling apply without refitting. `srIsRecon` tracks
  whether `srFull` is the real per-localization reconstruction (vs. the
  pre-Run data projection or a calibration bead composite) — gates the crop
  tool and the nm-per-pixel conversion (`srNmPerPx()`).
- **export** — ThunderSTORM-compatible CSV, see [§6](#6-csv-export-format).
  `photons`/`bg`/`bgstd` are already true photon units by the time they
  reach export (conversion happens inside the fit) — export does no further
  conversion, only warns when gain/offset look like they were never set.
- **workers** — frame-parallel detect/fit. Workers are **not** separate
  files: `workerSource()` builds worker code by stringifying the exact
  functions the main thread uses, so any module-level `let`/`const` a
  stringified function reads must also be re-declared in `WORKER_PRELUDE`, or
  the worker throws and silently falls back to single-threaded. Batch sizing
  is controlled by the `workerBatch*`/`workerMin*` params above.
- **3D calibration** — astigmatic σ_x/σ_y-vs-z curves from a bead z-stack;
  astigmatism is the only 3D method implemented (Double Helix/Biplane would
  live here too, per `docs/REFACTOR_PLAN.md`). Every bead is fit both by LS
  (real σ_x/σ_y) and phasor (magnitude ratio), so a saved calibration file
  can carry both models, tagged, with a guard stopping a 3D fit from running
  against the wrong one. **Fix bead x,y** (`calFixedXY`) freezes each bead's
  lateral position from a composite of the calibration range before fitting
  widths per frame — see [§7](#7-calibration-json-format).
- **drift** — AIM (adaptive intersection maximization), point-based, no
  FFT, 2D+z. Segments localizations in time (`driftSeg`), grid-searches the
  shift that maximizes coincident localizations against the accumulated
  reference (`driftRoi`), then a parabolic sub-pixel peak refine.
- **locprecision** — NeNA (nearest-neighbour precision, Endesfelder fit)
  and FRC (Fourier ring correlation image resolution, inline radix-2 FFT).
  Marked **experimental**, not yet cross-validated against established
  tools. FRC's sampling grid size is derived from a 3-tier fallback (NeNA
  precision σ/2 → per-localization-precision histogram mode → reconstruction
  pixel size), with NeNA rejected if implausibly larger than the mode tier
  (a sign clustering has removed the genuine repeat-detection pairs NeNA
  needs, letting its fit latch onto inter-molecule spacing instead).
- **pipeline** — top-level orchestration wiring the UI buttons to the
  modules; `run()` is the Localize entry point.
- **table** — the sortable, cumulatively-filterable localizations table
  ("View data + filtering") and per-column histograms, see
  [§5](#5-table--filter-grammar). `getBaseLocs()` is the single place that
  decides whether the table's base row set is raw `lastResult.locs` or
  `clusterEvents()`-derived merged events; everything downstream (render,
  export, NeNA, FRC) is unaware of the distinction.

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

Opened by **View data + filtering**. Base row set is `getBaseLocs()` — raw
localizations, or (if a `tempClusteringXY`/`tempClusteringZ` clause is
active) merged events from `clusterEvents()`.

**Columns** (present depends on the result): `id`, `frame`, `x`, `y`, `z`
(3D only), `sigma_xy`, `sigma_z` (MLE 3D only, an approximate z-precision —
not available for Phasor 3D), `intensity`, `offset`, `bkgstd`, `uncertainty`,
`nmerged` (only once clustering is active).

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
"id","frame","x [nm]","y [nm]",["z [nm]",]"sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"[,"sigma_z [nm]"][,"n_merged [frames]"]
```

- `z [nm]` only present for a 3D result.
- `sigma [nm]` is kept under that literal name (not `sigma_xy`, which the
  in-app table uses) specifically for ThunderSTORM compatibility.
- `sigma_z [nm]` (MLE 3D, when available) and `n_merged [frames]` (when
  temporal clustering is active) are webSMLM-specific additions appended
  after the standard columns — safe for a strict ThunderSTORM reader to
  ignore.
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
  bounding box (+10 px margin), not the original stack's actual dimensions.

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
  "sigma_x_nm": { "a": ..., "c": ..., "b": ..., "A": ..., "B": ..., "C": ... },
  "sigma_y_nm": { "a": ..., "c": ..., "b": ..., "A": ..., "B": ..., "C": ... },
  "phasor_ratio": { "a": ..., "c": ..., "b": ..., "A": ..., "B": ..., "C": ... },
  "phasor_z_from_ratio": { "coef": [...], "basis": "ratio", "rmin": ..., "rmax": ..., "rms_nm": ... },
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

## 8 · Headless API (`window.webSMLM`) — v0.10.0-dev

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
  multi-file-sequence support as Ctrl/Cmd+click **Load movie**), loaded via
  the existing `loadTiffFile`/`loadTiffSequence`. One of the two is required.
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
- `config.onProgress(pct)` — optional, called the same way `setProg()` would
  be interactively (0–100), for a driving script's own progress reporting.
- `config.onLog(msg)` — optional, called for every line `analyze()` would
  otherwise only collect into `logText` — a driving script can watch the run
  live instead of waiting for the whole thing to finish and reading
  `result.logText` after the fact. Every hook inside the pipeline
  (`loadTiffFile`/`loadTiffSequence`, `runCore`, `driftCore`,
  `frcResolution`, `calibrationCore`) defaults to the real interactive
  `log()`/`setProg()` when not given one explicitly, so nothing that would
  show in the interactive Log window goes missing headlessly — `analyze()`
  just always supplies its own collector, whether or not you also supply
  `onLog`. `onLog` carries diagnostics/summaries only, not progress — a
  numeric-only percentage adds nothing once read back as text (tried, then
  reverted: it just repeated the same handful of numbers for every phase
  with no other information), so `onProgress` is the only progress channel.

**Returns** `{locs, csvText, logText, settingsText, timings, reconstructionPng, drift, nena, frc, w, h, px, mag, calib, calibJsonText}`:
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
- `correctDrift`/`computeNeNA`/`computeFRC` work as `=1`/`=true` flags too,
  same as passing them to `analyze()` directly.
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
`summary.json` (localization count + timings + drift/NeNA/FRC results) to
`--out` — which defaults to a `webSMLM-out` folder **next to `--file`**, not
wherever the shell happens to be, unless given explicitly. Any `--key=value`
not listed in the script's header comment is passed straight through as a
`PARAMS` override (§2) — e.g. `--winr=6 --gain=0.1248 --camoffset=100`;
`--correctDrift`/`--computeNeNA`/`--computeFRC` are bare boolean flags;
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
