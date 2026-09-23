# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **WebGPU follow-ups** — the shipped path is opt-in and CPU-fallback safe, but a few GPU-specific
  limits remain worth revisiting:
  - Candidate acceptance differs slightly near the CPU f64 / GPU f32 boundary; current tests guard
    exact detection count and bounded accepted-set drift, not bit-identical accepted sets.
  - Detection was tried on WebGPU and removed after measuring slower than the worker-pool CPU path;
    only revisit with a different algorithm, not a straight port.
  - GPU batch sizing (`gpuBatchMb`/`gpuInflight`/`gpuFlushMs`) is settings-JSON/headless tunable for
    benchmarking, but intentionally has no sidebar UI until real users need it.
  - **Profile CPU-side detection to find a real overall-Run speedup** — asked directly why GPU phasor
    is only ~10% faster overall than GPU MLE despite a large (1.5x-35x) isolated fit-stage speedup:
    per **fit**'s own paragraph in CLAUDE.md, CPU-side detection (8 worker threads, identical cost
    regardless of fit method) already dominates a Run's wall time, so fitting was never the bottleneck
    for either method — no amount of smarter GPU auto-tuning/dispatch for phasor's own fit stage can
    move the *overall* number much further (Amdahl's law: the piece being sped up is already small).
    Detection itself was already tried on GPU and found slower (see the bullet above), so the
    remaining lever is profiling/optimizing the CPU band-pass + local-maxima detection path itself
    (`detectSpots()`, MODULE: detect) to find where its own real cost actually goes — not yet started.

- **Cubic-spline PSF fitting** (`picasso/fitting/splinefit.py`) for PSFs that deviate from
  Gaussian — meaningfully bigger scope than the rotated-elliptical MLE fitter (shipped): its own
  3D calibration volume and PSF-model representation, not just another free parameter. Key
  references: Babcock & Zhuang, "Analyzing Single Molecule Localization Microscopy Data Using
  Cubic Splines," *Sci. Rep.* 7, 552 (2017); Li et al., "Real-time 3D single-molecule localization
  using experimental point spread functions," *Nat. Methods* 15, 367–369 (2018).

- **File-size/modularity strategy for `webSMLM.html`.** Splitting the *core* app across multiple
  files was ruled out — `file://` blocks `fetch()`/dynamic `import()` under CORS in Chromium,
  inconsistently across browsers, breaking the "download and it just works" promise. Current
  approach: lean on the `MODULE:` banner convention plus the top-of-file **MODULE INDEX**
  line-number comment. Still on the table if the file keeps growing:
  - **Dev-time-only source split, single-file at ship time** — a `tools/`-tier build script
    concatenates `src/*.js` fragments into the final `webSMLM.html`, solving editability without
    touching the deployed artifact or the `file://` promise. Not implemented; revisit once the
    MODULE-banner approach alone stops being enough.
  - **Split SPT/smFRET out as their own single-file sibling apps** (`webSPT.html`, `webFRET.html`)
    — considered and set aside: they'd share too much of webSMLM's own pipeline (TIFF loading,
    worker pool, table/render/export) to cleanly separate, and some real analyses combine SPT and
    smFRET directly (Fontana, Fijen, Lemay, Mathwig & Hohlbein, *Lab Chip* (2018),
    [10.1039/C8LC01175C](https://doi.org/10.1039/C8LC01175C)). Revisit only if a future module
    needs almost nothing from the shared pipeline.

- **Nikon ND2 loading** — deliberate scope limits, not oversights:
  - **Multi-channel and non-16-bit** files throw a clear unsupported-format error rather than
    attempting to misread them.
  - **Multi-file ND2 concatenation** — TIFF's own `loadTiffFilesAuto()` can combine several
    single-frame files into one stack; ND2 can't yet.
  - The trailing `ND2 FILEMAP SIGNATURE NAME 0001!` index chunk isn't used as a shortcut —
    `readNd2ChunkHeader()` still walks the whole chunk chain linearly. Fine at the sizes tested
    (indexing cost scales with frame count, not file size beyond that), but a genuinely huge ND2
    file could benefit from reading this index instead.

- **FTM (fast temporal median filter)** — remaining gaps:
  - Scrub-preview speed at large frame sizes (measured, 8 workers: ~23 ms at 128×128 up to ~510 ms
    at 1024×1024 per scrubbed frame — fine smaller, laggy for rapid dragging on large ones). A
    finer row-band split, or reusing detect/fit's frame-batch workers differently, are options.
  - The worker-parallel Localize path only reports progress at chunk boundaries (no intra-chunk
    granularity, unlike the serial path) — would need a new worker message type (periodic progress
    pings ahead of the final result); not attempted since the barrier structure (see CLAUDE.md's
    Web Worker gotcha) already makes that a bit delicate.
  - `fitFirstFrame`/`fitLastFrame` (the analysis frame range) stays a *separate* range from FTM's
    own independent Start/End (which frames the filter itself runs over) — no UI for the latter yet.
  - A real (not synthetic) per-candidate MLE fit-time regression was reported on GATTA-PAINT data
    with FTM on (~160→270 µs/candidate) that a synthetic A/B test couldn't reproduce — likely the
    Newton solver needing more iterations on real corrected-background statistics, not yet
    confirmed against real data.

- **Spectrally resolved SMLM (sSMLM)** — remaining, not yet implemented:
  - **Multi-order chaining** (0-1-2-3+, matching `sSMLMAnalyzer`'s `sSMLMA.java` full feature set)
    — true higher orders (2nd, 3rd) are a distinct question from the ±1st-order symmetry already
    confirmed; nothing examined so far demonstrates a genuine 2nd-order signal at a *different*
    distance from the 1st-order band, so this still needs its own dataset/validation, not just the
    algorithm.
  - **FFT-based automatic angle/distance detection**, matching `sSMLMAnalyzer`'s
    `AngleAnalyzer.java` (render localizations to an image, 2D-FFT it, find the dominant periodic
    peak — not a drop-in for webSMLM's own inline FFT, a 1D radix-2 transform for FRC). **Preview
    pairs**' distance/angle histograms cover the same "find my window" need more simply for now.
  - A minimum-neighbour-count spatial consistency filter (reject sparse false pairs with too few
    nearby confirmed pairs) — `sSMLMAnalyzer` has one, webSMLM doesn't.

- **smFRET/ALEX integration** — the sSMLM-style acquisition mode (one movie, a diffraction grating,
  prism/polychroic splitter, or dual-view/image-splitter giving a donor/acceptor pair per emitter)
  now has a complete, real-data-verified v1 pipeline: SOI detection (**Localize SOI**),
  donor/acceptor pairing via either of two methods (**Pair DD + DA**, **Via distances and angles**
  reusing **Pairing (sSMLM & FRET)**'s own distance+bearing-angle matching, or **Via channel
  matching** for a spatially-separated dual-view setup — a from-scratch point-registration/affine-
  transform approach with its own **Alignment overlay** visual QA), role disambiguation
  (**Position donor?**), ALEX-aware DD/DA/AA time traces with a per-site E/S-vs-time subplot and
  inset ROI thumbnails, and a pooled population-level **E(S) histogram** (1D or, with ALEX+AA, a 2D
  E-vs-S density plot) — all under **Get traces & E/S**, whose own **Export traces & E/S**/**Load
  traces & E/S** round-trip both the raw per-frame traces and the pooled E(S) histogram data. See
  **Single-molecule FRET** in `CLAUDE.md` for the full implementation history — this file only
  tracks what's still genuinely open. References: Kapanidis, Lee, Laurence, Doose, Margeat & Weiss,
  "Fluorescence-aided molecule sorting: Analysis of structure and interactions by
  alternating-laser excitation of single molecules," *PNAS* **101**(24), 8936–8941 (2004),
  https://doi.org/10.1073/pnas.0401690101 (introduces ALEX); Hohlbein, Craggs & Cordes,
  "Alternating-laser excitation: single-molecule FRET and beyond," *Chem. Soc. Rev.* **43**(4),
  1156–1171 (2014), https://doi.org/10.1039/c3cs60233h (review).

  **"Link DD/DA/AA"/"Filter SOIs" were built, then dropped entirely** (an independent
  acceptor-channel verification pass and a DD+DA-vs-DD+DA+AA channel-selection setting) — direct
  request, on the reasoning that **Pair DD + DA** already establishes the acceptor position, and
  AA should simply always be sampled there once paired, no separate confirmation step or opt-in
  needed. Not a gap; don't re-add without a fresh, specific reason.

  **Still open**:
  - **AIM drift correction's own reliability degrades over the course of a long acquisition as
    emitters photobleach — raised directly, alongside the ALEX-pooling fix above** (see CLAUDE.md's
    own smFRET paragraph on `smfretComputeDrift()`): AIM estimates each segment's own shift from
    whatever real localizations exist within it, so a segment late in a long movie — after
    substantial photobleaching has thinned out the population — has genuinely less/noisier evidence
    to register against than an early one, making the per-segment shift estimate progressively less
    reliable exactly when cumulative real sample drift is often largest. Not scoped further yet:
    possible directions include a bleaching-aware/adaptive segment length (widening segments later in
    the movie to maintain a comparable localization count per segment) or flagging segments whose own
    localization count falls below some confidence floor rather than silently trusting a
    poorly-supported estimate — needs real bleaching-affected data to characterize before choosing
    an approach, not a change to make blind.
  - **Accurate/corrected FRET.** RAW E (= DA/(DD+DA)) and S (= (DD+DA)/(AA+DD+DA)) are already
    computed and shown — per-sample in the pooled **E(S) histogram**, per-site-per-time in the Time
    trace plot's own E/S-vs-time subplot. (`pooled_E`/`pooled_S` are no longer saved in **Export
    traces & E/S** — dropped as pure duplication, directly recomputable from the exported
    `photonsDD`/`photonsDA`/`photonsAA` arrays.) What's still missing is the FULL correction on top of
    these raw values — leakage/crosstalk, direct excitation, and a γ-factor derived from the
    population structure on the 2D E–S histogram — a distinct, later step, deliberately deferred per
    the references above.
  - **A hybrid MLE-position/aperture-intensity extraction mode, raised directly after confirming a
    real bias-variance trade-off between the two** (see CLAUDE.md's own smFRET paragraph on this):
    `gaussianMLEspheric()`'s own reported photon count has real-world scatter matching its own
    Cramér-Rao bound, which is genuinely, unavoidably worse than naive photon-counting statistics
    because it jointly estimates 5 correlated parameters (x, y, N, bg, sigma) — confirmed directly via
    `tests/gpu/test-mle-vs-aperture-variance.mjs` (CRLB ≈2x the naive floor, matching MLE's own
    empirical std within a few percent). `apertureIntensity()` pays a much smaller version of the same
    tax (no joint position/width fit, only a background percentile), so its own variance is closer to
    the naive floor, at the cost of a real, known systematic undercount bias. Idea (not scoped, "think
    later"): use MLE for sub-pixel POSITION (this correlation penalty doesn't apply nearly as strongly
    there) and evaluate aperture photometry AT that refined position for the photon COUNT — aperture's
    own lower variance without inheriting MLE's N-specific precision penalty. A related, also-deferred
    idea from the same discussion: for a non-converging fit, fall back to aperture photometry instead
    of reporting a flat rejected `0`, recovering partial signal rather than none. Needs real design
    work before implementing: exactly how a "fixed position, aperture-for-intensity" mode would be
    exposed (a new `smfretApertureMode`-adjacent toggle? Always-on once an MLE position exists?), and
    whether it belongs in smFRET specifically or as a general fit-module option.
    **Partly superseded (v0.12.9-dev, build 2026-09-23a):** smFRET's "Background from annulus"
    (`smfretAnchorBg`, `gaussianMLEsphericFixedBg()`) anchors bg to the annulus and fits x,y,N,σ —
    it already brings MLE trace noise level with aperture photometry on real data. Remaining follow-ups:
    - WGSL kernel for the anchored fit (currently CPU-only; `getSmfretTimeTraces()` skips the GPU batch).
    - Anchored bg for least-squares and the rotated elliptical fitter (both still fit bg freely).
    - A general Localize option ("Background: fit / from local annulus") — the same σ↑/bg↓ degeneracy
      inflates N there too (~9% of fits at 150 photons, ~50% at 800 photons with a PSF 1.5–2× σ_PSF);
      touches the shared worker/GPU fit paths, so needs its own CPU/GPU parity testing.
    - A soft Gaussian prior on bg (instead of fixing it) would keep the CRLB honest about background
      uncertainty; worth trying if the few-% undercount or optimistic lpx matter in practice.
  - **Headless/NDJSON export for Get traces & E/S.** `config.smfretLocateSOI` covers SOI detection
    headlessly; the time-trace extraction itself (`getSmfretTimeTraces()`) has no headless path yet.
    The existing streaming-NDJSON precedent (`spt_tracks.ndjson` via `makeRecordEmitter()`) is the
    natural shape to reuse — many molecules × many frames is too large for `analyze()`'s own return
    value — one record per molecule with its own DD/DA/AA-vs-frame arrays (or one record per
    molecule-frame — TBD).
  - **A "Donor vs acceptor" control** exposing `pairCore()`'s own existing directional 0th/1st-order
    role classification under smFRET's own donor/acceptor terminology, rather than silently assuming
    the convention `pairCore()` already uses (0th = donor-side) is the physically correct one for
    every setup. Only applies to **Via distances and angles**; **Via channel matching** has its own,
    separate **Position donor?** disambiguation already.
  - **Per-localization ALEX frame-role tagging on a GENERAL, non-smFRET-SOI localization set.**
    Today's DD/DA/AA sorting only ever applies to `smfretSOI` sites via **Get traces & E/S**; an
    ordinary Localize run's own output has no per-loc frame-role tag at all. Also still open: a
    genuine period/pattern control for ALEX cycles longer than a simple 1st-frame + period-2
    alternation, or explicit frame-index lists.
  - **Whether Localize SOI should gain a second averaging mode.** An ordinary Localize over the same
    frame range, then `tempClusteringXY < N` with `tempClusteringMemory <= inf` (table module,
    shipped), collapses every recurrence of the same physical site into one event with a real
    photon-weighted position and an `nMerged` blink count, instead of a heuristic centroid on a
    smoothed average image — usable manually today via the table's own filter box, no smFRET-specific
    code needed. Composite-averaging keeps a real, distinct advantage (it can find sites too faint to
    cross the per-frame detection threshold in any single frame), so this isn't a strict replacement;
    revisit once someone's actually compared the two on real smFRET data.
  - **Embed the SOI composite image(s) in the "Export traces & E/S"/"Load traces & E/S" JSON.**
    Right now the round trip carries fitted positions, raw per-frame intensities, and the pooled
    E(S) histogram data, but no pixel data at all — a loaded-traces-only session (no movie loaded)
    can show the Time trace/E(S) plots but never the SOI composite or real ROI-thumbnail pixel crops
    (`loadSmfretTraces()`, MODULE: smFRET). Raised and considered when building Load traces —
    deliberately NOT done then: a full composite is a w×h float array (over a million values on a
    real 1024×1024 test file), and as plain JSON text that's easily 10+ MB per composite, doubled
    for donor+acceptor — a 100×+ size jump over a traces-only file (~150 KB on the same real test)
    for a feature that's a visual sanity check, not analysis data. If built, do it as an opt-in
    checkbox at export time (default OFF) rather than baking it in unconditionally, and store it
    base64-encoded binary (Float32Array bytes) rather than a raw JSON number array to keep the size
    hit down.
  - **Molecules that aren't perfectly immobilised** (tethered particle motion, or genuinely freely
    diffusing molecules) could reuse **spt**'s own `linkTracks()` instead of a fixed-xy assumption —
    a distinct, later option, not needed for a genuinely immobilised-molecule dataset. Reiterated
    directly ("FRET calculation can and should be available for freely diffusing molecules, but that
    is another can of worms") alongside the FRET?/module-rename round (v0.12.5-dev, see **Single-
    molecule FRET** in `CLAUDE.md`) — still just a "keep in mind for later" note, not scoped further.
  - **Dual-channel PIXEL input for an image-splitter or two-camera setup** — narrower than it used
    to be: **Via channel matching** (`alignSmfretChannels()`) already solves the single-camera
    dual-view/image-splitter PAIRING problem directly on the one already-loaded movie (splitting
    sites of interest by their own x-position gap, then registering the two point sets with a fitted
    affine transform) — no separate frame-region split or synchronised sub-stacks needed for that.
    What's still genuinely open is lower-level: an actual PIXEL-level split of a dual-view frame into
    two independent sub-stacks (so e.g. Localize itself, not just smFRET's own SOI/pairing path,
    could run on either half separately) — structurally like the raw-panel crop tool's
    `makeCroppedStack()`, but producing TWO frame-synchronised sub-stacks from one crop step instead
    of one — and, separately, genuinely new frame-synchronised DUAL-STACK loading for a real
    two-camera setup (no existing precedent to lean on there at all).

- **Single particle tracking (spt)** — deliberately deferred, not forgotten:
  - **Length-resolved D histogram** (the reference pipeline's `D_track_length_matrix`, one
    histogram per track length rather than one pooled/ensemble one — distinct from the ensemble
    MSD-vs-lag plot already shipped) and **colour-reconstruction-by-D** (the render module's
    `colorField` mechanism sSMLM's `dist` already uses could extend to `D_coeff`, but D is
    track-level, not per-loc like z/dist, so this needs its own design, not a drop-in — distinct
    from the already-shipped tracks-overlay colour-by-D, which colours the polylines, not the
    density reconstruction itself).
  - **Real `10^x`-formatted tick labels** for the D histogram's log10(D) x-axis — still literal
    log10 numbers (a deliberate v1 shortcut reusing `computeHist()`/`drawHistogram()` unchanged)
    rather than a genuinely log-scale-aware axis.
  - **Large-subnetwork exact assignment.** `linkTracks()`'s connected components above
    `HUNGARIAN_MAX` (120 points) fall back to greedy nearest-neighbor rather than trackpy's own
    recursive exact-subnetwork solver — real single-molecule (PALM-style, sparse) SPT data isn't
    expected to produce components that large; no reports of it mattering yet.

- **Let a settings JSON override a parameter's `min`/`max`/`step`, not just its value.** Today
  Save/Load Settings only round-trips `{id: value}` pairs — the bounds themselves live solely in
  the hardcoded `PARAMS` registry and can't be changed without editing the file. Letting a loaded
  JSON optionally carry `{id: {value, min, max, step}}` and apply the bounds to both the in-memory
  `PARAMS[id]` entry and the DOM control (reusing `syncParamControls()`'s write path) would let
  someone with unusual data (e.g. a camera gain far outside today's 0.001–1000 range) relax a
  boundary without touching the source. Needs a decision on whether `saveSetBtn` should emit bounds
  by default (a fully self-describing saved file) or only on request (keeping normal saves small).

- **Let Load Settings introduce whole new modules, not just parameter values.** Today a loaded JSON
  can only set values for parameters the registry already knows about. A further step would let a
  loaded file *extend* the registry itself — e.g. ship a new detection filter or fit method's
  parameters (and, harder, its code) bundled with a settings file. Needs real design (where does
  the new module's *code* come from in a single-file, no-build app? a `Function`-constructed
  snippet in the JSON? a second file?) — flagged as a direction, not scoped yet.

- **Regression test suite via `analyze()`**: fixed-seed synthetic stack → assert localization count
  and RMS error within bounds. Nothing automated exists yet (no test files, no CI). A building
  block already exists for the drift half: the synthetic generator emits `simTrueDrift`, a known
  ground-truth drift curve already used to print an interactive RMS score after **Correct drift**
  — but nothing asserts against it automatically, and there's no equivalent known-Z ground truth
  yet for 3D work. Falls out of the v0.10.0 headless pipeline API (`docs/DOCUMENTATION.md` §8) once
  someone picks this up.
- Cross-validate **MLE 3D vs Phasor 3D** on real bead data — only checked against synthetic ground
  truth and mutual self-consistency so far.
- **3D detection beyond astigmatism** — Double Helix, Biplane, etc. could be added later as
  additional methods in the `3D calibration` module, alongside today's astigmatic σ_x/σ_y-vs-z
  approach.
- Cross-validate **NeNA and FRC** against established tools (ThunderSTORM, Picasso, FRCbar) — both
  still ship marked experimental.
- **3D FSC** (Fourier Shell Correlation) — the spherical-shell counterpart to 2D FRC, once the 3D
  voxel-grid memory cost is bounded.
- **Multi-emitter fitting** for dense/overlapping PSFs. Single-emitter fitting biases positions
  where PSFs overlap, and a faster single-emitter fit can't fix that — a better initial guess
  doesn't help when there's no good single-emitter optimum to find in the first place (see the
  rejected phasor-seeding idea in the v0.3.0 changelog entry, which ran into exactly this).
- **Robust detection threshold.** `mean + k·σ_noise` is computed over the whole filtered frame
  including signal, so at high blink density the threshold rises and dim localizations get
  silently dropped — detection sensitivity is density-dependent. Consider MAD or a low percentile
  of the filtered image instead. Also: threshold statistics currently include border pixels never
  searched for maxima; and plateau handling needs a look — the local-maximum test uses strict `>`,
  so two equal adjacent pixels can both survive as separate localizations from one emitter.

  **Feasibility check (2026-09-13), real GATTA-PAINT data + a line-for-line port of Picasso's own
  `identify_in_image`/net-gradient detector for comparison:** a naive MAD (sort a copy of the frame,
  twice) is 10-33x slower than the current threshold and gets worse with size — not shippable. MAD
  via quickselect (median + MAD-of-deviations, two O(n)-average selections, no full sort) is the only
  realistic version: ~2x the current threshold's cost at 1024×1024 (the current mean+k·σ is
  essentially free, ~O(n), next to the band-pass itself). A single percentile via quickselect is
  cheaper still (~1.2x) but has no size/density-stable default the way `k` does. Picasso's own
  single-parameter net-gradient detector was, surprisingly, the SLOWEST option tested — 6-7x the
  current cost at every size and worsening with frame size — because its local-maxima test is a
  naive box×box window scan with no separable acceleration (numba JIT buys it a constant factor, not
  a change in that O(box²·w·h) scaling); "one parameter" isn't "cheap" here. **Open question, not yet
  tested**: could just lowering `k` in the current formula recover the same dim localizations MAD
  does, without the cost? Likely not robustly — MAD's real benefit is that its noise estimate stays
  roughly constant as density varies *within* one movie (high breakdown point), while a single fixed,
  manually-lowered `k` has no such adaptivity: tuned low enough to help on a dense frame, it would be
  too permissive (more noise false-positives) on a sparser frame from the same movie. Needs a
  synthetic density-sweep check before treating either claim as settled.
- **σ_PSF estimation from the data**, instead of a fixed, user-supplied value.
- **Photon calibration beyond a single scalar gain/offset.** Single-image gain/offset estimation
  from the data itself (PCFO, a photon-transfer-curve variant) shipped in 0.10.2. A scalar still
  reasonably approximates an EMCCD chip, but most current SMLM runs on sCMOS, where gain, offset
  and read noise are all pixel-dependent — still open: **per-pixel** calibration maps, with a noise
  model that uses them.

  **Complexity comparison, Huang/Picasso vs. ACCéNT** — both reduce to the SAME two-step shape: (1)
  per-pixel offset + read-noise from dark data alone, a simple temporal mean/variance pass,
  architecturally identical to FTM's own per-pixel temporal computation (already proven at scale
  here); (2) per-pixel GAIN from a per-pixel linear regression of variance vs. mean across several
  DIFFERENT signal levels — the same `polyfit`-grade math either way, so the math isn't the
  differentiator:
  - **Picasso/Huang** varies signal level via CONTROLLED ILLUMINATION (a bright reference series,
    several movies at different brightness). Simple math, but needs a dimmable/controllable light
    source most setups aren't automated for — and since webSMLM has no camera control, the user
    has to capture that series externally and just load the resulting movie(s); real UI/
    data-management overhead (matching several movies to their own intensity "level") on top of the
    easy dark-only step.
  - **ACCéNT** varies signal level via EXPOSURE TIME instead, exploiting that dark current is
    itself Poisson and scales with exposure time — no light source needed, a genuine ergonomic win.
    But the published protocol uses 5–10 exposure times × up to a few thousand frames each
    (~8,000–20,000 frames total, per Diekmann et al.) — MORE total acquisition than Picasso's own
    single 1,000-frame dark series — and needs precise per-block EXPOSURE-TIME bookkeeping
    webSMLM's TIFF loader doesn't track today (`tiffScaleHint()` reads `finterval=`/pixel size from
    ImageJ-style description text, not a literal "exposure time for this movie" tag): likely the
    same "several separate movie files, matched up by hand" burden as Picasso's bright series, just
    on a different axis. Also genuinely unverified from the literature summary alone (re-check the
    primary source before committing): whether ACCéNT's own per-pixel GAIN output is meaningfully
    higher-resolution than a coarse/near-global estimate in practice — dark current's usable
    dynamic range is small next to real photon flux, so it may not clearly beat Picasso's
    bright-series gain map on FIDELITY, only on acquisition ergonomics.
  - **Neither is obviously the smaller port** — both need new multi-movie/multi-condition data
    plumbing for the gain step specifically; the dark-only offset/noise step is the easy part
    either way, common to both.

  **No shortcut for the GAIN map — a real correction, not just an open question.** An earlier draft
  of this note proposed reusing PCFO's own tile-pooling trick per-tile-position instead of globally,
  as a cheap per-pixel gain estimate. That doesn't work, and the reason is structural: a per-pixel
  gain needs REPEATED measurements of ONE SPECIFIC PIXEL at several genuinely different, deliberately
  varied signal levels, so a slope can be fit for that pixel alone. PCFO's global fit instead gets
  its dynamic range by pooling DIFFERENT PIXELS' single-frame brightness together — valid only for
  estimating a gain SHARED across the whole pool. Borrowing brightness variation from a neighbouring
  tile to estimate "the gain at this one location" bakes in the assumption that gain is locally
  uniform, which is circular — it can't detect the very pixel-to-pixel differences it's meant to
  measure. A single tile's own frame-to-frame fluctuation isn't a substitute either: ordinary SMLM
  background stays roughly constant between frames at any one location, so there's rarely genuine
  signal-LEVEL variation to regress against there in the first place. **Per-pixel offset and
  read-noise variance ARE genuinely free from one ordinary dark movie** (temporal mean/variance per
  pixel, single condition, no varied illumination or exposure needed — same shape as FTM's existing
  per-pixel temporal pass). **Gain is not** — it structurally needs the same multi-condition
  acquisition Picasso/Huang or ACCéNT use (an illumination series or an exposure-time ladder),
  applied globally so every pixel is measured at the SAME set of true signal levels. There's no
  cheaper substitute; v1 should implement one of those two protocols properly, not look for a
  shortcut around the underlying statistics.

  **A cheaper first step than implementing any of the above: just LOAD maps computed elsewhere.**
  ImageJ/Fiji (via ACCéNT's own plugin) or Picasso itself can already produce offset/gain/variance
  maps — webSMLM doesn't have to own the acquisition-and-regression pipeline to benefit from
  per-pixel calibration, only the "load a map, feed it into `mleNewtonFit()`'s existing `var` hook"
  half. This is a MUCH smaller, self-contained v1 (a file loader + the small MLE accumulator change
  from Huang's note above, no new acquisition UI, no multi-condition file plumbing at all) —
  probably worth doing before, or instead of, building any in-app calibration workflow. Likely a
  niche feature either way (most users won't have or want to run a separate calibration pipeline),
  so low urgency, but a good candidate for "small effort, real capability" if anyone asks for
  sCMOS-aware fitting before the bigger acquisition workflow is worth building.

  **Proposed integration** (per discussion, for whichever route actually gets built): stays inside
  the existing **Gain & offset estimation** module (`pcfoBox`), not a new sidebar section — a
  camera-model select, **EMCCD** (today's scalar path, unchanged, stays the default) vs. **sCMOS**
  (per-pixel), reveals sCMOS-specific inputs: at minimum a "Load calibration map" file picker (the
  cheap route above); if the in-app acquisition workflow is ever built too, also a dark-movie loader
  (offset + read-noise variance, one file) and, for gain, a loader for SEVERAL movies at different
  known-varying conditions (a bright series or an exposure-time ladder) — genuinely new file/
  condition-management UI, not a reuse of whatever single stack happens to already be loaded. The
  two existing buttons keep doing their own jobs, not new ones: **Estimate** runs either the current
  pooled-global regression (EMCCD) or the new per-pixel regression across the loaded calibration
  movie(s) (sCMOS); **Transfer estimates** either writes the scalar `gain`/`camoffset` fields as it
  does today, or — sCMOS path — stashes the computed maps into new module-level state the fit
  pipeline reads instead of a scalar.

  References, newest first:
  - Picasso's own implementation
    (https://picassosr.readthedocs.io/en/latest/localize.html#scmos-camera-calibration): dark movie
    (1000+ frames) → offset + read-noise-variance maps; optional bright reference series at several
    illumination levels → gain map. Loaded maps override the scalar `gain`/`camoffset` fields (set
    to the maps' own medians, then disabled) — matches the "Transfer estimates" idea above closely.
  - Diekmann, Deschamps, Li et al., "Photon-free (s)CMOS camera characterization…," *Nat. Commun.*
    **13**, 3362 (2022), https://doi.org/10.1038/s41467-022-30907-2, and its companion tool
    **ACCéNT** (github.com/ries-lab/Accent, GPL-3.0) — see the comparison above.
  - Babcock, "Multiplane and Spectrally-Resolved SMLM with Industrial Grade CMOS cameras,"
    *Sci. Rep.* **8**, 1726 (2018), https://doi.org/10.1038/s41598-018-19981-z — per-pixel noise on
    cheaper industrial (not scientific-grade) sensors; useful background on how much read-noise
    non-uniformity to expect across camera tiers, i.e. how much a map actually buys a given user.
  - Huang et al., *Nat. Methods* **10**, 653–658 (2013), https://doi.org/10.1038/nmeth.2488 — the
    original model, and the reason applying a map is a smaller lift than it looks regardless of how
    it's obtained: read-noise variance enters the Poisson likelihood as an ADDITIVE
    equivalent-photon term on both data and model (`data+var/gain²` vs `model+var/gain²`), not a
    separate noise term. The MLE fitters' shared `mleNewtonFit()` accumulator is already
    per-pixel-`var`-aware (Picasso's own `_estimator_terms(mle, value, data, var)`, see **fit** in
    `CLAUDE.md`) — swapping today's scalar `var` for a per-pixel lookup needs no new solver.
    Phasor/LS have no equivalent hook, so a first pass should scope this to MLE methods only.

  Genuinely unscoped beyond the above: storage format for a computed/loaded map (a JSON sidecar of
  flat `Float32Array`s, like the existing 3D calibration JSON, is the likely choice — ADU² variance
  and a gain ratio don't fit comfortably in a 16-bit-integer TIFF the way a segmentation label mask
  does, though a float-sample TIFF isn't ruled out, not checked against the UTIF-based reader); how
  a map's pixel indices track a cropped/streamed stack (likely needs the same offset bookkeeping
  `makeCroppedStack()` already does for the movie itself); whether Load/Save Settings should
  round-trip a map at all (probably its own file, too large for the flat settings JSON); and whether
  DETECTION should also become noise-map-aware — a separate, likely harder problem tangled up with
  "Robust detection threshold" above, not assumed solved here.
- Optional **fiducial-based drift correction** when beads are present (simpler and more accurate
  than AIM for that specific case).
- **3D point-cloud view** — an interactive, rotatable scatter (orthographic projection, colour = z)
  as an alternative to the depth-coded 2D reconstruction, where localizations at different z that
  overlap in x/y currently blend together.
