# Vectorial + Zernike-mode PSF implementation guide

> **Historical design note.** Written before the vectorial simulator was built; implemented and
> shipped in webSMLM 0.13.0, with some decisions revised on measurement (the 'direct' polar
> quadrature evaluator was removed; the 3D path uses the nearest kernel plane rather than a
> two-plane blend). For current behaviour see `docs/DOCUMENTATION.md` (§2 Simulation and the
> Simulation guide); for the history, `CHANGELOG.md`.

Status: implementation guide, no code written yet. Read this before implementing, and re-scope
against whatever webSMLM actually needs at the time — it is a design brief, not a spec to execute
blindly. Companion to `docs/design/VECTORIAL_PSF_SIMULATION.md`, which settled *how* an oversampled PSF
should be sampled/placed; this document is the concrete follow-up covering *what PSF to generate*
and *where it plugs into webSMLM*.

## 1. Purpose & scope

Adds a physically-grounded, **Zernike-aberrated** PSF option to webSMLM's built-in "Simulate
movie" generator, alongside (not replacing) the existing fixed-`sigma=1.3` isotropic-Gaussian
path. A user can dial in astigmatism, coma, trefoil, spherical aberration, etc., and get synthetic
camera frames whose PSF genuinely reflects that aberration — instead of the current placeholder,
which cannot represent any aberration shape at all.

**Deliberately scalar, not vectorial-in-the-polarization sense.** This model has no
`sqrt(cos θ)` apodization term and no dipole/polarization dyad — matching the reference project's
own deliberate choice (see §2). That keeps "all Zernike coefficients zero" a clean, checkable
regression case (the aberrated model must reduce to the existing symmetric-PSF physics with no
aberration applied) rather than bundling an unrelated physics change into the same feature.

**Relationship to `docs/design/VECTORIAL_PSF_SIMULATION.md`.** That memo compared two ways to sample and
place *any* pre-computed PSF and recommended Option 1 — a moderately oversampled (2–5× the camera
pixel) lookup, placed via interpolation, rather than the original 0.1 nm/1 nm proposal or an
FFT-shift approach. This document is the PSF-*generation* half of the same feature: the physics
that fills in the oversampled kernel Option 1 assumed existed. The two documents compose directly.

## 2. Where this comes from

Ported from a sibling project the user already has working, `C:\GitHub\demoCam_SMLM_MM` — a
Micro-Manager C++ device adapter that simulates a camera feed for testing SMLM acquisition
software, and which already implements exactly this kind of PSF (its own "Step 5" feature). That
repo contains a handoff document written specifically for this porting task by an earlier session
working there: `docs/webSMLM-handoff/zernike-and-astigmatism-notes.md`. This guide is built
directly on it, cross-checked against the actual Java source it references.

**What is and isn't portable.** demoCam_SMLM_MM's PSF code is a C++/JNI bridge into an
embedded-JVM Java layer, itself split into two families:

- Stock `RichardsWolfPSF`/`GibsonLanniPSF`, from EPFL BIG's `PSFGenerator.jar` (**GPL-3.0, not
  this project's own code, not portable, not to be read for licensing reasons beyond the public
  algorithm description**). Despite the "Richards-Wolf" name, these are radially-symmetric-only
  1D Kirchhoff-diffraction-integral models — reading `KirchhoffDiffractionSimpson` shows no
  polarization/apodization dyad at all, and no phi-dependence, so they cannot represent
  non-axisymmetric aberrations (astigmatism, coma, trefoil) in the first place.
- **`GibsonLanniZernikePSF.java`** (~350 lines) — this project's own new class, not part of
  PSFGenerator, algorithmically ported from EPFL's **MIT-licensed** `psf_generator` Python package
  (specifically its `VectorialCartesianPropagator`; see the licensing note in §3 below). This is
  the class this guide ports — small, self-contained math with no external numerical library
  dependency even in the Java version (hand-rolled binomial coefficients, trig, nested loops).

