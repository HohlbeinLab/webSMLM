# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **v0.10.1 — fast temporal median filter (FTM), analysis frame range,
  corrected/raw scrub toggle.** Port the Hohlbein Lab's own ImageJ plugin
  ([`HohlbeinLab/FTM2`](https://github.com/HohlbeinLab/FTM2)) into webSMLM: a
  per-pixel sliding-window temporal median subtracted from each frame — over
  a window of *W* consecutive frames centred on frame *i*, take each pixel's
  median across the window and subtract it from that pixel's value at frame
  *i*. This corrects pixel-specific fixed-pattern/background noise and
  cleans up detection, since a blinking emitter occupies far less than half
  the window at any one pixel — the window must be chosen so that holds (too
  small a window and the median starts tracking the signal itself, cancelling
  it back out). Used in Jabermoradi, Yang, Gobes, van Duynhoven, Hohlbein,
  *Enabling single-molecule localization microscopy in turbid food
  emulsions*, Philosophical Transactions of the Royal Society A
  **380**(2220), 20200164 (2022), https://doi.org/10.1098/rsta.2020.0164.

  **New controls** (exact placement TBD — not yet decided where in the
  sidebar these belong): a checkbox (`ftmEnabled`) turning the filter on/off,
  and a window-size field (`ftmWindow`, frames) meant to be swept
  interactively to find a size that cleans the background without eating
  real signal — needs its own `PARAMS` entries with real page controls (not
  `id:null`), unlike the worker-dispatch/preview-tuning constants.

  **Raw-panel toggle, corrected vs. raw.** Once FTM is enabled, the raw
  (left) panel's scrubber should let the user switch between the
  FTM-corrected frame and the original uncorrected one (one toggle, not two
  separate panels) — useful for judging at a glance whether a given window
  size is under/over-correcting.

  **Frame range for analysis (start/end), independent of FTM.** Not
  implemented at all today — Localize always processes the whole
  loaded/simulated stack. An `analysisFirst`/`analysisLast` pair (1-based,
  per-dataset working state like the calibration module's existing
  `calFirst`/`calLast`, not a `PARAMS` entry) would let a Run be restricted
  to a sub-range — useful on its own (skip a bleached tail, or a stack with a
  distinct pre-imaging phase) and also relevant to FTM, since FTM2 has its
  *own* independent Start/End (which frames the *filter* runs over, not which
  ones get *localized* afterward) — worth deciding whether webSMLM keeps one
  shared range for both or the same two-range split FTM2 has.

  **Open questions, deliberately unresolved here — need more thought before
  implementing:**
  - *Performance* — benchmarked (Node/V8, not shipped code, just to answer
    this question before committing to an approach): two candidate per-pixel
    sliding-window median algorithms on exactly the case above (500×500 px,
    1000 frames, window=50 → 250,000 independent pixel time-series). (A)
    naive — copy the window into a scratch array and fully resort it every
    slide step — extrapolates to **~257 s** for the full stack, confirming
    this is too slow. (B) keep the window as a sorted scratch array and do a
    binary-search insert + linear-scan removal per step instead of a full
    resort (O(window) per step, not O(window·log window)) — **measured
    directly at 18.8 s single-threaded** for the real full-scale case, a
    ~13× speedup over (A). Still probably too slow for a live/interactive
    sweep of the window-size field (the whole point of exposing it as a
    control), but the per-pixel computation is embarrassingly parallel (each
    pixel's time series is fully independent of every other pixel's) — the
    same worker-pool architecture detect/fit already uses (see **workers**)
    should get this into the same few-second range as a typical Localize
    run; worth prototyping that before reaching for a fancier incremental
    histogram-based median (an O(bins)-per-step structure, likely faster
    still, but more complex and not obviously needed once parallelized).
  - *Where it sits in the pipeline.* Whether FTM output is a full corrected
    stack materialized once before detect/fit (simplest, but a second
    full-stack memory/streaming concern layered on the existing
    `memgb`/`chunkmb` budget system — see **in/out**/**memory & streaming**),
    or computed on demand per requested frame (fine for the raw-panel scrub
    toggle above, which only ever needs one frame's correction at a time;
    not fine for a full Run, which needs every frame's corrected version
    once through detect/fit regardless).
  - *Interaction with gain/photon-unit conversion.* Median subtraction
    happens in raw ADU space; fitting converts `(raw−camoffset)×gain` to
    photons (see **fit** module) — still need a decision on whether FTM runs
    before or after that conversion. Settled: a corrected pixel that goes
    negative (background subtracted below zero — expected/normal for a
    median filter) is simply clamped to zero, not treated as a special case
    by the Poisson-MLE math.

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
- **Photon calibration beyond a single scalar gain/offset.** A scalar
  reasonably approximates an EMCCD chip, but most current SMLM runs on
  sCMOS, where gain, offset and read noise are all pixel-dependent (and
  non-uniform read noise also affects detection — a noisy pixel can
  masquerade as an emitter). Two options, increasing in rigor: (1) estimate
  gain from the data itself via a photon-transfer curve (variance-vs-mean
  across frames, slope = gain — feasible since every frame is already
  streamed through); (2) per-pixel gain/offset/variance calibration maps,
  with a noise model that uses them — see Huang et al., *Nat. Methods*
  **10**, 653–658 (2013), https://doi.org/10.1038/nmeth.2488.
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
