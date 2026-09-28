# Simulation parity: webSMLM vs. demoCam_SMLM_MM

This is a point-in-time snapshot of the parameter/feature correspondence
between this project's simulator (`webSMLM.html`) and the Micro-Manager
device adapter at `C:\GitHub\demoCam_SMLM_MM`
(`DeviceAdapter/SMLMDemoCam/Simulation/`). **It is not auto-updated.**

- webSMLM snapshot: commit `74654775f2182` (2026-09-08)
- demoCam_SMLM_MM snapshot: commit `35bcbda7c19c2` (2026-08-31) **plus**
  uncommitted working-tree changes made in the session that wrote this
  file (per-emitter 3D + 3D/NPC structures + labeling efficiency,
  `PsfInterp`, `PsfEvalMethod`/chirp-Z) -- see that repo's `CLAUDE.md`
  "webSMLM parity feature" section for the authoritative up-to-date
  status once those changes are committed.

**Partial refresh, 2026-09-19 (webSMLM side only).** webSMLM builds
`2026-09-19a`–`d` added multi-blink photophysics, a structured background,
blinking out-of-focus emitters and scoring criteria. The rows those builds
invalidate are updated below and marked *(webSMLM 2026-09-19)*; **the
demoCam_SMLM_MM column was NOT re-checked** — that repo was not available to
the session making this edit — so wherever such a row says "same" or
"absent" for demoCam it describes the 2026-09-08 snapshot, and every one of
them now reads **webSMLM ahead** until demoCam is diffed again.

**Partial refresh, 2026-09-20 (webSMLM side only).** webSMLM builds
`2026-09-20a`-`h` added an EMCCD sensor path (QE, Gamma gain register,
clock-induced charge, integer ADU at a settable bit depth) with its
analysis-side excess-noise correction, a non-uniform illumination profile,
engineered PSFs (higher-order astigmatism presets and a Gauss-Laguerre
double-helix phase mask) with a per-PSF Cramer-Rao bound, and a PSF-model
fitter (`psfmle`, since moved to the `psf_fitting` branch). Rows those builds invalidate or add are marked
*(webSMLM 2026-09-20)*; **the demoCam_SMLM_MM column was again NOT
re-checked** for the same reason as above.

**Partial refresh, 2026-09-21 (webSMLM side only).** webSMLM builds
`2026-09-21b`-`e` changed how the simulator computes, not what it models:
a block-summed splat (same result to 3e-8, ~10x faster), counter-based
camera noise (pcg4d, so seeded movies changed once), and a WebGPU path for
splat + noise. They also found that the `direct` evaluator is **wrong on
wide kernels**, and build `e` removed it from webSMLM entirely — this
matters to demoCam, whose default is `Direct` (see the PSF-models row and
"Numeric cross-check" §3).
Rows marked *(webSMLM 2026-09-21)*; the demoCam column was again NOT
re-checked.

**Full refresh, 2026-09-21 (BOTH sides).** The demoCam_SMLM_MM column below
was re-checked against that repo's working tree after its "webSMLM parity
round 2" (branch `websmlm-parity-and-property-groups`, on top of commit
`1f7fc53`; see its `CLAUDE.md` section of that name), against webSMLM
build `2026-09-21f` (commit `3b0f800`; 21f only changed a density-preset
default). demoCam_SMLM_MM caught up on every simulation gap this file
listed as "webSMLM ahead". The remaining differences are either deliberate
(analysis-side features a camera device does not have) or places where
demoCam is ahead. Every "*(webSMLM 2026-09-..)*" marker below is now
resolved on the demoCam side as well.

demoCam property names carry a group prefix mirroring webSMLM's UI groups
(`General_`, `SimType_`, `FluoParam_`, `CamParam_`, `PSFParam_`, and, since
this refresh, `Background_`). The short names below omit the prefix.

