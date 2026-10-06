# Tests and benchmarks

The test harness drives `webSMLM.html` through Playwright and keeps test-only
dependencies in `tools/`. Tests stay outside the application so they exercise
the same browser API and UI-facing paths as normal use.

## Setup

Install the tools dependencies once:

```sh
npm --prefix tools install
```

`tests/lib/launch.mjs` tries the installed Chrome channel first, then the
Playwright Chromium installed from `tools/`.

## Dashboard

Start the local dashboard from the repository root:

```sh
npm --prefix tools run dashboard
# or: cd tools && bun run dashboard
```

It opens a loopback-only control panel for the same package scripts documented
below. Select an individual command or a predefined run, then use **Run
selected**. A predefined run (called a suite in code) is one maintained list of
tests and benchmarks executed in order; choosing one replaces overlapping child
selections so work is not repeated.

**Standard run** (`all`) covers every normal automated group with bounded workloads.
**Everything available** (`everything`) adds the physical simulation regime
matrix plus optional Picasso comparisons on the independent fixture, fixed-seed
simulator, and EPFL high-density truth when that dataset is ready.
`everything:full` also uses larger workloads and adds the
EPFL low-density comparison when ready. Setup, dataset downloads, and live
hardware always remain separate explicit actions. A missing optional dataset is
recorded as skipped with its download instruction; it does not fail unrelated
tests.

The dashboard also provides one-click JavaScript/Chromium and Python/Picasso
setup, a WebGPU probe, per-dataset source and download controls, live command output, result
tables, charts, JSON inspection, and generated HTML reports.
Downloads remain opt-in and are offered one dataset at a time. Active downloads
show percent complete, transferred size, throughput, and ETA in the dataset row
and command log. The dashboard lists only datasets with a working public source
and downloader; private fixtures remain available to local command-line tests.
Each command names the real dataset it uses and whether it is ready. A missing
dataset is recorded as **Skipped**, with a reason and a request to download the
public dataset or provide the documented private fixture; it is not a failure.

Analytics and Results are run-based, not GPU-specific. Select one saved run to
see its GPU, CPU, I/O, livestream, validation, harness, and dataset groups.
Aggregate suites expand into individual test and benchmark rows with their own
pass/fail/skip status, duration, generated artifacts, and captured log. Runs do
not merge with earlier runs. The latest 25 are kept in the single generated
`tests/results/dashboard-runs.json` file.

Results and Reports follow the same selected run. The artifact table never
shows unrelated files from older runs, names the command that produced each
file, and opens JSON details or that run's HTML report. The controller keeps a
run-specific copy of mutable `*-latest.json` and `*.html` outputs so a later run
cannot silently replace the report shown for an earlier selection. Commands
that produce only status and logs show a clear empty-artifact message.

The controller binds to `127.0.0.1`, accepts only package scripts and manifest
datasets from fixed allowlists, and requires a random session token for command
and result endpoints. It has no arbitrary command or path input. Only one
command queue runs at a time.

## Layout

- `tests/gpu/` holds the tests and benchmarks that need (or A/B) WebGPU; see
  [GPU testing](gpu/README.md).
- `tests/cpu/` holds CPU-only correctness and science tests and benchmarks
  (smFRET, MLE variance, viewport render, CellField worker, drift, calibration,
  sSMLM, SPT, segmentation).
- `tests/io/` holds file-format and loading tests (BigTIFF, rotate, save
  simulated movie, state clearing, multi-file load).
- `tests/livestream/` holds the live-streaming benchmarks and the manual
  Micro-Manager hardware checklist.
- `tests/harness/` holds tests of the harness itself (report generation, the
  dataset registry, the cross-tool report).
- `tests/validation/` holds the optional webSMLM/Picasso cross-validation
  harness; see [validation](validation/README.md).
- `tests/data/` holds the dataset tooling (`download.mjs`, `bench.mjs`).
- `tests/run-suite.mjs` is the aggregate runner over all groups.
- `tests/dashboard.html` and `tests/dashboard-server.mjs` provide the local
  visual runner and analytics view.
- `tests/lib/` contains shared launch, data-path, dataset-registry, comparison,
  result, and HTML report helpers.
- `temp/` contains local real datasets. It is git-ignored and must not contain
  required source files.
- `tests/results/` contains generated JSON, remembered local data paths, and
  latest HTML reports. It is also git-ignored.

## Running tests

Package scripts work with npm or Bun. Script names are prefixed by group
(`gpu:`, `cpu:`, `io:`, `livestream:`, `harness:`, `validation:`). From the
repository root:

```sh
npm --prefix tools test                       # fast gate: every test, no benchmarks
npm --prefix tools run all                    # standard: every group, bounded workloads
npm --prefix tools run all:full               # standard coverage, full-size workloads
npm --prefix tools run everything             # standard run plus optional Picasso validation
npm --prefix tools run everything:full        # everything available, full-size workloads
npm --prefix tools run cpu:all                # one group (gpu/cpu/io/livestream/harness)
npm --prefix tools run cpu:test:smfret-anchored-bg
npm --prefix tools run validation:compare
npm --prefix tools run validation:bench:regimes # physical regimes scored against truth
npm --prefix tools run gpu:test:simulation       # simulator correctness
npm --prefix tools run gpu:test:sim-memory       # simulated-movie memory accounting
npm --prefix tools run gpu:bench:simulation      # bounded simulator benchmark

cd tools
bun run all
```

Run one module directly when developing a test:

