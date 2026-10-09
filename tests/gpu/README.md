# GPU tests and benchmarks

These tests drive webSMLM in a real Chromium browser and compare WebGPU paths
with CPU behavior for correctness, output quality, and timing. Shared setup,
result conventions, and instructions for adding tests are in the
[general test guide](../README.md).

## Requirements

Install the dependencies from `tools/package.json` and run on a machine where
Chrome or Playwright Chromium can expose WebGPU. The launcher prefers installed
Chrome and falls back to Playwright Chromium.

GPU availability is checked inside the browser. Depending on the script, an
unavailable GPU produces a clear skip or CPU-only measurements. It must not be
reported as a successful GPU measurement. Real hardware validation is manual:

```sh
npm --prefix tools run live-hardware
```

The main dashboard is available with `npm --prefix tools run dashboard`. Its
diagnostics show Playwright and Chromium readiness; **Probe WebGPU** launches
the existing test browser through `launchPage()` and reports the shared
`checkGpu()` result. Use the GPU command filter to select one benchmark,
`gpu:all`, or CPU/GPU dataset variants. The dashboard shows skips separately
from successful GPU measurements.

## CPU and GPU modes

Most benchmarks run the same workload through CPU and GPU paths and record
timings plus numerical differences. Correctness tests use tolerances appropriate
to CPU floating-point versus GPU floating-point arithmetic. Tests that require a
GPU skip when WebGPU is unavailable; mixed benchmarks may still report their CPU
side.

The real-data entry points select the mode explicitly for the documented STORM
dataset (all in `tools/package.json`):

```sh
npm --prefix tools run bench:dataset:storm3d
npm --prefix tools run bench:dataset:storm3d:cpu
npm --prefix tools run bench:dataset:storm3d:gpu
npm --prefix tools run bench:dataset:gatta80r
npm --prefix tools run bench:dataset:gatta80r:cpu
npm --prefix tools run bench:dataset:gatta80r:gpu
npm --prefix tools run bench:dataset:epfl-as-hd:cpu
npm --prefix tools run bench:dataset:epfl-as-ld:gpu
```

Unqualified dataset commands run both modes; the `:cpu` and `:gpu` commands
select one path explicitly. EPFL astigmatism runs are 2D CPU/GPU localization
benchmarks with the documented camera parameters; 3D ground-truth validation
remains a separate calibration workflow.

Bounded commands are the normal dashboard choices. **Standard run** (`all`)
covers every automated group; **Everything available** (`everything`) adds
optional Picasso validation. Commands marked **full workload** use the same
coverage with larger inputs and can consume much more time and memory.

## Coverage

- Correctness: foundation behavior, GPU fit parity, GPU FRC, candidate auditing,
  PCFO, simulator output, simulated-movie memory accounting, shape testing,
  frame-cache integrity, 3D view transforms, GPU viewport sampling, and FRC
  pixel-size recomputation (`gpu:test:*`).
- Core performance: fitting, rendering, FRC, detection, and live rendering.
- Simulation performance: bounded and `--full` simulator workloads through
  `gpu:bench:simulation`; simulator-vs-ground-truth validation remains available
  through `validation:compare:simulator`.
- Scientific workflows here: real-data analysis, stage timing and 3D fitting.
  Drift, calibration, sSMLM, SPT and segmentation live in `tests/cpu/`;
  multi-file loading in `tests/io/`; streaming in `tests/livestream/`.

List the package commands in `tools/package.json` for the authoritative mapping
from command names to modules. A focused module can also be run directly, such
as `node tests/gpu/bench-render.mjs`.

## Predefined runs

```sh
npm --prefix tools run gpu:all        # GPU group: tests and benchmarks
npm --prefix tools run gpu:test:simulation
npm --prefix tools run gpu:test:sim-memory
npm --prefix tools run gpu:test:view3d
npm --prefix tools run gpu:test:viewport-gpu
npm --prefix tools run gpu:test:frc-pixelsize
npm --prefix tools run gpu:bench:simulation
npm --prefix tools test               # fast gate, every group's tests
npm --prefix tools run bench:all      # benchmarks only
npm --prefix tools run all:full
npm --prefix tools run everything     # all automated groups plus Picasso when available
```

The same names work with `bun run` from `tools/`. Use
`node tests/run-suite.mjs --gpu --only=name1,name2` for a selected aggregate
report.

## Real data and skips

Standard real-data runs are bounded so they remain practical during routine
development. `all:full` passes `--full` to workloads that support an
opt-in full dataset run. Large data is never downloaded automatically.

Missing files resolved through `tests/lib/data.mjs` are expected skips, not
failures. The dashboard names the required dataset and points to its download
when public. You can also set the printed environment variable or place the file
at its documented path under `temp/`. Predefined and CI runs do not prompt. See
`experimental_data/README.md` for dataset sources and parameters.

Streaming has three levels: automated file-push (`tests/livestream/bench-livestream.mjs`), an
automated in-process WebSocket server (`tests/livestream/bench-livestream-realtime.mjs`), and the
manual Micro-Manager hardware checklist. The hardware check is never part of a
default unattended suite.