**A gotcha worth repeating**: EPFL's `psf_generator` also has a `VectorialSphericalPropagator`
that looks like the more obviously "vectorial" reference, but its own Zernike helper explicitly
drops any non-axisymmetric term (everything except piston/defocus/spherical) because its whole
parameterization assumes an axisymmetric pupil. Only the **Cartesian** propagator supports general
Zernike terms — check this kind of scope-narrowing in a "general-looking" reference before trusting
its docstring's claimed generality, if a future implementer goes back to `psf_generator` directly.

## 3. Licensing

This is a from-scratch JavaScript re-implementation of a small (~150 lines of actual physics),
self-contained mathematical algorithm, ported — not copied — from EPFL BIG's `psf_generator`
(MIT license, <https://github.com/Biomedical-Imaging-Group/psf_generator>). This is the exact same
"port the algorithm, don't add a dependency, honour the source license" convention `CLAUDE.md`
already documents for other ported features in webSMLM (e.g. FTM from HohlbeinLab/FTM2, sSMLM
pairing from HohlbeinLab/sSMLMAnalyzer). No GPL-3.0 `PSFGenerator.jar` code is touched, read for
implementation purposes, or needed — the Gibson-Lanni sample/immersion-index formulation is a
standard, published optical model (Gibson & Lanni 1991), not GPL-original content, and the Zernike
math is independently well-established. State the MIT source plainly in the code header comment
when implemented, matching webSMLM's existing convention of crediting ported algorithms in the
head banner / module comments.

## 4. The physics, ported to JS-ready pseudocode

Confirmed line-by-line against `GibsonLanniZernikePSF.java` (lines 171–346 of the source file).
**webSMLM keeps the full Gibson-Lanni sample/immersion-index bookkeeping** (not the handoff
document's offered simplification of folding z into a bare defocus-Zernike term) — this models a
real, common SMLM aberration source (imaging through a coverslip/medium different from the
immersion medium) physically rather than only approximately.

### 4.1 Zernike index → (n, m)

OSA/ANSI single-index convention, `j = n(n+1)/2 + l`, `l ∈ [0,n]`, `m = -n + 2l`:

```js
function indexToNM(j) {
  for (let n = 0; ; n++)
    for (let l = 0; l <= n; l++)
      if (n*(n+1)/2 + l === j) return [n, -n + 2*l];
}
```

Indices 0–14 cover every mode through 4th radial order:

| j | mode | j | mode | j | mode |
|---|------|---|------|----|------|
| 0 | piston | 5 | **vertical astigmatism** | 10 | oblique quadrafoil |
| 1 | tip | 6 | oblique trefoil | 11 | oblique secondary astigmatism |
| 2 | tilt | 7 | vertical coma | 12 | primary spherical |
| 3 | oblique astigmatism | 8 | horizontal coma | 13 | vertical secondary astigmatism |
| 4 | defocus | 9 | vertical trefoil | 14 | vertical quadrafoil |

**Verify index 5, not 6, is vertical astigmatism against the formula above before hardcoding
anything** — the source project's own planning docs got this wrong twice before being caught by
computing it directly. Don't trust prose (including this table) over `indexToNM(5)`.

### 4.2 Zernike value (unnormalized convention)

```js
function binomial(a, b) {
  if (b < 0 || b > a) return 0;
  let r = 1;
  for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1);
  return r;
}
function zernikeRadial(n, m, rho) {
  let r = 0;
  for (let k = 0; k <= (n - m) / 2; k++) {
    const coeff = (k % 2 === 0 ? 1 : -1) * binomial(n - k, k) * binomial(n - 2*k, (n - m)/2 - k);
    r += coeff * Math.pow(rho, n - 2*k);
  }
  return r;
}
function zernikeValue(j, rho, phi) {
  const [n, l] = indexToNM(j), m = Math.abs(l);
  const radial = rho <= 1 ? zernikeRadial(n, m, rho) : 0;
  return radial * (l >= 0 ? Math.cos(m*phi) : Math.sin(m*phi));
}
```

**No `sqrt((2n+2)/(1+δ_m0))` orthonormality factor** — this is the *unnormalized* convention, so a
coefficient of 1.0 means "one full wave of `R_n^m(1)` peak amplitude," not "one wave RMS." Keep
this consistent with any preset magnitudes exposed in the UI (§6) — don't mix conventions.

### 4.3 Per-Z-plane pupil precompute

Physical parameters: `NA`, `lambda` (wavelength, m), `ns` (sample refractive index), `ni`
(immersion refractive index), `ti0` (nominal working distance, m), `particleAxialPosition`
(emitter depth into sample, m), `zStep` (axial step between simulated Z-planes, m),
`zernikeCoeffs` (array of 15 wave-unit coefficients). Fixed pupil-quadrature resolution
`N_RHO=20, N_PHI=40` (see §5 for why this specific size, and why it's not user-configurable).

```js
function computePupilForZPlane(z, nz, params) {
  const { NA, lambda, ns, ni, ti0, particleAxialPosition, zStep, zernikeCoeffs } = params;
  const ti = ti0 + zStep * (z - (nz - 1) / 2);   // defocus enters here, per Z-plane
  const k0 = 2 * Math.PI / lambda;
  const bMax = Math.min(1, ns / NA);              // clamp: NA*rho/ns must never exceed 1
  const dRho = bMax / N_RHO, dPhi = 2*Math.PI / N_PHI;

  const krAt = new Float64Array(N_RHO);
  const cosPhiAt = new Float64Array(N_PHI), sinPhiAt = new Float64Array(N_PHI);
  for (let ip = 0; ip < N_PHI; ip++) {
    const phi = (ip + 0.5) * dPhi;
    cosPhiAt[ip] = Math.cos(phi); sinPhiAt[ip] = Math.sin(phi);
  }

  const pupilRe = new Float64Array(N_RHO * N_PHI), pupilIm = new Float64Array(N_RHO * N_PHI);
  for (let ir = 0; ir < N_RHO; ir++) {
    const rho = (ir + 0.5) * dRho;
    krAt[ir] = k0 * NA * rho;

    // Gibson-Lanni sample-index-mismatch/depth OPD — kept in full, not simplified away.
    const s1 = NA*rho/ns, s3 = NA*rho/ni;
    const opd1 = ns * particleAxialPosition * Math.sqrt(Math.max(0, 1 - s1*s1));
    const opd3 = ni * (ti - ti0) * Math.sqrt(Math.max(0, 1 - s3*s3));
    const gibsonLanniPhase = k0 * (opd1 + opd3);

    const rowBase = ir * N_PHI;
    for (let ip = 0; ip < N_PHI; ip++) {
      const phi = (ip + 0.5) * dPhi;
      let zernikePhase = 0;
      for (let j = 0; j < zernikeCoeffs.length; j++) {
        const c = zernikeCoeffs[j];
        if (c !== 0) zernikePhase += c * zernikeValue(j, rho / bMax, phi);
      }
      zernikePhase *= 2 * Math.PI;

      const phase = gibsonLanniPhase + zernikePhase;
      // rho is the polar-coordinate integration measure; constant dRho*dPhi factors are
      // dropped since the downstream sum-to-1 kernel renormalization (§5) cancels them.
      pupilRe[rowBase + ip] = rho * Math.cos(phase);
      pupilIm[rowBase + ip] = rho * Math.sin(phase);
    }
  }
  return { pupilRe, pupilIm, krAt, cosPhiAt, sinPhiAt };
}
```

### 4.4 Pupil → image-plane intensity

Direct 2D numerical quadrature per output pixel — **no FFT**:

```js
function computeIntensityPlane(nx, ny, resLateralM, pupil) {
  const { pupilRe, pupilIm, krAt, cosPhiAt, sinPhiAt } = pupil;
  const x0 = (nx - 1) / 2, y0 = (ny - 1) / 2;
  const slice = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const dyM = (y - y0) * resLateralM, rowOut = nx * y;
    for (let x = 0; x < nx; x++) {
      const dxM = (x - x0) * resLateralM;
      let sumRe = 0, sumIm = 0;
      for (let ir = 0; ir < N_RHO; ir++) {
        const kr = krAt[ir], rowBase = ir * N_PHI;
        for (let ip = 0; ip < N_PHI; ip++) {
          const sp = kr * (dxM*cosPhiAt[ip] + dyM*sinPhiAt[ip]);
          const cosSp = Math.cos(sp), sinSp = Math.sin(sp);
          const pr = pupilRe[rowBase+ip], pi = pupilIm[rowBase+ip];
          sumRe += pr*cosSp - pi*sinSp;
          sumIm += pr*sinSp + pi*cosSp;
        }
      }
      slice[rowOut + x] = sumRe*sumRe + sumIm*sumIm;
    }
  }
  return slice;
}
```

**Regression check, cheap and worth building in from day one**: with every `zernikeCoeffs[j]===0`,
this must reduce (up to overall scale, cancelled by kernel renormalization anyway) to a plain
Gibson-Lanni PSF — no aberration structure, radially symmetric. Compare visually or numerically
(e.g. sample along two perpendicular radii and confirm they match) any time this code changes.

**y outer / x inner loop order matters for cache locality** (sequential writes to `slice[x+nx*y]`
for fixed `y`), and the inner `N_RHO×N_PHI` sum is where essentially all the cost lives — see §5.

## 5. Sampling & performance

**"Oversample once, downsample everywhere"** — the same Option-1 approach
`docs/design/VECTORIAL_PSF_SIMULATION.md` independently recommended for placing *any* PSF turns out to be
exactly what the reference project already does for *this* PSF: compute one oversampled kernel
per distinct `(zernikeCoeffs, z, NA, wavelength, ns, ni, ti0, particleAxialPosition, pixel size)`
combination, cache it, and for each emitter placement box-average a fractional-pixel-shifted
window of the oversampled kernel into the output frame (rather than re-running the physics per
emitter). This is real cross-validation between the two documents, not a coincidence to gloss
over — implement the kernel cache and placement exactly per `docs/design/VECTORIAL_PSF_SIMULATION.md`
§5's recommendation (2–5× lateral oversampling of the camera pixel, axial step tuned to the PSF's
own curvature), keyed on the full parameter tuple above.

**Cost scales as `(oversampled kernel pixels)² × N_RHO×N_PHI × nz`.** The reference project's own
measured numbers (12-core C++/multithreaded, for scale): 65×65px×24 planes ≈ 0.5–0.6 s;
129×129px×24 planes ≈ 2.4–3.1 s; an unbounded 769×769px×71-plane configuration took 90+ seconds
even parallelized. The single biggest lever there was reducing oversampling (12×→4×) and kernel
half-width (32→16 px) — not micro-optimizing the quadrature loop itself. **This matters more in
webSMLM**: a browser tab has no free multithreading, so:

- Default kernel half-width and oversampling factor need to be conservative out of the box —
  start near the low end of the 2–5× range `docs/design/VECTORIAL_PSF_SIMULATION.md` settled on, and a
  kernel half-width sized to cover only the aberrated PSF's actual extent (e.g. a small multiple
  of the diffraction-limited Airy radius), not an arbitrarily generous margin.
- `N_RHO=20, N_PHI=40` should stay fixed, not user-configurable — the reference project tuned this
  down from 32×64 with no measurable accuracy loss (regression check against the unaberrated case
  stayed within run-to-run noise), and it directly multiplies the per-pixel cost.
- **The dedicated-Web-Worker option is the scale-up path, not the day-one implementation.**
  webSMLM already has a precedent for a second, purpose-built worker distinct from the shared
  detect/fit pool: `renderWorkerSource()`/`RENDER_WORKER_PRELUDE` (`webSMLM.html` ~line 6558), a
  single dedicated worker for offscreen rendering, built the same stringified-function way as the
  main pool but structurally separate (its own prelude, its own `onmessage`). If a kernel-cache
  build ever needs to move off the main thread, follow that pattern — a new
  `psfWorkerSource()`/`PSF_WORKER_PRELUDE` sibling — **not** a third message type folded into the
  existing detect/fit pool (`CLAUDE.md`'s Web Worker section explicitly warns against overloading
  that pool's single `onmessage` across job types; each worker has exactly one `onmessage`
  property, not a queue).
- **If parallelized, initialize worker state explicitly and verify output isn't silently empty.**
  The reference project's own Java port hit exactly this: bypassing its execution framework's
  normal per-job initialization (to parallelize manually) skipped a required `live=true` init
  step, silently producing all-zero output for every plane, with no exception. This is the same
  class of bug webSMLM's own `WORKER_PRELUDE` gotcha already guards against (a module-level global
  a stringified worker function relies on must be re-declared in the prelude, or the worker throws
  a `ReferenceError` and silently falls back to single-threaded) — add an explicit
  "output isn't all-zero/empty" sanity check when this is parallelized, don't trust "it ran
  without error."
