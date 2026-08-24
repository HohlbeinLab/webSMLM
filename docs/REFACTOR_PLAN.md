# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **Rotated-elliptical 2D/3D MLE fitter — SHIPPED (build 2026-08-21f; the
  `localize3D` checkbox + rename below shipped 2026-08-22c).**
  `gaussianMLEellipticangled()` (`'gaussmleEll'`, UI label "Gauss MLE 3D
  rotated elliptical" — renamed from "Gaussian MLE Elliptical (sSMLM)"
  alongside `gaussianMLE`→`gaussianMLEspheric`/`gaussianMLEastig`→
  `gaussianMLEelliptic`, matching Picasso's own SPHERICAL/ELLIPTIC/ROTATED
  naming, `mle3d`'s label now "Gauss MLE 3D elliptical") fits independent
  σx/σy at either a FREE or FIXED rotation angle, chosen by the **3D
  localisation?** checkbox (`PARAMS.localize3D`, shown for `mle3d`/
  `gaussmleEll` only, default checked): checked = FREE angle (an
  astigmatism-axis-alignment diagnostic — every emitter should share the
  same angle if field-position-dependent aberrations are ignored — against
  real 3D calibration bead data, no longer just a stated follow-up)
  plus z from a loaded `gaussian_width` calibration; unchecked = angle FIXED
  at the sSMLM pairing step's own calibrated dispersion bearing
  (`sSmlmAngleCenter`), no z — the original sSMLM-only path. `mle3d` also
  respects the checkbox now: unchecked runs the same axis-aligned elliptical
  fit with no calibration requirement and no z. See **fit** and **sSMLM** in
  `CLAUDE.md` for the full design, including the point-sampled (not
  pixel-integrated) model matching Picasso 0.11.0's own `gaussfit.py`
  `_accumulate_rotated` formula (checked directly against its real source
  before building this, not assumed). Landed alongside the refactor it was
  designed to build on: `gaussianMLEspheric`/`gaussianMLEelliptic` now share one
  `mleNewtonFit()` Fisher-scoring driver instead of two independently hand-
  written copies of the same loop — verified numerically unchanged (a
  synthetic-data regression harness, `gaussianFit`/LS deliberately excluded
  from the unification, different per-pixel weighting and outer solver).
  `pairCore()` gained optional `sx0th`/`sy0th`/`sx1st`/`sy1st` CSV/table
  columns (real per-axis widths for BOTH orders) alongside the existing
  `sigma1st` proxy; separately, every elliptical-method loc (paired or not)
  now also gets plain `sigma_x`/`sigma_y [nm]` CSV/table columns — which
  surfaced and fixed a real bug in the process: the worker pool's packed
  result array never carried `sx`/`sy` at all (only the merged `sigma`), so
  a worker-pool sSMLM Run was silently losing `sx0th`/`sy0th`/`sx1st`/`sy1st`
  even before this — see **export** in `CLAUDE.md`.

  Deliberately deferred, not forgotten:
  - **Per-pixel gain/offset/variance calibration maps** — Picasso's own
    shared per-pixel estimator (`_estimator_terms(mle, value, data, var)`)
    is already per-pixel-noise-aware via that `var` term, connecting
    directly to the sCMOS entry further down this file. Not attempted here;
    the accumulator refactor above makes it a smaller lift when it is
    (the per-pixel model callback gains one more input), but genuinely not
    done this round.
  - **Cubic-spline PSF fitting** (`picasso/fitting/splinefit.py`) for PSFs
    that deviate from Gaussian — meaningfully bigger scope than the rotated-
    elliptical case (its own 3D calibration volume, its own PSF-model
    representation, not just another free parameter). Key references:
    Babcock & Zhuang, "Analyzing Single Molecule Localization Microscopy
    Data Using Cubic Splines," *Sci. Rep.* 7, 552 (2017); Li et al.,
    "Real-time 3D single-molecule localization using experimental point
    spread functions," *Nat. Methods* 15, 367–369 (2018).

- **Headless plot export (`config.exportPlots`) — extend to column
  histograms.** Shipped v0.11.3-dev (build 2026-08-20g) covering drift/NeNA/
  FRC/PCFO/calibration — one flag renders whichever of those were actually
  computed as both PNG and SVG, with no browser window needed (see
  **render**/**pipeline** in `CLAUDE.md`, `renderPlotBothFormats()`/
  `_plotTarget`). Deliberately left out: the shared column histogram
  (`drawHistogram()`/`computeHist()`, **table** module) and the line-profile
  plot — both are driven interactively (a user picks a table column, or
  draws a line on the reconstruction) with no obvious headless default.
  Line-profile has no real headless equivalent (no reconstruction geometry
  exists to draw a line on) and should probably stay out of scope
  permanently. The histogram case is different and worth revisiting — a
  common real want is an intensity ('photons', or sigma/bg) histogram
  auto-generated for every batch/CLI run. The mechanism is mostly already
  there: `computeHist(col, vals, unit)` already takes an explicit `vals`
  array (so `locs.map(L=>L[col]).filter(isFinite)` from inside `analyze()`
  needs no new plumbing), but `drawHistogram()` itself reads the module-level
  `histData`/`histView` (set by `computeHist()`) the same way
  `drawCalibration()` reads `calib`/`calView` — so this needs the same
  small `renderHistogramPlotHeadless(col, vals, unit)` stash/restore wrapper
  `renderCalibrationPlotHeadless()` already demonstrates, not a new
  rendering mechanism. Needs a decision on WHICH column(s) to histogram by
  default: (a) a fixed set always rendered when `exportPlots` is set (e.g.
  `photons`/`sigma`/`bg`), (b) a new config field naming which columns
  (e.g. `exportHistograms: ['photons','sigma']`), or (c) something else —
  not scoped yet, flagged here as a direction.

- **Plot panel UI polish — SHIPPED (2026-08-18, builds d–k).** Fixed
  letterboxing, dark-on-screen/light-on-export plots, the Stack panels/Side
  by side toggle, PCFO's axis-scale ticks, panel vertical alignment, and a
  consistent axis-border/tick pass across every plot — see **render** in
  `CLAUDE.md` for the full mechanism. One still-open scrap: no UI to reset
  `layoutOverride` back to `null` (auto) once a user has clicked **Stack
  panels**/**Side by side** — not clearly needed yet (a second click always
  gets the other state, which for a 2-state toggle is equivalent, unless a
  third layout mode gets added later).

- **File-size/modularity strategy for `webSMLM.html`** (now past 10,400 lines;
  SPT alone added roughly a thousand when it shipped in v0.11.2, and a
  possible future single-molecule FRET (smFRET) module would add a few
  thousand more). Splitting the *core* app across multiple files was ruled out —
  `file://` blocks `fetch()`/dynamic `import()` under CORS in Chromium,
  inconsistently across browsers, breaking the "download and it just works"
  promise. **Chosen and landed (v0.11.1)**: lean on the existing `MODULE:`
  banner convention plus the top-of-file **MODULE INDEX** line-number
  comment, refreshed every build-letter bump. Still on the table if the file
  keeps growing:
  1. **Dev-time-only source split, single-file at ship time** — a `tools/`-
     tier build script concatenates `src/*.js` fragments into the final
     `webSMLM.html`, solving editability without touching the deployed
     artifact or the `file://` promise. Not implemented; revisit once the
     MODULE-banner approach alone stops being enough.
  2. **Split SPT/smFRET out as their own single-file sibling apps**
     (`webSPT.html`, `webFRET.html`) — considered and set aside: they'd
     share too much of webSMLM's own pipeline (TIFF loading, worker pool,
     table/render/export) to cleanly separate, and some real analyses
     combine SPT and smFRET directly (Fontana, Fijen, Lemay, Mathwig &
     Hohlbein, *Lab Chip* (2018),
     [10.1039/C8LC01175C](https://doi.org/10.1039/C8LC01175C)). Revisit only
     if a future module needs almost nothing from the shared pipeline.

- **Nikon ND2 loading — SHIPPED v0.11.2.** `isNd2File()`/`loadNd2File()`/
  `parseNd2LvField()` parse the modern (NIS-Elements 4.0+) chunk-container
  format, reverse-engineered directly from two real native samples since no
  official spec exists (Bio-Formats/`nd2reader` are GPL, unsafe to port
  from into this CC-BY project; the legacy JPEG2000-compressed variant is
  rejected with a clear error rather than half-supported — no lightweight
  JS JPEG2000 decoder exists). Wired into `loadTiffFile()`/
  `loadTiffFilesAuto()`'s single detection path so all three existing TIFF
  callers (interactive `#file`, calibration file input, headless
  `analyze()`) gained ND2 support with no caller-side changes. A real row-0
  pixel-corruption bug (a 24-byte per-frame sub-header misread as the first
  ~6 pixels of every frame — self-consistent enough that no dimension/
  frame-count check caught it, only the pixel VALUES were wrong) was found
  from a user screenshot and fixed the same cycle, cross-validated
  byte-for-byte against the independent BSD-3-Clause reference
  `tlambert03/nd2` (installed locally for exactly this check, not ported
  from). Embedded pixel size, frame interval (from per-frame timestamps),
  and camera datasheet info are also logged (never auto-applied — same
  compute-once/apply-separately convention as everywhere else). Full design
  and history: **in/out** in `CLAUDE.md`, the 0.11.2 entry in
  `CHANGELOG.md`.

  Not implemented — deliberate scope limits, not oversights:
  - **Multi-channel and non-16-bit** files throw a clear unsupported-format
    error rather than attempting to misread them.
  - **Multi-file ND2 concatenation** — TIFF's own `loadTiffFilesAuto()` can
    combine several single-frame files into one stack; ND2 can't yet.
  - The trailing `ND2 FILEMAP SIGNATURE NAME 0001!` index chunk isn't used
    as a shortcut — `readNd2ChunkHeader()` still walks the whole chunk
    chain linearly. Fine at the sizes tested (indexing cost scales with
    frame count, not file size beyond that), but a genuinely huge ND2 file
    could benefit from reading this index instead.

- **FTM (fast temporal median filter) — still open.** Shipped in 0.10.1;
  see `CHANGELOG.md` for what landed and `CLAUDE.md`'s **in/out** module
  note for the current design. Remaining:
  - Scrub-preview speed at large frame sizes (measured, 8 workers: ~23 ms
    at 128×128 up to ~510 ms at 1024×1024 per scrubbed frame — fine
    smaller, laggy for rapid dragging on large ones). A finer row-band
    split, or reusing detect/fit's frame-batch workers differently, are
    options if this needs to get faster.
  - The worker-parallel Localize path only reports progress at chunk
    boundaries (no intra-chunk granularity, unlike the serial path) — would
    need a new worker message type (periodic progress pings ahead of the
    final result) to smooth out, not attempted yet since the barrier
    structure already makes that a bit delicate (see CLAUDE.md's Web
    Worker gotcha).
  - `fitFirstFrame`/`fitLastFrame` (the analysis frame range) stays a
    *separate* range from FTM2's own independent Start/End (which frames
    the filter itself runs over, not which ones get localized afterward)
    — no UI for the latter yet.
  - A real (not synthetic) per-candidate MLE fit-time regression was
    reported on GATTA-PAINT data with FTM on (~160→270 µs/candidate) that
    a synthetic A/B test couldn't reproduce (µs/candidate came back
    ~unchanged there) — likely the Newton solver needing more iterations
    to converge on real corrected-background statistics, but not yet
    confirmed against real data.

- **Spectrally resolved SMLM (sSMLM) — follow-ups beyond the Phase 1 "Spectral
  SMLM analysis" module** (2-point 0th/1st-order pairing, shipped v0.11.0 —
  see `CLAUDE.md`/`docs/DOCUMENTATION.md`'s **sSMLM** module entry for the
  design; from Martens, Gobes, Archontakis, Brillas, Zijlstra, Albertazzi &
  Hohlbein, *Nano Lett.* 22(21), 8618–8625 (2022),
  [10.1021/acs.nanolett.2c03140](https://doi.org/10.1021/acs.nanolett.2c03140),
  ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer)).
  Role assignment (which point of a candidate pair is 0th vs 1st order) went
  through several real-data-driven revisions before landing on its current,
  purely directional design — worth remembering if revisiting this area:
  brightness looked plausible (the paper's own physical model) but measured
  at ≈50/50 correlation with position even at confident intensity gaps
  (likely PSF-overlap/crowding corrupting photon estimates at this emitter
  density); a hypothesized symmetric ±1st-order signal was also ruled out
  (the "opposite-side" population's intensity-ratio profile was statistically
  indistinguishable from the real side, inconsistent with a genuinely weaker
  physical order); PSF width (σ) showed a real but imperfect correlation
  (~65–70%, stronger with a clearer σ gap) — consistent with the 1st order's
  spectral smearing — and is now available as an optional, default-off
  confidence filter (`sSmlmRequireNarrower`) rather than a requirement.
  What actually worked was a purely geometric, brightness-free rule: a point
  qualifies as 0th order only if it has a candidate on the configured
  (now fully directional, signed) bearing AND no candidate on the opposite
  bearing — self-disqualifying, no external reference signal needed —
  verified on the real reference dataset to recover *more* pairs than the
  old brightness-gated approach (64.0% vs 59.0%), with only ~5% of points
  landing in the genuinely ambiguous "candidate on both sides" bucket it
  correctly excludes. Remaining, not yet implemented:
  - **Multi-order chaining** (0-1-2-3+, matching `sSMLMAnalyzer`'s
    `sSMLMA.java` full feature set) — true higher orders (2nd, 3rd — same
    side as 1st, further out) are a distinct question from the ±1st-order
    symmetry just confirmed above; nothing examined so far demonstrates a
    genuine 2nd-order signal at a *different* distance from the 1st-order
    band, so that part still needs its own dataset/validation, not just the
    algorithm.
  - **FFT-based automatic angle/distance detection**, matching
    `sSMLMAnalyzer`'s `AngleAnalyzer.java` (render localizations to an
    image, 2D-FFT it, find the dominant periodic peak — not a drop-in for
    webSMLM's own inline FFT, which is a 1D radix-2 transform for FRC, not a
    2D image FFT + peak-finding routine). Phase 1's **Preview pairs**
    distance/angle histograms cover the same "find my window" need more
    simply for now.
  - A minimum-neighbour-count spatial consistency filter (reject sparse
    false pairs with too few nearby confirmed pairs) — `sSMLMAnalyzer` has
    one, Phase 1 doesn't.

  **Headless exposure — shipped v0.11.1 (2026-08-17)**, alongside a data-model
  fix it depended on. Checking headless status surfaced a real, live bug: pairing
  stored the inter-order distance IN `z` (aliasing/overwriting it), and
  `driftCore`'s "Correct z too (3D)" gate keyed off the same `has3d` check the
  colour-by-depth toggle used — so a paired result would show that option, and
  ticking it would silently 1-D-"correct" the spectral distance as if it were
  spatial drift, corrupting it. Fixed at the root rather than patched: `dist` is
  now its own field, `z` is never touched by `pairCore()` at all — which also
  unblocks a future 3D-fit + sSMLM combination (a loc could carry real depth AND
  spectral distance simultaneously without one clobbering the other), the
  original reason this was raised rather than just adding a driftZ guard.
  `renderSuperRes()`/`zRange()` gained a `colorField` parameter (`'z'` or
  `'dist'`) so the one depth-coded render path serves both without duplication;
  `rerender()`/`analyze()` derive it from `hasZ`/`hasDist`. `pairCore()` itself
  now throws on bad input (real 3D `z`, or already-paired `dist`) rather than
  only the interactive wrapper checking — the second guard is new, needed
  because with `z` no longer touched, re-pairing an already-paired result could
  no longer be caught as a side effect of the old z-guard. `config.sSmlmPair`
  (headless), `--sSmlmPair` (CLI), `sSmlmPair=1` (autorun) all wire to the same
  `pairCore()` call, run right after Localize, before drift/NeNA/FRC. See
  **sSMLM** in `CLAUDE.md` for the full design; verified with direct `pairCore()`
  guard tests, a real button-click UI round-trip (Localize → Pair → confirm
  `driftZRow` stays hidden → Show standard/spectral toggle → Unpair), and a
  headless `analyze({sSmlmPair:true, ...})` call, all via Playwright.

