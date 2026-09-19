# GPU test and benchmark scripts

Plain Node.js + Playwright scripts drive the local `webSMLM.html` in a real
browser and compare WebGPU-accelerated fit, render, and FRC paths against the
CPU path for both speed and correctness.

The runnable scripts live in `tests/gpu/`. Shared helpers stay in `tests/lib/`.
Playwright is installed once through `tools/package.json`; there is no separate
`tests/package.json` or `tests/node_modules`.

## Setup

```sh
cd tools
npm install
```

`tests/lib/launch.mjs` tries the machine's installed Chrome first
(`channel: "chrome"`), then falls back to Playwright's Chromium from `tools/`.

## Running

From the repo root:

```sh
npm --prefix tools test
npm --prefix tools run gpu:test:foundation
npm --prefix tools run gpu:bench:fit
npm --prefix tools run gpu:all
npm --prefix tools run gpu:all:full
```


`gpu:all` runs the correctness suite plus the standard GPU benchmark set and
overwrites:

- `tests/results/gpu-latest.json`
- `tests/results/gpu-report.html`

`gpu:all:full` is the opt-in full real-data stress run. Timestamped per-bench
JSON files are still kept in `tests/results/`; the aggregate report uses only
files generated during the current suite run.

## Analytics reports — one test, several, or all

Every bench/test writes its own timestamped JSON under `tests/results/`, and
that always feeds an HTML analytics page:

- **Run one script directly** (`node tests/gpu/bench-fit.mjs`) — it generates
  its own scoped `tests/results/gpu-report.html` covering just that result and
  **opens it automatically** in your default browser when it finishes.
- **Run a chosen few via the suite**: `node tests/gpu/run-suite.mjs
  --only=bench-fit,bench-render` (script basenames, comma-separated, no
  `.mjs`) — one combined report covering exactly those, opened once.
- **Run everything**: `npm --prefix tools run gpu:all` (or `gpu:all:full`) —
  one combined report covering the whole run, opened once.

Set `WEBSMLM_TEST_NO_OPEN=1` (or run under `CI=1`) to suppress the
auto-open and just get the file path printed instead.

## Real data and temp/

Real-data benches (detect/real-data/gpu-stages/live-render's Part B/drift/
calibration/3d-fit, plus the new multi-file-load/segmentation benches) each
look for their file under `temp/` first. If it isn't there:

- set `WEBSMLM_TEST_DATA_<KEY>=<path>` (the console output on a skip names
  the exact `<KEY>`) to point at your own copy, or
- run the script from an interactive terminal and it will prompt for a path,
  remembering your answer in `tests/results/.data-paths.json` (git-ignored)
  so you're only asked once.

Neither is required — every real-data bench still just skips (not fails)
when nothing is found, same as before.

## Live-streaming coverage

`window.webSMLM.liveStream` (the Micro-Manager/pycromanager bridge) has three
test tiers:

- **Tier A** (`bench-livestream.mjs`, always runs) — the file-push conduit,
  fully automated, checked against a plain one-shot `analyze()` on the same
  synthetic frames.
- **Tier B** (`bench-livestream-realtime.mjs`, always runs) — the real
  WebSocket wire protocol, driven by a small in-process, dependency-free
  Node WebSocket server (`tests/lib/mini-ws-server.mjs`) — no Python, no
  external process. `tools/test_livestream_demo.py` (Python, manual) stays
  as the separate hand-driven dev tool it always was.
- **Tier C** (`node tests/gpu/live-hardware-checklist.mjs`, or
  `run-suite.mjs --live-hardware`) — real Micro-Manager hardware. Nothing
  here can drive Micro-Manager's GUI, so this only prints the manual steps
  and polls for a connection; never part of a default/unattended run.

## Current layout

- `tests/gpu/test-*.mjs` — fast correctness gates.
- `tests/gpu/bench-*.mjs` — GPU/CPU benchmarks and larger integration checks.
- `tests/gpu/run-suite.mjs` — aggregate GPU suite + latest report generator.
- `tests/lib/` — shared Playwright launch, reporting, and report HTML helpers.
- `tests/results/` — git-ignored JSON output plus the latest generated report.

## Notes

The tests are intentionally external to `webSMLM.html`. They exercise the
public browser API and UI-facing analysis path without adding runtime
dependencies to the single-page app.