- Z-plane count (`nz`) is the other multiplier in the cost formula and is directly under user
  control via the simulated z-range/step — keep the default range modest (a handful of hundred nm
  either side of focus, not microns) unless a user explicitly widens it.

## 6. `PARAMS`/UI additions

Concrete proposed entries, following the exact `PARAMS` object-literal shape and comment style
already used in `webSMLM.html` (~2429–2739 is the pattern to match: `type`, `id`, `label`,
`min`/`max`/`step`/`default`, `int`, and a `// name = meaning` comment above each). This section
fixes the *shape*; exact IDs/defaults/ranges are implementation-time decisions, not fixed here:

- **PSF-model selector**, an `enum` alongside the existing `simulation_*` group, e.g.
  `simulation_psfModel: {type:'enum', options:['gaussian','zernike'], default:'gaussian'}` —
  matches the existing `detFilter`/`method` enum-selector convention. Default stays `'gaussian'`
  so nothing changes for existing users/saved settings until they opt in.
- **Optical parameters**: NA, wavelength (nm), and the full Gibson-Lanni set — sample refractive
  index `ns`, immersion refractive index `ni`, nominal working distance `ti0`, emitter depth
  `particleAxialPosition` — each a plain `number` PARAMS entry with physically sensible
  min/max/default (e.g. `ni`/`ns` defaulting to a common oil-immersion value like 1.518, matching
  the reference project's own default).
- **Per-emitter z**: a new field on each simulated event (alongside the existing `x,y,tStart,tEnd`
  in `generateSynthetic()`), plus a `PARAMS` entry for its range/distribution (e.g. a z-range in
  nm the simulator draws from, uniformly or otherwise) — there is no per-emitter z anywhere in the
  synthetic-data path today, so this is new plumbing, not a parameter tweak.
- **Zernike coefficients**: expose a **curated subset**, not all 15 raw number inputs — mirror
  `SMLMZernike.cpp`'s own preset pattern (`AstigmatismWeak/Moderate/Strong`, `ComaWeak/Strong`,
  `SphericalWeak/Strong`, `TrefoilModerate`, `MixedRealisticObjective`, magnitudes in the
  ~0.07–0.3 wave range) as a dropdown, with the underlying array of 15 coefficients settable only
  via the full mechanism (advanced/settings-JSON) for users who want fine control — the same
  "PARAMS entries drive both the visible UI and `paramOverrides`-only advanced fields" split
  webSMLM already uses elsewhere (see `CLAUDE.md`'s **params** module description). **Repeat the
  source project's own caveat verbatim in webSMLM's UI/docs**: these preset magnitudes are
  order-of-magnitude estimates, not paper-sourced — don't present them as calibrated values.

## 7. Where this plugs into `generateSynthetic()`

`generateSynthetic()` (`MODULE: simulation`, `webSMLM.html` ~line 3461) currently renders every
emitter as an isotropic fixed-`sigma=1.3` Gaussian (the render loop around ~3516–3519,
`A*Math.exp(-((x-mx)**2+(y-my)**2)/(2*sigma*sigma))`), with no per-emitter z anywhere. Adding the
Zernike PSF model means:

1. Give each simulated emitter event a z value (§6), alongside its existing `x,y,tStart,tEnd`.
2. When `simulation_psfModel==='zernike'`, build/reuse the kernel cache (§5) keyed on the current
   optical parameters, and splat each frame's active emitters from it (oversample-and-box-average
   placement, §5) instead of evaluating the closed-form Gaussian.
