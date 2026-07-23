# webSMLM — Refactor & Roadmap Plan

Working document. Captures the envisioned development steps beyond v0.1.0, with
technical grounding in the current single-file implementation (`webSMLM.html`).

> Code is referenced by **function name** rather than line number, since line
> numbers shift with every edit. All functions live in the final `<script>` block
> of `webSMLM.html`, organised as `io · detect · fit · render · pipeline`.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

> This is the forward-looking phase plan. For the per-release history (including
> non-phase releases like the 0.6.x UI / robustness series) see
> [`../CHANGELOG.md`](../CHANGELOG.md).

---

## Roadmap (by version)

Going forward we track work by **version number**, not phase number — the phase
scheme was executed out of order and several releases never mapped to a phase
(see [`../CHANGELOG.md`](../CHANGELOG.md)). The design sections below retain
their historical "Phase N" headings as a record; new work is version-keyed.

**Shipped** (headline features; full list in the changelog):

| Version | Feature |
|---|---|
| v0.2.0 | UI / responsive redesign |
| v0.3.0 | Speed & bottleneck review (~7× / ~30×) |
| v0.4.0 | CSV export (ThunderSTORM-style) |
| v0.5.0 | 3D phasor (astigmatism) |
| v0.6.0–0.6.x | UI overhaul & pipeline polish; large multi-IFD stacks; TIFF fixes |
| v0.7.0 | Drift correction (AIM, 2D + 3D) |
| v0.7.1–0.7.7 | JS-disabled warning; wavelet detection filter (default); UI polish; PNG image export + raw scale bar |
| v0.8.0 | Localization precision — **NeNA** + **FRC** (2D), experimental |

**Next:**

| Version | Plan |
|---|---|
| **v0.8.x / 0.9.0** | **FSC** (3D FRC over spherical shells) · cross-validate NeNA/FRC against established tools |
| later | Scriptable / headless pipeline (see below) · Poisson MLE fitting · localization filtering · 3D point-cloud view |

---

## Phase 1 — UI improvements & small-screen support  ☑ *(v0.2.0)*

**Goal:** a layout that works on phones/tablets, with controls ordered to match
the actual analysis workflow.

### 1a · Data acquisition controls
- ☑ **"Load movie" and "Simulate movie" as two smaller side-by-side buttons.**
  Simulation matters (demo, validation, teaching) but is *not* a core function
  and should not dominate the panel.
- ☑ **Collapse simulation parameters behind a disclosure** (`<details>` or a
  toggle), hidden until "Simulate movie" is chosen. Currently frames / blink
  density / photons sliders are always visible and visually outweigh the real
  data path.

### 1b · Action buttons
- ☑ Dedicated **"Run localisations"** button (exists; keep prominent).
- ☑ Dedicated **"Save localisations"** button — wired up in **Phase 3**;
  ship it disabled-until-results in this phase so the layout is final.

### 1c · Control ordering & labelling
- ☑ **Fit method selector must come *before* fitting parameters.** The relevant
  parameters differ per method, so choosing the method first is the correct
  information hierarchy (and lets us show/hide method-specific parameters).
- ☑ **Disambiguate the sigmas with subscripts.** Three distinct quantities are
  currently all called "σ", which is genuinely confusing:
  | Current label | Should be | Meaning |
  |---|---|---|
  | "PSF σ (px)" | **σ_PSF** | PSF width, drives DoG scales + fit init |
  | threshold "k·σ" | **σ_noise** | std-dev of the *band-passed* image |
  | "Render blur (px)" | **σ_render** | display-only smoothing |
  *Implemented as plain underscores* (`σ_PSF`, `σ_noise`, `σ_render`) — `<sub>`
  markup rendered unreliably, and the underscore form reads correctly everywhere.
- ☑ **Replace numbered section headers** ("1 · Data", "2 · Detection & fit",
  "3 · Render") **with simple grey separator lines.** The numbering implies a
  rigid order that no longer holds once controls are regrouped.
