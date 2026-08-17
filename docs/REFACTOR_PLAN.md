# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **File-size/modularity strategy for `webSMLM.html`** (discussed 2026-08-17,
  prompted by two large candidate modules — single-particle tracking (SPT)
  and single-molecule FRET (smFRET) — that would each add a few thousand
  lines). GitHub Pages can technically serve sibling files that `webSMLM.html`
  loads at runtime (`fetch()`/dynamic `import()`), but `file://` (the
  double-click-to-run path the whole single-file design exists for) blocks
  that under CORS in Chromium, inconsistently across browsers — splitting
  the *core* app this way would break the "download and it just works"
  promise unevenly, so it's ruled out. Three options were weighed:
  1. **Lean harder on the existing `MODULE:` banner convention** — cheapest,
     doesn't slow the file's growth, but the size problem is about
     editability (human and AI-assisted), not runtime performance (browsers
     don't care about a multi-MB JS file). **Chosen for now.** Landed in
     0.11.1-dev: a top-of-file **MODULE INDEX** comment block giving each
     module's current line number, refreshed alongside every build-letter
     bump (see `CLAUDE.md`'s Branch & release workflow) rather than left to
     rot — cheap enough to check every round that it should actually stay
     trustworthy, unlike a one-off comment.
  2. **Dev-time-only source split, single-file at ship time**: a `tools/`-tier
     build script (Node, no runtime dependency, matching the existing
     `tools/` precedent of separate optional tooling) concatenates
     `src/*.js` fragments into the final `webSMLM.html`. Solves editability
     without touching the deployed artifact or the `file://` promise at
     all. **Planned next step once SPT/smFRET actually start landing and
     option 1 stops being enough** — not implemented yet. Real cost: it
     makes `webSMLM.html` a build product rather than the literal source of
     truth, a bigger philosophy shift than option 1, worth doing only when
     actually needed rather than pre-emptively.
  3. **Split SPT/smFRET out as their own single-file sibling apps**
     (`webSPT.html`, `webFRET.html`), mirroring the existing
     `docs/layout_bare.html` precedent ("backed up from webSMLM's chrome for
     future single-file projects"). **Considered and set aside**: SPT and
     smFRET would share too much of webSMLM's own pipeline (TIFF loading,
     worker pool, table/render/export) to cleanly separate, and some real
     analyses combine the two techniques directly — per the user, e.g.
     Fontana, Fijen, Lemay, Mathwig & Hohlbein, *High-throughput,
     non-equilibrium studies of single biomolecules using glass-made
     nanofluidic devices*, *Lab Chip* (2018),
     [10.1039/C8LC01175C](https://doi.org/10.1039/C8LC01175C) — splitting up
     front would fight that overlap rather than accommodate it. Revisit only
     if a module turns out to need almost nothing from the shared pipeline.

  **Physical reorder — done in 0.11.1-dev.** The file's physical `MODULE:`
  order had one mismatch against `CLAUDE.md`'s documented order: **export**
  physically sat before **workers**, the reverse of the doc — a leftover of
  modules being retrofitted onto code that predates them, not a deliberate
  choice. Fixed as its own dedicated pass (not bundled into an unrelated
  edit): confirmed first that neither section has top-level `const`/`let`
  state the other reads, nor any `addEventListener` wiring in either range
  (both are pure function/data declarations, hoisted regardless of position,
  so a physical move is a behavioral no-op in JS) — then moved the block and
  re-verified with the syntax check, a direct call to the moved
  `buildCsvText()`, constructing a real `Worker` from the moved
  `workerSource()` (would throw a `ReferenceError` immediately if
  `WORKER_PRELUDE` had gone stale), and a full Localize run with
  `paramOverrides` forcing worker dispatch (`↑ 8 workers · 82% utilisation`,
  correct localization count) to exercise the pool path for real, not just
  its single-threaded fallback. File's physical order now matches
  `CLAUDE.md`'s documented list end to end.

- **Nikon ND2 loading — feasibility researched 2026-08-17, blocked on a real
  sample file.** Requested by a new user. ND2 has **no official public
  specification** — every existing reader (Bio-Formats, both `nd2reader`
  packages) is reverse-engineered, and there are two genuinely different
  format variants:
  - **Legacy**: image data is **JPEG2000-compressed**. Not worth attempting
    — no lightweight JS JPEG2000 decoder exists comparable to what `pako`
    already does for deflate; a real decoder would be a large, complex
    addition disproportionate to likely benefit. Detect and reject with a
    clear error rather than half-support it.
  - **Modern** (NIS-Elements 4.0+, chunk-based container, file signature
    literally `"ND2 FILE SIGNATURE CHUNK NAME01!Ver3.0"`): image data is
    **uncompressed or Zip/deflate-compressed** — the tractable case, since
    `pako` is already inlined for exactly that compression. A loader would
    reimplement the chunk-map container parsing (analogous in spirit to how
    **in/out** already walks TIFF's multi-IFD chain) and plug into the
    existing `getFrame()/getFrames()` stack abstraction, so nothing
    downstream (detect/fit/FTM/etc.) needs to know the source format.
  - **License landscape matters here**: Bio-Formats' ND2 reader and both
    `nd2reader` packages are GPLv3+/GPL — not safe to port code from into
    this CC-BY project (same reasoning that already keeps this codebase
    MIT-only for `pako`/UTIF). [`tlambert03/nd2`](https://github.com/tlambert03/nd2)
    is **BSD-3-Clause**, pure Python, no Nikon SDK dependency for the modern
    format — the one safe reference to port chunk-parsing logic from, with
    attribution in the head banner matching the `pako`/UTIF precedent. No
    existing JS/WASM ND2 reader was found anywhere (the one "web ND2
    viewer" that exists, `miuraTakashi/ND2-Viewer`, is a Flask server
    calling `tlambert03/nd2` in Python — nothing runs client-side).
  - **Real blocker**: no spec means real risk of subtly-wrong metadata
    (frame dimensions, bit depth, pixel calibration) with no way to
    validate short of a real file — there's no ground truth to check
    against otherwise. **Waiting on a real modern-variant ND2 sample**
    (from the requesting user or the lab's own scopes) before writing any
    parser code, the same "get a real reference dataset first" approach
    used for the sSMLM CSV and the other `experimental_data/` fixtures.

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