**Partial refresh, 2026-09-22 (webSMLM side only).** Added
`simulation_structureFov` -- decouples the structure's own footprint from
the camera's `simulation_fov`. No sidebar control (deliberately -- reachable
via Save/Load Settings JSON or `paramOverrides` in the log terminal only;
NOT via `analyze(config)` -- Simulate movie is UI-only and has no headless
entry point at all). Default (build 2026-09-22c), when not explicitly
overridden: 10% LARGER than the camera FOV (`Math.round(fov*1.1)`), so
every simulation now has real structure just outside the frame from the
start -- Drift (px, total) has something to reveal with no setup step.
The structure is recentred on the camera FOV either way; larger means part
of it starts outside the frame, smaller means the whole structure sits
inside it. `dens`'s arrival-rate math scales with the structure's own
area, not the camera's, so density means the same thing regardless of
which is bigger. No downstream code needed to change (every consumer of
an out-of-FOV point was already bounds-safe); still missing the actual
"next steps" this groundwork is for -- see CLAUDE.md's own paragraph on
it. New row in "Emitter placement / structures", marked
*(webSMLM 2026-09-22)*; the demoCam column was not checked.

**Staleness warning:** this project has other collaborators and no
mechanism here notifies demoCam_SMLM_MM of new commits. Before starting
*any* simulation-engine work in either repo that assumes parity (or a gap)
described below, diff this table against both projects' current state and
refresh it.

Direction so far: **demoCam_SMLM_MM catches up to webSMLM.** This project
has not been modified for parity (this file is the only addition here).

A note for webSMLM itself, found while porting: a C++ expression like
`poisson(rng) + rn*gauss(rng)` has an unspecified operand evaluation order,
which made demoCam's old sequential-rng noise differ between two builds of
the same source. JS evaluates left to right, so webSMLM never had this
problem, but it is one more reason the counter-based noise (21b) was the
right call.

## PSF models