- ☑ **Move "Pixel size (nm)" into the rendering group.** It affects the scale
  bar, nm-space rendering and data export — not detection or fitting, which
  operate in pixel units.

### 1d · Input affordances
- ☑ **Add padding between the value and the spinner arrows** in all number
  inputs (`input.num`). *Resolved by removing the native spinners entirely* —
  padding alone cannot separate them (the spinner is laid out over the padding
  box), and the arrows rendered black-on-black in Chrome and crowded the digits
  in Firefox. Values are typed; arrow keys still step them.

### 1e · Responsive / mobile (structural)
Current blockers found in the CSS and event wiring:
- ☑ `.wrap` is a hard `grid-template-columns:300px 1fr` → must collapse to a
  single column under a breakpoint (~768px), sidebar above or in a drawer.
- ☑ `.canvases` is `1fr 1fr` → stack vertically on narrow screens.
- ☑ `.stats` is `repeat(4,1fr)` → wrap to 2×2 on small screens.
- ☑ `.wrap` uses `min-height:calc(100vh - 64px)`, hard-coding the header height;
  brittle if the header wraps on mobile. Prefer flex/auto sizing.
- ☑ **Touch support is entirely missing.** The zoom/pan handlers on the SR canvas
  bind `wheel`, `mousedown`, `mousemove`, `mouseup`, `dblclick` only — there is
  no touch path at all, so pan/zoom is unusable on mobile. Migrate to
  **Pointer Events** (`pointerdown`/`pointermove`/`pointerup`) and add
  **pinch-to-zoom** (two-pointer distance ratio) plus double-tap to reset.
- ☑ Sidebar `overflow:auto` inside a fixed-height grid can trap scrolling on
  touch; verify with `-webkit-overflow-scrolling`.

### 1f · Also delivered in v0.2.0 (beyond the original scope)
- ☑ **Colour-map selector** — Fire (default), Inferno, Viridis, Grey. The two
  matplotlib maps are perceptually uniform (verified monotonic luminance).
- ☑ **Percentile display scaling** ("Display max", default 99.9 %) via a
  4096-bin histogram, so one hot pixel no longer dims the reconstruction.
- ☑ **Live reconstruction preview** — the super-res view refreshes every 100
  frames alongside the raw view; preview cost is excluded from the reported
  compute time so the speed metric stays honest.
- ☑ **Stop button** — aborts a run and keeps partial results; statistics report
  frames actually processed so ms/frame and loc/frame remain correct.
- ☑ *Bug:* Load/Simulate were clickable mid-run and could swap the stack out
  from under the loop; both are now locked for the duration of a run.
- ☑ *Bug:* the raw canvas had no initial size and fell back to the 300×150
  canvas default, drawing a 2:1 black placeholder next to a square one.

---

## Phase 2 — Speed review (core priority)  ☑ *(v0.3.0)*

**Speed is a primary design goal.** Below: measured/structural bottlenecks, then
the assumptions worth challenging.

### 2a · Where the time actually goes
Per frame the pipeline runs `bandpass()` → `findMaxima()` → per-ROI fit.

**The band-pass dominates.** `bandpass()` runs two separable Gaussian blurs:
- small scale σ = 0.8·σ_PSF → for σ_PSF=1.3: radius 4 → 9-tap kernel
- large scale σ = 3.0·σ_PSF → for σ_PSF=1.3: radius 12 → **25-tap kernel**

Separable, so cost ≈ 2·(2r+1) multiply-adds per pixel per blur:
~18 (small) + ~50 (large) ≈ **68 MACs/pixel/frame**. At 128² that is ~1.1M
MACs/frame; at 512² it is ~18M/frame. The **large-scale blur alone is ~75% of
detection cost**, and its kernel grows linearly with σ_PSF.

### 2b · Measured results (GATTA-PAINT 80R: 1999 frames, 82x83, 16-bit BE)

