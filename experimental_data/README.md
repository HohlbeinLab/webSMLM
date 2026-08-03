# experimental_data

Drop real SMLM stacks here for benchmarking and validation.

## These files are not committed

Everything with an image extension is git-ignored — see [`.gitignore`](.gitignore).
That is deliberate:

- **This repository is public.** Committing a stack publishes it, along with any
  licensing or prior-publication implications.
- **GitHub rejects files over 100 MB** and warns above 50 MB. Raw SMLM stacks are
  routinely far larger.
- **Git history is permanent.** A large binary committed once bloats every future
  clone even if it is deleted in a later commit.

The files are still fully usable locally — they are simply untracked.

## If a fixture *should* be committed

A small, deliberately-cropped stack (a few MB, e.g. 50 frames of 128×128) makes a
genuinely useful regression fixture. Force-add it and say where it came from:

```bash
git add -f experimental_data/small_crop.tif
```

For anything larger, prefer a download link or a Zenodo deposit referenced here
over committing the bytes.

## Current benchmark dataset

`GATTA-PAINT-80R-raw_cropped.tif` — GATTAquant GATTA-PAINT 80R DNA-PAINT
nanoruler (80 nm mark-to-mark), acquired on a Leica GSD system, cropped from the
`80nm 80ms top image.lif` series and concatenated by ImageJ 1.54r.

