# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (~4000 lines). It loads a raw TIFF stack, detects/localizes emitters,
and renders a super-resolution image, **entirely client-side** (no upload, no server, no network
calls at runtime). `index.html` is just a redirect to `webSMLM.html` for the bare Pages URL.

There is **no build system, no package.json, no dependency install, and no test runner.**
"Running" the app = opening `webSMLM.html` in a browser (double-click, or the hosted Pages copy).
Do not introduce a bundler, framework, or npm dependency — the zero-install single-file property
is the point. New third-party code must be inlined and its license honoured in the head banner.

## Editing model

All work happens inside `webSMLM.html`. It is organized into commented `MODULE:` banners; find the
relevant one before editing rather than scrolling:

- **io** — TIFF parsing; in-memory vs. streamed loading; contiguous ImageJ stacks are indexed
  arithmetically, multi-IFD (Micro-Manager MMStack) stacks by walking the IFD chain. Handles
  multi-GB files via `File.slice()` (never fully loaded).
- **detect** — per-frame band-pass (à trous B-spline **wavelet**, the default, or Difference-of-
  Gaussians) then local maxima above `mean + k·σ`.
- **fit** — phasor (fast, non-iterative) and least-squares 2D-Gaussian localization.
- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting.
- **workers** — frame-parallel detect/fit (see below).
- **export** — ThunderSTORM-compatible CSV.
- **calibration** — astigmatic 3D: σ_x/σ_y vs z bead curves, JSON save/load.
- **drift** — AIM (adaptive intersection maximization), point-based, 2D+z.
- **precision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution,
  inline radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
- **pipeline** — top-level orchestration wiring the UI buttons to the modules.

### Web Worker gotcha (read before touching detect/fit/workers)

Workers are **not** separate files. `workerSource()` builds worker code by calling `.toString()`
on the very functions the main thread uses, so detection/fitting logic exists once. Consequences:

- A worker gets a fresh global scope. Any module-level state a stringified function relies on must
  be re-declared in `WORKER_PRELUDE`, or the worker throws a `ReferenceError` and silently falls
  back to single-threaded. If you add a `let`/`const` at module scope that a detect/fit function
  reads, add it to `WORKER_PRELUDE` too (there is a runtime check listing `missing` names).
- Any helper a stringified function calls must itself be included in the `workerSource()` body.

### Left/right panel plot pattern

The left panel (`raw` canvas) doubles as a plot surface. To show a plot instead of a frame, set
`rawFull=null; rawIsPlot=true; rawPlotName=<kind>` and draw directly on `$('raw')`; call
`syncSaveImg()`. Calibration plots render on the right (`sr`) canvas via `srIsPlot`. Switching a
panel back to a frame/reconstruction (`drawRawView`/`drawView`) must clear any plot-only overlay
state so a stale plot can't paint over live pixels.

### Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

## Validating changes (no test framework)

There is no automated test suite. To sanity-check JS changes without a browser, use the local
JavaScript engine:

```sh
# Full-file syntax check: extract the largest <script> and parse it with new Function()
python3 - <<'PY'
import re
src=max(re.findall(r'<script[^>]*>(.*?)</script>', open('webSMLM.html').read(), re.S), key=len)
open('/tmp/app.js','w').write(src)
PY
osascript -l JavaScript -e "var s=$.NSString.stringWithContentsOfFileEncodingError('/tmp/app.js',4,null).js; try{ new Function(s); 'SYNTAX OK'; }catch(e){ 'ERR: '+e }"
```

Numeric additions (fit, NeNA, FRC, drift, calibration) are validated by extracting the specific
functions, stubbing their globals (`performance`, `log`, etc.), and running against synthetic
ground truth in the same `osascript -l JavaScript` (JXA) engine. JXA has no good JIT (~50–100×
slower than V8), so keep validation inputs small.

## Branch & release workflow

- **`main`** is live: it is served by GitHub Pages (`hohlbeinlab.github.io/webSMLM/webSMLM.html`)
  and archived on Zenodo. **`webSMLM_local`** is the dev branch — do work there.
- Only push to `main`, merge, or cut a release **when the user explicitly asks.** Release = commit
  on `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Cadence: **minor bumps (`0.x.0`) → cut a GitHub release + new Zenodo version DOI. Patch releases
  (`0.x.y`) → version bump + push to `main` only, no DOI.**
- Version lives in two spots in `webSMLM.html` (the `.pill` in the `<h1>`, and the `<noscript>`
  log-stamp line) plus `CITATION.cff`. Dev builds are marked `vX.Y.Z-dev · build YYYY-MM-DDx`;
  clear the dev marker to `vX.Y.Z · proof-of-concept` on release.
- Every release also updates `CHANGELOG.md` (newest first; DOI column) and the "Shipped" table in
  `docs/REFACTOR_PLAN.md` (the forward-looking roadmap). Pages typically redeploys ~1-2 min after
  a push; check with `gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`.

## Reference material

- `README.md` — user-facing feature list, performance figures, algorithm references.
- `docs/REFACTOR_PLAN.md` — roadmap and shipped-feature history; think in version numbers, not
  "phases".
- `experimental_data/` — sample stacks (gitignored large files) with a README of public sources;
  note diffusing PAINT samples (e.g. Nile Red) are poor NeNA subjects.
