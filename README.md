# webSMLM

A browser-based tool for **single-molecule localization microscopy (SMLM)**. It loads a
raw image stack, detects and localizes single emitters, and reconstructs a
super-resolution image — entirely in the browser. Nothing is uploaded; all
computation runs client-side.

> Status: proof-of-concept. Not a validated replacement for established SMLM
> packages, but a fast, zero-install way to try localization on your own data.

[![Launch webSMLM](https://img.shields.io/badge/Launch-webSMLM-brightgreen?logo=googlechrome&logoColor=white)](https://hohlbeinlab.github.io/webSMLM/webSMLM.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21445041.svg)](https://doi.org/10.5281/zenodo.21445041)
[![Documentation Status](https://readthedocs.org/projects/websmlm/badge/?version=latest)](https://websmlm.readthedocs.io/en/latest/?badge=latest)

## Quick start

**Option A — just run it.** Download `webSMLM.html` and open it in any modern
browser (double-click works; no internet, no install, no server). Everything
needed is inside that one file.

**Option B — hosted.** Open the published version, served via GitHub Pages:
<https://hohlbeinlab.github.io/webSMLM/webSMLM.html>.

This README's **Guided workflow** below covers the essentials. For the full
reference — every button, control, parameter and module, plus the settings/
calibration/CSV file formats and the headless API — see the
[webSMLM documentation on Read the Docs](https://websmlm.readthedocs.io/en/latest/).
The app's own **Quick guide** button (sidebar) has the same walkthrough
in-app, plus acknowledgements and licence.

## Guided workflow

1. **Get data.** Click **Load movie/data** for a real `.tif`/`.tiff` stack (or
   a native Nikon `.nd2` file — the same button also accepts a CSV previously
   written by **Save data**), or **Simulate movie** for a test dataset (open
   **Simulation settings** to adjust frames, blink density and photons).
2. **Set detection & fit.** Pick a **Fit method** first — the relevant
   parameters follow it. **Phasor** is the speed option (no iteration);
   **Gaussian (LS)** and **Gaussian (MLE)** trade speed for precision, with
   MLE reporting a proper per-localization CRLB uncertainty and covering
   spherical, elliptical, 3D-astigmatic and rotated-elliptical (sSMLM)
   variants — see the **Fit method** popup and the full docs for when to use
   which. Adjust **Threshold (k·σ_noise)** if too many/few spots are boxed in
   the raw view, and set **σ_PSF** to match your spot size.
3. **Localize.** The raw view refreshes live with detected ROIs (green boxes)
   and accepted localizations as the run progresses; the right panel builds
   the super-resolution image.
4. **Explore the result.** Set **Pixel size (nm)** (e.g. 100 or 160) — it
   defines the physical scale for the scale bar and export. Change
   **Magnification**/**σ_render** to re-render instantly (no refit). Scroll
   or pinch to zoom, drag to pan, double-click/tap to reset.
5. **Optional extras.** Each remaining sidebar section is a self-contained
   add-on, opened as needed: **Gain & offset estimation** calibrates real
   camera photon units; **3D calibration** fits an astigmatic width-vs-z
   curve for 3D localization; **Drift correction** removes sample drift
   (AIM); **Localization precision** reports NeNA/FRC; **Spectral SMLM
   analysis** pairs 0th/1st-order localizations from a diffraction grating;
   **Single particle tracking** links per-frame localizations into
   trajectories and estimates diffusion coefficients.

## Data & privacy

The application is a single static HTML file. Your image data is read locally by
the browser and never leaves your machine — there is no server and no upload.

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
paper it implements (Martens et al., 2018 — see
[`docs/DOCUMENTATION.md` §9](docs/DOCUMENTATION.md) for this and every other
algorithm reference).

Each new **GitHub release** is picked up by Zenodo automatically and gets its own
version DOI; pushing to `main` redeploys the Pages site.

## License

© 2026 **Hohlbein et al.**, licensed under the
[MIT License](https://opensource.org/licenses/MIT) — see [`LICENSE`](LICENSE).
Versions 0.1.0–0.11.2 remain available under their original CC BY 4.0 terms;
this MIT license applies going forward.

Bundled third-party decoders retain their own MIT licenses:
[UTIF.js](https://github.com/photopea/UTIF.js) and
[pako](https://github.com/nodeca/pako).
