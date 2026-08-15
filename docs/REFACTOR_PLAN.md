# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

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
  Remaining, not yet implemented:
  - **Multi-order chaining** (0-1-2-3+, matching `sSMLMAnalyzer`'s
    `sSMLMA.java` full feature set) — Phase 1 deliberately handles 2-point
    pairs only; nothing in the real Fig. 2 reference dataset examined so far
    demonstrates a genuine 2nd-order signal to validate a chaining
    implementation against, so this needs its own dataset/validation, not
    just the algorithm.
  - **FFT-based automatic angle/distance detection**, matching
    `sSMLMAnalyzer`'s `AngleAnalyzer.java` (render localizations to an
    image, 2D-FFT it, find the dominant periodic peak — not a drop-in for
    webSMLM's own inline FFT, which is a 1D radix-2 transform for FRC, not a
    2D image FFT + peak-finding routine). Phase 1's **Preview pairs**
    distance/angle histograms cover the same "find my window" need more
    simply for now.
  - **Headless (`window.webSMLM.analyze()`/CLI) exposure** — natural next
    step once Phase 1 has seen real interactive use, same two-step pattern
    as `config.estimateGainOffset`/`config.cropX0` earlier in 0.10.x.
  - A minimum-neighbour-count spatial consistency filter (reject sparse
    false pairs with too few nearby confirmed pairs) — `sSMLMAnalyzer` has
    one, Phase 1 doesn't.

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
