# webSMLM

A browser-based tool for **single-molecule localization microscopy (SMLM)**. It loads a
raw image stack, detects and localizes single emitters, and reconstructs a
super-resolution image — entirely in the browser. Nothing is uploaded; all
computation runs client-side.

> Status: proof-of-concept. Not a validated replacement for established SMLM
> packages, but a fast, zero-install way to try localization on your own data.

[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21445041.svg)](https://doi.org/10.5281/zenodo.21445041)

## Quick start

**Option A — just run it.** Download `webSMLM.html` and open it in any modern
browser (double-click works; no internet, no install, no server). Everything
needed is inside that one file.

**Option B — hosted.** If served via GitHub Pages, open the published URL.

Then: click **Simulate movie** to try it immediately, or **Load movie** for your
own `.tif`/`.tiff` stack. Set the **pixel size (nm)**, pick a **fit method**, and
press **Run localisations**. Open **Help & guide** in the app for a full
walk-through of every step.

## What it does

- **Loads** multi-frame TIFF stacks (8/16/32-bit, little- or big-endian,
  uncompressed or deflate/LZW-compressed). 16-bit depth is preserved.
- **Handles very large stacks.** Contiguous ImageJ stacks (a single directory
  entry with frames laid out after it, as written above ~4 GB) are read frame by
  frame with `File.slice()`, so the file is never held in memory. A 4.89 GB /
  40,000-frame stack processes in ~24 s.
- **Memory-aware loading**: caches frames in RAM within a configurable budget,
  or streams large stacks in bounded heaps (the pattern that also enables
  real-time processing of a live camera buffer). Falls back to streaming
  automatically if an in-memory load hits the browser's memory ceiling.
- **Detects** ROIs with a Difference-of-Gaussians band-pass filter and a
  `mean + k·σ` threshold on the filtered image.
- **Localizes** with **phasor** fitting (very fast, no iteration) or a
  **least-squares 2D Gaussian** fit.
- **3D astigmatism** (**Phasor 3D**): calibrate a bead z-stack — detect every
  spot per plane, fit elliptical σ_x/σ_y vs z, and fit σ = a(z−c)² + b to each —
  then assign **z per localization** from the phasor width ratio. Calibrations
  save/load as JSON, and the reconstruction can be **depth-coded** (hue = z,
  brightness = density) with an adjustable z range.
- **Renders** a super-resolution image with adjustable magnification and blur,
  a choice of colour maps (Fire, Inferno, Viridis, Turbo, Grey) and
  percentile-based display scaling. All render settings apply instantly without
  refitting.
- **Builds up live**: the raw frame refreshes during a run with detected ROIs
  (green) and accepted localizations (magenta sub-pixel crosshairs); the
  reconstruction previews on a time budget. A **Stop** button ends the analysis
  early while keeping the localizations gathered so far.
- **Navigate both panels**: independent zoom/pan (wheel or pinch, drag,
  double-click to reset) on the raw frame and the reconstruction, plus a frame
  slider to scrub the stack.
- **Save/Load settings** as JSON to reproduce an analysis configuration.
- **Works on small screens**: single-column layout on phones and tablets, with
  drag/pinch-to-zoom navigation of the reconstruction (plus a scale bar).
- **Exports** localizations as ThunderSTORM-compatible CSV, including
  background-subtracted intensity, background level and a Thompson/Larson/Webb
  uncertainty estimate. See the caveat on ADU-to-photon conversion below.

## Performance

Detection and fitting run in parallel across a pool of Web Workers (one per
logical core), with the band-pass filter optimised for the common case. Measured
on a laptop, running the single HTML file directly from `file://`:

| Dataset | Frames | Frame size | Time | Rate |
|---|---|---|---|---|
| GATTA-PAINT 80R | 1999 | 82 × 83 | ~0.71 s | ~15,000 loc/s |
| Nile Red / *L. lactis* | 1173 | 256 × 256 | ~0.68 s | ~129,000 loc/s |
| 3D STORM (4.89 GB) | 40000 | 256 × 256 | ~24 s | ~182,000 loc/s |

That is ~7× and ~30× faster respectively than v0.2.0, with identical
localization counts. Notes:

- **Workers are probed before use**, with a self-test that exercises the whole
  numeric path. If they are unavailable — some browsers restrict workers on
  `file://` — the app falls back to single-threaded automatically and says so
  in the log.
- **Small frames stay single-threaded** on purpose: below ~20k pixels per frame
  the cost of handing a frame to a worker outweighs the work itself.
- The band-pass background term uses a **box-filter approximation** by default
  (~2× faster, changes ~0.4% of detections on the test data). Tick
  **Exact band-pass** for a true Gaussian when you need exact reproducibility.
- The run log reports a **timing breakdown** (frame access / detect / fit) so
  you can see where time goes on your own data.

## Data & privacy

The application is a single static HTML file. Your image data is read locally by
the browser and never leaves your machine — there is no server and no upload.

## How it works & references

The in-app **Help & guide** documents each stage and lists references. Key ones:

- **Phasor localization** (the fast fitter here implements this):
  K. J. A. Martens, A. N. Bader, S. Baas, B. Rieger, J. Hohlbein,
  *Phasor based single-molecule localization microscopy in 3D (pSMLM-3D)*,
  J. Chem. Phys. **148**, 123311 (2018). https://doi.org/10.1063/1.5005899
- **Detection & thresholding** (DoG band-pass + std-based threshold, after
  ThunderSTORM): M. Ovesný et al., *Bioinformatics* **30**(16), 2389–2390 (2014).
  https://doi.org/10.1093/bioinformatics/btu202
- **LS vs MLE fitting**: K. I. Mortensen et al., *Nat. Methods* **7**, 377–381
  (2010). https://doi.org/10.1038/nmeth.1447 — and localization-precision
  theory: R. E. Thompson, D. R. Larson, W. W. Webb, *Biophys. J.* **82**,
  2775–2783 (2002). https://doi.org/10.1016/S0006-3495(02)75618-X
- **Overview**: M. Lelek et al., *Nat. Rev. Methods Primers* **1**, 39 (2021).
  https://doi.org/10.1038/s43586-021-00038-x

## Known limitations

- 3D is astigmatism via **Phasor 3D** only; the Gaussian fit is 2D and
  **least-squares, not Poisson MLE**. The astigmatism calibration uses a
  vertex-quadratic per axis, a local approximation best over a cropped z-range.
- **Intensities are in ADU unless a camera gain is entered**, in which case the
  exported `intensity [photon]` and `uncertainty [nm]` columns are not on a
  physical scale. A single scalar gain also suits EMCCD better than sCMOS, where
  gain, offset and read noise vary per pixel — see
  [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md).
- Dense samples with overlapping PSFs are fitted with a **single-emitter model**,
  which biases positions where emitters overlap.
- The `mean + k·σ` threshold assumes roughly stationary noise; strong background
  gradients favour a local threshold.
- Precision figures shown in the app are for the built-in synthetic model.

## Roadmap

Planned work is tracked in [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md):

1. ~~UI improvements and small-screen support~~ (done in 0.2.0)
2. ~~Speed review — band-pass bottleneck, Web Worker pool~~ (done in 0.3.0)
3. ~~CSV export in ThunderSTORM format~~ (done in 0.4.0)
4. Localization precision via FRC
5. ~~3D phasor (astigmatism)~~ (done in 0.5.0)
6. Drift correction (2D, then 3D)

Also on the list: Poisson MLE fitting and localization filtering.

## Distribution & citation

This project is distributed as a single file. It lives at
[github.com/HohlbeinLab/webSMLM](https://github.com/HohlbeinLab/webSMLM), is
served via **GitHub Pages** at <https://hohlbeinlab.github.io/webSMLM/>, and is
archived on **Zenodo** with a citable DOI ([10.5281/zenodo.21445041](https://doi.org/10.5281/zenodo.21445041)).

To cite webSMLM, use the concept DOI above (it always resolves to the latest
version) or the metadata in [`CITATION.cff`](CITATION.cff) — GitHub's *Cite this
repository* button reads it automatically. Please also cite the phasor SMLM
paper it implements (Martens et al., 2018; see below).

Each new **GitHub release** is picked up by Zenodo automatically and gets its own
version DOI; pushing to `main` redeploys the Pages site.

## License

© 2026 **Johannes Hohlbein**, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see [`LICENSE`](LICENSE).
You may share and adapt this work, including commercially, with attribution.

Bundled third-party decoders retain their own MIT licenses:
[UTIF.js](https://github.com/photopea/UTIF.js) and
[pako](https://github.com/nodeca/pako).
