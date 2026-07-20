# webSMLM — Refactor & Roadmap Plan

Working document. Captures the envisioned development steps beyond v0.1.0, with
technical grounding in the current single-file implementation (`webSMLM.html`).

> Code is referenced by **function name** rather than line number, since line
> numbers shift with every edit. All functions live in the final `<script>` block
> of `webSMLM.html`, organised as `io · detect · fit · render · pipeline`.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

---

## Phase overview & dependencies

| # | Phase | Depends on | Notes |
|---|-------|-----------|-------|
| 1 | UI / responsive redesign | — | **☑ Done — shipped in v0.2.0** |
| 2 | Speed & bottleneck review | — | Independent; **core priority** |
| 3 | CSV export (ThunderSTORM style) | background/photon estimation | Needs phasor mask-based estimation |
| 4 | Precision estimation via FRC | 3 (localization list) | 3D variant needs Phase 5 |
| 5 | 3D phasor (astigmatism) | — | **Unblocks 3D in Phases 4 and 6** |
| 6 | Drift correction | 3 | 3D variant needs Phase 5 |

> **Suggested reordering:** Phase 5 (3D phasor) is a prerequisite for the 3D
> parts of both Phase 4 (FSC) and Phase 6 (3D drift). Consider promoting it
> ahead of Phase 4 so the 3D work lands once rather than being retrofitted twice.

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

## Phase 2 — Speed review (core priority)

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

### 2b · Optimizations, roughly by value/effort
- ☐ **Replace the large-scale Gaussian with a box-filter cascade.** Three passes
  of a running-sum box filter approximate a Gaussian closely and cost **O(1) per
  pixel independent of σ** (~6 ops/px vs ~50). The large blur is only a
  *background estimate* for DoG subtraction — exact Gaussian shape is not
  scientifically required here. **Biggest single win, low risk.**
- ☐ **Or: recursive/IIR Gaussian** (Deriche, van Vliet) — also O(1) per pixel per
  axis, closer to a true Gaussian if we want to keep the DoG mathematically tight.
- ☐ **Compute the background blur on a downsampled image.** The large-scale term
  is smooth by construction; compute at ½ or ¼ resolution and bilinearly
  upsample for a further 4–16× saving with negligible error.
- ☐ **Web Worker pool — the biggest structural win.** Frames are embarrassingly
  parallel. A pool of `navigator.hardwareConcurrency` workers, each handling
  whole frames, should scale near-linearly. `Float32Array` frames are
  *transferable*, so hand-off is zero-copy. Interacts with the streaming loader
  (decode and fit would need to pipeline); design carefully.
- ☐ **Seed the Gaussian LS fit with the phasor estimate.** Currently
  `gaussianFit()` initialises x₀,y₀ at the integer maximum and can run up to 20
  Gauss–Newton iterations, each with a 25-step line search. Phasor is ~100×
  cheaper and already gives a sub-pixel start → should cut iterations severalfold
  for free. **High value, very low effort.**
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

### 2c · Assumptions worth challenging
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

## Phase 3 — CSV export (ThunderSTORM-compatible)

**Goal:** "Save localisations" writes a CSV that drops into existing
ThunderSTORM-based workflows.

- ☐ **Target column set** (ThunderSTORM convention):
  `id, frame, x [nm], y [nm], sigma [nm], intensity [photon], offset [photon],
  bkgstd [photon], uncertainty [nm]` — plus `z [nm]` once Phase 5 lands.
- ☐ **Background and photon-count estimation for phasor.** The phasor fitter
  currently reports `photons` as the plain ROI sum, which conflates signal with
  background and is not a usable `intensity [photon]` value. Implement the
  **mask-based estimation from the original pSMLM paper**: estimate background
  from a perimeter/annulus mask of the ROI, subtract, and integrate the
  remainder for the photon count. This is the main technical work of the phase.
- ☐ Photon calibration: intensities are only in photons if gain/offset/ADU
  conversion is applied — expose camera gain + offset, or document that values
  are in ADU.
