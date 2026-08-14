# webSMLM

A browser-based tool for **single-molecule localization microscopy (SMLM)**. It loads a
raw image stack, detects and localizes single emitters, and reconstructs a
super-resolution image — entirely in the browser. Nothing is uploaded; all
computation runs client-side.

> Status: proof-of-concept. Not a validated replacement for established SMLM
> packages, but a fast, zero-install way to try localization on your own data.

[![Launch webSMLM](https://img.shields.io/badge/Launch-webSMLM-brightgreen?logo=googlechrome&logoColor=white)](https://hohlbeinlab.github.io/webSMLM/webSMLM.html)
[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21445041.svg)](https://doi.org/10.5281/zenodo.21445041)

## Quick start

**Option A — just run it.** Download `webSMLM.html` and open it in any modern
browser (double-click works; no internet, no install, no server). Everything
needed is inside that one file.

**Option B — hosted.** Open the published version, served via GitHub Pages:
<https://hohlbeinlab.github.io/webSMLM/webSMLM.html>.

Then: click **Simulate movie** to try it immediately, or **Load movie** for your
own `.tif`/`.tiff` stack. Set the **pixel size (nm)**, pick a **fit method**, and
press **Localize**. Open **Help & guide** in the app for a full
walk-through of every step.

## What it does

- **Loads** multi-frame TIFF stacks (8/16/32-bit, little- or big-endian,
  uncompressed or deflate/LZW-compressed). 16-bit depth is preserved.
- **Handles very large stacks.** Files too big to hold in memory are read frame
  by frame with `File.slice()`, so the file is never fully loaded. Contiguous
  ImageJ stacks (single directory entry, frames laid out after it — as written
  above ~4 GB) are indexed arithmetically; **multi-IFD stacks (e.g. multi-GB
  Micro-Manager MMStacks)** are indexed by walking the IFD chain. A 4.89 GB /
  40,000-frame stack processes in ~12 s.
- **Memory-aware loading**: caches frames in RAM within a configurable budget,
  or streams large stacks in bounded heaps (the pattern that also enables
  real-time processing of a live camera buffer). Falls back to streaming
  automatically if an in-memory load hits the browser's memory ceiling.
- **Detects** ROIs by band-passing each frame, with a choice of three filters:
  an **à trous B-spline wavelet** (the default, as in ThunderSTORM; no σ, the
  fastest to filter), a **Difference-of-Gaussians** filter, or a **uniform box
  filter** (Huang et al. 2011). Wavelet and DoG threshold on strict local
  maxima above `mean + k·σ`; the box filter thresholds on a plain intensity
  value instead. The three respond differently, so re-tune the threshold when
  you switch. A **Real-time update** toggle re-detects/re-fits the scrubbed
  frame live as you change detection or fit settings, without a full Run.
- **Temporal median filtering (FTM)**, optional: each pixel's value has the
  median of a sliding window of nearby frames subtracted, removing
  slowly-varying background before detection/fitting. Available both as a
  live raw/corrected toggle for the scrub preview and applied to an actual
  Localize run — chunked and worker-parallel when a worker pool is
  available, so memory stays bounded regardless of stack length.
- **Localizes** with **phasor** fitting (very fast, no iteration), a
  **least-squares 2D Gaussian** fit, or a **Poisson maximum-likelihood** fit
  (**Gaussian MLE 2D**, the default — integrated-Gaussian, Smith et al. 2010 /
  Picasso `gaussmle`). MLE is statistically optimal at low photon counts and
  reports a proper per-localization **CRLB uncertainty**. A **first/last
  frame** range restricts a Run to part of the loaded stack.
- **3D astigmatism**, two independent ways: **Phasor 3D** (z from the phasor
  magnitude ratio) and **Gaussian MLE 3D** (z from the elliptical σ_x/σ_y widths)
  — a built-in cross-check. Calibrate a bead z-stack — every spot is fit both by
  LS (real σ_x/σ_y curves) and phasor (magnitude ratio); the calibration carries
  both models, tagged, and a guard stops a 3D fit running against the wrong one.
  A **"Fix bead x,y"** option freezes each bead's lateral position from a
  composite of the calibration range before fitting widths per frame, so the
  fit can't wander to a wrong lobe when the PSF flattens, rings or splits at
  large defocus. Calibrations save/load as JSON (with their source file), and
  the reconstruction can be **depth-coded** (hue = z, brightness = density)
  with an adjustable z range.
- **Localizations table** (**View data + filtering**): sortable, with **cumulative
  filtering** (e.g. `intensity > 1000 and uncertainty < 20`, Enter to apply,
  removable chips, Reset) that **drives the reconstruction live**; any column can
  be **histogrammed** in the raw panel (with x-zoom/pan). Consecutive-frame
  detections of the same molecule can also be merged into **temporal-clustering
  events** (`tempClusteringXY`/`tempClusteringZ` filters), reducing noise at the
  cost of localization density.
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
  slider to scrub the stack. Both panels take the loaded stack's data aspect
  ratio, so they stay equal-sized with no letterboxing. The controls panel is
  **collapsible** — on desktop, re-opening it after a collapse floats it as an
  overlay so toggling never resizes the display windows.
- **Measures distances / line profiles**: click two points in the reconstruction
  to plot the intensity profile along the line (averaged over a 3-pixel band),
  with the length in nm and an x-zoomable/pannable plot. A **crop tool** next to
  it adds an x/y-range filter from two clicked corners, restricting the
  reconstruction, export, NeNA and FRC to that region like any other table filter.
- **Save/Load settings** as JSON to reproduce an analysis configuration.
- **Works on small screens**: single-column layout on phones and tablets, with
  drag/pinch-to-zoom navigation of the reconstruction (plus a scale bar).
- **Corrects drift** with **AIM** (adaptive intersection maximization) — a
  point-based estimator that needs no image rendering and **no FFT**, so it fits
  the single-file design and works natively in **3D** (x/y grid search + a
  separate z search on the Phasor-3D output). It re-estimates from the raw
  localizations on every run, so segment size and search radius can be swept and
  compared; corrected coordinates drive the render and CSV, the raw ones are
  kept, and the drift-vs-frame curve can be plotted.
- **Measures precision & resolution** (*experimental*, new in 0.8.0):
  **NeNA** — the mean per-localization precision from the nearest-neighbour
  distance distribution (with a fitted histogram plotted); and **FRC** — image
  resolution at the 1/7 threshold by Fourier ring correlation of two independent
  halves (a compact inline FFT, no dependency), with the curve plotted. Both
  report an error estimate. NeNA needs a *static* structure (a diffusing probe
  inflates it); FRC folds in labelling density and drift, so run it after drift
  correction.
- **Exports** localizations as ThunderSTORM-compatible CSV, including
  background-subtracted intensity, background level and a Thompson/Larson/Webb
  uncertainty estimate. See the caveat on ADU-to-photon conversion below.

## Performance

Detection and fitting run in parallel across a pool of Web Workers (one per
logical core). Measured on a laptop, running the single HTML file directly from
`file://` with the default **wavelet** detector:

| Dataset | Fit method | Frames | Frame size | Time | Rate |
|---|---|---|---|---|---|
| 3D STORM (4.89 GB) [[Leterrier]](experimental_data/README.md) | Phasor 3D | 40000 | 256 × 256 | ~12 s | ~350,000 loc/s |

Small stacks finish **faster than can be timed reliably** (well under a
second — JIT warm-up and timer resolution dominate), so only a stack large
enough to run for several seconds gives a stable throughput figure: the 4.89
GB stack above — never held in memory, streamed frame by frame — completes in
~12 s (~350k loc/s) with the **Phasor** fitter. Notes:

- **Rate is fitter-dependent.** Phasor (above) is non-iterative and by far the
  fastest; Gaussian MLE 2D/3D — the statistically-preferred default — costs
  several-fold more per localization for its ~5-iteration Newton fit, and on
  very large stacks frame I/O/decode can dominate wall time as much as fitting
  itself, so the figure above is a ceiling, not a typical number across methods.

- **Browser matters.** On macOS the numeric path runs fastest in **Safari**, then
  **Chrome**, then **Firefox** (JS-engine differences). Expect run-to-run
  variation too (JIT warm-up, GC, thermal, disk cache) — a repeat of the same
  stack is usually quicker.
- **Detector choice changes results**, not just speed: the three filters find
  slightly different spot sets, so counts differ between them.
- **Workers are probed before use**, with a self-test that exercises the whole
  numeric path. If they are unavailable — some browsers restrict workers on
  `file://` — the app falls back to single-threaded automatically and says so
  in the log.
- **Small, short stacks stay single-threaded** on purpose: below ~20,000
  pixels per frame *and* below ~30 million total pixels (frames × width ×
  height), the cost of handing work to a worker outweighs the work itself.
  Either condition alone is enough to parallelize — a stack with many small
  frames (e.g. thousands of 64×64 frames) still crosses the total-volume
  threshold and runs on the worker pool.
- The **DoG** filter approximates its background term with a box filter by
  default (~2× faster than a true Gaussian, changes ~0.4% of *its* detections);
  tick **Exact band-pass** for the true Gaussian. The wavelet filter has no such
  option (and no σ).
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
- **Detection & thresholding** (both the default à trous B-spline **wavelet**
  filter and the **DoG** band-pass, plus the std-based threshold, follow
  ThunderSTORM): M. Ovesný et al., *Bioinformatics* **30**(16), 2389–2390 (2014).
  https://doi.org/10.1093/bioinformatics/btu202
- **Uniform box filter** (the third detection filter, thresholded on a plain
  intensity value instead): F. Huang, S. L. Schwartz, J. M. Byars, K. A. Lidke,
  *Simultaneous multiple-emitter fitting for single molecule super-resolution
  imaging*, *Biomed. Opt. Express* **2**(5), 1377–1393 (2011).
  https://doi.org/10.1364/BOE.2.001377
- **LS vs MLE fitting**: K. I. Mortensen et al., *Nat. Methods* **7**, 377–381
  (2010). https://doi.org/10.1038/nmeth.1447 — and localization-precision
  theory: R. E. Thompson, D. R. Larson, W. W. Webb, *Biophys. J.* **82**,
  2775–2783 (2002). https://doi.org/10.1016/S0006-3495(02)75618-X
- **Drift correction (AIM)** (the estimator implemented here): H. Ma, M. Chen,
  P. Nguyen, Y. Liu, *Toward drift-free high-throughput nanoscopy through
  adaptive intersection maximization*, *Sci. Adv.* **10**(21), eadm7765 (2024).
  https://doi.org/10.1126/sciadv.adm7765 — adapted from the reference
  implementation in **Picasso** (`picasso/aim.py`,
  https://github.com/jungmannlab/picasso; J. Schnitzbauer et al.,
  *Super-resolution microscopy with DNA-PAINT*, *Nat. Protoc.* **12**,
  1198–1228, 2017, https://doi.org/10.1038/nprot.2017.024): a parabolic
  sub-pixel peak fit replaces the FFT phase refinement and linear interpolation
  replaces the spline.
- **Localization precision (NeNA)** (the estimator implemented here):
  U. Endesfelder, S. Malkusch, F. Fricke, M. Heilemann, *A simple method to
  estimate the average localization precision of a single-molecule localization
  microscopy experiment*, *Histochem. Cell Biol.* **141**, 629–638 (2014).
  https://doi.org/10.1007/s00418-014-1192-3
- **Image resolution (FRC)** (the measure implemented here): R. P. J.
  Nieuwenhuizen, K. A. Lidke, M. Bates, D. L. Puig, D. Grünwald, S. Stallinga,
  B. Rieger, *Measuring image resolution in optical nanoscopy*, *Nat. Methods*
  **10**, 557–562 (2013). https://doi.org/10.1038/nmeth.2448
- **Temporal median filtering (FTM)** (the background-correction technique
  implemented here): originates with the Nieuwenhuizen et al. paper above;
  ported from the Hohlbein Lab's own newer implementation,
  [`HohlbeinLab/FTM2`](https://github.com/HohlbeinLab/FTM2), used in
  Jabermoradi et al., *Enabling single-molecule localization microscopy in
  turbid food emulsions*, *Phil. Trans. R. Soc. A* **380**(2220), 20200164
  (2022). https://doi.org/10.1098/rsta.2020.0164
- **Overview**: M. Lelek et al., *Nat. Rev. Methods Primers* **1**, 39 (2021).
  https://doi.org/10.1038/s43586-021-00038-x

## Known limitations

- **3D astigmatism is 2D-vs-3D by two independent, still-unreconciled
  methods** (Phasor 3D from the magnitude ratio, Gaussian MLE 3D from the
  elliptical σ_x/σ_y widths) rather than a single validated 3D model. They
  are cross-checked against each other and against synthetic ground truth,
  but **not yet against real bead data**. The astigmatism calibration itself
  fits a vertex-quadratic per axis — a local approximation, best over a
  cropped z-range around focus.
- **NeNA and FRC are new and not yet cross-validated** against established
  tools (ThunderSTORM, Picasso, FRCbar) or previously-analysed datasets — the
  numbers they report should not yet be treated as authoritative. 3D FSC
  (the spherical-shell counterpart to 2D FRC) is not implemented.
- **Intensities are in ADU unless a camera gain is entered**, in which case the
  exported `intensity [photon]` and `uncertainty [nm]` columns are not on a
  physical scale. A single scalar gain also suits EMCCD better than sCMOS, where
  gain, offset and read noise vary per pixel — see
  [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md).
- Dense samples with overlapping PSFs are fitted with a **single-emitter model**,
  which biases positions where emitters overlap. Multi-emitter fitting would
  be the real fix.
- The `mean + k·σ` threshold assumes roughly stationary noise, computed over
  the whole frame including signal — so at high blink density the threshold
  rises and dim localizations get silently dropped. Strong background
  gradients also favour a local threshold over a global one.
- σ_PSF is a fixed, user-supplied value, not estimated or calibrated from the
  data.

## Advanced: scripting & headless analysis

*(Not everyone needs this; skip it if clicking through the UI already works
for you.)* webSMLM also exposes a scriptable pipeline, for
batch-processing files or driving a run without opening the app by hand.
Full reference: [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) §8.

- **In the browser console**, `window.webSMLM.analyze(config)` runs the
  whole load → detect/fit → drift pipeline and returns the CSV/log/settings
  text and a reconstruction PNG directly — no clicking through the UI.
- **A URL can trigger a run**: `webSMLM.html?autorun=1&fileUrl=...&pxnm=160`
  runs `analyze()` the moment the page loads, using the query string as
  settings; `&download=1` also saves the results as files.
- **`tools/`** has three command-line options for running this from outside
  the browser entirely, in increasing order of setup: `browser_sweep.py`
  (Python, standard library only) or `browser-sweep.sh` (bash) both drive a
  real, visible browser through a sweep of parameter values; `webSMLM-cli.mjs`
  (Node.js + [Playwright](https://playwright.dev)) runs a single analysis
  fully headless — no browser window ever opens — and is the most reliable
  of the three. See each script's header comment for setup and usage.

## Roadmap

Past releases — including implementation detail and notable rejected
approaches — are logged in [`CHANGELOG.md`](CHANGELOG.md); forward-looking
notes are kept in [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md).

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

© 2026 **Hohlbein et al.**, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see [`LICENSE`](LICENSE).
You may share and adapt this work, including commercially, with attribution.

Bundled third-party decoders retain their own MIT licenses:
[UTIF.js](https://github.com/photopea/UTIF.js) and
[pako](https://github.com/nodeca/pako).
