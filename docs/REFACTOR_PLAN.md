# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **Rotated-elliptical 2D/3D MLE fitter — SHIPPED (build 2026-08-21f).**

  Deliberately deferred, not forgotten:
  - **Per-pixel gain/offset/variance calibration maps** — see "Photon calibration beyond a single
    scalar gain/offset" further down for the full picture; the accumulator refactor above makes
    this a smaller lift when it happens (the per-pixel model callback gains one more input), but
    genuinely not done this round.
  - **Cubic-spline PSF fitting** (`picasso/fitting/splinefit.py`) for PSFs
    that deviate from Gaussian — meaningfully bigger scope than the rotated-
    elliptical case (its own 3D calibration volume, its own PSF-model
    representation, not just another free parameter). Key references:
    Babcock & Zhuang, "Analyzing Single Molecule Localization Microscopy
    Data Using Cubic Splines," *Sci. Rep.* 7, 552 (2017); Li et al.,
    "Real-time 3D single-molecule localization using experimental point
    spread functions," *Nat. Methods* 15, 367–369 (2018).

- **File-size/modularity strategy for `webSMLM.html`.**
  Splitting the *core* app across multiple files was ruled out —
  `file://` blocks `fetch()`/dynamic `import()` under CORS in Chromium,
  inconsistently across browsers, breaking the "download and it just works"
  promise. **Chosen and landed (v0.11.1)**: lean on the existing `MODULE:`
  banner convention plus the top-of-file **MODULE INDEX** line-number
  comment, refreshed every build-letter bump. Still on the table if the file
  keeps growing:
  - **Dev-time-only source split, single-file at ship time** — a `tools/`-
     tier build script concatenates `src/*.js` fragments into the final
     `webSMLM.html`, solving editability without touching the deployed
     artifact or the `file://` promise. Not implemented; revisit once the
     MODULE-banner approach alone stops being enough.
  - **Split SPT/smFRET out as their own single-file sibling apps**
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
  JS JPEG2000 decoder exists). Not implemented — deliberate scope limits, not oversights:
  - **Multi-channel and non-16-bit** files throw a clear unsupported-format
    error rather than attempting to misread them.
  - **Multi-file ND2 concatenation** — TIFF's own `loadTiffFilesAuto()` can
    combine several single-frame files into one stack; ND2 can't yet.
  - The trailing `ND2 FILEMAP SIGNATURE NAME 0001!` index chunk isn't used
    as a shortcut — `readNd2ChunkHeader()` still walks the whole chunk
    chain linearly. Fine at the sizes tested (indexing cost scales with
    frame count, not file size beyond that), but a genuinely huge ND2 file
    could benefit from reading this index instead.

- **FTM (fast temporal median filter).** Shipped in 0.10.1; Remaining:
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

- **Spectrally resolved SMLM (sSMLM)** (2-point 0th/1st-order pairing, shipped v0.11.0).

  Remaining, not yet implemented:
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
    2D image FFT + peak-finding routine). **Preview pairs**
    distance/angle histograms cover the same "find my window" need more
    simply for now.
  - A minimum-neighbour-count spatial consistency filter (reject sparse
    false pairs with too few nearby confirmed pairs) — `sSMLMAnalyzer` has
    one, Phase 1 doesn't.

- **Single particle tracking (spt) — SHIPPED v0.11.2.**

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

- **Let a settings JSON override a parameter's `min`/`max`/`step`, not just its value.**
  Today Save/Load Settings only round-trips
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
  https://doi.org/10.1038/nmeth.2488. The MLE fitters' shared `mleNewtonFit()` accumulator (see
  **fit** in `CLAUDE.md`) is already per-pixel-noise-aware via Picasso's own
  `_estimator_terms(mle, value, data, var)` `var` term, so a per-pixel model callback would only
  need one more input — a smaller lift than starting from scratch, but not yet attempted.
- Optional **fiducial-based drift correction** when beads are present
  (simpler and more accurate than AIM for that specific case).
- **3D point-cloud view** — an interactive, rotatable scatter (orthographic
  projection, colour = z) as an alternative to the depth-coded 2D
  reconstruction, where localizations at different z that overlap in x/y
  currently blend together.

