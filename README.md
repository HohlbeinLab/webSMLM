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

1. **Get data.** Click **Load data** for a real `.tif`/`.tiff` stack (or
   a native Nikon `.nd2` or camera-generated `.fits` file — the same button
   also accepts a CSV previously written by **Save localisations**), or **Simulate
   movie** for a test dataset with a known answer (open **Simulation** to
   choose the structure, density and physics; **Compare to GT** then grades
   your analysis against it).
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
   curve for 3D localization; **Drift correction & precision** removes
   sample drift (AIM or cross correlation) and reports NeNA/FRC; **Pairing
   for sSMLM or FRET** pairs 0th/1st-order localizations from a diffraction
   grating (or a prism-split donor/acceptor pair); **Time traces and FRET**
   finds sites of interest, pairs donor/acceptor channels and reads out
   DD/DA/AA intensity-vs-time traces; **Single-particle tracking** links
   per-frame localizations into trajectories and estimates diffusion
   coefficients.

## Simulation

**Simulate movie** generates synthetic data with a known ground truth, entirely in the
browser: a labelled 3D structure (microtubule networks in whole cells, nuclear pore
complexes, filaments, a tilted plane, a uniform volume or a spherical shell), molecules
that blink and bleach, a structured background, an sCMOS or EMCCD camera, and a
physically modelled vectorial PSF (Gibson-Lanni + Zernike aberrations, including
astigmatism and extended-depth presets). **Compare to GT** then scores a Localize
result against the truth — detection, lateral and axial error, per molecule and per
depth, and measured precision against both the fit's own CRLB and the theoretical
bound for the true emitters — and **Calib. 3D stack** simulates a matching bead stack
for 3D calibration. The simulated camera is copied into the Localisation fields, the
ground truth can be saved and loaded (**Save/Load ground truth**), and the movie
itself saved as a 16-bit TIFF (**Save sim. movie**). Seeded runs are exactly
reproducible; rendering runs on the GPU when available.
Step-by-step instructions and worked recipes:
[Simulation guide](https://websmlm.readthedocs.io/en/latest/content/02-module-reference.html#websmlm-simulation-guide).

## Live streaming (experimental)

For real-time acquisition rather than a saved file: an external process pushes
frame chunks in as they're acquired, each localized and rendered into the
reconstruction live, with no full stack ever loaded upfront. Two ways in:

- **WebSocket** — hook into a tab you already have open, in any browser. A
  local script (`tools/test_livestream_demo.py`) opens a WebSocket server;
  the page only ever connects *out* to it, opt-in, when you click **Connect**
  in the sidebar's **Memory & streaming** section — webSMLM never listens for
  incoming connections itself.
- **`tools/webSMLM-livestream-bridge.mjs`** — a fully automated/headless
  session (e.g. a Micro-Manager/pycromanager acquisition via a Gladoscopy RT
  node): a Playwright-driven bridge launches its own browser and feeds chunks
  in via `window.webSMLM.liveStream.pushChunk()`, no manual clicking at all.

Either way, the top-level **Stop** button ends the session; results (drift
correction, NeNA/FRC, CSV export, the locs table) are available while
streaming is still active, the same as after a normal Localize. See the
in-app **Memory & streaming** section's own "more info…" popup, or
[the full reference](https://websmlm.readthedocs.io/en/latest/) §2/§8, for
details.

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

## Tests and benchmark dashboard

Run `npm --prefix tools run dashboard` to open the local test dashboard. It can
check requirements, run individual tests or predefined runs, download supported public
datasets into `temp/`, stream logs, and inspect saved results and reports. The
same commands remain available from `tools/package.json`; see
[`tests/README.md`](tests/README.md) for setup and the short checklist for adding
tests, benchmarks, result files, and datasets.

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
[pako](https://github.com/nodeca/pako). The simulator's microtubule cell field is the
[inSiliScope](https://github.com/kjamartens/inSiliScope) world model of Koen J.A. Martens
(BSD-3-Clause, no GPL code), embedded as a generated block; its licence text is in the
head comment of `webSMLM.html`.
