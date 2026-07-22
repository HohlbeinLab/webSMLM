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