- **Single particle tracking (spt) — SHIPPED v0.11.2, follow-ups below.**
  Frame-to-frame linking (`linkTracks()`, Hungarian-optimal assignment per
  connected component, `sptMemory`-gated gap-bridging), per-track diffusion
  coefficients (`trackDiffusionCoeffs()`, ported from `diff_coeffs_per_track()`
  in the user's own `sptPALM-Python` pipeline), D/track-length histograms
  with an exponential lifetime fit, live D rescaling on Frame time/
  Localization error edits, headless exposure (`config.sptTrack`/
  `--sptTrack`/`sptTrack=1`), and a per-track **Save spt data** summary CSV
  — see **spt** in `CLAUDE.md` for the full design and the 0.11.2 entry in
  `CHANGELOG.md` for the round-by-round refinement history (verified
  against synthetic straight-line/crossing/gap-bridging cases and the real
  bundled L. lactis dataset). **Cell-segmentation-aware tracking SHIPPED
  build 2026-08-24**: `Apply segmentation?` loads a separate integer-
  labelled mask (`Load segm. image`/`Show segm. image`, recoloured display,
  `segmentedImageData`), `Min./Max. cell area (px)` gates which cells
  qualify (`Show area hist.` to help pick them), and `Track` then links
  each qualifying cell's own localizations SEPARATELY
  (`linkTracksPerCell()`) — a track can never cross a cell boundary —
  ported from `sptPALM-Python`'s own `apply_cell_segmentation_sptPALM.py`/
  `tracking_sptPALM.py` `use_segmentations` branch. `cell_id`/
  `cell_area [px]` become optional CSV/table columns, same pattern as
  `track_id`/`D_coeff`. Verified against the real bundled brightfield
  segmentation + localization CSV: no track ever spans two cells, area
  filtering exact at both bounds, CSV round-trip exact.

  Deliberately deferred, not forgotten:
  - **Length-resolved D histogram** (the reference pipeline's
    `D_track_length_matrix`, one histogram per track length rather than one
    pooled histogram) and **colour-reconstruction-by-D/by-track** (the
    render module's `colorField` mechanism sSMLM's `dist` already uses
    could extend to `D_coeff`, but D is track-level not per-loc the way z/
    dist are, so this needs its own design, not a drop-in).
  - **Real `10^x`-formatted tick labels** for the D histogram's log10(D)
    x-axis — v1 ships literal log10 numbers (a deliberate, documented v1
    shortcut, reusing `computeHist()`/`drawHistogram()` completely
    unchanged) rather than a genuinely log-scale-aware axis.
  - **Large-subnetwork exact assignment.** `linkTracks()`'s connected
    components above `HUNGARIAN_MAX` (120 points) fall back to greedy
    nearest-neighbor rather than trackpy's own recursive exact-subnetwork
    solver — real single-molecule (PALM-style, sparse) SPT data isn't
    expected to produce components that large, but a genuinely crowded
    dataset could exercise this fallback; no reports of it mattering yet.

- **`tempClusteringMemory` — gap-frame tolerance for temporal clustering.**
  `clusterEvents()` (table module) currently requires strictly consecutive
  frame numbers to chain detections into one event (memory=0, hardcoded) —
  a molecule that blinks off for even one frame and back on starts a new
  chain instead of extending the old one. `tempClusteringMemory = N` would
  allow up to N missed frames between detections of the same chain. Needs a
  decision on how a gap should weight into the position average (does a
  skipped frame count as "still on" for the photon-weighted mean, or purely
  bridge the chain without contributing) before implementing.
- **Reconsider the detect/fit/export/table module split.** These
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
- **Let a settings JSON override a parameter's `min`/`max`/`step`,
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
- **Let Load Settings introduce whole new modules, not just
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
- **Regression test suite via `analyze()`**: fixed-seed synthetic stack →
  assert localization count and RMS error within bounds. There is currently
  no automated test suite at all; this would be the first one, and it falls
  out of the v0.10.0 headless pipeline API (`docs/DOCUMENTATION.md` §8) for
  free.
- **Extend the synthetic generator** to also emit known z and known drift
  (ground truth), so 3D/drift/precision work can be validated
  quantitatively through the regression check above rather than by eye.
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
- **Photon calibration beyond a single scalar gain/offset.** Single-image
  gain/offset estimation from the data itself (PCFO, a photon-transfer-curve
  variant — tile-wise mean-signal-vs-noise-variance regression, not a
  variance-vs-mean-across-frames curve) shipped in 0.10.2 — see
  `CHANGELOG.md`. A scalar still reasonably approximates an EMCCD chip, but
  most current SMLM runs on sCMOS, where gain, offset and read noise are all
  pixel-dependent (and non-uniform read noise also affects detection — a
  noisy pixel can masquerade as an emitter); still open: **per-pixel**
  gain/offset/variance calibration maps, with a noise model that uses them —
  see Huang et al., *Nat. Methods* **10**, 653–658 (2013),
  https://doi.org/10.1038/nmeth.2488.
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
  modest ~200–250 lines out of ~6,400 (fit function, its distinct
  magnitude-ratio 3D calibration model, UI, worker/export wiring) — not
  huge, but removing it would simplify the calibration module down to one
  3D model instead of two co-existing ones that currently need guarding
  against each other. Weigh against phasor's one remaining real edge: it's
  still by far the fastest fitter, which could matter for extremely
  high-throughput or huge stacks where MLE's iterative cost adds up.
