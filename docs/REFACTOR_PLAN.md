# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

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

- **`tempClusteringMemory`** — gap-frame tolerance for temporal clustering. `clusterEvents()`
  (table module) currently requires strictly consecutive frame numbers to chain detections into
  one event (memory=0, hardcoded) — a molecule that blinks off for even one frame starts a new
  chain instead of extending the old one. `tempClusteringMemory = N` would allow up to N missed
  frames between detections of the same chain. Needs a decision on how a gap should weight into the
  position average (still "on" for the photon-weighted mean, or purely bridge the chain without
  contributing) before implementing. Already flagged in-app as "planned" (see `webSMLM.html` near
  `clusterEvents()`).

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
- **σ_PSF estimation from the data**, instead of a fixed, user-supplied value.
- **Photon calibration beyond a single scalar gain/offset.** Single-image gain/offset estimation
  from the data itself (PCFO, a photon-transfer-curve variant) shipped in 0.10.2. A scalar still
  reasonably approximates an EMCCD chip, but most current SMLM runs on sCMOS, where gain, offset
  and read noise are all pixel-dependent — still open: **per-pixel** calibration maps, with a noise
  model that uses them. References, newest first:
  - Picasso's own implementation
    (https://picassosr.readthedocs.io/en/latest/localize.html#scmos-camera-calibration) is the
    closest prior art to mirror: a dark movie (1000+ frames) gives offset (temporal mean) and
    read-noise variance (temporal variance) maps; an optional bright reference series at several
    illumination levels adds a gain map (per-pixel photon-transfer-curve slope). Loaded maps
    override the scalar `gain`/`camoffset` fields (set to the maps' own medians, then disabled).
  - Diekmann, Deschamps, Li et al., "Photon-free (s)CMOS camera characterization…," *Nat. Commun.*
    **13**, 3362 (2022), https://doi.org/10.1038/s41467-022-30907-2, and its companion tool
    **ACCéNT** (github.com/ries-lab/Accent, GPL-3.0) — gets offset/gain/variance from DARK frames
    alone, no controlled illumination series needed, a nice match for PCFO's own "no calibrated
    light source required" goal; worth trying before assuming a bright series is necessary.
  - Babcock, "Multiplane and Spectrally-Resolved SMLM with Industrial Grade CMOS cameras,"
    *Sci. Rep.* **8**, 1726 (2018), https://doi.org/10.1038/s41598-018-19981-z — per-pixel noise on
    cheaper industrial (not scientific-grade) sensors; useful background on how much read-noise
    non-uniformity to expect across camera tiers, i.e. how much a map actually buys a given user.
  - Huang et al., *Nat. Methods* **10**, 653–658 (2013), https://doi.org/10.1038/nmeth.2488 — the
    original model, and the reason this is a smaller lift than it looks: read-noise variance enters
    the Poisson likelihood as an ADDITIVE equivalent-photon term on both data and model
    (`data+var/gain²` vs `model+var/gain²`), not a separate noise term. The MLE fitters' shared
    `mleNewtonFit()` accumulator is already per-pixel-`var`-aware (Picasso's own
    `_estimator_terms(mle, value, data, var)`, see **fit** in `CLAUDE.md`) — swapping today's scalar
    `var` for a per-pixel lookup needs no new solver. Phasor/LS have no equivalent hook, so a first
    pass should scope this to MLE methods only, matching Picasso's own precedent.

  Rough shape, not designed in detail: a calibration step (dark[+bright] movie, same
  `loadTiffFile()` path everything else uses) computing offset/variance(/gain) maps via a per-pixel
  temporal mean/variance pass — architecturally close to FTM's own per-pixel temporal computation,
  mean/variance instead of median, over the whole movie rather than a sliding window. Storage
  probably a JSON sidecar (like the existing 3D calibration JSON) holding the maps as flat
  `Float32Array`s — ADU² variance and a gain ratio don't fit comfortably in a 16-bit-integer TIFF
  the way a segmentation label mask does, though a float-sample TIFF might work too, not checked
  against the UTIF-based reader. Genuinely unscoped: how a loaded map's pixel indices track a
  cropped/streamed stack (likely needs the same offset bookkeeping `makeCroppedStack()` already does
  for the movie itself), and whether DETECTION should also become noise-map-aware — a separate,
  likely harder problem tangled up with "Robust detection threshold" above, not assumed solved here.
- Optional **fiducial-based drift correction** when beads are present (simpler and more accurate
  than AIM for that specific case).
- **3D point-cloud view** — an interactive, rotatable scatter (orthographic projection, colour = z)
  as an alternative to the depth-coded 2D reconstruction, where localizations at different z that
  overlap in x/y currently blend together.
