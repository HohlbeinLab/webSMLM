# Changelog

All notable changes to **webSMLM** (the single `webSMLM.html`), newest first.

This is the per-release log. The forward-looking **phase roadmap** lives in
[`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md) — note that not every release
maps to a numbered phase: several releases (notably the 0.6.x series) were
cross-cutting UI / robustness work done *between* feature phases.

**DOI column:** a GitHub release archives the version on Zenodo with its own
version DOI. Per the project's cadence a release is normally cut for minor bumps
(`0.x.0`); patch releases (`0.x.y`) usually ship without a new DOI. The concept
DOI [10.5281/zenodo.21445041](https://doi.org/10.5281/zenodo.21445041) always
resolves to the latest.

| Version | Date | Phase | DOI | Summary |
|---|---|---|---|---|
| 0.8.4 | 2026-07-26 | — | — | **Sharper canvases & input guards (under-the-hood UI).** All canvases (plots + reconstruction + raw frame) now render at **device-pixel resolution** and re-render on window resize, so axis text, the scale bar and overlays stay crisp at any window size / on retina instead of pixelating. Plot text unified to a standard 12px font; selection boxes right-aligned to 60% width; NeNA x-axis label nudged to the axis. **Magnification** range extended to 25. **Out-of-range number inputs** are now clamped to the nearest valid value with a log note. |
| 0.8.3 | 2026-07-25 | — | — | **Sidebar UI enhancements.** Collapsible modules (Calibration, Drift, Precision, Memory & streaming, Simulation) are now slim, flat/outlined **section bars** with an oversized leading triangle — visually distinct from the raised action buttons; their controls are **indented** so they read as belonging to the section. Whole control tier unified to **12px** (labels, inputs, selects, buttons; help/hints stay 11px). Separator line added above **Magnification**; "Help & guide" no longer bold. |
| 0.8.2 | 2026-07-24 | — | — | **Plot cursor readouts.** Hovering inside any axis plot (line profile, NeNA, FRC, drift, calibration) now shows a dashed crosshair and a readout of the cursor position in data units (e.g. FRC gives spatial frequency, its resolution equivalent in nm, and the FRC value). Implemented once via a shared snapshot-restore overlay, so hovering never re-runs the plot render. |
| 0.8.1 | 2026-07-24 | — | — | **NeNA** fit switched to the full **Endesfelder** function (signal Rayleigh + Gaussian short-range + linear long-range). New **line-profile / distance tool** in the reconstruction — click two points → intensity profile over a 3-px band, plotted with x-zoom/pan and styled axes. Depth colourbar ticks at **+max / 0 / min** (overlapping label dropped); **Phasor 3D auto-selects the Turbo** colour map. **Clear log / Export log** buttons. Plot-label polish (drift/FRC axis titles no longer clipped, FRC "1/7" above its line); Memory/Simulation help collapsed behind "…further info…"; not-yet-implemented FSC checkbox hidden. |
| **0.8.0** | 2026-07-23 | precision | ✓ | **Localization precision & resolution (experimental).** **NeNA** — mean per-localization precision from the nearest-neighbour distance distribution (Endesfelder et al. 2014), with a fitted-histogram plot and a fit-covariance error; caveat that it needs a *static* structure. **FRC** — image resolution at the 1/7 threshold via Fourier ring correlation of two random halves (Nieuwenhuizen et al. 2013; compact inline radix-2 FFT, no dependency), with the curve plotted and an error from the split spread. Both on the left panel, saved via Save image. *New and not yet cross-validated against established tools.* |
| 0.7.7 | 2026-07-23 | — | — | **Save image** — export either window as PNG (chooser when both have content; reconstruction & raw frame supersampled with crisp overlays; drift/calibration plots snapshotted). Scale bar added to the raw window. Pixel-size changes now live-refresh both scale bars and the nm/px readout. Log timing-breakdown column alignment fix. |
| 0.7.6 | 2026-07-23 | — | — | Fix: "Colour by depth" toggle now appears (ticked) the moment a 3D fit method is chosen, not only after a run. README refreshed for the wavelet default and updated performance (4.89 GB 3D stack ~12 s / ~350k loc/s; browser ordering note). |
| 0.7.5 | 2026-07-23 | — | — | Selectable detection filter: à trous B-spline **wavelet** (ThunderSTORM-style, ~2× faster band-pass) **now the default**, or DoG band-pass. `findMaxima` mean+variance fused into one pass. Re-tune **k** when switching filters (they respond differently). |
| 0.7.4 | 2026-07-23 | — | — | UI polish: drop decorative button glyphs (self-explaining labels); disclosure "⋯" inherits text colour; Compute stat in seconds; reconstruction caption shows just nm/px; "All client-side, no upload." moved to the subtitle. |
| 0.7.3 | 2026-07-23 | — | — | Docs only (app unchanged): README gets a "Launch webSMLM" badge and a direct hosted link (`…/webSMLM.html`); Roadmap trimmed to point at the plan. |
| 0.7.2 | 2026-07-23 | — | — | Docs only (app unchanged from 0.7.1): `experimental_data/README.md` links to the public source datasets — GATTAquant GATTA-PAINT 80R RAW and Leterrier's 3D STORM stack (figshare); notes the 4.9 GB 3D stack runs client-side on an iPhone 17. |
| 0.7.1 | 2026-07-23 | — | — | `<noscript>` warning when JavaScript is disabled (some browser privacy settings otherwise leave the page blank) — a top banner plus a light-red line in the log. |
| **0.7.0** | 2026-07-22 | Phase 5 — drift | ✓ | Drift correction via **AIM** (adaptive intersection maximization), 2D + 3D; point-based, no FFT. Drift-vs-frame plot, reversible correction, clamp-fraction guard. |
| 0.6.3 | 2026-07-22 | — | — | *Local/dev only* — calibration overlays kept while scrubbing; robust large-stack loading. Folded into 0.7.0. |
| 0.6.2 | 2026-07-22 | — | — | Type-aware TIFF tag reading (fixes big-endian LONG tags → "could not read image dimensions"). |
| 0.6.1 | 2026-07-22 | — | ✓ | Large multi-IFD (Micro-Manager MMStack) streaming loader — indexes multi-GB stacks by walking the IFD chain. |
| 0.6.0 | 2026-07-22 | — | ✓ | **UI overhaul & pipeline polish**: sidebar reorg, number inputs (not sliders), Save/Load settings, both-panel zoom/pan, sub-pixel crosshair overlays. Fixes: multi-IFD freeze, blank-input render crash, O(n²) live-preview slowdown. |
| 0.5.0 | 2026-07-21 | Phase 4 — 3D | ✓ | **3D astigmatism (Phasor 3D)**: bead z-calibration, z per localization from the phasor width ratio, depth-coded render, calibration save/load. |
| 0.4.1 | 2026-07-21 | — | — | Raw-view refresh fix during parallel runs; GitHub header link. |
| 0.4.0 | 2026-07-20 | Phase 3 — CSV | ✓ | **CSV export** (ThunderSTORM-compatible), large-stack streaming, UI tidy-up. |
| 0.3.0 | 2026-07-20 | Phase 2 — speed | — | **Speed review**: band-pass optimization + Web Worker pool (~7× / ~30× faster). |
| 0.2.0 | 2026-07-20 | Phase 1 — UI | — | **UI / responsive redesign**, small-screen (phone/tablet) support. |
| 0.1.0 | 2026-07-19 | — | ✓ | Initial browser-based SMLM localizer: phasor + 2D-Gaussian fitting, TIFF loader, super-resolution render. |

<sub>0.2.0 and 0.3.0 predate the release policy (dev moved fast, no DOIs cut). 0.4.1, 0.6.2 and 0.6.3 were patches without a DOI. 0.6.1 was released despite being a patch.</sub>
