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
`webSMLM.html` (~18,500 lines). It loads a raw movie, detects/localizes emitters and renders a
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
equals the given file). The former `cell_field_sim/` prototype, its viewer and `DEMOCAM_PORT.md` live in
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
  no control and resolve via `paramOverrides`. Excluded: display/layout (CSS) and per-dataset working
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
  - **Rotate movie** (`rotateMovie`, 0/90/180/270° clockwise, in "Memory, Rotation, GPU & streaming"):
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

- **simulation** — the built-in synthetic stack generator ("Simulate movie"): demo/validation/
  teaching data, not a core analysis path. Split out from in/out since it doesn't load anything.
  `simulation_psfModel` (`'zernike'` default, or `'gaussian'`) picks the emitter PSF: `'gaussian'`
  is the original fixed-`sigma=1.3` isotropic render; `'zernike'` splats each emitter from the same
  oversampled, physically-modelled Gibson-Lanni+Zernike kernel the PSF preview builds (see
  `docs/VECTORIAL_ZERNIKE_PSF_IMPLEMENTATION.md` §10). With `simulation_3d` on, each emitter is
  splatted from the **nearest kernel z-plane** (quantizing its depth to ± half the z step, 2.9 nm
  RMS at the default — two orders below the fit's own axial error); with it off, one fixed
  `simulation_psfDepth` applies to the whole movie. A two-plane linear blend was built and then
  removed on measurement: blending two PSF *intensities* is not interpolating the PSF's *width*,
  which is what an astigmatic fit reads z from, so it cost 1.74× the simulation time for no
  measurable gain at a fine z step and was measurably worse at a coarse one. **Don't reintroduce
  it without a width-aware interpolation** (a spline through the z-stack would do it properly).
  `simulation_structureType` picks the object emitters attach to — the microtubule cell field
  (default), the original filaments+ring, the NPC model, or one of three that sample z independently of x/y (the filaments' single sine drives both their y and
  their z, so a z error can't be told apart from a y error — and their 1-D crowding inflates the
  measured lateral spread by ~50% at equal density, `uniform3D` being the one to quote figures
  from). **`simulation_3d` means exactly one
  thing**: `buildStructure()` always builds in 3D and flattens every z to 0 when it is off, so the
  lateral geometry is identical either way and every control, log line and plot applies unchanged
  in both states — don't reintroduce a separate 2D structure path. It defaults to on and has no
  sidebar control since 2026-09-28b (settings JSON / `paramOverrides` only).

  **Sidebar layout (2026-09-28b)**: top level = Structure type (+ Move view for microtubules),
  Frames, Emitter density preset, Physics detail preset, View GT; sub-groups Sample / Fluorophore /
  Background / Camera / PSF / Advanced / Score vs truth. Every `label.row` in `simBox` carries a
  `title` hover tip — keep it that way for new rows. A sidebar label and its PARAMS `label` are the
  same string; only fields that collide with an analysis-side label (pixel size, gain, offset) carry
  a "Simulated" prefix.
  `buildPsfKernelStack()` reports `zUsableNm`, how far either side of focus the PSF encodes z
  *single-valued* (measured per plane with `gaussianFitElliptical()`, the same fitter 3D
  calibration uses). Past it σy/σx turns back, two z values share one width pair, and
  `zFromWidths()` silently picks one — its `clamped` flag only guards the calibrated range's
  EDGES, not that ambiguous interior. `simulation_psfInterp` (`'nearest'|'linear'|'cubic'`(default)`|'fft'`) selects how
  `splatZernikeEmitter()` interpolates the oversampled kernel at each emitter's exact sub-pixel
  position before SUMMING (not averaging — each kernel entry is a probability mass, so summing is
  what conserves photon count) the sub-cell samples down to the camera pixel grid — the "oversample
  once, downsample everywhere" placement both `docs/VECTORIAL_PSF_SIMULATION.md` and the Zernike
  implementation doc's own §5 call for. **It computes that in swapped order**: every sub-cell of
  one emitter sits at the same fraction between kernel grid points (they are whole grid steps
  apart), so they share one set of interpolation weights, and "interpolate each of the os²
  sub-cells, then sum" equals "sum each os×os kernel block once per plane (`buildSummedKernel()`),
  then interpolate that once per camera pixel" — 16 reads instead of 256 for cubic at oversample
  4. It matches the old per-sub-cell algorithm to 3e-8 of peak in all four modes, edges included
  (`tests/gpu/test-sim-gpu.mjs` (b), which carries the old algorithm as its reference), and made a
  64 px × 50-frame movie 569 → 50 ms (2D cubic) and 1309 → 148 ms (3D). `simSplatSetup()` is the
  one place the per-emitter indices and weights are computed, shared with the GPU packer. Block
  sums are Float32 (what the GPU holds too), and only the planes some emitter uses are prepared
  (`prepareSimKernelPlanes()`, a sparse array) — preparing all 401 used to structured-clone
  ~186 MB into each of up to 12 sim workers. Downstream of filling `img` (shot noise, read noise,
  gain/offset — `applySimCameraNoise()`) is identical for both PSF paths.

  **`simulation_fov`** (default 128px, square) replaced a previously-hardcoded `w=128,h=128` at
  BOTH `generateSynthetic()`'s and `generateCalibrationStack()`'s own top — the one true source
  of the simulated camera's field of view now, no other hardcoded `128` remains for it anywhere
  in the file (checked). **`simulation_labelEfficiency`** (%, default 70) is applied exactly ONCE,
  right after `buildStructure()` returns, as a seeded random keep/drop filter over its candidate
  site list (`gtAll` → `gt`) — BEFORE the Poisson emitter-arrival process ever gets to pick a
  site, so a dropped site can never light up at any frame, not just less often; matches real
  labeling chemistry (antibody/SNAP/Halo/FP) never reaching 100% of its target. Structure-type
  agnostic by construction (filters whatever `buildStructure()` returned, regardless of which
  generator produced it) — meaningful for any discrete-site structure (NUP) and harmless (if less
  physically interesting) for the continuously-sampled filament/ring points.

  **`simulation_structureFov`** (px, no static default that matters in practice — see below;
  boilerplate laid down 2026-09-22, deliberately no sidebar control) decouples the STRUCTURE's
  own footprint from the camera's `simulation_fov` — two independent
  sizes rather than the structure always being generated to exactly fill the visible frame.
  `generateSynthetic()` calls `buildStructure(structFov, structFov, zRange, rng)` against this
  separate size, then recentres every returned `[x,y,z]` point by `structShift=(structFov-w)/2` in
  x and y, so the structure's own centre and the camera FOV's centre coincide regardless of which
  is bigger. **Since build 2026-09-22c, the applied default (when nothing overrides it) is
  `Math.round(w*1.1)` — 10% LARGER than the camera FOV, not equal to it** — computed fresh in
  `generateSynthetic()` itself, not read from the PARAMS registry's own static `default:128` (that
  field only matters once an explicit override is present — see the PARAMS entry's own comment).
  The point: every simulation now has real structure sitting just outside the frame from the
  start, so **Drift (px, total)** reveals something by default with no setup step required.
  `structShift=0` only when `simulation_fov` and an EXPLICIT `simulation_structureFov` override
  happen to be equal — `buildStructure(w,h,...)` then runs exactly as it did before this feature
  existed, no shift applied at all — positive (now the default) when the structure is LARGER (its
  edges then fall outside `[0,w)x[0,h)` on every side, so only the centre portion is ever imaged —
  combine with **Drift (px, total)** (`driftpx`,
  which already moves the sample under a fixed camera via `splatSimFrame()`'s `mx=ex+drx`, the
  sample-relative-to-camera convention) to have different parts of it drift into view over a
  movie), negative when the structure is SMALLER (the whole thing then sits inside the frame with
  empty camera area around it, e.g. to simulate a small labelled patch on an otherwise-blank
  coverslip). No per-type generator needed to change: `buildStructure()`'s dispatcher already
  forwards whatever `w,h` it's given with no special-casing (see its own comment), and every
  downstream consumer of an out-of-camera-FOV point already discards it safely with no new code —
  `splatSimFrame()`'s Gaussian path (`if(x<0||y<0||x>=w||y>=h) continue`), `splatZernikeEmitter()`
  (its own `Y`/`X` bounds checks), `illumAt()` (clamps to the nearest edge pixel rather than
  reading out of bounds), and `buildSimBackgroundMap()`'s haze-density pass
  (`if(x>=0&&y>=0&&x<w&&y<h)`) were all already bounds-safe before this existed, checked one at a
  time rather than assumed. **`dens`'s own arrival-rate math (`areaUm2`) uses `structFov`, not the
  camera FOV** — a deliberate correctness choice, not an oversight: density is a property of the
  sample, so `dens` means the same emitters-per-µm² whether the structure is bigger, smaller, or
  the same size as the visible frame; only the FRACTION of arrivals that ever gets imaged changes
  with the camera FOV, exactly as it should. `simulation_labelEfficiency` is unaffected — it's
  still a plain keep/drop filter over whatever candidate list `buildStructure()` returns,
  independent of either size. **`validation`**'s `scoreTruthCore()` needed no change — a truth
  event's position is just a number to it, so a structure point that never entered the visible FOV
  in ANY frame is simply never counted at all (never a frame-border "don't care" case, since it's
  never inside a frame to begin with), which is the correct behaviour, not a gap. The debug
  single-NUP viewer and **View GT localizations** call `buildStructure()`/read
  `groundTruthEvents` independently of this and are unaffected either way. Genuinely next: nothing
  yet drives `driftpx`'s direction/magnitude to systematically explore a larger structure's margin
  (it's still one random straight line), and no UI/log line reports how much of a larger structure
  a given run's drift path actually swept into view.

  **Structure type** (`simulation_structureType`, `'microtubules'` default, `'filaments_ring'`,
  `'nup'`, or one of `'tiltedPlane'`/`'uniform3D'`/`'shell'`) picks
  which ground-truth structure `buildStructure()` generates — a plain dispatcher now, over
  `buildFilamentsRingStructure()` (the original 3-filament+ring layout, unchanged) or
  `buildNupStructure()` (nuclear pore complexes). Both return the same shape (an array of
  `[x,y,z]` candidate emitter sites, x/y camera px, z nm), so nothing downstream of
  `buildStructure()` — the Poisson emitter-arrival process, per-frame splat/noise — needed to
  change for a new structure type; a future structure type is just a third case in that switch.

  **Microtubule structure** (`'microtubules'`, `buildMicrotubuleStructure()` → `CellField.buildWindow()`,
  MODULE: simulation, right above the NUP block) is the generated insiliscope block (see **CellField**
  above): `buildWindow(w, h, {seed, xUm, yUm, pxnm, mtDensity, cellDensity, focusUm, slabNm})` →
  `{sites, nCells, nMt, removed: null, packed}`. Its WASM module is instantiated synchronously on first use;
  main thread only here (`CellField.workerSource()` exists if a worker ever needs it). Cells are packed on
  fixed 8×8-chunk blocks (not per window), so a pan never re-packs. `simulation_mt_seed` (default 1249) picks the world; `simulation_mt_x`/`_y` (µm, default 0,0) are
  the window centre, moved by the **Move view** row (step selector + four arrows, `moveMtViewStep()` →
  `moveMtView()`, +y is down, written to `paramOverrides` and logged); the window is the
  structure FOV (px × `simulation_pxnm`), so 128 px at 100 nm is the central 12.8 µm (+10% margin).
  Seed, X/Y, `simulation_mt_cellDensity` (cell occupancy, default 0.33) and `simulation_mt_density`
  (microtubules/µm², 0.9) are id:null — no sidebar field; every other cell/cytoplasm knob stays at the block's defaults (webSMLM's former `CF_PARAMS`; cytoplasm: rim 0.1–0.3, edge rise 0.1–0.5, mid
  height 1–2, mid distance 0.1–0.3 × radius, `nucMargin` 0.6, mesh 60 rings × 128 angular samples, 12 smoothing passes). `simulation_mt_focusZ`
  (nm above the coverslip = z 0, the surface the cells lie on; default 250) is the one sidebar field (Focus height, under Sample).
  **Cell contrast is forced to 1 (off) for this structure** in `generateSynthetic()` and its field disabled
  in the UI: the contrast field's ellipse "cell" has nothing to do with the CellField's cells. A later
  update is to drive the background from the real cell footprints.
  Each microtubule centreline is decorated with the 13_3 lattice (25 nm cylinder, 12 nm binder, dye at a 2–5 nm
  uniform-in-volume linker offset) and **every dye is one candidate emitter site**, so blinking happens on the
  dyes; `simulation_labelEfficiency` still thins them afterwards. Only the 1 µm lattice blocks that can
  reach the window are decorated (a full network is millions of sites), and every dye is addressed by
  (seed, cell, microtubule, block), so its position doesn't change when the window moves. Sites are clipped to ±`simulation_zRange` around the focus
  height (an optical section that keeps them inside the PSF kernel's z range). Consumes nothing from the simulation's `mulberry32` stream.

  **NUP structure** (`buildNupAttachmentPoints()`/`displaceByLinker()`/`buildNupLocalPoints()`/
  `buildNupStructure()`) models the endogenously SNAP-tagged Nup96 nuclear pore complex (NPC)
  reference standard from Thevathasan et al., *Nat. Methods* 16, 1045–1053 (2019),
  DOI:10.1038/s41592-019-0574-9 — 8-fold symmetric ring (`simulation_nup_radius`, default 53.5 nm,
  the paper's measured value), 8 corners of 4 Nup96 each — arranged in a half-circle ARC bulging
  outward from the ring (`NUP_CORNER_ARC_ANGLES`, four points spread across 180°), not a 2x2
  square (a first version got this wrong — corrected against the paper's own Fig. 1e, which shows
  the real cluster shape), diameter `simulation_nup_cornerSpread` (default 12 nm, matching the
  figure's own ~12 nm corner-cluster scale vs. ~42 nm corner-to-corner spacing) — 2 rings
  along the pore axis (`simulation_nup_ringSeparation`, default 50 nm = the user's "25 nm
  above/below") = **64 attachment points per NPC**. Only `simulation_nup_count` has a sidebar field;
  the geometry PARAMS are id:null (paper values, changeable via settings JSON/`paramOverrides`), following the parametrized-NPC-simulation approach of Wanninger et al. ("CIR4MICS"),
  *Bioinformatics* 39(10), btad587 (2023), DOI:10.1093/bioinformatics/btad587. Each attachment
  point is then displaced by `displaceByLinker()` — a uniform-in-volume radius between
  `simulation_nup_linkerLengthMin`/`Max` (default 2–5 nm), uniform direction on the sphere — to
  get the actual emitter position, modelling the real fluorophore (SNAP/Halo+dye, or antibody)
  sitting some finite distance from its Nup96 attachment site rather than exactly on it.
  `buildNupStructure()` scatters `simulation_nup_count` NPCs over a small membrane patch
  (rejection-sampled for `simulation_nup_minSpacing`, each with a random azimuthal rotation), then
  maps each NPC's local `(a,b,c)` frame (ring plane `a,b`; pore axis `c`) into world
  `[x,y,z]` with the pore axis along the optical (Z) axis — ring plane → world X,Y, ring separation
  + a gentle `simulation_nup_curvature` bowl (mean-subtracted, centred at ~0) → Z. (A `sideways`,
  edge-on orientation existed and was removed in 2026-09-28b.) `buildNupStructure()`'s own `rng` parameter is the
  SAME seeded `mulberry32(simulation_seed)` stream `generateSynthetic()` already threads through
  `buildStructure()`, so a seeded Simulate-movie run reproduces the identical NPC layout too.

  **GT localizations viewer** (`groundTruthLocs`/`gtShowing`/`srFullBeforeGT`/`srTitleBeforeGT`/
  `srInfoBeforeGT`, module-level; `viewGtBtn`/`viewGtBtnRow`, MODULE: pipeline) — after a
  successful Simulate movie, `groundTruthLocs` is built from `groundTruthEvents` (one
  `{x,y,z,photons}` entry per simulated BLINK, not per structure site — the fair comparison
  against a real reconstruction's own per-blink localizations). Each entry ALSO carries a fixed
  `lpx:lpy:1/px` (native camera px equivalent of 1 nm, `px` = `simulation_pxnm`/`stack.px`) — a
  real, reported bug otherwise: with no `lpx`/`lpy` of their own, `renderSuperResPixels()`'s
  'precision'/'dither' render modes fall back to the whole-dataset `rblur` (Render blur σ_render,
  the same knob a REAL fit's own localization precision typically needs), rendering GT markers as
  blobs several times too large — these are the true simulated positions, not a fit with real
  uncertainty, so a 1 nm precision (a crisp point at any realistic magnification) is the correct
  fixed value. `viewGtBtn`'s own click handler passes the SAME `1/stack.px` as the `blurPx`
  fallback argument to `renderSuperRes()` too (rather than `paramValue('rblur')`), covering
  'fixed' render mode as well, which never consults `lpx`/`lpy` at all. **`viewGtBtnRow`'s HTML
  sits in the Simulation panel's top-level rows** (shown for ANY structure type) — genBtn's handler toggles
  `viewGtBtnRow.style.display`, not the button's own (the button carries no inline style of its
  own now that it's wrapped in a `label.row`).

  Clicking **View GT localizations** renders `groundTruthLocs` into `srFull` via the SAME
  `renderSuperRes()` call `rerender()` makes — **including its depth-colour (z) handling**, not
  just a flat density render (a real, reported bug: the first version hardcoded `zColor=false`
  regardless of real per-emitter z, e.g. from a 3D NUP simulation). Mirrors `rerender()`'s own
  logic exactly: auto-checks **Colour by depth (z)** + picks the `turbo` LUT the first time a
  given `groundTruthLocs` array turns out colourable (`_zColorAutoChecked` flagged directly on
  the array, same "flag on the data object" trick `lastResult._zColorAutoChecked` uses), computes
  zlo/zhi via `zRange()` (cached as `groundTruthLocs._zr`, same per-object-cache idea as
  `lastResult.zr`), shows/hides `zcolorRow`/`zrangeRow`, and stamps `srFull._zColor`/`_zlo`/`_zhi`
  on the returned canvas so `drawView()`'s own `srFull._zColor` check draws the depth-colour bar
  for a GT render exactly as it would for a real one. Stashes/restores whatever `srFull` (AND its
  `$('srTitle')`/`$('srInfo')` text, `srTitleBeforeGT`/`srInfoBeforeGT`) held before — swaps
  `srFull` directly rather than going through `lastResult`, since `lastResult` is `null`
  immediately after Simulate movie, before any Localize run; hiding GT with no `lastResult` and no
  stashed `srFull` re-runs `showStackProjection()` rather than leaving a blank canvas mislabelled
  "Ground truth", and always hides `zcolorRow`/`zrangeRow` again in that fallback path (GT's own
  depth-colour state has no home once there's no real result or prior render to fall back to).

  **`$('zmin')`/`$('zmax')` are SHARED text fields** with the real reconstruction's own zmin/zmax
  auto-fill (`rerender()`, only fills them when EMPTY, by design — see its own comment — so a
  user's manual override persists across settings-change re-renders of the SAME result).
  `genBtn`'s click handler now explicitly clears both (`$('zmin').value=''; $('zmax').value='';`)
  — a real, reported bug otherwise: nothing cleared them on a fresh Simulate movie, so clicking
  **View GT localizations** right after could silently inherit zmin/zmax LEFT OVER from a
  completely unrelated previous dataset (an earlier real Localize result, or an earlier Simulate
  movie run) — GT's own `if($('zmin').value==='')` auto-fill guard (same pattern `rerender()`
  uses) then saw them as already-set and never recomputed, clipping the depth-colour range to
  values that had nothing to do with the new simulation. `run()` (Localize) already cleared them
  at its own start for the same reason (real dataset vs. real dataset); `genBtn` needed the exact
  same reset for GT vs. GT (or GT vs. real, either direction).

  **Engineered PSFs (2026-09-20).** The Zernike vector is `PSF_NZERNIKE`=28 (n≤6); the first 15
  are untouched and a 15-value custom string is zero-padded, so older files mean what they meant.
  `saddlePoint`/`extendedRange`/`extendedRangeStrong` stack astigmatism at j=5/13/25 (primary/
  secondary/tertiary — verified with `psfIndexToNM`, never assumed) and are named for the measured
  trade (focal z-CRLB 12.6/23.6/23.9 nm for single-valued ranges ±700/±1000/±1300 nm, against
  10.1 nm/±500 nm for `astigModerate`). **They are deliberately NOT called tetrapods**: the
  published masks are optimisation output with a four-lobe shape these do not have (measured: one
  lobe at focus, three at ±1.5 µm). Don't rename them back without the coefficients and a shape to
  show for it. `pupilMaskPhase()` is the separate, non-Zernike term: a real double helix, i.e. the
  phase of a Gauss-Laguerre superposition along l=2p+1 (Pavani & Piestun), measured rotating 60°
  over ±800 nm with ~11% of the light in the two lobes. A concentric-vortex-zone approximation was
  tried first and replaced; its "rejected on measurement" note was itself measured through the
  broken worker path (see the 20260920g entry below), so it proves nothing — the GL construction
  stands on being the published one. The mask is
  called from BOTH pupil builders (polar and Cartesian/FFT) and `laguerreL`+`pupilMaskPhase` are
  both in `psfWorkerSource()`'s list — miss that and the PSF pool dies on a ReferenceError.

  **`psfZCramerRao()` is the PSF-agnostic replacement for `zUsableNm`'s role.** `zUsableNm` follows
  σy/σx and reports 0 for a double helix, which encodes z in an ANGLE; the CRLB asks only how much
  the image changes per nm of defocus, over the same 5-parameter Fisher matrix [x,y,N,bg,z] a
  PSF-model fit would build (N and bg marginalised — fixing them quotes a precision nobody can
  reach). It is the bound a fitter is judged against: the astigmatic 3D run's 23.4 nm axial median
  sits 2.4× above its ~10 nm bound.

  **Photophysics, background and the byte-identity rule (2026-09-19).** Blinking is a per-molecule
  three-state model (ON ⇄ dark → bleached: `simulation_blinkBleachProb`, `simulation_offLifetime`)
  with a log-normal per-blink brightness (`simulation_photCV`), all generated by one
  `spawnMolecules()` closure inside `generateSynthetic()`. **`dens` must keep meaning "mean emitters
  ON per µm² per frame" under any kinetics** — molecules activate at `dens·area/(lifetime·meanBlinks)`
  — or the density presets mean something different per setting. Brightness rides in on the
  per-frame overlap weight `splatSimFrame()` already multiplies by, so variable brightness needed
  no worker change. Background: `simbg` stays the **FOV mean**; `buildSimBackgroundMap()` (cell
  field + static haze, normalized to that mean) and `simBgScale()` (fade to a 30% floor) only
  reshape it, and `splatSimFrame()`'s `bg` is a number **or** `{map,scale}`. `simulation_hazeRatio`
  adds a second blinking population 0.3–2 µm out of focus through the ordinary kernel-stack splat
  (a separate FFT convolution layer was planned and dropped: at the depths where it would pay off
  the PSF is wider than half the frame, which the static haze already covers).
  **The rule all of this obeys: with the Physics detail preset (`simulation_realism`) on `min` and every other new parameter
  at its old default, a seeded movie is byte-identical to the 2026-09-21b build** (the baseline
  moved once, deliberately, when camera noise went counter-based — see below; before that it was
  2026-09-08b). Since 2026-09-21f the shipped defaults are the `med` preset's values
  (`simulation_realism:'med'`, so bleach 0.2, CV 0.5, `simbg` 10, cell contrast 3, haze 1, fade
  150), `simulation_zRange` 500 and `simulation_nup_count` 100 — the byte-identity baseline is
  therefore NOT the out-of-the-box state any more; select Basic (and zRange 1000 / 20 NPCs where
  relevant) to reproduce it. **Since 2026-09-28b the out-of-the-box state moved again**: structure
  `microtubules` (the baseline used `filaments_ring`), `simulation_3d` on (the baseline was 2D; it
  now has no sidebar control), `simulation_zRange` 1000 and 1000 frames — reproducing the baseline
  also needs `paramOverrides.simulation_3d=false` and the structure/frames set back. The density preset is `low`/`med`/`high`/`veryhigh` = 0.05/0.2/0.5/2, default `med` (`dens` 0.2;
  the old default was 0.05). **Since 2026-09-22c, `simulation_structureFov`'s own default
  additionally breaks this baseline on its own, independent of the Physics detail/density presets**: with
  no explicit `paramOverrides.simulation_structureFov` override, every `generateSynthetic()` call
  now builds its structure at `Math.round(simulation_fov*1.1)`, not `simulation_fov` itself (see
  that PARAMS entry's own comment) — so even Minimal-preset reproduction of the pre-2026-09-22
  baseline additionally needs `paramOverrides.simulation_structureFov=128` (or whatever
  `simulation_fov` is set to) set explicitly first; there is still no sidebar control for it. New
  random draws
  therefore live ONLY in branches the defaults never enter (the original single-blink loop is kept
  verbatim beside the new one for exactly this reason), and background/haze each draw from their
  OWN stream derived from the seed, after all emitter draws — so switching them on never moves an
  in-focus emitter, and their effect can be measured on otherwise identical data. Re-check with a
  pixel hash after touching any of it. **Camera noise is its own, counter-based stream**:
  `makeSimNoiseRng()` addresses every draw by (noise seed, frame, pixel, counter) through pcg4d
  (Jarzynski & Olano, JCGT 2020), so a pixel's noise depends on nothing but its address — any
  worker, batch order or GPU thread gives the same pixel, and `WGSL_SIM_NOISE_FNS` (MODULE: gpu)
  reproduces the u32 stream bit for bit. The draws (`simNoiseGauss`/`simNoisePoisson`/
  `simNoiseGamma`: plain two-uniform Box-Muller, inversion up to λ=60 then normal,
  Marsaglia-Tsang) are written once in JS and mirrored line for line in WGSL; change one, change
  both. The old per-frame mulberry32 noise stream could not be ported (Poisson inversion, a
  rejecting Box-Muller and the `_g` spare made pixel i's numbers depend on every earlier pixel).
  The emitter/event stream is untouched (`mulberry32(simulation_seed)`); an unseeded run draws a
  random noise seed.
  **EMCCD (2026-09-20).** `simulation_cameraType` (`'scmos'` default, `'emccd'`) switches
  `applySimCameraNoise()`'s first two steps: photons → photoelectrons (`simulation_qe`) plus
  `simulation_cic`, Poisson, then the gain register as `simNoiseGamma(n)` (Marsaglia-Tsang, scale
  1, in `simWorkerSource()`'s own function list — forget a noise helper there and the pool dies on
  a ReferenceError), read noise divided by `simulation_emGain`, integer ADU clipped at
  2^`simulation_bitDepth`−1. **Poisson compounded with Gamma has variance 2λ** — that IS the √2
  excess noise, not an added fudge (measured: variance/mean 2.00 vs 1.08 on sCMOS). Scale 1
  instead of a literal EM gain keeps `simulation_gain` meaning photons/ADU end-to-end and the ADU
  scale comparable across sensor types. The whole sensor model travels as ONE `cam` bundle
  (`readSimCameraModel()`) through `simCtx`/`calibCtx`, both init messages and the GPU spec.

  **Simulation on the GPU (2026-09-21).** The frame stage has a device path, through
  `runStage()` (`STAGE_META` `simFrames`), taken whenever `useGpu` is on and the
  engine is up — no size threshold and no separate setting (an `auto`/`always`/`off` option and a
  crossover existed for one build and were removed: the GPU won every case measured, and the
  smallest jobs lose only tens of ms of dispatch overhead; unchecking Use GPU acceleration is the
  way back to the CPU).
  **Frames**: `WGSL_SIM_FRAMES` fuses splat and camera noise, one thread per (pixel, frame), as a
  GATHER over that frame's emitter list in list order — no atomics, and the CPU's own summation
  order. The CPU packs each emitter with `simSplatSetup()`'s indices and weights, so the device
  interpolates the same Float32 block sums with the same weights. Batches keep each output
  ≤64 MB, and batch k+1 is packed and submitted before k is read back. `simulateFramesGpu()` and
  `simulateCalibFramesGpu()` are thin spec builders over one `gpuSimFrames()`. 'fft' placement
  and the Gaussian model have no kernel. The PSF build (chirp-Z, already worker-parallel) has no
  GPU path. **Agreement** (`tests/gpu/test-sim-gpu.mjs`): pcg4d and the uniforms bit-exact over 393k
  values; GPU splat = CPU to 1.3e-7 of peak; GPU noise = CPU noise on 100% of pixels within
  1e-3 ADU (sCMOS: f32 read noise, ≤1.7e-4 ADU; EMCCD: identical); the same seeded 3D movie with
  haze and a structured background generated on the CPU pool and on the GPU agrees on 100%
  (sCMOS) / 99.999% (EMCCD: one pixel one count apart, an f32/f64 Poisson boundary) of pixels.
  **Measured** (`tests/gpu/bench-simulation.mjs`, i7-1355U +
  Intel Iris Xe, warm, median of 3, against the NEW CPU splat on 8 workers):

  | Case | CPU ms | GPU ms | Speedup |
  |---|---|---|---|
  | 2D cubic 128² × 100 | 321 | 47 | 6.9× |
  | 3D cubic 128² × 100 | 653 | 60 | 10.8× |
  | 2D linear 128² × 100 | 273 | 36 | 7.6× |
  | 2D 0.3 em/µm², 128² × 50 | 843 | 54 | 15.6× |
  | 2D 256² × 50, bg 20 | 1155 | 67 | 17.1× |
  | EMCCD 128² × 100 | 435 | 35 | 12.6× |
  | Calibration stack 128², 41 planes | 152 | 34 | 4.4× |

  Cold (first use per page session) adds the pipeline compile, ~60–100 ms here, plus, once, the
  engine's own start-up (~1–2 s, shared by every GPU stage; the log line says when a stage paid
  it). A dedicated GPU should gain more, and the headroom is in the heavy cases (`--full`: default
  300-frame movies, dense, 512²) this laptop was not run on.

  **The PSF has one evaluator, chirp-Z; the 'direct' polar quadrature was removed (2026-09-21e)
  because it was wrong.** It had a GPU port for one build, which is how this came up. The polar
  quadrature samples the pupil at `PSF_N_PHI`=40 angles, which resolves exp(i·k·r·cos φ) only while
  k·NA_eff·r stays below ~N_PHI/2, i.e. out to ~1.6 µm at 660 nm / NA_eff 1.33; past that the sum
  aliases. On the default 6 µm kernel (unaberrated, one plane) 'direct' puts **17%** of the light
  beyond 3 µm (the square's corners) and 20% beyond 1 µm; 'fft' puts 0.17% / 3.44%, and an exact
  Airy disk sampled on the same grid 0.157% / 3.39%. The cores agree (FWHM 255.7 'fft' vs 255.6
  'direct' vs 255.1 Airy, first zero within 1 nm), so the error only shows after normalization:
  every emitter splatted from a 'direct' kernel is ~17–20% too dim in its core, over a faint ghost
  pedestal. The 0.22–0.29% agreement PARITY.md recorded was measured on a 1.6 µm kernel, inside
  the valid radius — which is why it went unnoticed. `simulation_psfEvalMethod`, its dropdown,
  `computePsfPupilForZPlane()`/`computePsfIntensityPlane()`, `PSF_N_RHO`/`PSF_N_PHI`, the worker
  branch and the GPU kernel are all gone; the focal-shift explanation moved onto
  `computePsfPupilCartesianForZPlane()`. An old settings file naming the key loads with the usual
  "not recognised" note. `tests/gpu/test-sim-gpu.mjs` pins chirp-Z's tail to the Airy value.
  **Don't reintroduce a polar quadrature** without an angular sample count that grows with the
  kernel radius (~128 at the default 6 µm).

  **The analysis-side companion is `PARAMS.cameraExcessNoise` (F², MODULE: fit)**: a Poisson
  likelihood cannot express Var = F²·N, so `runCore()` hands the fitters `gain/F²` (fitting in
  F²-photon units, where the data IS Poisson again) and `applyExcessNoise()` scales
  photons/bg/bgstd back by F². Positions are untouched; the CRLB comes out inflated by exactly F.
  Measured: CRLB coverage of the real scatter 0.66 at F²=1 → 0.93 at F²=2 on EMCCD data. Applied
  at every fit dispatch site that fits real data: the worker, `runCore()`'s serial loop, the live
  preview, and — since the upstream v0.12.7 merge — the GPU fit path's result loop in
  `makeGpuFitAccumulator()`. The GPU needs no kernel change for it: its seeds and windows are packed
  with `runCore()`'s own `gain`, which is already `gain/F²`, so only the photon-like outputs need
  scaling back, same as everywhere else. **Any new fit dispatch path must do the same**, or F²
  silently stops applying there. `photons` can shift ~0.25% between F²=1 and 2 on the same movie because
  `mstep`'s absolute floors (`Math.max(100,0.3*N)`) are not scale-invariant — expected, not a bug.
  PCFO measures gain·F² on EMCCD data and says so rather than silently dividing.

  **Illumination (2026-09-20).** `buildSimIllumination()` builds an attenuation field with **peak
  1** (not mean 1 — that was tried and rejected: a 60% Gaussian then makes the centre 2.7x the
  typed `phot`, which reads as the setting being ignored), so with a profile selected `phot` and
  `simbg` are the values at the beam CENTRE. The factor is applied in exactly ONE place per
  emitter — folded into `bright`, which `addBlink()` already feeds into BOTH the rendered frame
  and the ground-truth `rate` — so the movie and the truth cannot disagree about how bright an
  emitter was. The background is attenuated by the same field and deliberately NOT renormalised.
  Consequence worth knowing: switching a profile on does NOT simply make detection worse — on one
  scored run the 50%-detection point FELL (440 → 227 photons) because the background dimmed along
  with the signal, while recall and lateral error still degraded (81.6% → 78.2%, 5.0 → 9.1 nm).

  **Presets write parameters, they never replace them**: `wirePreset()` pushes a preset's values
  into the ordinary controls and a manual edit flips the preset to `custom`, so
  `simulation_realism` (**Physics detail**: `min`/`med`/`max` = Basic/Realistic/Full) and
  `simulation_densityPreset` (**Emitter density** at the top of the panel; the exact `dens` sits under
  Sample) carry no physics of their own and `paramValue()`/settings JSON/`analyze()` never need to know they exist.

- **validation** — scores recovered localizations against the simulator's own ground truth
  (`groundTruthEvents`), which nothing read before. `scoreTruthCore()` is the pure core shared by
  the **Score vs truth** button and `analyze()`'s `scoreVsTruth` flag. Matching is per frame,
  **lateral only**, one-to-one within `validation_matchRadius`: matching on z would pair towards
  whichever candidate has the flattering z and bias the axial error towards zero — the very number
  being measured — and keeping it lateral is also what lets 2D and 3D share one code path (axial
  metrics simply don't accumulate when either side lacks a finite z). Ground truth per frame is
  *derived* from `groundTruthEvents` with the same frame-overlap rule `generateSynthetic()` used to
  splat it, so the two sets agree by construction. Positions are compared **before** drift
  correction (`L.x0`/`L.y0`, which `correctDrift()` preserves) against the *drifted* truth, so the
  score measures the fitter regardless of what drift correction did. **Median and percentiles are
  the headline numbers, not RMSE**: the axial error distribution has heavy tails (fold-back and
  clamped-calibration failures), and measured on a typical run the worst 1% of pairs contributed
  62% of the sum of squares while the RMSE swung 67→420 nm across seeds and the median barely
  moved. Gross axial failures are counted separately rather than left to inflate a mean.
  **Three classes of truth, not two (2026-09-19):** an emitter-frame is *counted* only if it
  delivered ≥ `validation_minPhotons` that frame and lies outside `validation_border`; otherwise —
  and always for out-of-focus haze emitters — it is *don't care*: matched = neither TP nor FP,
  unmatched = not FN. **Match against ALL truth first, classify afterwards**; filtering first turns
  a genuine detection of a dim emitter into a false positive. `minPhotons=0, border=0,
  crowdRadius=0` must reproduce the older numbers exactly (verified to the last decimal). The
  recall-vs-photons bins and the logged 50%-detection point exist because the threshold alone
  misleads: the ~77% recall every fit method showed was only partly frame slivers — the default
  detector crosses 50% at ~440 photons, a real sensitivity limit the threshold must not hide.
  **Per-molecule + effective z range (2026-09-20):** `groundTruthByFrame()` now carries
  `moleculeId` through, so the score can group pairs by MOLECULE (`perMol`) and report molecule
  recall, detections per molecule, and the error of each molecule's AVERAGED position — the thing
  repeat blinks actually buy (measured: 87.0% vs 81.6% frame recall, 4.63 vs 5.03 nm). `effZ` is
  the widest CONTIGUOUS depth span with per-bin recall ≥ `EFF_Z_RECALL` (0.5, a constant on
  purpose — a range is only comparable across runs if its definition never moves), which needed
  the z bins to count misses too (`zMiss`, binned into `b.fn`), since the bins previously held
  matched pairs only. **It is a DETECTION criterion and deliberately not the same as the PSF's
  own `zUsableNm`**: measured ±559 nm effective against ±460 nm single-valued on the same run —
  in between, emitters are found but their z can fold to the wrong side.

  **Two conventions (2026-09-20):** `validation_preset` (`webSMLM` default | `challenge2016`)
  writes four ordinary parameters — `validation_matchMode` (`lateral` | `cylinder3D`),
  `validation_photonMode` (`absolute` | `quantile`), `validation_borderMode` (`dontcare` |
  `exclude`) and the border/tolerances — so the published SMLM-Challenge-2016 rules can be
  reproduced without our own defaults moving a digit. `matchFrameCylinder()` is a SEPARATE matcher,
  deliberately not built on `gridNN()`: gridNN hands back each loc's nearest LATERAL truth, which
  is the wrong candidate once z gates the pair, so the cylinder builds the full within-radius
  candidate list over a bucket grid and ranks by true 3D distance in nm. `matchFrame()` is left
  untouched so the default numbers cannot drift. Measured decomposition on one 2D run (Jaccard
  0.812 → 0.976 overall): the quantile threshold does nearly all of it (0.812 → 0.971; the 25%
  quantile lands at 541 photons against our absolute 100), the cylinder adds 0.812 → 0.817 while
  RAISING lateral RMSE 15.9 → 20.3 nm (it rescues far pairs the NN matcher dropped), the border
  mode moved 2 localizations. **`lateral` stays the default because the axial gate flatters the
  axial error**: a pair that would have scored as bad z becomes a miss instead.

  `scoreTruthCore()` stays global-free: frame size, the Run's detection border and the Run's own
  frame range (`firstIdx`/`lastIdx`/`stopped`, so a restricted or stopped Run is not scored as
  missing everything it never looked at) come in through `truthScoreConfig(cfg, det, run)`, the
  one helper both the button and `analyze()` use. Its controls live in `validationBox` ("Score vs
  truth"), a `details.subsim` inside Simulation settings, last after PSF parameters — it only works
  on simulated data, so it sits with the simulator.

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
  - The **Use GPU acceleration** checkbox sits in "Memory, Rotation, GPU & streaming" (shared by fit, render,
    FRC).

  **PSF-model fitting (`psfmle`) and `detection_mergeRadius` are not on this branch** — they
  live on `psf_fitting` (split off 2026-09-28 so the simulation PR stays about simulation).
  **Double helix — the bug that faked a physics conclusion (2026-09-20g).** A DH fit once looked
  like proof that the MASK did nothing. It was not: **`buildPsfPlanesParallel()`
  and the PSF worker each spell the optical parameters out by hand rather than forwarding `cfg`,
  and neither listed `maskType`/`maskModes`/`maskWaist`** — so every kernel built through the
  pool (the default path) came back unaberrated, and every DH measurement was really measuring a
  plain PSF. Two tells were available before the conclusion: six mask settings all reported the
  SAME z-CRLB, and a masked kernel was byte-identical to an unmasked one. **When a physics result
  says a model does nothing, check that the parameter reached the model.** Same class as the
  `WORKER_PRELUDE` gotcha, one layer up: an explicit field list on both ends of a postMessage.
  With it fixed the sign is decisive — expected log-likelihood ratio between +z and −z at ±400 nm,
  5000 photons: 516, against exactly 0 unaberrated.



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

- **gpu** — WebGPU engine (experimental; probed once, disabled for the session on failure or device
  loss). `runStage()` picks CPU/GPU per stage and times both for the A/B table (`logStageTable()`).
  Fit batching: `makeGpuFitAccumulator()` (in `runCore()`) and `makeGpuFitSlotPool()` (lazy
  persistent slots); pipelines are cached as promises with explicit layouts. Kernel sizes come from
  the adapter's real limits; `tuneGpuWorkgroup()` measures the best workgroup size once per session.
  The free-angle rotated kernel needs `maxStorageBuffersPerShaderStage ≥ 7`. `WGSL_FRC_BIN`
  dispatches 2D (loc count can exceed 65,535 workgroups in one dimension). PCFO's tile FFTs
  (`pcfoTilePointsGpu()`, stage `pcfo`: mirror fill with the tile mean removed, batched row FFTs,
  per-tile transpose, masked power sum) match the CPU to ~1e-7; its jackknife is the exact
  O(n log n) `pcfoJackknife()`. Test: `tests/gpu/test-pcfo.mjs`. WGSL strings can't share
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

- **sSMLM** ("(Caution!) Pairing (sSMLM & FRET)") — pairs 0th/1st-order grating images (Martens et
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
    Pair on the donor-excitation composite; **Position donor** picks which of the two bearings points
    D→A) and **Via channel matching** (`alignSmfretChannels()`: x-gap split, displacement search,
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
    photons, or ADU at gain 1; saved as `gain_photons_per_adu`/`intensity_unit`). **Plot (FRET) data** (`plotSmfretTraces()`) re-shows
    the in-memory traces; saved trace JSON loads via **Load movie/data**. Save/load round-trips
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
  - **Load movie/data** (`loadFiles()`): movie, CSV, or JSON routed by its `format` field
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
  headlessly. `checkTableSize()` uses `TABLE_FILTER_ROW_BYTES` (32). `commitSrCrop()` awaits the
  filtered render before zooming; the crop rectangle is drawn first, with a `tick()` so it paints.

## Web Worker gotcha (read before touching detect/fit/workers)

Workers are built from the main thread's own functions (`workerSource()` stringifies them), so the
numerics exist once. Consequences:

- A worker has a fresh global scope: module-level state a stringified function reads must be
  re-declared in `WORKER_PRELUDE` (a runtime check lists `missing` names; otherwise the worker throws
  and the app silently runs single-threaded). The render worker has its own `RENDER_WORKER_PRELUDE`.
- Every helper a stringified function calls must be in the `workerSource()` body.
- One pool, several message types (frame batches, FTM preview, FTM chunk, GPU detect), branched on a
  `d.<flag>`. A worker has one `onmessage`, not a queue: never put two job types on the pool at once
  (hence FTM's barrier phases).
- The worker source is a template literal: no backticks in comments inside it.

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

- Sidebar/panel buttons fit on one line; abbreviate rather than wrap. Compact labels read
  `Word/word` (**Save plot/image**, **View data/filtering**, **Load movie/data**).
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
  osascript -l JavaScript -e "var s=$.NSString.stringWithContentsOfFileEncodingError('/tmp/app.js',4,null).js; try{ new Function(s); 'SYNTAX OK'; }catch(e){ 'ERR: '+e }"
  ```
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
  (parameter sweeps in a visible browser), `sync_hints.mjs`, the livestream bridge.

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
  drift check). The `module: X` pill is fixed markup. The 18 hints: `hint-memory` (incl. live
  streaming), `hint-simulation` (top-level rows + overview) + seven sub-group hints (`-type` = Sample,
  `-nup`, `-fluorophore`, `-background`, `-camera`, `-psf`, `-advanced`), `hint-pcfo`, `hint-calibration`, `hint-detectfit` (incl.
  gain/offset), `hint-render`, `hint-drift` (incl. NeNA/FRC), `hint-validation`, `hint-sSMLM`, `hint-smfret`,
- **Quick guide** (`helpBtn`) is thin, hand-authored UI copy: intro, the 5-step Guided workflow,
  Acknowledgements, Licence & author. `README.md`'s Guided workflow is a copy; update both together.