| | Baseline | After index maps + box cascade + MessageChannel yield |
|---|---|---|
| Phasor total | 5377 ms | **797 ms (6.7x)** |
| Gaussian LS total | 5803 ms | **1391 ms (4.2x)** |
| detect | 4872 / 4671 ms | **769 / 765 ms (~6.2x)** |
| localizations | 10891 / 10890 | 10850 / 10849 (**-0.38%**) |
| yield overhead | ~500 ms (9%) | ~25 ms (3%) |

Profile after these changes: **phasor is 96% detect** (fit irrelevant);
**Gaussian LS is 55% detect / 43% fit** (fit optimisation now worthwhile).

**Final Phase 2 results** (adding kernel symmetry + Web Worker pool), measured
from `file://`:

| Dataset | v0.2.0 | v0.3.0 | Speed-up |
|---|---|---|---|
| GATTA-PAINT 80R (82x83 x 1999) | 5377 ms | ~714 ms | **7.5x** |
| Nile Red / *L. lactis* (256x256 x 1173) | 20493 ms | **677 ms** | **30.3x** |

Localization counts are identical before/after the worker pool, confirming
parallelism does not perturb the numerics. Note the reported "CPU time across
workers" over-states the benefit on Apple Silicon, because efficiency cores
inflate summed CPU time; wall-clock is the honest measure.

Remaining, deliberately not done (~10% combined, exact): fuse the DoG subtract
into the blur's vertical pass; fuse `findMaxima`'s two statistics passes.

Per-candidate fit cost measured at **0.3 us (phasor) vs 55.8 us (Gaussian LS)** —
a 186-265x ratio, not the ~100x previously claimed in the UI.

### 2c · Optimizations, roughly by value/effort
- ☑ **Replace the large-scale Gaussian with a box-filter cascade.** Three passes
  of a running-sum box filter approximate a Gaussian closely and cost **O(1) per
  pixel independent of σ** (~6 ops/px vs ~50). The large blur is only a
  *background estimate* for DoG subtraction — exact Gaussian shape is not
  scientifically required here. **Biggest single win, low risk.**
- ☐ **Or: recursive/IIR Gaussian** (Deriche, van Vliet) — also O(1) per pixel per
  axis, closer to a true Gaussian if we want to keep the DoG mathematically tight.
- ☐ **Compute the background blur on a downsampled image.** The large-scale term
  is smooth by construction; compute at ½ or ¼ resolution and bilinearly
  upsample for a further 4–16× saving with negligible error.
- ☑ **Web Worker pool — the biggest structural win.** Frames are embarrassingly
  parallel. A pool of `navigator.hardwareConcurrency` workers, each handling
  whole frames, should scale near-linearly. `Float32Array` frames are
  *transferable*, so hand-off is zero-copy. Interacts with the streaming loader
  (decode and fit would need to pipeline); design carefully.
- ✗ **Seed the Gaussian LS fit with the phasor estimate — rejected.** The idea
  was that phasor is ~100x cheaper and gives a sub-pixel start, so Gauss-Newton
  would need fewer iterations. It does not survive contact with dense data:

  Phasor takes the first Fourier coefficient of the ROI row/column sums, i.e. an
  intensity-weighted position over the whole window. With a second emitter in
  that window it returns a point *between* the two, so it is no better than the
  local maximum as a starting guess and can be worse — the maximum at least sits
  on a real emitter.

  More fundamentally, on overlapping emitters the optimiser is not slow because
  the start is poor; it is slow because **there is no good single-emitter
  optimum to find**. A better initial guess cannot fix model mismatch.

  The optimisation therefore has the wrong shape: it helps least exactly where
  fit cost is highest. Measured per-candidate LS cost was **56 us on the sparse
  GATTA stack vs 211 us on the dense Nile Red stack** — the 3.8x difference is
  iterations spent on emitters the model cannot describe.

  The real answer for dense data is **multi-emitter fitting** (or stricter
  rejection of candidates whose fit residual stays high), not a faster
  single-emitter fit. Speeding up a fit that returns biased positions optimises
  the wrong thing.
