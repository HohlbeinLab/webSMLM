# Design notes

Background documents written while building features. They record the reasoning and the
alternatives considered at the time and are **not** kept in sync with the code: the current
behaviour is described in [`docs/DOCUMENTATION.md`](../DOCUMENTATION.md), and what changed when in
[`CHANGELOG.md`](../../CHANGELOG.md).

| File | What it is |
|---|---|
| [`VECTORIAL_PSF_SIMULATION.md`](VECTORIAL_PSF_SIMULATION.md) | How to sample and place an oversampled PSF when simulating (oversample once, interpolate, sum down to camera pixels) |
| [`VECTORIAL_ZERNIKE_PSF_IMPLEMENTATION.md`](VECTORIAL_ZERNIKE_PSF_IMPLEMENTATION.md) | The Gibson-Lanni + Zernike pupil model and where it plugs into the simulator |
| [`SIMULATION_PARITY_DEMOCAM.md`](SIMULATION_PARITY_DEMOCAM.md) | Snapshot comparison with the demoCam_SMLM_MM Micro-Manager simulator |