3. Leave the existing Gaussian path completely untouched when `simulation_psfModel==='gaussian'`
   (the default) — this is a new, additive branch, not a rewrite of the existing code path.

## 8. Validation plan

Generate a synthetic stack with `simulation_psfModel='zernike'` and a nonzero coefficient 5
(vertical astigmatism), spanning a z-range through focus, and run it through webSMLM's **existing**
analysis pipeline — no new test infrastructure needed:

- `gaussianFitElliptical`/`gaussianFitEllipticalFixedXY` (`webSMLM.html` ~line 4941, ~4982) fit
  independent `sigma_x`/`sigma_y` per spot.
- `calibrationCore` (~line 7088) fits local-quadratic `sigma_x(z)`/`sigma_y(z)` curves from a bead
  z-stack, plus a phasor-ratio z model.

**Expected, checkable result**: recovered `sigma_x(z)`/`sigma_y(z)` should show the classic
astigmatic signature — roughly equal (symmetric PSF) at focus, diverging oppositely away from
focus in x vs. y — falling out of the Zernike-5 pupil phase naturally, not special-cased anywhere
in the fitter. This is the concrete "did the port work" check: if a synthetic astigmatic dataset
doesn't recover this shape through the existing, already-validated fitting/calibration code, the
PSF generation has a real bug, not just an aesthetic difference from the reference project.