- ☐ **Exploit separability of the Gaussian in the fit inner loop.** `exp()` is
  called win² times per iteration (49 for win=7); since
  exp(−d²/2s²) = exp(−dx²/2s²)·exp(−dy²/2s²), precomputing 2·win row/column
  exponentials per iteration cuts transcendental calls ~7×.
- ☐ **Cheaper line search.** 25 halving steps is very conservative; an Armijo
  condition with 3–4 steps is standard and nearly always sufficient.
- ☐ **Fuse the two threshold passes.** `findMaxima()` traverses the image twice
  (once for mean, once for variance). A single pass accumulating Σx and Σx²
  (or Welford) halves that traversal. Small but free.
- ☐ **WebGPU/WebGL**: band-pass as a fragment/compute shader, and replace the
  render accumulation loop with GPU point splatting. Highest ceiling, highest
  effort — worth prototyping only after workers.
- ☑ *(done in v0.1.0 follow-up)* Band-pass scratch buffers hoisted; hot path no
  longer allocates per frame.
- ☑ **Precomputed mirrored index maps in `blurInto`.** The clamp closure was
  called once per tap (~925M calls per 2000-frame run); replaced by lookup
  tables plus a direct-indexed interior. Bit-identical output.
- ☑ **Unclamped yield.** `setTimeout(0)` is throttled to ~4 ms by browsers and
  cost ~9% of runtime; replaced with a MessageChannel round-trip.

### 2d · Assumptions worth challenging
These are correctness/robustness assumptions that also interact with speed:
- ☐ **`mean + k·σ_noise` is computed over the whole filtered frame, signal
  included.** At high blink density the emitters inflate σ_noise, raising the
  threshold and silently dropping dimmer localizations — i.e. detection
  sensitivity is *density-dependent*. Consider a robust estimator (MAD, or a
  low percentile of the filtered image) so the threshold reflects background only.
- ☐ **Threshold statistics include border pixels** never searched for maxima.
- ☐ **Plateau handling:** the 8-neighbour test uses strict `>`, so two equal
  adjacent pixels both survive → duplicate localizations from one emitter.
- ☐ **Fixed, user-supplied σ_PSF.** No estimation/calibration from the data;
  a poor σ_PSF degrades both the DoG band and the fit initialisation.
- ☐ **No overlapping-emitter handling.** Single-emitter fitting per ROI; at high
  density this biases positions. Multi-emitter fitting is a larger project.
- ☐ **LS, not Poisson MLE** (already documented as a known limitation).
- ☐ **Phasor photon estimate is the raw ROI sum, with no background subtraction**
  — directly blocks Phase 3; see below.

---

## Phase 3 — CSV export (ThunderSTORM-compatible)  ☑ *(v0.4.0)*

**Goal:** "Save localisations" writes a CSV that drops into existing
ThunderSTORM-based workflows.

- ☐ **Target column set** (ThunderSTORM convention):
  `id, frame, x [nm], y [nm], sigma [nm], intensity [photon], offset [photon],
  bkgstd [photon], uncertainty [nm]` — plus `z [nm]`, added with Phase 4 (v0.5.0).
- ☐ **Background and photon-count estimation for phasor.** The phasor fitter
  currently reports `photons` as the plain ROI sum, which conflates signal with
  background and is not a usable `intensity [photon]` value. Implement the
  **mask-based estimation from the original pSMLM paper**: estimate background
  from a perimeter/annulus mask of the ROI, subtract, and integrate the
  remainder for the photon count. This is the main technical work of the phase.
- ◐ Photon calibration: **exposed as scalar gain + offset (v0.3.0-dev), but see
  the caveat below** — with gain=1 the exported "intensity [photon]" is really
  ADU, and the log says so.

### 3a · The ADU-to-photon problem (open)

Everything downstream of the photon count inherits its errors. `uncertainty [nm]`
scales as 1/sqrt(N), so a wrong conversion factor silently produces
plausible-looking but wrong precision figures — on the GATTA stack the exported
uncertainty came out at ~5 nm, which is optimistic for DNA-PAINT and is most
likely an ADU/photon artefact rather than a real result.