| Concept | webSMLM (`simulation_psfModel`) | demoCam_SMLM_MM (`PsfModel`) |
|---|---|---|
| Fixed-sigma Gaussian | `gaussian`, sigma hardcoded 1.3px, not NA/lambda-derived | `Gaussian`, sigma = 0.21*lambda/NA (physics-derived) -- **demoCam ahead** |
| Richards-Wolf (scalar Debye-Kirchhoff) | absent | `RichardsWolf` (PSFGenerator) -- **demoCam ahead** |
| Gibson-Lanni | absent as a standalone model (subsumed into the Zernike model at zero coefficients) | `GibsonLanni` (PSFGenerator) -- **demoCam ahead** |
| Gibson-Lanni + Zernike (scalar, full 2D pupil) | `zernike` (default), chirp-Z only (64x64 Cartesian pupil). The N_RHO=20 x N_PHI=40 polar quadrature and its `simulation_psfEvalMethod` switch were **removed** as wrong on wide kernels *(webSMLM 2026-09-21)* | `GibsonLanniZernike`, chirp-Z only (same 64x64 Cartesian pupil); `Direct` and `PsfEvalMethod` **removed** too, matching webSMLM 21e -- **same** *(both 2026-09-21)* |
| Zernike coefficients | 28 (OSA 0-27, n<=6), milliwaves in UI, presets + custom; a 15-value custom string is zero-padded, so older settings files are unchanged *(webSMLM 2026-09-20)* | 28 (OSA 0-27), **waves** (webSMLM's UI uses milliwaves), space-separated (MMCore forbids commas in property values), a 15-value list zero-padded; `PsfZernikePreset` has all 13 webSMLM presets with webSMLM's values (demoCam names, e.g. `AstigmatismModerate`, `SaddlePoint`) -- **same** *(both 2026-09-21)* |
| Sub-pixel kernel placement | `simulation_psfInterp`: `nearest`\|`linear`\|`cubic`\|`fft` (Fourier-shift), default `cubic` | `PsfInterp`: `Nearest`\|`Linear`\|`Cubic`\|`Fft`, default `Cubic`, block-summed splat (`buildSummedKernel`/`simSplatSetup` ported); `Fft` is CPU-only like webSMLM's -- **same** *(both 2026-09-21)* |
| Z-stack / defocus | per-emitter Z (site's own z), nearest-plane lookup, no blend | per-emitter Z (site depth + Z-stage global offset add), nearest-plane only. The Gibson-Lanni depth focal shift (sweep centred at ti0 - depth·ni/ns) is ported -- **same** |
| Engineered PSFs | higher-order astigmatism presets (`saddlePoint`/`extendedRange`/`extendedRangeStrong`, astigmatism stacked at OSA j=5/13/25) and a real double-helix phase mask (`simulation_psfMaskType`, Gauss-Laguerre superposition along l=2p+1, measured ~60 deg rotation over +/-800 nm) *(webSMLM 2026-09-20)* | same presets (`SaddlePoint`/`ExtendedRange`/`ExtendedRangeStrong`) and the same double-helix mask (`PsfMaskType`=`DoubleHelix`, `PsfMaskModes` 5, `PsfMaskWaist` 1.0) -- **same**; bit-identical pupil/PSF (Numeric cross-check §4) *(both 2026-09-21)* |
| PSF figure of merit | `psfZCramerRao()`: x/y/z Cramer-Rao bound from the kernel stack, PSF-shape agnostic (the astigmatism-specific `zUsableNm` is kept alongside it) *(webSMLM 2026-09-20)* | same function (`DescribePsfCramerRao`), logged to the corelog after every kernel build, like webSMLM's log line; `zUsableNm` not ported -- **same** (log-only in both) *(both 2026-09-21)* |
| PSF-model ("vector") fitting | absent (`psfmle` lives on the `psf_fitting` branch) | absent |
| Measured/experimental PSF, bead-calibrated spline PSF, biplane | absent in both | absent in both |

## Emitter placement / structures

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Sampling model | finite pre-generated site list (2000-50000 sites, area-scaled), arrival picks a random index | 9 patterns sample continuously per blink (no site list) **plus** (this session) `SiteListPattern` for the 4 new 3D structures below -- see that project's `SMLMPatterns.h` header comment for why the distinction is deliberate |
| 2D patterns | filaments+ring, NPC-only-as-3D (no dedicated 2D resolution-target pattern) | Circle, Lines, Grid, Random, CustomPoints, Spiral, Star, Heart, ResolutionTarget -- **demoCam ahead** on 2D pattern variety |
| 3D structures | `filaments_ring`, `nup`, `tiltedPlane`, `uniform3D`, `shell` | `TiltedPlane`, `Uniform3D`, `Shell`, `NUP`, and `FilamentsRing` (webSMLM's default, sine-correlated z, px constants at 100 nm/px); the 9 continuous 2D patterns additionally get a uniform z via `ZSpreadPattern` -- **same** (demoCam has more 2D patterns) |
| NUP/NPC geometry | Thevathasan 2019 Nup96, Wanninger 2023 CIR4MICS params, 64 sites/pore, rejection-sampled spacing, bowl curvature, topdown/sideways | same -- ported verbatim this session, with one added corelog warning (rejection-sampling shortfall) webSMLM doesn't have |
| Labeling efficiency | `simulation_labelEfficiency` (%, default 70), applied once to the site list before arrivals | `LabelingEfficiencyPct` (%, default 70), applied once to the 5 site-list structures; **not** applied to the 9 continuous patterns or CustomPoints (no site list, documented) |
| Emitter Z spread on 2D patterns | filaments' z correlates with the same sine driving y (documented as an accuracy limitation in webSMLM's own docs) | `FilamentsRing` has webSMLM's correlated z; the other 2D patterns use `ZSpreadPattern` (uniform, uncorrelated) |
| Structure FOV independent of camera FOV | `simulation_structureFov` (px, id:null -- no sidebar control on purpose): structure built at this size, then recentred onto the camera FOV; defaults to 10% larger than the camera FOV when not explicitly overridden, so structure sits outside the frame and drifts into view via `driftpx` by default; smaller values sit entirely inside the frame; `dens`'s arrival-rate area follows `structureFov`, not the camera FOV -- boilerplate only, added 2026-09-22, not yet ported -- **webSMLM ahead** *(webSMLM 2026-09-22)* | absent |

## Blinking kinetics / photophysics

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Arrival process | areal-density Poisson, sites reused across the movie | areal-density Poisson (per-frame or per-tick), continuous patterns draw a fresh position -- same core math, different site-reuse semantics per the sampling-model row above |
| ON duration | single exponential (mean = `simlifetime`); one blink per molecule by default, a geometric number (mean 1/`simulation_blinkBleachProb`) otherwise *(webSMLM 2026-09-19)* | single exponential (`OnLifetimeSec`); geometric blink count via `BlinkBleachProb` (default 1 = one blink); molecules keep their position across blinks -- **same** *(both 2026-09-21)* |
| Photon count | constant by default; per-blink log-normal rate with CV `simulation_photCV`, mean preserved; scaled by frame-overlap fraction *(webSMLM 2026-09-19)* | `PhotonCV` (default 0): per-blink log-normal, mean preserved, times the illumination at the site, times frame overlap -- **same** *(both 2026-09-21)* |
| Bleaching, dark/triplet states, multi-blink kinetics | three-state ON ⇄ dark → bleached per molecule (`simulation_blinkBleachProb`, `simulation_offLifetime`); `dens` keeps meaning ON-density; no separate triplet state; default = original single-blink model, byte-identical for a seed *(webSMLM 2026-09-19)* | same three-state model (`BlinkBleachProb`, `OffLifetimeSec`), arrival rate divided by mean blink count so density = ON-density; default draw sequence untouched; live mode schedules each surviving molecule's next blink -- **same** *(both 2026-09-21)* |
| Sub-pixel position | continuous float positions both paths | continuous float positions both paths |

## Camera / noise model

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Chain | bg -> Poisson(signal) -> +Gaussian read noise (post-gain conversion... actually pre-gain, see webSMLM inventory) -> /gain -> +per-pixel offset -> clamp at 0 | photons·QE + dark current -> Poisson -> + Gaussian read noise -> /gain -> + offset -> clamp [0,65535], drawn from webSMLM's counter-based pcg4d stream (same `simNoisePoisson`/`simNoiseGauss`/`simNoiseGamma`) -- **demoCam ahead** on QE/dark/per-pixel gain and read-noise maps |
| QE / dark current | QE on the EMCCD path (`simulation_qe`, 0.9); no dark current *(webSMLM 2026-09-20)* | `QuantumEfficiency` (0.85, both camera types), `DarkCurrentElectronsPerSec` (1.03) -- **demoCam ahead on dark current** |
| Per-pixel maps | offset only (`simulation_offset_std`) | offset, gain (`PixelGainStdPct`), read noise (`PixelReadNoiseStdPct`) -- **demoCam ahead** |
| EMCCD / excess noise factor | `simulation_cameraType='emccd'`: Poisson -> Gamma gain register, so variance = 2x mean (measured 2.00); clock-induced charge (`simulation_cic`); analysis side corrects for it via `cameraExcessNoise` *(webSMLM 2026-09-20)* | `CameraType`=`EMCCD`: Poisson(QE·photons + dark + `CicElectrons`) -> Gamma(ne,1) -> read noise/`EmGain` -> /gain -> + offset, integer ADU -- **same** (plus dark current) *(both 2026-09-21)* |
| Quantization / bit depth | integer ADU clipped at 2^`simulation_bitDepth`-1 on the EMCCD path; sCMOS path still Float32 (kept for byte-identity with earlier builds) *(webSMLM 2026-09-20)* | `BitDepth` (8-16) clip on the EMCCD path; 16-bit uint clamp otherwise -- **same** |
| Gain units | photons/ADU | photons/ADU -- same convention |
| Illumination profile | `simulation_illumProfile`: `flat` (default) \| `gaussian` \| `sigmoid`, width `simulation_illumFwhmPct`; attenuation normalised to peak 1, applied to emitters AND background *(webSMLM 2026-09-20)* | `IllumProfile` `Flat`\|`Gaussian`\|`FlatTop` (= `sigmoid`), `IllumFwhmPct`, peak 1, on emitters AND background -- **same** *(both 2026-09-21)* |

## Background / drift / focus

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Background | `simbg` = FOV-mean photons/px, Poisson-fluctuating; flat by default *(webSMLM 2026-09-19)* | `Background_BackgroundPhotonsPerSec`, Poisson-fluctuating -- same |
| Structured background, vignetting, autofluorescence | cell-shaped autofluorescence field (`simulation_bgCellContrast`), static out-of-focus haze from the structure's projected density (`simulation_bgHazeWeight`/`Width`), fade to a 30% floor (`simulation_bgDecayFrames`), and blinking out-of-focus emitters through the real defocused PSF (`simulation_hazeRatio`/`Depth`); no vignetting *(webSMLM 2026-09-19)* | `Background_CellContrast`, `HazeWeight`/`HazeWidthNm` (haze from 20000 sampled sites, since continuous patterns have no site list), `DecaySec` (fade to 30%, in seconds), `OutOfFocusRatio`/`OutOfFocusDepthNm` (lower bound fixed at 300 nm -- demoCam does not compute `zUsableNm`) -- **same** *(both 2026-09-21)* |
| Drift | linear, single random direction (X/Y), stored ground truth | linear, random direction per seed (`DriftNmPerSec` = speed); no ground-truth export (see below) -- **same** apart from GT |
| Focus / Z stage | no separate stage concept -- structure Z is absolute | real `SMLMDemoZStage` MM::Stage device, global focus offset, live-drivable -- **demoCam ahead** (no equivalent in webSMLM) |

## Outputs / ground truth

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Raw movie export | **absent** (in-memory only) | uint16 stack via standard MM camera API -- **demoCam ahead** |
| Ground-truth emitter/localization export | in-memory only (`groundTruthEvents`/`groundTruthLocs`), consumed by "View GT" and "Score vs truth"; no file export | **absent entirely** -- `BlinkEvent` positions are discarded after rendering; this is demoCam's single biggest ground-truth gap |
| GT scoring vs. localization output | yes (`scoreTruthCore`): recall/precision/Jaccard, median+percentile lateral/axial error, photon-threshold + edge "don't care" classes, isolated/crowded split, recall-vs-photons curve with 50% point, challenge efficiency *(webSMLM 2026-09-19)*; plus per-molecule metrics and an effective z range, and a `validation_preset` that reproduces the published SMLM-Challenge-2016 rules (3D cylinder matching, quantile photon threshold, border excluded before matching) *(webSMLM 2026-09-20)* | absent |

## Compute (not physics)

| Concept | webSMLM | demoCam_SMLM_MM |
|---|---|---|
| Splat | block sums of each photon-normalized plane, one interpolation per camera pixel *(21b)* | same (`BuildBlockSums`/`SplatSetup`) |
| Camera noise RNG | counter-based pcg4d (seed, frame, pixel, counter) *(21b)* | same, bit-identical uniforms |
| GPU | WebGPU fused splat + noise *(21c/21d)* | Direct3D 11 fused splat + noise (`General_UseGpu`, default On; `General_GpuStatus`), frames batched per dispatch; CPU fallback on all cores. GPU==CPU on >= 99.8% of pixels (the rest are a Poisson count apart, float32) |

## Presets (webSMLM only, 2026-09-19)

`simulation_realism` (`min`/`med`/`max`) and `simulation_densityPreset`
(`low`/`med`/`high`) are UI shorthands that only WRITE the ordinary parameters
above; they carry no physics of their own, so a port needs the underlying
parameters, not the presets.

## Not tracked here

webSMLM's ThunderSTORM-compatible CSV export, Settings-JSON round-trip, and
reconstruction/rendering pipeline have no demoCam equivalent (demoCam is a
camera device, not an analysis tool) and are out of scope for this
comparison by design, not a gap.

## Numeric cross-check

Two separate checks, both run this session:

1. **Within demoCam_SMLM_MM**: `GibsonLanniZernikePSF`'s ported chirp-Z
   evaluator vs. its original direct-quadrature evaluator (both Java, same
   process) -- 0.22-0.29% relative L2 (sum-normalized) at NA 1.4/660nm,
   65x65px, zero-Zernike and 0.15-wave astigmatism cases. Recorded in that
   repo's `CLAUDE.md`.
2. **Cross-project** (`demoCam_SMLM_MM/tools/psf_parity_check/`): webSMLM's
   own JS `computePsfPupilForZPlane`/`computePsfIntensityPlane` (the direct
   polar-quadrature path) vs. demoCam's Java port of the same functions
   (`GibsonLanniZernikePSF.computeSliceDirect`), same physical parameters
   (NA 1.4, lambda 660nm, ns=ni=1.518, ti0 150um, in-focus, 0.15-wave
   vertical astigmatism, 65x65px @ 25nm/px oversampled resolution).
   **Result: 0.0000% relative L2 difference** (bit-for-bit agreement,
   modulo ordinary floating-point noise) -- expected and confirms the
   direct-quadrature port from webSMLM into Java is faithful, since it's
   the same algorithm/formulas/constants in both languages. Re-run this
   check (`tools/psf_parity_check/README.md`) after any future change to
   either engine's direct-quadrature PSF math.
3. **Direct vs. chirp-Z vs. an exact Airy disk, on a wide kernel**
   *(webSMLM 2026-09-21)*. Checks 1 and 2 used a 65x65 px @ 25 nm
   (1.6 µm) kernel. At webSMLM's default 6 µm kernel (241x241 @ 25 nm,
   NA 1.4, 660 nm, ns 1.33 / ni 1.518, unaberrated, in focus) the two
   evaluators disagree by **21% relative L2** after sum-normalization. The
   cores agree: FWHM 255.7 nm chirp-Z vs 255.6 nm direct vs 255.1 nm Airy,
   and the first zero is within 1 nm of 0.61·λ/NA_eff. The disagreement is
   in the tails:

   | Light beyond | chirp-Z | direct | exact Airy, same grid |
   |---|---|---|---|
   | 1 µm | 3.44% | 20.07% | 3.39% |
   | 3 µm (corners) | 0.17% | 16.98% | 0.157% |

   Chirp-Z is the physical one. Direct samples the pupil at N_PHI=40
   angles, which resolves exp(i·k·r·cos φ) only while k·NA_eff·r < ~N_PHI/2,
   i.e. out to ~1.6 µm here; beyond that the sum aliases into spurious
   light. After normalization every emitter's core is ~17-20% too dim.
   This is a property of the shared algorithm (same N_RHO/N_PHI), so it
   applies to demoCam's Java `Direct` port too, which is demoCam's
   default. Fix options: use chirp-Z, keep the kernel under ~2.2 µm wide,
   or scale N_PHI with the kernel radius (~128 at 6 µm). webSMLM chose to
   remove its `direct` evaluator (build `2026-09-21e`), so check 2 above can
   no longer be re-run against current webSMLM; it stands as a historical
   record of the Java port's fidelity. webSMLM guards its default with a regression check
   (`tests/gpu/test-sim-gpu.mjs`: chirp-Z's light beyond 3 µm < 1%).
   demoCam_SMLM_MM removed its `Direct` evaluator too (2026-09-21).
4. **Chirp-Z, cross-project** *(2026-09-21)*
   (`demoCam_SMLM_MM/tools/psf_parity_check/`, now regenerated from webSMLM
   21e's chirp-Z JS). In-focus plane, 65x65 px @ 25 nm, NA 1.4, 660 nm,
   ni 1.518. Four cases:
   - `astigModerate`;
   - `extendedRangeStrong` (n=6 modes);
   - the double-helix mask;
   - ns 1.33 with the emitter 500 nm deep (focal shift).

   All four: **0.0000% relative L2**, raw and sum-normalized. demoCam's Java
   pupil/PSF math is the same algorithm as webSMLM's. Measured through it:
   the double-helix lobe axis turns ~63° over ±800 nm (webSMLM: ~60°).
