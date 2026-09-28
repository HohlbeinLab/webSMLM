# Vectorial PSF simulation — design research memo

> **Historical design note.** Written before the vectorial simulator was built; implemented and
> shipped in webSMLM 0.13.0, with some decisions revised on measurement (the 'direct' polar
> quadrature evaluator was removed; the 3D path uses the nearest kernel plane rather than a
> two-plane blend). For current behaviour see `docs/DOCUMENTATION.md` (§2 Simulation and the
> Simulation guide); for the history, `CHANGELOG.md`.

Status: research/decision memo, no implementation yet. Written for the `vectorial_simulation`
branch, before any code changes. Covers only the specific question raised: how to *sample and
place* a vectorial PSF for simulation purposes, given two candidate approaches. Cubic-spline PSF
models (the field's actual dominant convention for this problem — see the footnote at the end) are
deliberately **not** recommended here; that door is left open for later, not closed.

## 1. Problem statement

webSMLM's built-in "Simulate movie" generator (`MODULE: simulation`, `webSMLM.html`,
`generateSynthetic()` around line 3461) currently draws every emitter as a fixed-`sigma=1.3`
**analytic 2D Gaussian**, evaluated per pixel via closed-form erf integration. That works because
a Gaussian is separable and has a closed-form pixel integral — there is no sampling problem at
all: any sub-pixel emitter position can be plugged straight into the erf formula.

A real **vectorial PSF** (Richards–Wolf / Debye–Wolf diffraction integral) has no such closed
form. It must be *evaluated numerically* on some grid, and then an emitter at an arbitrary
sub-pixel position (not sitting on that grid) needs a way to get a correctly-shifted copy of the
PSF onto the camera-pixel grid the simulated frame lives on. Two candidate approaches were
proposed for how to do that:

- **Option 1** — precompute a *very* densely oversampled PSF (the original proposal: 0.1 nm
  lateral, 1 nm axial step) and place it via lookup, at the cost of large storage and
  initialization time.
- **Option 2** — precompute a coarser, pixel-scale PSF stack (camera pixel size laterally, 1–10 nm
  axial step) and place it at an arbitrary sub-pixel position via the **Fourier shift theorem**
  (FFT → subpixel phase-ramp multiply → inverse FFT).

## 2. Option 1 — oversampled PSF + lookup/interpolation

**Mechanism.** Precompute the vectorial PSF on a fine xy/z grid once (per optical-parameter set:
NA, wavelength, immersion medium, aberrations). To place an emitter at an arbitrary sub-pixel
position, either (a) nearest-grid-point lookup, (b) bilinear/trilinear interpolation between grid
samples, or (c) treat the PSF as a normalized 2D probability density and Monte-Carlo sample
individual photon arrival positions from it directly — the last option is the *physically correct*
way to generate shot noise (see below), rather than rendering a mean image and Poisson-sampling
each output pixel afterward.

**Precedent.** GDSC-SMLM's model plugins do exactly this: bilinear interpolation to insert a PSF
onto the pixel grid, and separately a Monte-Carlo photon-by-photon sampling mode treating the PSF
as a probability density for noise generation. Real-time SMLM lookup-table *fitters* (not
simulators, but the same underlying primitive) use comparably fine precomputed templates — one
cited implementation uses >100,000 9×9-pixel templates (~264 MB) to fit up to 600 emitters per
frame in under 10 ms on a single CPU core — confirming that "big precomputed table, looked up
per call" is a normal, fast pattern in this field.

**How fine does the grid actually need to be?** The original proposal (0.1 nm lateral / 1 nm
axial) is far finer than optically necessary. A diffraction-limited PSF core (FWHM roughly
250–300 nm at visible wavelengths and typical NA) is fully described once sampled at or above the
Nyquist rate for the *optical* resolution — not the camera pixel size, and not an arbitrarily fine
grid. Direct literature evidence on the actual factor needed: **Fu et al., "Up-sampled PSF enables
high-accuracy 3D super-resolution imaging," bioRxiv 2024.10.31.620776 (2024)** find that modeling
the PSF on a grid only **~2–3× finer than the traditional ~100 nm SMLM camera pixel** (i.e.
~33–50 nm grid spacing) — reconstructed from coarser, pixelated bead data via maximum-likelihood
estimation — recovers the high-frequency detail lost to pixelation and reaches near-Cramér–Rao
-bound localization precision, with diminishing returns beyond that factor. Taking this as the
field's own empirical answer rather than a purely theoretical Nyquist estimate: a **2–5× lateral
oversampling of the camera pixel** (roughly 20–50 nm/px at a 100 nm camera pixel, erring toward
the upper end for margin) plus a z-step matched to the PSF's own axial curvature (commonly
10–25 nm in astigmatism-calibration literature) is enough. Literal 0.1 nm/1 nm sampling multiplies
storage and compute by orders of magnitude for no accuracy gain the cited literature can detect.