**Without a known conversion the column is not physically meaningful.** Options,
in increasing order of rigour:

1. Document loudly that values are ADU unless gain is set (**done**).
2. Let the user enter a scalar gain/offset from the camera datasheet (**done**).
3. Estimate gain from the data itself via a photon-transfer curve
   (variance-vs-mean across frames is linear with slope = gain). Feasible here
   since we already stream every frame, and it would remove the need for the
   user to know their camera.
4. Per-pixel calibration maps — see below.

**Why this is harder than it looks on modern cameras.** ThunderSTORM and much of
the surrounding convention date from the **EMCCD** era, where a single scalar
gain describes the whole chip reasonably well. Most current SMLM is done on
**sCMOS**, where gain, offset and read noise are all **pixel-dependent**. A single
scalar is therefore an approximation that is wrong pixel-by-pixel, and sCMOS read
noise additionally varies across the chip, which affects both detection (a noisy
pixel can masquerade as an emitter) and the precision estimate.

Doing this properly means per-pixel gain/offset/variance maps and a noise model
that uses them, as in Huang et al., "Video-rate nanoscopy using sCMOS
camera-specific single-molecule localization algorithms", *Nat. Methods* **10**,
653-658 (2013), https://doi.org/10.1038/nmeth.2488.

That is a substantial piece of work and probably belongs with Poisson MLE
fitting rather than with the exporter, but it is the honest answer to "is my
intensity column in photons?".

### 3b · Note on cross-validation against ThunderSTORM

Comparing localization-by-localization against ThunderSTORM is not
apples-to-apples, for two independent reasons:

- **Different detection**: ThunderSTORM's default is a wavelet filter, webSMLM
  uses a DoG band-pass with a mean+k*sigma threshold. The candidate sets differ
  before any fitting happens.
- **Unknown ADU/photon**: without the conversion, intensity and uncertainty
  cannot be compared on an absolute scale in either direction.

Useful comparisons are therefore *relative* — distributions, spatial patterns,
and whether the same structures appear — not absolute per-localization values.
- ☐ Uncertainty column: use Thompson/Mortensen precision formula from
  intensity, background and σ_PSF (cross-check against FRC/NeNA in v0.8.0).
- ☐ Streaming CSV writer so multi-million-localization exports don't build one
  giant string in memory (`Blob` parts / `File System Access API`).

---

## Phase 4 — 3D phasor (astigmatism)  ☑ *(v0.5.0; was Phase 5)*

Implements the 3D half of the pSMLM-3D paper the 2D fitter already follows.

- ☑ **Magnitude ratio → z.** `phasorFit()` already computes the first Fourier
  coefficients in x and y; their **magnitudes** encode PSF ellipticity under an
  astigmatic (cylindrical lens) PSF. The ratio |F₁ˣ|/|F₁ʸ| is the z observable —
  most of the required computation is already in the function, currently discarded.
- ☑ **Calibration workflow:** load a bead z-stack, fit magnitude-ratio vs z,
  store the calibration curve (and allow save/load of calibration as JSON).
- ☑ UI: astigmatism on/off, calibration import, z colour-coding in the render.
- ☑ Render: z as colour (depth-coded LUT) over the existing 2D histogram render.
- Reference: Martens et al., *J. Chem. Phys.* **148**, 123311 (2018), and the
  engineered-PSF extension in *Methods* (2020).

---

## Phase 5 — Drift correction  ☑ *(v0.7.0; 2D + 3D; was Phase 6)*

**Method: AIM** (Adaptive Intersection Maximization; Sci. Adv. 2024,
doi:10.1126/sciadv.adm7765; ref impl. picasso/aim.py). Chosen over RCC because
it is **point-based** — no image rendering and **no FFT** for the core estimate
(fits the single-file, no-dependency constraint that RCC/FFT would break, and
that v0.8.0's FRC still has to solve) — and it is **natively 3D** (x/y as a 2D
grid search, z as a separate 1D search), matching the Phasor 3D output.