## 9. Open questions / explicitly deferred decisions

Not answered here — flagged for whoever implements this to decide against the actual requirements
at the time:

- **Z-plane interpolation vs. nearest-plane lookup** for the kernel cache. The reference project
  uses nearest-plane lookup only (no interpolation between cached Z-planes, despite having
  considered it during planning) — worth deciding fresh for webSMLM rather than assuming that
  choice carries over, especially since `docs/design/VECTORIAL_PSF_SIMULATION.md` already discusses the
  general tradeoff (interpolation cost vs. z-step fineness) for PSF placement.
- **Exact PARAMS IDs, defaults, and ranges** for everything listed in §6 — this document fixes the
  shape of the parameter set, not final numbers.
- **Whether/when to add a dedicated Web Worker** (§5) — start single-threaded on the main thread
  with conservative defaults; add `psfWorkerSource()` only if real usage shows it's needed.
- **Whether to keep the 15-coefficient array exposed via advanced/settings-JSON only, or eventually
  surface more of it in the visible UI** — start curated (§6), revisit if users ask for finer
  control than the presets offer.

## 10. Shipped: 2D movie-generation wiring, and how to extend to 3D

`generateSynthetic()` now actually consumes `simulation_psfModel==='zernike'` (previously build/
preview only, per §7 above) — this section documents what shipped and, concretely, how a future
per-emitter-z (3D) version should build on it, resolving §9's "Z-plane interpolation vs
nearest-plane lookup" open question for webSMLM specifically.