**Pros:** simple, robust, no periodic-boundary/aliasing failure mode, matches how the field
actually builds these lookup structures, cheap per-placement (see §4).
**Cons:** the *stack itself* is still bigger than Option 2's coarser one at equal xy extent —
though at a corrected oversampling factor this is a modest, not extreme, cost — and needs
interpolation for the axial dimension unless the z-step matches simulation needs exactly.

## 3. Option 2 — coarse pixel-sampled PSF + FFT subpixel shift

**Mechanism.** Precompute the PSF at coarser resolution (down to the camera pixel size laterally),
then place it at an arbitrary sub-pixel offset via the Fourier shift theorem: FFT the tile,
multiply by a linear phase ramp corresponding to the desired sub-pixel translation, inverse FFT.
This is mathematically exact for a *periodic, band-limited, adequately sampled* signal.

**Two different literatures, worth separating.** The best-matched literature for this technique is
for *estimating* an unknown sub-pixel shift between two images (image registration), not for
*synthesizing* an arbitrary, known shift the way placing a PSF at a chosen emitter position would
— same underlying math (the shift theorem), opposite direction of use.

- **Foroosh, Zerubia & Berthod, "Extension of phase correlation to subpixel registration,"
  *IEEE Trans. Image Processing* 11(3):188–200 (2002).** This is the anchor reference for how the
  shift-theorem machinery behaves under *imperfect* sampling. They derive analytically that when
  the input images are themselves downsampled/aliased, the phase-correlation peak is **not** a
  clean delta/sinc at the true shift, but a **downsampled 2-D Dirichlet kernel** whose energy
  spreads across several adjacent coherent peaks instead of concentrating cleanly. It's a
  shift-*estimation* paper, not a shift-*synthesis* one — but the Dirichlet-kernel result is the
  precise underlying reason Option 2 needs its own PSF tile adequately sampled *before* a shift is
  applied: the same aliasing failure mode degrades a synthesized shift, not just an estimated one.
- **Bernstein & Gruen, "Resampling images in Fourier domain," *Publications of the Astronomical
  Society of the Pacific* 126:287 (2014), arXiv:1401.2636.** The better-matched reference for the
  actual *synthesis* direction Option 2 needs: Fourier-domain interpolation with wrapped sinc
  functions, and explicit treatment of periodic-boundary handling (zero-padding) to avoid
  wraparound.
- **Guizar-Sicairos, Thurman & Fienup, "Efficient subpixel image registration algorithms,"
  *Optics Letters* 33(2):156–158 (2008).** The field's efficient variant: instead of a full
  zero-padded FFT, use a selective matrix-multiply DFT to upsample only the small region actually
  needed, cutting cost and memory substantially versus a naive padded-FFT shift. Directly relevant
  to bringing down Option 2's per-placement cost (see §4).

No direct SMLM-*simulator* citation was found applying FFT-domain shifting specifically to
per-emitter PSF placement — it is well established for whole-image registration/resampling, not
this narrower use.

**Real implementation risk.** A PSF tile is not periodic. FFT-domain shifting implicitly assumes
periodic boundary conditions, so without adequate zero-padding and edge windowing/apodization,
energy wraps around the tile edges — Gibbs ringing, the same aliasing/Dirichlet-kernel-adjacent
artifact family Foroosh et al. characterize, and a well-documented concern in the Bernstein & Gruen
resampling literature. It is a manageable, well-understood risk, not a fatal flaw — but it is an
extra correctness-sensitive step, and this codebase's own history (`CLAUDE.md` documents many
real, previously-shipped bugs from subtle math/indexing issues elsewhere in the app) suggests
being cautious about introducing one without strong need.

**Pros:** smaller base PSF stack at equal accuracy (once both options are corrected to realistic
oversampling, the storage gap shrinks considerably — see §4).
**Cons:** needs careful padding/windowing to avoid ringing; a per-placement transform is costlier
than direct interpolation at bulk-simulation call volumes (see §4); the base tile still needs to
be sampled at roughly the same 2–5× factor as Option 1 for the shift theorem to behave cleanly, so
it isn't actually escaping the oversampling requirement, just applying it differently.

