# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **FTM (fast temporal median filter) — implemented as a scrubbing-time
  preview; Localize integration still open.** `ftmEnabled`/`ftmWindow`
  `PARAMS` controls live in the "Memory, streaming & loading" sidebar
  module; full current behaviour is in `docs/DOCUMENTATION.md` §2's FTM
  section and `CLAUDE.md`'s **in/out** module note, not duplicated here.
  The technique originates with Nieuwenhuizen, Lidke, Bates, Puig, Grünwald,
  Stallinga, Rieger, *Measuring image resolution in optical nanoscopy*,
  *Nat. Methods* **10**, 557–562 (2013), https://doi.org/10.1038/nmeth.2448;
  ported from the Hohlbein Lab's own newer implementation,
  [`HohlbeinLab/FTM2`](https://github.com/HohlbeinLab/FTM2), used in
  Jabermoradi, Yang, Gobes, van Duynhoven, Hohlbein, *Enabling
  single-molecule localization microscopy in turbid food emulsions*, *Phil.
  Trans. R. Soc. A* **380**(2220), 20200164 (2022),
  https://doi.org/10.1098/rsta.2020.0164.

  **Design history — two approaches tried, the first reverted.** The first
  implementation ran FTM once over the *whole* stack right after loading,
  replacing `stack` itself with the corrected version (parallelized
  spatially across the worker pool — row bands, no overlap needed, since
  each pixel's computation depends only on its own value across every
  frame, unlike detection which needs a border margin; measured 0.5 s for a
  200×200×800/window=50 stack with 8 workers). That design had a real
  memory problem: every pixel's full temporal history had to be
  materialized *twice* (raw input + corrected output) before any frame was
  addressable again, which doesn't work once a stack is too big to hold
  both copies — chunked, overlapping input fetching (as discussed) would
  only have halved peak memory, not solved the deeper issue that the
  corrected *output* still needed full random-access, and `makeStack()`'s
  interface has no streamed/on-disk backing for freshly-computed data the
  way it does for an original file. Reverted in favour of computing the
  correction **live, one frame at a time** (`ftmFrame()`/
  `ftmFrameParallel()`): a raw/FTM-corrected toggle next to the raw panel
  (`rawFtmBtn`) recomputes the correction for whichever frame is currently
  scrubbed to, fetching only a `ftmWindow`-frame window of context around
  it — small and bounded regardless of stack length, so the memory problem
  doesn't arise at all. Simpler algorithmically too: a one-shot median per
  pixel, no sliding-window bookkeeping needed, since only one frame's
  output is ever wanted at a time.

  Measured (500-frame synthetic stacks, window 50, 8 workers): ~23 ms at
  128×128, ~35 ms at 256×256, ~130 ms at 512×512, ~510 ms at 1024×1024 per
  scrubbed frame — fine for occasional scrubbing at smaller frame sizes,
  noticeably laggy for rapid dragging on large ones. Not addressed further
  yet; a finer row-band split, or reusing detect/fit's frame-batch workers
  differently, are options if this needs to get faster.

  **Still open:**
  - **Apply FTM to an actual Run, not just the scrubbing preview.**
    Localize still analyzes the original, uncorrected stack regardless of
    the toggle. Wiring FTM into `runCore()` would need its own design pass
    — likely the per-frame approach above, run just-in-time as each frame
    is about to be detected/fit (naturally bounded, same as the preview),
    rather than a separate whole-stack pass.
  - **Interaction with gain/photon-unit conversion**, if FTM ever reaches
    Localize: median subtraction happens in raw ADU space; fitting converts
    `(raw−camoffset)×gain` to photons (see **fit** module) — still need a
    decision on whether FTM would run before or after that conversion. The
    floor-at-0 clamp is also not quite the same noise distribution the
    Poisson-MLE fitters otherwise assume (which models a
    Poisson-distributed background around some *positive* mean), which
    could bias fitted background/photon counts and reported uncertainty
    low in very dim regions.

  Also relevant: `fitFirstFrame`/`fitLastFrame` (the analysis frame range,
  done in an earlier round — see `docs/DOCUMENTATION.md` §1/§2) are a
  *separate* range from FTM2's own independent Start/End (which frames the
  filter itself runs over, not which ones get localized afterward).

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
