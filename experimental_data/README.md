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

GATTAquant GATTA-PAINT 80R DNA-PAINT nanoruler (80 nm mark-to-mark), acquired
on a Leica GSD system.

**Full raw dataset (public):** [`GATTA-PAINT-80R-RAW.zip`](https://www.gattaquant.com/files/GATTA-PAINT-80R-RAW.zip)
from GATTAquant.

| Property | Value |
|---|---|
| Native frame size | 180 × 180 px |
| Bit depth | 16-bit, uncompressed |
| Byte order | little-endian per individual frame; **big-endian once concatenated into a stack by ImageJ** |
| **Pixel size** | **99.2 nm** (from XResolution 4294967295/42605 = 100808.996 px/cm) |
| Exposure | 80 ms |

**The public download is not a single ready-to-load stack** — it's one TIFF
per frame. webSMLM loads it directly: click **Load movie**, then select all
the frame files at once (Ctrl/Cmd+click, or your file manager's "select all")
— multiple single-frame TIFFs are natural-sorted by filename and concatenated
into one stack automatically, no separate tool needed. (An older route still
works too: concatenate them into one multi-frame TIFF in ImageJ first — File
→ Import, then File → Save As → Tiff — and load that single file instead;
see below for why that path is still worth keeping around as a test case.)

Three reasons this dataset is a good fixture beyond raw speed:

- **It exercises the multi-file loader** (`loadTiffSequence`) — natural
  filename sorting (so frame 2 sorts before frame 10) and per-file decoding,
  each frame in its own little-endian byte order.
- **The ImageJ-concatenated alternative exercises the big-endian 16-bit
  decode path instead** — the per-frame originals are little-endian, but
  ImageJ's concatenated stack comes out big-endian, a different code path
  (`loadTiff`/`loadMultiIfdStreaming`) than loading the folder directly.
- **It carries a resolution ground truth** — the 80 nm mark-to-mark spacing
  lets the FRC precision work be validated against a known distance rather
  than only self-consistency.

**FRC on this dataset shows extra peaks at 40 nm and 20 nm**, alongside the
expected 80 nm one — exact submultiples of the ruler spacing (80/2, 80/4),
not a bug. A periodic structure like a regularly-spaced nanoruler array
concentrates its Fourier content at the fundamental spatial frequency *and*
its harmonics, so FRC — which assumes a generic, non-periodic structure —
picks those harmonics up as apparent resolution. Expect this on any
sufficiently periodic sample; it isn't extra resolved detail.

**`GATTA-PAINT-80R-raw_cropped.tif`** (82×83 px, 1999 frames, big-endian) is a
smaller ImageJ-cropped derivative of the dataset above, kept alongside a
byte-identical duplicate (`GATTA-PAINT-80R-raw_cropped copy.tif`) specifically
to exercise `loadTiffFilesAuto()`'s OTHER multi-file case: several files that
are each ALREADY multi-frame stacks in their own right (unlike the per-frame
originals above), meant to be concatenated end-to-end as one continuous
acquisition split across files purely by size — not one file per frame.
Selecting both (Ctrl/Cmd+click **Load movie**) auto-detects this from the
first file's own frame count and loads a combined 3998-frame stack
(1999+1999) via `makeConcatStack()`; **Localize** runs cleanly across the
file boundary (verified: 21,598 localizations from 3998/3998 frames, no
errors). `makeConcatStack()` also rejects a frame-size mismatch across files
(checked against `GATTA-PAINT-80R-raw_cropped.tif` paired with the 150×150
`sequence-as-stack-Beads-AS-Exp.tif` below — throws immediately, `runBtn`
stays disabled, load fails cleanly rather than silently combining
incompatible files). See **in/out** in `CLAUDE.md`/`docs/DOCUMENTATION.md`
for the design.

## Second benchmark dataset — 3D STORM (very large, ~4.9 GB)

3D STORM of spectrin rings in neurons, by **Christophe Leterrier**, on figshare:
[3D STORM spectrin rings in neurons](https://figshare.com/articles/dataset/3D_STORM_spectrin_rings_in_neurons/19165061).

| Property | Value |
|---|---|
| Frames | ~40,000 |
| Frame size | 256 × 256 px |
| Format | large multi-IFD TIFF (Micro-Manager MMStack) — indexed by walking the IFD chain |
| On disk | ~4.9 GB (**never loaded whole — streamed frame-by-frame via `File.slice()`**) |

A good stress test for large-stack handling: webSMLM never loads the file
whole — frames are streamed on demand via `File.slice()` — so this is a
practical check that a multi-GB stack processes without the browser running
out of memory. It's also a real 3D dataset, useful for exercising Phasor 3D
and z-drift correction on something larger than the synthetic generator.

**Camera parameters** (Andor iXon 897 EMCCD, 16 µm physical pixel, 256×256
center quadrant, 160 nm/pixel post-magnification; acquisition settings
confirmed by Christophe Leterrier from the Nikon NIS-Elements panel): **EM
gain = 100**, **e⁻/ADU = 0.1248**, baseline 100 ADU.

**webSMLM settings to match:** Pixel size (nm) = **160**; Camera offset (ADU)
= **100**; Camera gain (photons/ADU) = **0.1248** — used directly, *not*
divided by the EM gain again, since NIS-Elements' "e⁻/ADU" readout already
reflects the current EM gain setting (system gain at a given EM setting =
unity-gain sensitivity ÷ EM gain). Also consistent physically: 0.1248 e⁻/ADU
alone would cap the 16-bit ADC at ~8,000 e⁻, far below this sensor's
~180,000 e⁻ well depth, while ×100 = 12.48 e⁻/ADU is a plausible unity-gain
figure. The iXon 897 has a known QE curve (~92.5% peak at 575 nm,
back-illuminated) that isn't part of the reported settings above, so as with
the EPFL dataset's stated 0.90 e⁻/photon, a QE correction could be layered
on top if wanted — not applied here.

## Third benchmark dataset — 3D astigmatism ground truth (EPFL SMLM 2016 Challenge)

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

## Fourth reference dataset — spectral SMLM (sSMLM) pair-finding

`sSMLM_Fig2_locs.csv` — real localizations from the same lineage as Figure 2A
of Martens, Gobes, Archontakis, Brillas, Zijlstra, Albertazzi & Hohlbein,
*Enabling Spectrally Resolved Single-Molecule Localization Microscopy at
High Emitter Densities*, *Nano Lett.* **22**(21), 8618–8625 (2022),
[10.1021/acs.nanolett.2c03140](https://doi.org/10.1021/acs.nanolett.2c03140).
The full dataset behind the paper — TIFF stacks for Figures 2–4 and
Supplementary Figures 1–2, plus processed CSVs, 19.3 GB total — is on Zenodo:
[10.5281/zenodo.6778964](https://doi.org/10.5281/zenodo.6778964), *"Enabling
spectrally resolved single-molecule localization microscopy at high emitter
densities: Dataset"* (same authors).

**Current copy is PAIRED output** (46 MB, 757,715 rows, `id,frame,x [nm],
y [nm],z [nm],sigma [nm],intensity [photon],offset [photon],bkgstd [photon],
uncertainty [nm]` — note the `z` column), from Localize run across **4
combined, cropped movies loaded together** via the multi-file "combine
several multi-frame TIFFs" path (`loadTiffFilesAuto()`/`makeConcatStack()`,
see **in/out** in `CLAUDE.md`), then **Pair**. 100,000 frames total, z holds
the inter-order distance (~2,994–3,110 nm here), same trick as always. Load
via **Load data**, not **Load movie** — there's no raw stack behind this
copy, only the localizations. Loading it correctly shows `(3D)` and
**Pair** correctly *refuses* it (`⚠ sSMLM pairing needs 2D localizations —
the current result already has real z...`) — this is the guard working as
intended, a real, natural test case for "don't silently re-pair
already-paired data" that's worth keeping around specifically for that,
not a dataset to feed through **Preview pairs**/**Pair** again.

An earlier version of this file (92 MB, 1,710,773 rows, **raw/unpaired**,
31,407 frames, ~54.5 loc/frame, ~24.2 × 12.3 µm FOV) was used to validate
the pairing algorithm itself before this repo had its own multi-movie test
case — kept here for the record, not reproducible from the current file:
direct analysis (sampled ~3,000 frames, all same-frame pairwise
distances/angles, then reproduced live via **Preview pairs**) found a sharp
**distance peak at ~2.5 µm** (median 2536 nm) against the expected smooth
combinatorial background, and a **dominant angle at ~0°/180°** within that
window — the apparent presence on *both* sides turned out to be a
diagnostic dead end, not a real symmetric ±1st-order signal (see
`docs/REFACTOR_PLAN.md`'s sSMLM entry: brightness turned out unreliable for
telling 0th from 1st order; PSF width (σ) gave a real but imperfect signal;
the mechanism that actually worked was purely directional
self-disqualification). The module's own `PARAMS` defaults
(`sSmlmDistMin=2200, sSmlmDistMax=2800, sSmlmAngleTol=5`) were tuned to that
peak, recovering 547,183 pairs (64.0%) there, mean distance 2546 ± 73 nm — a
mean-position sanity check (averaging all 0th-order positions vs. all
matched 1st-order positions, an entirely independent computation from the
per-pair distance stat) reproduced a (2544, 87) nm separation, confirming
the pairs found were self-consistent.

## Fifth reference dataset — `example_stack100.nd2` (ND2 loading investigation)

From Christophe Leterrier's [`cleterrier/DECODE_NC`](https://github.com/cleterrier/DECODE_NC)
repo (NeuroCyto tools for the DECODE SMLM software), placed here to validate
Nikon ND2 loading support — see `docs/REFACTOR_PLAN.md`'s ND2 entry for the
full feasibility research. **Surprising finding**: despite the `.nd2`
extension, this file's actual bytes are a big-endian **ImageJ TIFF** stack
(`MM\x00\x2a` magic, embedded `ImageJ=1.53c\nimages=100\nframes=100...`
description) — independently confirmed by walking its IFD chain byte-by-byte
(exactly 100 well-formed IFDs) and by loading it through webSMLM's existing
TIFF path end to end: 100 frames, 256×256, Localize finds 8,681 real
localizations (92% of 9,421 candidates kept), worker pool engages normally.
Not a genuine native Nikon ND2 binary container — almost certainly a
portability export DECODE_NC's own notebook pipeline produces, just named
`.nd2` in that repo. **Does not unblock real native-ND2 parsing** (still no
sample of the actual proprietary binary format to validate a parser
against), but it did surface and fix a real, general robustness gap: the
file-input's `accept` filter and the multi-file loader
(`loadTiffFilesAuto()`/`loadTiffSequence()`) used to trust the `.tif`/`.tiff`
*extension*; they now sniff the real magic bytes instead (`isTiffFile()`),
so a mislabeled-but-genuinely-TIFF file like this one loads correctly, and
genuinely non-TIFF content (e.g. a real native ND2 binary, or any other
unsupported format) now fails with a clear error instead of silently
producing `NaN`-sized buffers and canvas errors downstream — a real bug that
existed before this file surfaced it, since nothing had exercised that path.
See **in/out** in `CLAUDE.md`/`docs/DOCUMENTATION.md` for the design.

## Sixth reference dataset — `Sample2_L.lactis_..._MMStack_Pos0.ome.tif` (single particle tracking)

`Sample2_L.lactis_10ng-mlNR_1000f_50msft_30%green_greenfilt_1_MMStack_Pos0.ome.tif`
(147 MB) — a real *Lactococcus lactis* sptPALM movie, the test file for the
**spt** (single particle tracking) module (v0.11.2, see `CLAUDE.md`/
`docs/DOCUMENTATION.md`). Verified directly rather than trusted from the
filename: `MM\x00\x2a` magic (big-endian OME-TIFF/MMStack), 256×256,
**1173 frames** — the filename's own "1000f" undercounts the real frame
count by 173, worth knowing if cropping to a round number; 50 ms/frame
(`sptFrameTime = 0.05`) does match the filename's "50msft".

Loads and localizes through webSMLM's existing TIFF/Localize path with no
changes needed. Full-stack run (default `pxnm=100`, `method=gaussmle`):
74,011 localizations → **spt Track** finds 21,578 tracks, 13,645 with
`sptTrackLenMin=2` (default) qualify for a D estimate — mean D = 0.321
µm²/s, median D = 0.186 µm²/s (consistent with a 100-frame-subset run: mean
0.311, median 0.182), both physically plausible for bacterial cytoplasmic
protein diffusion. 1,217 of the full run's tracks came out with a
non-positive D (a real, expected artifact of the localization-error
correction for near-immobile tracks, not a bug — see **spt** in
`CLAUDE.md`).

## Seventh & eighth reference datasets — genuine native ND2 binaries

`2026-07-13_BHK21_EphB2_mEos4_substack_0-100.nd2` (13.9 MB, 100 frames) and
`2026-07-13_BHK21_EphB2_mEos4_substack_0-500.nd2` (68.0 MB, 500 frames) —
real STORM/PALM acquisitions (mEos4, BHK21 cells, EphB2), placed to unblock
Nikon ND2 loading (see `docs/REFACTOR_PLAN.md`'s ND2 entry). Unlike the
earlier `example_stack100.nd2` (which turned out to be a mislabeled TIFF),
these are confirmed **genuine native ND2 binaries**: `file(1)` reports
"data" (unrecognized), magic `0x0ABECEDA` at offset 0, the literal
`"ND2 FILE SIGNATURE CHUNK NAME01!Ver3.0"` string at offset 0x10.

The chunk container format was reverse-engineered directly from these two
files (cross-validated against each other, byte-identical structure except
frame count) — see `docs/REFACTOR_PLAN.md` for the full chunk-header/
`ImageAttributesLV!` decode. Confirmed: 256×256, 16-bit storage (14-bit
significant), single channel, frame count recoverable three independent
ways (counting `ImageDataSeq` chunks, the `uiSequenceCount` metadata field,
and the filename itself — all agree: 100 and 500 respectively). Real pixel
payload bytes read as plausible uncompressed camera data, no decompression
applied. No webSMLM parser code exists yet — this was read-only structure
reconnaissance (Python, offline).

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