## 4. Computational-speed comparison

Two genuinely separate costs, worth pulling apart:

### One-time PSF-stack creation cost

Evaluating the Richards–Wolf vectorial integral over the chosen xy/z grid is, at a comparable sane
grid, **roughly the same order of magnitude for both options** — the cost scales with grid point
count, not with what happens to the stack afterward. The raw integral is known to be slow to
evaluate directly (cost grows with the number of pixels per plane); the field's standard fix is
FFT- or chirp-Z-transform-accelerated evaluation.

**Concrete number:** Sedukhin, "Ultrafast vectorial calculation of tightly focused vortex and
non-vortex fields in a meridional plane," *Optics Communications* 558:130237 (2024), reports that
rewriting the Debye–Wolf/Richards–Wolf integral into a form evaluable by FFT or chirp-Z-transform
speeds up calculation of typical meridional field patterns by **two to three orders of magnitude**
versus direct numerical integration. The same family of result is echoed more generally (without
as specific a multiplier) in "Revisiting PSF models: unifying framework and high-performance
implementation," *J. Microsc.* (2025) / arXiv:2502.03170, which frames Fourier- and
Bessel/chirp-Z-based evaluation as a unifying fast-computation strategy for the same integral.

This matters for *either* option's up-front generation step, and is the main reason the original
0.1 nm-xy/1 nm-z proposal is expensive in absolute terms: it multiplies grid point count (and so
this one-time cost) by roughly three orders of magnitude over a sane, literature-supported grid,
for no detectable accuracy benefit.

### Per-emitter-per-frame placement cost

This is where the two options genuinely diverge — and it is the cost that dominates total
simulation runtime, since a bulk SMLM simulation places thousands of emitters across thousands of
frames, paying this cost repeatedly:

- **Option 1 (lookup + interpolation).** Placing one emitter is trilinear interpolation over a
  small tile — a handful of multiply-adds per output pixel, no transform involved. This is the
  same primitive real-time SMLM *fitters* rely on for speed (the ~600-emitters-in-~10 ms/core
  figure cited in §2 uses exactly this kind of precomputed-template lookup), confirming it is
  cheap enough for real-time, per-emitter, per-frame use at the volumes an SMLM simulation needs.
- **Option 2 (FFT subpixel shift).** Placing one emitter needs a forward transform of the tile, a
  phase-ramp multiply, and an inverse transform. Done naively (a zero-padded FFT), that's an
  O(N log N) cost per placement — markedly more expensive per call than direct interpolation. The
  field's efficient variant (Guizar-Sicairos, Thurman & Fienup, 2008, §3) avoids the full
  zero-padded FFT by using a selective matrix-multiply DFT to upsample only the needed region,
  cutting cost and memory substantially — but it is still a per-call transform, not a fixed small
  number of multiply-adds. At the call volumes a bulk simulation needs (many thousands of
  placements), it remains costlier in aggregate than Option 1's interpolation even with this
  optimization applied.

**Net:** Option 1 is cheaper, or at worst comparable, on the one-time creation cost once sanely
gridded, and clearly cheaper on the repeated placement cost that actually dominates total
simulation runtime.

## 5. Recommendation