**Full raw dataset (public):** [`GATTA-PAINT-80R-RAW.zip`](https://www.gattaquant.com/files/GATTA-PAINT-80R-RAW.zip)
from GATTAquant — our crop above was taken from this.

| Property | Value |
|---|---|
| Frames | 1999 |
| Frame size | 82 × 83 px (cropped from 180 × 180) |
| Bit depth | 16-bit, uncompressed |
| Byte order | **big-endian (MM)** — ImageJ wrote the stack BE; the per-frame originals are LE |
| **Pixel size** | **99.2 nm** (from XResolution 4294967295/42605 = 100808.996 px/cm) |
| Exposure | 80 ms |
| On disk | 26.5 MB |
| Decoded Float32 working set | 51.9 MB — fits the default 3 GB budget, so it loads fully into RAM |

Two reasons this file is a good fixture beyond raw speed:

- **It exercises the big-endian 16-bit decode path**, which was previously
  reasoned-about but never runtime-verified.
- **It carries a resolution ground truth** — the 80 nm mark-to-mark spacing lets
  the FRC precision work (v0.8.0) be validated against a known distance rather
  than only self-consistency.

## Second benchmark dataset — large format

`Sample2_L.lactis_10ng-mlNR_1000f_50msft_30%green_greenfilt_1_MMStack_Pos0.ome.tif`
— Nile Red PAINT on *Lactococcus lactis*, Micro-Manager OME-TIFF.

| Property | Value |
|---|---|
| Frames | 1000 |
| Frame size | 256 × 256 px (**9.6× the pixels/frame of the GATTA crop**) |
| Bit depth | 16-bit, uncompressed |
| Byte order | big-endian (MM) |
| **Pixel size** | **~120 nm** |
| Exposure | 50 ms |
| On disk | 147 MB (**over GitHub's 100 MB limit — never commit**) |
| Decoded Float32 working set | ~262 MB — fits the default 3 GB budget, loads fully into RAM |

This is the dataset that decides the **Web Worker** question. On the 82 × 83 GATTA
crop the per-frame work (~0.36 ms) is small enough that worker message-passing
overhead would dominate. At 256 × 256 the per-frame work is roughly 10× larger,
which is the regime where distributing frames across cores actually pays.

Note on σ_PSF: at 120 nm/px with a typical high-NA objective the diffraction-limited
PSF is only ~0.75 px, at or below the slider's 0.8 minimum. Start at 0.8–1.0 and
tune by eye against the green detection boxes.

**Not a good NeNA sample.** Nile Red is a solvatochromic membrane probe: it
partitions into and **diffuses within the membrane** during binding events, so
consecutive-frame displacements carry that motion on top of the localization
error. NeNA assumes a *static* structure, so it would report an inflated σ here.
Use a fixed-target sample for precision — e.g. the DNA-PAINT nanoruler above,
where the imager binds a static docking strand.

## Third benchmark dataset — 3D STORM (very large, ~4.9 GB)

3D STORM of spectrin rings in neurons, by **Christophe Leterrier**, on figshare:
[3D STORM spectrin rings in neurons](https://figshare.com/articles/dataset/3D_STORM_spectrin_rings_in_neurons/19165061).

| Property | Value |
|---|---|
| Frames | ~40,000 |
| Frame size | 256 × 256 px |
| Format | large multi-IFD TIFF (Micro-Manager MMStack) — indexed by walking the IFD chain |
| On disk | ~4.9 GB (**never loaded whole — streamed frame-by-frame via `File.slice()`**) |
| Processing | ~24 s end-to-end on a laptop |

This is the stress-test dataset behind three features:

- **Large multi-IFD streaming** (v0.6.1) — the file is indexed by walking the
  IFD chain and read one frame at a time, so the 4.9 GB stack is never held in
  memory.
- **Phasor 3D** (v0.5.0) — astigmatic z per localization.
- **z-drift correction** (v0.7.0) — the AIM z channel was developed and tuned
  against this stack.

Notably it runs entirely client-side **in a mobile browser** — tested fine on an
**Apple iPhone 17** — which is the payoff of the memory-aware streaming loader: a
multi-GB 3D stack processed on a phone, with no upload.

## Fourth benchmark dataset — 3D astigmatism ground truth (EPFL SMLM 2016 Challenge)

Three files from the EPFL Biomedical Imaging Group's SMLM 2016 3D simulation
challenge, astigmatism (AS) modality, `MT0.N1` microtubule structure —
[bigwww.epfl.ch/srm/dataset/challenge-3D-simulation](https://bigwww.epfl.ch/srm/dataset/challenge-3D-simulation/index.html)
(Sage et al., *Super-resolution fight club*, Nat. Methods 2019). Unlike the
other stacks in this folder, these are **fully synthetic with known
ground-truth emitter positions** (`positions.csv` / `activations.csv`,
published alongside the LD/HD downloads on the site but not included here) —
the right fixture for validating fit *accuracy* against a known answer, not
just self-consistency.

| File | Role | Frames | Frame size | On disk |
|---|---|---|---|---|
| `sequence-as-stack-Beads-AS-Exp.tif` | Z-calibration bead stack | 151 | 150 × 150 px | 6.5 MB |
| `sequence-as-stack-MT0.N1.HD-AS-Exp.tif` | High-density microtubules (ground truth) | 2'500 | 64 × 64 px | 19.9 MB |
| `sequence-as-stack-MT0.N1.LD-AS-Exp.tif` | Low-density microtubules (ground truth) | 19'996 | 64 × 64 px | 158.9 MB |

Frame counts and dimensions above were verified directly from each file's own
embedded ImageJ `images=` tag and TIFF `ImageWidth`/`ImageLength` (16-bit,
big-endian), not just copied off the site — its shared "Parameters of
simulation" table lists a generic 64 px / 6400 nm field of view that does
**not** apply to the beads file, which is actually 150 × 150 px (that row is
evidently boilerplate inherited from the MT0.N1 page template).

**Simulation / camera parameters** (from the HD dataset's and beads z-stack's
"Parameters of simulation" tables on the site; MT0.N1 LD and HD share the same
"N1" noise profile — *"typical photon counts and background levels for
Alexa647 labelled STORM sample"*):

| Parameter | Value |
|---|---|
| Pixel size | 100.00 nm (MT0.N1 HD/LD; not embedded as a TIFF resolution tag — set manually) |
| Quantum efficiency (QE) | 0.90 e⁻/photon |
| Wavelength | 660.00 nm |
| Numerical aperture (NA) | 1.49 |
| Read-out noise | Gaussian, σ = 74.4 e⁻ |
| EM gain | 300× (Gamma-distributed multiplicative noise) |
| Spurious (clock-induced) charge | Poisson, mean 0.0020 e⁻/pixel/frame |
| Electron conversion | 45.00 e⁻/ADU |
| Baseline (offset) | 100.00 ADU |
| Saturation | 65535 ADU (16-bit) |
| **Total system gain** (QE × EM gain / e⁻ per ADU) | **6.00 ADU/photon** |

**webSMLM settings to match:** Pixel size (nm) = **100**; Camera offset (ADU)
= **100**; Camera gain (photons/ADU) = **1 / 6.00 ≈ 0.167** (webSMLM's field
multiplies ADU by this to get photons — the site's "total gain" is the
inverse, ADU *per* photon).

**Beads z-calibration:** 6 beads/slice, z-step 10 nm, range −750 to +750 nm,
focal plane (z = 0) at the centre slice → **frame 76 of 151**, a ready value
for the "z=0 ref frame" field. Spanning the full ±750 nm defocus range end to
end, it's also a good stress-test for the "Fix bead x,y" calibration option
(v0.9.x) — large defocus is exactly where per-frame detection is prone to
drift or split.

**Molecule density:** LD "0.2", HD "2" (unit not stated on the source page).

**Candidates for committing as fixtures:** `sequence-as-stack-Beads-AS-Exp.tif`
(6.5 MB) and `sequence-as-stack-MT0.N1.HD-AS-Exp.tif` (19.9 MB) are both well
under GitHub's 50 MB warning threshold — worth force-adding once we've
validated webSMLM's fits against the published ground truth, so future
regression checks don't depend on re-downloading from EPFL.
`sequence-as-stack-MT0.N1.LD-AS-Exp.tif` (158.9 MB) stays local-only regardless
(over the 100 MB hard limit).

## Useful properties to note for benchmarking

When adding a stack, record these — they determine which speed optimizations
matter and make timings comparable:

| Property | Why it matters |
|---|---|
| Frame size (px) | Band-pass cost scales with pixel count |
| Frame count | Determines whether streaming or in-RAM loading is used |
| Bit depth / endianness | Exercises the TIFF decode paths |
| Pixel size (nm) | Needed for correct nm-space output |
| Approx. σ_PSF (px) | Sets the DoG kernel size — the dominant cost term |
| Emitter density | Affects detection count and the fit-vs-detect time split |