AIM core: segment localizations in time (~100 frames); for each segment count
**coincident localizations** with the accumulated reference over a small search
window (~60 nm) at a quantization of ~20 nm; the shift that maximizes the count
is the drift. Two passes (first segment as reference, then the whole undrifted
set). Adaptations for webSMLM: **parabola peak fit** for sub-pixel instead of
Picasso's FFT phase refinement; **linear / Catmull-Rom** interpolation of drift
between segment centres instead of SciPy cubic spline.

- ☑ **5a — simulated drift** (ground truth): linear total drift over all frames
  in a random direction; true per-frame drift stored (`simTrueDrift`) for
  scoring. *(v0.7.0)*
- ☑ **5b — AIM 2D**: validated vs. simulated drift (RMS ~3-4 nm). *(v0.7.0)*
- ☑ **5c — apply + display**: reversible correction (raw kept), drift-vs-time
  curve, corrected coords drive render + CSV. Progress bar. *(v0.7.0)*
- ☑ **5d — z drift**: 1-D intersection-max on z. Validated vs. simulated drift
  (RMS ~6–8 nm at a realistic ~40 nm axial precision; ~18 nm at a pessimistic
  130 nm). *(v0.7.0)*
  - **Sawtooth fix.** A broad/noisy z intersection peak gave the parabola
    sub-pixel fit a near-zero curvature term, so it flipped to ±0.5-bin offsets
    on alternating segments — a visible sawtooth (reported on the large 3D
    stack, 500-frame window). Fixed by a linear-preserving `[1,2,1]` segment
    smooth (`_smoothSeg`, applied once on x/y, twice on the noisier z) that
    removes the 2-segment oscillation without touching a genuine linear ramp.
    Same parabola is kept — it is essential for the sharp 2D peaks (2D stays
    2.7/4.4 nm).
  - **Clamped-z exclusion.** Phasor-3D z is clamped to the calibrated
    `[rmin,rmax]`; those locs pile into the two boundary bins as fixed,
    non-drifting spikes that dominate the intersection and both suppress and
    oscillate the estimate. They are excluded (`zClamped` flag from the fitter).
  - **Known limitation.** If the sample's z-range exceeds the calibration, a
    large clamped fraction truncates the in-range population and z-drift is
    under-estimated (validated: even a few % clamp with poor axial precision
    compresses the recovered drift). `correctDrift` warns when >20% of z is
    clamped and recommends widening the z-calibration range.
- ☐ Optional **fiducial-based** correction when beads are present (simpler, more
  accurate).
- ☐ Cross-check: FRC (v0.8.0) should measurably improve after correction — an
  end-to-end validation of both features.

---

## v0.8.0 — localization precision: NeNA + FRC  ☑ *(experimental)*

Well-timed after drift correction (v0.7.0): resolution should measurably improve
after AIM, so FRC doubles as an end-to-end validation of the drift work.

**Why not a per-localization formula?** The **phasor** fitter is fast and
non-iterative but gives **no meaningful per-localization precision** — there is
no CRLB / Thompson–Larson–Webb-style uncertainty as there is for a Gaussian-MLE
fit, and its photon/background estimates are crude. So for precision on
phasor localizations, prefer **empirical / resolution** measures:

- ☑ **NeNA** — per-localization precision from the nearest-neighbour distance to
  the *next frame* (grid index, exact NN). The distance histogram (signal
  Rayleigh, scale √2·σ, + smooth background) is fit by Levenberg–Marquardt and
  σ = b/√2 reported with a covariance error; the histogram+fit is plotted.
  Endesfelder et al., *Histochem. Cell Biol.* 141, 629 (2014). Validated vs.
  synthetic (recovers injected σ within ~2%). **Assumes a static structure** —
  a diffusing probe (e.g. Nile Red membrane PAINT) inflates it.
- ☑ **2D FRC** — split localizations into two **random** halves, render + Hann
  window, 2D-FFT and correlate over frequency rings; resolution = 1/(1/7
  crossing), error = spread over random splits. Compact inline radix-2 FFT
  (Float32, no dependency); reports "< Nyquist" when finer than the sampling.
  Nieuwenhuizen et al., *Nat. Methods* 10, 557 (2013).
