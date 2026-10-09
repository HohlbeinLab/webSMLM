# webSMLM vs. Picasso cross-validation

This optional harness runs webSMLM and
[Picasso](https://github.com/jungmannlab/picasso) on the same input. It measures
each tool against the same known ground truth where truth exists, then measures
agreement and runtime separately. It supports an independent synthetic fixture,
a fixed-seed movie from webSMLM's physical simulator, and the published EPFL
high- and low-density astigmatism challenge data.

See the [general test guide](../README.md) for setup conventions, result files,
report behavior, and guidance for adding tests.

## Setup

From the repository root:

```sh
npm --prefix tools run validation:setup
```

This installs `tests/validation/requirements.txt`. Picasso's CLI includes PyQt6,
although this headless localization path does not open a display. Set
`WEBSMLM_PICASSO_PYTHON` when the required Python interpreter is not the
`python` found on `PATH`.

The dashboard (`npm --prefix tools run dashboard`) diagnoses Python and Picasso
separately. Its **Install Picasso requirements** action runs the same
`validation:setup` package script; when Python is missing, it reports that
prerequisite instead of attempting the install.

## Running

```sh
npm --prefix tools run validation:compare
npm --prefix tools run validation:compare:full
npm --prefix tools run validation:compare:simulator
npm --prefix tools run validation:compare:simulator:full
npm --prefix tools run validation:compare:epfl-hd
npm --prefix tools run validation:compare:epfl-ld
npm --prefix tools run validation:bench:regimes
npm --prefix tools run validation:bench:regimes:full
npm --prefix tools run picasso:compare       # backward-compatible alias
npm --prefix tools run picasso:compare:full  # backward-compatible alias

cd tools
bun run validation:compare
bun run validation:compare:full
```

The normal run uses a small independent movie; `:full` uses its larger case.
`:simulator` uses the same fixed seed for both tools and `:simulator:full`
increases that workload. The EPFL commands require their movie and published
`activations.csv` ground truth; download each dataset explicitly from the
dashboard or with `data:download:epfl-as-hd` / `data:download:epfl-as-ld`.
Each command writes `tests/results/picasso-latest.json` and
`tests/results/picasso-report.html`. The report opens automatically unless
`WEBSMLM_TEST_NO_OPEN=1` or `CI=1` is set.

Dashboard runs suppress extra report windows and embed `picasso-report.html`
in the Reports view. The Analytics and Results views also expose the run matrix,
tool parameters, comparison summary, and raw result JSON.

If Picasso is unavailable, its half of the comparison skips with exit code 0
and an actionable message. webSMLM is still scored against ground truth.

## Comparison scope

Both tools use matched 2D spherical Gaussian maximum-likelihood fitting and one
documented detection-threshold sweep per tool. Every comparison reports:

- detection Jaccard overlap score with a bootstrap 95% confidence interval;
- localization root mean square error (RMSE) and signed x/y position bias for
  matched true-positive detections;
- mean difference and 95% agreement interval between paired localizations;
- Pearson correlation between the tools' paired localizations.

The independent fixture and fixed-seed application simulation provide known
2D ground truth. The EPFL commands use published activation truth and report
lateral detection/localization accuracy; the current shared fit is spherical
2D, so the report explicitly does not claim matched axial accuracy from the
astigmatic stack. Experimental datasets without per-localization truth can
measure repeatability, structure, throughput, or tool agreement, but cannot
honestly report ground-truth accuracy.

Picasso is an offline analysis tool. Live latency, dropped frames, and sustained
throughput are therefore measured by the separate webSMLM livestream benchmarks,
not shown as a fabricated Picasso-versus-webSMLM realtime comparison.

`validation:bench:regimes` is the broader fixed-seed physical simulation matrix.
It varies structures, density, photons, background, drift, camera, point-spread
function, and fit modes, and records detection and localization accuracy against
known truth. It validates webSMLM across those regimes; the smaller
`validation:compare:simulator` command is the matched webSMLM/Picasso comparison.

## Files

- `generate-ground-truth.mjs` creates the neutral synthetic movie.
- `run-webSMLM.mjs` and `run-picasso.mjs` run each tool and normalize CSV
  output through `ts-csv.mjs`.
- `compare.mjs` implements the statistics and has a direct self-check.
- `cross-validate.mjs` orchestrates `validation:compare` and selects the Picasso
  report writer.

Methodology background remains in `docs/REFACTOR_PLAN.md`.