**What shipped (2D — one fixed emitter depth for the whole movie).**

- `readPsfConfigForSimulation()` (`webSMLM.html`, `MODULE: simulation`) calls the existing
  `readPsfConfigFromUI()` and forces `cfg.nz=1` — an actual movie applies one global
  `simulation_psfDepth` to every emitter (there is no per-emitter z yet), so only the single
  focus-plane kernel is ever built for movie generation, via the same
  `getOrBuildPsfKernelStack()` cache the preview uses. This one line is the entire "2D" scope
  boundary — see below for what changes to lift it.
- The built slice is normalized to `sum===1` once (a probability MASS over the oversampled grid,
  not a density) before the frame loop starts, so per-emitter photon count is exact by
  construction rather than approximated.
- **`simulation_psfInterp`** (`'nearest'|'linear'|'cubic'|'fft'`, default `'cubic'`) selects how
  `sampleKernelAt()` reads the oversampled kernel at a continuous (fractional) index — nearest,
  bilinear, separable bicubic (Catmull-Rom, `a=-0.5`), or a whole-kernel Fourier phase-shift. This
  is the user-facing choice the two companion docs left open (neither commits to one scheme).
  Default moved from `'linear'` (both companion docs' original baseline recommendation) to
  `'cubic'` once a wider literature check confirmed bilinear is well documented as too inaccurate
  for subpixel placement near Nyquist-level sampling, while cubic (bicubic/spline) is the standard
  practical speed/accuracy trade-off actually shipped across SMLM PSF tooling — e.g. the
  cubic-spline PSF model in Babcock & Zhuang, "Isotropic real-time 3D single-molecule localization
  microscopy," *bioRxiv* (2017), later published *Nature Methods* 12(4), 449–452, and the same
  cubic-spline family used by SMAP and DECODE. `'fft'` (Fourier-shift-theorem placement via
  `splatZernikeEmitterFFT()`/`fftShiftKernelTile()`, reusing `fft2d()` from MODULE: locprecision)
  is deliberately **not** the default — see `docs/design/VECTORIAL_PSF_SIMULATION.md` §3/§4 for why: it
  needs a full 2D FFT + inverse per emitter (versus `'cubic'`'s fixed `4×4`-tap sum), assumes
  periodic boundaries so a non-periodic kernel tile risks wraparound (Gibbs) ringing without
  padding, and the accuracy gap versus `'cubic'` is small at the oversampling factors this tool
  already uses (2–5×) — see Guizar-Sicairos, Thurman & Fienup, "Efficient subpixel image
  registration algorithms," *Optics Letters* 33(2), 156–158 (2008) for the field's efficient
  variant of the same technique. It's kept opt-in purely so it can be A/B-compared against
  `'cubic'` directly; a Node-harness numerical check (not checked in) confirmed the two agree to
  ~0.02% of peak value on a synthetic symmetric test kernel across several sub-pixel offsets, with
  photon count conserved exactly by both.
- **`splatZernikeEmitter()`** does the actual placement: for every camera pixel within `camRad` of
  an emitter, it samples `oversample²` sub-cell points of the (fractionally shifted, per the
  emitter's own exact position) kernel via `sampleKernelAt()` and **sums** them (not averages —
  since each kernel entry is a probability mass, summing conserves total photon count; averaging,
  tried first, silently discarded a factor of `1/oversample²` of every emitter's photons — caught
  by a standalone photon-conservation check, not by inspection). This sum-of-interpolated-samples
  step is the literal "interpolate for sub-pixel placement, then box-downsample" pipeline both
  `docs/design/VECTORIAL_PSF_SIMULATION.md` §2 and this document's own §5 describe.
- Verified (standalone Node harness, not checked in): for a synthetic symmetric test kernel, all
  four interpolation modes conserve total photon count exactly regardless of emitter sub-pixel
  position; `'linear'`/`'cubic'`/`'fft'` reproduce the emitter's exact sub-pixel centroid to
  floating-point precision, `'nearest'` quantizes to the oversampled grid's own
  `1/oversample`-camera-pixel resolution (expected — it's the cheap/coarse option, not a bug).
- The existing Gaussian path (`generateSynthetic()`'s original `sigma=1.3` render loop) is
  untouched — purely an additive `if(zKernel){…}else{…}` branch, per this doc's own §7 instruction.

**How to extend to 3D (per-emitter z) — next step, not yet implemented.**

1. Give each simulated event its own `z` (a new field alongside the existing
   `{x,y,tStart,tEnd}` in `generateSynthetic()`'s `events`/`frameEvents`), drawn from a new
   PARAMS-controlled distribution (e.g. uniform over a configurable ± range) — §6 above already
   flagged this as new plumbing, not a parameter tweak.
2. In `readPsfConfigForSimulation()`, **stop forcing `cfg.nz=1`** — build (and cache, via the
   existing `getOrBuildPsfKernelStack()`) the full multi-plane stack the preview already builds,
   swept over `simulation_psfZRange`/`ZStep` around the focal-shift-corrected best-focus plane
   (`MODULE: simulation`'s own `computePsfPupilForZPlane()` already handles that shift correctly,
   see `docs/PSF_PHYSICS.md` §4.2).
3. Per emitter, per frame, pick which slice(s) feed `splatZernikeEmitter()` based on that emitter's
   own `z`: either nearest-plane lookup (`slices[Math.round((z-zMin)/zStep)]`, matching the
   reference C++ project's own choice) or a linear blend of the two nearest planes
   (`(1-f)*slices[z0] + f*slices[z0+1]`) before normalizing/splatting — **only this slice-selection
   step is new**; `sampleKernelAt()`/`splatZernikeEmitter()`'s lateral interpolation-and-downsample
   logic needs no changes at all, since it already operates on "whatever single 2D slice it's
   handed."
4. Record the per-emitter `z` on `groundTruthEvents` (currently 2D-only, no `z` field) so a 3D
   validation run can compare recovered-vs-true depth, the same way `docs/
   VECTORIAL_ZERNIKE_PSF_IMPLEMENTATION.md` §8's existing 2D astigmatism validation plan compares
   recovered `sigma_x(z)`/`sigma_y(z)` shape.
5. Performance note: cost now scales with the full stack's `nz` (kernel BUILD cost only — the
   per-emitter splat cost is unchanged, since it only ever touches one or two slices per
   placement), so the existing "keep the z-range modest" guidance in §5 above applies with the
   same force here.

## Reference map

**In `demoCam_SMLM_MM`** (read-only reference, not to be copied wholesale):

- `docs/webSMLM-handoff/zernike-and-astigmatism-notes.md` — the original handoff document this
  guide is built on.
- `docs/vectorial-psf-plan.md` — full step-by-step history/rationale ("Step 5" is the relevant
  section).
- `CLAUDE.md`'s "Vectorial PSF feature" section — architecture summary and two Gotchas
  subsections with concrete bugs hit during that project's own implementation.
- `DeviceAdapter/SMLMDemoCam/Simulation/SMLMZernike.h`/`.cpp` — OSA index table doc comment and
  preset coefficient values with their sourcing caveats.
- `DeviceAdapter/SMLMDemoCam/Simulation/psfbridge-java/psfbridge/GibsonLanniZernikePSF.java` — the
  actual portable math this guide's §4 pseudocode is transcribed from.

**In `webSMLM`**:

- `webSMLM.html` ~line 3461 (`generateSynthetic`) — simulator to extend.
- `webSMLM.html` ~line 3467, ~3516–3519 — current fixed-`sigma=1.3` isotropic Gaussian render.
- `webSMLM.html` ~line 4941/4982 (`gaussianFitElliptical`/`...FixedXY`) — existing elliptical
  -Gaussian fitter to validate synthetic astigmatic data against.
- `webSMLM.html` ~line 7088 (`calibrationCore`) — existing 3D calibration pipeline to exercise
  end-to-end with synthetic ground truth.
- `webSMLM.html` ~line 2429–2739 (`PARAMS`) — existing parameter-registry convention to match.
- `webSMLM.html` ~line 6558 (`renderWorkerSource`/`RENDER_WORKER_PRELUDE`) — the dedicated
  -second-worker pattern to follow if/when kernel generation needs to leave the main thread.
- `docs/design/VECTORIAL_PSF_SIMULATION.md` — companion memo on PSF sampling/placement strategy this
  guide's §5 builds on directly.

**External**: [EPFL `psf_generator`](https://github.com/Biomedical-Imaging-Group/psf_generator)
(MIT) — the algorithm reference this guide's §4 physics was ultimately ported from (via
`GibsonLanniZernikePSF.java`).