**Option 1, implemented at a sane oversampling factor — not the original 0.1 nm/1 nm proposal.**
Concretely: a moderately oversampled xy/z PSF stack, roughly **2–5× the camera pixel laterally**
(per Fu et al. 2024's empirical finding in §2), with an axial step tuned to the PSF's own
curvature (commonly 10–25 nm), placed via bilinear/trilinear interpolation — or, for the
noise-generation step specifically, true per-photon Monte-Carlo sampling from the
PSF-as-probability-density, which is the physically correct way to reproduce Poisson shot noise
rather than an approximation of it.

**Reasoning.** Once both options are corrected to the *actually necessary* sampling density
(the literature's empirical 2–5×, not the camera pixel and not an arbitrarily fine grid), Option
1's storage/compute cost stops being extreme, it is cheaper per-placement than Option 2 at the
volumes a bulk SMLM simulation needs (§4), and it avoids Option 2's real, correctness-sensitive
failure mode (FFT periodic-boundary ringing on a non-periodic PSF tile, §3) entirely. Option 2's
storage advantage is real but shrinks considerably once Option 1 is also sanely gridded — it's
worth recording as a documented future optimization if storage ever becomes a genuinely binding
constraint, not as the initial implementation, in keeping with this codebase's general preference
(`CLAUDE.md`) for the simplest correct approach over a premature or riskier optimization.

## 6. Footnote: cubic-spline PSF models exist, and are the field's actual default

Not recommended here, per explicit direction, but worth recording for future reference: the SMLM
field's most common answer to "how do you sample and place a PSF with no closed form" is neither
of the two options above in pure form, but a **cubic B-spline representation** fitted to a
moderately oversampled calibration grid, then evaluated continuously at any (x, y, z) via spline
interpolation. See Li et al., "Real-time 3D single-molecule localization using experimental point
spread functions," *Nature Methods* 15:367–369 (2018) (the "spline PSF" used by SMAP); DECODE
(Speiser et al., *Nature Methods* 18:1082–1090, 2021), which uses cubic-spline PSF models to
generate simulator-learning training data; and the dynamic-spline 4Pi-STORM work (*Nature
Methods*, 2022). It combines much of Option 1's smoothness/accuracy without storing every fine
grid step, and sidesteps Option 2's FFT-ringing risk — but it is explicitly out of scope for the
current decision.

**Update**: `simulation_psfInterp`'s eventual default landed on `'cubic'` (Catmull-Rom bicubic —
close in spirit to, though not literally, the cubic B-spline models above), matching this
footnote's own observation that cubic is the field's actual default. Option 2 (this section's
FFT-shift approach) was also later added as a genuinely opt-in `'fft'` mode on the same setting —
not because the rejection reasoning above changed, but purely so it can be loaded and A/B-compared
against `'cubic'` directly. See `docs/design/VECTORIAL_ZERNIKE_PSF_IMPLEMENTATION.md` §10 for what
shipped.

## 7. Open questions for implementation (not answered here)

- Which vectorial PSF formulation/reference implementation to base generation on — e.g. a
  Richards–Wolf Cartesian-parameterised implementation — consistent with webSMLM's
  single-file/no-dependency constraint (`CLAUDE.md`: no bundler, no npm dependency inside
  `webSMLM.html` itself; any ported code must be inlined with its license honoured).
- Concrete default oversampling factor and z-step to ship (§5 gives a range, not a single number).
- Where in `MODULE: simulation` this plugs in without disturbing the existing Gaussian path —
  most likely a new PSF-model selector alongside the current fixed-Gaussian generator, not a
  replacement of it.

## Sources

- GDSC SMLM documentation, "Model Plugins" (gdsc-smlm.readthedocs.io) — bilinear PSF insertion vs.
  Monte-Carlo photon probability-density sampling for noise generation.
- PSF Generator (Icy/BIII, biii.eu/psf-generator) — Richards & Wolf vectorial model reference
  implementation, alongside Born & Wolf / Gibson & Lanni scalar models.
- Real-time 3D SMLM lookup-table fitting (PMC8407837) — precedent for large precomputed PSF
  template tables and their per-call cost (fitting context, not simulation, but the same
  underlying lookup/interpolation primitive and speed evidence: ~600 emitters/~10 ms/core).
- Foroosh, H., Zerubia, J. B. & Berthod, M., "Extension of phase correlation to subpixel
  registration," *IEEE Trans. Image Processing* 11(3):188–200 (2002).
- Bernstein, G. M. & Gruen, D., "Resampling images in Fourier domain," *Publications of the
  Astronomical Society of the Pacific* 126:287 (2014), arXiv:1401.2636.
- Guizar-Sicairos, M., Thurman, S. T. & Fienup, J. R., "Efficient subpixel image registration
  algorithms," *Optics Letters* 33(2):156–158 (2008).
- Fu, Y. et al., "Up-sampled PSF enables high-accuracy 3D super-resolution imaging," bioRxiv
  2024.10.31.620776 (2024).
- Sedukhin, A. G., "Ultrafast vectorial calculation of tightly focused vortex and non-vortex
  fields in a meridional plane," *Optics Communications* 558:130237 (2024).
- "Revisiting PSF models: unifying framework and high-performance implementation," *Journal of
  Microscopy* (2025), arXiv:2502.03170.
- (Footnote only) Li, Y. et al., "Real-time 3D single-molecule localization using experimental
  point spread functions," *Nature Methods* 15:367–369 (2018); DECODE (Speiser, A. et al.,
  *Nature Methods* 18:1082–1090, 2021); dynamic-spline 4Pi-STORM (*Nature Methods*, 2022).