- ☐ Uncertainty column: use Thompson/Mortensen precision formula from
  intensity, background and σ_PSF (cross-check against Phase 4's FRC).
- ☐ Streaming CSV writer so multi-million-localization exports don't build one
  giant string in memory (`Blob` parts / `File System Access API`).

---

## Phase 4 — Localization precision via FRC

- ☐ **2D FRC**: split localizations into two statistically independent halves
  (odd/even frames, or random 50/50), render both, compute the Fourier Ring
  Correlation curve, and report resolution at the **1/7 threshold**.
- ☐ **3D FSC** (Fourier Shell Correlation) once Phase 5 provides z.
- ☐ Report FRC resolution in the stats bar alongside localization count.
- ☐ **Note on interpretation:** FRC measures *image resolution* (which folds in
  labelling density and drift), not per-localization precision. Keep the
  existing **NeNA** reference as the complementary per-localization measure —
  ideally report both, since disagreement between them is itself diagnostic
  (e.g. residual drift).
- ☐ FRC is FFT-heavy; a small self-contained FFT (or WebGPU) will be needed —
  budget this against the single-file, no-dependency constraint.

---

## Phase 5 — 3D phasor (astigmatism)

Implements the 3D half of the pSMLM-3D paper the 2D fitter already follows.

- ☐ **Magnitude ratio → z.** `phasorFit()` already computes the first Fourier
  coefficients in x and y; their **magnitudes** encode PSF ellipticity under an
  astigmatic (cylindrical lens) PSF. The ratio |F₁ˣ|/|F₁ʸ| is the z observable —
  most of the required computation is already in the function, currently discarded.
- ☐ **Calibration workflow:** load a bead z-stack, fit magnitude-ratio vs z,
  store the calibration curve (and allow save/load of calibration as JSON).
- ☐ UI: astigmatism on/off, calibration import, z colour-coding in the render.
- ☐ Render: z as colour (depth-coded LUT) over the existing 2D histogram render.
- ☐ Reference: Martens et al., *J. Chem. Phys.* **148**, 123311 (2018), and the
  engineered-PSF extension in *Methods* (2020).

---

## Phase 6 — Drift correction

- ☐ **2D: redundant cross-correlation (RCC).** Bin localizations into temporal
  blocks, reconstruct each, cross-correlate all block pairs, and least-squares
  solve for the drift trajectory (more robust than sequential correlation).
- ☐ **3D drift.** ThunderSTORM currently only corrects in 2D; published code
  exists for 3D — evaluate and adapt rather than reimplement. Depends on Phase 5.
- ☐ Optional **fiducial-based** correction as a simpler, more accurate path when
  beads are present.
- ☐ Apply correction to the stored localization list so the render and CSV export
  both reflect it; keep raw + corrected coordinates so it stays reversible.
- ☐ Cross-check: FRC (Phase 4) should measurably improve after drift correction —
  a good end-to-end validation of both phases.

---

## Cross-cutting considerations

- **Single-file constraint.** The project's identity is one self-contained HTML
  file with no build step. FFT (Phase 4), worker pools (Phase 2) and calibration
  I/O (Phase 5) all add bulk. Workers in particular normally want separate files —
  use `Blob`-URL workers to stay single-file. Worth an explicit decision if the
  file grows unwieldy: keep single-file, or add an optional build that bundles.
- **Validation.** As scientific features land (photon counts, precision, z, drift),
  the synthetic generator becomes the natural ground-truth harness — it already
  knows true emitter positions. Consider extending it to emit known z and known
  drift so Phases 4–6 can be validated quantitatively rather than by eye.
- **Regression safety.** There are currently no automated tests. Even a minimal
  headless check (fixed-seed synthetic stack → assert localization count and
  RMS error within bounds) would protect the numerics through this refactor.
- **Branching.** `main` is the live GitHub Pages site and Zenodo release line;
  do this work on `webSMLM_local` (or per-phase branches) and merge when a phase
  is complete and validated.
