# webSMLM — Roadmap

Forward-looking notes only: things worth remembering and testing later, not a
history. Shipped features — and the implementation detail behind them — live
in [`../CHANGELOG.md`](../CHANGELOG.md); this file doesn't duplicate it.

## Next

- **Plot panel UI polish (2026-08-18, builds d–h)**, prompted by user feedback
  after the spt refinement round above. Shipped: (1) plots letterbox a fixed
  4/3 sub-rectangle CENTRED WITHIN the panel's own box (`setupPlot(cv,true)`)
  rather than changing the panel's own size — an earlier version within this
  same round instead gave `.is-plot` canvases their own `aspect-ratio:4/3`
  CSS, which fixed axis stretching but (combined with CSS Grid stretching
  both cards in a row to match whichever sibling was taller) made a panel's
  height depend on whatever the OTHER panel happened to be showing —
  switching one panel between a frame and a plot could resize BOTH panels,
  which read as visually unstable; a same-day follow-up report ("keep it
  squared... otherwise the window sizes change all the time") is what
  prompted the letterbox redesign — see **render** in `CLAUDE.md` for the
  full mechanism, including how `registerPlotHover()` absorbs the
  letterbox offset so no individual plot function needed to change.
  (2) Plots render dark on screen (`plotColors()`, matching the app's own
  permanently-dark chrome — there's no separate app light/dark theme to
  hook into) but light for export (`exportPanel()` flips `_plotExportMode`,
  redraws once via the panel's `_replotRaw`/`_replotSr`, snapshots, redraws
  back). (3) A **Stack panels**/**Side by side** button (`layoutToggleBtn`)
  replaces the previous "code always decides" behaviour: `layoutOverride`
  takes precedence over the `h/w<0.5` auto-heuristic once clicked, and
  sticks across further loads this session — lives on the right of the
  **Log** card's own title bar (`clearLogBtn`/`exportLogBtn` grouped on the
  left of that same bar), not a dedicated row above the canvases (an
  earlier version's `.canvases-toolbar`, removed after same-day feedback
  that it read as wasted vertical space for one small button). (4) PCFO's
  noise-variance axis (commonly hundreds of thousands, ADU²) had tick
  labels visually colliding with its own rotated axis-name text — fixed via
  a new shared `axisScale()` helper (scientific notation, single leading
  digit + one decimal, `×10ⁿ` drawn once near the axis) rather than
  engineering notation's multiple-of-3 rounding, which was tried first and
  rejected for still leaving 3-digit ticks on this specific range.
  Deliberately deferred: no UI to reset `layoutOverride` back to `null`
  (auto) once set — not clearly needed yet (a second click always gets you
  the other state, which for a 2-state toggle is the same thing unless a
  THIRD future layout mode gets added, at which point revisit).

  Same-day user report, resolved as a non-issue: the sidebar's 📌 "dock the
  floating panel back" button (`#sidePin`) reportedly rendered invisible in
  floating mode. Confirmed via `git show` that this button/emoji predates
  this entire session and could not be reproduced in headless Chromium;
  user confirmed afterward it was their own observation error, not a real
  bug — no code change was needed or made.

  (5, build h) The letterbox redesign in (1) introduced its OWN alignment
  bug, caught from a live drift-correction screenshot on the real full
  lactis dataset: `.panel-body` centred each panel's canvas+trailing-
  controls group independently, but since raw/sr canvases are now always
  exactly the same height, that centring shifted the two canvases out of
  vertical alignment with each other by roughly half of whichever trailing
  control only ONE panel has at a given moment (raw's `#scrubRow`, no sr
  equivalent when `#srFilterNote`/`#calViewRow` are both hidden) — measured
  as an exact 14px offset in one repro, confirmed by DOM geometry before and
  after the fix. `.panel-body` is top-aligned now (flex's own default,
  `justify-content:center` removed) instead — see **render** in
  `CLAUDE.md`.

- **File-size/modularity strategy for `webSMLM.html`** (discussed 2026-08-17,
  prompted by two large candidate modules — single-particle tracking (SPT)
  and single-molecule FRET (smFRET) — that would each add a few thousand
  lines). GitHub Pages can technically serve sibling files that `webSMLM.html`
  loads at runtime (`fetch()`/dynamic `import()`), but `file://` (the
  double-click-to-run path the whole single-file design exists for) blocks
  that under CORS in Chromium, inconsistently across browsers — splitting
  the *core* app this way would break the "download and it just works"
  promise unevenly, so it's ruled out. Three options were weighed:
  1. **Lean harder on the existing `MODULE:` banner convention** — cheapest,
     doesn't slow the file's growth, but the size problem is about
     editability (human and AI-assisted), not runtime performance (browsers
     don't care about a multi-MB JS file). **Chosen for now.** Landed in
     v0.11.1: a top-of-file **MODULE INDEX** comment block giving each
     module's current line number, refreshed alongside every build-letter
     bump (see `CLAUDE.md`'s Branch & release workflow) rather than left to
     rot — cheap enough to check every round that it should actually stay
     trustworthy, unlike a one-off comment.
  2. **Dev-time-only source split, single-file at ship time**: a `tools/`-tier
     build script (Node, no runtime dependency, matching the existing
     `tools/` precedent of separate optional tooling) concatenates
     `src/*.js` fragments into the final `webSMLM.html`. Solves editability
     without touching the deployed artifact or the `file://` promise at
     all. **Planned next step once SPT/smFRET actually start landing and
     option 1 stops being enough** — not implemented yet. Real cost: it
     makes `webSMLM.html` a build product rather than the literal source of
     truth, a bigger philosophy shift than option 1, worth doing only when
     actually needed rather than pre-emptively.
  3. **Split SPT/smFRET out as their own single-file sibling apps**
     (`webSPT.html`, `webFRET.html`), mirroring the existing
     `docs/layout_bare.html` precedent ("backed up from webSMLM's chrome for
     future single-file projects"). **Considered and set aside**: SPT and
     smFRET would share too much of webSMLM's own pipeline (TIFF loading,
     worker pool, table/render/export) to cleanly separate, and some real
     analyses combine the two techniques directly — per the user, e.g.
     Fontana, Fijen, Lemay, Mathwig & Hohlbein, *High-throughput,
     non-equilibrium studies of single biomolecules using glass-made
     nanofluidic devices*, *Lab Chip* (2018),
     [10.1039/C8LC01175C](https://doi.org/10.1039/C8LC01175C) — splitting up
     front would fight that overlap rather than accommodate it. Revisit only
     if a module turns out to need almost nothing from the shared pipeline.

  **Physical reorder — done in v0.11.1.** The file's physical `MODULE:`
  order had one mismatch against `CLAUDE.md`'s documented order: **export**
  physically sat before **workers**, the reverse of the doc — a leftover of
  modules being retrofitted onto code that predates them, not a deliberate
  choice. Fixed as its own dedicated pass (not bundled into an unrelated
  edit): confirmed first that neither section has top-level `const`/`let`
  state the other reads, nor any `addEventListener` wiring in either range
  (both are pure function/data declarations, hoisted regardless of position,
  so a physical move is a behavioral no-op in JS) — then moved the block and
  re-verified with the syntax check, a direct call to the moved
  `buildCsvText()`, constructing a real `Worker` from the moved
  `workerSource()` (would throw a `ReferenceError` immediately if
  `WORKER_PRELUDE` had gone stale), and a full Localize run with
  `paramOverrides` forcing worker dispatch (`↑ 8 workers · 82% utilisation`,
  correct localization count) to exercise the pool path for real, not just
  its single-threaded fallback. File's physical order now matches
  `CLAUDE.md`'s documented list end to end.

- **Nikon ND2 loading — feasibility researched 2026-08-17; real chunk format
  reverse-engineered from a genuine sample 2026-08-18, ready to build.**
  Requested by a new user. ND2 has **no official public
  specification** — every existing reader (Bio-Formats, both `nd2reader`
  packages) is reverse-engineered, and there are two genuinely different
  format variants:
  - **Legacy**: image data is **JPEG2000-compressed**. Not worth attempting
    — no lightweight JS JPEG2000 decoder exists comparable to what `pako`
    already does for deflate; a real decoder would be a large, complex
    addition disproportionate to likely benefit. Detect and reject with a
    clear error rather than half-support it.
  - **Modern** (NIS-Elements 4.0+, chunk-based container, file signature
    literally `"ND2 FILE SIGNATURE CHUNK NAME01!Ver3.0"`): image data is
    **uncompressed or Zip/deflate-compressed** — the tractable case, since
    `pako` is already inlined for exactly that compression. A loader would
    reimplement the chunk-map container parsing (analogous in spirit to how
    **in/out** already walks TIFF's multi-IFD chain) and plug into the
    existing `getFrame()/getFrames()` stack abstraction, so nothing
    downstream (detect/fit/FTM/etc.) needs to know the source format.
  - **License landscape matters here**: Bio-Formats' ND2 reader and both
    `nd2reader` packages are GPLv3+/GPL — not safe to port code from into
    this CC-BY project (same reasoning that already keeps this codebase
    MIT-only for `pako`/UTIF). [`tlambert03/nd2`](https://github.com/tlambert03/nd2)
    is **BSD-3-Clause**, pure Python, no Nikon SDK dependency for the modern
    format — the one safe reference to port chunk-parsing logic from, with
    attribution in the head banner matching the `pako`/UTIF precedent. No
    existing JS/WASM ND2 reader was found anywhere (the one "web ND2
    viewer" that exists, `miuraTakashi/ND2-Viewer`, is a Flask server
    calling `tlambert03/nd2` in Python — nothing runs client-side).
  - **Real blocker**: no spec means real risk of subtly-wrong metadata
    (frame dimensions, bit depth, pixel calibration) with no way to
    validate short of a real file — there's no ground truth to check
    against otherwise. **Waiting on a real modern-variant ND2 sample**
    (from the requesting user or the lab's own scopes) before writing any
    parser code, the same "get a real reference dataset first" approach
    used for the sSMLM CSV and the other `experimental_data/` fixtures.
  - **Picasso** (jungmannlab, already used elsewhere in this codebase for
    AIM drift correction and the Gaussian MLE fitters) confirmed to lean on
    the same reference: its `ND2Movie`/`load_nd2()` in `picasso/io.py` is a
    thin Dask-based wrapper — `import nd2; nd2.ND2File(path)` — around
    exactly `tlambert03/nd2`, not a separate from-scratch parser. Independent
    confirmation that library is the standard, actively-used choice in the
    SMLM-tooling community, not just the one this project happened to find.
  - **A first real sample landed 2026-08-17** — `experimental_data/
    example_stack100.nd2`, from Christophe Leterrier's `DECODE_NC` repo —
    but turned out to be a big-endian **ImageJ TIFF** underneath (`MM\x00\x2a`
    magic, `images=100\nframes=100` description), not a genuine native ND2
    binary; confirmed by walking its IFD chain directly and by loading it
    end-to-end through the existing TIFF path (100 frames, 256×256, 8,681
    real localizations). **Still doesn't unblock the actual parser work** —
    the real blocker (a genuine proprietary-format sample) is unchanged —
    but it did surface and fix a real, separate robustness gap, landed the
    same day: the file-input `accept` filter and `loadTiffFilesAuto()`/
    `loadTiffSequence()` used to trust the `.tif`/`.tiff` *extension*; they
    now sniff the real magic bytes (`isTiffFile()`), and `loadTiff()`/
    `loadTiffFile()`/`loadTiffSequence()`'s `decodeOne()` all validate the
    raw ImageWidth/ImageLength tags (`t256`/`t257` — UTIF only sets the
    convenience `.width`/`.height` properties as a side effect of
    `decodeImage()`, so checking those before calling it silently checked
    `undefined>0` and broke every file, a regression caught immediately by
    testing against this real sample) before trusting a decode, so
    genuinely unparseable content (a real native ND2 binary, or anything
    else) now fails with a clear error instead of `NaN`-sized buffers and
    canvas errors propagating downstream. See **in/out** in `CLAUDE.md`.
  - **Two genuine native ND2 binaries landed 2026-08-18** —
    `experimental_data/2026-07-13_BHK21_EphB2_mEos4_substack_0-{100,500}.nd2`
    (real STORM/PALM acquisitions, mEos4, confirmed by direct byte
    inspection: `file(1)` reports "data", magic `0x0ABECEDA` at offset 0,
    the literal `"ND2 FILE SIGNATURE CHUNK NAME01!Ver3.0"` string at offset
    0x10 — the real thing this time, not another TIFF-in-disguise). The
    chunk container format was reverse-engineered directly from these two
    files (cross-validated against each other — byte-identical structure
    except `uiSequenceCount`, see below), not guessed or copied from any
    GPL source:
    - **Chunk header** (16 bytes, all little-endian): magic `u32`
      (`0x0ABECEDA`, constant across every chunk) + `dataOffset` `u32`
      (bytes from chunk start to where the payload begins) + `dataLen` `u32`
      (payload byte length) + 4 reserved/zero bytes. A null/`!`-terminated
      ASCII chunk name follows immediately at chunk-start+16 (e.g.
      `"ImageDataSeq|42!"`), then padding, then the payload starts at
      chunk-start+`dataOffset`. Each chunk (header+name+payload) is padded
      up to the next 4096-byte boundary before the next chunk begins —
      confirmed exactly: `dataOffset+dataLen` rounded up to the next 4096
      multiple equals the measured stride between consecutive
      `ImageDataSeq` chunks in both files, every time.
    - **Frame count** = a plain count of `"ImageDataSeq|N!"` chunks — 100
      and 500 respectively, exactly matching each file's own filename
      (`substack_0-100`/`substack_0-500`) and independently matching the
      `uiSequenceCount` metadata field below. Three independent signals
      agreeing is strong confidence this part is right.
    - **`ImageAttributesLV!`** (found right before the trailing chunk map)
      holds the real declarative metadata — width/height/bit depth/frame
      count — encoded in Nikon's own binary key-value format (unofficial
      name "LV", likely "Labeled Value"): a container record
      (`SLxImageAttributes`, type `0x0b`) holds N child fields, each
      `[type: u8][nameLen: u8, INCLUDES a trailing null][name: UTF-16LE,
      nameLen×2 bytes][value: type-dependent width]`. Decoded by hand
      against real bytes (not assumed): `uiWidth`=256, `uiWidthBytes`=512
      (256×2, confirming 16-bit storage independent of the next field),
      `uiHeight`=256, `uiComp`=1 (single channel), `uiBpcInMemory`=16,
      `uiBpcSignificant`=14 (14-bit ADC stored in 16-bit words — a
      completely ordinary sCMOS/EMCCD figure), `uiSequenceCount`=100 (file
      1) / 500 (file 2) — matching the independently-counted frame count
      exactly in both files. Only the scalar-field shape is decoded so far,
      not the full recursive container grammar (nested `SLx*` structs still
      unexplored) — enough to read dimensions/frame count, not yet a
      general-purpose metadata parser.
    - **Compression**: `eCompression`=2 present in the same chunk (meaning
      not yet independently verified — no confirmed enum mapping found from
      an authoritative source), but a direct check of real
      `ImageDataSeq|0!` payload bytes as raw uint16 values produced a
      completely plausible camera frame (background ~100–140 ADU, a bright
      region up to 20,211) with NO decompression applied at all — real
      compressed/entropy-coded data would not look like that. Working
      hypothesis, not yet a certainty: this real-world sample's pixel data
      is stored **fully uncompressed**, simpler than the "uncompressed or
      deflate" case the original feasibility research anticipated — `pako`
      may not even be needed for files like these two.
    - **`ND2 FILEMAP SIGNATURE NAME 0001!`** confirmed as the last chunk in
      both files — the trailing chunk-map/index existence predicted by the
      original research is real; not yet decoded (a real parser would
      prefer reading this index over a full linear magic-byte scan, which
      is what this investigation used and which does not scale well to
      much larger files).
    - **Not yet done**: an actual parser wired into **in/out**'s
      `getFrame()/getFrames()` stack abstraction — this was header/structure
      reconnaissance (Python, offline, read-only), no webSMLM code written.
      Next real step when picked back up: a minimal JS reader — walk the
      file for the chunk map (or fall back to linear scan), read
      `ImageAttributesLV!` for width/height/frame count, expose
      `ImageDataSeq|N!` payloads as typed-array frames — same shape as
      `loadTiffFile()`'s return value so nothing downstream needs to know
      the source format.

- **FTM (fast temporal median filter) — still open.** Shipped in 0.10.1;
  see `CHANGELOG.md` for what landed and `CLAUDE.md`'s **in/out** module
  note for the current design. Remaining:
  - Scrub-preview speed at large frame sizes (measured, 8 workers: ~23 ms
    at 128×128 up to ~510 ms at 1024×1024 per scrubbed frame — fine
    smaller, laggy for rapid dragging on large ones). A finer row-band
    split, or reusing detect/fit's frame-batch workers differently, are
    options if this needs to get faster.
  - The worker-parallel Localize path only reports progress at chunk
    boundaries (no intra-chunk granularity, unlike the serial path) — would
    need a new worker message type (periodic progress pings ahead of the
    final result) to smooth out, not attempted yet since the barrier
    structure already makes that a bit delicate (see CLAUDE.md's Web
    Worker gotcha).
  - `fitFirstFrame`/`fitLastFrame` (the analysis frame range) stays a
    *separate* range from FTM2's own independent Start/End (which frames
    the filter itself runs over, not which ones get localized afterward)
    — no UI for the latter yet.
  - A real (not synthetic) per-candidate MLE fit-time regression was
    reported on GATTA-PAINT data with FTM on (~160→270 µs/candidate) that
    a synthetic A/B test couldn't reproduce (µs/candidate came back
    ~unchanged there) — likely the Newton solver needing more iterations
    to converge on real corrected-background statistics, but not yet
    confirmed against real data.

- **Spectrally resolved SMLM (sSMLM) — follow-ups beyond the Phase 1 "Spectral
  SMLM analysis" module** (2-point 0th/1st-order pairing, shipped v0.11.0 —
  see `CLAUDE.md`/`docs/DOCUMENTATION.md`'s **sSMLM** module entry for the
  design; from Martens, Gobes, Archontakis, Brillas, Zijlstra, Albertazzi &
  Hohlbein, *Nano Lett.* 22(21), 8618–8625 (2022),
  [10.1021/acs.nanolett.2c03140](https://doi.org/10.1021/acs.nanolett.2c03140),
  ported from [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer)).
  Role assignment (which point of a candidate pair is 0th vs 1st order) went
  through several real-data-driven revisions before landing on its current,
  purely directional design — worth remembering if revisiting this area:
  brightness looked plausible (the paper's own physical model) but measured
  at ≈50/50 correlation with position even at confident intensity gaps
  (likely PSF-overlap/crowding corrupting photon estimates at this emitter
  density); a hypothesized symmetric ±1st-order signal was also ruled out
  (the "opposite-side" population's intensity-ratio profile was statistically
  indistinguishable from the real side, inconsistent with a genuinely weaker
  physical order); PSF width (σ) showed a real but imperfect correlation
  (~65–70%, stronger with a clearer σ gap) — consistent with the 1st order's
  spectral smearing — and is now available as an optional, default-off
  confidence filter (`sSmlmRequireNarrower`) rather than a requirement.
  What actually worked was a purely geometric, brightness-free rule: a point
  qualifies as 0th order only if it has a candidate on the configured
  (now fully directional, signed) bearing AND no candidate on the opposite
  bearing — self-disqualifying, no external reference signal needed —
  verified on the real reference dataset to recover *more* pairs than the
  old brightness-gated approach (64.0% vs 59.0%), with only ~5% of points
  landing in the genuinely ambiguous "candidate on both sides" bucket it
  correctly excludes. Remaining, not yet implemented:
  - **Multi-order chaining** (0-1-2-3+, matching `sSMLMAnalyzer`'s
    `sSMLMA.java` full feature set) — true higher orders (2nd, 3rd — same
    side as 1st, further out) are a distinct question from the ±1st-order
    symmetry just confirmed above; nothing examined so far demonstrates a
    genuine 2nd-order signal at a *different* distance from the 1st-order
    band, so that part still needs its own dataset/validation, not just the
    algorithm.
  - **FFT-based automatic angle/distance detection**, matching
    `sSMLMAnalyzer`'s `AngleAnalyzer.java` (render localizations to an
    image, 2D-FFT it, find the dominant periodic peak — not a drop-in for
    webSMLM's own inline FFT, which is a 1D radix-2 transform for FRC, not a
    2D image FFT + peak-finding routine). Phase 1's **Preview pairs**
    distance/angle histograms cover the same "find my window" need more
    simply for now.
  - A minimum-neighbour-count spatial consistency filter (reject sparse
    false pairs with too few nearby confirmed pairs) — `sSMLMAnalyzer` has
    one, Phase 1 doesn't.

  **Headless exposure — shipped v0.11.1 (2026-08-17)**, alongside a data-model
  fix it depended on. Checking headless status surfaced a real, live bug: pairing
  stored the inter-order distance IN `z` (aliasing/overwriting it), and
  `driftCore`'s "Correct z too (3D)" gate keyed off the same `has3d` check the
  colour-by-depth toggle used — so a paired result would show that option, and
  ticking it would silently 1-D-"correct" the spectral distance as if it were
  spatial drift, corrupting it. Fixed at the root rather than patched: `dist` is
  now its own field, `z` is never touched by `pairCore()` at all — which also
  unblocks a future 3D-fit + sSMLM combination (a loc could carry real depth AND
  spectral distance simultaneously without one clobbering the other), the
  original reason this was raised rather than just adding a driftZ guard.
  `renderSuperRes()`/`zRange()` gained a `colorField` parameter (`'z'` or
  `'dist'`) so the one depth-coded render path serves both without duplication;
  `rerender()`/`analyze()` derive it from `hasZ`/`hasDist`. `pairCore()` itself
  now throws on bad input (real 3D `z`, or already-paired `dist`) rather than
  only the interactive wrapper checking — the second guard is new, needed
  because with `z` no longer touched, re-pairing an already-paired result could
  no longer be caught as a side effect of the old z-guard. `config.sSmlmPair`
  (headless), `--sSmlmPair` (CLI), `sSmlmPair=1` (autorun) all wire to the same
  `pairCore()` call, run right after Localize, before drift/NeNA/FRC. See
  **sSMLM** in `CLAUDE.md` for the full design; verified with direct `pairCore()`
  guard tests, a real button-click UI round-trip (Localize → Pair → confirm
  `driftZRow` stays hidden → Show standard/spectral toggle → Unpair), and a
  headless `analyze({sSmlmPair:true, ...})` call, all via Playwright.

- **Single particle tracking (spt) — follow-ups beyond v0.11.2.** Shipped:
  frame-to-frame linking (`linkTracks()`, Hungarian-optimal assignment per
  connected component, `sptMemory`-gated gap-bridging) and per-track
  diffusion coefficients (`trackDiffusionCoeffs()`, ported from
  `diff_coeffs_per_track()` in the user's own `sptPALM-Python` pipeline) —
  see **spt** in `CLAUDE.md` for the full design; verified against
  synthetic straight-line/crossing/gap-bridging cases AND the real bundled
  L. lactis dataset (both a 100-frame subset and the full 1173-frame movie).
  **2026-08-18 refinement round**, prompted by the user testing the real
  dataset and spotting an artificial-looking peak at D≈10⁻³ µm²/s: fixed
  `drawSptDHist()` to EXCLUDE non-positive D from the plotted histogram
  (logging the excluded count) instead of clamping every such track into
  one bin — the clamp was the actual cause of the fake peak, pooling
  unrelated near-immobile/short tracks into a single artificial spike; also
  dropped `sptTrackLenMax`/truncation entirely (every qualifying track's
  MSD now uses ALL of its own steps, not a capped prefix — the truncation's
  only purpose, equal per-track weighting for a length-resolved histogram,
  doesn't apply yet), raised `sptTrackLenMin`'s default 2→5 per user
  guidance, and added a **Show length hist.** button
  (`drawSptTrackLenHist()`) — a log-Y-axis histogram of every linked
  track's length, the intended way to judge whether **SPT min track
  length** is set sensibly. The log-Y support is generic:
  `computeHist()`/`drawHistogram()` (table module) gained an optional 5th
  `logY` parameter, reusable by any future histogram that needs one.
  `experimental_data/README.md`'s lactis entry was re-run and updated under
  the new algorithm (74,011 localizations, 21,578 tracks unchanged — linking
  itself didn't move — 5,175 tracks with `sptTrackLenMin=5` qualify for a D
  estimate, mean D 0.325 µm²/s, only 82 non-positive-D tracks now excluded
  rather than clamped).

  **2026-08-18, same-day second round**, more real-data feedback: added
  `sptDPlotMin`/`Max` (µm²/s, defaults from the reference pipeline's own
  histogram range) — a display-only axis window on the D histogram, tracks
  outside it excluded from the PLOT only, never from `meanD`/`medianD`.
  Added `recomputeSptD()`: since D = (MSD/4 − locErrorUm²)/frametime is
  exactly linear in 1/frametime and MSD itself doesn't depend on
  frametime/locError, `trackDiffusionCoeffs()` now also returns a
  `trackMSD` Map (cached per track, µm², spatial only) so editing **Frame
  time** or **Localization error** after **Track** rescales every D live —
  in `lastSpt`, the table/CSV (`lastResult.locs`' own `D_coeff`), and the D
  histogram if shown — with no re-linking. Added an exponential lifetime
  fit (`fitTrackLifetime()`, count(L) ~ A·exp(−L/τ)) overlaid on the
  track-length histogram, fit by weighted least-squares on ln(count) vs bin
  centre (weight = the bin's own count — an UNWEIGHTED version shipped
  first and was corrected same-day after a real rendered histogram showed
  the fit line sitting nearly an order of magnitude below the first,
  highest-count bar: bin counts are Poisson, so Var(ln(count)) ~ 1/count,
  and an unweighted fit gives noisy low-count tail bins the same say as the
  much more reliable high-count peak); τ logged/shown in both locs and
  seconds. This needed a small
  generic extension to the shared histogram plot: `computeHist()`/
  `drawHistogram()` (table module) now support an optional
  `histData.curve`/`curveLabel`, set by the caller AFTER `computeHist()`
  returns (a fit needs the already-binned data to fit against, unlike
  `markers`, which are known ahead of binning) — see **table** in
  `CLAUDE.md`. Also fixed a layout complaint: histograms/line plots drawn on
  the raw/SR canvases used to inherit `--frame-ar` (the loaded movie's own
  aspect ratio), so an unusually wide/narrow movie stretched every plot's
  axes into an unreadable shape; `setupPlot(cv, isPlot)` now applies a fixed
  `aspect-ratio:4/3` via a new `.is-plot` CSS class for every plot-drawing
  function (frame/reconstruction drawers keep the movie's own ratio) — 4/3
  matches matplotlib's own default figure size (6.4×4.8in), which is also
  close to what the `sptPALM-Python` reference scripts use for their own
  standalone histogram figures (`plt.figure(figsize=(4,5))` in
  `plot_diff_histograms_tracklength_resolved.py` — narrower, since that
  script's multi-panel figures use several different ratios with no single
  consistent convention; 4/3 was chosen for on-screen readability, not
  fidelity to one specific reference figure size). Deliberately deferred, not forgotten:
  - **Headless (`window.webSMLM.analyze()`/CLI) exposure** — same
    "interactive first, headless once it's seen real use" precedent sSMLM's
    own headless exposure followed a full version cycle after Phase 1.
  - **Length-resolved D histogram** (the reference pipeline's
    `D_track_length_matrix`, one histogram per track length rather than one
    pooled histogram) and **colour-reconstruction-by-D/by-track** (the
    render module's `colorField` mechanism sSMLM's `dist` already uses
    could extend to `D_coeff`, but D is track-level not per-loc the way z/
    dist are, so this needs its own design, not a drop-in).
  - **Real `10^x`-formatted tick labels** for the D histogram's log10(D)
    x-axis — v1 ships literal log10 numbers (a deliberate, documented v1
    shortcut, reusing `computeHist()`/`drawHistogram()` completely
    unchanged) rather than a genuinely log-scale-aware axis.
  - **No cell-segmentation-aware tracking** (the reference pipeline's
    `use_segmentations` branch, tracking per-bacterium rather than across
    the whole field of view) — webSMLM has no concept of cell masks;
    revisit only if a real use case needs per-cell track isolation rather
    than whole-FOV linking.
  - **Large-subnetwork exact assignment.** `linkTracks()`'s connected
    components above `HUNGARIAN_MAX` (120 points) fall back to greedy
    nearest-neighbor rather than trackpy's own recursive exact-subnetwork
    solver — real single-molecule (PALM-style, sparse) SPT data isn't
    expected to produce components that large, but a genuinely crowded
    dataset could exercise this fallback; no reports of it mattering yet.

- **`tempClusteringMemory` — gap-frame tolerance for temporal clustering.**
  `clusterEvents()` (table module) currently requires strictly consecutive
  frame numbers to chain detections into one event (memory=0, hardcoded) —
  a molecule that blinks off for even one frame and back on starts a new
  chain instead of extending the old one. `tempClusteringMemory = N` would
  allow up to N missed frames between detections of the same chain. Needs a
  decision on how a gap should weight into the position average (does a
  skipped frame count as "still on" for the photon-weighted mean, or purely
  bridge the chain without contributing) before implementing.
- **Reconsider the detect/fit/export/table module split.** These
  four already share parameters and data in ways that make the boundary feel
  arbitrary in places — e.g. `PARAMS.gain`/`camoffset` sit under a `----
  export` comment header (`webSMLM.html`) even though the conversion now
  happens inside `fit`, and `table` reads the same already-converted
  `photons`/`bg`/`bgstd` that `export` does. Merging any two of them "because
  they're interwoven" risks snowballing (detect/fit are just as interwoven
  with each other and stay split, so that alone isn't a sufficient
  criterion) — needs an actual principle for where the lines go (kind of
  work vs. data flow) before touching it, not just an ad-hoc merge. At
  minimum, retitle the stale `---- export` `PARAMS` comment to `fit` once
  this is looked at.
- **Let a settings JSON override a parameter's `min`/`max`/`step`,
  not just its value.** Today Save/Load Settings only round-trips
  `{id: value}` pairs (see `$('saveSetBtn')`/`$('setFile')`) — the bounds
  themselves live solely in the hardcoded `PARAMS` registry in
  `webSMLM.html` and can't be changed without editing the file. Letting a
  loaded JSON optionally carry `{id: {value, min, max, step}}` and apply the
  bounds to both the in-memory `PARAMS[id]` entry and the DOM control's
  `min`/`max`/`step` attributes (reusing `syncParamControls()`'s write path)
  would let someone with unusual data (e.g. a camera gain far outside
  today's 0.001–1000 range, or a much larger pixel size) relax a boundary
  for their own use without touching the source. Needs a decision on
  whether `saveSetBtn` should also emit bounds by default (so a saved file
  is a full self-describing spec) or only on request (keeping normal saves
  small/value-only).
- **Let Load Settings introduce whole new modules, not just
  parameter values.** Today a loaded JSON can only set values for
  parameters the registry already knows about (`PARAMS[id]` must exist —
  see `logParamValues`/`$('setFile')` handler). A further step would let a
  loaded file *extend* the registry itself — e.g. ship a new detection
  filter or fit method's parameters (and, harder, its code) bundled with a
  settings file, so a new module can be dropped in and used without a
  webSMLM.html edit. Needs real design (where does the new module's *code*
  come from in a single-file, no-build app? a `Function`-constructor'd
  snippet embedded in the JSON? a second file?) — flagged here as a
  direction, not scoped yet.
- **Regression test suite via `analyze()`**: fixed-seed synthetic stack →
  assert localization count and RMS error within bounds. There is currently
  no automated test suite at all; this would be the first one, and it falls
  out of the v0.10.0 headless pipeline API (`docs/DOCUMENTATION.md` §8) for
  free.
- **Extend the synthetic generator** to also emit known z and known drift
  (ground truth), so 3D/drift/precision work can be validated
  quantitatively through the regression check above rather than by eye.
- Cross-validate **MLE 3D vs Phasor 3D** on real bead data — only checked
  against synthetic ground truth and mutual self-consistency so far.
- **3D detection beyond astigmatism** — Double Helix, Biplane, etc. could be
  added later as additional methods in the `3D calibration` module, alongside
  today's astigmatic σ_x/σ_y-vs-z approach.
- Cross-validate **NeNA and FRC** against established tools (ThunderSTORM,
  Picasso, FRCbar) — both still ship marked experimental.
- **3D FSC** (Fourier Shell Correlation) — the spherical-shell counterpart to
  2D FRC, once the 3D voxel-grid memory cost is bounded.
- **Multi-emitter fitting** for dense/overlapping PSFs. Single-emitter
  fitting biases positions where PSFs overlap, and a faster single-emitter
  fit can't fix that — a better initial guess doesn't help when there's no
  good single-emitter optimum to find in the first place (see the rejected
  phasor-seeding idea in the v0.3.0 changelog entry, which ran into exactly
  this).
- **Robust detection threshold.** `mean + k·σ_noise` is computed over the
  whole filtered frame including signal, so at high blink density the
  threshold rises and dim localizations get silently dropped — detection
  sensitivity is density-dependent. Consider MAD or a low percentile of the
  filtered image instead. Also: threshold statistics currently include
  border pixels that are never searched for maxima; and plateau handling
  needs a look — the local-maximum test uses strict `>`, so two equal
  adjacent pixels can both survive as separate localizations from one
  emitter.
- **σ_PSF estimation from the data**, instead of a fixed, user-supplied
  value.
- **Photon calibration beyond a single scalar gain/offset.** Single-image
  gain/offset estimation from the data itself (PCFO, a photon-transfer-curve
  variant — tile-wise mean-signal-vs-noise-variance regression, not a
  variance-vs-mean-across-frames curve) shipped in 0.10.2 — see
  `CHANGELOG.md`. A scalar still reasonably approximates an EMCCD chip, but
  most current SMLM runs on sCMOS, where gain, offset and read noise are all
  pixel-dependent (and non-uniform read noise also affects detection — a
  noisy pixel can masquerade as an emitter); still open: **per-pixel**
  gain/offset/variance calibration maps, with a noise model that uses them —
  see Huang et al., *Nat. Methods* **10**, 653–658 (2013),
  https://doi.org/10.1038/nmeth.2488.
- Optional **fiducial-based drift correction** when beads are present
  (simpler and more accurate than AIM for that specific case).
- **3D point-cloud view** — an interactive, rotatable scatter (orthographic
  projection, colour = z) as an alternative to the depth-coded 2D
  reconstruction, where localizations at different z that overlap in x/y
  currently blend together.
- Localizations-table filter grammar: parentheses/grouping; filtering
  presets.
- **Consider deprecating Phasor 2D/3D** in a future release. MLE 2D/3D are
  now the default and statistically superior (Poisson-optimal, reports a
  real CRLB uncertainty), and the worker pool has closed most of phasor's
  historical speed advantage for typical stacks. Phasor's own code is a
  modest ~200–250 lines out of ~6,400 (fit function, its distinct
  magnitude-ratio 3D calibration model, UI, worker/export wiring) — not
  huge, but removing it would simplify the calibration module down to one
  3D model instead of two co-existing ones that currently need guarding
  against each other. Weigh against phasor's one remaining real edge: it's
  still by far the fastest fitter, which could matter for extremely
  high-throughput or huge stacks where MLE's iterative cost adds up.