```sh
node tests/gpu/bench-fit.mjs
node tests/run-suite.mjs --only=bench-fit,bench-render
node tests/run-suite.mjs --cpu --io          # group flags combine; none = every group
```

`run-suite.mjs` flags: `--gpu --cpu --io --livestream --harness --validation` (groups),
`--tests-only`, `--benches-only`, `--full`, `--everything`, `--live-hardware`, and
`--only=a,b` (script basenames without `.mjs`, or roster names).

## Real-data datasets

The dataset registry is `tests/lib/datasets.mjs`. It includes every real-data
fixture documented in `experimental_data/README.md`: STORM, GATTA-PAINT, the
five EPFL stacks, sSMLM, smFRET, NPC beads, both public sptPALM Cas12a
conditions, and BigTIFF.
`data:list` labels each entry as an automated download or private fixture. Public
downloads remain opt-in; private fixtures are not shown in the dashboard, and no
normal test or suite downloads large data.

Entries with known `sha256`/`bytes` are verified after the fetch (a mismatch
exits non-zero). Archives without a published checksum report that verification
was skipped. The EPFL ZIPs are extracted and flattened to the manifest paths.
The sSMLM archive is about 19.3 GB and STORM is over 5 GB, so start those only
when there is sufficient disk space and time.

```sh
npm --prefix tools run data:list
npm --prefix tools run data:download -- storm3d
npm --prefix tools run data:download:storm3d
npm --prefix tools run data:download:gatta80r
npm --prefix tools run data:download -- epfl-as-beads
npm --prefix tools run data:download -- epfl-as-hd
npm --prefix tools run data:download -- epfl-as-ld
npm --prefix tools run data:download -- epfl-bp250
npm --prefix tools run data:download -- epfl-dh
npm --prefix tools run data:download -- npc-beads
npm --prefix tools run data:download -- ssmlm
npm --prefix tools run data:download:cas12a-targeting
npm --prefix tools run data:download:cas12a-scrambled
npm --prefix tools run bench:dataset -- storm3d
npm --prefix tools run bench:dataset:storm3d
npm --prefix tools run bench:dataset:storm3d:cpu
npm --prefix tools run bench:dataset:storm3d:gpu
npm --prefix tools run bench:dataset:gatta80r
npm --prefix tools run bench:dataset:gatta80r:cpu
npm --prefix tools run bench:dataset:gatta80r:gpu
npm --prefix tools run bench:dataset:epfl-as-hd:cpu
npm --prefix tools run bench:dataset:epfl-as-ld:gpu
npm --prefix tools run bench:dataset:cas12a-targeting
npm --prefix tools run bench:dataset:cas12a-scrambled
```

## Real-data paths

Real-data tests resolve each required file in this order:

1. Its documented default location under `temp/`.
2. `WEBSMLM_TEST_DATA_<KEY>`, where the test prints the exact key.
3. A previously remembered path in `tests/results/.data-paths.json`.
4. An interactive path prompt when stdin is a terminal.

If no valid path is available, the test skips instead of failing. Suite and CI
runs do not prompt. See `experimental_data/README.md` for source datasets and
scientific acquisition parameters.

## Creating a test

Use `test-*.mjs` for a quick correctness gate and `bench-*.mjs` for timing,
real data, or a larger integration workflow. Reuse helpers from `tests/lib/`
and keep application dependencies out of the harness.

For a real-data test, add the dataset/file role to
`tests/lib/datasets.mjs`, then call `resolveDatasetFile(datasetKey, role)` from
`tests/lib/data.mjs`. The manifest owns paths, environment keys, parameters,
download metadata, and supported scenarios. Exit successfully with a clear
skip message when resolution returns `null`. Keep `resolveDataFile()` for a
one-off external fixture that does not belong in the shared registry.
Add complete `source` and `download` metadata only when the public archive and
destination layout have been verified. Those entries automatically receive
Source and Download controls in the dashboard; entries without `download` stay
available to local CLI tests but are intentionally hidden from that list.

Save structured output with:

```js
import { writeResults } from '../lib/report.mjs';

writeResults('bench-example', {
  parameters,
  measurements,
  verdict,
});
```

`writeResults(name, data, options?)` writes
`tests/results/<name>-<timestamp>.json`. A standalone run also generates and
opens a scoped HTML report. The suite sets `WEBSMLM_TEST_SUITE`, collects the
result files from that run, and opens one aggregate report instead. Pass a
specialized `reportWriter` only when the default GPU report is not appropriate,
as the Picasso harness does.

The suite also stores a bounded log on each command record. Keep important
diagnostics on stdout/stderr so the dashboard can show the exact output for the
selected test without combining it with another run.

Set `WEBSMLM_TEST_NO_OPEN=1`, or run under `CI=1`, to create reports without
opening a browser. Suite runs update `gpu-latest.json` and `gpu-report.html`;
Picasso runs update `picasso-latest.json` and `picasso-report.html`.

When adding a package command, point it at the test module from
`tools/package.json`. User-facing scripts appear in the dashboard automatically;
setup, generic argument-taking, lifecycle, and dashboard scripts stay outside
the selectable command list. Add a module to the roster in
`tests/run-suite.mjs` only when it belongs in the aggregate suite; preserve
direct execution for focused debugging. New JSON files in `tests/results/`
appear automatically, with a generic table when no specialized summary exists.

See [GPU testing](gpu/README.md) and
[Picasso cross-validation](validation/README.md) for harness-specific details.