- ☐ **3D FSC** (Fourier Shell Correlation) — same idea over spherical shells,
  once the 3D voxel-grid memory is bounded. *Not yet implemented.*
- ☐ **Cross-validate** NeNA and FRC against established tools (ThunderSTORM,
  Picasso, FRCbar) and previously-analysed datasets before treating the numbers
  as authoritative — this is why 0.8.0 ships marked **experimental**.
- **Note on interpretation:** FRC measures *image resolution* (folds in
  labelling density and drift); NeNA measures *per-localization* precision.
  Reporting both is diagnostic — disagreement flags residual drift. Run after
  drift correction.

---

## Cross-cutting considerations

- **Single-file constraint.** The project's identity is one self-contained HTML
  file with no build step. FFT (FRC, v0.8.0), worker pools and calibration I/O
  all add bulk. Workers in particular normally want separate files —
  use `Blob`-URL workers to stay single-file. Worth an explicit decision if the
  file grows unwieldy: keep single-file, or add an optional build that bundles.
- **Validation.** As scientific features land (photon counts, precision, z, drift),
  the synthetic generator becomes the natural ground-truth harness — it already
  knows true emitter positions. Consider extending it to emit known z and known
  drift so the 3D, drift and precision work can be validated quantitatively
  rather than by eye.
- **Regression safety.** There are currently no automated tests. Even a minimal
  headless check (fixed-seed synthetic stack → assert localization count and
  RMS error within bounds) would protect the numerics through this refactor —
  and it falls out of the scriptable pipeline below for free.
- **Branching.** `main` is the live GitHub Pages site and Zenodo release line;
  do this work on `webSMLM_local` (or per-phase branches) and merge when a phase
  is complete and validated.

---

## Later — scriptable / headless pipeline

**Goal.** Run the full pipeline (load → detect/fit → drift → export) *without
clicking through the UI*, so one can (a) batch-process many files in one go, and
(b) run an identical end-to-end scenario across browsers and compare results and
timings. Requested as a "for later" item.

- ☐ **Config-driven core.** The pipeline currently reads settings straight from
  the DOM (`$('...').value`). Factor that into a plain **config object** the
  pipeline accepts (file/source, pixel size, fit method, detection k·σ, fit
  radius, drift `{seg, roi, z}`, render/export options); the UI just builds the
  config. This decoupling is the main piece of work.
- ☐ **Small public API**, e.g. `window.webSMLM.analyze(config) → Promise<result>`
  returning localizations + per-stage timings + drift; and `analyzeBatch(files,
  config)` looping over multiple `File`s or URLs.
- ☐ **Cross-browser benchmark mode.** A fixed scenario (bundled simulated stack
  or a fixture URL) auto-run via a URL trigger (e.g. `?bench=default`) that dumps
  a **machine-readable JSON report** — per-stage timings, worker utilisation,
  localization count, and a **result hash** for correctness comparison. Open the
  same URL in each browser and diff the JSON. (Directly answers the "why is it
  faster in browser X" question with numbers.)
- ☐ **Regression check** reuses the same entry point: fixed-seed synthetic →
  assert localization count and RMS within bounds (see Cross-cutting above).
- Single-file constraint preserved: an exposed API + optional URL-param autorun,
  no build step. Output stays the existing CSV plus the JSON run report.


### Phase 4 — future ideas
- ☐ **3D point-cloud view.** The depth-coded render is a 2D projection: where
  localizations at different z overlap in x/y, the colour blends. An interactive
  rotatable point cloud (orthographic scatter, colour = z) would show the true 3D
  distribution. Needs a small 3D projection/rotation on a canvas (no external
  library, to stay single-file) — possibly a separate view mode alongside the
  reconstruction and calibration plot.
- ☐ Gaussian 3D (elliptical fit → z via σx/σy distance-minimisation) as an exact
  counterpart to Phasor 3D.
