# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

webSMLM is a **single-file** browser tool for single-molecule localization microscopy (SMLM):
the entire application — HTML, CSS, all JavaScript, and the two bundled decoders (pako, UTIF) —
lives in `webSMLM.html` (growing past 10400 lines; the file's own top-of-file **MODULE INDEX**
comment gives current per-module line numbers — re-`grep -n "MODULE:"` if it looks stale, and
refresh it alongside a build-letter bump when a change has moved things by more than a few
lines). It loads a raw TIFF stack, detects/localizes emitters, and renders a super-resolution
image, **entirely client-side** (no upload, no server, no network calls at runtime). `index.html`
is just a redirect to `webSMLM.html` for the bare Pages URL.

`webSMLM.html` itself has **no build system, no package.json, no dependency install, and no test
runner.** "Running" the app = opening `webSMLM.html` in a browser (double-click, or the hosted
Pages copy). Do not introduce a bundler, framework, or npm dependency to the app itself — the
zero-install single-file property is the point. New third-party code must be inlined and its
license honoured in the head banner. (`tools/` is the one exception: a separate, optional
Node+Playwright CLI for headless/scripting use — see **pipeline** below — with its own scoped
`package.json`, deliberately kept out of `webSMLM.html` so the app's own property is untouched.)

## Editing model

All work happens inside `webSMLM.html`. It is organized into commented `MODULE:` banners; find the
relevant one before editing rather than scrolling:

- **params** — the `PARAMS` registry: single source of truth for every analysis/render/export
  parameter (name → `{label, min, max, step, default, int}`), read via `paramValue(id)`. Drives
  the HTML controls' min/max/default (`syncParamControls()`), Save/Load Settings, and — for
  parameters with no page control yet (worker-dispatch thresholds, preview timing, etc.) —
  `paramOverrides`, settable only via a loaded settings JSON. This is also the shape
  `window.webSMLM.analyze(config)`'s headless config takes (see **pipeline** below) — a new
  `PARAMS` entry is automatically available to both without extra wiring. Deliberately excludes
  pure display/layout (CSS) and per-dataset working state (`calFirst`/`calLast`/`zmin`/`zmax`).

  `addNumberSteppers()` (runs once, right after `syncParamControls()`) wraps every `input.num` in a
  `.numstep` span with an appended `.numstep-btns` −/+ pair — Inkscape-style, always visible, not
  the browser's native number-input spinner (tried first; reverted — look varies across engines,
  and it's hover-reveal only, unreachable on a touchscreen). Reads each input's already-present
  `min`/`max`/`step` (set by `syncParamControls()` for `PARAMS`-mapped fields, or static HTML
  attributes for the ones `PARAMS` excludes), so any current or future `.num` field gets steppers
  for free with no per-input wiring. Clicking dispatches real `input`/`change` events, so every
  existing listener reacts exactly as it would to typing. `input.num` is left-aligned (not right)
  and narrower (64px) — value first, then the control that changes it.

  **Trailing "/N" text next to a numstep-wrapped field needs its own `vertical-align:middle`.**
  `.numstep` is `display:inline-flex;align-items:stretch;vertical-align:middle`, so it renders
  TALLER than a plain text baseline — a plain `<span>` right after it (e.g. the Frame scrubber's
  `#scrubTotal`, "/ total frames" next to `#scrubNum`) inherits ordinary baseline alignment and
  renders visibly lower than the numstep group's own vertical centre unless it also gets
  `vertical-align:middle`. That span also carries a space on each side of the `/` (` / 20000`) —
  safe since the parent already has `white-space:nowrap`.

- **in/out** — TIFF parsing; in-memory vs. streamed loading; contiguous ImageJ stacks are indexed
  arithmetically, multi-IFD (Micro-Manager MMStack) stacks by walking the IFD chain. Handles
  multi-GB files via `File.slice()` (never fully loaded). `loadTiffFile()`'s choice between the
  whole-file (`file.arrayBuffer()`) and streamed (`loadMultiIfdStreaming()`) path is gated on
  `effSliceMin = Math.min(SLICE_MIN, readBudget())` — `SLICE_MIN` (~1.5 GB) alone used to be the
  ONLY gate, disconnected from `readBudget()`/`memgb` (the SAME "Memory budget (GB)" control that
  gates decoded-frame caching further downstream). **Fixed a real bug**: a moderate file (147 MB
  bundled sample; a 680 MB real-world one) stayed under 1.5 GB and always took the whole-file path
  (reading the entire raw file AND indexing every frame's IFD up front, before any budget check),
  while a much larger file (4.9 GB) was always forced onto the chunked streaming path regardless of
  its own size — on memory-constrained mobile Safari (no JS-visible OOM signal, see FTM's memory
  note below) this made the SMALLER file the riskier load. Tying the threshold to `readBudget()`
  lets a user lower **Memory budget (GB)** and have it apply here too; unchanged at the 3 GB
  default (`min(1.5GB,3GB)=1.5GB`) so desktop behaviour is untouched. Verified via Playwright: a
  forced-low budget routes the same 147 MB sample through `loadMultiIfdStreaming()` instead,
  producing byte-identical pixel data. Both call sites log a one-line advisory —
  `"Streaming instead of loading whole: X file exceeds the Y Memory budget…"` — but ONLY when the
  tightened budget (not a file genuinely over the fixed 1.5 GB ceiling) is what forced streaming,
  so it doesn't fire redundantly alongside the other path's own message.

  **`memgb`'s own DEFAULT is also lowered on mobile** (`syncParamControls()`, MODULE: params) — the
  fix above only helps once a user has actually lowered **Memory budget (GB)**; at the unchanged
  3 GB default the 680 MB mobile-sized file still crashed silently. `syncParamControls()`
  special-cases `memgb`: on a narrow viewport (`isMobileViewport()`, `window.innerWidth<=860` — the
  same signal the mobile sidebar drawer uses) it defaults to `0.5` (its UI-allowed minimum) instead
  of `3`. **1 GB was tried first and is wrong** — `680 MB<1 GB` still doesn't clear the threshold,
  only `0.5` (512 MB) does; re-verify against a real number if this default is ever revisited.
  Deliberately a LOCAL override inside the sync loop (`const def = ... ? 0.5 : spec.default`), NOT
  `spec.default=0.5` — the latter would permanently mutate the shared `PARAMS.memgb` object
  (`PARAMS[id]` is a reference, not a copy). Only the INITIAL default changes; a loaded settings
  JSON's own `memgb` still overrides it as always.

  A multi-file selection (Ctrl/Cmd+click) goes through `loadTiffFilesAuto()`, which auto-detects
  which of two combining strategies applies from `files[0]`'s own frame count (same "file[0] sets
  the rules" convention used for width/height): exactly 1 frame → `loadTiffSequence()`
  (natural-sorted, one file = one frame — e.g. a per-frame camera dump); more than 1 →
  `makeConcatStack()` (each file loaded normally via `loadTiffFile()`, keeping whichever loading
  strategy its own size calls for, then concatenated end-to-end) — for one continuous acquisition
  split across several files purely by size, a different scenario from the per-frame case.
  `makeConcatStack()` only implements `getFrames()` (never `getFrame()`, same convention as
  `makeCroppedStack()`/`makeFtmStack()`), routing a requested range across component stacks via a
  prefix-sum frame-count table. The same `loadTiffFilesAuto()` entry point backs the interactive
  file input, calibration loading, and the headless `cfg.files`/`cfg.calibrationFiles` config (see
  **pipeline**) — one detection path, three callers. Multi-file selection filters candidates by
  SNIFFING the real TIFF magic bytes (`isTiffFile()`, "II*\0"/"MM\0*") rather than trusting the
  filename extension; the `#file` input's `accept` lists `.nd2` alongside `.tif`/`.tiff` for
  exactly this.

  `loadTiff()`/`loadTiffFile()`'s fast path and `loadTiffSequence()`'s `decodeOne()` all validate
  the raw ImageWidth/ImageLength tags (`t256`/`t257`) are present and positive before trusting a
  `UTIF.decode()` result — UTIF returns one EMPTY ifd object (no exception) for non-TIFF bytes, so
  without this an unsupported binary would silently produce `NaN` dimensions instead of a clean
  error. **Check `t256`/`t257`, not `.width`/`.height`** — those are only set as a side effect of
  `UTIF.decodeImage()`, so checking them beforehand silently checks `undefined>0` and rejects every
  file, valid or not (a real regression caught before shipping).

  **Native Nikon ND2** (distinct from the TIFF-in-disguise case above), shipped v0.11.2,
  **experimental** — `isNd2File()` sniffs the real magic (`0x0ABECEDA` LE u32 at byte 0) and
  `loadTiffFile()`'s first line dispatches to `loadNd2File()`, reaching all three existing callers
  (interactive, calibration, headless) with no caller-side changes; `loadTiffFilesAuto()` also
  special-cases a lone `.nd2` selection (multi-file ND2 concatenation isn't supported yet).
  Reverse-engineered directly from real sample bytes, not ported from any GPL reader (see also the
  independent BSD-3-Clause `tlambert03/nd2` reference). The file is a flat run of 16-byte-header
  chunks (`magic+dataOffset+dataLen+4 reserved`, then a `!`-terminated name, then payload), each
  padded to the next 4096-byte boundary; `readNd2ChunkHeader()` walks the WHOLE chain from byte 0
  to index every `ImageDataSeq|N!` frame offset — no shortcut, since the required
  `ImageAttributesLV!` metadata chunk sits near EOF, after all frame data. Each `ImageDataSeq|N!`
  payload is a 24-byte (`ND2_FRAME_HEADER_BYTES`) per-frame sub-header (unidentified, never parsed)
  then the pixel array. `parseNd2LvField()` recursively decodes Nikon's binary key-value ("LV")
  format for `ImageAttributesLV!`/`ImageCalibrationLV|0!`: a container (type `0x0b`) holds
  `childCount(u32)+byteLen(u64)` then recurses exactly `childCount` times — **`byteLen` must never
  be used as the parse boundary**, it can include trailing padding and produce a bogus extra read
  with a garbage type byte. String fields (type `8`) are **null-terminated UTF-16LE with no length
  prefix**, unlike field names (explicit `nameLen`). `getFrames(s,e)` decodes each frame at its own
  explicit stored offset (never back-to-back). Pixel calibration (`ImageCalibrationLV|0!`'s
  `dCalibration`) and two bonus metadata chunks — `CustomData|AcqTimesCache!` (per-frame
  timestamps → a MEDIAN-of-diffs frame-interval estimate, robust to near-zero leading placeholders
  seen in real files) and `CustomData|STORM_CAM_DATA_SHEET_XML-V1!` (camera datasheet info, NOT
  wired to `gain`/`camoffset`) — are also parsed.

  **Native FITS** (Flexible Image Transport System), v0.12.1-dev, **experimental** — requested after
  a real Andor Solis-exported sample file (`t1b18_scan1-g2r1_001.fits`, 512×258×50, 16-bit, camera
  `DU897_BV` — an Andor iXon EMCCD, the same model already named elsewhere in this file's own
  `mmMetadataHint()` real-sample log) turned up in the repo: "should be a camera driven data format
  think from Andor cameras. Could be implemented in the data loading if not too complex." A camera
  movie export, not an astronomical multi-extension/WCS file — only the small, camera-relevant
  subset of the (large) FITS standard is implemented: a single primary HDU holding a plain 2D image
  or a 2D+frame-axis data cube, `BITPIX` ∈ {8,16,32,-32,-64} (the standard's own 5 sample formats),
  `BZERO`/`BSCALE` applied generally (`physical=raw·BSCALE+BZERO`) — not hardcoded to the common
  "represent unsigned 16-bit as signed+32768" convention, so any real BZERO/BSCALE pair works.
  `isFitsFile()` sniffs the real `SIMPLE` magic (byte 0) rather than the `.fits`/`.fit` extension,
  same convention as `isTiffFile()`/`isNd2File()`; `loadTiffFile()`'s dispatch chain gained one more
  early check (`if(await isFitsFile(file)) return loadFitsFile(file, onLog);`, right after the
  existing ND2 one), reaching all 3 existing callers (interactive, calibration, headless) with zero
  caller-side changes — same "one detection path, three callers" precedent ND2 established.
  `loadTiffFilesAuto()`'s own "a lone ND2 file must be caught before the TIFF-only magic-byte filter"
  special case was generalized to cover a lone FITS file too, for the same reason (a bare
  `isTiffFile()` filter would otherwise silently drop it). `#file`/`#segFile`'s own `accept` lists
  gained `.fits,.fit` alongside `.nd2`.

  `fitsParseHeader()` walks 80-byte fixed-width "cards" (`fitsParseCard()` handles the 3 value kinds
  a camera-movie primary header actually uses — a single-quoted STRING with `''`-escaped literal
  quotes per the FITS standard's own Fortran-derived convention, a bare `T`/`F` LOGICAL, and a plain
  NUMBER, including Fortran-style exponents like `1.0E-05` that JS's own `Number()` already parses
  correctly with no translation needed) until `END`, growing its own read by one 2880-byte block at a
  time since the header's true size isn't known until `END` is actually found (real camera-movie
  headers seen so far are 1-3 blocks; a pathological file bails after 20 blocks rather than reading
  forever). Metadata actually present on the one real sample (`HEAD`/camera model, `SERNO`, `ACQMODE`,
  `EXPOSURE`, `GAIN`/EM gain, `TEMP`) is logged the same "compute once, apply by hand" way ND2's own
  calibration hint is — **no pixel-size or frame-interval keyword exists in this format at all** (no
  `CDELT`/`PIXSCALE`-equivalent on the one real sample, and Andor's own FITS export doesn't appear to
  write one), so unlike TIFF/ND2 there is genuinely nothing here to hint at beyond camera/acquisition
  identity.

  **Row orientation needed real care, not just structure**: the FITS standard's own convention (Pence
  et al. 2010, *A&A* 524, A42 §5.1 — the SAME paper this real sample file's own header `COMMENT` card
  cites) stores row 1 at the BOTTOM of the image with row index increasing UPWARD — the opposite of
  this app's/TIFF's/canvas's top-down convention — so row 0 in the FILE must become the LAST output
  row, not the first, or every frame would render upside-down relative to every other loader in this
  app. `decodeOne()` reads output row `y` from source row `h-1-y` directly during decode (no separate
  flip pass). **Circumstantial, not independently visually confirmed**: the one real sample's own
  `SUBRECT` card (`'1, 512, 386, 129'`, a descending top>bottom pair) is consistent with Andor's own
  sensor-row addressing already matching this bottom-up convention, but the sample carries no
  fiducial/asymmetric feature that would let the flip direction be settled by eye against a rendered
  Andor Solis view — revisit if a differently-oriented real file ever surfaces.

  **Verified the same way the ND2 loader was held to** — "install a real reference reader and diff
  decoded VALUES, not just structure": `astropy.io.fits` (already available in this environment) was
  used to independently decode the real sample file, and the hand-parsed header arithmetic
  (`headerSize=5760` bytes, `frameBytes=264,192`, exact total file size) and BOTH frames' pixel
  statistics (frame 0: min 385/max 443/mean 396.38; frame 25: min 387/max 5201/mean 657.86) matched
  astropy's own decode EXACTLY, byte for byte — including the first 10 raw pixel values of each
  frame's own first STORED row, confirming both the header/data-offset arithmetic and the BZERO/
  BSCALE application are correct before the row-orientation flip was ever applied. Re-verified
  end-to-end via Playwright through the real interactive `#file` picker (not just a direct function
  call): `stack.getFrames()`'s own output matches astropy's decode pixel-for-pixel once the vertical
  flip is accounted for, Localize finds real, plausible spot candidates on the loaded data (107
  spots/20 locs on the quiet first frame; 265/265 on a bright mid-movie frame), and the Data
  projection composite renders a normal-looking field of real single-molecule puncta with zero page
  errors.

  TIFF gets the analogous treatment via
  `tiffScaleHint(ifd0, desc)`: reads `finterval=` from the `t270` description text, and — only when
  `unit=` says micrometers — `t282`/`t283` (XResolution/YResolution) for a pixel-size estimate;
  `t296` (ResolutionUnit) is deliberately never consulted.

  **`tiffScaleHint()`'s pixel-size branch now sanity-checks the RESOLVED value, not just `>0`** —
  a real, reported bug found via a genuinely new sample file (`experimental_data/
  alex50mW_1_MMStack_Default.ome.tif`, dual-view/image-splitter ALEX TIRF smFRET — see
  `experimental_data/README.md`'s own Dataset V entry): its `unit=um` description paired with a
  `t282` (XResolution) RATIONAL of `4294967295/1` — `0xFFFFFFFF`, the classic "unset" sentinel some
  TIFF writers emit instead of omitting the tag entirely — passed the old `ifd0.t282[0]>0` check
  trivially (`4294967295>0`), so the app logged a fabricated-looking `"pixel size ≈ 0.0 nm/px"` for
  a file whose own Micro-Manager metadata elsewhere explicitly says `PixelSizeUm: 0.0` (never
  calibrated). Fixed by checking the FINAL computed `pxNm=1000/ifd0.t282[0]` against a plausibility
  range (`PX_HINT_MIN_NM`/`MAX_NM`, 1–100000 nm/px — comfortably covering every real scientific-
  camera pixel size this project has seen) instead of the raw tag value. **Deliberately not a
  hardcoded reject-`4294967295`-specifically rule** — `experimental_data/README.md`'s own Dataset I
  (GATTA-PAINT) has a LEGITIMATE, correctly-calibrated XResolution of `4294967295/42605` (same huge
  numerator, but a real, non-unity denominator resolving to a normal ~100 nm/px scale) — a
  numerator-based check would have wrongly rejected that genuine case too; checking the final
  resolved pixel size is what correctly tells the two apart. Verified via Playwright against the
  real new file (bogus line no longer logged, nothing incorrect substituted in its place — this
  dataset genuinely has no usable pixel-size hint anywhere) and against two real POSITIVE cases
  (GATTA-PAINT-80R-raw_cropped.tif → still `119.0 nm/px`; the Z-calibration stack → still
  `160.0 nm/px` + `118.9 ms` frame interval) to confirm the fix doesn't touch a real, valid hint.

  **`mmMetadataHint(ifds)`** (requested, same investigation — "always check each tiff header for
  extractable information especially on camera, frametime and pixel size... general readout...
  many data will have been provided, for example with micromanager") reads a genuinely different,
  much richer tag `tiffScaleHint()` never touches: Micro-Manager's own per-frame metadata (TIFF tag
  51123, present on EVERY IFD of an MMStack file) — a real JSON object per frame, not just plain
  description text. UTIF stores an ASCII-type tag's value as an array containing the WHOLE decoded
  string (confirmed by direct inspection via Playwright — not a raw byte array needing a UTF-8
  decode, which was tried first and produced garbage/NUL bytes), so the JSON text is
  `ifd.t51123.join('')` — the exact same "UTIF stores ASCII tags as an array, `join()` it" pattern
  `descOf()`/`dv()` already use for `t270` elsewhere in this file. Three keys are UNIVERSAL across
  every camera adapter Micro-Manager supports (`Exposure-ms`, `ElapsedTime-ms`, `PixelSizeUm` — all
  Core metadata, not adapter-specific); camera IDENTITY has no such standard — `'Camera-Camera'`/
  `'Camera-Description'` (checked here, best-effort) happen to be populated by the Andor adapter in
  every real sample this project has, but a different camera/adapter may use neither, in which case
  this simply omits that one line rather than guessing at an unfamiliar key name. Andor's own
  adapter writes the camera identity as a literal `"| Type | Model | Serial |"` pipe-table string —
  only the OUTER pipes/whitespace are stripped (keeping the inner `" | "` separators, which read
  fine as `"Type | Model | Serial"`), so the log doesn't show a value wrapped in stray leading/
  trailing bars.

  **Frame interval is estimated from a SAMPLE, not every frame** (`MM_HINT_SAMPLE=25`) — parsing
  every single frame's own JSON blob would cost 40,000 `JSON.parse()` calls on a Leterrier-style
  large stack, measurably slowing down every such load for no real gain in estimate quality.
  Instead, `Math.min(n,25)` evenly-spaced indices are sampled across the WHOLE stack, and the
  MEDIAN of `Δtime/Δindex` between consecutive SAMPLED points is taken — dividing by the index gap
  means a non-adjacent sample pair is just as valid as an adjacent one (a longer baseline is
  actually LESS sensitive to any single frame's own jitter), the same "median, robust to a bad
  sample" spirit as the ND2 loader's own `AcqTimesCache` interval estimate above, generalized to
  work off a spread sample rather than requiring every consecutive frame. Wired into all 3
  `tiffScaleHint()` call sites (`loadTiffFile()`'s contiguous-single-IFD fast path,
  `loadTiffSequence()`'s per-file decode, `loadTiff()`'s general multi-IFD decode) — the first two
  only ever have ONE decoded IFD available at that point (a contiguous ImageJ stack's own frames
  aren't separate IFDs; a file-per-frame sequence decodes the REST of its files lazily, later, in
  `getFrames()`), so `mmMetadataHint([ifd0])` there naturally reports only camera/exposure/pixel-size
  and skips the frame-interval estimate (needs ≥2 IFDs) — no special-casing needed, the function
  degrades on its own. `loadTiff()`'s own `ifds` array already holds every frame's IFD (the whole
  file is decoded up front on that path), so it gets the full sampled estimate for free. Verified
  via Playwright against the real new file: reports `camera iXon | DU897_BV | 5673, exposure 30 ms
  (set point — real inter-frame time may differ, see below), frame interval ≈ 32.01 ms (median of
  24 sampled inter-frame gaps)` — matching the file's own separately-confirmed `32.02 ms`
  `Camera-ActualInterval-ms` almost exactly — while a 264 MB load still completes in ~1.3 s (no
  measurable slowdown from the added sampling); re-checked against 3 files that predate this
  feature (GATTA-PAINT, the Z-calibration stack, the sptPALM Lactis dataset — none of which carry
  tag 51123 at all) to confirm `mmMetadataHint()` cleanly returns `''` and changes nothing about
  their existing `tiffScaleHint()`-only output.

  `makeCroppedStack()` (raw-panel crop tool, `rawCropBtn`) is the simplest stack wrapper: slices
  every fetched frame to a fixed `[x0,x1)×[y0,y1)` sub-rectangle and REPLACES the module-level
  `stack` with it (kept in `originalStack` while active, restored on "uncrop") — a full stack swap
  rather than a search-region restriction threaded through detect/fit, so no downstream consumer
  needs a coordinate offset added back. Deselecting `rawCropBtn` while `lastResult` exists confirms
  first — `resetAfterCropChange()` erases `lastResult` (and sSMLM pairing state) unconditionally,
  no undo.

  **FTM** (`ftmEnabled`/`ftmWindow`, controls in the **fit** module's `PARAMS`/sidebar despite the
  functions living here) is a per-pixel sliding-window temporal median subtraction — floored at
  `camoffset` and added back, not floored at zero, see **fit** for why — used in two places sharing
  the same math but otherwise independent:
  - **Scrubbing preview** — `ftmFrame()`/`ftmFrameParallel()`, one frame at a time, fetching only
    that frame's own `ftmWindow`-wide context. Parallelizes across the worker pool spatially (row
    bands, no overlap margin needed — each pixel needs no neighbouring-pixel context). The
    raw-panel toggle (`rawFtmBtn`, shown only while `ftmEnabled` is checked) drives `rawFtmView`;
    `showFrame()` swaps in the corrected frame before running the usual detect/live-preview logic.
    The raw panel title stays fixed at "Raw frame" always — only `rawFtmBtn`'s own label changes
    (a dynamic title was tried and reverted: visual noise for no information gain).
  - **Localize** — processes the stack in chunks sized from half the `chunkmb` budget (headroom
    for raw context + corrected output coexisting), using the sliding-window median algorithm
    (`ftmSeriesGlobal`, O(window) per step). Two implementations, chosen by whether `runCore()`
    uses the worker pool this Run:
    - **No pool**: `makeFtmStack()` wraps the loaded stack so `runCore()`'s serial `getFrames()`
      calls receive FTM-corrected data transparently, caching each chunk. Main-thread, with a
      single-flight lock.
    - **Pool in use**: a **barrier-phased loop** inside `runCore()` (search `fetchStack!==stack`)
      processes chunk by chunk — each chunk runs a full-pool-parallel FTM-correction phase
      (`ftmChunkParallel()`, row-band split) to completion, THEN a full-pool-parallel detect/fit
      phase (duplicated rather than shared, to keep the non-FTM path provably untouched) to
      completion, before the next chunk's FTM phase — never both job types on the pool at once.
      **Required, not just faster**: each worker has exactly one `onmessage` property, not a
      queue, so without the barrier an FTM-correction reply and a detect/fit reply could clobber
      each other's handler mid-flight. The timing log's `↑ N workers, X% util.` line covers
      the detect/fit phase only, excluding the separately-reported FTM phase. Each chunk's
      detect/fit phase's `finishChunk()` MUST check `shouldStop()` itself, not just rely on
      `dispatchChunk()`'s own bail-out.

    Both implementations must widen a chunk's context fetch beyond naive `coreStart±window/2`
    whenever the chunk's core range comes close enough to either end of the **whole stack** (not
    the Run's own `fitFirstFrame`/`fitLastFrame`) that a frame's window gets clamped further than
    that padding accounts for — same clamp `ftmSeriesGlobal` applies per frame internally
    (`ftmFrame()`'s single-frame path already had this right; the chunked functions didn't, until a
    worker-vs-serial A/B test caught a ~5%-photon-count-bias for a stack's tail frames).

    **Memory**: the barrier-phased loop's `ctxFrames` (raw context, dead once `ftmChunkParallel`
    returns `corrected`) must be explicitly dropped (`ctxFrames=null`, hence `let` not `const`)
    right after that call, not left reachable through the following dispatch phase's own
    allocations in the same closure — `chunkmb`'s `/2` split only budgets for context+corrected
    coexisting, not context+corrected+in-flight batch clones too. `runCore()` also logs an
    estimated peak-MB figure (chunk working set plus the already-cached stack's size, a *separate*
    budget stacking on top of `chunkmb`) right after the chunk-size line, advisory above ~800 MB —
    gated on `memgb<=8` (max is now 64, for workstation-scale caching) so a desktop user who's
    deliberately raised it isn't nagged every Run. Visibility only: a mobile tab killed for memory
    pressure gets no JS-visible error at all — nothing here can detect or prevent that.

- **simulation** — the built-in synthetic stack generator ("Simulate movie"): demo/validation/
  teaching data, not a core analysis path. Split out from in/out since it doesn't load anything.

- **detect** — per-frame band-pass, one of three filters selectable via `#detFilter`: à trous
  B-spline **wavelet** (default) or **DoG** (both thresholded by local maxima above `mean + k·σ`),
  or **uniform box filter** (difference of two box averages, thresholded by a plain intensity
  value + a σ_PSF-sized square dilation, per Huang et al. 2011). `detectSpots()` is the single
  dispatch point (used by both the main thread and workers) that picks the right band-pass +
  maxima function for the selected mode. Each filter's UI parameters are separate fields named
  `detection_<method>_<setting>` (e.g. `detection_DoG_thr`, `detection_box_thr`) shown/hidden by
  the sync IIFE keyed off `#detFilter` — don't reintroduce a single shared field across methods,
  their thresholds mean different things (k·σ multiplier vs. raw intensity).

- **fit** — phasor (fast, non-iterative), least-squares 2D-Gaussian, and Poisson-MLE 2D/3D/
  Elliptical (`gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`;
  `gaussianMLEspheric` is the default) localization. All fitters take `gain,camoff` and convert
  every pixel to true photon units — `(raw-camoff)*gain` — before fitting, matching Picasso's
  architecture; position/width/ratio outputs are provably invariant to this affine transform
  (LS/phasor), while MLE's Poisson likelihood and CRLB (`lpx`/`lpy`) are only statistically correct
  when fit in photon units, so this is the one place gain/offset actually change a result rather
  than just rescaling it.

  **Accept/reject drift gate decoupled from `winr`** (reported): all 5 fitters (`gaussianFit`,
  `gaussianFitElliptical`, `gaussianMLEspheric`, `gaussianMLEelliptic`, `gaussianMLEellipticangled`)
  reject a converged fit whose position drifted too far from its seed — previously bounded by `r`
  (Fit radius/`winr` itself), so widening the window for more background context also silently
  loosened (or, via harder convergence in a busier/crowded window, sometimes effectively tightened)
  that gate, with no reliable direction — the same visual set of spots in real, faint, crowded smFRET
  data gave different accepted counts at `winr` 3 vs 4. Now bounded by `FIT_MAX_DRIFT_SIGMA_MULT`
  (2, declared once near MODULE: fit's own banner) times the SEED σ_PSF (`sigma0` — never the fit's
  own output sx/sy, which would be circular) — a physically meaningful, window-size-independent test.
  A constant, not a live `PARAMS` value: all 5 fitters are stringified into the detect/fit worker
  (`workerSource()`), so a tunable value would need threading through that worker's own dispatch
  protocol at every call site instead of one shared declaration (+ one `WORKER_PRELUDE` line) —
  promote to a real setting later if 2× ever proves wrong for real data. `sigma0` is already a
  parameter on every one of these 5 functions, so this needed zero signature or call-site changes.

  **`apertureGeometry(win)`/`percentile(sortedVals,p)`** (v0.12.1-dev, right before `phasorFit()`) are
  a shared aperture-photometry helper — a CIRCULAR signal disk (`distance from centre <= r`,
  `r=(win-1)/2`, the same half-width every fitter here already uses) plus a SEPARATE, non-overlapping
  background annulus just outside it (`r < distance <= r+2.5`), background estimated via that
  annulus's 56th PERCENTILE (not mean or median) — published, previously-validated method (Martens et
  al., *J. Chem. Phys.* 148, 123311 (2018), Supplementary Information §S11 "Aperture photometry to
  assess intensity and background levels," itself adapting Preus, Hildebrandt & Birkedal, *Biophys.
  J.* 111, 1278 (2016), "Optimal Background Estimators in Single-Molecule FRET Microscopy" — directly
  on-topic for the smFRET use case below). **Reverse-engineered pixel-exact from the SI's own Figure
  S11 reference maps, not its prose formula** — the SI's own text names a "ROI radius" that turned out
  to be consistently 2px LARGER than the window's actual half-width `r`, for reasons the SI itself
  never explains; rendered the SI's PDF at 600 DPI (`pdftoppm`) and counted signal/background pixels
  exactly against the 7×7 and 9×9 reference maps (both independently confirming the `r`/`r+2.5`
  boundary) and the 15×15 map's own excluded corners (confirming the exclusion cutoff) before trusting
  the geometry — the prose alone would have produced a signal disk far too small to match the
  published figures. `apertureGeometry(win)` caches the `(dx,dy)` offset lists per window size (same
  `win` reused across every call in one Localize run or one smFRET Get time traces run);
  `percentile()` is the standard linear-interpolation convention (numpy's/MATLAB's default). **A real
  bug caught before shipping**: the background annulus reaches `r+2.5`, WIDER than the `win×win` box
  itself — the first draft only scanned `dx,dy` in `[-r,r]` (carried over by habit from an earlier
  box-based version's own loop bounds), silently never visiting the outer part of the annulus at all;
  fixed by scanning out to `Math.ceil(r+2.5)` instead.

  Used by **two** callers, consolidated into ONE implementation on request ("best to not have too many
  different methods") rather than two independently-evolved ad-hoc ones:
  - `phasorFit()` (below) — its own `photons`/`bg`/`bgstd` now come from this geometry instead of its
    PREVIOUS approach (a square `win×win` box's own outermost ring, background = plain MEAN) — see
    `phasorFit()`'s own comment for the re-verified synthetic accuracy number (a genuine improvement,
    not just "comparable," since a real, separate annulus removes most of the old ring's own
    real-signal leakage bias). Position/phasor-magnitude math (`col`/`row`/`tot`, the Fourier
    transform of the FULL box) is completely unrelated and untouched.
  - `apertureIntensity()` (MODULE: smFRET) — smFRET's own fit-free "Aperture photometry (no fit)"
    option for Get time traces; see that module's own paragraph for how it got here (a square-box
    ring-MEAN first, then a ring-MEDIAN that empirically made things WORSE before this literature
    version replaced both).

  Both stringified into the detect/fit worker (`apertureGeometry.toString()`/`percentile.toString()`
  added to `workerSource()`'s function list, `_apWin`/`_apSignal`/`_apBackground` added to
  `WORKER_PRELUDE` — the Web Worker gotcha: `phasorFit` is itself worker-dispatched for a Phasor
  2D/3D Localize run, so anything it newly depends on must reach the worker too, or it throws
  `ReferenceError` the first time a worker-pool Run actually exercises it).

  **`winr2d`/`winr3d`** (Fit radius 2D/3D) are the two fields actually shown in the sidebar;
  `applyWinrDefault()` (MODULE: pipeline, called from `updateMethodUI()`'s own `currentIs3d()`)
  keeps the underlying `winr` field mirroring whichever one is relevant as the 2D/3D context
  changes — a symmetric 2D PSF at this codebase's typical σ_PSF (~1.3 px) is well-fit by a
  narrower window (default 3) than an astigmatic 3D PSF's elongated axis (default 4), so one
  global `winr` default (previously 4, now 3) couldn't serve both. `winr`'s own sidebar row is
  hidden (`style="display:none"`, reported: three near-identical-looking fields on screen at once
  read as confusingly redundant, since two of the three always showed the same number) but stays
  in the DOM — every existing `$('winr')`-based mechanism (PARAMS, live-preview listener arrays,
  the worker-dispatch value) needed zero changes; edit **Fit radius 2D**/**Fit radius 3D** directly
  instead, they now double as "the active value for that mode". `applyWinrDefault()` itself is
  still internally NON-CLOBBERING, unlike `updateMethodUI()`'s own LUT auto-default just below
  (which always overwrites on every method switch, since LUT is a display preference with nothing
  to protect): it only overwrites `winr` if its current value still equals `_winrAutoSetValue`
  (what the mechanism itself last wrote there) — with no UI path left to hand-edit `winr` itself,
  this now just means editing the *inactive* one of `winr2d`/`winr3d` has no visible effect until
  you actually switch into that context, which is the wanted behaviour. `currentIs3d()` means real
  z coming out, not just a 3D-capable
  method selected (`mle3d`/`gaussmleEll` with **3D localisation?** unchecked still counts as 2D
  here) — extracted as its own function so `winr2d`/`winr3d`'s own `change` listeners can reuse the
  identical logic `updateMethodUI()` already had, rather than a second copy. Headless `analyze()`
  sets `winr` directly, same as always — this auto-apply is interactive-UI-only.

  **`methodResetsLutToFire(method)`** (v0.12.1-dev, extracted from `updateMethodUI()`'s own
  else-branch — `m==='phasor'||m==='gaussmle'||m==='mle3d'||m==='gaussmleEll'`, deliberately NOT
  `gaussls`, see that branch's own comment) is now also checked by `run()` itself, right before
  `runCore()` starts: `if(!currentIs3d() && methodResetsLutToFire(method)) $('lut').value='fire';`.
  Real, reported bug this closes: `updateMethodUI()`'s own reset only ever fires on an actual
  `method`/`localize3D` **change** event — it never re-runs just because Localize was clicked, so a
  Colour map left on `hsvBlue`/`turbo` by an EARLIER, unrelated result (most commonly sSMLM's own
  **Pair & plot sSMLM**) silently carried over onto a brand-new dataset's plain 2D Localize run, as
  long as the Fit method dropdown itself stayed on the same value the whole time (no `change` event
  to catch it) — the reconstruction rendered as a confusing rainbow/blue-dominant density map instead
  of Fire. Checked BEFORE `runCore()` starts (not just after it finishes) so every live preview
  during the run, not only the final render, already uses the corrected map — avoids a
  flash-then-correct effect on a long run. Reuses the exact same method list `updateMethodUI()`
  itself checks (now a shared function) rather than a second, potentially-drifting copy; `run()`
  never needs the OTHER half of that branch (`if(srFull) rerender(true)`) since it always calls
  `rerender(true)` itself right after anyway. Verified via Playwright: paired an sSMLM/smFRET result
  (Colour map → `hsvBlue`), loaded a completely different, unrelated real dataset with the Fit
  method dropdown left untouched (`gaussmle`, still selected), clicked **Localize** — Colour map
  correctly reads `fire` afterward, not the stale `hsvBlue`.

  **Shared MLE accumulator**: `gaussianMLEspheric`/`gaussianMLEelliptic`/`gaussianMLEellipticangled`
  all run on ONE Fisher-scoring Newton driver, `mleNewtonFit(n, th, mstep, clampFn, ..., modelFn)` —
  checked directly against Picasso 0.11.0's `picasso/fitting/gaussfit.py`, whose
  `_estimator_terms(mle, value, data, var)` dispatch is the same Fisher-scoring shell
  (`inv=1/model; cf=data*inv-1; hess+=du·du·inv`) webSMLM already implemented. `modelFn(px,py,th,
  duOut)` returns the per-pixel model value and writes its Jacobian into a reused scratch array —
  `mleModelSpherical`/`mleModelElliptical` are erf-pixel-integrated (unchanged math, just
  extracted); the driver never needs to know what a parameter MEANS, only how the model responds to
  it, so a third/fourth model plugs in without touching the driver. `gaussianFit` (LSQ, Gauss-Newton
  + backtracking line search) is deliberately NOT part of this unification — different per-pixel
  weighting (plain squared residual, no `1/model` term) and a different outer solver.

  **`gaussianMLEellipticangled`** (`'gaussmleEll'`, "Gauss MLE rotated elliptical" in the UI —
  "3D" dropped from this and `mle3d`'s own label, requested: both methods work equally validly as a
  plain 2D fit with **3D localisation?** unchecked, so a "3D"-only-sounding name was misleading,
  particularly for sSMLM's own non-3D FIXED-angle use case below)
  adds a genuinely new model: `[x,y,N,bg,σx,σy]` plus a rotation angle, either FIXED (6 free params,
  reusing `mleModelElliptical` with pixel offsets pre-rotated by the constant once — same
  size/stability class as `gaussianMLEelliptic`, no angle Hessian row) or FREE (7 free params, angle
  is θ[6]). Motivated by sSMLM: every other 2D method fits one symmetric σ, so `sigma1st` (see
  **sSMLM**) was never a real directional measurement of the spectrally-smeared 1st order, just the
  closest available proxy. POINT-SAMPLED (`value=amp·exp(-½(arga²/σx²+argb²/σy²))+bg` at the pixel
  CENTER), not pixel-integrated like the other two models — a rotated Gaussian doesn't factor into
  closed-form per-axis erf integrals the way an axis-aligned one does; matches Picasso's own
  `_accumulate_rotated` formula exactly. `photons` is the amplitude converted to a true integrated
  photon count (`amp*2π·σx·σy`, same relation `gaussianFitElliptical` uses) — NOT the raw θ[2]
  amplitude the point-sampled model actually optimizes internally (`amp` reported separately).
  **Free-angle gotcha** carried over from Picasso: the angle derivative vanishes identically when
  σx==σy, singularising the Hessian — the seed deliberately breaks that symmetry
  (`σx0=1.05·σ0, σy0=0.95·σ0`) whenever angle is free; a fixed angle never enters the optimisation,
  so this doesn't apply there. An unconstrained (σx,σy,angle) fit also has a real, expected 4-way
  degeneracy (swapping σx↔σy and adding ±90°/±180° to the angle describes the identical physical
  ellipse) — not a bug, confirmed against all 4 equivalent parameterisations of a synthetic fit.

  **`PARAMS.localize3D`** ("3D localisation?", default checked) is the switch between the two angle
  modes for `'gaussmleEll'` — no separate per-method setting. `updateMethodUI()` only shows the
  checkbox's row (`localize3DRow`) for `mle3d`/`gaussmleEll`; unchecked: angle FIXED at
  `paramValue('sSmlmAngleCenter')` (degrees → radians, the sSMLM pairing step's own calibrated
  dispersion bearing, see `fitSSmlmDistAndAngle()`) and no z is computed (`wcal` stays `null` regardless of
  calibration). Checked (default): angle FREE (recovers a genuine per-emitter rotation angle) AND —
  if a `gaussian_width` calibration is loaded — z is computed from the fitted `(σx,σy)` via
  `zFromWidths()`, the same call `mle3d` makes; this doubles as the astigmatism-axis-alignment
  diagnostic: run `'gaussmleEll'` against real 3D calibration bead data and read back a genuine
  per-emitter angle instead of assuming axis alignment. `runCore()` computes `sSmlmAngleRad` as
  `config.localize3D ? null : (config.sSmlmAngleCenter||0)*Math.PI/180` — `null` selects free mode
  inside `gaussianMLEellipticangled`. **Chicken-and-egg gap**: the angle can only be FIT from an
  already-localized dataset's own pair geometry (position-only, any method works for that first
  pass), so unchecking `localize3D` for `'gaussmleEll'` is only meaningful as a SECOND Localize,
  after a first pass with a symmetric method feeds **Preview pairs**/**Fit dist. & angle**.
  `sSmlmAngleCenter` defaults to 0°, and unlike `mle3d` there's no calibration file to hard-gate on
  — a genuinely unset angle is indistinguishable from a real 0° bearing, so `runCore()` can only
  warn (`onLog`, once per Run, gated on `!config.localize3D`), not refuse, when
  `config.sSmlmAngleCenter` is still exactly its default.

  `mle3d` itself also respects `localize3D`: unchecked, it's an axis-aligned elliptical 2D fit
  (`gaussianMLEelliptic`, angle implicitly 0) with no calibration requirement and no z — useful on
  its own now that **export**'s `sigma_x`/`sigma_y [nm]` columns expose per-axis widths directly.
  Checked (default), behavior is unchanged from before this control existed: calibration required
  (`run()`'s `needCal` guard, mirrored in `analyze()`), z via `zFromWidths()`. `run()`'s `wcal` (and
  `analyze()`'s `wcalForRun`) are only built when `localize3D` is checked AND a `gaussian_width`
  calibration is present; `wcal`'s mere presence (not a second flag) decides whether
  `runCore()`/the worker/`showFrame()` call `zFromWidths()` at all, for both methods alike.

  The `cal3dRow` "Load calibration…" control sits directly under `localize3DRow`, showing only
  while BOTH `localize3D` is checked (or method is `phasor3d`) AND no calibration is active yet
  (`cal3d||cal3dW`) — `updateMethodUI()` re-runs after every calibration load/compute so the box
  disappears the moment one lands. No in-page "replace calibration" affordance yet; a fresh page
  load or Load-settings round-trip is the reset path.

- **render** — accumulates localizations into an offscreen buffer `srFull`; a `view` (zoom/pan)
  transform draws the visible region + scale bar. Colour maps, blur, and display scaling apply
  without refitting. `LUT_CPS` control-point maps: `fire`/`inferno`/`viridis`/`turbo` are smooth
  hue ramps for continuously-varying data (intensity, real 3D depth); `hsvBlue` is a closed-loop
  full hue cycle (240°→cyan→green→yellow→red→magenta→violet→240°, saturation/value pinned to 1) —
  unlike every other map here it's cyclic, so BOTH ends of the mapped range land on the same hue
  (blue) by design, not an artifact; **Pair** auto-selects it. `drawDepthBar()` (the on-canvas
  colour-scale strip) anchors to the actual DATA's own right edge and vertical centre
  (`srFull._locMaxXpx`/`_locMidYpx`, cached once per `rerender()` in native px, converted through
  the current `view`/zoom on each draw), falling back to the bare top-right canvas corner only if
  there's no cached extent — a fixed corner alone looked disconnected, since sSMLM's paired
  reconstruction is often a subset of a larger FOV. Ticks/labels extend left (into the panel) so
  they're never clipped by the canvas edge.

  `renderSuperRes()`'s accumulator buffers are DENSE, not sparse — one value per super-resolution
  pixel across the WHOLE `(w×mag)×(h×mag)` grid regardless of localization count, so memory scales
  as O(w·h·mag²), completely decoupled from data volume. `checkRenderSize()` runs before any
  allocation: refuses (throws) if either side would exceed `CANVAS_MAX_DIM` (16384, a hard
  per-browser canvas-creation wall) or if the estimated concurrent footprint (count/z accumulators,
  `blur()`'s scratch, the final `ImageData`, the canvas backing store) exceeds `memgb` — the SAME
  "Memory budget (GB)" setting stack loading uses. `rerender()` catches the throw, logs what to
  change, and leaves the PREVIOUS `srFull` on screen rather than blanking; the headless `analyze()`
  path lets it propagate. The count accumulator (`acc`) is `Uint16Array`, not `Float32Array` (a hit
  count is always non-negative, halving the footprint); `zacc` (summed z, fractional) stays
  `Float32Array`. `Uint16Array` WRAPS silently past 65535 on a naive `+=1`, so the increment is
  guarded explicitly (`if(acc[idx]<65535) acc[idx]++`) with a one-line saturation warning.

  **`renderMode`** (`PARAMS.renderMode`, default `'precision'`) picks how `renderSuperResPixels()`
  turns locs into pixels: `'precision'` splats each loc as its own bounded (±3σ) Gaussian sized by
  its real CRLB (`lpx`/`lpy`; `rblur` is the fallback width for a method with none, e.g. phasor) —
  Picasso's own default convention — with σ additionally capped at `MAX_SPLAT_SIGMA_PX` (6 SR-px)
  since the ±3σ bound alone doesn't stop σ itself (∝ precision×mag) from growing unbounded for a
  badly-localized outlier or high mag, which otherwise dominates render cost out of proportion to
  its share of the dataset (measured on a real 4.2M-loc dataset). `'fixed'` is the original
  behaviour: bin then apply one uniform blur (`rblur`) to the whole buffer — cost ∝ buffer area, not
  loc count. `'dither'` is a stochastic alternative to `'precision'` for large/dense datasets:
  jitters each loc by one seeded draw from N(0, its own σ) and bins — O(1)/loc instead of O(σ²)/loc,
  10-24x faster on real dense data (Average-Shifted-Histogram/Monte-Carlo-KDE argument: each loc is
  one sample from its own posterior, converging to the true density once many overlap) — but grainy
  on sparse data, so not the default. Buffer dtype/allocation (`renderSuperRes()`'s main-thread
  fallback AND the render worker's own copy) key off `renderMode` too: `Uint16Array` for
  `'fixed'`/`'dither'` (integer hit count), `Float32Array` for `'precision'` (fractional Gaussian
  mass); a mode switch must reallocate, never reuse the other dtype.

  `setupPlot(cv, isPlot=false)` (shared by every draw function on the raw/sr canvases) letterboxes
  a fixed 4/3 sub-rectangle, centred within the panel's own box, for plots — rather than changing
  the canvas's own size (a CSS-`aspect-ratio` approach was tried first and rejected: CSS Grid
  stretches both cards in a row to match whichever sibling is taller, so a panel's height ended up
  depending on the OTHER panel's content). The canvas's own CSS box always tracks `--frame-ar` (the
  loaded movie's own w/h); `isPlot=true` fills the whole canvas with `plotColors().bg`, computes a
  centred 4/3 sub-rect, stashes the offset in `_plotLetterboxOx/Oy`, and `ctx.translate()`s to it
  before returning the sub-rect's own W/H as if it were the whole canvas — so every plot-drawing
  function's own `{ctx,W,H}`-from-`(0,0)` code needed zero changes. `registerPlotHover()` folds the
  same offset into the `mL`/`mT` a caller hands it, since `drawPlotHover()`'s hit-testing reads
  real, untranslated `clientX`/`Y`. `drawRawView()`/`drawView()` never pass `isPlot`.

  `.panel-body` (wrapping a canvas with its trailing controls — `#scrubRow`/`#srFilterNote`/
  `#calViewRow`) is top-aligned, NOT centred, since raw/sr canvases are always the same height
  (both track `--frame-ar` unconditionally) — centring each panel's canvas+controls group
  independently shifted the two canvases out of vertical alignment by roughly half of whichever
  trailing control only one panel has. Top-aligning puts both canvases flush against their own
  `h4`, so any leftover height difference lands invisibly at the bottom of the shorter card.

  Every plot function reads colours from `plotColors()` (`{bg,grid,text,axis,bar}`) rather than a
  hardcoded hex value, driven by a module-level `_plotExportMode` flag. `false` (normal, on-screen)
  reads the values LIVE via `getComputedStyle(document.documentElement)` for
  `--panel`/`--line`/`--muted`/`--fg`/`--accent`, so plots automatically track whichever of the
  app's three UI themes (dark/light/contrast, see **params**' `applyTheme()`) is active. `true` — a
  completely separate, FIXED light palette, independent of the UI theme — only inside
  `exportPanel()`'s "plot" branch, which flips the flag, redraws once via the panel's
  `_replotRaw`/`_replotSr`, snapshots via `cv.toBlob()`, then flips back and redraws again: a saved
  PNG reads better on a white background regardless of which theme is active on screen. A few
  accent colours (fit-line green/red/magenta, the exponential-fit orange, marker red) stay
  hardcoded across every theme AND the export palette, chosen to read clearly against any of them.
  Raw-frame/reconstruction overlays (ROI boxes, fit crosshairs, the scale bar, the depth-colour bar)
  and the `LUT_CPS` colour-map dropdown are deliberately UNTOUCHED by the UI theme — they sit on
  top of arbitrary image/data pixels, not a themeable panel background; `drawPlotHover()`'s tooltip
  is the same way on purpose, since it's the SAME function used for the raw-frame pixel-value hover
  readout (`fmtRawPixel`), which does sit on arbitrary image content.

  **"Save plot/image"** (`saveImgBtn`, export module) offers SVG as well as PNG, but ONLY for the
  7 genuinely plot-shaped panels (calibration, drift, NeNA, FRC, PCFO, line-profile, the shared
  histogram) — never the raw frame or SR reconstruction, real pixel-density data with no
  meaningful vector form at real localization counts. No separate SVG button or in-page format
  picker: for a plot, `exportPanel()` delegates to `exportPlotEither()`, which renders BOTH a PNG
  blob and an SVG string ahead of time and hands them to `savePlotEither()`, which opens ONE native
  `showSaveFilePicker()` dialog listing both "PNG image" and "SVG image" as `types` — the OS/browser
  dialog's own "Save as type" dropdown becomes the format picker. Since the returned handle has no
  "which type was picked" field, the actual format is read back from the resolved file handle's own
  extension (`/\.svg$/i.test(h.name)`). Falls back to PNG when no native picker is available
  (Safari/Firefox, or `file://` without picker support). A raster panel still calls the single-type
  `saveBlob()` helper as before — `savePlotEither()` is a second, plot-only sibling to it.

  `SvgRecordingContext` (next to `setupPlot()`) is a small, purpose-built class that duck-types the
  exact Canvas2D surface those 7 functions use (paths/rects/circles/text/save/restore/translate/
  rotate/clip — no gradients, patterns, images or curves) and records real SVG DOM nodes instead of
  painting pixels — written from scratch rather than vendoring a general canvas→SVG shim.
  `save()`/`translate()`/`rotate()` each push a FRESH nested `<g>` rather than mutating the current
  group's own `transform` — an SVG transform applies to ALL of a group's children, so mutating an
  already-populated group would retroactively move siblings drawn *before* the call; pushing a new
  group per transform and having `restore()` truncate the stack back to the depth recorded at the
  matching `save()` reproduces real canvas transform-scoping exactly. `makeSvgPlotCanvas(w,h)` wraps
  a `SvgRecordingContext` as a plain object duck-typing the slice of `HTMLCanvasElement` that
  `setupPlot()` touches (`clientWidth`/`clientHeight`/`width`/`height`/`getContext`), so
  `setupPlot()` and all 7 plot functions run completely UNCHANGED against it. The redirection is one
  module-level `_plotTarget` variable, consulted by each plot function's own hardcoded
  `setupPlot($('raw'|'sr'), true)` call (`_plotTarget||$('raw')`) — `null` normally, set only for
  the duration of the SVG render inside `exportPlotEither()`; the PNG render in the same function
  still screenshots the real on-screen canvas directly. Reuses `_plotExportMode`'s light export
  palette and the existing `saveImgModal` left/right chooser when both panels have content — that
  chooser only decides WHICH window; format is decided downstream. SVG `<text>` stays real, editable
  text (not outlines), so it re-renders with whatever font is available on the *viewing* system — a
  known, accepted trade-off versus PNG's baked-in glyph pixels.

  **UI colour theme** (`applyTheme(name)`, params module, `dark`/`light`/`contrast`) is set via
  `[data-theme]` on `<html>`, driving ~17 CSS custom properties (`--bg`/`--panel`/`--line`/`--fg`/
  `--muted`/`--accent`/`--accent2`/`--warn`/`--danger`(+`-hover`)/`--surface`(+`-hover`)/`--deep`/
  `--scrollbar-thumb`(+`-hover`)/`--shadow`/`--scrim`/`--row-stripe`/`--accent-tint`) — three icon
  buttons in `.header-actions` switch it, `.active` marking the current one. Persisted via
  `localStorage` (genuinely new for this project — Save/Load Settings is explicit JSON, not
  localStorage; still 100% client-side) — every access wrapped in `try/catch`: a failed read falls
  back to `'dark'`, a failed write is silently ignored, no error ever surfaces. A tiny inline
  `<script>` right after `</style>` pre-sets `[data-theme]` from the same key before first paint to
  avoid a flash of the wrong theme; `applyTheme()` re-derives and re-applies the same value once the
  main script runs. Deliberately NOT a `PARAMS` entry — pure display/layout, same as sidebar
  collapsed/floating state.

  **Quick guide** (`helpBtn`) sits in the sidebar sharing `#tableBtn`'s row, right of **View
  data/filtering**, styled with its own bespoke `.helpbtn` look; `wireHelp()` finds it by
  `id="helpBtn"`, position- and class-independent.

  **`webSMLM_lastVersion`** (localStorage, same try/catch fail-safe as the theme) is a sibling of
  `webSMLM_theme`: on load it parses the release number (`vX.Y.Z`) out of the `<h1>` pill's own
  text and compares it against whatever was previously saved for this browser, logging
  `webSMLM updated: vA.B.C → vX.Y.Z — see what's new: <CHANGELOG.md link>` when they differ, since
  the single-file/no-auto-update design otherwise gives a returning visitor no signal that anything
  shipped between visits. Deliberately parses only the leading `vX.Y.Z`, never the full pill text —
  the pill also carries a `-dev · build YYYY-MM-DDx` suffix that changes on every build-letter bump.

  `axisScale(maxAbs)` gives an axis whose values commonly run large, matplotlib-style "offset
  notation": ticks show a small (single digit + one decimal) scaled number, with a single `×10ⁿ`
  multiplier drawn once near the axis (`n = floor(log10(maxAbs))`). Lives in **render** (not
  `drawPcfoPlot()`, the one plot currently needing it) so any other plot with the same large-number
  problem can reuse it.

  **`drawAxisScaleLabel(ctx,scale,x,y,align)`** (v0.12.1-dev, right after `axisScale()`, reported —
  the exponent read too small and cramped against "10") replaces relying on `axisScale()`'s own
  Unicode-superscript `label` string (⁰¹²³…) for the standalone `×10ⁿ` chip each of the 3 call sites
  (`drawPcfoPlot()`/`drawSmfretTrace()`/`drawHistogram()`) used to draw with one plain `fillText()`.
  The Unicode superscript block's own glyph metrics run noticeably smaller/tighter than a real
  superscript in most fonts — no amount of bumping the SHARED font size fixes that, since both "10"
  and the exponent character share it. Fixed by drawing the label as two separately-sized pieces
  instead: "×10" at the caller's own font size, then the exponent as a PLAIN digit string (not the
  Unicode glyph) at a dedicated, clearly-larger-than-the-Unicode-glyph size (10px against a 12px
  base), raised above the baseline with an explicit gap after "10" — a manual superscript, full
  control over both size and spacing rather than trusting a font's own superscript rendering.
  `axisScale()` itself now also returns the raw numeric `exp` (alongside the still-present `label`,
  which the one EMBEDDED usage — `drawPcfoPlot()`'s own x-axis title, `xScale.label` woven into a
  bigger `fillText()` call — still reads directly, left as Unicode superscript since splitting THAT
  usage into pieces would need measuring/positioning around the surrounding text too, out of scope
  for this round). All 3 standalone call sites' identical `ctx.fillText(yScale.label,...)` line
  replaced with `drawAxisScaleLabel(ctx,yScale,mL,mT-8,'right')` — one shared implementation instead
  of the same block duplicated three times.

  **`GAP` corrected from `2` to `0` the same day** (reported, with a screenshot, immediately after
  the first version shipped — "this is not how a scientific superscript should look like, bring
  closer to trailing number"): 2px read as a visibly floating, disconnected digit, not a real
  superscript sitting close against "10". A real scientific superscript's exponent sits immediately
  adjacent to (often slightly overlapping) the preceding character — `GAP=0` reproduces that.
  Verified visually (a dedicated offscreen canvas, screenshotted at 6x device scale for a crisp
  close-up) against both the reported-bad `GAP=2` rendering and the corrected `GAP=0` one — the
  latter reads as an ordinary "×10⁴" the way a textbook would set it, the former as "×10 ⁴" with a
  visible gap.

  **`GAP` corrected AGAIN, to `-2`** — even `0` still read as too far apart (reported a second
  time). A real superscript glyph commonly overlaps the preceding character's own right-side
  bearing slightly, which `GAP=0` (flush advance-width positioning, no overlap) doesn't reproduce —
  `-2` does. Re-verified the same way (offscreen canvas, 6x-8x device scale close-up): the exponent
  now visibly sits tucked against/over the "0", matching a textbook's own tight scientific notation.

  Every plot draws a real L-shaped axis border (left + bottom, `C.text`) plus a short (5px)
  outward-facing tick mark at each major tick, on both axes. The border is drawn LAST, after the
  data, so bars/points flush against an axis edge (NeNA in particular) can't be covered by it. Tick
  labels shift outward by the same 5px to clear the marks.

  The side-by-side/stacked panel layout (`.canvases.stacked`, single column) is resolved by
  `applyLayout()`: `layoutOverride` (module-level, `null`/`true`/`false`) takes precedence over the
  `frameAspectWH.h/frameAspectWH.w<0.5` auto-heuristic once the user clicks **Stack panels**/**Side
  by side** (`layoutToggleBtn`), and sticks across further loads this session. `setFrameAspect(w,h)`
  is the single place that sets `frameAspectWH`, the CSS `--frame-ar` custom property, AND calls
  `applyLayout()` — `initScrub()` calls it with the loaded stack's own `w`/`h`; a CSV load
  (`csvFile`'s change handler, MODULE: table) calls it with `parseCsvLocs()`'s own bounding-box
  `w`/`h` instead, since there's no stack in that path. The reconstruction's own bounding box is
  always somewhat smaller than the original camera FOV (border-adjacent localizations are dropped
  during fitting).

  **`parseCsvLocs()` NEVER shifts loc coordinates** — `(0,0)` always means the same physical camera
  pixel it meant in the original file/session, full stop.

  **Raw-frame display contrast** (`rawBlack`/`rawWhite`, the Contrast slider, Picasso-inspired) is
  a FIXED [black,white] ADU range applied identically to every frame by `drawRaw()`, replacing an
  earlier per-frame auto-stretch that made brightness/contrast visibly shift as you scrubbed and let
  a single dead/hot pixel dominate a frame's own min or max. `estimateRawContrastRange(stack)`
  (called once right after a stack loads) establishes the slider's bounds/initial handles by
  sampling a bounded number (50) of seeded-random frames — the same `pickSeededFrames()` PCFO's own
  gain/offset estimate uses — a reasonable trade-off for a display convenience, not a measurement.
  `applyCropToRaw()`/`uncropRaw()` each make this same call too, right before `showFrame(0)`, since
  a crop/uncrop swaps `stack` for a genuinely different pixel population. Deliberately excluded from
  `PARAMS`/Save-Load Settings/the headless `analyze()` config — same "pure display/layout" carve-out
  as UI theme and sidebar state — a display convenience local to one interactive session.

  **`rerender()`/`srNmPerPx()` guard against `lastResult` going null mid-render** — a genuine,
  pre-existing async race, found (not introduced) while Playwright-testing the terminal's new
  GUI/terminal parity work (see **pipeline**): `rerender()`'s own EARLY `if(!lastResult) return;`
  only catches `lastResult` already being null before the call starts; it can just as easily go null
  DURING the `await renderSuperRes(...)` inside it, since `applyCropToRaw()`'s own
  `resetAfterCropChange()` (a crop/uncrop/fresh load) nulls it SYNCHRONOUSLY, with no render of its
  own to wait for. The existing `mySeq!==_srRenderSeq` staleness check right after that await now
  also bails on `!lastResult` — exactly the same reasoning as its `mySeq` half: if the result this
  render was FOR is gone, the render itself is moot. `srNmPerPx()` gets the matching guard
  (`srIsRecon && lastResult`, not `srIsRecon` alone) for the same reason, since `drawView()`'s own
  call to it can run from that same stale, still-in-flight completion callback. A real click-driven
  session rarely lands two actions close enough together in time to hit this (confirmed: a genuine
  two-click raw-panel crop via Playwright never triggered it); the log terminal's own back-to-back
  scripted calls (Localize immediately followed by a crop, both fired programmatically with no human
  reaction time in between) reproduced it reliably before this fix, not after — verified by 3 repeated
  runs with zero page errors post-fix, versus 100% reproduction pre-fix.
- **workers** — frame-parallel detect/fit (see below).
- **export** — ThunderSTORM-compatible CSV. `photons`/`bg`/`bgstd` are already true photon units
  by the time they reach export (gain/offset applied inside the fit, see **fit**), so export/the
  table histogram do no further conversion — they read `gain`/`camoff` only to log a "gain 1 /
  offset 0" warning when a user hasn't set real camera values. `"sigma_x [nm]"`/`"sigma_y [nm]"`
  (CSV) and `sigma_x`/`sigma_y` (table) are optional columns, present whenever ANY loc carries a
  real per-axis width (`isFinite(L.sx)&&isFinite(L.sy)`, i.e. the Run used `mle3d` or `gaussmleEll`)
  — independent of `sigma1st`/`sx0th`/`sy0th`/`sx1st`/`sy1st` (sSMLM-pair-specific; these are
  per-loc, paired or not). `parseCsvLocs()` reads them back into `L.sx`/`L.sy` for a round trip.
  `"angle [deg]"` (CSV) / `angle` (table) is the same kind of optional column, present only when
  `gaussianMLEellipticangled` set `L.angle` (radians on the loc, converted to/from degrees at the
  CSV/table boundary) — the fitted ellipse rotation itself, previously computed but never surfaced
  anywhere: with `localize3D` checked it's a genuine per-emitter angle, with it unchecked every loc
  shares the same FIXED `sSmlmAngleCenter` value (still exported, but not a per-emitter measurement).
  **Required a real fix**: the worker pool's message protocol only packed `x,y,photons,bg,bgstd,
  sigma,z,zClamped,frame,lpx,lpy,lpz` (12 floats) per loc — `sigma` (`(sx+sy)/2`) but never `sx`/`sy`
  themselves — so a worker-pool Run silently lost per-axis width entirely, even though the
  single-threaded fallback (`locs.push(L)` directly) always kept it. Widened to 14 floats (`sx`,`sy`
  appended, `NaN` for methods that don't fit them) at all three sites that must move together — the
  worker's own `out.push(...)`, and both `wk.onmessage` unpack loops (the plain pool-dispatch loop
  and the FTM barrier-phased loop, which duplicate this on purpose, see **in/out**'s FTM entry) — a
  stride mismatch between any of the three is a silent data-corruption bug, not a crash. Widened
  again to 15 floats (`angle` appended, radians, `NaN` unless the Run used `gaussmleEll`) so the
  fitted ellipse rotation survives a worker-pool Run too — same three-site convention, same risk.
- **3D calibration** — astigmatic: σ_x/σ_y vs z bead curves, JSON save/load. Astigmatism is the
  only method implemented; other 3D approaches (Double Helix, Biplane) would live here too.
  `calibrationCore()` takes the same `shouldStop` hook `runCore()` (Localize) does, checked at the
  same yield point as its progress/preview callbacks (a Stop click can only be observed while
  yielding); `runCalibration()` enables `stopBtn` and resets `stopRequested` the same way `run()`
  does.
- **drift** — AIM (adaptive intersection maximization), point-based, 2D+z. `drawDriftCurve()`'s
  own green (`#0a7d32`)/magenta (`#c81cc8`)/blue (`#3572b0`) drift-x/y/z palette is treated as the
  project's reference colour pairing — other plots' own green/magenta curves (NeNA, **spt**'s
  track-length fit) were retroactively matched to it so a colour means the same thing across plots.

  `drawDriftCurve()` is a thin dispatcher over two plot functions, chosen by module-level
  `driftPlotMode` (`'frame'` default, or `'xy'`): `drawDriftCurveVsFrame()` is x/y/(z) vs frame
  index; `drawDriftCurveXY()` is a single trajectory (drift y vs drift x), each segment coloured by
  frame (time) through `getLUT(paramValue('lut'))`.

  **Stop support** (v0.11.10 — AIM's two rounds can take a while, and a user tuning
  `driftSeg`/`driftRoi` wants to see the curve to judge settings before a run they might discard).
  `aimDrift2D()`/`aimDriftZ()`'s two rounds are checked against `shouldStop()` per segment; Round 1
  is inherently sequential (`dx[k]` depends on `dx[k-1]`), so a stop there truncates to a genuine
  prefix of correctly-estimated segments. Round 2 needs EVERY segment's round-1 result to build its
  `full` reference, so a Round-1 stop skips Round 2 entirely; a Round-2 stop keeps whatever segments
  it already re-estimated and falls back to each remaining segment's own round-1 value. `fdx`/`fdy`
  stay sized to the FULL requested frame range regardless, reusing the existing tail-interpolation
  logic past the stop point, with `stopped`/`stoppedAtFrame` on the result so `driftCore()` and the
  interactive plot can tell a genuine measurement from the flat continuation. `driftCore()` treats a
  stop in EITHER the 2D or z pass as the WHOLE run being incomplete — never applying a complete 2D
  correction alongside a partial/missing z one — and skips applying ANY correction to `locs` in that
  case, exactly as if Correct drift had never been clicked. `correctDrift()` still shows the partial
  curve (dashed vertical marker + "stopped here — flat beyond" label, `rawInfo` leading with
  "PREVIEW ONLY, not applied") so judging convergence still works without committing. Headless
  `analyze()` never passes a `shouldStop` hook, so `stopped` is always `false` there.

  **`driftSamplePct`** ("AIM sample %", default 100, v0.11.11 — AIM becomes slow on a large
  dataset). `bestShift()` iterates its `(2R+1)²` shift-search grid once per OCCUPIED BIN of the
  segment being aligned — not per raw point, and not against `ref`'s size — so fewer points in that
  segment directly cuts both this loop and the bin-map build, roughly proportional to the
  percentage. `subsampleSegments(seg, samplePct)` does the actual thinning, called from both
  `aimDrift2D()` and `aimDriftZ()` after their per-segment grouping — mutates `seg` in place, one
  shared seeded RNG (`mulberry32(AIM_SAMPLE_SEED)`) across the whole call so a given (locs order, %)
  pair always samples the same points (same precedent as **spt**'s `getVisibleTracksForOverlay()`).
  Unlike that overlay sampling, this is NOT purely cosmetic: fewer points means noisier
  histogram-intersection counts feeding the sub-pixel parabolic peak fit, trading real estimation
  precision for speed — default stays 100. `AIM_SAMPLE_FLOOR` (200) guards the failure mode: a
  segment already at or below the floor is left untouched, and an above-floor segment falls back to
  its full point set if post-sampling count would drop below the floor — verified against synthetic
  linear-drift ground truth (300k pts, 100 segments): 20% sampling raised drift-estimate RMS error
  only modestly (3.94→4.41 px), while 5% (below the floor) correctly fell back to the full segment
  and reproduced the 100% result exactly.

  **Round 2's own reference used to include the segment being aligned, so it could never revise
  round 1 — fixed via leave-one-out** (Hazen Babcock, [issue #9](https://github.com/HohlbeinLab/webSMLM/issues/9),
  2026-09-06, independently re-verified against this exact code before applying). `aimDrift2D()`'s
  round 2 builds `full` from EVERY segment's own round-1-corrected position, then scores each
  segment `k` against `full` via `bestShift()`'s histogram-intersection search
  (`t=Σ min(cs[i],ref)`). Since `full` already contains segment `k`'s own contribution (added in the
  very loop that builds it), at segment `k`'s own round-1 position every one of its bins has
  `ref>=cs[i]`, so `min(cs[i],ref)=cs[i]` there — the score is `Σcs[i]`, the fixed total no OTHER
  shift can ever exceed (`min(cs[i],ref)<=cs[i]` always). Zero additional shift therefore always
  attains the maximum, whatever round 1's own estimate actually was — round 2 could only ever
  contribute the sub-pixel parabola term on top of an unquestioned round-1 value, never correct a
  real round-1 error, no matter how large. **Reproduced exactly**, independently, before touching any
  code: built a synthetic 20-segment/60-locs-per-segment dataset (realistic camera-FOV spatial scale,
  not a toy few-hundred-nm box — an early reproduction attempt used too small a synthetic FOV
  relative to the 15 nm bin size, causing accidental cross-site bin collisions that masked the bug
  entirely; widening the FOV to a realistic scale reproduced it cleanly), injected a deliberate 60 nm
  (4-bin) error into one segment's own round-1 estimate — the unpatched code recovered it as `0.00
  nm` (left in place, matching the issue's own independently-reported `-0.001 bins`), confirming the
  diagnosis is exactly right, not just plausible. **`picasso/aim.py` has the identical
  self-referential round 2** (passes the corrected set as both target AND reference for its second
  pass, same `min()`-based scoring) — so this is a deliberate DIVERGENCE from the reference
  implementation this codebase otherwise tracks closely, not a port of an upstream fix; not yet
  reported to the Picasso project as of the issue thread.

  **Fix**: `subFrom(map,list,ox,oy)` (next to `addTo()`, its exact inverse — decrements a bin's count,
  deleting the key entirely once it would reach 0, matching `addTo()`'s own "absent key means 0"
  convention) removes segment `k`'s own contribution from `full` immediately before scoring it, then
  `addTo()` restores it immediately after — O(segment size) per segment (O(N) over the whole round),
  not the O(nSeg²) an actual per-segment full-rebuild would cost. Re-verified against the SAME
  injected-error reproduction above: the patched code recovers the 60 nm error to within 0.08 nm
  (`-60.08` vs. the true `-60`), matching the issue's own reported `-4.00 bins` recovery almost
  exactly. **A genuinely new failure mode this fix would otherwise introduce, caught before
  shipping** (not present in the issue's own proposed patch, which doesn't touch `bestShift()`
  itself): leaving segment `k` out of `full` can leave it EMPTY of any real evidence at all — most
  simply, `nSeg===1` (no other segment exists to align against), but also possible whenever a segment
  is the sole occupant of its own spatial footprint. `bestShift()`'s own grid search then ties every
  candidate shift at `t=0`, and the scan's strict `t>best` comparison silently resolves that tie to
  whichever shift was tried FIRST — the search window's own `(-R,-R)` corner — a spurious, systematic
  bias with zero real evidence behind it (the same failure SHAPE as round 1's own now-fixed
  empty-segment bug, see this module's own `frame0` comment above, just reached a new way). Closed
  with one shared guard inside `bestShift()` itself (both the 2D and z copies): `if(best<=0) return
  [0,0]` (`return 0` for z) — "no real alignment evidence" means "don't move this segment," not "pin
  it to a search-window corner." Verified directly: a synthetic single-segment (`nSeg===1`) call to
  `aimDrift2D()`/`aimDriftZ()` returns `segdx=segdy=[0]`/`segdz=[0]` post-fix, not a corner-pinned
  spurious value.

  **The issue itself only covers `aimDrift2D()`'s 2D case — `aimDriftZ()`'s own round 2 has the
  IDENTICAL `full` self-inclusion bug**, unaddressed by the issue's own proposed patch (its 1D
  `addTo()`/`bestShift()` are structurally the same shape as the 2D versions, just single-valued bin
  keys instead of `KEY(bx,by)`-hashed pairs). Fixed the same way — a 1D `subFrom()`, the same
  `subFrom`/`bestShift`-call bracketing in z's own round 2 loop, and the identical `best<=0` guard in
  z's own `bestShift()` — so 2D and z drift correction stay consistent rather than one silently
  keeping the bug the other just fixed. Verified with an analogous synthetic multi-segment z dataset
  (real recovery, no exceptions) and the same `nSeg===1` degenerate-guard check.
  Verified end-to-end via Playwright (Simulate movie → Localize → Correct drift) with zero page
  errors, confirming the interactive path is unaffected by any of the above.

- **locprecision** — NeNA (localization precision, Endesfelder fit) and FRC (image resolution,
  inline radix-2 FFT). Marked **experimental**, not yet cross-validated against established tools.
  `drawNenaPlot()`'s two overlaid curves are green (`#0a7d32`, the FULL Endesfelder fit — signal +
  short-range + long-range terms) and magenta (`#c81cc8`, the signal-Rayleigh term alone).

- **sSMLM** — spectrally resolved SMLM: pairs 0th/1st-order localizations from a diffraction
  grating. **The sidebar section label is prefixed "(Caution!)"** (v0.12.1-dev, requested — a
  plain visual warning, no internal renaming: the id stays `sSmlmBox`, nothing keys off the exact
  summary text), since the pairing approach implemented here is a specific method with real
  assumptions (directional role assignment, a single configured bearing/tolerance), not a
  general-purpose technique — see **smFRET**'s and **spt**'s own module bullets for the same label
  on the other two experimental/approach-specific sections. Ported from
  [`HohlbeinLab/sSMLMAnalyzer`](https://github.com/HohlbeinLab/sSMLMAnalyzer);
  Martens et al., *Nano Lett.* 22(21), 8618–8625, 2022). Role assignment (which point of a pair is
  0th vs 1st) is **directional, not brightness-based** — real-data investigation found photon count
  barely correlates with position (≈50/50 even at confident intensity gaps, likely PSF-overlap/
  crowding at real emitter densities), so `sSmlmAngleCenter` is a genuine SIGNED bearing (full
  ±180°) and `pairCore()` classifies each candidate by direction into `outEdges`/`hasIncoming`
  maps: a point qualifies as 0th order only if it has ≥1 outgoing edge (a candidate on the
  configured bearing) AND zero incoming evidence (opposite bearing, more likely someone else's 1st
  order) — self-disqualifying, no brightness needed. PSF width (σ, broader for the spectrally
  smeared 1st order) showed only ~65–70% correlation with role — too unreliable to gate on, so
  it's reported (`sigma1st`, below) but never used to filter. An optional `sSmlmRequireNarrower`
  extra-confidence gate built on this correlation was REMOVED (requested — "rarely does anything")
  after direct confirmation it was already default-OFF and only ever a weak, optional filter, never
  load-bearing for correctness; `pairCore()`'s own `best=edges[0]` selection (closest-to-expected-
  bearing wins) is now unconditional, with no sigma-based override. **2-point pairs only** (0th+1st)
  — multi-order chaining and FFT-based angle/distance auto-detection are `docs/REFACTOR_PLAN.md`
  follow-ups; the interactive **Preview pairs** distance/angle histograms
  (`computeHist()`/`drawHistogram()` from **table**) cover "find my window" instead — always
  fetched over a WIDE fixed scan (0–6000 nm, any angle), ignoring the current field values, so
  narrowing either one first can't hide the true peak. The **angle** histogram, unlike the distance
  one, restricts to the current distance window (angle signal is only sharp within the real peak)
  and plots each candidate's `rawAngle` AND its exact reverse (`+180°`) — which of a candidate's two
  points gets the smaller array index (and so which direction `rawAngle` reports) is a row-order
  accident, not evenly split in real data, so plotting only the raw bearing looks wildly asymmetric;
  doubling it makes the two peaks equal. The angle-fitting half of `fitSSmlmDistAndAngle()`
  (**Fit dist. & angle**, see below for the distance-fitting half added in the same round)
  estimates `sSmlmAngleCenter`/`sSmlmAngleTol` from that same data — 2°-bin peak detection +
  half-max-width walk, THEN DOUBLED as a safety margin (the raw half-max width alone came out ~1°
  against real data, vs. the ~5° that actually worked by hand). Both histograms draw the currently
  configured
  window as markers (`computeHist()`'s optional 4th `markers` param), refreshed live on field edits
  and after a fit via `refreshSSmlmHistIfShown()`. **Its own "is the sSMLM histogram currently
  showing" check was stale** (reported: Fit angle & tol. updated the log/fields but not the Angles
  plot) — the polar angle plot (`drawSSmlmAnglePolar()`, below) never sets `rawPlotName`/`histData`
  at all (only the distance histogram, via `drawHistogram()`, does either), so the old
  `rawPlotName!=='histogram'||!histData` guard always bailed out whenever the angle view was the one
  on screen. Fixed by checking `$('rawTitle').textContent==='sSMLM histograms'` instead — the one
  thing `drawSSmlmHist()` sets unconditionally for BOTH modes — then just calling `drawSSmlmHist()`
  itself, which already re-dispatches to whichever mode (`sSmlmHistMode`) is current and re-reads the
  live angle fields; no other change needed. Verified via Playwright: with the Angles plot showing,
  clicking **Fit dist. & angle** now visibly redraws it at the new center/tolerance (confirmed via
  a changed canvas checksum), not just the log line and the underlying fields.

  **`fitSSmlmDistAndAngle()` also fits the DISTANCE histogram now** (renamed from `fitSSmlmAngle()`;
  button relabelled **Fit angle & tol.** → **Fit dist. & angle**, requested — previously
  `sSmlmDistMin`/`sSmlmDistMax` had to be set by eye, with no fit at all). A two-component mixture:
  a theoretical **background** term — the PDF of the distance between two independent, uniformly
  random, UNPAIRED points confined to the region the localizations actually occupy — plus a
  **Gaussian signal** term on top, the real distance between an emitter's spectrally-split 0th/1st
  order images. New `PARAMS.sSmlmBgProfile` (`'rect'`/`'circle'`, default `'rect'`, **Background
  profile** dropdown next to Distance min/max) picks the background's shape — real optical setups
  vary (a rectangular camera FOV vs. a circular field-stop/aperture) and this isn't reliably
  inferable from the point cloud alone, so it's a plain user choice, not auto-detected.

  **The two background formulas** (`sSmlmBgPdfRect(v,a,b)`/`sSmlmBgPdfDisk(r,R)`, right before
  `fitSSmlmDist()`) were independently verified — Monte Carlo simulation, numerical integration to
  1.0, and (rectangle) exact reduction to the standard "square line picking" formula at `a=b` —
  before being transcribed into code, not taken on faith from a single secondary source:
  - **Rectangle** (sides `a≤b`, domain `0<v≤√(a²+b²)`, 3 pieces): Philip, J. *"The Probability
    Distribution of the Distance Between Two Random Points in a Box."* Technical Report
    TRITA-MAT-07-MA-10, Dept. of Mathematics, KTH, Stockholm, 2007 (§4, "The two-dimensional
    distribution" — the report's own real target is the 3D box case; the 2D rectangle used here is
    its intermediate result). **A real citation error caught before shipping**: this report is
    widely mis-cited as "1991" (including in the request that prompted this feature) — reading the
    primary source directly (recovered via the Wayback Machine, the live KTH mirror having gone
    404) showed "1991" is the year of the unrelated AMS *Mathematics Subject Classification* scheme
    referenced in a footnote on the SAME title page, not the report's own publication date; the
    report is internally dated 2007 (cites Bailey/Borwein/Crandall 2007, uses Maple 10), matching
    the "07" in its own report number. A DOI the user separately proposed for this citation
    (`10.1038/s41592-023-02149-7`, the TARDIS paper — Martens et al., *Nat. Methods* 2024, same lab)
    was checked and dropped: its own Supplementary Information explicitly states a continuous
    background formula does NOT work for real ROIs and uses an empirical histogram instead — it
    neither contains nor cites this formula.
  - **Disk** (radius `R`, domain `0≤r≤2R`, single piece, no breakpoints): Solomon, H. *Geometric
    Probability*, SIAM, 1978, p. 129 (via Wolfram MathWorld "Disk Line Picking") — verified the mean
    matches the known closed-form constant `128/(45π)` to 10 significant digits.

  **`sSmlmBoxDims()`** derives `(a,b)` from the ACTUAL localization bounding box
  (`sSmlmOriginalLocs`, the same raw pairing input `pairCore()` itself always reads from — min/max
  x,y, native px → nm via `lastResult.px`) rather than the full camera FOV: the background model
  assumes molecules are roughly uniform over the region they actually occupy, and an unused camera
  margin (a crop, or a sparse sub-region of the chip) would bias a full-FOV box size upward,
  understating the true background density. For the circular profile, `R` is the EQUIVALENT-AREA
  disk radius from that same bounding box (`R=√(a·b/π)`) — a standard, parameter-free way to convert
  a rectangular extent into a disk radius when there's no independent aperture measurement.

  **`fitSSmlmDist(d,y,bgPdf)`** mirrors `fitNeNA()`'s own Levenberg-Marquardt engine exactly (same
  `solveLin()`-based per-iteration solve, same damping/back-off loop shape) rather than inventing a
  new pattern — see that function's own comment (MODULE: locprecision) for the general shape. Only
  4 free parameters (`p=[A_bg,A_sig,mu,sigma]`), fewer than NeNA's 6, because `a,b`/`R` are FIXED
  (computed from data, not fit) — the background term's only free parameter is its own linear
  amplitude (`∂/∂A_bg = bgPdf(x)`, trivial); the signal term's own amplitude/mu/sigma derivatives are
  the same standard Gaussian ones `fitNeNA()`'s own `dSds`-adjacent code already shows the pattern
  for. Verified on synthetic data (rejection-sampled uniform points in a real rectangle/disk, plus a
  known Gaussian signal mixed in) via `osascript -l JavaScript`: recovered `mu`/`sigma` within ~2%
  of ground truth for the rectangle case, ~10% for the disk case (a smaller synthetic
  signal-to-background ratio in that test, not a flaw in the disk formula itself, which passed its
  own independent integration/mean checks above).

  **Seeding is TWO-STAGE, not "tallest bin = signal"** — a real, reported bug on real data: the
  ORIGINAL seed (`mu0` = the histogram's own tallest raw-count bin, `A_bg0` = the median of
  `y/bgPdf(x)` over bins far from that bin) worked on every dataset tested during development
  (small synthetic mixtures, the smFRET SOI dataset), but broke on a real, denser Localize run on
  the ALEX/prism dataset (733 localizations → 61,358 wide-scan candidates — reproduced exactly,
  down to the candidate count, once pointed at it): the background itself keeps RISING across the
  whole scanned range (Preview only scans out to 6000 nm, well short of the box's own diagonal), so
  the histogram's own GLOBAL maximum is just the background's own rising front at the domain's far
  edge — nothing to do with the real, much smaller signal peak. Seeding `mu0` there sent LM into a
  degenerate fit (`sigma` collapsing toward its floor near the WRONG end of the domain), which then
  set Distance min/max to a near-empty window — and since the angle fit's own candidate filter
  reads THAT window, the Angles histogram came back completely empty (`n=0`), not just a bad
  distance fit. Fixed with a proper two-stage seed that needs no prior guess at `mu`/`sigma` at all:
  (1) estimate `A_bg0` FIRST from the 20th PERCENTILE (not the median — a signal peak spanning many
  bins can still bias a median upward) of `y[i]/bgPdf(d[i])` across ALL bins — bins with extra
  signal only ever push this ratio UP, never down, so the low end of the ratio distribution is
  background-dominated regardless of where the real signal sits; (2) subtract that estimate off
  every bin (`resid[i]=max(0,y[i]-A_bg0·bgPdf(d[i]))`) and seed `mu0`/`sigma0` from the PEAK OF THE
  RESIDUAL, not the raw counts — this directly targets "excess over background" instead of
  whichever end of the domain the background's own shape happens to be largest at. Verified via
  Playwright against the real reproduction case: Distance min/max now land on a real, narrow window
  (343–677 nm, `mu≈510`, `sigma≈56`) instead of a near-empty one, and the subsequent Angles
  histogram shows a real, non-empty peak (4,096 values, previously 0).

  `sSmlmGaussBump(x,mu,s)` (an UNNORMALIZED peak-height-1 Gaussian, same convention `fitNeNA()`'s own
  `G()` uses for its correction term) is shared between `fitSSmlmDist()`'s model/Jacobian and
  `drawSSmlmHist()`'s own curve overlay, so the two can never drift apart. The fit result
  (`sSmlmDistFit={p,bgPdf}`, module-level, `null` until a fit has run) is consumed ONLY at draw time
  — `drawSSmlmHist()`'s dist-mode branch re-evaluates `histData.curve = x=>p[0]*bgPdf(x)+
  p[1]*sSmlmGaussBump(x,p[2],p[3])` fresh on every draw (never baked in), reusing
  `drawHistogram()`'s existing single magenta `curve` overlay slot with NO changes needed to that
  shared function.

  **A real, reported bug looked exactly like the seeding bug above, but wasn't**: the curve appeared
  to shoot up near `v=0` and exceed the chart's own y-range within the first ~100 nm — the SAME
  visual signature the seeding bug produced — but on this dataset (already re-verified end to end
  after the seeding fix) the fit itself was genuinely correct (`mu=510`, matching the real 979-count
  peak bin at 512 nm almost exactly: `p[0]*bgPdf(510)+p[1]*sSmlmGaussBump(510,510,56)=977.8`). The
  curve-attachment line originally read `x=>bw*(p[0]*bgPdf(x)+...)` — an EXTRA, wrong `bw*`
  multiplication, justified at the time by a false claim ("same convention `fitTrackLifetime()` uses
  for its own curve overlay") that re-reading that function immediately disproved: it fits its own
  `A` directly against raw bin counts too (`y=Math.log(c)` in its own weighted-least-squares loop)
  and its own `histData.curve=x=>fit.A*Math.exp(-x/fit.tau)` has NO bin-width factor either.
  `fitSSmlmDist()`'s `p` already comes out in "counts per bin" units for the identical reason (its
  own `cost()`/`jac()` compare `f(d[i],p)` directly against `y[i]`, never a density) — multiplying by
  `bw` again inflated the curve by the bin width itself (~79 nm here) for NO reason, pushing it off
  the chart almost immediately and making a correctly-converged fit look exactly like the earlier,
  genuinely-broken one. Removed; verified via Playwright that the curve now stays within the real
  bars' own scale everywhere (max ~1330 at the domain's far edge vs. a real bar max of 1648) and
  shows a clean, narrow signal spike sitting inside the Distance min/max window, not a runaway rise
  from the origin.

  Invalidated (`sSmlmDistFit=null`) on a fresh **Preview pairs** run (a new
  candidate set, and possibly a changed bounding box) and on a **Background profile** change (a
  fit against the WRONG region-shape assumption shouldn't keep decorating the plot) — NOT at every
  one of the ~9 "reclaim the whole SR panel" reset blocks `alexProjToggleBtn` itself is hidden at,
  matching the EXISTING precedent that `sSmlmLastCands` itself is never proactively cleared there
  either (the relevant buttons — `sSmlmHistBtn`/`sSmlmFitAngleBtn` — already get `disabled` at those
  same points, which is what actually prevents a stale fit/histogram from being reachable).

  `fitSSmlmDistAndAngle()` fits distance FIRST, writing `sSmlmDistMin`/`sSmlmDistMax` to the DOM
  immediately (`mu∓3σ`, clamped to `[0,PARAMS.sSmlmDistMax.max]`) — a documented STARTING window,
  not a validated constant the way the angle fit's own `±5°`/half-max-doubling is (no real-data
  calibration exists yet for distance), deliberately generous (~99.7% of a Gaussian) rather than
  tuned. The angle-fitting half then runs SECOND and reads `paramValue('sSmlmDistMin'/'Max')` live,
  so it restricts to the JUST-FITTED distance window rather than whatever was there before — the
  angle fit's own pre-existing distance-window restriction (above) composes correctly with zero
  extra plumbing. Also gained a `logCmd()` call (the old `fitSSmlmAngle()` had none at all — a real,
  reported-adjacent gap, not present before this round) via `overrideWithFields()`, same convention
  every other bare-function terminal-callable action in this module already uses.

  **The distance histogram's own min/max markers are directly draggable** (requested) — a dedicated
  IIFE (MODULE: table, physically right before the existing "Column-histogram X-axis zoom" IIFE)
  hit-tests a `pointerdown` against both marker's current on-screen position (`valueToPx()`,
  correctly folding in `setupPlot()`'s own 4:3 letterbox offset `_plotLetterboxOx` the same way
  `registerPlotHover()` does — the OTHER zoom/pan IIFE's own `dataX()` doesn't bother, fine for a
  symmetric pan but would silently misplace an absolute hit-test like this one). **Must be
  registered BEFORE that other IIFE, not just given `{capture:true}`**: for a pointerdown dispatched
  directly ON the target element (not a descendant), listeners fire in REGISTRATION order regardless
  of the capture flag — there's no real capture-vs-bubble distinction once
  `target===currentTarget`. Registering this block first is what lets its own
  `e.stopImmediatePropagation()` actually pre-empt the other IIFE's pointerdown when a press starts
  on a marker; capture-phase-but-registered-after was tried first and silently lost the race (caught
  by an explicit regression check: the OTHER histogram types' own zoom stopped responding once
  verified against a real page — Playwright's synthesized pointer events couldn't validate plain
  drag-to-pan at all, even on a completely unmodified baseline, so wheel-zoom was the actual
  regression signal used). During a drag, only a cheap `drawSSmlmHist()` redraw runs per
  pointermove (it re-reads the live field value directly, no event needed) — the real `change`
  event fires exactly once, on release, so whatever else reacts to `sSmlmDistMin`/`Max`
  (`syncSSmlmZRangeFromDist()`'s possible `rerender()` if already paired) doesn't run on every
  pointer tick. Clamped so one marker can't cross the other (`MIN_SEPARATION_NM`) or leave
  `PARAMS.sSmlmDistMin`/`Max`'s own bounds. Hovering near a marker (no press) sets
  `cv.style.cursor='ew-resize'` as a grabbability affordance a canvas-drawn line doesn't get for
  free otherwise.

  **`sSmlmHistBtn`** ("Show histograms") is one button covering both the distance and angle
  histograms, with `sSmlmHistModeBtn` toggling which mode `drawSSmlmHist()` draws — `sSmlmHistMode`
  `'dist'`/`'angle'` — labelled `"Distances"`/`"Angles"` (the OTHER mode's name, `driftPlotModeBtn`'s
  convention). **Deliberately different from spt's own D/track-length histogram merge**:
  `drawSSmlmHist()` overrides `$('rawTitle')` to a single FIXED `"sSMLM histograms"` for both modes
  — spt's own merge keeps `drawHistogram()`'s per-mode title instead, by explicit request.
  `previewSSmlmPairs()` resets `sSmlmHistMode='dist'` before its own first draw — a fresh Preview
  always opens on Distances, same precedent `driftPlotMode`/`sptHistMode` follow.

  **Fit dist. & angle** and **Pair** share one button row; **Unpair** sits alone in the row below. An
  unpaired localization is dropped from the result. A pair's reported position is the 0th order's
  OWN x/y (undispersed — already the true position), not the midpoint: the 1st order's offset
  varies per emitter with wavelength, so averaging would blur position.

  Stores the inter-order distance in its own `dist` field so a future 3D-fit + sSMLM combination
  could carry real depth AND spectral distance on the same loc without one clobbering the other.
  `renderSuperRes()`/`zRange()` take an explicit `colorField` parameter (`'z'` or `'dist'`) so the
  SAME depth-coded render path colours by either; `rerender()`/`analyze()` derive it as
  `hasZ ? 'z' : (hasDist ? 'dist' : null)`. The sidebar's **Colour by depth (z)**/**z min/max (nm)**
  labels switch wording live to "sSMLM distance" whenever `colorField==='dist'`. **`pairCore()`
  itself throws** (not just the interactive wrapper) if the input already has real 3D `z`, OR
  already has a `dist` field (already-paired output). Interactively, **Pair** also sets
  `zmin`/`zmax` to the configured distance window, since every accepted pair's `dist` already lies
  inside it by construction. Three module-level vars track state: `sSmlmOriginalLocs` (the true raw
  backup, captured once — also the authoritative pairing input: Preview/Pair always read
  `sSmlmOriginalLocs || lastResult.locs`, never `lastResult.locs` alone, since that may currently be
  an already-paired subset with no 1st-order companions left to find), `sSmlmPairedLocs` (latest
  Pair result), and `sSmlmShowingRaw`. The reconstruction-panel toggle (`sSmlmColorBtn`, "Show
  spectral"/"Show standard") swaps `lastResult.locs` between them (plus `zcolor`) — a real data
  swap, without discarding the pairing the way Unpair does.

  **`toggleSSmlmColorView()` also swaps the Colour map now** (v0.12.1-dev, reported, same class of
  bug as `run()`'s own stale-LUT fix — see **pipeline**'s `methodResetsLutToFire()` paragraph):
  toggling to "Show standard" left whatever `hsvBlue` (or `turbo`) the SPECTRAL view had selected
  still active, rendering the unpaired reconstruction — which has no colourable field at all — as a
  confusing blue-dominant density map instead of a plain one. Mirrors `runSSmlmPair()`/
  `unpairSSmlm()`'s own `sSmlmPrevLut` stash/restore, just at the toggle's own two transition points:
  switching to spectral captures the standard view's CURRENT Colour map into `sSmlmPrevLut`
  (unconditionally, not only-if-null like `runSSmlmPair()`'s own stash — that guard exists so a
  re-Pair while already spectral can't self-overwrite the true value with `hsvBlue` itself; the
  toggle instead always starts from a genuine standard view, so capturing fresh — including a manual
  LUT change made while on standard — is safe and more correct) then sets `hsvBlue`; switching back
  to standard restores `sSmlmPrevLut`. `unpairSSmlm()`'s own restore is unaffected either way, since
  the toggle keeps `sSmlmPrevLut` in sync with whichever LUT the standard view actually last had,
  regardless of how many times the toggle fires in between. Verified via Playwright: Colour map set
  to `viridis` before Pair, `hsvBlue` after; toggling to standard restores `viridis`, toggling back
  to spectral restores `hsvBlue`; a manual change to `inferno` while on standard is correctly
  captured on the next switch to spectral and restored on the switch back; Unpair afterward still
  restores the correct (`inferno`) value.

  **Every paired row also keeps the 1st order's own position and the pair's own directed
  bearing** (`x2,y2,pairAngle`, v0.12.1-dev) — previously `pairCore()` looked up the 1st order
  internally (`locs[q.down]`) purely to compute `dist`/`dAng` against it, then discarded the
  position entirely; the actual absolute 0th→1st compass bearing (the same quantity
  `sSmlmAngleCenter` itself represents, not just its deviation `dAng` from the configured centre)
  was likewise computed at the candidate stage and then dropped. Fixed as a general sSMLM
  improvement (not smFRET-specific, even though smFRET's own DD/DA trace-splitting below is what
  prompted it) — `x2,y2` (the 1st order's own native-px position) and `pairAngle` (the directed
  bearing, degrees) are threaded through `outEdges`→`qualifying`→`paired` alongside `dist`/`dAng`,
  present on every pair `pairCore()` produces. **Named `pairAngle`, deliberately not `angle`** — a
  plain `angle` field already exists on a loc from `gaussianMLEellipticangled`'s own fitted
  ellipse-rotation output, stored in **radians**; reusing the name for this **degrees**-valued pair
  bearing would have silently corrupted the "angle [deg]" CSV/table column for any paired result
  that also carries a real per-loc ellipse angle. Same optional-column precedent as `sigma1st`/
  `sx1st`/`sy1st`: `buildCsvText()`/`locTableData()` each gained an explicit `hasX2Y2`/
  `hasPairAngle` check (this app's optional-column wiring is hardcoded per field, not
  auto-detected — confirmed against `sigma_x`/`sigma_y`'s own handling before adding these), with
  `x2 [nm]`/`y2 [nm]`/`pairAngle [deg]` CSV columns and matching `parseCsvLocs()` round-trip.

  **Headless**: `config.sSmlmPair` runs
  pairing right after Localize, before drift/NeNA/FRC; `pairCore()`'s throws propagate immediately,
  and the result's `sSmlmPair` field records `nPairs`/`nInput`/`meanDistance`/`stdDistance`.
  `tools/webSMLM-cli.mjs`'s `--sSmlmPair` and `?autorun=`'s `sSmlmPair=1` both forward to it.

  **`previewSSmlmPairs()` now calls `logCmd()`** too (v0.12.1-dev, reported — Preview pairs computed
  a real, `sSmlmLastCands`-backed histogram that "Save plot/image" already exports, but never
  recorded a command for it) — deliberately does NOT log `sSmlmDistMin`: the wide diagnostic scan
  ignores it entirely, so including it would misleadingly suggest it mattered to what just ran.
  **Headless**: `config.sSmlmPreview` runs the identical wide scan (`sSmlmCandidates()` directly,
  0–6000 nm or wider, any angle) independently of `config.sSmlmPair` — either, both, or neither can
  be requested — recording `result.sSmlmPreview={nCandidates,scanMax}`; `config.exportPlots` (once
  `plots` exists, later in `analyze()`) additionally renders the SAME distance-histogram PNG/SVG
  "Save plot/image" would, markers included (`renderHistogramPlotHeadless()` gained an optional 4th
  `markers` param for exactly this — `computeHist()` already took one, `config.exportHistograms`'s
  own plain-column case just never needed it before). `sSmlmPreviewCands` (the raw candidate array)
  is stashed in a local var between where it's computed (alongside `sSmlmPair`, before drift/NeNA/
  FRC) and where `plots` is actually built (near the end) — the same "compute early, render late"
  shape `drift`/`nena`/`frc`/`pcfo` already use for their own `exportPlots` entries.

  **Angle histogram is a polar (rose) plot, not the shared cartesian bar chart** (requested — the
  cartesian version, per its own now-removed windowing trick, split a true peak straddling the axis's
  wrap point into two edge bars, illegible; a follow-up reference image settled the exact convention
  after the request's own wording — "0° top, 90° left" — turned out to be the OPPOSITE of the
  picture's own axis labels). `drawSSmlmAnglePolar(vals, angleCenter, tol)` (right after
  `drawSSmlmHist()`) replaces `computeHist()`/`drawHistogram()` for angle mode only — the distance
  histogram is completely untouched. Convention: **0°=right, 90°=top, increasing
  COUNTERCLOCKWISE** — standard math convention, confirmed against the reference image, not the
  reversed orientation first typed in words. Fixed `SSMLM_POLAR_BIN_DEG=2`° bins across
  `SSMLM_POLAR_NB=180` bins spanning the full circle (not `computeHist()`'s data-driven
  `sqrt(n)`-bin heuristic — angular data wants a fixed, interpretable resolution regardless of n).
  The doubled `rawAngle`/`rawAngle+180` fairness fix (row-order bias, see above) is unchanged; only
  the windowing origin changed, `wrap360(...,-90)` → `wrap360(...,0)` — a full circle has no "centre
  the peak away from the seam" need a linear axis had.

  Rendered as ONE continuous stepped outline (two points per bin, chained bin to bin, closed back to
  the start) rather than individual pie-slice wedges — filled with the theme's own `plotColors().bar`
  and stroked with `C.axis`, reusing the app's existing colour convention rather than copying the
  reference image's own literal red/grey. Radial gridlines (dotted concentric rings at `niceTicks(0,
  cmax,4)` count ticks) and the histogram outline itself are both built from plain `moveTo`/`lineTo`
  polygons via a shared `toXY(deg,r)` helper — **deliberately never `ctx.arc()`** for anything that
  needs a STROKE: `SvgRecordingContext.arc()` only ever feeds its own `fill()` (used elsewhere purely
  for full-circle point markers) — its `stroke()` only ever consumes a built path (`_d`), never the
  `_arc` state `arc()` sets, so a stroke-only circle would silently render nothing in "Save
  plot/image"'s SVG export. A 72-segment polygon per ring is visually indistinguishable from a true
  circle at any real canvas size, and guarantees the SVG export is pixel-identical geometry to the
  on-screen canvas (same code, same math, no `_plotTarget`-conditional branch). **Also caught the
  same way**: `SvgRecordingContext` has no `closePath()` at all (confirmed via the exact same
  Playwright SVG-content check that caught the arc/stroke gap) — the outline's own closing segment is
  built with an explicit trailing `lineTo(startX,startY)` instead, which closes correctly on both
  backends rather than relying on `fill()`'s own implicit-close behaviour (real Canvas2D auto-closes
  an open subpath for fill, but not for stroke, and the recorder doesn't auto-close for either).
  Selection markers were originally just "two crossed lines through the origin" (the two ±tolerance
  boundaries) — a third, magenta line at Primary angle itself was added on request right after, so
  the primary bearing has its own genuine reference line rather than being left implicit as the red
  pair's own midpoint. All three are full diameters at `wrap360(angleCenter[∓tol],0)`, dashed — red
  `#d9534f` (the same red the cartesian markers already use) for the ±tolerance pair, magenta
  `#c81cc8` (this project's own established magenta — drift/NeNA/spt's track-length fit all already
  use it) for Primary angle, drawn last so it stays on top when tolerance is small and the lines sit
  close together. Each line's own opposite endpoint (`deg+180`) is what makes it a full diameter, not
  a ray, so the red pair together bound the accepted wedge on BOTH sides of the circle by
  construction. Verified via Playwright by independently recomputing all marker lines' expected
  endpoint coordinates from the same `toXY()` formula and diffing them pixel-for-pixel against the
  actual recorded SVG path data — exact match. **Still no interactive hover** — the shared
  `registerPlotHover()`/`drawPlotHover()` do a rectangular hit-test + linear interpolation,
  fundamentally Cartesian and not reusable for a circular hit-test without real new code nobody
  asked for; the distance histogram's own draggable-marker IIFE stays fully inert here regardless
  (already gated on `histData.col==='sSMLM pair distance'`, which this plot never sets) — but **all
  three lines are now directly draggable** (requested, see the next paragraph).

  **Dragging the three marker lines** (requested — "similar to the Distances plot") is a genuinely
  different hit-test/drag model from that Distances-plot precedent, not a copy of it: a polar plot
  has no single 1D pixel-to-value axis, so hit-testing is PERPENDICULAR DISTANCE from the pointer to
  the INFINITE line through the circle's centre at a candidate angle (`distToLine()`, a 2D
  cross-product magnitude) — this naturally covers BOTH ends of a diameter with one test, no separate
  "near side"/"far side" case needed — and dragging recomputes an ANGLE from the pointer's own
  bearing around the centre (`pointerAngleDeg()`, `atan2` against the SAME 0°=right/90°=top/CCW
  convention `toXY()` itself uses), not a 1D value interpolation. Dragging the magenta line sets
  `sSmlmAngleCenter` directly to the pointer's own angle (wrapped into PARAMS' signed [-180,180)
  range) — grabbing either end of the diameter works identically, since whichever point you drag TO
  becomes the new bearing; no "which end did you grab" bookkeeping needed. Dragging EITHER red line
  recomputes ONE shared `sSmlmAngleTol` from the pointer's own angular distance to the (live) primary
  angle — since both red lines are always drawn as `angleCenter∓tol` from the SAME field, updating it
  moves both symmetrically for free; this is what produces the "mirrored" effect requested, with no
  separate mirroring logic of its own. `MIN_TOL_DEG` (1°) is the "may not cross the magenta line"
  guard requested: a red line's own recomputed tol is clamped to `[MIN_TOL_DEG, PARAMS.sSmlmAngleTol.max]`
  every drag tick, so it can get arbitrarily close to the primary-angle line but never reach or pass
  through it — same purpose (and same shape) as the Distances plot's own `MIN_SEPARATION_NM` clamp
  preventing its min/max markers from crossing each other. No `stopImmediatePropagation()` fight with
  a sibling zoom/pan IIFE is needed here the way the Distances plot's own draggable-marker IIFE needs
  one against the column-histogram zoom/pan IIFE right below it (registration-order gotcha, see that
  code's own comment) — the raw-panel navigator only ever acts when `rawFull` is set (never true for
  any plot) and the column-histogram zoom/pan IIFE only ever acts when `rawPlotName==='histogram'`,
  so nothing else listens for pointer events while `rawPlotName==='sSmlmAnglePolar'`. A cursor hint
  (`grab`/`grabbing`) mirrors the Distances plot's own `ew-resize` affordance, adapted for rotational
  rather than linear dragging. Verified via Playwright: computed each line's own on-screen client
  coordinates from `_sSmlmPolarGeom` (the `{cx,cy,R}` the draw function stashes on every render) and
  dispatched a real multi-step `mouse.move`/`down`/`move`×N/`up` sequence — dragging magenta to a new
  angle sets `sSmlmAngleCenter` to that angle exactly; dragging a red line changes `sSmlmAngleTol`
  exactly and leaves `sSmlmAngleCenter` untouched; dragging a red line toward and past the magenta
  line clamps at `MIN_TOL_DEG`, never reaching 0 or negative.

  **A real, reported bug in dragging the red (±tolerance) lines specifically** (v0.12.1-dev, not
  present in the magenta line's own drag): each red line is drawn as a FULL diameter (both ends
  grabbable, per `drawDiameter()`'s own comment above), but the drag math computed `sSmlmAngleTol`
  from the pointer's raw signed offset from `sSmlmAngleCenter` with no folding — correct when
  grabbing the visible tolerance wedge's own NEAR end, but grabbing the SAME line's FAR end (180°
  around, geometrically the identical line) produced a wildly wrong tol (a real tol of 6° read back
  as ~174° the instant the pointer crossed to the far half) — "behaves strangely" was the exact
  symptom reported. Unlike the magenta line (whose own drag deliberately has no such bookkeeping —
  see its own comment: wherever you drag TO becomes the new bearing, correct regardless of which end
  was grabbed), the red lines' VALUE is a relative offset to the centre, so grabbing either end of
  the same diameter must yield the identical result. Fixed by folding the raw signed offset into its
  own near-side representative in (-90°,90°] first (mod 180 — a diameter's two ends are the same
  line) before taking the magnitude — `if(diff>90) diff-=180; else if(diff<=-90) diff+=180;` — so
  either end of a red line's diameter now always produces the same, correct tolerance.

  **`_plotHover.raw` must be explicitly cleared, not just left unregistered** — a real, reported bug
  ("the plot closes and reverts to the distance plot" the instant the cursor moved): the DISTANCE
  view (still `drawHistogram()`) DOES call `registerPlotHover()`, caching a clean-plot snapshot plus
  a mousemove listener already wired once, globally, at page load (`MODULE: table`, for both
  `raw`/`sr`). Switching to Angles calls `drawSSmlmAnglePolar()` instead, which registers no hover of
  its own — but simply not calling `registerPlotHover()` again does NOT unregister the PREVIOUS
  mode's own entry in `_plotHover.raw`; the global mousemove listener still fires on it regardless of
  which draw function most recently ran, blindly repainting that stale DISTANCE-mode snapshot straight
  over the polar plot on the very next pointer move. Fixed with one line, `_plotHover.raw=null;`, right
  at the top of `drawSSmlmAnglePolar()` — the exact same fix `drawRaw()` already applies for the same
  reason when a live frame reclaims the panel from any plot (see that call site's own comment).

  **`_replotRaw=drawSSmlmHist`** is now set unconditionally at the top of `drawSSmlmHist()` itself
  (a real, previously-latent bug this surfaced) — before this, `_replotRaw` was only ever set
  *inside* `drawHistogram()`, correct for distance mode but leaving it either stale or unset for
  angle mode once that stopped calling `drawHistogram()` at all; a resize/theme-change while viewing
  the polar plot would have redrawn the WRONG thing (or nothing). Harmless for distance mode too —
  `drawHistogram()`'s own internal `_replotRaw=drawHistogram` assignment runs right after and simply
  overwrites this one back to the (already-correct) simpler target for that mode.

  **Three more workflow requests, same round.** (1) `previewSSmlmPairs()` now calls
  `fitSSmlmDistAndAngle()` itself right after building `sSmlmLastCands` (requested — "this way
  operation is faster") — every Preview already has exactly what the fit needs, so Distance
  min/max/Primary angle/Angle tolerance now reflect the CURRENT dataset's own real peak the moment
  Preview finishes, instead of sitting at generic `PARAMS` defaults until a separate manual click.
  Typing over the fields afterward, or re-fitting again (e.g. after changing **Background
  profile**), still works exactly as before — this only changes the STARTING point. (2) `runSSmlmPair()`
  now stashes the Colour map value into a new module-level `sSmlmPrevLut` right before its own
  existing auto-switch to `hsvBlue` (only if nothing's already stashed, so a re-Pair while ALREADY
  paired — no Unpair in between — doesn't overwrite the TRUE pre-pairing value with `hsvBlue`
  itself), and `unpairSSmlm()` restores it (requested — Unpair previously left the Colour map on
  whatever Pair had switched it to, regardless of what the user actually had selected before).
  `sSmlmPrevLut` is also cleared alongside `sSmlmOriginalLocs`/`sSmlmPairedLocs` at every place those
  already reset (the ~9 "reclaim the panel" blocks, including the two smFRET-specific ones that
  don't go through the generic reset — `locateSmfretSOI()`'s own invalidation branch and
  `clearSmfretFixSOI()`'s tail block), so a stale stash never leaks into an unrelated later result.
  (3) **First attempt (superseded the same round)**: `drawDepthBar()` (MODULE: render) overlaid
  `sSmlmDistFit`'s own curve directly on the reconstruction's colour-scale bar, on the reading that
  "the colour plot" in "as in the distances plot, the colour plot should show the fitting function"
  meant that bar. **Corrected on direct follow-up** — it meant the Angles polar plot itself, not the
  colour bar at all; the colour-bar overlay was reverted (`drawDepthBar()` is back to its original,
  pre-curve form) and the real fit went to `drawSSmlmAnglePolar()` instead (documented in its own
  module bullet, below, along with a real modelling bug caught while building it — a single-bump
  model locking onto whichever of the doubled-bearing data's two genuine mirror peaks happened to
  look marginally taller). Verified via Playwright against the real ALEX/prism reproduction dataset
  for the two changes that stood: Preview alone now sets Distance min/max to `343`/`677` nm (no
  separate Fit click needed), and Pair switches the Colour map to `hsvBlue` while Unpair correctly
  restores a distinctively different pre-Pair selection (`viridis`, in the test).

  **Three more requests on the same round.** (1) Changing **Background profile** now re-fits
  outright (`if(sSmlmLastCands && sSmlmLastCands.length) fitSSmlmDistAndAngle();`) instead of just
  clearing `sSmlmDistFit` and leaving the user to click **Fit dist. & angle** again — same
  "refresh an existing result automatically" convention `smfretApertureMode`'s own change listener
  already uses; a no-op before the first Preview, since there's nothing to re-fit against yet.
  (2) The Angles plot's three draggable selection lines (Primary angle, ±Angle tolerance) now
  extend `SSMLM_POLAR_MARKER_EXT` (25px) past the histogram's own outer radius `R` for an easier
  drag target (requested) — `drawSSmlmAnglePolar()`'s own `drawDiameter()` draws to `R+
  SSMLM_POLAR_MARKER_EXT` instead of `R`, and the draggable-marker IIFE's `withinRing()` hit-test
  bound was widened to match (`R+SSMLM_POLAR_MARKER_EXT+10`, a small grace margin past the line's
  own visible tip) — one shared constant so the visible line and its clickable area can never drift
  apart; the hit-test ITSELF is unaffected either way (perpendicular distance to an infinite line,
  per `distToLine()`'s own comment — `withinRing()` only bounds how far from the circle a click is
  even worth testing against it). (3) `setupPlot()` gained an optional 3rd `targetRatio` argument
  (default `4/3`, matching every existing call site exactly, so nothing else changes) —
  `drawSSmlmAnglePolar()` is the one caller passing `1` (square), requested: a circular plot wastes
  real estate in a non-square box, whichever axis isn't the limiting one. Verified via Playwright:
  changing Background profile after a fit already exists re-fits with a genuinely different result
  (not just a cached copy — `343→342` nm on Distance min in the test), and dragging a line grabbed
  at `R+20` (past the OLD hit radius, within the new one) successfully changes Primary angle.

  **The Angles plot now overlays its own fitted curve too** (corrected, same round — see the
  colour-bar paragraph above for the misread this replaces). A flat-background + Gaussian-signal
  mixture, same `fitSSmlmDist()` engine the distance histogram's own curve uses, with `bgPdf=()=>1`
  instead of the box/disk PDF (a random unpaired candidate is equally likely at any bearing, so the
  background contributes no shape parameters at all, only its own linear amplitude). **A real
  modelling bug caught while building this, not shipped**: fitting a single Gaussian bump directly
  against the raw 360° angle histogram is wrong, because the doubled-bearing data (every candidate
  plots BOTH `rawAngle` and `rawAngle+180`, `sSmlmCandidates()`'s own row-order fairness fix) always
  has TWO genuine, equal-height peaks exactly 180° apart — a single bump can only explain one of
  them, and risks the fit locking onto whichever mirror happens to look marginally taller (checked
  directly: it did — the fit converged with `mu` nearly 182° away from the already-known-good
  half-max estimate, onto the OTHER mirror peak instead). Fixed by FOLDING the histogram to its true
  180°-periodic domain first — `folded[i]=hist[i]+hist[i+nb/2]` sums each bin with its own mirror,
  merging the two peaks into one genuine peak — THEN re-centering (same reasoning the distance fit's
  own domain never needed, since it doesn't wrap at all) and fitting on that folded domain via a new
  shared `wrap180(x,lo)` (next to `wrap360()`, same idea at period 180 — used by both
  `fitSSmlmDistAndAngle()`'s own folding and `drawSSmlmAnglePolar()`'s matching curve evaluation, so
  the two can never disagree on convention). The fitted `p`/`muFoldAbs` are stored in a new
  `sSmlmAngleFit` (mirroring `sSmlmDistFit`, cleared at the same single point — a fresh Preview —
  that already invalidates `sSmlmDistFit`, matching that variable's own established "not at every
  reclaim block, the buttons being disabled already prevents reaching a stale one" precedent).
  `sSmlmAngleCenter`/`sSmlmAngleTol` themselves are deliberately UNCHANGED by any of this — still set
  from the original, already-validated (±5° against real data) peak/half-max-width method; the new
  fit is purely a display overlay, not a replacement estimator, to avoid risking a working, tuned
  heuristic on an unvalidated new one. **Drawing exploits the fold's own periodicity directly**:
  `wrap180(deg-muFoldAbs,-90)` maps `deg` and `deg+180` to the IDENTICAL relative offset by
  construction, so evaluating the folded model (halved, since it was fit against a SUMMED pair of
  bins) across the full 360° circle automatically traces both real mirror peaks correctly with no
  separate "which mirror is which" bookkeeping at all. Verified via Playwright: the curve evaluates
  to the exact same value at the fitted centre and at centre+180° (`579.54` both times in the real
  test, confirming the periodicity), close to zero (background-only) 90° away from either peak, and
  `muFoldAbs` lands within 1° of the independent half-max estimate (`-87.95°` vs. `-87°`) — the two
  methods agreeing despite being computed completely differently.

  **Renamed and reorganized** (v0.12.1-dev, requested — this module is now also the smFRET
  donor/acceptor pairing path, not just diffraction-grating sSMLM). Sidebar label: "(Caution!)
  Spectral SMLM analysis" → **"(Caution!) Pairing (sSMLM & FRET)"** (id stays `sSmlmBox`, matching
  the existing "label-only, nothing keys off the text" convention above — a first attempt shortened
  "spectral SMLM" to just "sSMLM" while ALSO dropping the "!", which wrapped onto two lines in the
  sidebar for the wrong reason and inconsistently lost the caution marker other modules keep;
  reverted, keeping "!" and using the shorter "sSMLM" form fits one line). **Pair** →
  **"Pair & plot sSMLM"** (clarifies it does two things: commit the pairing AND
  switch the reconstruction to colour-by-distance). The standalone **Fit dist. & angle** button is
  removed entirely — **Preview pairs** already auto-ran it internally every time (see that
  paragraph above), so a separate click was pure redundancy; the underlying `fitSSmlmDistAndAngle()`
  function is unchanged and still runs automatically from Preview pairs and from a **Background
  profile** change. **Pair & plot sSMLM**/**Unpair** now share one button row (previously Pair
  shared a row with the now-removed Fit button, and Unpair sat alone below). **`unpairSSmlm()`
  now calls `logCmd()` too** (reported gap — the one remaining sSMLM action with no logged command,
  an edge case since there's nothing meaningful to replay, but kept consistent with every other
  actionable control here).

  **Internally split into pairing vs. plotting**, so **smFRET**'s own **Pair DD + DA** button
  (below) can pair without hijacking whichever view the smFRET raw/SR panels currently show:
  `pairSSmlm(cfg, myEpoch)` is the pure(ish) pairing step — runs `pairCore()` and applies the result
  to `sSmlmOriginalLocs`/`sSmlmPairedLocs`/`lastResult.locs`, nothing else (returns `null` if a newer
  action superseded it while `pairCore()` was running, same `newEpoch()`/`staleEpoch()` convention as
  everywhere else); `runSSmlmPair()` (the button handler) calls it, then does the "plot" tail —
  z-range, LUT switch, rerender, button enabling. Likewise `previewSSmlmPairsCore()` is the pure
  candidate-scan-plus-auto-fit step, with `previewSSmlmPairs()` adding the histogram-view switch on
  top. Verified via Playwright against the real ALEX/prism dataset: `getSmfretPairingFromDonor()`
  (below) calling these two directly pairs the donor-channel SOI set with the SR panel's own
  `srInfo` text staying byte-identical before/after (confirming no rerender/view switch happened)
  and the LUT/`zcolor` fields left completely untouched.

  **"sSMLM histograms" renamed "Pairing histogram"** (v0.12.1-dev, requested — shorter, and no
  longer misleadingly sSMLM-only now that smFRET pairs through here too). `sSmlmPairContext`
  (`null`/`'sSmlm'`/`'smfret'`, declared next to `sSmlmOriginalLocs`) tracks which module last
  COMMITTED a pairing this session — `runSSmlmPair()` sets `'sSmlm'`, `getSmfretPairingFromDonor()`
  sets `'smfret'` — deciding what dragging a Distances/Angles plot handle does to the right-hand
  panel AFTERWARD (requested: "when pairing done from within the pairing module, we should see the
  SMLM reconstruction window, when entered via ... 'Pair DD + DA' ... we should keep showing and
  live updating the composite window"). The `'sSmlm'` context's own behaviour is UNCHANGED
  (`syncSSmlmZRangeFromDist()` — colour-RANGE-only rescale, no re-pairing, exactly as before);
  the `'smfret'` context is genuinely new: `refreshSmfretPairingLive()`, wired to all four fields'
  (`sSmlmDistMin`/`Max`/`sSmlmAngleCenter`/`Tol`) own `change` event (fires on drag-RELEASE, per
  every other draggable marker's own convention — not continuously mid-drag, confirmed with the
  user directly rather than assumed), re-runs `pairSSmlm()` with the NEW window (deliberately
  skipping `previewSSmlmPairsCore()`'s own auto-fit, which would silently undo a manual edit) then
  re-marks the SOI composite's own overlay via `markSmfretSoiPairedKeys(pairedLocs)` (the exact
  marking logic `getSmfretPairingFromDonor()`'s own tail also calls, see **smFRET**'s own paragraph
  below for the full mechanism — colours a paired entry dark orange, never removes an unpaired
  one's box/crosshair). Always rebuilds `smfretPairedSoiKeys` from the FULL `smfretSOI` array
  (never from a previously-filtered subset — there isn't one any more) — widening the window on a
  later refresh must be able to bring a site back into the marked set that an earlier, narrower
  window had excluded. An empty window (0 pairs) correctly clears the marking entirely via
  `r.nPairs ? r.locs : []`, rather than leaving the previous window's marks stuck on screen.
  Verified via Playwright against the real ALEX/prism dataset: narrowing Distance max via a field
  change while in the smfret context re-pairs and `smfretPairedSoiKeys`' own size changes to match
  the new pair count (`srSpots`/`srLocs` themselves stay the same full length throughout, by
  design); picking the *other* candidate bearing on smFRET's own "Position donor?" (below) — which
  sets Primary angle then dispatches `change` — triggers the identical live re-pair/re-mark path
  for free, no separate wiring needed.

  **`sSmlmDistMin`/`sSmlmDistMax` have no fixed upper limit any more** (v0.12.1-dev, reported — a
  new real dataset, dual-view/image-splitter TIRF smFRET, put the donor channel on the LEFT half of
  the sensor and the acceptor channel on the RIGHT half — a genuinely different physical setup from
  every prior ALEX/sSMLM sample this session, which are all prism/polychroic-based with donor/
  acceptor images overlapping the SAME region and pair separations of only hundreds of nm. A
  dual-view separation is instead the sensor's own half-width, tens of MICROMETERS. Both fields'
  own `PARAMS` `max` (previously a flat `20000`, chosen for the diffraction-grating reference
  dataset's own sub-µm dispersion) and the matching HTML `<input max="20000">` attributes are gone
  — `max:null`, the exact convention `fitLastFrame` already established for "no UI ceiling, only a
  physical one" (`syncParamControls()`'s own `if(spec.max!=null) el.max=spec.max;` line means
  `max:null` leaves the HTML attribute unset entirely, so the static markup itself had to drop
  `max="20000"` too — setting only the PARAMS side would have left the old ceiling silently in
  place). The "Preview pairs" wide diagnostic scan already tracked a widened Distance max
  (`scanMax=Math.max(6000,paramValue('sSmlmDistMax'))`, MODULE: sSMLM/pipeline) — it was ONLY the
  fields' own hard ceiling blocking dialing in a large enough window in the first place, not a
  second, independent cap. **Two real `Math.min(null,x)` gotchas caught while removing the
  ceiling** — `null` coerces to `0` in `Math.min`/`Math.max`, so leaving either of these call sites
  unchanged would have silently zeroed the very thing this fix was meant to unblock: (1)
  `fitSSmlmDistAndAngle()`'s own auto-fit clamped `distMax` via
  `Math.min(PARAMS.sSmlmDistMax.max, mu+3*sigma)` — replaced with `Math.min(Math.hypot(dims.a,
  dims.b), mu+3*sigma)`, the localization bounding box's own diagonal (already computed as
  `dims.a`/`dims.b` for the background-model fit right above it) being the actual physical bound —
  no two localizations within that box can be farther apart than its diagonal, a real constraint
  unlike the old arbitrary constant; (2) the distance histogram's own draggable min/max marker IIFE
  clamped every drag tick via `Math.max(spec.min,Math.min(spec.max,nv))` — changed to
  `Math.max(spec.min, spec.max==null?nv:Math.min(spec.max,nv))`, an explicit null-check rather than
  relying on `Math.min`'s own silent coercion, since without it every drag would have snapped
  straight to `spec.min` on the very first pointermove. `sSmlmAngleCenter`/`sSmlmAngleTol`'s own
  drag clamps (a few lines below, same IIFE family) are untouched — those fields keep real, bounded
  `max` values (±180°/90°), unaffected by any of this. Verified via Playwright with a synthetic
  dual-view-style dataset (donor/acceptor sites 300 px apart at 160 nm/px ≈ 48 µm — well past the
  old 20000 nm ceiling): the field itself now accepts and retains 50000 directly; **Preview pairs**
  found real candidates out to ~54,640 nm; **Pair & plot sSMLM** committed 19/20 planted pairs at a
  mean distance of ~48,327 nm; and a separate run through `fitSSmlmDistAndAngle()`'s own auto-fit
  path converged to a real, non-zero, non-crashing window (~44,600–45,800 nm) instead of the
  `Math.min(null,...)` bug's `0` — confirming both the manual-entry and auto-fit code paths.

  **"Preview pairs"' own wide diagnostic scan had a SEPARATE, independent 6000 nm floor — the field
  ceiling fix above wasn't sufficient on its own** (reported, with a screenshot: the Distances
  histogram's own x-axis topped out at 6000 nm, and the resulting pairing came back at a mean
  distance nowhere near the user's expected "half the frame size" separation). Root cause:
  `previewSSmlmPairsCore()` (interactive) and `analyze()`'s own `config.sSmlmPreview` branch
  (headless) both compute `scanMax=Math.max(6000, Distance max)` — a SEPARATE ceiling from the
  field's own `PARAMS.max` (already fixed above), so removing the field's ceiling alone did nothing
  once `Distance max` itself was still sitting at some value below the true tens-of-µm separation
  (its own default, or the auto-fit's previous wrong output) — the wide scan never looked far enough
  to find the real peak at all. Fixed the same way as the ±3σ clamp above: both scans now also floor
  at the localization bounding box's own diagonal — `previewSSmlmPairsCore()` via `sSmlmBoxDims()`
  (already in scope), the headless branch via an inline bounding-box computation over `locs`/
  `cfg.pxnm` (no equivalent global state to reuse there). Verified via Playwright with a synthetic
  512×256 px two-region dataset (donor left half, acceptor right half, true separation exactly
  256 px × 160 nm/px = 40,960 nm): the scan now reaches ~89,814 nm (the box's own diagonal), where it
  previously stopped dead at 6000 nm.

  **A second, deeper limitation found while verifying the fix above, not yet addressed in code**:
  even with the scan reaching far enough, `fitSSmlmDistAndAngle()`'s own two-stage seeding still
  doesn't reliably converge on the correct window for a two-DISJOINT-region setup (donor/acceptor on
  separate halves of the sensor) — confirmed on both a synthetic dataset and a real quick Localize
  SOI run against `alex50mW_1_MMStack_Default.ome.tif`: the fit produced a wide, uninformative window
  whose resulting pairs' mean distance (~22.6 µm in the real-file test) sat nowhere near the true
  ~41 µm separation. Root cause: the background model (`sSmlmBgPdfRect`/`sSmlmBgPdfDisk`, see this
  module's own paragraph above) assumes ONE contiguous uniform region — correct for the
  diffraction-grating dataset it was built and validated against (0th/1st order images overlap the
  SAME region), but wrong for a dual-view split, where the real signal sits at a MODERATE distance
  (roughly half the box diagonal) deep inside an already-large, smoothly-varying combinatorial
  background from same-half and cross-half unpaired candidates — not the kind of clean, isolated
  local maximum the residual-based seeding was designed to find. **A real, user-suggested workaround,
  independently verified**: since the true angular bearing of a dual-view split is usually known
  in advance (roughly horizontal, ~0°, unlike the grating case where angle is itself unknown),
  restricting `sSmlmCandidates()`'s own angle window to that known bearing BEFORE looking at
  distance removes most of the combinatorial noise — same-half random pairs span all angles, but a
  real cross-channel pair does not. Verified on the synthetic 40,960 nm-separation dataset: an
  any-angle scan showed no distinguishable peak at all (72,010 total candidates, smooth background);
  restricting to ±10° around the known 0° bearing cut candidates to 15,985 and produced a clear,
  visible local spike (747 counts at the true bin vs. ~580–610 in neighbouring bins — unmistakable
  against the otherwise smooth decline) at exactly the true distance. The angle HALF of a subsequent
  auto-fit on this angle-restricted candidate set also improved sharply (1° vs. the true 0°), though
  the distance half still didn't converge tightly — recommended, for now, as a terminal-driven manual
  workaround (`sSmlmCandidates(locs, px, 0, dmax, 0, tol, …)` with a narrow `tol` around the known
  bearing, then visually placing Distance min/max on the resulting histogram) rather than a UI
  change — a dedicated "restrict the wide scan by the current Angle window" toggle is a plausible,
  not-yet-built follow-up if this proves broadly useful.

  **The ceiling-widening direction above was REVERTED — `sSmlmDistMin`/`sSmlmDistMax` have a fixed
  upper limit again (10000nm)** (reported: "Angle first does nothing" on a real wedge-prism
  donor-only dataset whose TRUE separation is only ~500nm at ~0° — a small, single-region setup, not
  a dual-view split at all; "the other approaches fail equally"). Removing the ceiling to unblock the
  dual-view case (above) had a real, unintended cost for "Via distances and angles"' own ORIGINAL
  use case (a small, sub-µm-to-few-µm dispersion — diffraction grating, wedge prism): both the wide
  Preview scan and the ±3σ auto-fit clamp grew to cover the data's FULL bounding-box diagonal
  (tens of µm on a real FOV) regardless of how small the TRUE separation actually was, diluting a
  genuinely small real peak across a search range orders of magnitude larger than it needed to be —
  exactly the failure this user hit, and unrelated to `sSmlmFitOrder`'s own distance-vs-angle
  ordering (correctly reported as unhelpful here, since the real problem was scan/clamp WIDTH, not
  fit order). Fixed by reinstating a real ceiling (`PARAMS.sSmlmDistMin`/`sSmlmDistMax.max=10000`,
  matching HTML `max="10000"` attributes restored) — chosen from the user's own suggested 5–10 µm
  range — and reverting `previewSSmlmPairsCore()`'s/`analyze()`'s `config.sSmlmPreview`'s own
  `scanMax` to floor-only (`Math.max(6000, Distance max)`, dropping the bounding-box-diagonal term)
  and `fitSSmlmDistAndAngle()`'s own `distMax` clamp back to
  `Math.min(PARAMS.sSmlmDistMax.max, Math.hypot(dims.a,dims.b), mu+3*sigma)` (both bounds combined,
  tighter of the two wins). The dual-view/large-displacement case this ceiling was originally
  widened for is now **channel matching**'s job instead (see smFRET's own module bullet,
  `alignSmfretChannels()`) — a purpose-built point-registration method with no such cap, so "Via
  distances and angles" no longer needs to cover both scales at once. `sSmlmFitOrder` itself is
  UNCHANGED and still useful in principle (a same-region setup with an unusually WIDE but still
  bounded-under-10µm dispersion and a known bearing could still benefit from angle-restricting
  first) — its own motivating BIG-PICTURE case (a two-disjoint-region dual-view split) is simply out
  of scope for this method again, same as the ceiling itself.

  **`sSmlmFitOrder`** ("Fit order", Distance first/Angle first, default Distance first, v0.12.1-dev)
  — the toggle proposed just above, built the same round after the user confirmed the real bearing
  is known in advance for a dual-view/image-splitter setup: "we know the angle... that might help.
  ...Should we insert a toggle... or how can we keep it general?" `fitSSmlmDistAndAngle()` was split
  into two reusable, DOM-free pieces — `fitSSmlmDistanceFromCands(cands)` and
  `fitSSmlmAngleFromCands(cands)`, each taking an explicit candidate array instead of implicitly
  reading `sSmlmLastCands`/the live Distance fields — so both fit orders share identical fitting
  code, only the candidate SUBSET and the order differ. `distFirst` (default) is the ORIGINAL,
  real-data-validated behaviour verbatim (fit distance from the wide, any-angle pool; then fit angle
  restricted to the just-fitted distance window) — re-verified byte-for-byte identical against a
  synthetic regression case (`11942, 20505, -1`, matching the pre-refactor code's own output exactly)
  before shipping the refactor. `angleFirst` reverses both the order AND the restriction direction:
  fits angle from the wide, ANY-DISTANCE pool first, then restricts to that fitted angle window via a
  new `filterSSmlmCandsByAngle(cands, angleCenter, angleTol)` (mirrors `sSmlmCandidates()`'s own
  per-candidate folded-angle-distance math exactly, applied post-hoc to each candidate's already-
  computed `angle` field — so it agrees with what a fresh `sSmlmCandidates()` call at that exact
  center/tolerance would have kept) before fitting distance on the result. Wired the same "refresh
  an existing result automatically" convention as `sSmlmBgProfile`'s own change listener.

  **The Distances HISTOGRAM itself also respects `angleFirst`** (not just the fitted numbers) —
  without this, the toggle would improve the auto-fitted angle but leave the visible PLOT just as
  diluted as before, missing the actual demonstrated benefit (a ~4-5x background reduction making
  the true peak visible by eye). `drawSSmlmHist()`'s dist-mode branch now filters `sSmlmLastCands`
  through `filterSSmlmCandsByAngle()` (using the LIVE Primary angle/Angle tolerance, so manually
  narrowing either field re-filters the plot immediately) whenever `sSmlmFitOrder==='angleFirst'` —
  mirroring the angle histogram's own pre-existing "restrict by the other axis's current window"
  logic, just in the direction this fit order needs; `distFirst` is completely untouched, still the
  full, unrestricted "whole picture" the histogram was originally designed to show. Verified via
  Playwright on the same synthetic dual-view-style dataset: `angleFirst` correctly narrows the
  histogram's own candidate count (72,010 → 42,143 in the test, using the auto-fitted ±32° window)
  while `distFirst` still shows the full 72,010.

  **A real, reported bug found and fixed the same round, unrelated to the above**: dragging the
  Distance min/max markers directly on the Distances histogram was switching the reconstruction
  panel from the smFRET SOI composite to a genuine z-coloured "SMLM reconstruction" — exactly the
  behaviour `refreshSmfretPairingLive()`'s own comment says should NOT happen in the `'smfret'`
  pairing context ("this context ... deliberately does NOT touch the reconstruction panel"). Root
  cause: `syncSSmlmZRangeFromDist()` (MODULE: sSMLM, the plain `'sSmlm'`-context colour-rescale
  helper) is wired to the SAME `change` event on `sSmlmDistMin`/`Max` as `refreshSmfretPairingLive()`
  — both listeners always fire together — but `syncSSmlmZRangeFromDist()` itself never checked
  `sSmlmPairContext` at all, only `sSmlmOriginalLocs==null`/`sSmlmShowingRaw`, so it unconditionally
  called `rerender(true)` regardless of which module actually committed the pairing.
  `sSmlmPairContext` postdates this function (added for the smFRET live-repair feature in an earlier
  round), and the missing guard was a real gap, not a deliberate omission —
  `refreshSmfretPairingLive()`'s own comment already documented the INTENDED split, it just was
  never enforced on this side. Fixed with one added condition:
  `if(sSmlmOriginalLocs==null || sSmlmShowingRaw || sSmlmPairContext!=='sSmlm') return;`. Verified
  via Playwright: with `sSmlmPairContext='smfret'`, dragging a distance marker no longer touches
  `zmin`/`zmax` (stayed empty, confirming the function returned immediately); with
  `sSmlmPairContext='sSmlm'`, the exact same drag still correctly sets `zmin`/`zmax` and rerenders,
  unchanged from before this fix.

  **`pairCore()`'s own summary log line said "dropped, not shown" — misleading for one of its two
  callers** (reported: "there are still non paired ROIs in SOI composite (as it should be!)" — a
  real point of confusion, not a bug in behaviour). `pairCore()` is shared by the plain sSMLM
  reconstruction path (where the claim is literally true — the reconstruction really does only ever
  show the `n` paired points) and smFRET's own `pairSSmlm()`/`getSmfretPairingFromDonor()` (where
  the SOI composite always shows EVERY site regardless, colour-marking a paired one via
  `markSmfretSoiPairedKeys()` rather than removing anything) — `pairCore()` itself has no visibility
  into which caller it's serving, so a blanket "not shown" overclaimed for the smFRET case. Reworded
  to only assert what's always true regardless of caller — "this result now holds only these N
  paired points; M ... are dropped from it (a site may still be visible elsewhere ...)" — rather than
  a display claim `pairCore()` can't actually verify.

- **smFRET** (v0.12.1-dev) — Marked **experimental**; the sidebar label also carries the same
  **"(Caution!)"** prefix as **sSMLM**/**spt** (see sSMLM's own paragraph on this — a visual
  warning only, id stays `smfretBox`). **Sidebar label renamed** "(Caution!) smFRET (experimental)"
  → **"(Caution!) Single-molecule FRET"** (requested, same round as sSMLM's own rename above — the
  "(experimental)" suffix was redundant with the "(Caution!)" prefix itself). v1: "sites of interest" (SOI) detection plus a
  simple per-site time-trace readout, the first step of `docs/REFACTOR_PLAN.md`'s own smFRET/ALEX
  integration sketch. Not squeezed into sSMLM (a genuinely different optical setup motivating this —
  a prism + polychroic beam-splitter, not sSMLM's own diffraction grating) or 3D calibration, though
  **Localize SOI** (`locateSmfretSOI()`) reuses that module's own `averageFrames()`/`detectSpots()`/
  `gaussianFitElliptical()` chain verbatim — averages the first `smfretAvgFrames` frames (clamped to
  the stack's own length, `Math.min(stack.n,...)`) into one composite, detects once, fits each
  maximum, same "average, then detect once" reasoning `locateBeadsForCalib()` already uses (real
  molecule positions stay bright across an average the way transient noise doesn't). The FIRST run
  is a manual button click; once `smfretSOI!==null` (a composite is already showing), changing
  `smfretAvgFrames` or any detection/fit field also wired to `locateBeadsForCalib()`'s own listeners
  re-runs it automatically too — real SOI signals are commonly faint, so hand-tuning the threshold
  with live feedback matters here in practice, unlike a bright/well-separated bead calibration.
  Results (`smfretSOI`, `{x,y,sx,sy,sigma,photons,bg,bgstd,frame:0}` per site — the fitter's own full
  output, not just position) display the same way a bead composite does: `srFull`/`srSpots`/
  `srLocs` in the reconstruction (right) panel, `setSrRecon(false)` (reference view, not a real
  reconstruction). Not yet its own `MODULE:` banner — lives at the sSMLM/spt physical boundary,
  small enough for now; promote it once it grows (matching **liveStreaming**'s own precedent).
  Real motivating dataset: a prism/polychroic-split immobile DNA-FRET sample
  (`experimental_data/Donor-1b …prisms9393…tif`) — donor-heavy, so most detected SOI likely have
  little/no acceptor signal; not yet established whether real pairs are even present in it.

  **Every successful `locateSmfretSOI()` run also writes `lastResult`** (`{locs:smfretSOI, w, h,
  px:paramValue('pxnm'), mag:paramValue('mag'), det:null, fromSmfretSOI:true}`, reported — SOI data
  had no way into the table/export/sSMLM pairing machinery otherwise) — the same minimal shape
  `loadCsvFile()` uses for locs with no real per-frame Run behind them (`det:null`, so `showFrame()`'s
  own frame-overlay logic correctly skips trying to match it against the stack). This is what makes
  **Spectral SMLM analysis**'s existing **Preview pairs**/**Pair** usable on SOI data with ZERO
  changes to `pairCore()`/`sSmlmCandidates()` themselves — exactly the `docs/REFACTOR_PLAN.md`
  smFRET/ALEX sketch's own "linking a DD candidate to its DA partner = sSMLM's own pairing" idea,
  now wired rather than just proposed. Every SOI site gets the SAME `frame:0` (an arbitrary shared
  constant, not a real per-frame index) specifically because `sSmlmCandidates()` groups candidates
  by `loc.frame` and only ever compares within one group — giving them all the same value collapses
  the WHOLE SOI set into one group, so every candidate is compared against every other one, correct
  for a position set with no real temporal structure. `fromSmfretSOI:true` is a marker tag on the
  `lastResult` object itself (not a `PARAMS` field) letting `smfretFixSOI`'s own uncheck handler
  (below) tell "this lastResult is SOI's own" from "this happens to be a real Localize/CSV result
  that predates SOI" — only the former gets discarded on uncheck. `pairCore()`'s own guards (real z
  / already-`dist`-paired input) both pass trivially on fresh SOI locs, needing no special-casing.
  **REPLACES whatever `lastResult` held before** (a real Run, a loaded CSV, an earlier SOI pass) —
  no confirmation, same "no prompt, but name what's about to go" convention `run()`'s own pre-Localize
  reset already uses (mirrored here: warns once when clobbering a REAL prior result, but not on every
  routine auto-rerun re-clearing its own previous SOI pass, checked via `!lastResult.fromSmfretSOI`).
  Deliberately does NOT call `rerender()` — the SR panel keeps showing the composite/ROI overlay
  untouched; only an actual **Pair** (if the user gets that far) switches it to a real reconstruction,
  exactly as it already does for an ordinary Localize result. Verified via Playwright against the
  real prism/polychroic dataset: `lastResult.locs` matches `smfretSOI` 1:1, `View data/filtering`
  shows all sites with `sigma_x`/`sigma_y` columns (free, since every SOI loc carries real `sx`/`sy`
  — the same optional-column convention `mle3d`/`gaussmleEll` results already trigger), **Preview
  pairs** runs to completion against them, and unchecking `smfretFixSOI` tears the whole thing back
  down (`lastResult=null`, table/save/sSMLM buttons disabled again).

  **`locateSmfretSOI()` now calls `logCmd()`** (reported — clicking it produced no recorded command
  at all, unlike every other action that writes `lastResult`) — logs `{smfretLocateSOI:true,
  smfretAvgFrames, psf, winr, detFilter, <active threshold field>, pxnm}`, genuinely replayable now
  that `config.smfretLocateSOI` exists (see below), not a cosmetic-only log line.

  **`smfretPairingBtn` ("Pair DD + DA", renamed from "Get from pairing")** (v0.12.1-dev, requested — shares Localize SOI's own
  row; **Get time traces** moved one row down to make room) is a shortcut over **sSMLM**'s own
  Preview pairs + Pair & plot sSMLM, run from right here on the current sites of interest.
  `getSmfretPairingFromDonor()` calls `previewSSmlmPairsCore()` then `pairSSmlm(cfg, myEpoch)` — the
  same DOM-light halves **sSMLM**'s own two buttons call (see that module's own paragraph on the
  split) — redrawing the raw (left) panel with the resulting Distances/Angles histogram (requested,
  same round — the visual feedback Preview pairs itself already gives, missing from the first
  version of this button, which was silent there too) but deliberately SKIPPING the RECONSTRUCTION
  (right) panel's own "plot" tail either interactive wrapper would run (no LUT switch, no z-range
  change, no rerender), so it doesn't hijack whichever SOI composite or time trace that panel
  currently shows. Its only real design question — **which
  channel to pair when ALEX is on** — was resolved directly with the user: there are conceptually
  TWO separate SOI channels once ALEX is ticked (direct-donor-excitation, giving DD/DA intensity
  pairs; direct-acceptor-excitation, giving AA locs/traces), but only ONE is ever held in
  `smfretSOI`/`lastResult` at a time (`alexProjChannel`, shared with the Data-projection view's own
  donor/acceptor toggle) — **for now, this button only ever pairs the donor channel**. Rather than
  silently recomputing/discarding whatever composite is currently showing (a real, surprising side
  effect for a button whose whole point is to run quietly), it just refuses with a clear log message
  if `alexProjChannel!=='dirDonorExc'` — the common case regardless, since that's the default and
  what a fresh stack load/Localize SOI run always resets it to; the acceptor composite is only
  reached by an explicit toggle click. Once it succeeds, `getSmfretTimeTraces()`'s own existing
  `fromSmfretSOI && isFinite(lastResult.locs[0].dist)` check (see below) picks up the DD/DA split
  automatically — no changes needed there at all. Verified via Playwright against the real
  ALEX/prism dataset: clicking it pairs the 286-site donor SOI set, leaves `srInfo`'s text and the
  Colour map/`zcolor` fields completely untouched (confirming the silent, no-side-effect design),
  and a subsequent **Get time traces** correctly reports both `photonsDD` and `photonsDA`.

  **The SOI composite's own overlay marks (not filters) pairing survivors — reverted from an
  earlier, stricter design on direct follow-up.** The FIRST version of this feature (requested that
  round: "after pairing, the SOI composite should filter out all ROIs and locs that do not belong
  to a pair anymore") actually REMOVED an unpaired site's own green ROI box/magenta crosshair from
  `srSpots`/`srLocs` — reverted the very next round, reported: "most all DA and locs boxes vanish...
  How about changing the colour of ROI boxes for the DAs to dark orange to see that they became
  part of a pair?" `srSpots`/`srLocs` now ALWAYS stay the full, unfiltered `maxima`/`smfretSOI` once
  a composite is showing — no more object replacement, no more identity-check workarounds (the
  earlier version's own `__pairedSOI` tag hack, needed only because `srLocs` used to become a
  DIFFERENT filtered array, is gone entirely — `srLocs===smfretSOI` alone is sufficient again once
  it never changes). Instead, `markSmfretSoiPairedKeys(pairedLocs)` (renamed from
  `filterSmfretSoiOverlayToPairs()`) builds `smfretPairedSoiKeys` — `{spotKeys, locKeys}`, two
  `Set`s keyed differently — and `drawSpotOverlays()` (MODULE: render) consults it to recolour a
  matching entry `PAIRED_SPOT_COLOR` (`#d2691e`, dark orange) instead of the usual green (spots) or
  magenta (locs). Two different keys are needed because `spots`/`srSpots` (the green-box overlay,
  `maxima`, coarse pre-fit INTEGER `[cx,cy]` pairs) has no direct link to a fitted site's own
  sub-pixel x,y once some maxima have been dropped for failing to fit (`fitted.length` can be less
  than `maxima.length`, and the two are NOT index-aligned) — `smfretSOICore()`'s fit loop stashes
  `_maxCx`/`_maxCy` (the ORIGINATING detected-maximum's own integer position, an internal
  bookkeeping field, leading-underscore convention matching `lastResult._zColorAutoChecked`) on
  every fitted site for exactly this, so `spotKeys` can be built from a paired entry's own
  `_maxCx|_maxCy` while `locKeys` matches the fitted `x|y` directly. Shared by
  `getSmfretPairingFromDonor()`, `refreshSmfretPairingLive()`, and `linkSmfretChannels()` (below) so
  the three re-marking call sites can never implement this differently — each just calls
  `markSmfretSoiPairedKeys()` with whatever `lastResult.locs` currently holds after its own action,
  and a plain `clampView(); drawView();` (no `rerender()`, since `srFull`, the composite image
  itself, never changes — only the overlay's own colouring does) repaints it. Reset to `null`
  (clearing any stale marking) at the same points `sSmlmOriginalLocs` itself resets: a fresh
  Localize SOI run, `unpairSSmlm()`, and `clearSmfretFixSOI()`.

  **"Channels to show" renamed "Filter SOIs"** (requested — the field now also gates a NEW
  action, **Link channels** below, not just Get time traces' own display). **"Position donor?"**
  (`smfretDonorAngleRow`/`smfretDonorAngle`, shown alongside it once ALEX is on) answers a real
  gap: the doubled-bearing angle fit (`fitSSmlmDistAndAngle()`, MODULE: sSMLM) can only recover the
  ANGULAR SPACING between the two orders, never which of the two 180°-apart candidates actually
  points from donor toward acceptor — that needs the user's own knowledge of the real optical
  setup, not something derivable from the data. `refreshSmfretDonorAngleOptions()` FREEZES the two
  candidate values (current Primary angle, and that +180° wrapped) the moment a real fit runs —
  called from `fitSSmlmDistAndAngle()` itself, right after it sets the field — rather than
  recomputing them live on every possible Primary-angle change, so toggling between the two options
  keeps offering the SAME pair, not a shifting one recentred on whichever was just picked. Selecting
  an option directly sets `sSmlmAngleCenter` and dispatches a real `change` event — one single
  source of truth for bearing, no new parameter threaded into `pairCore()` — so it also transparently
  triggers `refreshSmfretPairingLive()`'s own live re-pair for free.

  **"Link channels"** (`smfretLinkChannelsBtn`, new button sharing **Get time traces**' own row, to
  its left) closes the "not yet implemented" gap this module's own hint text used to flag — linking
  a direct-acceptor-excitation (AA) site to a donor-channel DD/DA pair. Enabled only with
  **Alternating laser excitation?** checked AND a real DD+DA pairing already committed
  (`smfretHasDDDAPairing()`, factored out of `getSmfretTimeTraces()`'s own identical check — now
  shared by both). `linkSmfretChannels()` itself ALSO requires **Filter SOIs** = `DD+DA+AA` to
  actually do anything (refuses with a log message otherwise) — deliberately a separate check from
  the button's own enable gate, matching the request's own precise wording ("grayed out as long as
  we are not in Alternating laser excitation mode" — only that one precondition disables the
  button itself). Runs a FRESH, on-demand `smfretSOICore(cfg, stack)` call with
  `smfretSoiChannel:'acceptor'` — the same detect+fit pass **Localize SOI** itself would run on that
  channel, but never persisted into `smfretSOI`/`lastResult` (a one-off comparison; re-clicking
  re-localizes from scratch every time) — then, for every already-paired row, checks whether ANY
  resulting AA site sits within `LINK_RADIUS_PX` (2, a plain Euclidean `Math.hypot`) of that row's
  own `x2,y2` (the DA/acceptor-channel position from pairing); a pair with no such AA site is
  dropped. `lastResult.locs` is genuinely REPLACED with the surviving subset (a real data
  reduction, unlike the composite's own display-only marking below), and
  `markSmfretSoiPairedKeys()` re-marks the SOI composite's own overlay to match — reusable as-is
  here since a surviving row's own `x,y` (the DONOR position) is untouched by this step, still
  matching the original `smfretSOI` entry by value exactly like the pairing-stage marking does.
  Idempotent — re-clicking re-localizes the acceptor channel fresh and re-applies the same 2 px
  test to whatever `lastResult.locs` currently holds. Verified via Playwright against the real
  ALEX/prism dataset: 50 DD+DA pairs → Link channels localizes 283 independent AA sites → keeps
  48 pairs with a nearby AA hit (also checked with a genuinely different Primary angle from
  **Position donor?** first: 78 pairs → 77 kept) — `srSpots`/`srLocs` and `lastResult.locs.length`
  stay in sync throughout, and a second click on an already-linked result is a stable no-op
  (77→77).

  **`getSmfretTimeTraces()` already sampled AA at the DA position during acceptor-excitation
  frames** (asked about directly, same round — "How is decided which localisation of a pair is
  coming from donor or acceptor... add AA obtained from DA loc positions but in direct acceptor
  excited frames") — re-confirmed by re-reading the per-frame loop (see its own existing comment
  a few paragraphs up: "AA is direct-acceptor-EXCITATION, so ... its emission physically belongs at
  the ACCEPTOR's own channel position (x2,y2)") and re-verified end to end via Playwright (60-frame
  real ALEX dataset → exactly 30 finite `photonsDD`/`photonsDA`/`photonsAA` samples each, one per
  excitation half) — no code change needed here, a shipped fix from an earlier round already
  covers exactly this.

  **A real, reported bug in `getSmfretPairingFromDonor()` itself, found the very next round**:
  clicking **Pair DD + DA** the FIRST time (fresh ALEX + Localize SOI, no manual Preview pairs
  first) produced only a handful of pairs; clicking it again immediately after produced many more
  — "clicking it the first time shows only very few pairs, clicking another time produces much
  more pairs. Why?" Root cause: `cfg` (the window `pairSSmlm()` actually pairs with) was captured
  from the sidebar fields BEFORE `previewSSmlmPairsCore()` ran — but that call INTERNALLY auto-fits
  those same four fields (`fitSSmlmDistAndAngle()`, called from inside it) to the real data. So the
  first click always paired using whatever STALE window was already sitting there (the `PARAMS`
  defaults, e.g. distance 2200–2800/angle 0°±5°, on a dataset whose real peak sat at 253–691 nm /
  −89°±6°) — almost nothing qualifies. The second click then captured `cfg` from the FIRST click's
  own auto-fitted output (now sitting correctly in the fields), pairing correctly. Fixed by moving
  `cfg` construction (and its `logCmd()`) to AFTER `previewSSmlmPairsCore()` returns, so it always
  reflects the window pairing is about to actually use — the fit runs, then pairing reads the FRESH
  result, every single time, first click included. This bug also explains a SECOND report from the
  same round ("time traces currently do not show signs of DA") that turned out to have the
  identical root cause, not a separate one: the few, mismatched pairs the buggy first click
  produced had geometrically poor/border-adjacent `x2,y2` positions, so `smfretExtractIntensity()`
  rejected most of them — fixing the ordering bug alone restored real DA signal (re-verified:
  79 pairs on the first click now, 934 non-zero DA samples spanning ~600–1300 photons, and the
  time-trace plot's own magenta DA curve visibly renders — 556 magenta pixels on a real canvas
  check, versus a flat, signal-free line before the fix).

  **"Position donor?"'s own option labels corrected to the 0°–360° convention** (reported, with a
  screenshot — "this is inconsistent. Angle should be as in the 2D histogram running between 0 and
  360"): `sSmlmAngleCenter` is stored SIGNED (`[-180°,180°)`, the convention `pairCore()`'s own
  bearing math and the field's own `PARAMS` range both rely on), but the Angles polar plot right
  next to it labels its spokes 0°–360° (0°=right, 90°=top, increasing counterclockwise). Showing a
  raw signed value like "-87.0°" in the dropdown read as a different angle convention than the
  histogram beside it. Fixed by changing only the DISPLAYED label
  (`wrap360(+v,0).toFixed(1)+'°'`) — `option.value` still carries the real signed number, so
  picking an option still sets `sSmlmAngleCenter` to the exact value `pairCore()` expects,
  unchanged; only the text shown to the user now matches the histogram's own convention (e.g.
  `-89°` displays as `271.0°`).

  **"Channels to show" → "Linking SOIs" → "Filter SOIs"** — renamed twice in two rounds (the first
  rename, to "Linking SOIs", was itself superseded on direct follow-up the very next round).

  **"Fix sites of interest (SOI)" default confirmed already on** (asked about directly — "set
  default to on") — its own PARAMS entry (`default:true`) and the HTML checkbox's own `checked`
  attribute already agree; re-verified via Playwright on a completely fresh page load with no data
  at all. The likely source of the confusion: `initScrub()` force-UNCHECKS it on every fresh STACK
  load (`smfretSOI=null; $('smfretFixSOI').checked=false;`) — a deliberate, already-documented
  design (a status flag scoped to one loaded dataset, not a sticky preference, same reasoning
  `calFixedXY` already established) rather than a wrong default — left unchanged, since changing it
  would contradict that established, still-correct design rather than fix an actual default.

  **Three small ROI thumbnails below the Time trace plot** (`smfretRoiThumbsRow`, requested) — DD/
  DA/AA (only the ones that actually exist for the current site, matching `photonsDA`/`photonsAA`'s
  own presence), each a small contrast-stretched crop of the real camera pixels around that
  channel's own extraction position, purely as a quick visual sanity check that a position genuinely
  sits on a molecule rather than background — the SAME motivation as the dark-orange composite
  marking above, one level more zoomed in. `drawSmfretRoiThumbnails(idx)`, called fire-and-forget
  (not awaited) from the end of `drawSmfretTrace(idx)` — a genuinely async frame fetch
  (`stack.getFrames()`) inside an otherwise-synchronous plot draw, so it populates a moment after
  the main plot rather than blocking it. Deliberately NOT scrubbed with the main Frame slider — each
  channel uses one FIXED representative frame (the first frame of its own relevant parity: donor-
  excitation for DD/DA, acceptor-excitation for AA — `firstFrameOfParity()`), since this view exists
  to confirm the position, not to browse every frame. `smfretTraces[idx]` itself gained `x2`/`y2`
  fields (previously only ever read locally inside `getSmfretTimeTraces()`'s own per-frame loop from
  the SOURCE `sites` array, then discarded — never carried onto the trace object) so this function
  has DA/AA's own extraction position to crop around. `_smfretRoiGen` (a plain incrementing counter,
  the same shape as this codebase's own `newEpoch()`/`staleEpoch()` convention elsewhere, just
  scoped locally to this one feature rather than the shared session-wide epoch) guards against
  scrubbing sites quickly leaving an OLDER site's still-in-flight frame fetch draw over a NEWER
  selection's canvas. Each crop is contrast-stretched against its OWN local min/max (not the raw
  panel's shared fixed Contrast slider range, tuned for a whole frame, not a `2×winr+1` px crop) and
  rendered at native crop resolution with `image-rendering:pixelated` CSS scaling it up crisply
  (`48px` display size) rather than blurring. Hidden at the same points the site scrubber itself
  (`smfretTraceScrubRow`) hides — a fresh Localize SOI, `clearSmfretFixSOI()`, switching to "Show
  raw frame", or a fresh stack load — so a stale thumbnail never lingers once the underlying trace
  data it was showing is gone.

  **`smfretSOICore(config, stack, checkStack=true)`** (v0.12.1-dev) is the pure, DOM-free half of
  `locateSmfretSOI()` — the averaging+detect+fit loop, extracted so `analyze()`'s own
  `config.smfretLocateSOI` can call the identical logic (MODULE: pipeline's own `*Core()`/wrapper
  split). Mutually exclusive with the normal per-frame `runCore()` path in `analyze()` — set, it
  REPLACES the whole Localize step (matching the interactive button's own "replaces whatever the
  current result was" behavior), producing `r={w,h,timings:null}` the same minimal shape a `.csv`
  input already uses. **`checkStack` surfaced a real, previously-latent bug**: `averageFrames()`
  (its own inner loop, called by `smfretSOICore()`) aborts early if the module-level `stack` global
  no longer matches the one it was given — correct for the INTERACTIVE case (a user can swap stacks
  mid-average), but `analyze()`'s own `stack` is a separate, function-local variable of the same
  name that SHADOWS the module-level one — the global stays `null` in a fresh headless page, so the
  check was `null!==<real stack>` on every single call, 100% of the time, returning `null`
  immediately. `smfretSOICore()` never worked headlessly until this was caught (same "a module-level
  global populated before every interactive call site is invisible until something calls the same
  function headlessly" lesson as **spt**'s own `segmentedImageData` bug). Fixed by adding an explicit
  `checkStack` parameter to `averageFrames()` itself (default `true`, so every existing interactive
  call site — this one, `locateBeadsForCalib()`, `showStackProjection()` — is untouched), threaded
  through as `false` only from `analyze()`'s own call site.

  **`smfretFixSOI`** ("Fix SOI x,y for time traces", default unchecked) is a STATUS flag, not an
  independent on/off switch like 3D calibration's own `calFixedXY` — `locateSmfretSOI()` itself
  checks it (no `change` dispatch) on every successful run, explicit click or auto-rerun alike;
  there's no way to distinguish "just auto-checked" from "user clicked it", so only the UNCHECK
  direction has a real handler: it clears `smfretSOI`/`smfretTraces`, restores the reconstruction
  panel's general overview, and hides the site scrubber (below) in favour of the ordinary Frame one
  — same "uncheck to discard and restore" shape as `calFixedXY`'s own uncheck branch, just without
  its check-to-trigger direction. `initScrub()` resets it to unchecked on every fresh stack load,
  same reasoning as `smfretSOI` itself (scoped to one loaded stack, not sticky).

  **Get time traces** (`getSmfretTimeTraces()`) extracts every `smfretSOI` site's intensity — its
  known x,y only picks which `win×win` window to look at, never re-detected by scanning the whole
  frame — in EVERY frame of the loaded movie. Sequential over frames (`await stack.getFrames(fi,
  fi+1)` per frame, `await tick()` every ~50ms) — not worker-parallelized, matching the "simple
  check" scope of this feature; a real performance concern only once dataset sizes grow past what
  prompted this. Wired to the shared progress bar (`setProg(100*(fi+1)/n)`, `setProg(null)` in a
  `finally`) — reported: many sites × many frames, most of which won't contain a real localization
  for a given faint site (extraction still runs there regardless, same cost either way), can take a
  while with zero visual feedback otherwise, the same `onProgress`→`setProg` convention `sptCore()`/
  `pairCore()`/`driftCore()`/`calibrationCore()` already use. `smfretTimeTracesBtn` disables for the
  duration (re-enabled in the same `finally`, gated on `smfretSOI` still being non-empty — mirrors
  `runSptTrack()`'s own disable/`finally`-re-enable shape).

  **Two extraction methods, chosen by `smfretApertureMode`** ("Aperture photometry (no fit)",
  default unchecked, v0.12.1-dev). This went through THREE iterations while diagnosing a real,
  reported bug: on a real donor-heavy prism/polychroic dataset, several sites' time traces showed
  isolated single-frame "spikes" (amplitude 10-120x the surrounding frames) with NO corresponding
  brightness in the raw pixels at all (checked directly — the raw ADU values under the fit window on
  a spike frame looked identical to calm neighbouring frames).

  1. **Originally**: `gaussianFitEllipticalFixedXY()` (MODULE: fit — the exact fixed-position fitter
     3D calibration's own `calFixedXY` mode still uses, unmodified). Root cause of the spikes: an
     UNWEIGHTED nonlinear least-squares fit, fine for `calFixedXY`'s own bright, well-isolated
     calibration beads, but real smFRET candidate sites are often only detectable at all because
     **Localize SOI** averages many frames first — a SINGLE frame's own fit window can be close to
     flat background noise, and fitting a Gaussian PSF shape to that is ill-posed; the optimizer
     occasionally converged to a spurious narrow/high-amplitude "fake" peak (σ shrinking toward its
     0.5 px floor) that happened to fit one frame's random noise pattern unusually well.
  2. **Then**: reported feedback — there is no reason to FIX x,y at all here, unlike calibration's
     own bright/well-isolated beads; a standard 2D MLE fit with x,y merely SEEDED at the known
     position (free to move) should simply fail to converge, or get rejected, on a frame with no
     real molecule — that IS the desired behaviour, not something to special-case around. Switched
     the default to `gaussianMLEspheric()` (MODULE: fit — the exact same fitter an ordinary Localize
     run uses) seeded at the site's rounded position, x,y left free. This alone cut the worst site's
     max/median ratio from 117x to ~25x and correctly turned most of the remaining bad frames into
     NaN gaps (the fitter's own existing accept/reject logic — non-convergence, amplitude pinned at
     its floor, position drifted too far from the seed) — but not all the way: gain/camoffset are now
     applied (`paramValue('gain')`/`paramValue('camoffset')`), so `smfretTraces`' `photons` field is
     now true photon units, no longer the deliberately-uncorrected raw ADU the fixed-position fitter
     produced.
  3. **Then**: direct pixel inspection of a remaining spike (site 5, frame 23: fitted photons=27,326,
     raw 7×7 box sum barely moving between frames) revealed the fitted σ was 5.95 px — essentially
     UNBOUNDED, since `mleClampSpherical()`/`mleClampElliptical()` (right above `gaussianMLEspheric`)
     previously had NO ceiling on σ at all, unlike their LSQ siblings which already clamp to [0.5,6].
     A wide, dim, diffuse "blob" spread across the whole window integrates to a large total photon
     count from pure noise, with no localized bright pixel needed at all — a real, different failure
     mode from the floor-pinned one. Fixed at TWO levels:
     - **Shared, app-wide** (affects every caller of the 3 MLE fitters — `gaussianMLEspheric`/
       `gaussianMLEelliptic`/`gaussianMLEellipticangled`): added `MLE_MAX_SIGMA=6` (MODULE: fit, right
       after `MLE_MIN_SIGMA=0.5` — the SAME ceiling value the LSQ fitters already use, not a new
       number invented here) to both clamp functions, and extended all three fitters' own
       accept/reject line to also reject a result with σ (or σx/σy) pinned at EITHER `MLE_MIN_SIGMA`
       or `MLE_MAX_SIGMA` — symmetric with the existing amplitude-floor reject already there.
       `MLE_MAX_SIGMA` added to `WORKER_PRELUDE` alongside `MLE_MIN_SIGMA`/`FIT_MAX_DRIFT_SIGMA_MULT`
       (the Web Worker gotcha — a module-level `const` a stringified fitter reads must be re-declared
       there too). Deliberately conservative: reuses an EXISTING, already-shipped bound rather than
       picking a new one, and only rejects a result already pinned exactly at a floor/ceiling — a
       genuinely well-converged fit essentially never lands there by chance.
     - **smFRET-specific, on top** (`getSmfretTimeTraces()` itself, not the shared fitter): the
       shared 6px ceiling alone still wasn't tight enough — checked against the real dataset, a σ of
       3-4px (comfortably under 6, against a 1.3px seed) is ALREADY wide enough, relative to the fit
       window's own half-width, that a large fraction of the model's Gaussian mass extrapolates past
       the window edge, so the reported total "photons" stops being meaningfully constrained by the
       actually-observed pixels. Added `if(L && L.sigma<=FIT_MAX_DRIFT_SIGMA_MULT*sigma) traces[j]
       .photons[fi]=L.photons;` — reusing `FIT_MAX_DRIFT_SIGMA_MULT`'s (2) own "how far can a trusted
       result differ from its seed" reasoning, generalized from position to width. Empirically
       checked, not guessed: of 564 accepted fits across all 14 real sites, only 13 (2.3%) exceed
       2×σ_PSF, and EVERY one of those 13 is a clear photon-count outlier (median 8686 vs. the kept
       population's 2112) — a clean separation, not a borderline cutoff. Deliberately scoped to
       smFRET's OWN code, not folded into the shared fitter — 3D calibration's own astigmatic fits
       legitimately need σ to range far more widely away from focus, so tightening the SHARED ceiling
       to 2×σ_PSF would risk rejecting valid calibration data; this narrower check only applies where
       x,y is merely seeded (not genuinely being scanned across a real z-range).

  End-to-end result on the same real dataset: max/median ratios that were 1.4-120x with the original
  fixed-position LSQ fit are now 1.2-9.1x with the final free-position MLE + both sigma-plausibility
  gates — most sites' remaining variation now looks like genuine single-molecule blinking (extended
  ON stretches, then a NaN-gap-heavy tail consistent with photobleaching) rather than isolated
  divergent spikes.

  **`smfretApertureMode`** checked runs `apertureIntensity(img,w,h,cx,cy,win,gain)` (right above
  `getSmfretTimeTraces()`) instead: a linear operation with no iterative optimizer, so it structurally
  cannot diverge the way either fit can, at the cost of not reporting a per-frame width. `camoffset`
  cancels out exactly in a background-SUBTRACTED linear sum (no need to pass it separately) — only
  `gain` remains, applied as a final multiplicative scale so both methods report the same
  true-photon-unit convention. As of the aperture-photometry consolidation below (see **fit**'s own
  `apertureGeometry()`/`percentile()` paragraph), this calls the SAME shared circular-disk +
  background-annulus + 56th-percentile geometry `phasorFit()` itself now uses — not the square-box
  ring-mean version this paragraph originally described, superseded on request ("best to not have too
  many different methods"). Registered as an ordinary `PARAMS` bool entry (`type:'bool'`), so it's automatically part of
  Save/Load Settings like every other `PARAMS` field — `getSmfretTimeTraces()` itself still has no
  headless equivalent (unaffected by this). Its own `change` listener auto-reruns `getSmfretTimeTraces()`
  when traces are ALREADY showing (`if(smfretTraces) getSmfretTimeTraces();`) — reported: toggling
  the checkbox while a trace was on screen had no visible effect until "Get time traces" was clicked
  again, easy to miss since the checkbox itself gives no other feedback. Gated on `smfretTraces`
  specifically (not merely `smfretSOI`), matching Localize SOI's own settings-change listeners'
  "refresh an existing result, don't auto-START a fresh one" convention — checked and confirmed via
  Playwright NOT to auto-start a run before Get time traces has ever been clicked once.

  **Three more reported fixes, same round.** (1) A REJECTED/non-converged `gaussianMLEspheric` fit
  now writes `0` into `traces[j].photons[fi]`, not the array's `NaN` fill default — the reject logic
  already IS the best-available judgement that no real molecule was on at that site that frame, a
  real, physically meaningful ZERO intensity, not missing data; `NaN` is now reserved for the
  genuinely different "too close to THIS frame's own edge" case just above it (no window to even
  attempt a fit on). `drawSmfretTrace()`'s NaN-breaks-the-line logic and its own `nGaps` counter both
  benefit for free — a rejected fit no longer shows as a break in the curve, and "N frame(s) not fit"
  now means exactly that, not "fit ran and said no." (2) `apertureIntensity()` is now floored at 0
  (`Math.max(0, ...)`) — a negative photon count has no physical meaning regardless of where a
  negative raw result might come from (see the geometry rewrite below for what actually caused it).
  (3) Editing **Frame time (s)** while a Time trace was showing left the plot's own x-axis stale (it
  reads `frametime` fresh on every draw, per `drawSmfretTrace()`'s own comment, but nothing previously
  triggered that redraw when `frametime` itself changed — spt's own `frametime` listeners only ever
  refreshed spt's own displays). Fixed with one more `$('frametime').addEventListener('change', ...)`
  guarded by `smfretOwnsRawPanel()`, same gating convention `liveStreamOwnsRawPanel()` already
  established for its own scrubber redraws.

  **`apertureIntensity()` rewritten on a published, previously-validated method** (v0.12.1-dev, same
  round) — the ORIGINAL version (square `win×win` box, background = MEAN of that same box's own
  outermost ring) was ad-hoc, and its background ring sitting flush against the signal region's own
  edge meant real PSF tail could leak into it, biasing background high (occasionally producing a
  negative "intensity" before the floor above was added). Switching that ring's estimator from mean
  to MEDIAN was tried first (median seems like the more "robust" choice) and made things WORSE, not
  better — empirically checked against the real dataset: several sites' spikiness increased, one
  drastically (ratio 92x → 3313x), because the ring is only ~24 pixels for `win=7`, and a median's
  own sampling variance for that few samples (~1.57x a mean's, for the same N — a standard result)
  outweighs whatever real-signal-contamination bias it was meant to fix; a noisier estimator on a
  small sample is the wrong fix for a geometry problem. The user pointed to the RIGHT fix instead —
  and then, on a follow-up request to avoid maintaining two different aperture-photometry
  implementations, `apertureIntensity()`'s own geometry/percentile logic was further consolidated
  with `phasorFit()`'s own (below) into ONE shared `apertureGeometry()`/`percentile()` pair — see
  **fit**'s own paragraph on them above for the full method, citations, reverse-engineering story,
  and the worker-stringification bug that needed catching along the way.

  **`drawSmfretTrace(idx)`** plots one site's intensity-vs-frame curve in the raw (left) panel,
  following the exact "left panel doubles as a plot surface" pattern drift/NeNA/FRC already use
  (`rawFull=null; setRawPlot(true); rawPlotName='smfretTrace'`, `setupPlot()` for the 4:3
  letterbox, `_replotRaw` for resize/theme redraws, `registerPlotHover()` for the hover readout) —
  structurally a simplified `drawDriftCurveVsFrame()` (one curve, no drift-specific dashed-stop
  marker), breaking the line at any `NaN` sample instead of interpolating across a gap or drawing
  to a non-finite coordinate. **Y-axis ticks use `axisScale()`** (reported — full 5-6 digit ADU
  values visually collided with the rotated "intensity (ADU)" axis title, the exact same failure
  `drawPcfoPlot()`'s own large-value axis already needed `axisScale()` for): small 1-2 digit ticks
  plus one `×10ⁿ` multiplier drawn once near the axis, same placement convention (`mL, mT-8`).
  **`smfretOwnsRawPanel()`** (`smfretTraces!==null && !smfretShowRawFrame`) is the same
  "another feature owns the raw panel" pattern `liveStreamOwnsRawPanel()` established for its own
  scrubber — checked by the SAME shared `scrubByWheel` routing (MODULE: pipeline) that already
  branches on `liveStreamOwnsRawPanel()`, redirecting shift+wheel/slider-wheel to the dedicated
  `#smfretTraceScrubRow` (mirroring `#liveStreamScrubRow`'s own structure: a range input + a
  number+total pair) instead of the ordinary `#scrubRow`. A fresh `locateSmfretSOI()` run
  invalidates any trace view already showing (positions may have shifted) — reclaims the panel back
  to the ordinary Frame scrubber the same way unchecking `smfretFixSOI` does (hide
  `#smfretTraceScrubRow`, show `#scrubRow`, `showFrame()`).

  **`smfretTraceModeBtn`** ("Show raw frame"/"Show time trace", v0.12.1-dev) toggles the raw panel
  between the trace plot and the live raw frame WITHOUT discarding `smfretTraces`/`smfretTraceIdx` —
  reported: once a trace was showing, there was no way back to browsing raw frames short of
  discarding the whole SOI/trace state (unchecking `smfretFixSOI` or re-running Localize SOI), making
  it hard to visually cross-check a trace against the frame it actually came from. `smfretShowRawFrame`
  (module-level bool, default `false`, reset to `false` every time a fresh Get time traces run
  completes — same "fresh action reopens on its own default view" convention `driftPlotMode`/
  `sSmlmHistMode`/`sptHistMode` already use) is the switch `smfretOwnsRawPanel()` itself now also
  checks. The button's own click handler mirrors the exact show/hide pairs `locateSmfretSOI()`'s own
  trace-invalidation branch and the `smfretFixSOI` uncheck handler already use (swap
  `#scrubRow`/`#smfretTraceScrubRow` visibility, call `showFrame()` or `drawSmfretTrace()`) — just
  without nulling `smfretTraces` itself. **Deliberately NOT added to `hideOtherRawToggleBtns()`'s
  mutual-exclusion list** — that list is for buttons that switch BETWEEN DIFFERENT raw-panel
  features (drift/spt/sSMLM/segmentation); `smfretTraceModeBtn` instead toggles between two views of
  THIS SAME feature's own content, the same precedent `rawFtmBtn` (raw/FTM-corrected) already
  established, so it must survive `drawRaw()`'s own `hideOtherRawToggleBtns(null)` call when the
  raw-frame sub-view is showing. Shown (`style.display=''`) only in `getSmfretTimeTraces()`'s own
  success branch, right alongside `#smfretTraceScrubRow`; hidden at the same three places that null
  `smfretTraces` (the `locateSmfretSOI()` invalidation branch, the `smfretFixSOI` uncheck handler, and
  `initScrub()`'s fresh-stack-load reset) — `drawSmfretTrace()`'s own `hideOtherRawToggleBtns(null)`
  call correctly leaves it alone either way, per the paragraph above.

  **`.scrubslider`** (MODULE: params, the
  5 CSS rules right after the navigator comment) is the shared class giving every single-handle
  scrubber (`#scrub`/`#liveStreamScrub`/`#smfretTraceScrub`) its custom themed thumb/track — reported:
  this used to be a hardcoded id list instead of a class, so `#smfretTraceScrub`, despite copying
  `#liveStreamScrubRow`'s own markup exactly, still rendered with the browser's plain native thumb
  until its id was separately added to all 5 rules; a shared class means a FUTURE scrubber just
  needs `class="scrubslider"` to get the right look with no CSS change required at all.

  **`drawSmfretTrace()`'s x-axis is TIME (s), not frame index** (reported — a raw frame-number axis
  is meaningless without knowing the acquisition's own frame time). Exploits that
  `time = frame_index × frametime` is exactly linear: the existing per-frame pixel-mapping function
  `X(f)` needed NO change at all (it still maps a frame index to an x pixel) — only the TICK
  generation changed, from iterating frame-based `niceTicks` to iterating time-based `niceTicks(0,
  (n-1)*frametime, 6)` and converting each "nice" time value back to an equivalent (possibly
  fractional) frame index via `t/frametime` before handing it to the unchanged `X()`. `frametime`
  (`paramValue('frametime')`, "Frame time (s)") is read fresh on every draw, so editing it live
  redraws the trace in the new units via the usual `_replotRaw` mechanism. Tick VALUES are chosen in
  time directly (not translated from "nice" frame numbers) so they land on round seconds rather than
  whatever odd time a nice frame number happens to produce; `decT` (tick decimal places) scales up
  for short (<10s) traces, where whole seconds alone would collapse most ticks to "0". The hover
  tooltip shows both (`t = X.XX s (frame N)`) so the underlying frame is still recoverable.
  **`yScale.label`'s font (the `axisScale()` `×10ⁿ` multiplier, top-left)** was 11px against the
  12px tick labels/axis titles it sits beside — reported as reading too small next to them; bumped to
  match at 12px. The identical `axisScale()`-multiplier font-size fix was also applied to
  `drawPcfoPlot()` and the shared `drawHistogram()` (table/spt/sSMLM histograms) for the same
  app-wide consistency, not just this one plot.

  **`smfretFloorZero`** ("Floor intensities to 0", default checked, v0.12.1-dev) is a new
  `PARAMS` bool controlling ONLY `apertureIntensity()`'s own existing `Math.max(0,...)` floor on
  its computed background-subtracted value — confirmed via grep that this function has exactly one
  caller (`getSmfretTimeTraces()`), so this can't reach `phasorFit()`, which uses the separate
  shared `apertureGeometry()`/`percentile()` helpers, not this function. Unticking it lets a
  genuinely negative value through instead of clamping it — for FITTING an intensity
  *distribution* afterward (e.g. an OFF-state population centred near zero with a real negative
  tail from noisy background subtraction), a raw negative value is more informative than an
  artificial floor at zero. Deliberately scoped to this one function only, per explicit
  confirmation: the MLE-fit path's own "a rejected/non-converged fit reports 0" convention (see
  above) is a different concept — a judgement that no molecule was on, not a floored computed
  value — and stays untouched regardless of this checkbox.

  **DD/AA/AA excitation-channel splitting** (v0.12.1-dev) makes the trace plot ALEX-aware. Each
  site's trace object grows from one `photons` array to `{photonsDD, photonsAA, photonsDA}` — only
  `photonsAA`/`photonsDA` when applicable, `photonsDD` always present (so the case with neither
  ALEX nor pairing active renders pixel-for-pixel identically to the original single-curve
  behaviour). With **Alternating laser excitation?** checked, `getSmfretTimeTraces()`'s own
  per-frame loop already knows each frame's parity (`alexFirstFrame`'s existing convention, the
  same one the Data-projection view uses) — a donor-excitation frame's extracted value goes into
  `photonsDD`, an acceptor-excitation frame's into `photonsAA`, both read at the SAME (donor/site)
  position. Pairing the SOI set first (**Spectral SMLM analysis**'s own **Preview pairs**/**Pair**,
  which already works on Localize SOI's sites unmodified — see that module's own paragraph on why)
  further splits DD into DD and DA: `getSmfretTimeTraces()` detects a paired result via
  `lastResult.fromSmfretSOI && isFinite(lastResult.locs[0]?.dist)` (the `fromSmfretSOI` marker
  survives pairing — confirmed by reading `runSSmlmPair()`, which only ever mutates
  `lastResult.locs` in place, never rebuilds the object — so this safely tells "smFRET's own
  paired SOI result" apart from an unrelated Localize-then-Pair workflow that also happens to
  produce a `dist` field), and when true iterates the paired rows instead of `smfretSOI` directly,
  reading a THIRD value at each pair's own `x2,y2` (the 1st order's position, see **sSMLM**'s own
  paragraph on this) into `photonsDA`. DA is sampled only during donor-excitation frames — the
  same frames as DD, a different spatial channel — regardless of whether ALEX is on (with ALEX
  off, "every frame" already counts as donor-excitation, matching the non-split behaviour). The
  per-position extraction logic (aperture-vs-MLE-fit branch) was pulled into a shared
  `smfretExtractIntensity(img,w,h,cx,cy,win,sigma,gain,camoffset,useAperture,floorZero)` helper so
  it can be called once per channel per frame instead of duplicated three times inline.

  Colours reuse the project's own established palette: DD = `#0a7d32` (the drift-x/NeNA-signal
  green), AA = `#3572b0` (the drift-z blue), DA = `#c81cc8` (magenta — already this plot's own
  pre-existing single-curve colour, and the app's established "pairing" colour elsewhere). DD and
  DA are drawn on the SAME graph per site, overlaid exactly like DD/AA. `drawSmfretTrace()` labels
  whichever curves exist with small colour-coded text near the plot (`drawDriftCurve()`'s own
  "drift x"/"drift z" convention) — the plain single-curve case (neither split) stays unlabeled.

  **Real bug caught and fixed the same round: ALEX's own per-frame alternation broke line
  rendering entirely.** A split channel's array is NaN on every OTHER frame by construction (not a
  gap — that frame simply isn't this channel's turn), but the original line-drawing loop reset
  `started=false` on ANY NaN with no way to tell the two cases apart — since a channel's real
  samples are then never two frames apart, `started` always resets before a second point can ever
  reach `ctx.lineTo()`, so every "line" rendered as a set of isolated, invisible zero-length
  `moveTo`s (confirmed via Playwright: labels/axes drew correctly, canvas pixel-colour counts for
  all three curve colours were exactly zero). Fixed by giving each curve an explicit `parity`
  (which `frame%2` it actually samples — `null` when every frame belongs, i.e. ALEX off or the
  unsplit case) and having the draw loop `continue` silently past an off-parity frame (not this
  channel's frame at all) while still breaking the line on a genuine same-parity NaN gap. The
  `nGaps`/"N frame(s) not fit" counter in `rawInfo` needed the identical fix — it was counting
  every off-parity NaN as "not fit" too, which would overstate the gap count by roughly half
  whenever ALEX is active; now counted only over DD's own applicable frames.

  **X-axis zoom** (`smfretTraceView={x0,x1}`, frame-index units) mirrors the existing SPT
  MSD-plot/line-profile zoom pattern exactly: wheel/pinch/drag to narrow, double-click to reset.
  Reset to the full range (`null`, resolved to `{x0:0,x1:n-1}` on next draw) only on a fresh
  `getSmfretTimeTraces()` run — preserved across scrubbing between sites, so a zoomed-in time
  window stays put while comparing different sites. Y stays fixed to the full trace's own range
  regardless of X zoom, same as that existing precedent (not auto-rescaled to the visible window).
  Tick generation and the hover readout both already read live `[x0,x1]`/`frametime`, so a zoomed
  view's ticks land on round times for the CURRENT span, not the whole trace's.

  Linking a direct-acceptor-excitation (AA) composite's own sites to these donor-channel DD/DA
  pairs stays an explicitly open, unimplemented item — no action taken on it this round.

  **The SOI composite draws each site's 1-based index next to its ROI box** (v0.12.1-dev, requested
  — "same visual style as plotting tracks in the single particle tracking module"), via a new
  `numbered` parameter on the shared `drawSpotOverlays(ctx,v,spots,locs,DW,DH,numbered=false)`
  (MODULE: render) — the SAME function that also draws 3D calibration's own bead-composite overlay
  and the raw-panel live-detect overlay, at 3 call sites total. Reuses `drawTracksOverlay()`'s
  (MODULE: spt) EXACT label style: font size `Math.max(9,Math.min(14,5.5*(fitZ>0?v.zoom/fitZ:1)))`
  (scales with how far zoomed in past `fitZoom()`, clamped [9,14]px, dataset/mag-independent), white
  text on an `rgba(0,0,0,.6)` backing box sized via `ctx.measureText()`'s bounding-box metrics, offset
  from the crosshair centre (`+7,-7` here vs. tracks' own `+3,-3` — SOI's crosshair itself, unlike a
  track's start-point dot, has no filled marker to clear, so a slightly larger offset reads better
  against the crosshair's own arms). Only the SR-panel call site passes `numbered:true`, and only
  conditionally: `srLocs===smfretSOI` — an OBJECT-IDENTITY check, not a bare `smfretSOI!==null` one,
  because `smfretSOI` is a session-scoped global that is never cleared when 3D calibration's own bead
  composite is later shown for the same loaded stack (`locateBeadsForCalib()` sets its own, DIFFERENT
  `fitted` array into `srLocs`) — a bare non-null check would have kept numbering calibration's own
  beads too, stale, after an earlier smFRET run in the same session. Applied identically at both
  `drawView()`'s own SR-panel draw and the PNG-export code path (`isSR` branch) so a saved composite
  image matches what's on screen.

  **ALEX frame-role bookkeeping — first piece** (`alexEnabled`/`alexFirstFrame`, step one of
  `docs/REFACTOR_PLAN.md`'s own smFRET/ALEX sketch: *"which frames are donor-excitation vs.
  acceptor-excitation is new state nothing in webSMLM tracks today... needed before any
  DD/DA/AA/AD sorting can happen"*). **Alternating laser excitation?** (default unchecked) reveals
  **1st frame is** (Direct donor excitation/Direct acceptor excitation) — which physical laser the
  movie's own first frame corresponds to. 1st frame = 0-based index 0 = "even" parity; the other
  physical excitation is the opposite parity. Deliberately scoped to a fixed period-2 alternation
  only (no general period/pattern control, no explicit frame-index lists, no per-localization
  frame-role tagging, no DD/DA/AA/AD sorting) — just enough to unblock the ONE thing asked for.

  The only consumer is `showStackProjection()`'s existing **Data projection** view (shown in the
  reconstruction panel before any Localize/Calibration result exists) — checked, it averages only
  one parity via the new `averageFramesByParity(st,first,last,parity,cap,checkStack=true)`
  (MODULE: in/out, right after `averageFrames()`) instead of the whole stack, and the panel title
  gains a toggle button (`alexProjToggleBtn`, same `.logbtn`/default-hidden convention as
  `sSmlmColorBtn`/`srSegOverlayBtn`/`srTracksOverlayBtn`, labelled with whichever state clicking it
  switches TO — **Donor dir. exc.**/**Acceptor dir. exc.**) flipping module-level `alexProjChannel`
  between the two. **`averageFramesByParity()` is a genuinely separate function, not a
  parameterised `averageFrames()` call** — that function's own evenly-spaced `step` subsampling
  (for staying fast over a huge range) has no relationship to 2, so it would land on the wrong
  parity about as often as the right one; the new function instead steps by exactly 2 from the
  first in-range index of the requested parity. The raw (left) panel and every other analysis path
  (Localize, Localize SOI, Get time traces, sSMLM pairing, …) are completely untouched — this is a
  projection-preview control only.

  **A parity-restricted average must never be cached in `_projCache`** — that cache exists so
  `locateBeadsForCalib()` ("Fix bead x,y") can reuse the whole-stack overview instead of
  re-averaging when the calibration range matches it; a half-frame-count ALEX average landing
  there would silently corrupt a calibration bead fit run afterward. `showStackProjection()` sets
  `_projCache=null` whenever `alexEnabled` is on, leaving the real cache untouched for the
  non-ALEX path. **Re-showing the projection after a checkbox/selector/toggle change hits
  `showStackProjection()`'s own re-entry guard** (`if(stack!==st || srFull || ...) return;` — meant
  to stop it clobbering a real result that claimed the panel while it was awaiting frame data) —
  but that guard can't tell "someone else's content" from "my own prior projection, about to be
  redrawn with the other parity," since `srFull` is the very state the FIRST call left behind. Each
  of the three listeners (`toggleAlexEnabled`/`refreshAlexProjectionIfShown` on `#alexFirstFrame`'s
  own `change`/`toggleAlexProjChannel`) funnels through `refreshAlexProjectionIfShown()`, which
  checks `$('srTitle').textContent==='Data projection'` first (only refresh if a projection is
  actually showing — avoids a wasted whole-stack average otherwise) and explicitly resets
  `srFull=null; srIsPlot=false; srSpots=null; srLocs=null;` before calling `showStackProjection()`
  again — a real bug caught via Playwright before this fix (toggling the checkbox showed the
  selector row but `srInfo`/the toggle button never updated at all, silently no-op every time).
  Verified end-to-end with the real ALEX sample
  (`experimental_data/Donor-1b …ALEX60fr…tif`, 60 frames): donor/acceptor toggle reports 30/60
  frames each way, and a pixel-checksum of the SR canvas confirms flipping **1st frame is** while
  the toggle stays on **acceptor** correctly swaps which physical 30 frames get averaged (matches
  the checksum of the ORIGINAL donor view, not the acceptor one) — the parity math, not just the
  on-screen label, was checked.

  **A round of label renames, reordering, and real fixes (v0.12.1-dev, requested).** Four
  cosmetic-only renames, no id/param-name changes: **1st frame is** → **First frame**;
  **Fix SOI x,y for time traces** → **Fix sites of interest (SOI)**, default now CHECKED (`true` —
  only visible before the first stack load or after a Load Settings round-trip that omits it, since
  `initScrub()` still force-unchecks it on every fresh stack load, unchanged — this checkbox
  remains a status flag, not a sticky preference); **Floor intensities to 0** → **Set negative
  intensities to zero** (`apertureIntensity()`'s own behaviour is unchanged, only the label). **Average
  frames** → **Average # of frames**, moved to the FIRST row of `smfretBox` (previously last of the
  detection-adjacent settings) — a genuinely more prominent position for the one setting every
  Localize SOI run actually depends on.

  **SOI composite/Data projection ALEX toggle, unified** (real gap fixed, reported: "we already have
  the toggle when loading data?! ... the toggle is only present when alternating laser excitation is
  ticked, which would mean that if data is loaded yet the box is not ticked, the composite should be
  recalculated"). Previously `smfretSOICore()`'s own average was NEVER parity-aware — Localize SOI
  always mixed both excitation channels into one composite regardless of ALEX, and `locateSmfretSOI()`
  unconditionally HID `alexProjToggleBtn` — the exact toggle **Data projection** already uses for its
  own donor/acceptor split. Fixed by making the two composites share ONE toggle/state
  (`alexProjChannel`) rather than each having its own, since they're mutually-exclusive views of the
  same underlying parity-restricted averaging operation, just at different points in a session
  (before vs. after Localize SOI). `smfretSOICore()` gained two optional config fields —
  `alexEnabled`/`alexFirstFrame` (already PARAMS ids) plus `smfretSoiChannel` (`'donor'|'acceptor'`,
  NOT a PARAMS field — mirrors the interactive-only `alexProjChannel` directly, so a headless caller
  wanting a filtered composite passes it explicitly; omitting it keeps the original whole-range
  average regardless of `alexEnabled`, so no existing headless caller's behaviour silently changes) —
  when both are set, it calls `averageFramesByParity()` instead of the plain `averageFrames()`, same
  parity math `showStackProjection()` already uses. `refreshAlexProjectionIfShown()` was generalized
  from a single `if($('srTitle').textContent!=='Data projection') return;` check into a dispatcher on
  that same title text, re-running `locateSmfretSOI()` when it reads `'SOI composite'` (guarded on
  `smfretSOI!==null`) — this is what makes checking **Alternating laser excitation?** AFTER an SOI
  composite already exists correctly recompute it (the literal scenario reported), not just Data
  projection. The composite's own toggle button is labelled with smFRET's own trace vocabulary
  (**DD+DA**/**AA**, the target channel clicking it switches to) rather than Data projection's
  **Donor dir. exc.**/**Acceptor dir. exc.** wording, since DD+DA/AA is what these sites actually
  become once Get time traces runs; `srInfo` gains a matching `"— composite of 30/60 donor-excitation
  (DD+DA) frames · N site(s) of interest"`-style readout. **Two pre-existing, unrelated bugs caught
  and fixed along the way**: `locateSmfretSOI()`'s own pairing-state-reset block, and
  `clearSmfretFixSOI()`'s own tail block, BOTH unconditionally hid `alexProjToggleBtn` regardless of
  whether Data projection (reachable from either path) had just correctly shown it moments earlier —
  a real, previously-latent bug (Data projection's own toggle silently disappearing after an SOI
  pairing was reset, or after unchecking **Fix SOI x,y**, whenever ALEX was on) that this same
  unification work made newly obvious. Verified via Playwright against the real ALEX dataset: SOI
  composite correctly reports **286** donor-excitation vs. **283** acceptor-excitation sites (genuinely
  different averages, not a cached/stale redraw), toggling flips both the label and `srInfo` text, and
  unchecking then re-checking **Alternating laser excitation?** while the composite is showing
  correctly reverts to the mixed 60-frame average and then back to the parity-filtered one.

  **SR-panel Contrast slider** (v0.12.1-dev, requested — "add the contrast slider on the same
  horizontal level" as the raw panel's own, whenever SOI composite/Data projection is shown). Both
  composites are plain averaged-frame grayscale images built exactly the way a raw frame is, so the
  same fixed-range `[black,white]` stretch applies: `srBlack`/`srWhite`/`srContrastMax` mirror
  `rawBlack`/`rawWhite`/`rawContrastMax` exactly, and `renderSrCompositeCanvas(proj,w,h,resetRange)`
  (next to `redrawRawContrast()`, MODULE: render) reuses the SAME `rawContrastLUT()` — a plain
  0..65535 grayscale lookup agnostic to which panel's data it's stretching — clamped/truncated the
  identical way `drawRaw()`'s own hot loop already does. `srCompositeProj` holds the RAW
  (un-normalized) averaged pixel data behind whichever composite is showing, so a slider drag
  (`redrawSrContrast()`) redraws without re-averaging the stack; `resetRange=true` (passed by both
  composite-build call sites, and by **Auto**) re-estimates `[srBlack,srWhite]` from that data's own
  actual min/max — the exact range the original always-auto-stretch code produced, so this is
  pixel-for-pixel backward compatible until a user actually touches a slider. `#srContrastRow` sits
  in the SR panel's own `.panel-body`, shown/hidden via `setSrContrastRowVisible()` at the exact same
  ~9 call sites `alexProjToggleBtn` itself is shown/hidden at (a plain grep-and-replace over the
  existing "reclaim the panel" reset blocks) — EXCEPT `showStackProjection()`'s/`locateSmfretSOI()`'s
  own non-ALEX branches, which must show the contrast row too (a composite is still genuinely up,
  just without the donor/acceptor toggle) — a real bug from the initial blanket find-and-replace,
  caught and fixed before shipping by re-reading both call sites individually rather than trusting
  the bulk edit alone. **`#srContrastSpacer`** (an invisible, `visibility:hidden` — not `display:none`
  — clone of `#scrubRow`'s own row structure, shown/hidden in lockstep with `#srContrastRow`) is what
  actually delivers "same horizontal level": the raw panel typically has its ordinary Frame scrubber
  ABOVE its own Contrast row whenever a composite is being viewed (before any Localize run), so the
  SR panel needs an equivalently-tall placeholder row of its own or its Contrast row would sit one
  row higher, at the raw panel's scrubber height instead of its Contrast row's — using the identical
  DOM structure/CSS classes (not a guessed pixel height) guarantees the same rendered height by
  construction. Verified via Playwright: `#srContrastRow` reads `flex` display and real, data-derived
  `srBlack`/`srWhite` values (e.g. `86`/`1301` on the real ALEX dataset, not the `0`/`255` placeholder
  defaults) the moment either composite shows, and dragging **White** produces a genuinely different
  canvas pixel checksum without re-fetching any frames.

  **Get time traces channel selector + a real AA-position bug fix** (v0.12.1-dev). New **Channels to
  show** (`smfretTraceChannels`, `'DD+DA'`/`'DD+DA+AA'`, default `'DD+DA'`) row, shown only when
  **Alternating laser excitation?** is checked (same visibility gate as **First frame**) — reported:
  the plot previously auto-included AA the instant ALEX was on, with no way to see just DD+DA even
  when that's all that was wanted ("I thought I mentioned to plot DD and DA before we figure out the
  linking with AA"). `getSmfretTimeTraces()`'s own `showAA = alex && paramValue('smfretTraceChannels')
  ==='DD+DA+AA'` now gates BOTH whether `photonsAA` is even allocated and whether it's populated
  during the per-frame loop — `drawSmfretTrace()` needed no changes at all, since it already treats
  `site.photonsAA` truthiness as "does this curve exist." Auto-reruns Get time traces on change, same
  convention `smfretApertureMode`/`smfretFloorZero` already use.

  Separately, a genuine correctness bug in AA's own EXTRACTION POSITION, found while working through
  the sSMLM/smFRET "how does AA relate to a spatial donor/acceptor pairing" tangle: AA
  (direct-acceptor-EXCITATION) was always sampled at the DONOR's own position `(x,y)`, even once a
  real, spatially-DIFFERENT acceptor position `(x2,y2)` was known from Spectral SMLM analysis pairing
  — only correct for an unsplit single-channel system. In this app's own real spectrally-split
  (prism/dichroic) datasets, during a direct-acceptor-excitation frame the acceptor's own emission
  physically belongs at the ACCEPTOR channel's position, exactly like DA already reads there. Fixed:
  `getSmfretTimeTraces()`'s per-frame loop now reads AA at `(x2,y2)` whenever `paired`, falling back
  to `(x,y)` only when there's no known separate acceptor position at all — same fallback shape DA's
  own `paired` check already has. Verified via Playwright on the real ALEX dataset: for a paired
  site's own first acceptor-excitation frame with a finite AA sample, the value `getSmfretTimeTraces()`
  actually stored (`1059.485...`) matches `smfretExtractIntensity()` called directly at `(x2,y2)`
  exactly, and clearly does NOT match the same call at `(x,y)` (`0` — a real, unambiguous difference,
  not a rounding coincidence).

  The **"Donor vs acceptor" button** — exposing `pairCore()`'s own existing directional
  0th/1st-order role classification under smFRET's donor/acceptor terminology, instead of smFRET
  silently assuming 0th=donor/1st=acceptor is always right — and linking a direct-acceptor-excitation
  (AA) composite's own sites to these donor-channel DD/DA pairs both stay explicitly open, deliberately
  deferred follow-ups, not attempted this round.

  **Three more usability fixes, same round.** (1) `initScrub()` no longer force-unchecks
  **Fix sites of interest (SOI)** on a fresh movie load (requested: "Do not force uncheck ... There
  is no reason, as only 'Localize SOI' will have consequences") — `smfretSOI` itself is still reset
  to `null` (those positions genuinely belong to the OLD stack's own pixels), but the checkbox's own
  state is left alone; `clearSmfretFixSOI()` (its own uncheck handler) still runs the real teardown
  whenever a user (or a subsequent Localize SOI mismatch) actually unchecks it. (2) Toggling the
  SOI-composite channel view (`alexProjToggleBtn`, **DD+DA**/**AA**) used to silently discard an
  already-committed pairing — a real, reported UX trap: `toggleAlexProjChannel()` →
  `refreshAlexProjectionIfShown()` → `locateSmfretSOI()` had no way to tell "just peeking at the
  other channel's composite" from "the user explicitly wants a fresh SOI pass with real
  consequences," and the latter's own reset block always nulled the pairing/marking state, which
  also disabled **Link channels** and made the dark-orange paired boxes vanish. Fixed with a new
  `preservePairing` boolean threaded `toggleAlexProjChannel()` → `refreshAlexProjectionIfShown()` →
  `locateSmfretSOI()` (`true` only from the channel-toggle call site; every other caller, including
  the explicit **Localize SOI** button and `refreshAlexProjectionIfShown()`'s own no-arg
  `toggleAlexEnabled()` path, stays `false`) — when set AND `smfretHasDDDAPairing()` is true,
  `locateSmfretSOI()` bails out right after refreshing `smfretSOI`/`srFull`/`srSpots`/`srLocs`/
  `srInfo`/the toggle button's own label, but BEFORE overwriting `lastResult` or resetting any
  pairing state. This relies on detection being deterministic: re-averaging/detecting/fitting the
  SAME channel on the SAME frames with the SAME settings reproduces numerically identical
  x,y/`_maxCx`/`_maxCy` values every time, so the OLD (never-nulled) `smfretPairedSoiKeys` Sets
  still match the FRESH `smfretSOI` array by VALUE — toggling back to the donor channel correctly
  re-shows the same dark-orange marks with no extra bookkeeping needed. Verified via Playwright on
  the real ALEX dataset through a full round trip (donor → AA → back to donor): `nPairs` (79) and
  `smfretPairedSoiKeys.locKeys.size` (79) stayed identical throughout, **Link channels** stayed
  enabled the whole time, the dark-orange pixel count reappeared on toggling back (540 px), and a
  subsequent **Link channels** re-run against the restored state still completed correctly (71
  pairs). (3) **Position donor?** (`smfretDonorAngle`) is now `disabled` by default in the HTML and
  only enabled once a real angle fit has actually run — requested: "Position donor should grayed
  out and deactive until 'Pair DD + DA' was checked providing guesses for the angles," since its two
  options are meaningless placeholders (the `PARAMS` default bearing and its +180°) before any real
  data has been fit. `refreshSmfretDonorAngleOptions()` gained an `enable=true` parameter
  controlling `sel.disabled=!enable`; the one page-load seed call (populating the dropdown before
  any stack is even loaded, so it's never left empty) passes `refreshSmfretDonorAngleOptions(false)`
  explicitly, while every real call from `previewSSmlmPairsCore()`'s own auto-fit and
  `fitSSmlmDistAndAngle()` keeps the default `true`. Verified via Playwright: the select reads
  `disabled===true` immediately after page load and after loading a movie with no fit yet, and
  `disabled===false` immediately after **Preview pairs**/**Pair DD + DA** completes its own
  auto-fit.

  **AA no longer strictly needs the "+AA" filter once paired, and Link channels no longer reads
  that filter at all** (two requests, same round: "'Filter SOIs' set to DD + DA should take DA
  position to set center positions of ROIs in the AA channel to fit for ... AA is not a strict
  requirement anymore" and "make sure that also the 'Link channels' will be handle the new
  situation" — see below for the second). `getSmfretTimeTraces()`'s own `showAA` gate changed from
  `alex && smfretTraceChannels==='DD+DA+AA'` to `alex && (paired || smfretTraceChannels
  ==='DD+DA+AA')` — once a real DD+DA pairing exists, the acceptor's own position (`x2,y2`) is
  already known from that pairing, so AA is sampled there regardless of the Filter SOIs dropdown;
  `drawSmfretTrace()` draws the AA curve purely off `photonsAA`'s own presence (unchanged), so it
  now shows automatically too once paired, no separate opt-in needed. Filter SOIs' only remaining
  role is the weaker UNPAIRED fallback (no known acceptor position yet, so AA can only be guessed
  at the SOI's own `(x,y)` — kept opt-in via the explicit `DD+DA+AA` choice rather than sampled by
  default). `linkSmfretChannels()` ALSO dropped its own `if(smfretTraceChannels!=='DD+DA+AA')
  return` gate entirely — it never actually depended on that setting in the first place: it always
  runs its own fresh, independent acceptor-channel detect+fit pass (`smfretSOICore(...,
  {smfretSoiChannel:'acceptor'})`), completely decoupled from whatever `getSmfretTimeTraces()`
  itself computed for `photonsAA` — gating it on that dropdown never reflected a real dependency.
  Verified via Playwright on the real ALEX dataset with Filter SOIs left at its default `DD+DA`
  (never switched to `+AA`): Get time traces on a paired result reports `hasPhotonsAA:true`, and
  **Link channels** (previously refused outright at this setting) now runs and correctly narrows 79
  pairs down to 71.

  **`smfretChannelsLinked` — re-applying Link channels automatically after a live re-pair**
  (requested, same round: "If the position of the donor is changed, make sure that also the 'Link
  channels' will be handle the new situation, this is currently not the case and the linkage seems
  to be lost"). Root cause: `refreshSmfretPairingLive()` (fires on a Distance/Angle field's own
  `change` event, including the one **Position donor?** dispatches onto `sSmlmAngleCenter`) calls
  `pairSSmlm(cfg)`, which WHOLESALE OVERWRITES `lastResult.locs` with the fresh, full, unfiltered
  pair set for the new window — silently discarding whatever narrower subset **Link channels** had
  previously written there, with no way to tell "just moved the window" from "start over" was ever
  distinguished. Fixed with a new module-level `smfretChannelsLinked` flag (declared next to
  `smfretPairedSoiKeys`): set `true` at the end of a successful `linkSmfretChannels()` run; reset
  `false` wherever a genuinely NEW (as opposed to a live-refreshed EXISTING) pairing starts —
  `getSmfretPairingFromDonor()`'s own try block, `unpairSSmlm()`, `locateSmfretSOI()`'s fresh-result
  reset path, and `clearSmfretFixSOI()`'s tail block. `refreshSmfretPairingLive()` captures the flag
  BEFORE calling `pairSSmlm()` (which is what clobbers `lastResult.locs`), and — if it was `true`
  and the fresh re-pair produced any pairs — calls `linkSmfretChannels()` again right after marking,
  which re-runs its own independent acceptor-channel check against the NEW pairing and re-sets the
  flag itself (idempotent, no double-bookkeeping needed here). Verified via Playwright on the real
  ALEX dataset: Pair DD + DA (79 pairs) → Link channels (kept 71) → switch **Position donor?** to
  the other candidate bearing (a genuinely different Primary angle, 91° vs. −89°) → the re-pair at
  the new bearing (78 raw pairs) is automatically re-linked (`smfretChannelsLinked` stays `true`,
  `lastResult.locs.length` and `smfretPairedSoiKeys.locKeys.size` both land on 78, matching exactly
  — meaning every pair at the new bearing happened to pass the AA-proximity check this time — and
  363 dark-orange pixels are visible on the reconstruction canvas), rather than silently reverting
  to the full, unlinked 78-pair set.

  **ROI thumbnails moved INTO the Time trace plot itself, with a magenta fit crosshair** (requested,
  mid-round, with a screenshot of the previous below-the-canvas version: "I like it but put into the
  Timetrace panel if possible and indicate the fitted localisation with a magenta cross hair"). The
  separate `#smfretRoiThumbsRow` DOM row (three small named `<canvas>` elements below the plot,
  shown/hidden via `style.display`) is gone entirely — `drawSmfretRoiThumbnails(idx, geom)` now
  draws the same contrast-stretched crops as small insets directly onto the REAL `$('raw')` canvas,
  top-right corner, inside the plotted axes, on a semi-opaque `rgba(0,0,0,.55)` backing panel so
  they stay legible over whatever curve data happens to sit underneath — same left-to-right order as
  the curve legend above them (DD, AA, DA). Each crop is scaled up via `ctx.drawImage(...,
  win,win,...,INSET,INSET)` with `imageSmoothingEnabled=false` (nearest-neighbour, matching the old
  version's `image-rendering:pixelated` CSS), and now also gets a magenta (`#ff2fd0`) crosshair — the
  same small-gap-in-the-middle style `drawSpotOverlays()` already uses for a fitted loc elsewhere —
  marking the EXACT fitted sub-pixel position within the crop, not just "the crop is centred near
  it": `buildCrop()` returns `{cv, lx, ly}` where `lx=(cx-x0)+0.5, ly=(cy-y0)+0.5` — the same
  `TX(x+0.5)` pixel-CENTRE convention `drawSpotOverlays()` uses (a fit position of exactly integer
  `x` sits at that pixel's centre, while canvas image space is corner-based, source pixel index `d`
  spanning `[d,d+1)`).

  **Deliberately never drawn through `_plotTarget`** (the `SvgRecordingContext` redirection
  `exportPlotEither()` uses for the 7 genuinely vector-shaped plots) — `drawSmfretRoiThumbnails()`
  always targets the literal `document.getElementById('raw')` context directly, since it's an async,
  fire-and-forget function that runs well after `drawSmfretTrace()`'s own synchronous render returns
  (there's no way for it to participate in a synchronous SVG-serialization pass anyway), and a raster
  crop has no meaningful vector form regardless — same reasoning the raw frame/reconstruction are
  already excluded from SVG export for. Explicitly re-applies `ctx.setTransform(dpr,...)` +
  `ctx.translate(ox,oy)` itself from a `geom` object `drawSmfretTrace()` passes it (`{mL,mT,pw,ph,
  ox:_plotLetterboxOx,oy:_plotLetterboxOy}`, snapshotted at the exact moment it's valid) rather than
  trusting whatever transform the shared canvas context happens to still have by the time its own
  async fetches resolve — `drawPlotHover()`'s own hover-crosshair redraw resets that transform to a
  plain dpr scale with NO translate in between, so relying on it surviving would silently misposition
  the insets the next time a hover event fired first.

  **Two new staleness guards, on top of the pre-existing `_smfretRoiGen` one** (needed BECAUSE this
  now draws onto the real, shared plot canvas instead of separate always-there-but-hidden DOM
  elements): a final check right before the actual draw — `if(!rawIsPlot || rawPlotName
  !=='smfretTrace' || smfretTraceIdx!==idx) return;` — bails if the raw panel has moved on to
  something else entirely (a mode switch to **Show raw frame**, a different plot, or the feature
  torn down) while the frame fetches above were in flight; drawing stale insets over whatever's
  showing NOW would be a real, visible glitch the old hidden-row placement never risked. Second: the
  hover-readout's own clean-plot snapshot (`_plotHover.raw.snap`, captured by `registerPlotHover()`
  synchronously inside `drawSmfretTrace()`, BEFORE this async draw even starts) is explicitly
  re-captured (`snap.getContext('2d').drawImage(cv,0,0)`) once the insets are actually drawn — without
  this, the very next `mousemove` over the plot would call `drawPlotHover()`, which restores that
  now-stale, inset-free snapshot underneath its own crosshair, making the insets flicker away.
  Verified via Playwright: the old DOM row/canvases are confirmed gone (`!document.getElementById
  ('smfretRoiThumbsRow')`), the raw canvas shows real dark-backing-panel pixels plus genuine
  `#ff2fd0`-matching magenta crosshair pixels once a Get time traces run completes, scrubbing to a
  different site updates correctly, and toggling to **Show raw frame** mid-flight (`rawIsPlot`
  becomes `false`) causes no crash and no stray inset drawn over the live frame.

  **Documentation staleness/consistency pass** (requested — "check documentation and code for
  staleness and consistency especially as we went back and forth with ssmlm and smFRET... maybe
  renaming some parts is in place"). Cross-checked every current sSMLM/smFRET button id and label in
  `webSMLM.html` against `docs/DOCUMENTATION.md`/`README.md`/`docs/REFACTOR_PLAN.md` — the actual
  live UI naming turned out already consistent (Filter SOIs, Pair DD + DA, Pair & plot sSMLM,
  Position donor?, Link channels — no lingering "Get from pairing"/"Channels to show"/"Linking
  SOIs"/"Fit dist. & angle" in current-facing text anywhere in the app itself), so no code-level
  renaming was warranted; the staleness was entirely in the PROSE, not the names. Fixed in
  `docs/DOCUMENTATION.md`: (1) §3's own sSMLM prose (below the already-current `.hint` marker) still
  described a removed **Fit dist. & angle** button as something to click — 2 spots, rewritten to
  describe **Preview pairs**' own automatic fit instead; 6 more spots said bare **Pair** instead of
  the actual **Pair & plot sSMLM** label. (2) §2's **Single-molecule FRET** section (848 onward) had
  fallen well behind the shipped feature set — no mention of **Pair DD + DA**, **Position donor?**,
  **Link channels**, the dark-orange pairing marks, or the ROI-thumbnail insets at all, one lingering
  "**Spectral SMLM analysis**" old-name reference, a stale **Filter SOIs** description that hadn't
  caught up with AA/pairing decoupling, and — worst — a "Still not implemented... linking a
  direct-acceptor-excitation (AA) composite's own sites to the DD/DA pairs" claim that was flatly
  wrong (**Link channels** does exactly this, and has for a while); rewrote the section end to end,
  and closed a genuine content gap where the sSMLM section promised an `x2`/`y2`/`pairAngle`
  write-up "below" that was never actually written. (3) §1's own sidebar-module list promised a
  "**Single-molecule FRET** below" cross-reference that flat-out didn't exist — the whole bullet was
  missing from the list; added it. `docs/REFACTOR_PLAN.md`'s smFRET/ALEX section was similarly
  behind — it read as a half-finished sketch ("nobody's yet run it against real dual-view/polychroic
  data," "Still open: letting the user pick which frames feed the average") describing things that
  are now shipped, verified features; trimmed to keep only what's genuinely still open (E_raw/S_raw,
  the "Donor vs acceptor" terminology control, general non-SOI ALEX frame-role tagging, headless
  export for Get time traces, image-splitter/two-camera infrastructure), per this file's own "shipped
  history lives in CHANGELOG.md, not here" convention — REFACTOR_PLAN.md had drifted into narrating
  history it wasn't meant to hold. `README.md`'s own "Guided workflow" step 5 still named the module
  "Spectral SMLM analysis" — the in-app Quick guide modal's own copy had already been updated to
  "Pairing (sSMLM & FRET)" at some earlier point without the required "update both together" (see
  this file's own **Reference material** section) actually happening; synced verbatim. Verified: RTD
  strict build passes, `tools/sync_hints.mjs --check` reports in sync (no `.hint` content touched,
  only surrounding prose), and every current sSMLM/smFRET button id/label cross-checked directly
  against the live HTML via a grep sweep rather than assumed from memory.

  **Four more usability fixes, same round.** (1) The ROI thumbnails' own `×10ⁿ` y-axis exponent was
  reported STILL too far from "10" even at `drawAxisScaleLabel()`'s existing `GAP=-2` — the third
  report on this exact spacing (2px → 0px → -2px, each time "still too far"). Rather than guess a
  fourth single value blind, built a side-by-side offscreen-canvas comparison this round (`GAP`
  ∈ {-2,-4,-5,-6,-8}, 6× zoomed screenshots) to actually SEE where the exponent starts genuinely
  colliding/merging into the "0" rather than just looking closer — `-6` and `-8` visibly cross
  strokes with the "0", `-5` tucks right against it without merging, matching a real superscript's
  own look. Shipped `GAP=-5`. (2) The ROI thumbnails (DD/DA/AA), inset into the plot's own top-right
  corner two rounds ago, are moved again — now to a dedicated strip BELOW the x-axis, still on the
  same canvas/panel (requested: "move the three ROIs from within the graph to below the graph (but
  still in the Time trace frame)"), and 40% larger (`SMFRET_ROI_INSET=59`, up from 42). New shared
  constants (`SMFRET_ROI_INSET/GAP/LABEL_H/PAD`, next to `SMFRET_ML/MR`) are read by BOTH
  `drawSmfretTrace()` (to size its own `mBRoi` bottom-margin reservation, shrinking the actual
  line-graph's plotted height to make room within the same fixed-size panel — "still in the frame,
  with enough space" means reallocating existing space, not growing the panel, which isn't under
  this function's control anyway) and `drawSmfretRoiThumbnails()` (to actually draw there), so the
  two can never disagree on how much room is set aside. The semi-opaque group backing panel from the
  inset design is REMOVED — it existed only to keep the thumbnails legible over real curve data
  underneath; the new position has nothing else drawn there, so a plain per-thumbnail border
  (`plotColors().grid`) is enough, and the label text switches from a fixed light-grey to
  `plotColors().text` — both now correctly theme-aware, unlike the fixed light-on-dark pair the old
  inset (deliberately, since it always sat on a fixed dark backing regardless of theme) used.
  Verified via Playwright in both dark and light theme: thumbnails render below the graph with no
  overlap, correct contrast in both themes, scrubbing between sites and zero page errors.
  (3) **Get time traces** can be run without ever clicking **Link channels** first, tracing the
  full, unverified pair set — reported as unintuitive, with the alternative floated of having Get
  time traces call Link channels internally. Decided AGAINST auto-wiring: Link channels is a
  genuinely separate, meaningful action — it runs its own fresh, independent acceptor-channel
  detect+fit pass (can be slow) and PERMANENTLY reduces `lastResult.locs` to the verified subset (a
  real, visible effect on the table/export too, not just future traces) — folding that silently into
  a button whose whole point is "just show me the trace" would hide a real computation cost and a
  real, hard-to-undo data reduction behind an unrelated action, and would remove the ability to
  trace the full unverified set at all even when that's what's wanted (e.g. comparing verified vs.
  unverified). Fixed the actual complaint (discoverability, not a missing behaviour) instead: both
  `smfretTimeTracesBtn`'s own tooltip and the `hint-smfret` popup now say outright that Get time
  traces works on whatever's currently loaded and does NOT run Link channels for you.
  (4) **`smfretDonorAngle`** ("Position donor?") stayed enabled/clickable even after its pairing was
  later undone (Unpair, a fresh Localize SOI, or unchecking Fix sites of interest (SOI)) — reported:
  "people might start clicking on it nonetheless ... wondering why nothing is happening." A plain
  `smfretHasDDDAPairing()`-tracks-enablement approach was tried first and rejected: **Preview pairs**
  alone (no commit yet) already runs the angle fit and is MEANT to enable this dropdown on purpose,
  so a user can choose the donor bearing BEFORE actually committing a pair — gating on "currently
  paired" would re-disable it in exactly that legitimate pre-commit window. Fixed instead by setting
  `sel.disabled=true` directly at the same three places that already reset `sSmlmOriginalLocs`/
  `smfretChannelsLinked` to `null`/`false` (`unpairSSmlm()`, `locateSmfretSOI()`'s fresh-SOI reset,
  `clearSmfretFixSOI()`'s tail block) — those are genuine "no active pairing SESSION at all, frozen
  options or otherwise" resets, not "not committed yet," so they don't reopen the pre-commit gap the
  simpler check would have. Verified via Playwright: `disabled===false` right after **Pair DD + DA**,
  `disabled===true` right after **Unpair**.

  **Four more fixes, same area, next round.** (1) **`select.sel` had NO `:disabled` CSS rule at
  all** — the previous round's `smfretDonorAngle.disabled=true` fix was setting the real DOM
  attribute correctly the whole time, but it was invisible: the element's own explicit
  `color:var(--fg)` defeats a browser's native disabled-dimming, and this codebase never gave
  `select.sel` its own `:disabled` style the way `button:disabled{opacity:.45;cursor:not-allowed}`
  already has. Reported via a screenshot showing "Position donor?" looking fully active BEFORE
  **Localize SOI** had even run. Fixed with one shared rule, `select.sel:disabled{opacity:.45;
  cursor:not-allowed}` — the same convention buttons already use — which also retroactively makes
  every EARLIER disable point (the page-load seed, Unpair, a fresh Localize SOI, unchecking Fix
  sites of interest) visually correct for free, not just this one.

  (2) **A real, reported "Link channels gives zero after flipping Position donor" turned out NOT to
  be a bug** — independently investigated end to end against the real bundled ALEX dataset before
  touching any code. Root-caused precisely: flipping `sSmlmAngleCenter` by exactly 180° leaves
  `sSmlmCandidates()`'s own candidate pool byte-identical (its filter folds into `[0,180)` modulo
  180, so ±87°/93° map to the same axis) and `pairCore()`'s role-classification cleanly SWAPS which
  point is 0th/1st for every candidate (verified directly: a hand-replica of the classify/qualify
  loop gave the identical `nQualifying` count, 84/84, for BOTH bearings — confirmed via a dedicated
  diagnostic script, not assumed). The actual collapse to exactly 0 happens one step later, inside
  **Link DD/DA/AA**'s own independent acceptor-channel check: flipping the bearing swaps `x2,y2` to
  what used to be the DONOR position, and Link DD/DA/AA correctly finds no real direct-acceptor-
  excitation signal there (there's no physical reason for any — that's the undispersed channel).
  A clean 0/N is therefore the CORRECT fingerprint of picking the physically wrong "Position
  donor?" option, not a malfunction — and a genuinely useful one, since there was previously no
  automatic way to tell which of the two bearings is correct at all. Verified precisely on the real
  dataset: default bearing kept 82/84; the flipped one kept 0/84; switching back restored 82/84
  exactly. Documented this explicitly (a new log line fires on a 0-kept result: `↳ 0 kept usually
  means "Position donor?" is set to the physically wrong bearing — try the other option above.`)
  rather than leaving a correct-but-alarming result unexplained. Renamed **Link channels** →
  first **"Link DD, DA and AA"** (as requested), then shortened to **`Link DD/DA/AA`** one round
  later after it wrapped to two lines at the sidebar's real 300px-fixed width (`.wrap{grid-
  template-columns:300px ...}`) — a real violation of this file's own "Button label length" rule,
  caught by screenshotting at the actual sidebar width rather than trusting a wider test viewport;
  `/`-joined with no spaces matches the established compact-label convention (**Save plot/image**,
  **View data/filtering**) instead of introducing a new one. Every reference — button label,
  tooltips, log messages, code comments, `docs/DOCUMENTATION.md` prose and its own `hint-smfret`
  marker (re-synced via `tools/sync_hints.mjs`, after a first pass accidentally hand-edited the
  `.hint` div directly via a broad `sed` and had to be reconciled back through the marker, the
  correct source of truth) — renamed together, except the two places that verbatim-quote an
  EARLIER user request containing the old name, deliberately left untouched.

  (3) **`smfretTraceChannels`'s two option labels gained spaces** — `DD+DA`/`DD+DA+AA` →
  `DD + DA`/`DD + DA + AA` (requested, to match **Pair DD + DA**'s own layout) — display text only;
  the underlying `option value`/`PARAMS.smfretTraceChannels` enum strings stay unspaced, since
  settings JSON and every code comparison (`smfretTraceChannels==='DD+DA+AA'`, etc.) already commit
  to that exact literal.

  (4) **`smfretTimeTracesBtn` now stays disabled until `linkSmfretChannels()` has actually
  succeeded, but only with ALEX on** (requested, "to be really safe") — previously **Get time
  traces** only ever checked `smfretSOI.length`, letting a user trace a pairing whose acceptor
  position was never independently confirmed (or built on the wrong "Position donor?" bearing
  entirely, see above — the one check that would have caught it was skippable). New shared
  `refreshSmfretTimeTracesBtn()` (next to `refreshSmfretLinkChannelsBtn()`, same pattern) —
  `disabled = !haveSites || (alex && !(smfretChannelsLinked && lastResult.locs.length>0))` — wired
  into every place `smfretChannelsLinked` changes (`unpairSSmlm()`, `locateSmfretSOI()`'s two exit
  paths, `getSmfretPairingFromDonor()`'s start, `linkSmfretChannels()`'s own `finally`) plus
  `toggleAlexEnabled()` itself (flipping ALEX changes whether the extra requirement even applies).
  **The `lastResult.locs.length>0` half is not redundant** — caught in testing, not assumed: after a
  successful link, flipping **Position donor?** re-applies **Link DD/DA/AA** live (see this
  module's own `refreshSmfretPairingLive()` paragraph above) and can legitimately drop the kept
  count to zero (the "wrong bearing" case just above) — `smfretChannelsLinked` alone would still
  read `true` then (linking DID run, it just kept nothing), so checking it in isolation left **Get
  time traces** wrongly enabled with literally nothing to trace; verified this exact sequence via
  Playwright before shipping the fix, not just the simpler on/off transitions. ALEX off is
  completely unaffected — same plain `smfretSOI.length` gate as before, verified via Playwright
  producing real traces immediately after **Localize SOI** with no linking step at all.

  **The dark-orange "part of a pair" marking was recolouring the wrong endpoint — DD, not DA**
  (reported directly: "for me orange box indicates acceptor, meaning DA, so this is what caused the
  confusion for me, best to change"). `markSmfretSoiPairedKeys(pairedLocs)` built its match set from
  `pairedLocs.map(L=>L.x+'|'+L.y)` — but `pairCore()`'s own convention is that a pair's `x,y` is
  ALWAYS the 0th-order/DONOR position (undispersed, the true emitter position — see **sSMLM**'s own
  module bullet), with the acceptor stored separately as `x2,y2`. So every `smfretSOI` entry
  matching that set was, by construction, a DONOR site — confirmed directly before touching any
  code: a diagnostic against the real ALEX dataset found the donor position matched 84/84 accepted
  pairs and the acceptor position matched 0/84, not a coincidence. Fixed by matching on `L.x2+'|'
  +L.y2` instead — the SAME `smfretSOI` filter-by-value-equality mechanism, just checking the
  pair's acceptor coordinate instead of its donor one. Re-verified on the same real dataset,
  inverted exactly as expected: acceptor position now matches 84/84 (82/82 after **Link
  DD/DA/AA** narrows it), donor position matches 0/84 either way. Scoped correctly with no
  cross-module risk: `markSmfretSoiPairedKeys()` is gated on `smfretSOI` existing at all, which
  only ever happens via **Localize SOI** — sSMLM's own plain (non-smFRET) diffraction-grating
  pairing never touches `smfretSOI` or this function, so the swap is invisible to that module.

  **Two more fixes/additions, same area.** (1) **`getSmfretTimeTraces()` gained a `preserveView`
  parameter** (default `false`, requested: "make sure that the same molecule that is currently
  shown in the Time Trace overview stays shown and not jumping back to molecule 1") — toggling
  **Aperture photometry (no fit)**, **Set negative intensities to zero**, or **Filter SOIs** while a
  trace is already showing now calls `getSmfretTimeTraces(true)`, which clamps the OLD
  `smfretTraceIdx`/`smfretTraceView` onto the freshly-recomputed traces instead of resetting to site
  1 with the full x-range — a genuine fresh click of **Get time traces** itself is unaffected,
  still opening on site 1 as before (a real, not just a settings-triggered, re-run may have
  genuinely different sites to show). **Caught a real, pre-existing latent bug while wiring this
  up**: `$('smfretTimeTracesBtn').addEventListener('click', getSmfretTimeTraces)` passed the
  function directly rather than wrapped — harmless while the function took no parameters at all,
  but the moment it gained `preserveView` as its first parameter, the DOM's own click EVENT object
  (always truthy) silently became every button click's own `preserveView` argument, meaning a
  literal, deliberate re-click of **Get time traces** stopped resetting to site 1 at all. Caught by
  testing the exact scenario the feature was built for (this button → a settings toggle → this
  button again) rather than just the toggle-alone case; fixed by wrapping the listener in an arrow
  function, `()=>getSmfretTimeTraces()`, so a real click always calls it with zero arguments
  regardless of the event object. Verified via Playwright: scrub to site 5, set a narrow x-zoom,
  toggle each of the three settings in turn (site/zoom preserved every time), then a genuine fresh
  **Get time traces** click (correctly resets to site 0, full range).

  (2) **New "Export traces" button** (`exportSmfretTracesBtn`/`exportSmfretTraces()`, requested) —
  saves `smfretTraces` as one JSON file, MOLECULE BY MOLECULE: one self-contained record per site,
  each carrying its own `x`/`y` (`x2`/`y2` too, once paired, present only when finite — same
  optional-field convention as `sigma1st`/`track_id` elsewhere), a `time_s` array, and
  `photonsDD`/`photonsDA`/`photonsAA` (whichever the site actually has). A deliberately simple v1 —
  one in-memory JSON blob, not the streaming-NDJSON precedent (`config.exportTrackData` etc.) a
  truly huge dataset would need — real smFRET site counts don't currently warrant that complexity.
  **A real gotcha caught before shipping**: `JSON.stringify()` on a raw `Float64Array` serializes it
  as a plain OBJECT (`{"0":1,"1":2,...}`), not a JSON array, since `Array.isArray()` is false for
  typed arrays — `Array.from(s.photonsDD)` first is what actually produces `[1,2,...]`. Converting
  first also turns every channel's own `NaN` gap into JSON's native `null` for free, via
  `JSON.stringify`'s own existing `NaN`→`null` convention — no extra handling needed. Compact JSON
  (no `null,2` indent argument), unlike `exportCalibration()`'s own pretty-printed file — a
  calibration file is small and meant to be read directly, while a trace export can be many sites ×
  many frames × up to 3 channels, where indentation whitespace alone would meaningfully bloat the
  file for a file nobody reads by eye anyway. Enabled/disabled alongside `smfretTraces` itself at
  every point that already sets or clears it (`getSmfretTimeTraces()`'s own success path;
  `locateSmfretSOI()`'s trace-invalidation branch, `clearSmfretFixSOI()`, and the two fresh-load/
  simulate reset blocks that already null it). Verified via Playwright (stubbing
  `window.showSaveFilePicker` to force the plain anchor-download fallback, since the native picker
  hangs forever waiting for a dialog that never appears in headless automation): a real 82-site,
  120-frame export round-trips through `JSON.parse()` with all expected top-level fields, each
  site's own `photonsDD` correctly containing real `null` gaps at the ALEX off-parity frames.

  **"Align channels"** (v0.12.1-dev) — a genuinely different, direct REGISTRATION approach to
  finding donor/acceptor geometry, replacing an earlier attempt (`sSmlmCrossCandidates()`,
  "Calibrate via AA"/"Pair (fixed window)" — shipped, then reverted the same day, see git history)
  that was still fundamentally a histogram/background-model fit and, on direct feedback, "doesn't
  help much and makes everything more complicated." The real root cause the user identified:
  "Due to the width/height ratio of DD and DA channel, we expect to see more angles along the long
  axis, which here is actually a false lead" — a confound no amount of candidate-pool cleverness
  can fix, since it's a property of the FOV's own shape, not the candidate-generation method: in a
  rectangle much wider than tall, two random points are geometrically more likely to be oriented
  along the LONG axis purely from combinatorics, and here that long axis coincides with the TRUE
  physical donor→acceptor bearing (~0°/180°, a horizontal dual-view split) — making a histogram
  peak there fundamentally indistinguishable from pure background shape, not just hard to detect.
  Any Distance/Angle-histogram-based approach (`fitSSmlmDistAndAngle()`, `sSmlmFitOrder`, the
  reverted cross-candidate attempt) inherits this problem regardless of what feeds the histogram.

  **The fix is to stop histogramming pairs at all** and directly register two independently-
  detected point sets instead — proposed directly: "we need to split the entire frame in DD and DA
  region and calculate a transform between the channels for mapping... which distance and angle
  optimises the number of pairs found, with initial guess of deg=180 (to the left) and distance/
  displacement being half a frame." `smfretFovSplitX(locs, w)` finds the x-position GAP between the
  two regions from the sites of interest's OWN detected positions, not an assumed frame-half-width
  — "you can histogram the intensities along the x-axis, that should give you an indication of
  field of views and separation." **A raw PIXEL intensity profile was tried first and found NOT
  informative** on the real dataset (`alex50mW_1_MMStack_Default.ome.tif`): uniform background/
  illumination across the whole 512 px width swamped the real per-molecule signal in a plain
  column sum (values stayed within ~180–205k across the entire width, no discernible bimodal
  structure). A histogram of the SITES OF INTEREST'S OWN x-positions instead — zero contribution
  from background pixels, only confidently-detected real molecules — showed a clean, unambiguous
  gap (bins at x≈240–272 empty/near-empty) exactly where the two regions meet. `smfretFovSplitX()`
  searches for the emptiest histogram bin within the middle third of the width only (avoids
  mistaking a genuinely sparse region near either edge for the real gap).

  **Truth pool, confirmed directly**: "truth (DA + AA) for ALEX seems good. in non ALEX, it would
  simply be DA" — with `alexEnabled`, truth = DA-region candidates (from the same donor-excitation
  composite) plus a fresh, independent AA localization (the same on-demand
  `smfretSOICore(cfg, stack, {smfretSoiChannel:'acceptor'})` call `linkSmfretChannels()` already
  makes); without ALEX there's no separate direct-acceptor-excitation channel to localize AA from
  at all, so truth is DA alone. `alignSmfretChannels()` branches on `paramValue('alexEnabled')` for
  exactly this — confirmed via Playwright that the non-ALEX path never calls `smfretSOICore()` at
  all (monkeypatched to detect a call; correctly never invoked) and still produces a real pairing
  from DA-only truth.

  **The registration search** (`smfretSearchDisplacement()`) is a coarse-then-fine grid search over
  candidate `(dx,dy)` displacement vectors centred on the initial guess (`(w/2, 0)` — half the
  frame width, dy=0; the request's own "deg=180 (to the left)" describes the reverse direction,
  truth→DD, same magnitude opposite sign as the DD→truth convention used here) — same two-stage
  coarse/fine philosophy `bestShift()` (MODULE: drift) already uses for an analogous shift-
  registration problem. Each candidate's SCORE is exactly the quantity requested: how many DD
  points land within a match tolerance of a real truth point once shifted by it — "which distance
  and angle optimises the number of pairs found." **A spatial hash (`smfretBuildSpatialHash()`/
  `smfretNearestInHash()`, cellSize=tolPx) is required, not just faster** — a naive O(nDD×nTruth)
  inner check per grid point (measured: ~130M+ operations for a realistic grid×point-count
  combination) was the dominant cost before this; binning truth points into tolPx-sized cells and
  only scanning the query's own 3×3 cell neighbourhood cuts this to effectively O(nDD) per grid
  point. **`smfretAlignTolPx`** ("Align channels match tol. (px)", default 10, PARAMS) is the match
  tolerance — deliberately more generous than `linkSmfretChannels()`'s own 2 px `LINK_RADIUS_PX`
  (a "confirm an ALREADY-KNOWN position" check, not a search), per explicit confirmation: "with
  field dependent distortions being possible, some slack should be allowed" — a single rigid
  `(dx,dy)` transform is only an approximation once real optical aberrations vary the true local
  offset slightly across the field of view.

  **The winning transform's own match set IS the pairing** — no separate Distance/Angle-window
  `pairCore()` step needed afterward, unlike every other pairing path in this app (`pairSSmlm()`,
  `getSmfretPairingFromDonor()`): for each DD point, its nearest truth point within `tolPx` (if any)
  directly becomes its `x2,y2`/`dist`, written straight into `lastResult.locs`/`sSmlmOriginalLocs`/
  `sSmlmPairedLocs` (`sSmlmPairContext='smfret'`, same as every other smFRET pairing path, so the
  `syncSSmlmZRangeFromDist()` context fix above still applies correctly). `unpairSSmlm()` needed no
  changes — it only ever reads `sSmlmOriginalLocs`/`sSmlmPairedLocs`, both set the same way any
  other pairing path sets them.

  Verified via Playwright, both synthetically and against the real file: a synthetic 512×256 px
  dual-view-style dataset (150 real complexes, true displacement exactly 256 px/dy=0, only 15%
  showing weak DA signal but 90% showing strong AA) recovered `splitX≈266.7` (the true gap's own
  midpoint) and paired 178/191 DD sites in ~320 ms. Against the real ALEX file: `splitX=256.0 px`
  (exactly half the 512 px frame), best displacement `dx=282.75 px, dy=0.00 px` (a clean, purely
  horizontal result — no spurious vertical component), 142/178 DD sites matched in ~460 ms, and the
  full paired set's own distance distribution is TIGHT — mean 45,072 nm, std 857 nm (<2% CV) —
  drastically more consistent than the old histogram-based approach's own noisy ~22,589±10,142 nm
  result on the same file, strong evidence these are genuine, consistent donor/acceptor pairs
  rather than scattered spurious matches.

  **Three follow-up fixes, same day.** (1) `alignSmfretChannels()`'s own logged command was a bare
  `{smfretAlignChannels:true}` marker with no real config attached, unlike every other actionable
  smFRET function (`locateSmfretSOI()`, `linkSmfretChannels()`, `getSmfretTimeTraces()`), which use
  `overrideWithFields()` so the ACTUAL settings used are visible/recallable directly from the log
  line — reported: "'Aperture photometry (no fit)' => cli and all others!". Fixed by building a
  real `cmdCfg` (the same detection/averaging fields `locateSmfretSOI()` itself logs, only the
  ACTIVE detection filter's own threshold, plus `smfretAlignTolPx` and, when ALEX is on,
  `alexEnabled`/`alexFirstFrame`) and passing it through `overrideWithFields()` — verified the
  logged line now reads as a complete, directly-runnable `$('id').value=...;` sequence ending in
  `alignSmfretChannels()`, not a bare call with no visible config. (2) **`locateSmfretSOI()`'s own
  success log line now breaks the total down by channel when ALEX is on** — reported: "In Alex,
  mention how many on DD+DA and AA channel respectively." The donor-excitation (DD+DA) composite
  reuses `smfretFovSplitX()` (already built for Align channels, no extra detection needed — the
  composite is already fully fitted) to report DD-region vs. DA-region counts; the direct-
  acceptor-excitation composite reports its own single AA count instead (no split needed, only one
  real population there). Verified via Playwright against the real ALEX dataset: `"found 482
  site(s) of interest (donor-excitation/DD+DA view: 177 DD-region + 305 DA-region site(s), split at
  x=256 px)"`. (3) **Explained, not a bug**: "After 'Align channels' many molecules do not seem to
  be paired in the DA channel?" — the SAME real run's own numbers make this mathematically
  necessary, not a matching failure: the DA region has 305 detected sites against only 177 in the
  DD region, so AT MOST 177 DA sites could EVER be marked paired regardless of match quality — the
  DD population itself is the hard ceiling. With 141/177 (80%) of DD sites actually finding a
  match, 305−141=164 DA-region sites stay unpaired, the large majority (305−177=128) simply because
  there is no possible DD partner for them at all — most likely genuine free (unconjugated)
  acceptor label or higher background on that side of the sensor, both common, expected effects in
  a real smFRET sample with imperfect donor/acceptor labelling stoichiometry, not an alignment
  defect.

  **`drawSmfretTraceSelectionOverlay()`** (v0.12.1-dev, requested — "add blue highlighting circles
  in the SOI composite window of which ROIs are currently selected with a line connecting the two
  circles") highlights the currently-scrubbed Time trace site directly on the SOI composite: a blue
  (`#3fa9ff`) circle at the site's own DD position, and — once paired — a second one at its DA/AA
  position (`x2,y2`), joined by a line. Radius is `winr+3` NATIVE px, scaled by the current zoom
  exactly like `drawSpotOverlays()`'s own ROI-box radius, so it sits proportionally just outside the
  real ROI box at any zoom level rather than drifting relative to it. Reads `smfretTraceIdx`/
  `smfretTraces` fresh on every call (no state threading needed) — `drawSmfretTrace(idx)`'s own tail
  just calls `clampView(); drawView();` when `srLocs===smfretSOI`, mirroring the exact "just refresh
  the marking" pattern `markSmfretSoiPairedKeys()` already uses. Wired into BOTH of `drawSpotOverlays()`'s
  own SOI-composite call sites (`drawView()`'s interactive path AND the PNG-export `isSR` branch), so
  a saved "Save plot/image" composite also shows it when relevant. Never reachable through
  `_plotTarget`/`SvgRecordingContext` (the SOI composite is raster-only, same as the raw frame/
  reconstruction) — its own `ctx.arc()`+`ctx.stroke()` pairing would hit that recorder's own known
  gap otherwise (see **render**'s own paragraph on this). Verified via Playwright against the real
  ALEX dataset: scrubbing to a specific site (site 4/141) produces real `#3fa9ff`-matching pixels on
  the SR canvas at exactly that site's own DD/DA composite positions.

  **A same-round investigation, reported as a possible wiring bug, found no bug**: "I do not see any
  anticorrelation expected that when acceptor bleaches (DA and AA) down that DD goes up... indicates
  somewhat that the linking is not done [correctly]." Investigated directly against the real ALEX
  dataset (post `alignSmfretChannels()` pairing) rather than assumed: (1) the DD/DA/AA extraction
  code itself is correct — `x,y`/`x2,y2` are real, sensible, finite positions in their own expected
  regions, matching the already-documented, unchanged extraction logic. (2) Match QUALITY doesn't
  explain it — splitting paired sites into "tight" vs "loose" match-distance halves gave
  indistinguishable anticorrelation rates (24.3% vs 26.8%), arguing against `alignSmfretChannels()`
  producing systematically-wrong (spurious) pairs as the root cause. (3) A population-level check
  (first-half vs. second-half trace means) found BOTH DD and DA tend to decrease together over the
  movie (mean deltas −1128/−1674) — consistent with ordinary independent photobleaching of both
  fluorophores dominating any per-molecule FRET-driven anticorrelation at the population-average
  level. (4) A targeted, per-molecule bleach-STEP check (find each site's own largest clean DA drop,
  excluding exact-zero REJECTED-FIT artifacts — a real gotcha caught while building this check: a
  non-converged fit's own "0" — see **smFRET**'s existing convention above — was initially being
  mistaken for a real near-zero photon count, inflating "drop size" for spurious reasons) found DD
  goes up right after a DA drop only 49.3% of the time — statistically indistinguishable from chance.
  **Conclusion, not yet resolved further this round**: no coding defect found: this app currently
  reports RAW, uncorrected per-channel photon counts only — no spectral bleedthrough/crosstalk
  correction, no gamma/beta factor, no E_raw/S_raw computation (already-documented open items, see
  `docs/REFACTOR_PLAN.md`'s smFRET/ALEX section). If donor→acceptor bleedthrough dominates this
  sample's own DA signal over genuine FRET-sensitized emission, DD and DA would be expected to track
  each other (via shared donor brightness) rather than anticorrelate — a real, physically plausible
  explanation consistent with what was measured, though not conclusively distinguished from other
  possibilities (e.g. this specific "control, no ATP" condition genuinely having little dynamic FRET
  behaviour) without further, more targeted per-trace inspection than a population-level script can
  give.

  **"Pair DD + AA" + "Pairing method" selector** (v0.12.1-dev) — consolidates the two separate
  buttons "Pair DD + DA" and "Align channels" from earlier the SAME day into one button, after
  confirming the two approaches genuinely aren't redundant (they target different optical layouts,
  not a quality trade-off) but still concluding "then we should use a selector rather than two
  buttons" once that was established. New `PARAMS.smfretPairMethod` (enum `distAngle`/`channelMatch`,
  default `distAngle` — preserves the original, longest-established method as the default) drives a
  new **Pairing method** dropdown, labelled with the user's own preferred wording ("Via distances
  and angles" / "Via channel matching") rather than an optical-setup description, since naming the
  actual MECHANISM lets a user just try both and compare rather than first having to reason about
  which their own setup counts as. `pairSmfretSites()` is a thin dispatcher — `paramValue
  ('smfretPairMethod')==='channelMatch' ? alignSmfretChannels() : getSmfretPairingFromDonor()` — both
  underlying functions are completely UNCHANGED, only how they're reached from the UI changed;
  `alignSmfretChannels()` itself is still directly terminal-callable by name, same as before.
  `smfretAlignTolPx`'s own row (`smfretAlignTolRow`) is now conditionally shown — only relevant to
  `channelMatch` — hidden by default (matching `distAngle`'s own default) via both the static HTML
  attribute AND an explicit page-load sync line (belt-and-braces: a loaded settings JSON can set
  `smfretPairMethod` without dispatching its own `change` event, which only the sync line, not the
  `change` listener alone, would catch). `smfretPairingBtn`'s own id/enable-disable lifecycle
  (Localize SOI's success path, the 4 reset blocks) is UNCHANGED and now the single shared button for
  both methods — `alignSmfretChannels()`'s own internal disable/enable (previously targeting its now-
  removed dedicated `smfretAlignBtn`) was retargeted to the same shared `smfretPairingBtn` id.
  Verified via Playwright against the real ALEX dataset: the default selection dispatches to
  `getSmfretPairingFromDonor()` (119 pairs, its own histogram-fitted window), switching to "Via
  channel matching" reveals the tolerance row and dispatches to `alignSmfretChannels()` instead (141
  pairs, matching the previously-established real-data result) — confirming the SAME underlying
  algorithms run unchanged, just reached through one consolidated control now.

  **Five follow-up fixes, same day.** (1) **"Align channels match tol. (px)" → "Align channels match
  tolerance (px)"**, default lowered from 10 to 4 px — a tighter default now that the button/selector
  consolidation makes it easy to raise by hand if a real setup genuinely needs more slack; the field's
  own tooltip dropped its "kept generous by default" framing accordingly. (2) **"Pair DD + AA" →
  "Pair DD + DA"** — the button's own static label (never dynamic per-method, by design, see the
  consolidation entry above) reverted to the original wording. (3) A third rename — "Link DD/DA/AA" →
  "Filter SOIs" — was requested but SKIPPED on direct confirmation: "Filter SOIs" already labels a
  completely different, pre-existing control (`smfretTraceChannels`, Get time traces' own DD+DA/
  DD+DA+AA channel selector) — reusing the same label for a second, unrelated control would create a
  real ambiguity, flagged via `AskUserQuestion` before touching anything; the user chose to skip this
  one rename rather than rename either control. (4) **A real, reported persistence bug in the Time
  trace selection highlight** (added earlier the same day): toggling the SOI composite's own AA/
  DD+DA view (`toggleAlexProjChannel()` → `refreshAlexProjectionIfShown(true)` →
  `locateSmfretSOI(true)`) was silently NULLING `smfretTraces` at the very top of
  `locateSmfretSOI()`, regardless of `preservePairing` — a real gap in that flag's own original
  intent (protecting a "just peeking at the other channel" view toggle from discarding real work,
  already covering the PAIRING state further down the function, but never extended to the ACTIVE
  TIME TRACE SESSION). This didn't just hide the highlight — it destroyed the whole trace session
  (raw panel reverted to a live frame, `smfretTraces=null`), and the highlight never came back even
  after toggling back to the original channel, since the destroyed session state has no path to
  regenerate itself. Fixed by gating that block on `!preservePairing` too — `smfretTraces` itself
  doesn't depend on which composite is currently shown (built from `lastResult.locs`, itself
  untouched by a view toggle), so there was nothing to actually invalidate in that case. **Caught via
  a real Playwright timing bug in the FIRST verification attempt** — `toggleAlexProjChannel()` isn't
  itself `async` (it fires off `locateSmfretSOI()`'s own async work without awaiting it), so a test
  that doesn't wait for that work to finish reads stale state and can look like "nothing changed"
  regardless of whether the underlying fix worked; re-verified with an explicit wait, confirming the
  highlight (measured via a real on-canvas blue-pixel count) survives a full AA→DD+DA→AA round trip
  unchanged (359→361→359 pixels, the small AA-view difference just reflecting a different composite
  image underneath the same real overlay). (5) **The highlight's connecting line now starts/ends at
  each circle's own EDGE, not its centre** — offsets each endpoint along the unit vector between the
  two circle centres by the shared radius `r` (guarded against near-zero separation, `dist>2*r`,
  avoiding a `dx/dist` NaN when the two circles are very close together or coincide). Verified via a
  zoomed-in screenshot: no line visible cutting through a highlighted circle's own interior, only
  starting right at its boundary and heading toward the (off-screen, tens-of-µm-away) partner.
  Also: changing **"Align channels match tolerance (px)"** now re-runs **Pair DD + DA** automatically
  whenever a pairing already exists (same "refresh an existing result" convention `smfretApertureMode`/
  `sSmlmBgProfile`'s own change listeners already use elsewhere) — a no-op before any pairing exists.

  **A real, reported bug in the dark-orange "paired" marking itself, found via a screenshot**: a
  channel-matched pairing's blue trace-selection circle (above) sat over a genuine, boxed
  `smfretSOI` site with NO orange recolouring at all, prompting the (reasonable, but wrong) question
  "is Link DD/DA/AA actually needed if channel matching already links things?" Root cause:
  `markSmfretSoiPairedKeys()`'s own match test was EXACT string-value equality between a paired
  row's `x2,y2` and an `smfretSOI` entry's own `x,y` — correct for `getSmfretPairingFromDonor()`
  (the distAngle method), whose `pairCore()` always copies `x2,y2` verbatim from ANOTHER entry
  already inside the SAME `smfretSOI` array (so exact equality is guaranteed), but silently
  impossible for `alignSmfretChannels()`'s own AA-sourced matches — those come from
  `smfretSOICore(cfg,stack,{smfretSoiChannel:'acceptor'})`'s SEPARATE, independently-fit
  direct-acceptor-excitation composite, a genuinely different image with its own independent noise
  realization, so bit-for-bit equality with anything in `smfretSOI` essentially never holds even for
  a real, correct link. Confirmed directly against the real ALEX dataset before fixing: 29 of 59
  channel-matched pairs — precisely the AA-sourced ones (`nDAsourced=30` matched exactly under the
  old check; `nAAsourced=29` never did) — could never be marked, full stop, regardless of match
  quality. Fixed with two changes: (1) `alignSmfretChannels()` now tags each truth point's own
  origin (`daPoints.forEach(L=>L.pairSrc='DA')`/`core.fitted.forEach(L=>L.pairSrc='AA')`, right
  after each is built), carried into `paired.push({...D,x2:T.x,y2:T.y,dist:...,pairSrc:T.pairSrc})`
  — `linkSmfretChannels()`'s own `kept.push(L)` keeps original object references, so this field
  survives Link DD/DA/AA's own filtering for free, no changes needed there; `getSmfretPairingFromDonor()`/
  `pairCore()` never set it at all, so every distAngle-method pair reads `pairSrc===undefined`,
  treated as `'DA'`-equivalent (same-composite, by construction, for every pair that method
  produces). (2) `markSmfretSoiPairedKeys()` rewritten to a TOLERANT nearest-position match
  (`smfretBuildSpatialHash()`/`smfretNearestInHash()`, the same helpers `alignSmfretChannels()`
  itself already uses for its own displacement search — reused here purely for lookup, no search) at
  a new `SOI_MARK_TOL_PX=2` (matching `linkSmfretChannels()`'s own `LINK_RADIUS_PX` precedent for
  "same real feature confirmed across two independently-fit composites") instead of exact string
  keys — a DA-sourced pair still matches at distance ≈0 regardless, since its `x2,y2` genuinely IS
  another `smfretSOI` entry's own `x,y`.

  **Also now VISUALLY distinguishes the two kinds of match**, since an AA-sourced link is a real but
  meaningfully WEAKER guarantee than a DA-sourced one — pure nearest-neighbour geometry under one
  global rigid transform, with no per-pair distance/angle consistency check at all, versus a
  same-image, already-detected `smfretSOI` entry. `markSmfretSoiPairedKeys()` now returns two
  additional Sets (`aaLocKeys`/`aaSpotKeys`, always a subset of `locKeys`/`spotKeys`) alongside the
  existing ones, populated only when the tolerant match's own winning `smfretSOI` neighbour's
  `pairSrc==='AA'`. `drawSpotOverlays()` checks the AA sets FIRST: a new `AA_PAIRED_SPOT_COLOR`
  (`#e8b400`, gold) draws instead of the existing `PAIRED_SPOT_COLOR` (`#d2691e`, dark orange) for
  those entries only — still reads as "paired" at a glance, but visually flags "confirmed via a
  cross-composite geometric match, not per-pair-validated same-image data." Verified via Playwright
  against the real ALEX dataset: post-fix, `locKeys.size=49`/`aaLocKeys.size=17` (up from 0 pre-fix
  — some AA-sourced positions still land >2px from any real `smfretSOI` entry and stay unmarked,
  correctly, rather than being force-matched to the wrong neighbour), and a real on-canvas pixel
  check confirms both colours actually render (91 gold px, 253 orange px) on the same composite; a
  parallel check of the distAngle method confirms it's completely unaffected — 119/119 pairs still
  match exactly, `aaLocKeys` stays empty throughout.

  **`alignSmfretChannels()` upgraded from a single rigid displacement to a full 2D AFFINE transform**
  (rotation + scale + shear + translation), requested directly after investigating why "Via channel
  matching"'s own match tolerance needed to be so much looser than expected: "if we take the
  super-resolution position of each emitter, we should have a mapping with sub pixel accuracy
  between DD and AA ... maybe we should go with a transform instead of [a] vector?" — pointing at
  the same registration approach dedicated bead-based channel-mapping tools (TetraSpeck-style
  calibration in packages like TwoTone TIRF-FRET) already use. **Confirmed empirically before
  changing anything**: sweeping `smfretAlignTolPx` from 2 to 30 px on the real ALEX dataset showed
  pair count climbing steadily (36→177, saturating once every DD point finds SOME match) while the
  paired distances' own coefficient of variation climbed in lockstep (0.31%→3.23%) — a textbook
  signature of a systematic (not random) residual: real matches genuinely need more slack than the
  old default allowed, but that same slack lets the search snap onto the nearest WRONG neighbour in
  a crowded region (confirmed separately: DA-region nearest-neighbour spacing averages 10.6 px but
  drops to 0.24 px at its closest — real crowding, not a data artifact). A pure translation can't
  represent a real optical dual-view/image-splitter path's own small relative rotation or
  magnification difference between its two channels (different lens elements/path lengths are
  common) — its own residual grows with distance from wherever the translation happens to be
  centred, which is exactly the shape of the problem measured above.

  **`smfretFitAffine(corr)`** (next to `smfretApplyAffine()`, right after `smfretSearchDisplacement()`)
  is an ordinary least-squares fit of `x2=a·x+b·y+tx, y2=c·x+d·y+ty` from a set of DD→truth point
  correspondences — two independent 3-parameter linear regressions sharing one design matrix/normal-
  equations solve, via the same generic `solveLin()` (MODULE: fit) `fitNeNA()`/`fitSSmlmDist()`
  already use for their own LSQ fits. Returns `null` (fewer than 3 correspondences, or a degenerate/
  collinear set — `solveLin()` itself returns `null` on a singular matrix) rather than a garbage
  transform. Verified via a synthetic JXA check (known ground-truth rotation 3°/scale 1.02×0.99/
  translation (256,5), 50 random correspondence points): recovers all 6 parameters to machine
  precision noise-free, and to <0.1 px max residual with ±0.3 px of matching noise added — the math
  itself is correct before it ever touches real data.

  `alignSmfretChannels()`'s own displacement search is now only a coarse, cheap SEED for the affine
  fit, not the final answer: `smfretSearchDisplacement()` runs at a generous, non-user-facing
  `SEED_TOL_PX=max(tolPx,20)` (real matches can be missed near the FOV edges under a translation-only
  guess, so the seed stage needs slack the FINAL match no longer does) to gather an initial
  correspondence set, then a small, fixed-round ICP (`ICP_ROUNDS=4`) alternates fitting the affine
  from the current correspondences and re-matching under it at a geometrically-shrinking tolerance
  (`SEED_TOL_PX·(tolPx/SEED_TOL_PX)^(it/ICP_ROUNDS)`) down to the user's own `smfretAlignTolPx` —
  each round's tighter, more-accurate correspondence set feeds a better-conditioned fit than the
  last. Falls back to keeping the LAST GOOD transform (identity+translation initially) if a round's
  correspondence set drops below 3 points or `smfretFitAffine()` returns `null` — never propagates a
  degenerate fit forward. `smfretAlignTolPx` itself keeps its existing meaning to the user (the match
  tolerance), just now applied AFTER convergence rather than to a raw shift.

  On the real ALEX dataset, the fitted transform reads `scale 0.9871/0.9948, rotation -0.24°` — a
  small but real (~1.3%/0.5%) scale mismatch between channels, not merely rotation, confirming there
  WAS genuine non-translational distortion for the affine to correct. **Effect measured directly,
  not assumed**: comparing each of the 177 DD-region points' own nearest-truth-point residual under
  the best pure translation vs. the converged affine — the OVERALL median residual barely moves
  (7.63→6.87 px), because most of that population reflects points with NO real partner at all
  (expected in real smFRET data — a donor-only population is a standard artifact, not a registration
  failure), not registration error. But among points that DO have a real match, the affine's benefit
  is large: **3× as many land within 2 px** (9→28) and noticeably more within 4 px (46→56) — exactly
  the sub-pixel-to-few-px accuracy a genuine geometric transform should recover, once the "most
  points have no partner" population is set aside. End-to-end pair counts at matched tolerances
  are similar to the old pure-translation numbers (e.g. tol=4: 59→56) with slightly BETTER
  consistency at every tolerance (CV 0.83%→0.66% at tol=4; 1.88%→1.78% at tol=10) — a modest,
  genuine improvement on this particular dataset, whose own optical mapping turns out to already be
  close to a pure shift; the affine model is expected to matter far more on a setup with a larger
  real rotation/magnification difference between channels, which this implementation now handles
  correctly rather than silently absorbing into a looser, noisier translation-only tolerance.

  **"Show E hist"/"Show E/S hist"** (requested — a classic ALEX-FRET "E-S" plot, reference image
  supplied) pools every site's own DD/DA/AA samples across ALL time points into one population-level
  FRET histogram — `smfretPoolE(minDex)` (E = DA/(DD+DA), 1D case) and `smfretPoolES(minDex,minAA)`
  (E vs S = (DD+DA)/(AA+DD+DA), 2D case, the standard ALEX stoichiometry). `renderSmfretEHistCore()`
  dispatches between the two based on live state: E alone needs only a real DD+DA pairing
  (`s.photonsDA` present); the 2D E-vs-S plot additionally needs ALEX on AND AA data
  (`s.photonsAA` present) — matching `getSmfretTimeTraces()`'s own `showAA` gate exactly, since S
  has no meaning without a direct-acceptor-excitation channel to sample AA from at all.
  `smfretEHistBtn`'s own label reflects which of the two the NEXT click would draw
  (`refreshSmfretEHistBtn()`, same "shows what clicking gets you" convention `driftPlotModeBtn`/
  `sptHistModeBtn` use), refreshed after every `getSmfretTimeTraces()` run and on `alexEnabled`'s own
  `change` (a second, additional listener — `toggleAlexEnabled()`'s own existing one is left
  untouched).

  `smfretMinDex`/`smfretMinAA` (new `PARAMS` entries, `max:null` — same "no fixed UI ceiling, the
  real bound comes from the loaded data" convention `fitLastFrame`/`segAreaMax` already use) are
  per-SAMPLE (site,frame) burst-selection thresholds — the standard smFRET/ALEX technique for
  excluding a sample whose own donor-excitation (or, for AA, direct-acceptor-excitation) total
  intensity is too low for E (or S) to be a meaningful ratio rather than noise.
  `smfretUpdateEHistThresholdRanges()` (called once `getSmfretTimeTraces()` succeeds) sets both
  sliders' own `max` from the ACTUAL loaded traces' observed range — same pattern the raw-panel
  Contrast slider's own `estimateRawContrastRange()` already established — and clamps the CURRENT
  value down if a smaller re-run left it out of range. Each threshold is a range+number pair
  (`wireSmfretThresholdSlider()`, two-way bound) — dragging/typing gives a cheap live redraw
  (`refreshSmfretEHistIfShown()`, checked via `rawPlotName`/`histData.col`) with one `logCmd()` on
  release (`change`), the same "cheap redraw per tick, one committed log per gesture" convention the
  sSMLM distance histogram's own draggable min/max markers already use.

  **1D case** (`drawSmfretEHist()`) reuses the exact shared column-histogram machinery
  (`computeHist()`/`drawHistogram()`, MODULE: table) every other histogram in this app already draws
  through — table columns, sSMLM distance/angle, spt D/track-length — rather than a bespoke drawer;
  only `histData.col`'s text ("E (FRET efficiency)") distinguishes it from those, and is what
  `refreshSmfretEHistIfShown()`/`smfretEHistLogIfShown()` check to know this specific histogram (not
  some unrelated one) is currently showing.

  **2D case** (`drawSmfretESPlot()`) is bespoke — no existing plot in this app is a 2D binned
  scatter-density — but reuses two already-shared primitives rather than reinventing them: `blur()`
  (MODULE: fit, the SAME Gaussian blur `renderSuperResPixels()` uses) smooths the raw per-bin counts
  into the soft "hot cloud" look these plots conventionally have (a plain bar grid reads as
  blocky/noisy at any realistic sample count — the same reasoning the reconstruction itself blurs
  for), and `getLUT('viridis')` (MODULE: render, the SAME LUT the reconstruction/render pipeline
  uses) colorizes it — "the rendering engine from 3D plot" the request asked for, reused here as its
  two real components rather than a literal call into `renderSuperResPixels()` itself (that
  function's own machinery — CRLB-sized Gaussian splats, mag/zoom, z-colour — has no natural meaning
  in an E/S coordinate space). A 60×60 bin grid (fixed [0,1] domain both axes, the conventional E/S
  range) is blurred, normalised, colour-mapped, then blitted through a tiny offscreen canvas scaled
  up to the plot rect — the canvas's own bilinear resampling adds a further, cheap smoothing pass on
  top of `blur()`'s own. Near-empty bins are left fully transparent (alpha 0) rather than a flat
  dark-viridis rectangle, so the panel background shows through outside the real data cloud. 1D
  marginal histograms — E along the top, S along the right (rotated, bars extending from the main
  plot's own right edge) — use the SAME 60 bins/domain as the main density grid, so they align
  exactly under/beside the shared axes; plain bar histograms for this first version, not the
  smoothed KDE-like outline the reference image's own marginals show. Row `by=0` (low S) must be
  written to the LAST image row, not the first — canvas image rows run top-to-bottom while the
  plot's own S axis increases upward, the same bottom-up-vs-top-down flip every other
  non-screen-native-axis plot in this app already needs. Verified via Playwright with synthetic
  DD/DA/AA trace data (known true E/S per site): both the 1D histogram (`histData.n`/`lo`/`hi` match
  the synthetic population) and the 2D plot (real viridis-coloured pixels at the expected E/S
  location, correct marginal bar heights, `n` label) render correctly with zero page errors; raising
  Min D_ex live (dispatching a real `input` event) correctly shrinks the pooled sample count
  (6000→4127 against a synthetic population with a deliberate 30% dim-sample fraction).

  **Four follow-up fixes, same feature, next round — two of them real bugs the first version's own
  synthetic verification failed to catch.**

  **(1) A genuine bug in `smfretPoolES()` itself, not a display issue**: reported as "E/S histogram
  errored out saying no samples pass the current threshold even though they were by default at 0."
  Root cause: under ALEX, `getSmfretTimeTraces()`'s own `isDonorExc`/`showAA` gates write
  `photonsDD`/`photonsDA` and `photonsAA` to STRICTLY ALTERNATING frame indices — a donor-excitation
  frame never also has a finite AA value at that same index, and vice versa (by construction, one
  physical excitation laser is on at a time). The first shipped `smfretPoolES()` required all of
  `dd[i]`/`da[i]`/`aa[i]` finite at the SAME `i` — an intersection that is ALWAYS EMPTY on real ALEX
  data, regardless of threshold or how much real data exists. **The original verification's own
  synthetic fixture had the identical bug** — it wrote `aa[i]` at every index alongside `dd[i]`/`da[i]`,
  which doesn't model real ALEX sampling at all, so the "6000→4127" test above never actually
  exercised this code path against realistic data. Fixed by pairing a donor-exc frame `i` with its
  own ADJACENT acceptor-exc frame's AA value instead (prefer `aa[i+1]`, fall back to `aa[i-1]`) — one
  ALEX excitation CYCLE, not one frame index, is the real unit of "simultaneous" DD/DA/AA. Verified
  with a CORRECTED synthetic fixture (even frames = DD/DA finite/AA NaN, odd = the reverse) and
  against the real ALEX dataset: 11,965 real (site,frame) samples now pass at threshold 0, where the
  unfixed version found 0 regardless of threshold.

  **(2) Moved both plots from the raw (left) panel to the reconstruction (right) one** (requested —
  "move E/S to the right panel", so it can sit alongside the Time trace plot rather than replacing
  it) — genuinely new territory for the SR panel (previously only 3D calibration's own
  `drawCalibration()` and the ordinary reconstruction/SOI composite ever drew there). The 1D case
  (`drawSmfretEHist()`) is now a bespoke drawer rather than reusing `computeHist()`/`drawHistogram()`
  (MODULE: table) — that pair is hardcoded throughout to the raw panel (`rawFull`/`rawPlotName`/
  `$('rawTitle')` baked into `drawHistogram()` itself), and retargeting such a widely-shared function
  risked unrelated regressions for a modest amount of reuse; simpler and lower-risk to give it its
  own small drawer, styled consistently with `drawSmfretESPlot()`. Both now use `srFull=null`/
  `srIsPlot=true`/`setSrRecon(false)`/`$('srTitle')`/`_replotSr`/`_plotHover.sr` (the `drawCalibration()`
  convention), not the raw-panel equivalents. `refreshSmfretEHistIfShown()`/`smfretEHistLogIfShown()`
  check `$('srTitle').textContent` (`'E histogram'`/`'E vs S'`) to know this specific plot — not some
  unrelated one — currently owns the panel, the same "read the title text" mechanism
  `markSmfretSoiPairedKeys()`/`refreshSSmlmHistIfShown()` already use elsewhere, since no dedicated
  `srPlotName` variable exists (only the raw panel's `rawPlotName` does) and introducing one for just
  this one caller wasn't worth it. `drawView()` (the "a real reconstruction reclaims this panel" entry
  point) gained one more reclaim line hiding both threshold rows, matching its own pre-existing
  `calViewRow` precedent right above it.

  **A second real bug, found only once the plot actually lived in the SR panel** (not a synthetic-test
  gap this time — a real, reported symptom: "the sliders show, then disappear"): `drawSmfretTrace()`
  (the Time trace plot, MODULE: smFRET) has its own long-standing tail —
  `if(srLocs===smfretSOI){ clampView(); drawView(); }` — that refreshes the SOI composite's own blue
  trace-selection highlight (see this module's own earlier paragraph on it) every time the Time trace
  redraws. `showSmfretEHist()` only ever touches `srFull`/`srIsPlot`, never `srLocs` — so
  `srLocs===smfretSOI` stayed true even while the E/S plot owned the SR panel, meaning EVERY Time
  trace redraw still unconditionally called `drawView()` on top of it. This didn't show up
  immediately: `refitCanvases()`'s own debounced resize/`ResizeObserver` handler (MODULE: pipeline)
  replays whichever of `_replotRaw`/`_replotSr` currently applies ~120ms after a layout change —
  and showing the two new threshold rows for the first time IS a layout change (the SR panel's own
  `.panel-body` grows taller) — so `_replotRaw()` (still `drawSmfretTrace`, from the Time trace plot
  in the OTHER panel) fired shortly after the click, its own tail called `drawView()`, which blanked
  the E/S plot and hid the very rows that had just triggered the resize in the first place. Confirmed
  by instrumenting `drawView()` directly (a wrapped version logging `new Error().stack`) — the call
  chain traced exactly to `refitCanvases()` → `_replotRaw` → `drawSmfretTrace()`'s own tail. Fixed
  with one added guard, `srLocs===smfretSOI && !srIsPlot` — `srIsPlot` is `false` whenever the SOI
  composite is genuinely showing (unaffected) and `true` exactly when a plot (E-hist or calibration)
  owns the panel instead, so the highlight-refresh now correctly skips itself while an unrelated plot
  is up. Re-verified via the same `drawView()` call-count instrumentation: the rows now stay visible
  (`display:'flex'`) past the same 400ms window that previously reverted them to `'none'`.

  **(3) `locateSmfretSOI()`'s own button listener had the SAME event-object-as-parameter bug
  `getSmfretTimeTraces()`'s click listener was already fixed for, just never applied here** (reported
  — "Localize SOI should reset potentially existing pairs, links and traces", i.e. it currently
  didn't). `$('smfretLocateBtn').addEventListener('click', locateSmfretSOI);` handed the real DOM
  click `Event` object to `locateSmfretSOI(preservePairing=false)` as its own `preservePairing`
  parameter on EVERY real user click — an `Event` is always truthy, so `preservePairing` was
  effectively always `true` for a genuine click, never the intended default `false`. Two real
  consequences, both silent: the smfretTraces-invalidation block (`if(smfretTraces &&
  !preservePairing)`) never fired (`!preservePairing` was `!<truthy>` = `false`), and — worse — the
  `if(preservePairing && smfretHasDDDAPairing()){ ...; return; }` early-return fired on every click
  where a pairing already existed, skipping the reset of `sSmlmOriginalLocs`/`smfretChannelsLinked`/
  `smfretPairedSoiKeys` entirely. Net effect: a genuine fresh Localize SOI click never actually reset
  an existing pairing/Link DD/DA/AA state/Time trace session at all — exactly the reported symptom.
  Fixed the same way `getSmfretTimeTraces()`'s own listener already was: wrap it,
  `()=>locateSmfretSOI()`, so a real click always calls it with zero arguments (`preservePairing`
  correctly resolves to its own default `false`); `refreshAlexProjectionIfShown(true)`'s own DIRECT
  call to `locateSmfretSOI(true)` (the real "just peeking at the other channel" case this parameter
  exists for) is a plain function call, not an event listener, so it's completely unaffected. Verified
  via Playwright against the real ALEX dataset: built a real paired+linked+traced session
  (`sSmlmOriginalLocs!==null`, `smfretChannelsLinked===true`, `lastResult.locs.length===51`), then
  dispatched a REAL `page.click()` (not a direct function call) on Localize SOI — post-fix, all three
  correctly reset (`sSmlmOriginalLocs===null`, `smfretChannelsLinked===false`,
  `lastResult.locs.length===482`, matching the fresh, full, unpaired SOI count) — pre-fix this exact
  sequence left the OLD 51-row paired/linked state completely untouched.

  **Three more requests, same round.** (1) Both E-hist plots now call `setSrContrastRowVisible(false)`
  right after claiming the panel — the SOI composite's own Contrast (Black/White) slider has no
  meaning for a density/count plot, and was previously left showing (stale) underneath it. (2) 2D
  density blur reduced `1.1`→`0.6` (`blur(grid,NB,NB,0.6)`, `drawSmfretESPlot()`) — the original value
  over-smoothed real structure in the density on actual data; still enough to avoid a blocky per-bin
  look. (3) **`alexProjToggleBtn` folds the E/E-S histogram into its own existing DD+DA/AA cycle as a
  THIRD stop** (requested — "the toggle should enable to toggle between E/S, SOI composite DD+DA, and
  SOI composite AA"): DD+DA → AA → E (or E vs S, whichever `smfretCanShowEHist()`/ALEX+AA data calls
  for) → back to DD+DA. `smfretCanShowEHist()` (extracted from `showSmfretEHist()`'s/
  `refreshSmfretEHistBtn()`'s own duplicate checks — a real "must never drift apart" risk otherwise,
  since a mismatch would mean the toggle offers "E/S" as a destination the button itself would then
  refuse) is the single shared gate all three now use. `toggleAlexProjChannel()` reads the CURRENT
  state from `$('srTitle').textContent` (the same discriminator `showSmfretEHist()`/
  `refreshSmfretEHistIfShown()` already use) rather than a separate mode variable — doesn't matter
  whether the user arrived at the current view via this toggle or a direct button click either way.
  Only reachable with ALEX on (without it there's no DD+DA/AA composite distinction at all —
  `alexProjToggleBtn` stays hidden entirely, unchanged). `locateSmfretSOI()`'s own AA-composite label
  line now reads `smfretCanShowEHist()` too, showing "E/S" as the next stop once real data exists,
  "DD+DA" (the plain 2-way fallback) otherwise — naturally correct immediately after a fresh Localize
  SOI run, since that already resets `smfretTraces` to `null` before this label is set (see the
  `preservePairing`-bug fix just above). **A real bug caught while wiring the "E/S → DD+DA" step**:
  the first attempt called `refreshAlexProjectionIfShown(true)`, which decides what to refresh by
  RE-READING `$('srTitle')` itself — but the title is STILL `'E vs S'`/`'E histogram'` at that point
  (nothing has redrawn yet), so it matched neither of that function's own branches and silently did
  nothing, leaving the toggle stuck on the E/S view forever. Fixed by calling `locateSmfretSOI(true)`
  DIRECTLY instead — this step is a forced TRANSITION away from the plot, not a "refresh whatever's
  already showing" (the composite isn't currently on screen to refresh). Verified via Playwright
  against the real ALEX dataset, cycling through all 4 steps of the loop: DD+DA (label "AA", Contrast
  visible) → AA (label "E/S", Contrast visible) → E vs S (label "DD+DA", Contrast hidden) → back to
  DD+DA (label "AA", Contrast visible again) — confirmed broken at exactly the 4th step before the
  `refreshAlexProjectionIfShown`→`locateSmfretSOI` fix, correct after.

- **spt** (single particle tracking, v0.11.2) — links per-frame localizations into trajectories and
  computes a per-track diffusion coefficient. The sidebar label carries the same **"(Caution!)"**
  prefix as **sSMLM**/**smFRET** (see sSMLM's own paragraph on this — id stays `sptBox`), since the
  linking/D-estimation approach here (trackpy-inspired, a single-average-per-track D, no MSD-vs-lag
  fit) is one specific, scope-limited method, not a general SPT solution. A trackpy-**inspired** variant (same
  `search_range`/`memory` terminology and linking philosophy as the Python `trackpy` package), not
  a literal port. Ported from the user's own `sptPALM-Python` pipeline (L. lactis sptPALM, Martens
  et al., *Nat. Commun.* 10, 3552, 2019). `linkTracks()` walks frames in order; each frame's
  track↔candidate bipartite graph (edges within `sptSearchRange`, gated by `sptMemory` for
  gap-bridging) splits into connected components ("subnetworks") via union-find, each solved by a
  self-contained Hungarian/Kuhn–Munkres implementation (`hungarianAssign()`) for the
  minimum-total-squared-displacement assignment. NOT trackpy's own recursive exact-subnetwork
  solver; components above `HUNGARIAN_MAX` (120) fall back to greedy nearest-neighbor instead
  (one-time logged warning) rather than let O(n³) stall the tab — a documented scope limit, not
  expected to matter for real single-molecule SPT density. Returns a NEW locs array (never
  mutates) with `track_id` set on EVERY localization, even length-1 tracks — length filtering
  happens only at the diffusion-coefficient step. `trackDiffusionCoeffs()` ports
  `diff_coeffs_per_track()`'s core MSD math: one D (µm²/s) per track with at least
  `sptTrackLenMin` localizations, from the gap-corrected mean of ALL of that track's own
  single-frame squared displacements — an average, explicitly NOT a linear MSD-vs-lag-time fit,
  matching the reference pipeline — `D = MSD/(4·frametime) − locError²/frametime` (2D,
  static-localization-error-corrected). Unlike the reference pipeline there is no
  `sptTrackLenMax` truncation. `trackDiffusionCoeffs()` also collects `trackLengths` for EVERY
  linked track regardless of D qualification — `drawSptTrackLenHist()`'s log-Y-axis histogram of
  this is how a user judges whether `sptTrackLenMin` is set sensibly (`computeHist()`/
  `drawHistogram()` gained a `logY` parameter for this: bars/ticks map through `log10(count)`,
  with a 0-count bin pinned to the floor via `log10(max(1,c))=0`; the hover readout hands log-space
  bounds to its own `fmt` callback rather than teaching the shared hover code a Y-scale option). A
  real, expected artifact of the D formula is that near-immobile or very-short tracks can compute a
  non-positive D — `drawSptDHist()` EXCLUDES these from the plotted log10(D) histogram (logged
  count, not silently dropped) rather than pooling them into one fake-spike bin. **Track**
  (`runSptTrack()`) is idempotent, safe to re-run any time. Immediately draws the D histogram,
  fed `log10(D)` (D commonly spans orders of magnitude); not yet nicely `10^x`-formatted tick
  labels (v1 shortcut, `docs/REFACTOR_PLAN.md`). `sptDPlotMin`/`Max` are a DISPLAY-only axis
  window — `meanD`/`medianD` always reflect every qualifying track.

  **`sptHistBtn`** ("Show histograms") shows either the D or track-length histogram;
  `sptHistModeBtn` (same `.logbtn` placement as `driftPlotModeBtn`) toggles which of
  `drawSptDHist()`/`drawSptTrackLenHist()` is on screen, labelled with the OTHER mode's name.
  `sptHistMode` resets to `'D'` only at the top of a fresh `runSptTrack()`. `sptHistBtn` is enabled
  off `trackLengths.length`; if a fresh Track run has zero qualifying D estimates, it sets
  `sptHistMode='length'` first so a dataset with tracks but no D estimate still shows a useful
  histogram automatically.

  D = (MSD/4 − locErrorUm²)/frametime is exactly linear in 1/frametime, and MSD itself (cached per
  track in `trackDiffusionCoeffs()`'s `trackMSD` Map, plumbed to `lastSpt.trackMSD`) depends on
  neither frametime nor locError. `recomputeSptD()` exploits this: editing **Frame time** or
  **Localization error** after **Track** rescales every track's D directly from `trackMSD`, no
  re-linking — unlike **Search range**/**Memory**/**Min track length**, which still need a fresh
  **Track**. **Get from NeNA** (`sptLocErrorFromNenaBtn`) writes `sptLocError.value`
  programmatically, which doesn't fire `change`, so its handler calls `recomputeSptD()` explicitly.

  **`frametime`** (Frame time (s), renamed from `sptFrameTime`, v0.12.1-dev) moved OUT of this
  module's own `sptBox` to a pinned, always-visible sidebar row next to `pxnm` — same precedent and
  reasoning as `pxnm`'s own earlier relocation (see MODULE: params' comment on it): a per-dataset
  acquisition property, not something spt-specific, despite spt being its only current consumer.
  PARAMS registry position follows `pxnm` (both under the `// ---- render ----` comment group) for
  developer discoverability, but its DOCUMENTATION.md table entry stays under spt's own §3 section
  — its real functional home — exactly mirroring how `pxnm`'s own table entry stays under
  "Rendering settings" despite its pinned UI position; §1's sidebar section covers the physical
  relocation for both fields together. **Renaming, not just relocating** (unlike `pxnm`, which kept
  its id): a plain relocation would have left an SPT-specific id (`sptFrameTime`) on a control that
  no longer lives in the SPT section, confusing for anyone reading `PARAMS`/a settings file cold.
  Three TEMPORARY back-compat aliases cover the old key, each logging one deprecation warning and
  removable once external scripts/settings have migrated: (1) `analyze()`'s own top-of-function
  check (`config.sptFrameTime→cfg.frametime`, since `Object.assign(defaultConfig(),config)` would
  otherwise leave the caller's real value shadowed by `frametime`'s own default, with no error) —
  this alone also covers `tools/webSMLM-cli.mjs`'s `--sptFrameTime`, since the CLI forwards raw
  `--key value` pairs straight into `config`; (2) the Load Settings handler's own alias, applied to
  the parsed JSON's `values` object BEFORE the `for(const id in v)` loop, so an old saved file's
  `sptFrameTime` isn't silently dropped as an "unknown/legacy key"; (3) `runAutorun()`'s URL-param
  loop, which needed its own explicit `if(key==='sptFrameTime')` branch since `PARAMS['sptFrameTime']`
  no longer resolving means the loop's generic `spec`-driven path can't find it either. Fresh Save
  settings/Save data always write the new `frametime` key — the alias is read-only compatibility,
  never round-tripped back out.

  `drawSptTrackLenHist()` fits an exponential decay (`fitTrackLifetime()`, count(L) ~ A·exp(−L/τ),
  a photobleaching-limited survival model) via WEIGHTED least-squares on ln(count) vs bin centre,
  weight = the bin's own count. **Weighting is required, not cosmetic**: bin counts are
  Poisson-distributed (Var(ln(count)) ~ 1/count) — an unweighted fit gave a count-of-2 tail bin the
  same say as a count-of-8000 peak bin, dragging the fit an order of magnitude below the first bar.
  Fit curve drawn magenta (`#c81cc8`, matching **drift**'s pairing), attached as
  `histData.curve`/`curveLabel`. τ is reported in both locs and seconds; **locs≈frames only when
  `sptMemory=0`** — a bridged gap still counts as one "loc" despite spanning >1 frame, so the
  seconds figure is an approximation once gap-bridging is active. `computeHist()`'s `markers`
  parameter draws a vertical line at the current `sptTrackLenMin` (`trackLengths` never depends on
  that field, precisely so the marker can help pick it) — its `change` listener calls
  `refreshSptTrackLenHistIfShown()` to redraw the marker live, no re-Track needed.

  `track_id`/`D_coeff` are independent, optional table/CSV columns (same pattern as sSMLM's
  `dist`/`sigma1st`), so the filter grammar works on tracking data for free. **Save track data**
  (`sptSaveBtn`/`exportSptSummary()`) is a genuinely DIFFERENT export: `sptTrackSummary()`
  aggregates into one row per TRACK (`track_id`/`n_locs`/`D_coeff`/`mean_x`/`mean_y`) built from
  the tracked locs directly, not `lastSpt`'s own (D-qualifying-only) arrays. **Headless**:
  `config.sptTrack` runs tracking AFTER drift/NeNA/FRC (opposite order from `sSmlmPair`) since a
  per-track D benefits from drift-corrected coordinates; the result's `spt` field records
  `nTracks`/`nQualify`/`meanD`/`medianD` only (`trackMSD` is a `Map`, not JSON-serialisable).
  `tools/webSMLM-cli.mjs`'s `--sptTrack`/`?autorun=`'s `sptTrack=1` forward to it. No
  length-RESOLVED D histogram — tracked as `docs/REFACTOR_PLAN.md` follow-up.

  **Tracks overlay** (`srTracksOverlayBtn` "Show tracks"/"Hide tracks" next to the SR-panel title;
  `sptShowTracksBtn` in the sidebar turns it ON) plots a filtered/sampled subset of tracks as thin
  polylines over the reconstruction (`drawTracksOverlay()`), styled to match the user's own
  `sptPALM-Python`: plain magenta (`#ff3bff`) by default, or — `sptTracksColorByD` (checked by
  default) — each track coloured by its own mean D via `getLUT('fire')`, normalised against
  `sptDPlotMin`/`Max`; a track with no qualifying D draws neutral `#666`. A filled circle marks
  each track's start point (radius = 2× line width); the track number sits beside it in white on a
  `rgba(0,0,0,.6)` backing box, font size scaling with `view.zoom/fitZoom()` (not `view.zoom`
  alone, so it's dataset/`mag`-independent), clamped `[9,14]px`. Clicking a track's polyline
  selects it (`trackHitTest()`, point-to-segment distance, `8/view.zoom` tolerance) — the selected
  track overrides to magenta (colour-by-D mode) or `#3fb950` green (plain mode). `selectedTrackId`
  resets at the same five call sites `srTracksOverlayOn` does. Turning the overlay on also switches
  the reconstruction to the `grey` LUT (`switchLutToGreyForTracks()`).

  **Line thickness is `view.zoom` alone, NOT `mag*view.zoom`** — one `srFull` pixel's own
  on-screen size = `view.zoom`; `mag*view.zoom` draws one CAMERA pixel's width and is unbounded at
  high zoom — get this wrong again and it reproduces a real bug (giant spikes covering the
  reconstruction when zoomed in on one track).

  **`drawTracksColorBar()`** (D legend) anchors to the PANEL itself (`x=DW-28-bw, y=(DH-bh)/2`,
  `bw`/`bh`=`16`/`180`) — not `drawDepthBar()`'s data-extent anchor (tried first, read as squeezed
  into the corner); shifts left by `bw+24` when a real depth-colour bar shares the margin. **Must
  set `ctx.lineWidth=1` explicitly before its own `strokeRect()`** — `ctx.lineWidth` is canvas
  STATE, not reset between draw calls, and this runs immediately after `drawTracksOverlay()` in the
  same `drawView()` call, so without the reset its border silently inherited the tracks' own
  zoom-dependent line width (a real bug: the legend border thickened along with the track lines at
  high zoom). Same lesson for `textBaseline`: the unit label sets it to `'bottom'` explicitly
  rather than inheriting `'middle'` from the tick-label loop above it.

  `getTracksOverlayData()` groups `lastResult.locs` by `track_id` (excluding `track_id<0`) sorted
  by frame, cached by object identity against `lastResult.locs`. **`getVisibleTracksForOverlay()`**
  then narrows the list before drawing: `sptTrackLenMin` drops short tracks, then
  `sptShowTracksPct` (default 10%) samples a fixed percentage of the survivors deterministically —
  `mulberry32(TRACKS_OVERLAY_SEED)` draws one float **per track in the FULL, unfiltered id-ordered
  list**, keeping a track iff its draw is `<pct/100` AND it meets `sptTrackLenMin`. **The draw must
  run over the full list, not the length-filtered subset**, or raising `sptTrackLenMin` would
  reshuffle which tracks the RNG assigns to survivors — verified with a monotonicity sweep: the
  same dataset always shows the same track identities at a given percentage; raising the percentage
  only adds tracks; raising `sptTrackLenMin` only removes tracks. Cached against (list identity,
  minLen, pct); all three controls live-refresh via `refreshTracksOverlayIfShown()`.

  **`sptShowTrackDataBtn`** ("Show track data") opens `trackTableModal`: a sortable, filterable
  table of `sptTrackSummary()`'s per-track rows, reusing the main table's `parseFilter()` grammar
  and filter-autocomplete (`wireFilterAutocomplete()`, factored out for both boxes to share) rather
  than reimplementing it. Deliberately a SEPARATE, minimal implementation otherwise (own state/draw
  functions) rather than generalising the main table's own machinery, which is entangled with
  reconstruction filtering/temporal clustering/crop that a per-track summary has no equivalent of
  yet. `#trackTable` shares `#locTable`'s CSS via one combined selector list. Rebuilds fresh from
  `lastResult.locs` on every open; committed filters persist across close/open. Enabled/disabled by
  the same `!r.trackLengths.length` condition as `sptSaveBtn`/`sptShowTracksBtn`.

  **Cell-by-cell tracking is also wired headlessly** via `config.segmentationFile` (a File, loaded
  like `config.file`/`config.calibrationFile`, through its own hidden `#segmentationFileInput`).
  Its mere presence switches `sptCore()` to `segCtx`-based cell-by-cell tracking, same as checking
  **Apply segmentation?** interactively. This surfaced (and fixed) a real, previously-latent bug:
  `linkTracksPerCell()` read per-cell area off the module-level `segmentedImageData` global
  directly instead of taking it as a parameter — harmless interactively (always populated before
  this can run) but silently broken headlessly, since `analyze()` never touches that global —
  every loc would have come back excluded with no error. Fixed by recomputing the area map from
  the passed-in `segLabels` via `computeSegmentedImageData()` (pure, DOM-free) instead — a general
  lesson for any future `*Core()`-reachable function: a module-level global populated before every
  interactive call site is invisible until something calls the same function headlessly.
  `tools/webSMLM-cli.mjs`'s `--segmentation <mask.tif>` forwards to it; `?autorun=` has no
  file-upload mechanism at all, so it doesn't gain an equivalent.

  **Segmentation image** (`applySegmentation` checkbox, default unchecked; v1 toward
  cell-segmentation-aware tracking). Checking it reveals **Load segmented image**
  (`segLoadBtn`/hidden `segFile`, same accept list as **Load movie**), loading a separate
  integer-labelled mask through the same `loadTiffFile()` any movie goes through — 0=background,
  1/2/3/…=cell number. Only frame 0 is read (warns, doesn't error, on a multi-frame file). A
  movie/mask W×H mismatch logs a warning but loading still proceeds ("warn, don't block").

  `computeSegmentedImageData()` does one pass over the label array, building `segmentedImageData`
  (one `{id,cx,cy,areaPx}` row per nonzero label) — verified numerically EXACT against an
  independent numpy computation on the real bundled
  `experimental_data/bf_analysed_JH_procBrightfield_segm.tif` (111 cells).

  `drawSegmentedImage()` renders it through the SAME `rawFull`/`rawView` raster pipeline
  `drawRaw()` uses for an ordinary frame (fit/pan/zoom, and a correct raster PNG export for free,
  since `exportPanel()`'s PNG-vs-SVG dispatch keys off `rawFull` being non-null) rather than the
  plot mechanism — this is real pixel-density content with no meaningful vector form.
  `rawPixelData` is repurposed to hold the integer label array while shown (`rawSegView` flag) —
  `fmtRawPixel()`'s hover branches on it to show "cell N"/"background"; `redrawRawContrast()`
  no-ops instead of corrupting the label data through grayscale contrast mapping. The raw-panel
  crop tool is disabled while shown and re-enables automatically once a live frame reclaims the
  panel (`drawRaw()` resets `rawSegView=false`/`setRawPlot(false)`, same mechanism used for
  reclaiming from a plot). Unchecking **Apply segmentation?** reverts to the live frame and drops
  `segmentedImageData`/`segmentedImageLabels`.

  **Show image** (`segShowBtn`) shows either the segmentation image or its cell-area histogram; a
  raw-panel-title toggle (`segShowModeBtn`) flips `segShowMode` (`'image'`/`'hist'`) and calls
  `drawSegShow()` again. Unlike the spt/sSMLM histogram toggles (switching between two PLOTS
  sharing one draw call), this switches between a RASTER IMAGE (`drawSegmentedImage()`) and a PLOT
  (`drawSegAreaHist()`) — two structurally different rendering paths with no shared draw primitive,
  so `drawSegShow()` is a thin dispatcher; each mode keeps its own panel title. Hidden at the same
  two reclaim points every other raw-panel toggle uses.

  `drawSegmentedImage()` also calls `setFrameAspect(w,h)` with the segmentation image's OWN
  dimensions, taking over `--frame-ar` regardless of what set it before — a real bug otherwise: for
  a CSV-loaded result (no `stack`), `--frame-ar` was left at `parseCsvLocs()`'s own APPROXIMATE
  loc-bounding-box, so the panel got letterboxed with a gap that looked like a data misalignment.
  The segmentation image's dimensions are the more authoritative source once one is loaded — the
  reconstruction panel may pick up a small letterbox gap of its own instead, the right trade.

  `segmentedImageLabels` (`{arr,w,h}`, distinct from the per-cell stats table
  `segmentedImageData`) persists independently of whatever the raw panel currently shows, unlike
  `rawPixelData` — this is what **Show image** re-displays (deterministic seed-0 recolouring, so
  pixel-identical to the original load) without re-reading the file, and what tracking reads from.

  Cell colouring (`shuffledLabelColors()`) ports the *idea* behind the user's own
  `sptPALM-Python/helper_functions.py`'s `randomize_label_image()`: raster-order segmentation tools
  number cells in scan order, so physically adjacent cells often get consecutive label values,
  which map to near-identical hues through an ordinary continuous colour ramp. This shuffles each
  label's RANK (0..N-1) via a seeded PRNG (`mulberry32`) and maps rank/N straight to a hue
  (`hsvToRgb`, s=0.85/v=0.95) — spaces hues evenly regardless of gaps in the original label values.
  Verified visually against the real bacteria dataset — no two adjacent cells share a similar
  colour.

  **SR-panel "Show segm."/"Show recon."** (`srSegOverlayBtn`) swaps the panel between the normal
  density reconstruction and the segmented cells (OPAQUE) with the SAME density reconstruction
  drawn on top, its black background made highly transparent — cell colour shows through wherever
  there's no real signal, density stays visible on top (two earlier designs — a semi-transparent
  blend, then opaque cells with plain white points — were tried and rejected on direct feedback).
  Two offscreen canvases, both built in `drawView()`:
  - `buildSegOverlayCanvas()` — at `segmentedImageLabels`' own CAMERA-pixel resolution, label 0
    transparent, every other pixel OPAQUE via the same `shuffledLabelColors(seed=0)` call
    `drawSegmentedImage()` uses. Cached by object identity against `segmentedImageLabels`.
  - `buildTransparentReconCanvas()` — redraws `srFull` with alpha derived from each pixel's own
    LUMINANCE (`0.299r+0.587g+0.114b`, safe since every `LUT_CPS` ramp starts at `[0,0,0]`). `*2.5`
    gain so a pixel reaches full opacity well before true peak density; `MIN_SIGNAL_ALPHA` (90)
    floors the alpha of any nonzero-luminance pixel — without it a sparse/isolated localization
    (already near-black by LUT design) went dim AND nearly transparent at once, invisible against a
    bright cell colour underneath. Cached by object identity against `srFull`.

  Neither canvas is gated on `segmentedImageLabels.w/h` exactly matching `lastResult.w/h` — real
  segmentation masks are routinely a few px off from the movie's own dimensions, and requiring
  exact equality (an earlier version did) silently drew nothing for that common case. Matches this
  app's "warn, don't block" convention — `ctx.drawImage()` clips naturally at a genuine mismatch.

  **`segmentedImageLabels.refPxNm`** — localization POSITIONS never depend on `pxnm` (only the
  scale bar/`srInfo` readout do), so correcting **Pixel size (nm)** after loading a segmentation
  image had no visible effect on the overlay, a real bug. Fixed by treating the `pxnm` value at
  LOAD time as the segmentation image's own calibration reference (`refPxNm`, stashed only on a
  fresh load); `drawView()` scales the segmentation canvas's source-rect by
  `(current pxnm)/refPxNm`. **The direction was wrong in the first shipped version** (inverted,
  `refPxNm/current`) — caught only by checking against real data: double-check the direction
  empirically again if this formula is ever touched. Editing Pixel size (nm) while active needs no
  new wiring — the existing `pxnm` `change` listener already triggers `rerender()`→`drawView()`.

  **Cell-by-cell tracking** (`Min./Max. cell area (px)`, default 50/∞, same `default:Infinity`
  convention `fitLastFrame` uses). Their two `label.row`s are direct children of `#sptBox`
  (`segAreaMinRow`/`segAreaMaxRow`, `padding-left:40px`) rather than nested inside `#segLoadRow` —
  see the `label.row` nesting-depth gotcha above for why nesting there silently broke their
  right-edge alignment despite still looking indented. A fresh **Load segm. image** sets
  `segAreaMax` to `Math.max(...segmentedImageData.map(c=>c.areaPx))` — a real upper bound for that
  image. Ports `apply_cell_segmentation_sptPALM.py`/`tracking_sptPALM.py`'s own `use_segmentations`
  branch. `cellIdForLoc(L,segLabels)` looks up a loc's raw label the same way `fmtRawPixel()`'s
  hover does; `linkTracksPerCell()` groups locs by that label FILTERED through
  `segmentedImageData`'s own `areaPx` (`-1` sentinel, deliberately not `0`, which some dataset's
  raw mask might legitimately use as a real label — for background OR an out-of-range cell) and
  runs `linkTracks()` SEPARATELY per qualifying cell, so a track can never cross a cell boundary.
  Each cell's local `track_id` range is offset by a running counter (mirroring the reference
  pipeline's `track_id_shift = max(tracks['track_id'])+1`) so the merged result stays globally
  unique. `sptCore()` takes an optional 5th `segCtx` (`{labels,areaMin,areaMax}`) parameter
  selecting `linkTracksPerCell()` over the plain `linkTracks()` call; `trackDiffusionCoeffs()`
  needed no changes — it already skips `track_id<0`. `runSptTrack()` only builds `segCtx` when
  **Apply segmentation?** is checked AND an image is actually loaded (falls back to plain
  whole-FOV tracking with a warning otherwise). `cell_id`/`cell_area [px]` become optional CSV/
  table columns exactly like `track_id`/`D_coeff`.
- **pipeline** — top-level orchestration wiring the UI buttons to the modules. Localize, drift
  correction and 3D calibration are each split into a DOM-free `*Core(config, stack, hooks)`
  function (`runCore`/`driftCore`/`calibrationCore`) plus a thin interactive wrapper
  (`run()`/`correctDrift()`/`runCalibration()`) that resolves DOM state into `config`, calls the
  core, then applies results back to globals/UI. `window.webSMLM.analyze(config)` — the headless
  entry point, v0.10.0 — calls the same cores directly with an explicit config and no DOM at all;
  `tools/webSMLM-cli.mjs` (Node + Playwright) drives `analyze()` from the command line, fully
  headless. New code belongs in the relevant `*Core` when it should also work headlessly (most
  analysis logic should); only DOM-reading/writing belongs in the wrapper. See
  `docs/DOCUMENTATION.md` §8 for the full headless API and `docs/REFACTOR_PLAN.md` for the design
  rationale (three-layer split: in-page API, CLI driver, URL-param autorun).

  **`makeNavigator(cv, nav)`** is the shared pan/zoom (drag/wheel/pinch/double-tap-to-fit) wiring
  for both the raw and SR canvases (Pointer Events, one code path for mouse/trackpad/pen/touch).
  **`trackDragDistance(cv)`** (v0.12.1-dev, right after `makeNavigator()`'s own definition) fixes a
  real, reported bug in every click-based multi-point tool riding the SAME canvas — raw-panel crop
  (`rawCropBtn`), and the SR panel's crop/measure/track-select (MODULE: table's own `cropBtn`/
  `measureBtn`/tracks-overlay click handlers): a browser still fires a native `click` event after a
  `pointerdown`→`pointermove`(drag)→`pointerup` sequence on the same element, no matter how far the
  pointer travelled in between — `makeNavigator()`'s own drag-to-pan does exactly that sequence.
  Without this, dragging to pan a zoomed-in view while one of those tools was armed silently planted
  a stray corner/point wherever the drag happened to end; repeated drags on the raw crop tool in
  particular could crop the stack down to a tiny sliver with each new "corner" chaining off the
  previous accidental one, with no way back short of reloading — the crop tool deliberately stays
  armed after a completed crop (see **in/out**'s own `makeCroppedStack()` paragraph), so a user
  reaching for a plain pan-drag next had no reason to expect this. `trackDragDistance(cv)` wires a
  SEPARATE, passive `pointerdown`/`pointermove` pair (alongside, not replacing, `makeNavigator()`'s
  own) purely to measure total on-screen movement since the last press; the returned `wasDrag()`
  (true past `CLICK_DRAG_PX`, 5 CSS px) lets each tool's own `click` handler bail out instead of
  treating the event as a genuine single-point click. `srWasDrag`/`rawWasDrag` are the two instances,
  checked at the very top of `$('sr')`/`$('raw')`'s own `click` listeners — a near-stationary press
  still measures near-zero distance, so an ordinary two-click crop/measure is unaffected.

  **Keyboard hotkeys** (`wireHotkeys()`, v0.11.9): holding **Alt** (Option on Mac) shows numbered
  hint badges over the 10 always-visible top-level action buttons (`HOTKEY_BUTTONS`, on-screen
  order); tapping the matching digit clicks that button. Adding **Shift** switches the hint set to
  `HOTKEY_SECTIONS`, the 10 collapsible sidebar `<details>` modules — the digit toggles that
  section's `.open` and, on open, scrolls to and `.focus()`es its `<summary>` so the next Tab press
  lands on the section's first input (a closed `<details>`'s descendants aren't in the tab order
  until `.open` flips true). Alt, not Ctrl — Ctrl+1..9 is already bound to browser tab-switching on
  Windows/Linux; being modifier-gated also means no focused-input guard is needed against the app's
  many free-typable numeric fields. Both digit lists are FIXED to on-screen position (a hint simply
  doesn't render for a disabled button or off-screen section, but the mapping never renumbers), so
  muscle memory (e.g. Alt+5 = Localize) stays valid regardless of app state. **Digit matching uses
  `e.code`, not `e.key`** — a real bug caught before release: macOS remaps `e.key` for the digit
  row while Option is held (Option+2 sends `"™"`, not `"2"`), so an `e.key`-based version showed
  hint badges but silently never fired on Mac; `e.code` (`"Digit1".."Digit0"`) is the physical key,
  unaffected by modifier-driven remapping. `.hotkeyHint` badges are a FIXED blue (`#0969da`) rather
  than `var(--accent)`, same "overlay stays fixed across themes" convention as raw-frame overlays
  and the tracks-colour legend. Known gap: on the mobile/floating sidebar drawer (collapsed by
  default), Alt+Shift+N still opens the target `<details>` underneath, just invisibly until the
  drawer itself is shown.

  **Alt+T** (reported — "link the terminal to the shortcut harness", either Shift state) focuses
  `#logTerminal` directly, checked via `e.code==='KeyT'` BEFORE the digit lookup rather than through
  `HOTKEY_CODES`/`HOTKEY_BUTTONS`/`HOTKEY_SECTIONS` — it's one fixed binding (focus the terminal), not
  a 10-item, on-screen-position-indexed list like those two. Gets its own hint badge too (`addHint()`,
  factored out of `showHints()`'s per-target loop so both call sites share it), shown alongside
  EITHER digit set since Alt+T isn't itself Shift-gated.

  **Load movie/data** (`loadBtn`) is one button over ONE hidden `#file` input whose `accept` lists
  `.tif,.tiff,.nd2,.csv` together. Dispatch is by file EXTENSION alone (`/\.csv$/i`) — real content
  sniffing for the movie side (`isTiffFile()`/`isNd2File()`) still happens downstream, inside
  `loadMovieFiles()`'s own `loadTiffFilesAuto()`/`loadTiffFile()` call chain. `loadMovieFiles
  (fileList)` and `loadCsvFile(file)` are named functions the combined handler dispatches to. A
  selection mixing a CSV with movie file(s) is refused outright with a logged error, rather than
  guessing via file count or order. An all-CSV selection with more than one file warns (doesn't
  block) and loads only `files[0]`.

  **`analyze()`'s `config.file` now also accepts a `.csv`** (v0.11.13, same extension-only
  dispatch), parsed via `parseCsvLocs()` instead of `loadTiffFile()` — Localize/crop/
  `estimateGainOffset`/calibration are all skipped (no raw pixel data to act on), but everything
  downstream (`sSmlmPair`/`correctDrift`/`computeNeNA`/`computeFRC`/`sptTrack`/export/render) runs
  unchanged, since none of those `*Core()` functions ever took a `stack` to begin with — only
  `locs`/`pxnm`. `timings` comes back `null` (no Run to time); `tools/webSMLM-cli.mjs` handles that
  (a real, previously-crashing gap — its own summary line unconditionally read `timings.runMs`).
  `loadCsvFile()` now calls `logCmd()` too, matching `loadMovieFiles()`'s own convention — until
  this, a CSV load was the one **Load movie/data** path that recorded no command at all, a real,
  reported gap (spotted from the log output itself: prose with no command line above it) that also
  happened to be genuinely justified before this — there was no headless equivalent to record.

  `config.exportPlots` (also `--exportPlots`/`exportPlots=1`) renders whichever of drift/NeNA/FRC/
  PCFO/calibration were actually computed this call into `result.plots`, each a `{pngDataUrl,
  svgText}` pair — reuses **render**'s `renderPlotBothFormats()`/`_plotTarget` redirection (the
  same mechanism "Save plot/image" uses interactively), so no visible browser window is needed.
  `drawNenaPlot(res)`/`drawFrcPlot(r)` already take an explicit result parameter; `drawDriftCurve()`
  /`drawPcfoPlot()`/`drawCalibration()` don't (they read module-level globals) — three small
  `render*PlotHeadless()` wrappers stash the real global(s), call `renderPlotBothFormats()`, then
  restore them. `calib`'s wrapper specifically must live OUTSIDE `analyze()`'s own body: `analyze()`
  declares its own local `let calib=null` shadowing the module-level one `drawCalibration()` reads.
  The calibration plot needs a FRESH build this call — a bare `calibrationJson` only carries the
  derived model, not the point cloud the plot needs. The raw frame/reconstruction are never
  included (no vector form at real localization counts); the line-profile plot (a user-drawn line)
  has no headless equivalent.

  **`config.exportHistograms`** (`string[]`, also `--exportHistograms photons,sigma,bg` — comma
  -separated, no spaces) covers the "no headless equivalent" gap for the shared column histogram:
  since `computeHist()`/`drawHistogram()` already takes an explicit `vals` array (no table/DOM
  state needed), `renderHistogramPlotHeadless(col, vals, unit)` stashes `histData`/`histView`
  (which `computeHist()` itself sets), computes the requested histogram, renders via
  `renderPlotBothFormats(drawHistogram)`, then restores prior state. A separate flag from
  `exportPlots`, usable with or without it, with an explicit column LIST (not a fixed default set).
  Results land in `result.plots` as flat `hist_<column>` keys (not a nested `plots.histograms`
  object), so `tools/webSMLM-cli.mjs`'s already-generic `writePlots()` needed zero changes.
  `x`/`y`/`z`/`dist`/`sigma`/`sigma_x`/`sigma_y` convert to nm before histogramming (matching the
  CSV/table convention); every other column histograms as-is. A column that's absent or entirely
  non-finite logs a warning and is silently skipped, not a hard error.

  **`config.exportTrackData`/`exportSSmlmCandidates`/`exportCalibrationPoints`/`exportPcfoTiles`**
  (v0.11.10, `docs/DOCUMENTATION.md` §8 has the full schema) stream a per-record dataset too
  large/detailed for `analyze()`'s own return value — a per-track MSD-vs-lag curve, an sSMLM
  candidate pair, a calibration bead point, a PCFO tile point — through a new
  `config.onRecord(kind, batch)` hook in bounded batches (`makeRecordEmitter()`, 2000/batch), never
  accumulated in-page or put on the return value (which crosses the DevTools Protocol as one JSON
  blob when CLI-driven — exactly why `pcfo.pts`/`sSmlmPair.locs` are already trimmed out of
  `tools/webSMLM-cli.mjs`'s own return handling). `sptCore()`/`pairCore()`/`calibrationCore()`/
  `pcfoCore()` each accept the matching flag + `hooks.onRecord`; `computeEnsembleMsd()` (MODULE:
  spt) now also returns `perTrackMsd` (`Map<track_id,[{lag,tamsd}]>`) for exactly this — previously
  computed then discarded once pooled into the ensemble mean. `tools/webSMLM-cli.mjs` is the
  reference consumer: `--exportTrackData`/etc. forward `onRecord` via the SAME live `console.log()`
  channel `onProgress`/`onLog` use, appended to a per-kind `.ndjson` file via
  `fs.createWriteStream()`.

  **The Log window is also an interactive JS terminal** (`#logTerminal`, a `<textarea>` row directly
  below `#log`) — since every action already logs a directly-runnable `analyze({...})` call, the
  natural next step is to let one actually be typed, pasted, or recalled and RUN, with the session
  redrawing as a result. `logHistory` gains a third entry kind, `{type:'term', text}`, rendered by
  `formatLogEntry()` with a fixed `> ` prompt prefix — always JS, independent of `logCmdStyle`
  (`{type:'cmd'}`/`{type:'log'}` still switch between JS/CLI style and `//`/`# ` comment markers as
  before). Enter runs the current text via `runTerminalStatement()`; Shift+Enter inserts a literal
  newline; ArrowUp/Down — only when the cursor sits on the textarea's own first/last line, so normal
  cursor movement inside a multi-line draft is untouched — walk `terminalHistoryList()`, which
  combines every logged `{type:'cmd'}` entry (via the existing `jsCommandFor()`, always JS form
  regardless of the current `logCmdStyle`) with every past `{type:'term'}` entry, so ANY interactive
  action's own logged command — a Localize, a committed filter, a crop — is recallable and editable
  here too, not just prior terminal input; a bash-style live-draft slot is preserved so Down past the
  newest entry restores whatever was being typed before Up was first pressed.

  `runTerminalStatement(text)` uses the same two-attempt strategy Node's own REPL uses: probe
  whether `text` parses as a single expression via a `new Function('return (...)')` syntax-only
  check (never executed); if it compiles, wrap as `return (\n${text}\n)` so the expression's value is
  captured, else fall back to running `text` as a plain, unwrapped body (only an explicit `return`
  inside then captures anything). The actual runner is built via `eval()`, not `new Function` —
  webSMLM is one single top-level `<script>` (no modules/IIFEs wrapping the whole file), so a direct
  `eval()` call placed inside a function declared there shares that function's full lexical scope
  chain, seeing every module-level `let`/`const` (`lastResult`, `stack`, `PARAMS`, `_tableFilters`,
  …) in addition to `window`-attached names (`analyze`, `paramValue`, …) — `new Function` alone would
  only ever see the latter. Wrapped in an async IIFE so a bare `analyze(...)` call is auto-awaited
  without the user needing to type `await` themselves. A `{type:'term'}` entry is pushed to
  `logHistory` regardless of success or failure, so a bad statement stays recallable to fix, same as
  a real shell.

  **`applyHeadlessResultToSession(result)`** is the actual "redraw" bridge, new because `analyze()`
  itself is deliberately DOM-free (the exact function the CLI drives) and nothing previously took its
  result and pushed it into the live UI. Mirrors `loadCsvFile()`'s own reset/set/enable sequence
  almost line-for-line: resets `srFull`/`srSpots`/`srLocs`/measure/crop/drift/NeNA state and
  `_tableFilters`, sets `lastResult={locs,w,h,px,mag,det:null}` (the same minimal shape a CSV or
  smFRET SOI result already uses), calls `setFrameAspect()`+`rerender()`, and re-enables
  Save/Table/drift/NeNA/FRC/sSMLM/spt buttons. **Explicitly nulls the module-level `stack`** even if
  an unrelated movie was loaded earlier this session — `analyze()`'s own `stack` is a function-local
  variable that never touches this global (the same shadowing gotcha `smfretSOICore()`'s
  `checkStack` fix already ran into elsewhere in this codebase), so leaving a stale one in place could
  let the raw panel scrub through footage that doesn't even match the new result. Same "no live raw
  frame data" contract a loaded CSV already has. Deliberately does **not** auto-wire
  `result.drift`/`nena`/`frc`/`spt`/`sSmlmPair` into their own dedicated interactive globals/plots —
  each has its own global + redraw function + button-enable logic, and wiring all of them is a
  separably bigger follow-up; the full `result` is still inspectable from the terminal itself.

  **`_terminalFileRegistry`/`registerTerminalFile()`/`resolveTerminalConfig()`** (reported —
  the single most obvious recall-and-edit workflow, "Localize again with a different pxnm," failed
  outright) fix a real gap the terminal's own file-bearing recall otherwise always hits: a logged
  `file:`/`calibrationFile:`/`segmentationFile:`/`files:`/`calibrationFiles:` value is always a bare
  display STRING (`loadMovieFiles()`'s own comment already documented why — browsers never expose a
  real filesystem path), but `analyze()` hard-requires an actual `File`/`Blob` for every one of these
  keys, so recalling a logged Localize/segmentation/CSV command verbatim and pressing Enter threw a
  confusing low-level error (`f.slice(...).arrayBuffer is not a function`) three call-frames deep
  inside `analyze()`, not something a user typing into a terminal should ever have to decode.
  `registerTerminalFile(f)` is called at every point a real File actually enters the app —
  `loadMovieFiles()` (all selected files, not just `fs[0]`), `segFile`'s change handler, and
  `loadCsvFile()` — building a session-scoped filename→File map. `runTerminalStatement()` declares a
  LOCAL `const analyze = cfg => window.webSMLM.analyze(resolveTerminalConfig(cfg))` right before
  its own `eval()` call, so — by the same direct-`eval()`-sees-the-enclosing-scope mechanism the
  function's own comment already explains — the evaluated text's free `analyze` reference resolves to
  this shadowed version instead of the real top-level one, transparently substituting a matching
  registered File back in by name (and registering any real File/Blob passed directly, so a file
  first used FROM the terminal is itself recallable next) before delegating to the real `analyze()`.
  A name with no match throws a clear, actionable error naming the missing filename and how to fix it,
  rather than the raw type error. Verified via Playwright against the exact reported scenario: load a
  real file interactively, arrow-up in the terminal to recall its logged `analyze({file:"…",...})`
  command, edit `pxnm`, press Enter — now runs and updates `lastResult.px`, where it previously threw.

  **`_lastTerminalFile`** (reported — recalling and re-running a crop-only command threw
  `config.file (or config.files) is required`) covers the OTHER recall gap the same bug report
  surfaced: most `logCmd()`'d actions — a committed filter, the crop tool, a Localize run — never
  include `file:` at all, by design (a curated snapshot of just what THAT action changed, the same
  convention documented at every one of those call sites), so recalling one of THOSE alone has no
  `file:` key present for `resolveTerminalFileValue()` to substitute into in the first place — the
  string-substitution mechanism above doesn't fire when the key is simply missing. A plain
  last-write-wins variable, not "last entry in `_terminalFileRegistry`'s iteration order" — `Map.set()`
  on an EXISTING key does not move it, so the map alone can't answer "most recently used."
  `resolveTerminalConfig()` falls back to it whenever `file`/`files` is absent entirely (and
  `config.calibrationOnly` isn't set, since a calibration-only run legitimately has no movie file),
  so re-running "just a crop" or "just a filter" from the terminal now acts on whatever's currently
  loaded — the same behavior the interactive crop tool/filter box already have, no file re-selection
  needed. Verified via Playwright: `analyze({cropX0,cropY0,cropX1,cropY1,pxnm})` with no `file:` key,
  run right after loading a real file interactively, now succeeds and redraws instead of throwing.

  **`pxnm`/`frametime` now live in exactly ONE logged command — "Load movie/data"** (reported;
  reworked twice — a first attempt removed them from the Load command specifically, which was
  backwards, then corrected). `loadMovieFiles()`'s own `logCmd({file:fs[0].name, pxnm, frametime})`
  is the session-establishing declaration of what this file's own pixel size/frame time actually
  are — exactly what a CLI/`analyze()` user reproducing the load from scratch needs — so it KEEPS
  both fields (`loadCsvFile()`'s equivalent Load-shaped command keeps them too). Every OTHER logged
  action was changed to drop them instead: `correctDrift()`, `computeNeNA()`/`computeFRC()`,
  `estimateGainOffset()` (PCFO), `runCalibration()`, `locateSmfretSOI()`, `runSSmlmPair()`/its
  preview, `runSptTrack()`, the SR-panel crop tool, and — yes, this one too — `run()`'s own Localize
  command. Restating a session-wide constant on every single derived action was pure redundancy, and
  each restatement was its own separate stale-snapshot risk if `pxnm` was corrected in between two
  actions.

  This alone would have reintroduced the ORIGINAL staleness bug for every one of those OTHER
  commands (a pxnm-less Localize/crop/etc. command, recalled and run standalone via the terminal,
  would otherwise fall through to `analyze()`'s own fixed `PARAMS.pxnm` default — 100nm — not
  whatever's actually set right now). Fixed at the terminal layer instead of by re-adding `pxnm` to
  every action: **`resolveTerminalConfig()`** (renamed from `resolveTerminalConfigFiles()`, since it
  now does more than files) backfills `config.pxnm`/`config.frametime` from the LIVE
  `paramValue('pxnm')`/`paramValue('frametime')` whenever a terminal-run statement's own config
  omits them — never from the PARAMS default. An explicit `pxnm:200` typed into the terminal still
  wins (the backfill only fills a key the statement itself left out). This is deliberately
  terminal-only — the CLI/a fresh headless `analyze()` call has no "current session" to fall back
  on, so `pxnm`/`frametime` still need to be explicit there, same as always. Verified via Playwright:
  load a file (Load command logs `pxnm:100`), correct pxnm to 160 interactively, run Localize
  (its own logged command has no `pxnm`, `lastResult.px===160`), recall that exact command in the
  terminal and press Enter with no edits (`lastResult.px` stays `160`, not reset to 100), then edit
  in an explicit `pxnm:200` (`lastResult.px` becomes `200`).

  **Generalized to EVERY `PARAMS` field, not just `pxnm`/`frametime`** (reported, same round — a
  crop-only command recalled from the terminal, per the paragraph above, still ran a full Localize
  since `analyze()` always does load→detect/fit→… in one shot; the crop tool's own `logCmd()` never
  carried `method`/`psf`/threshold/etc. either, so that Localize silently used GENERIC `PARAMS`
  defaults — a wavelet/phasor mismatch, wrong `psf`, wrong threshold — producing a confusing,
  unrepresentative result instead of an error). `resolveTerminalConfig()`'s pxnm/frametime-specific
  lines were replaced by one loop, `for(const id in PARAMS){ if(out[id]===undefined) out[id]=
  paramValue(id); }` — since `pxnm`/`frametime` are themselves `PARAMS` entries, this single loop
  subsumes the earlier special case rather than sitting alongside it. Every action's own curated
  `logCmd()` (crop, drift, NeNA/FRC, PCFO, calibration, sSMLM, spt) only ever records the handful of
  fields THAT action changed — by design, see `logCmd()`'s own comment — precisely because each was
  meant to run alongside whatever the rest of the session is already configured to; the terminal is
  what actually exercises that assumption now that these are directly runnable standalone. Non-PARAMS
  directive keys (`cropX0`, `calibrationOnly`, `tableFilters`, `correctDrift`, …) are untouched, since
  they were never in `PARAMS` to begin with. **A crop-only command still always re-runs Localize —
  this doesn't change**: `analyze()` has no "crop only, skip detect/fit" mode headlessly, by design;
  use the interactive raw-panel crop tool (`rawCropBtn`) directly for a crop with no analysis attached.
  What changed is that when a recalled/typed command DOES trigger a Localize, it now uses the real,
  currently-configured method/psf/threshold/etc., not arbitrary defaults. Verified via Playwright:
  configured `method:'phasor'`, `psf:2.1` interactively, ran a crop-only `analyze({cropX0,...})` from
  the terminal, confirmed the actual resolved config (`result.settingsText`) has `method:"phasor"`,
  `psf:2.1` — not the registry's own defaults.

  Documented, deliberate v1 scope boundaries: the terminal executes **JS only** (a CLI-style logged
  line won't run here — switch `logCmdStyleBtn` to JS first if pasting from an exported log); pasting
  a whole multi-command block runs each call independently in sequence, so an early bare command that
  references a real File `resolveTerminalConfig()` genuinely can't resolve (a filename no longer
  registered this session, or a calibration/segmentation file never loaded at all) throws and stops
  the block there — the intended per-command workflow is arrow-up → recall → edit → run one statement
  at a time, not a batch replay; and running arbitrary code via `eval()` in the page's own scope is
  consistent with this project's own established threat model (a trusted, single-file, fully
  client-side tool with no server, no other users, no credentials at stake) — the same reasoning
  already backing the CLI/headless `analyze()` surface itself.

  **Full GUI/terminal parity** (reported — after being pointed at `applyCropToRaw()` as the fix for
  "why did a crop-only `analyze()` call also run a full Localize", the user's generalized ask: EVERY
  actionable GUI control should have a plain, terminal-callable function behind it, discoverable, not
  reverse-engineered). A 3-way parallel codebase audit found this was **already true for the large
  majority of actions** — the whole `*Core()`/thin-wrapper split this module is built around already
  means most button handlers are just `addEventListener('click', someTopLevelFunction)`, and the
  terminal's direct `eval()` sees every one of those names via the shared top-level scope. Only 9 real
  gaps existed, where a button's actual logic was still inline in an anonymous listener closure with
  no named equivalent — each extracted into its own top-level function (pure, behavior-preserving
  refactor, verified via Playwright both for the unchanged interactive path and the new direct
  terminal call): `loadFiles(fileList)` (the merged `#file` CSV/movie dispatcher), `loadCalibrationJson
  (file)`/`loadSettingsJson(file)` (same `async function loadX(file)` shape as the pre-existing
  `loadCsvFile`/`loadSegmentedImage`), `runSimulation()` (Simulate movie's full disable→generate→
  reset→re-enable sequence around the already-pure `generateSynthetic()`), `clearCalFixedXY()` (Fix
  bead x,y's uncheck branch — the check branch already called `locateBeadsForCalib()`),
  `commitSrCrop(x0nm,y0nm,x1nm,y1nm)` (the SR-panel crop tool's crop-commit branch, extracted out of
  `$('sr')`'s multi-purpose click handler — which keeps its own `cropPt0` two-click bookkeeping and
  now just converts px→nm before calling this; **nm**, not px, matching what the tool itself logs/
  displays — a genuinely different mechanism from `applyCropToRaw()`, see this module's own crop-tool
  paragraph), `toggleSSmlmColorView()`, `clearSmfretFixSOI()`, `toggleSmfretTraceMode()`. No naming
  collisions with anything already in the file.

  **`logCmd(config, jsOverride)`** (follow-up, same round, reported — the raw-panel crop tool's own
  logged `analyze({cropX0,...})` command, recalled and run from the terminal, re-ran a full Localize
  instead of reproducing the crop-only action `applyCropToRaw()` itself actually took). `logCmd()`
  gained an optional second `jsOverride` argument — literal JS text shown/recalled/run instead of
  `jsCommandFor(config)` in JS style (`formatLogEntry()`'s `'cmd'` branch and `terminalHistoryList()`
  both check it); CLI style always falls back to the ordinary `config`-as-flags rendering regardless,
  since the CLI only ever drives one-shot `analyze()` calls with no equivalent to fall back to either
  way. `applyCropToRaw()`'s own call was the first to use it.

  **The underlying pattern, once actually audited (reported again — "gain & offset estimation still
  in analyze?", after the user noticed the exact same smell in a DIFFERENT logged command): crop
  wasn't the only exception, it just happened to be the one first reported.** `analyze()`'s per-frame
  Localize step is UNCONDITIONAL — it always runs (the main branch, `else` from `smfretLocateSOI`'s
  own exclusive branch, itself only skipped for a `.csv`/`calibrationOnly` input) — and every one of
  `config.estimateGainOffset`/`correctDrift`/`computeNeNA`/`computeFRC`/`sSmlmPair`/`sSmlmPreview`/
  `sptTrack` is evaluated either right before it (PCFO, overriding gain/offset for the Localize that
  follows) or right after it (everything else, operating on whatever `locs` that same call's own
  Localize just produced) — `analyze()` has NO way to run any of them in isolation. But the
  INTERACTIVE buttons for every one of these — `estimateGainOffset()`, `correctDrift()`,
  `computeNeNA()`, `computeFRC()`, `runSSmlmPair()`, `previewSSmlmPairs()`, `runSptTrack()` — all
  REQUIRE an existing `lastResult` and never Localize anything themselves. Recalling any of their
  own logged `analyze({...})` commands from the terminal was silently ALSO re-Localizing the whole
  stack — for PCFO specifically (a single click that only ever estimates and plots, never applies
  the estimate or Localizes on its own) this wasn't just wasteful, it was a completely different,
  much slower, surprising outcome. All seven gained the same `jsOverride` fix, pointing at their own
  already-terminal-callable, no-arg, reads-live-state function (`estimateGainOffset()`,
  `correctDrift()`, `computeNeNA()`, `computeFRC()`, `runSSmlmPair()`, `previewSSmlmPairs()`,
  `runSptTrack()`) — the same "plain top-level function reads live session state" shape every one of
  these already had, from the earlier full-parity audit; only the LOGGED command needed fixing, not
  the functions themselves.

  `commitSrCrop()`'s own `logCmd({tableFilters:...})` call deliberately does NOT get one, despite
  superficially the same shape of problem — its config is the FULL CUMULATIVE filter list (by design,
  see MODULE: table), and a `commitSrCrop(...)` override would only know about its own single
  rectangle, silently dropping any other active filter; re-running via `analyze({tableFilters:[...]})`
  is slower (a redundant re-Localize) but not actually WRONG the way the other eight mismatches were —
  a genuinely different failure mode, not the same bug.

  **Of the three "does the interactive action Localize?" siblings that come to mind here, only ONE
  actually has this bug** — corrected after initially over-claiming all three did (reported: "I don't
  understand, loadCsvFile()/runSimulation() never Localize"):
  - **`loadCsvFile()`** — NOT affected, full stop. `analyze()` branches on the file extension
    (`isCsv`) BEFORE the Localize code is even reached: a `.csv` input parses locs directly and
    returns, never calling `runCore()` at all (see §8: "method/crop/estimateGainOffset/calibration
    options don't apply to a CSV input"). Recalling `loadCsvFile()`'s own logged
    `analyze({file:"x.csv",...})` command is already exactly faithful — nothing to fix.
  - **`runSimulation()`** — not applicable at all: it has no `logCmd()` call (Simulate movie logs
    nothing) and `analyze()` has no `config.simulate`-equivalent flag in the first place, so there's
    no recalled command for this mismatch to even apply to.
  - **`loadMovieFiles()`** — the one real case: a genuine TIFF/ND2 `config.file` DOES take the `else`
    branch, which unconditionally Localizes after loading. And to be precise about HOW MUCH it
    Localizes (asked directly, reported): NOT just the first frame — `fitFirstFrame`/`fitLastFrame`
    default to `1`/`Infinity` (§3), so a bare recalled `analyze({file:"movie.tif"})` Localizes the
    ENTIRE stack, exactly as much work as a full interactive Localize click. "Dynamic" loading only
    means frames are decoded on demand as the stack is read (in/out module) — it has no bearing on
    how much of the stack a SUBSEQUENT Localize step touches.

  **`loadMovieFiles()`'s own case is now fixed too** (follow-up, same round — "that would lead to
  minutes of time passing for large files" was a fair objection to leaving this one unfixed). The
  earlier obstacle was real: the natural override target (`loadFiles(fileList)`, the already-exposed
  parity function) takes a real `File`/`FileList`, and calling it directly from the terminal did NOT
  go through `resolveTerminalConfig()`'s own file-string-resolution (that wrapper only intercepted
  calls made through the shadowed `analyze` identifier), so a naive string-based `jsOverride` would
  have reintroduced the exact "bare filename can't be read from disk by browser JS" bug
  `resolveTerminalConfigFiles()` was built to fix in the first place, just at a different call site.
  Fixed properly instead of left as a gap: `runTerminalStatement()` now ALSO shadows `loadFiles`,
  `loadCsvFile`, `loadCalibrationJson`, `loadSettingsJson`, and `loadSegmentedImage` (every remaining
  terminal-facing function that takes a File/FileList), each wrapped to resolve a filename STRING back
  to the real File via `resolveTerminalFileValue()` before delegating to the real function underneath.
  Each real function is a top-level `function` declaration, so it's ALSO reachable as `window.<name>`
  — the wrappers call it that way, not by its bare identifier, since a `const` of the SAME name later
  in `runTerminalStatement()`'s own body puts that identifier in the temporal dead zone for the ENTIRE
  function, including lines textually before the `const` — referencing the bare name to get "the
  original" wouldn't work, only `window.<name>` reaches it. `resolveTerminalFileValue()`'s own second
  parameter was renamed `label` (from `key`) and its error message's `config.` prefix dropped, since
  it's now called both from `resolveTerminalConfig()` (a real config field) and from these bare
  function wrappers (no config object involved) — each call site now passes whatever `label` actually
  fits (`config.file` vs. plain `loadFiles()`). `loadMovieFiles()`'s own `logCmd()` gained the matching
  `jsOverride`: `` `loadFiles(["${fs[0].name}"])` `` — no `pxnm`/`frametime` in the override itself
  (those aren't `loadFiles()` arguments, just independent sidebar settings, still recorded in the
  CLI/JS-style `config` form above it for reference). Verified via Playwright: recalling the Load
  command after a real Localize now completes in single-digit milliseconds and leaves `lastResult`
  `null` (a genuine load-only replay, not a redundant multi-second-to-multi-minute re-Localize), a
  subsequent real Localize afterward still works normally, and an unresolvable filename still throws
  the same clear, actionable error the `analyze()` path already had.

  Verified via Playwright for all seven newly-fixed actions: recalling each one's own logged command
  from the terminal after an initial Localize leaves `lastResult.locs.length` UNCHANGED (confirming no
  redundant re-Localize happened) and correctly re-runs just that one action. The original crop case
  (`applyCropToRaw(x0,y0,x1,y1)` in JS style, unchanged `--cropX0 ...` flags in CLI style) still holds.

  Documented as an actual reference table in `docs/DOCUMENTATION.md` §1 (right after the terminal's
  own paragraphs) — GUI label → terminal function → notes, covering these 9 plus the ~25 actions that
  were already clean (`run()`, `correctDrift()`, `runCalibration()`, `computeNeNA()`/`computeFRC()`,
  `estimateGainOffset()`, `runSptTrack()`, `runSSmlmPair()`, `locateSmfretSOI()`,
  `getSmfretTimeTraces()`, `applyCropToRaw()`/`uncropRaw()`, `exportCSV()`, `rerender()`, …) —
  explicitly calling out `analyze({file,...})` as the *separate*, one-shot, no-session CLI/scripting
  tool, not the "do exactly what one button does" one. **Standing convention going forward** (a new
  short rule, not just a one-time cleanup): every future actionable GUI control's real logic belongs
  in a plain top-level named function, never inline in an anonymous listener — so it's automatically
  terminal-callable with no separate "make it scriptable" step, ever again. This is the actual answer
  to "GUI and commandline support should be interchangeable": not a parallel API surface to keep in
  sync by hand, but a rule that guarantees there's only ever one implementation per action.

  **`_sessionEpoch`/`newEpoch()`/`staleEpoch()`** (follow-up, same round, requested: "everything
  should be as bulletproof as possible") — a real async race the parity work above made newly easy
  to hit: interactively, `applyCropToRaw()`'s own button is disabled for the whole duration of an
  in-flight Localize/drift/etc. (a DOM attribute, not a real reentrancy guard), so a user physically
  cannot click Crop mid-Run — but the terminal calls the SAME function directly, bypassing that
  DOM-only protection entirely. Confirmed via Playwright: fire Localize, wait only for its FIRST
  mid-run preview (`lastResult.locs.length` truthy — not the same as the run actually finishing),
  then call `applyCropToRaw()` from the terminal — the crop correctly nulls `lastResult`, but the
  STILL-RUNNING original `run()` later reaches its own completion and silently overwrites
  `lastResult` right back with the stale, pre-crop full-dataset result. Generalizes the exact
  "detect and discard a stale async completion" principle `rerender()`'s own `_srRenderSeq`/`mySeq`
  already uses (MODULE: render) into one shared, monotonic epoch counter (declared next to
  `lastResult` itself, MODULE: in/out) that EVERY long-running, state-writing action now
  participates in: `run()`, `correctDrift()`, `runCalibration()`, `runSptTrack()`, `runSSmlmPair()`,
  `locateSmfretSOI()`, `getSmfretTimeTraces()`, `estimateGainOffset()`, `loadMovieFiles()`,
  `loadCsvFile()`, `runSimulation()`, `applyCropToRaw()`, `uncropRaw()`, and the log terminal's own
  `analyze()`-result bridge. Each captures `const myEpoch=newEpoch()` right after its own
  preconditions, then checks `staleEpoch(myEpoch)` immediately before every later write to shared
  state — especially the first thing after an `await` — bailing out (discarding its own result
  entirely) if a NEWER action has bumped the epoch again in the meantime. `getSmfretTimeTraces()`'s
  own per-frame loop (previously the only one of these with no cancellation of any kind) also checks
  it INSIDE the loop at its existing yield point, stopping early rather than continuing to compute
  toward a result that's about to be discarded.

  **Deliberately does NOT try to force the superseded operation to stop early** — no wiring through
  the existing `stopRequested` flag (`shouldStop()`, the Stop button's own signal). That would need a
  fragile, timing-sensitive dance (toggle true then back to false, with a yielded tick in between so
  the older run's own already-scheduled continuation actually observes it before it flips back) to
  reliably interrupt something that might already be past its next check — and even then wouldn't be
  guaranteed. Letting a superseded action keep computing in the background and simply discarding its
  result is simpler and just as correct for the actual concern (data-integrity, not wasted CPU on an
  abandoned run).

  **Deliberately does NOT epoch-guard each function's own button-enable/`finally` cleanup** either —
  tried first for `run()`/`correctDrift()`, then reverted: a superseding action doesn't necessarily
  manage the SAME button set as the one it superseded (a crop doesn't touch `driftBtn`, for
  instance), so suppressing a stale operation's own re-enable on top of an already-stale-guarded data
  write would leave that button stuck disabled forever instead — a worse failure mode than a button
  re-enabled a moment "early" relative to some unrelated newer action. `finally` blocks (or their
  equivalent) stay unconditional, exactly as before this change.

  Fixed two genuinely separate, PRE-EXISTING bugs found while doing this (not caused by the epoch
  work, just adjacent to it): `loadMovieFiles()` and `runSimulation()` each had no error-path cleanup
  at all — a load or a simulation that flat-out FAILED (a corrupt file; `generateSynthetic()`
  throwing) left every button either function disables at its own top stuck disabled forever, since
  neither had a `catch`/`finally` that re-enabled them. Fixed by re-enabling directly in each
  function's own `catch` block (not a shared `finally` with the new staleness bail-outs above — an
  ERROR means nothing else is going to fix this, so it must always run; a STALE-but-successful return
  correctly defers cleanup to whatever superseded it, per the paragraph above).

  **`applyCropToRaw()`/`commitSrCrop()` gained real input validation** (follow-up, same round,
  reported — `applyCropToRaw(4000, 397, 667, 596)` was reported as "Crop region too small (min 8×8
  px)", which is technically true of the raw `x1-x0` arithmetic (`667-4000=-3333<8`) but has nothing
  to do with the REAL problem: an INVERTED region (`x1<x0`), not a small one). Both functions'
  interactive callers (the raw-panel/reconstruction-panel click handlers) always hand in correctly-
  ordered, in-bounds corners by construction (a click maps to a real canvas pixel; both handlers
  already take the min/max of the two clicks themselves) — this validation gap was invisible until the
  terminal made it possible to pass ARBITRARY numbers directly. `applyCropToRaw()` now checks three
  genuinely different failure modes with three distinct messages, in order: (1) `x1<=x0||y1<=y0` —
  "Invalid crop region: x1 (…) must be greater than x0 (…), …"; (2) out of bounds against
  `originalStack||stack` (the TRUE original the crop coordinates are always relative to, not a
  possibly-already-cropped `stack`) — "Crop region … is out of bounds for the W×H stack"; (3) the
  pre-existing, still-valid "too small (min 8×8 px)" check, now only reachable once (1) and (2) have
  already ruled out the other two causes. `commitSrCrop()` gets the matching `x1<=x0||y1<=y0` guard —
  its own failure mode without one is milder (no crash, `r.x>=x0&&r.x<=x1` for an inverted region can
  never be true, so it would just silently commit a filter matching zero rows) but just as confusing,
  so it's caught explicitly too rather than left to fail silently. No out-of-bounds check added there
  — `commitSrCrop()` takes nm bounds against `lastResult`'s own reconstruction, a softer failure mode
  (an out-of-range filter just matches fewer/zero rows, not a crash) not worth the added complexity of
  converting nm to native px via `lastResult.px/lastResult.mag` just to bounds-check it. Verified via
  Playwright: the exact reported inverted-x case, a genuinely out-of-bounds region, a genuinely
  too-small region, and a valid crop all produce the correct distinct outcome.

  **Terminal/log parity round 2** (reported: "it would be great if... the submitted parameters are
  displayed", plus "check all buttons" — a fresh, independent audit). A real gap in the mechanism
  itself, not a per-action one: a `jsOverride` action (`estimateGainOffset()`, `runSptTrack()`, …) is
  a bare no-arg call reading live session state, so JS-style log output showed NOTHING of what it
  actually used — only CLI style ever rendered `config` (as `--flags`). **First attempt**: extract
  `jsCommandFor()`'s own `key:value` filter/map logic into a shared `configBody(config)` and have
  `formatLogEntry()` prepend it as a `//`-comment above the override. Shipped, then superseded same
  day on direct follow-up: a separate comment still means copying values BY HAND into a fresh call —
  the actual ask was "rerun the function from the terminal without much copy paste and just by using
  the arrow up or down keys to select and edit." **Final design**: `overrideWithFields(config, call)`
  (next to `configBody()`) makes the override itself self-contained and directly editable — for every
  `config` key that names a REAL sidebar field, it prefixes `call` with a `$('id').value=...` (or
  `.checked=...` for a checkbox) assignment, e.g.
  `` $('pcfoFrames').value=200; $('pcfoK').value=0.9; $('pcfoRnstd').value=2.89; estimateGainOffset() ``
  — recalling this (↑) loads the WHOLE line into the terminal box already editable; change a number,
  press Enter, done. A key with no matching element — a bookkeeping marker like
  `estimateGainOffset:true`, the crop tool's own local `cropX0`/etc. coordinates, a File's `.name` —
  is silently skipped: `$(k)` simply returns `null` for those, no marker-vs-real-value heuristic
  needed (the earlier comment-based design's own filtering headache, since a marker is always `true`
  but so is a legitimate boolean *setting* like `smfretApertureMode` when it's on — that ambiguity
  doesn't exist here, since the DOM itself is the source of truth for "is this a settable field", not
  the value). `<input type="file">` is skipped explicitly even though `$('file')` DOES resolve to a
  real element (the hidden file input shares that id) — browsers block setting a file input's value
  from script, and `loadFiles()` already takes the filename as a literal call argument instead
  (resolved via `resolveTerminalFileValue()`). Setting `.value`/`.checked` this way does NOT fire the
  field's own `change` listeners — exactly what's wanted, since the trailing `call` is what actually
  runs the action once, with the just-set values already in place, the same "set the field, then call
  the action" idiom `sptLocErrorFromNenaBtn`'s own programmatic `$('sptLocError').value=...` write
  already relies on. `formatLogEntry()`'s own comment-injection branch is gone again — now redundant,
  since the values are already embedded in the runnable line itself; it's back to
  `` e.jsOverride || jsCommandFor(e.config) `` for JS style, unchanged from before round 2 started.
  `terminalHistoryList()` (↑/↓ recall) needed no changes at all across either attempt — it already
  reads `e.jsOverride` straight from the stored entry, so enriching what gets STORED (this round's
  actual fix) automatically enriches both the log display and the recall for free. Applied to every
  `jsOverride` call site uniformly (`logCmd(cmdCfg, overrideWithFields(cmdCfg, '...'))`), including
  ones where it's a provable no-op (`computeNeNA`/`computeFRC`'s marker-only config,
  `applyCropToRaw`'s own non-field crop coordinates) — cheap, and means a future config field added to
  any of them starts benefiting automatically with no second "remember to wire this" step.
  `loadFiles()`'s own override gained a small bonus from this uniform treatment: `pxnm`/`frametime`
  (real sidebar fields, unlike `file`) now get their own assignment prefix too, previously invisible
  in JS style entirely. `exportPanel()`'s call site is the one deliberate exception, left unwrapped —
  its config is a bare `{}` by design (`which` is already the whole story, embedded in the call
  itself), so wrapping it can never do anything.

  This one change improved every existing `jsOverride` site for free. The audit (an Explore agent
  reading all 84 `click` + 51 `change` listeners, cross-referenced against the 20 `logCmd(` sites,
  independently spot-verified before acting on it) found the rest genuinely needed fixing at their
  own call sites: **`runSimulation()`** (Simulate movie) called `logCmd()` nowhere at all — now logs
  the 11 simulation PARAMS fields with a `jsOverride` (same no-arg/reads-live-state shape as
  `estimateGainOffset()`, and `analyze()` has no `config.simulate` equivalent to fall back to either
  way). **`exportPanel()`** (Save plot/image's raw-frame/reconstruction PNG path — the PLOT path
  inside `exportPlotEither()` already logs for certain plot types) also logged nothing — now logs
  `` logCmd({}, `exportPanel('${which}')`) `` right after a completed save (not a cancelled one, same
  placement `exportPlotEither()` itself already uses) — an empty `config` is fine, `which` is already
  embedded in the override text itself (same convention as `applyCropToRaw(x0,y0,x1,y1)`), and CLI
  style's resulting empty flag list is an honest "no CLI equivalent" signal, matching that same
  precedent's own comment. **`locateBeadsForCalib()`** ("Fix bead x,y") and **`getSmfretTimeTraces()`**
  ("Get time traces") are both real detect/fit computations with real tunable params that never
  called `logCmd` — fixed the same way, reusing each function's own already-computed local variables
  (`sigma`/`mode`/`k` for the former, `sigma`/`gain`/`camoffset`/`useAperture` for the latter) rather
  than re-deriving them via a second `paramValue()` read. `locateBeadsForCalib()` logs on every
  auto-rerun too (a detection-setting tweak while the checkbox is on), matching `locateSmfretSOI()`'s
  own already-shipped precedent for the identical "average once, detect once" pattern.
  **`recomputeSptD()`** genuinely mutates `lastResult.locs[]`'s own `D_coeff` from live
  `frametime`/`sptLocError` (only on `change`, so this can't spam the log) — same fix. Also fixed a
  minor, unrelated standing-convention violation the same audit turned up: **`trackTableResetBtn`**
  had its reset logic inlined in the click listener (unlike its sibling `tableResetBtn`, which
  correctly calls the named `resetFilters()`) — extracted to `resetTrackTableFilters()`, which
  `commitTrackTableFilter()`'s own `'reset'`-keyword branch now calls too instead of duplicating it.

  **"Both windows"** (requested — the save-image picker only ever offered either/or): a third button
  in `saveImgModal` alongside the existing "Left window"/"Right window", wired to a new
  `saveBothPanels()` (`await exportPanel('raw'); await exportPanel('sr');`) — no `logCmd()` of its
  own; each `exportPanel()` call already logs its own accurate, independently-replayable command as
  it completes (two lines, not one opaque wrapper), avoiding a log-suppression flag threaded through
  `exportPanel()`/`exportPlotEither()` for a rarely-used path. Verified via Playwright: after
  Simulate movie (both panels already have content — the raw frame and the Data-projection
  reconstruction), calling `exportPanel('raw')` then `exportPanel('sr')` each produce their own
  correct `logCmd`, and `saveBothPanels()` runs both without error.

  Everything else the audit checked — spt's own view-refresh listeners, sSMLM histogram/marker
  listeners, render/theme/contrast settings, table sort/filter-chip removal, live-streaming controls,
  calibration method/`localize3D` UI-reveal listeners — was confirmed already correct: a pure view
  toggle, a persisted UI preference, or (live streaming's own Connect/Clear) an interactive-only
  action with no headless equivalent to record.

  **`runCore()`'s own timing-summary log lines are a fixed-width table** (one row per stage — `frame
  I/O`/`detect`/`fit`/`preview`/`other`, plus the worker-pool `↑ N workers...` utilisation line) —
  word-wrapping ANY of them mid-row (`wrapCommentLine()`'s own comment-wrap, unaware these are table
  columns) silently breaks the whole table's alignment, and on a real multi-ten-thousand-candidate
  Localize a few rows ran long enough to do exactly that (reported — "does not look great", plus a
  `not` immediately followed by `// compute` with no space, from a wrapped row's own two half-lines
  landing next to each other). Fixed at the root rather than by widening the wrap width: a new
  `compactCount(n)` (right next to `sec()`/`pc()`, `runCore()`'s own local helpers) renders large
  counts as `"42.2k"`/`"1.23M"` instead of `toLocaleString()`'s full grouped form, and the `fit`/
  `preview`/`other`/worker-utilisation lines' own prose was trimmed (`"kept"` replacing `"candidates
  → ... kept"`, `"µs/cand"` not `"µs/candidate"`, `"(SR/raw refresh, grows with locs)"` not the
  original's much longer parenthetical, `"↑ N workers, X% util. — CPU Xs vs. N×Ys wall (excl. FTM)"`
  not the original's `"X% utilisation on detect/fit (worker CPU ... excl. the separately
  barrier-phased FTM stage above)"`) — every row now stays comfortably under the `# `/`// ` marker's
  own 77-char budget (`wrapCommentLine()`'s `width=80` minus the marker) even at unrealistically large
  worker/CPU-second counts, verified via Playwright against a real, deliberately dense (400 frames,
  density 2) simulated Localize run (a real ~14k-candidate `fit` row, previously guaranteed to wrap,
  now a single unwrapped line) rather than just eyeballing hand-picked numbers.

  **`fit`'s own µs/candidate figure uses adaptive precision** (follow-up, same round, requested): a
  new `perCandStr(v)` (next to `compactCount()`) shows a whole number with no decimal once the value
  reaches double digits (`100.2`→`"100"`, a slow iterative fitter like MLE) but keeps one decimal
  below that (`6.5`, phasor's own much faster per-candidate time) — a fractional µs is noise once the
  figure itself is already 3 digits, but is the only thing distinguishing two single-digit values.
  Verified via Playwright with the same real simulated dataset run under both the default (slower)
  method and Phasor 2D — `32 µs/cand` and `6.5 µs/cand` respectively.

  **Four "save to file" actions recorded no command at all** (reported — "nothing in command line?"
  after Save settings' own prose-only log — a real gap the earlier "check all buttons" audit itself
  MISSED, having waved these off as "prose log is appropriate for an export action"): `exportCSV()`
  (Save data), `exportCalibration()` (Save calibration), `exportSptSummary()` (Save track data), and
  Save settings' own former inline handler. All four now `logCmd({}, '<name>()')` right after a
  completed save (not a cancelled one) — an empty config is fine, same precedent `exportPanel()`
  already established ("no real parameters exist beyond the current result itself, already fully
  described by the prose above"). Save settings' own logic was ALSO still inline in an anonymous
  listener — a standing-convention (Q1) gap on top of the missing `logCmd()` (Q2) one — extracted to
  `saveSettingsJson()`, the same shape `loadSettingsJson(f)` right above it already has for the load
  side. Verified via Playwright: `saveSettingsJson()` is a real top-level function, and calling it
  directly (native picker stubbed away, matching this app's own `file://` download fallback) produces
  a `logCmd` entry with `jsOverride==='saveSettingsJson()'`.

  **The timing table's own label→number gap was still too wide** (follow-up, same round, reported —
  no literal tabs anywhere, just plain spaces: each row's label is hardcoded-padded to 12 chars in
  its own template literal, and `sec()`'s `padStart(7)` right-aligned the number on top of that — a
  19-char fixed prefix regardless of label length, so a short label like `fit` (3 chars) left a
  14-space gap before a 1-2 digit value). `sec()`'s own `padStart(7)` → `padStart(4)` — comfortably
  fits any realistic single-stage duration (up to `"9,999"` s ≈ 2.7h) without reserving 3 unused
  columns for a scenario (a Localize stage running past ~2.7 hours) this app has no reason to expect.
  Cuts the same 3 characters off every row uniformly, so column alignment across rows is unaffected.
- **liveStreaming** (`window.webSMLM.liveStream`) — Marked **experimental**: real, but younger and
  less battle-tested than the rest of the app (several real bugs found and fixed via actual
  openframe-rig/Playwright testing this same 0.12.0 cycle — Stop not wired for streaming, the locs
  table staying disabled all session, an adaptive-cadence timing gap). A Micro-Manager/pycromanager
  camera bridge, physically right after **pipeline** (whose `runCore()` it calls per chunk) and split into its own
  indexed `MODULE:` banner for its size, not moved elsewhere in the file. Distinct from, and named
  to avoid colliding with, both the in/out module's own unrelated TIFF chunked/streamed-loading
  flag (`chunkmb`/`loadMultiIfdStreaming()`/`stack.streaming`) and the headless API's NDJSON
  "streaming per-record exports" (`onRecord`/`makeRecordEmitter()`, above) — three genuinely
  different features that all happen to use the word "stream". Two ways in, both nested inside
  `memBox` ("Memory & streaming"): an opt-in WebSocket the page itself connects OUT to (never
  listens), for hooking into a tab already open (`tools/test_livestream_demo.py`); or an external
  Playwright-driven bridge (`tools/webSMLM-livestream-bridge.mjs`, e.g. driving a Gladoscopy RT
  node) via a hidden `#liveStreamChunkInput` file conduit. Either way, each chunk is localized
  independently via `runCore()` (no cross-chunk context, so FTM is unsupported in this mode) and
  appended to a running total, repainting the reconstruction through the same `lastResult`/
  `rerender()` globals an interactive Localize run already uses. No separate Start step: a
  session (`liveStreamState`) arms itself the moment streaming actually begins — Connect, or the
  first pushed chunk — using whatever pxnm/gain/method/etc. the sidebar is set to at that moment.
  The top-level **Stop** button is the one control that ends a session either way (closing the
  WebSocket first if one's open); an earlier separate Disconnect button was folded into it and
  removed once Stop covered everything it did. The raw panel gets its own scrubbable frame history
  (`liveStreamShowRawFrame()`), auto-following the newest frame unless paused by a manual scrub,
  capped to **Memory budget (GB)** via a ring buffer (`liveStreamState.rawFrames`) since an
  open-ended acquisition can't keep every raw frame in memory. The periodic cadence render is
  adaptively time-based (`liveStreamState.previewInterval`, seeded from `srPreviewMs`/scaled to
  ~10x its own measured cost up to `srPreviewMaxMs` — the same mechanism a normal Localize run's
  live preview uses; a manual "Render every N frames" setting was removed since its effective
  cadence depended on external chunk size, not anything this app controls), guarded by
  `liveStreamState.renderBusy` so a fast chunk stream can't pile up renders faster than the single
  dedicated render worker can finish them, plus a conservative idle/pause detector and a session's
  own final render on end so the displayed reconstruction never lags behind `lastResult.locs`.
  `liveStreamOwnsRawPanel()` is the single shared "does streaming currently own the raw panel"
  check, used by the Contrast-auto handler and wheel-scrub routing — `initScrub()` deliberately does
  NOT use it: a fresh stack/CSV load must always reclaim the panel from a stopped session's leftover
  scrub-back history, a narrower check by design, not an oversight. **View data/filtering** (the
  locs table) is available mid-session too (same "any locs exist" gate as drift/NeNA/FRC) for
  browsing/sorting/histograms, but committing a NEW filter (or the reconstruction panel's crop
  tool, same `_tableFilters` mechanism) is refused while streaming — a filter is a one-time
  snapshot never re-applied to later chunks, so using one mid-stream would silently freeze the
  displayed reconstruction while `lastResult.locs` kept growing underneath it. **Clear
  localizations** (`liveStreamClearBtn`, `clearLiveStreamingLocalizations()`) resets `allLocs`/
  `frameOffset`/`rawFrames`/the reconstruction to empty without touching `.active` — chunks keep
  arriving through the call, no reconnect needed.
- **table** — the sortable, cumulatively-filterable localizations table ("View data/filtering")
  and per-column histograms. Committed filters set `renderLocs`, which drives the reconstruction
  live. The SR panel's crop tool (`cropBtn`, click two corners) is not a separate mechanism — it
  pushes an x/y-range clause into the same `_tableFilters` array a typed filter would, so
  reconstruction, export, NeNA and FRC all see a crop identically to any other filter. Typing
  `tempClusteringXY < 10` (nm) into the filter box is different in kind from an ordinary clause —
  it doesn't select a subset, it *merges* a blinking molecule's own detections into fewer,
  higher-precision "events" (`clusterEvents()`), changing the BASE row set rather than which rows
  currently pass. `getBaseLocs()` is the single place deciding whether the base is raw
  `lastResult.locs` or clustered events; everything else consumes whichever it gets, the same
  loc-shape either way.

  **Filtering is now CLI/JS-loggable** (v0.12.1-dev, on request — "repeat filtering steps"). Every
  successful `_tableFilters.push()` — the ordinary-clause branch and the tempClustering branch in
  `commitFilter()`, and the crop tool's own push — now calls `logCmd({tableFilters:
  tableFilterExprList()})`, where `tableFilterExprList()` maps `_tableFilters` to
  `f.exprCLI||f.expr`: the FULL cumulative array every time, so the most recently logged line
  always reproduces the exact current filter state (same "curated snapshot, not a diff" convention
  `run()`'s own `logCmd()` already uses). An ordinary or tempClustering entry's own `.expr` is
  already valid, replayable filter syntax (it's literally what was typed); the crop tool's own
  `.expr` is a pretty DISPLAY string ("crop: x 1234–5678 nm, y ...") `parseFilter()` can't parse, so
  it gained a second `.exprCLI` field — the equivalent `x >= .. and x <= .. and y >= .. and y <= ..`
  clause, built from the same `x0/x1/y0/y1` the crop tool already computes — used only for
  logging/replay; the chip's own on-screen display still reads the pretty `.expr`, unchanged.
  `resetFilters()` deliberately does NOT log anything — clearing filters isn't itself "a step to
  repeat," and an absent `tableFilters` key is already the headless default.

  **`tableFiltersCore(locs, px, exprList)`** (right after `commitFilter()`) is the pure, DOM-free
  half — `config.tableFilters` (MODULE: headless API) calls it with the exact array `logCmd()`
  above records, so an entire interactive filtering session (typed clauses, crop, temporal
  clustering, in whatever order they were committed) replays headlessly. Walks `exprList` in order:
  a `tempClustering(XY|Z|Memory)` entry updates local `{xy,z,memory}` state (replace, not stack, per
  axis — same semantics `commitFilter()`'s own `_tableFilters=_tableFilters.filter(f=>f.cluster
  !==axis)` line has) and rebuilds the base via the already-pure `clusterEvents()`; everything else
  parses via the already-pure `parseFilter(expr, cols)` against the CURRENT base's columns and ANDs
  into a running predicate; throws a plain `Error` on an unparseable clause (same "config
  validation propagates immediately" convention `analyze()` uses elsewhere). Deliberately NOT
  called FROM `commitFilter()` itself — the interactive path's own incremental one-clause-at-a-time
  UI updates (chips, live count, rebuilding `_tableData` only when the base actually changes) don't
  collapse into a single batch call cleanly; this is the "`*Core()`" DOM-free half existing
  *alongside* the interactive one, not a replacement for it. Verified end-to-end: replaying a real
  interactive session's own logged `tableFilters` array (an ordinary clause + a tempClustering
  clause, and separately a crop) through a fresh headless `analyze()` reproduces the EXACT same
  filtered row count as the interactive session's own `_tableFiltered.length` — 442/442 and 112/112
  on a real test file — and a real `tools/webSMLM-cli.mjs --tableFilters "..."` run matches too.

  **`locTableData(baseLocs, isClustered, px)`** gained an optional 3rd `px` parameter (default
  `px??lastResult.px`) so `tableFiltersCore()` above can call it with no `lastResult`/interactive
  session at all — all 3 existing interactive call sites (`rebuildTableData()`, `openTable()`, the
  crop tool) omit the 3rd argument and are completely unaffected.

  **Column headers put a unit suffix ("[nm]" etc.) on its OWN line, not appended inline**
  (`<br><span class="col-unit">[...]</span>` in the shared `<th>` template both `#locTable` and
  `#trackTable` build — see the CSS comment right above `.col-unit`) — reported: with many optional
  columns active at once (sigma_x/sigma_y, angle, track_id, `nmerged` once clustering is on, ...),
  every header reading "name [unit]" on one line made the table wide enough that later columns
  (`nmerged` in particular) needed horizontal scrolling to see at all. The table's own default
  auto-layout sizes each column to its widest LINE of content, so splitting the unit onto its own
  (usually shorter) line lets a column shrink to whichever is narrower — the bare name or the
  bracketed unit — instead of always needing room for both on one line; verified via Playwright at a
  cramped 900px viewport that all 10 columns of a `tempClusteringXY`-filtered table (including
  `nmerged`) now fit with no scrolling, and separately that `#trackTable` (sharing this exact
  template) renders the same way. The sort arrow (▲/▼) moved to sit right after the column NAME
  (previously after the unit) so it stays on the same line as the text people actually scan first.

  **`tempClusteringMemory <= N`** (frames, or `<= inf`, shipped — was the one remaining planned
  pseudo-field) is `clusterEvents()`'s new `memoryFrames` parameter (default 0, preserving the
  original hardcoded strict-adjacency behavior bit-for-bit — verified via Playwright: 0 produces the
  exact same event SET, by position/photons/frame/nMerged, as a frozen copy of the pre-memory
  algorithm on a real dataset). Restructured the per-frame loop so a chain's eligibility is a
  computed check (`f - c.lastFrame - 1 <= memoryFrames`) against the CURRENT frame, evaluated at the
  TOP of each frame's processing, rather than an immediate close-if-not-extended decision at the
  tail of the frame it failed to extend at — a chain surviving the check just gets another chance to
  match; one that's exceeded its gap tolerance is finalized before any distance search runs. Same
  reasoning resolves the design question `docs/REFACTOR_PLAN.md` had flagged as blocking this (how a
  gap should weight into the position average): a gap frame has no localization at all, so there's
  nothing to add into the running sums either way — the only real choice was whether matching should
  use the chain's full photon-weighted history or something more recency-weighted, and it stays the
  full history unchanged, since this app already has a dedicated drift-correction step (AIM) that's
  the intended place to handle real stage drift before clustering with a large/unlimited memory.
  Parsed by `commitFilter()`'s own regex, extended to accept `inf`/`infinity` (case-insensitive) as a
  value token for all three clustering pseudo-fields, not just Memory — it degrades correctly through
  the existing `d>xyPx`/`Math.abs(...)>zNm` checks (never true) for XY/Z too, so no special-casing
  was needed there. Memory alone (no XY/Z clause) does nothing — `getBaseLocs()` still gates on
  `xy||z` — `commitFilter()` warns rather than silently no-opping when a user sets Memory first.
  **Unlimited memory changes the performance profile for real**: at `memoryFrames=0`, `open` (the
  in-progress chains) self-prunes every frame; with real gap tolerance it only shrinks via merges, so
  it can grow to the total number of distinct physical sites over the whole clustered range — the
  existing "would want a spatial grid… if ever fed a pathologically dense frame" comment is now much
  more likely to actually matter, but the grid wasn't built pre-emptively (same "don't optimize for a
  scale nobody's hit yet" precedent as SPT's own Hungarian-vs-greedy fallback). `checkTableSize()` guards `locTableData()` the same way
  `checkRenderSize()` guards **render**'s buffers — each row estimated at ~200 bytes (V8 per-object
  overhead) against `memgb`; throws if over budget, caught at all three build sites so a too-large
  table fails with a log message and leaves whatever was on screen before.

  `computeHist()`/`drawHistogram()` (reused by table-column histograms, sSMLM's distance/angle
  histograms, and **spt**'s D/track-length histograms) can overlay a fit curve: `histData.curve`, a
  `x=>y` function sampled across the current view in the same bin-height units as the bars, plus an
  optional `histData.curveLabel`. Unlike `markers` (a `computeHist()` parameter, positions known
  before binning), `curve` isn't a `computeHist()` argument — a fit like `fitTrackLifetime()` needs
  the ALREADY-binned `histData` to fit against, so the caller sets `histData.curve`/`curveLabel`
  after `computeHist()` returns, before `drawHistogram()`. Defaults to `null`.

  `computeHist()`'s x-axis range (`hi`) carries a 5% right-edge headroom (`hi = lo +
  (dmax-lo)*1.05`), mirroring the Y-axis's own `ymax*=1.08` factor: without it, `hi===dmax`
  exactly, so the tallest/rightmost bin's right edge fuses visually with the plot's own border. A
  real bug on **spt**'s track-length histogram: a long-tail outlier track was effectively
  invisible, indistinguishable from the axis line — binning was never the problem (`b>=nb` already
  clips into the last bin), only the missing visual margin was.

The list above is in the file's actual physical order (as of v0.11.1, **workers** and
**export** were swapped to match — see `docs/REFACTOR_PLAN.md` for the reasoning and how it was
verified safe: both are pure declarations, no cross-referencing top-level state, so JS hoisting
made the physical move a no-op for behavior).

### Web Worker gotcha (read before touching detect/fit/workers)

Workers are **not** separate files. `workerSource()` builds worker code by calling `.toString()`
on the very functions the main thread uses, so detection/fitting logic exists once. Consequences:

- A worker gets a fresh global scope. Any module-level state a stringified function relies on must
  be re-declared in `WORKER_PRELUDE`, or the worker throws a `ReferenceError` and silently falls
  back to single-threaded. If you add a `let`/`const` at module scope that a detect/fit function
  reads, add it to `WORKER_PRELUDE` too (there is a runtime check listing `missing` names).
- Any helper a stringified function calls must itself be included in the `workerSource()` body.
- The same pool serves two unrelated message protocols: detect/fit's frame-batch dispatch
  (`d.frames`/`d.start`/…) and FTM's single-frame row-band preview (`d.ftmFrame`/`d.buf`/…) —
  `onmessage` branches on `d.ftmFrame` before falling into the detect/fit path. A new worker job
  needs its own branch and its own `d.<flag>` field, not a repurposed existing one. FTM's
  *other* use — `makeFtmStack()`, feeding `runCore()`'s Localize path — deliberately does **not**
  add a third message type: it runs its chunk correction on the main thread instead, precisely
  because `runCore()`'s own worker-dispatch can have several workers mid-detect/fit while a chunk
  fetch is in flight, and a third job type on the same pool would overwrite a busy worker's
  `onmessage` (one property, not a queue) out from under it. Don't "fix" this by giving chunk
  correction a worker branch without also solving that scheduling conflict properly.

### Left/right panel plot pattern

The left panel (`raw` canvas) doubles as a plot surface. To show a plot instead of a frame, set
`rawFull=null; rawIsPlot=true; rawPlotName=<kind>` and draw directly on `$('raw')`; call
`syncSaveImg()`. Calibration plots render on the right (`sr`) canvas via `srIsPlot`. Switching a
panel back to a frame/reconstruction (`drawRawView`/`drawView`) must clear any plot-only overlay
state so a stale plot can't paint over live pixels.

**The four raw-panel mode-toggle buttons must call `hideOtherRawToggleBtns(exceptId)` (MODULE:
render, next to `drawRaw()`).** `driftPlotModeBtn`/`sptHistModeBtn`/`sSmlmHistModeBtn`/
`segShowModeBtn` are mutually exclusive by construction — only one plot/image can occupy the panel
at a time. A DIRECT switch between two plot dispatchers with no "reclaim point" in between (e.g.
**Correct drift**/**Show drift**, leaving `driftPlotModeBtn` up, immediately followed by **Preview
pairs**) used to leave the PREVIOUS toggle stranded on screen alongside the new one — a real,
reported bug, since each dispatcher only knew how to show/label its OWN button. Fixed by having
all four dispatchers (plus `drawRaw()`/`drawSegmentedImage()`) call `hideOtherRawToggleBtns()`
first. Any FUTURE raw-panel toggle button must do the same — add its id to the helper's list.

### Live preview (real-time detect/fit on the scrubbed frame)

`showFrame()` re-detects and re-fits whatever frame the raw-panel scrubber is on, so
switching detection/fit method or scrubbing shows results immediately without a full Run.
Two paths, chosen by the `#liveUpdate` checkbox:

- **checked** — reads the current UI controls live and calls `detectSpots()` fresh; this is a
  throwaway visualization, never written to `lastResult`/`locs`/`srFull`.
- **unchecked** — replays the *last full Run's* (or Calibration's) parameters from the cached
  `det:{sigma,k,win,border,exactBP,mode}` bundle on `lastResult`/`calib`, so the overlay matches
  what was actually localized rather than whatever the controls currently show.

Any control that affects detection/fit is wired into the live-preview listener array (search
for `.forEach(id=>{` near the settings-JSON code) — a new per-method parameter needs adding there
too, or changing it won't refresh the scrubbed-frame preview until the next full Run.

Both paths suppress the fit crosshairs (not the ROI boxes) outside `fitFirstFrame`/`fitLastFrame`
— `fitFrameRange()` is the single place deciding "in range" for both `showFrame()` and `runCore()`,
so scrubbing to a frame a Run would never touch can't show a misleading live-fit result there.

### Every actionable GUI control needs a plain top-level function behind it

Standing rule, not a one-time cleanup (established after a full parity audit — see **pipeline**'s
own "Full GUI/terminal parity" paragraph): a button click, checkbox change, or any other control
that actually computes or changes data must call ONE plain top-level `function`/`async function` —
never inline its real logic directly in an anonymous `addEventListener` closure. Reading/writing a
handful of DOM elements to reflect state (disabling a button, toggling a CSS class) is fine to leave
inline; anything beyond that (a fetch/parse, a state reset sequence, building a filter, discarding a
result) belongs in a named function the handler just calls.

**Why**: the log terminal's `eval()` shares this file's own top-level scope, so any plain top-level
function is automatically callable from the terminal, reproducing the exact GUI action with zero
extra wiring. An anonymous inline handler is invisible to that — a user (or a future contributor)
has no way to trigger "what button X does" except by clicking it. Following this rule means GUI and
terminal/scripted access stay interchangeable by construction, not by remembering to keep a parallel
API in sync.

### Button label length

Sidebar/panel-title buttons must fit on one line at the sidebar's normal width — a label that
wraps reads as broken layout, not a design choice. Abbreviate rather than let a label wrap:
"Fit dist. & angle" not "Fit distances and angles" (see **sSMLM**). Favour standard, unambiguous
abbreviations (`dist.`, `min`/`max`, `deg`) over truncation that could be misread.

Two-word-joined-by-punctuation labels read `Word/word` with no surrounding spaces (**Save
plot/image**, **View data/filtering**, **Load movie/data**) — matches the compact house style
already used elsewhere (`sigma_x`/`sigma_y`, `min`/`max`). A `+` joining two nouns (as
"View data + filtering" used to) reads as addition/combination rather than an either/or or
belongs-together pairing; `/` is the established connector for that here.

### `label.row` nesting-depth gotcha (indented sidebar sub-rows)

`details.sim>label.row{padding-right:4px}` (keeps a row's numstep +/- buttons flush with every
other row's own right edge) is a DIRECT-CHILD selector — it only matches a `label.row` immediately
inside a `details.sim`, not one nested a level deeper inside a wrapping `<div>` (e.g. a
conditionally-shown sub-group like `#segLoadRow`). Such a nested row still LOOKS indented
(inherits left padding from the wrapper's own `details.sim>*:not(summary){padding-left:14px}`), so
the missing 4px right-padding is easy to miss until compared pixel-for-pixel against a
properly-indented row (a real bug: `segAreaMin`/`segAreaMax`, MODULE: spt, originally lived inside
`#segLoadRow` this way). An indented sidebar sub-row (the `ftmWindowRow` pattern) should instead be
a DIRECT child of its `details.sim`, given its own `id` + inline
`style="display:none;padding-left:40px"` (40px, not 14px, so it still reads as subordinate to a
plain top-level row), shown/hidden by the SAME handler that toggles its sibling group. The opposite
direction breaks the same way: a row placed OUTSIDE any `details.sim` (e.g. `pxnm`, pinned
always-visible) also needs its own explicit `style="padding-right:4px"`.

### Syntax gotcha

Leading-unary `**` is a SyntaxError in both JavaScriptCore and V8: write `-((x-d)**2)`, never
`-(x-d)**2`.

### `getBoundingClientRect()` + scroll gotcha (position:fixed elements anchored to an in-flow one)

`#sideToggle`/`#sidePin` (the mobile/floating sidebar drawer's toggle/pin buttons) are
`position:fixed`, but their `top` is `calc(var(--header-content-bottom) - ...)`, where
`--header-content-bottom` is set by `measureHeader()` from
`.header-actions.getBoundingClientRect().bottom` — VIEWPORT-relative, so it shifts as the page
scrolls. A `position:fixed` element itself doesn't move on scroll, so this must store the header's
RESTING position (as if scrolled to the top), not whatever the viewport-relative rect reads at the
moment `measureHeader()` fires. Add `window.scrollY` back: `rect.bottom + window.scrollY` is
scroll-invariant, `rect.bottom` alone is not. A real bug without it: `measureHeader()` also runs on
every `resize` event, and mobile browsers fire a `resize` when their address bar collapses/expands
DURING an ordinary scroll — so a resize firing while scrolled away from the top baked in a deeply
negative `--header-content-bottom`, pushing the toggle permanently off-screen until the next
correct remeasurement. General rule: any `getBoundingClientRect()` measurement feeding a
`position:fixed` element's offset must add `window.scrollY`/`window.pageXOffset` back in.
`--header-h` (a size, not a position) doesn't need this — only `.bottom`/`.top`/`.left`/`.right`
reads do.

### Window resize must always re-fit the reconstruction/raw panels, not just when `atFit`

`refitCanvases()` (the debounced `window.resize`/`ResizeObserver` handler, MODULE: pipeline) used
to only call `fitView()`/`fitRawView()` when `view.atFit`/`rawView.atFit` was still `true` —
reasoned as "don't clobber a user's manual zoom/pan on an unrelated redraw." But `atFit` turns
`false` the moment the user zooms or pans ONCE, and on any real dataset a user almost always does
— so resizing the window stopped re-fitting the reconstruction for the rest of the session after
the first zoom/pan, a real bug. Fixed by making a window/panel RESIZE always re-fit
unconditionally, regardless of `atFit` — a resize reshapes the PANEL, a distinct action from
zoom/pan, so the two shouldn't share a gate. `atFit` is still set correctly by `fitView()`/pan/zoom,
it just no longer gates anything.

### Mobile input font-size vs. label font-size

Below the 860px breakpoint, `input.num`/`select.sel` jump to 16px (iOS auto-zooms on focusing a
smaller input; 16px is the threshold that stops it) while `label.row` text stays at the base 12px
— a real, known, deliberate size mismatch, not a bug to "fix" by shrinking the input back down.

### `<noscript>` + `.textContent +=` gotcha

Never put a `<noscript>` inside an element that JS later reads via `.textContent` (especially
`+=`, which reads-then-overwrites). With scripting enabled, a browser parses `<noscript>...
</noscript>` content as RAWTEXT — a single opaque text node, not real child markup — so
`.textContent` on an ancestor includes that raw text (literal tags and all) even though the
`<noscript>` itself renders as nothing. Reading `.textContent` is harmless; but the moment
something WRITES `.textContent` (as `log()`'s own `.textContent += '\n'+m` does, writing to
`$('logText')`), the noscript element gets destroyed and replaced by one flat text node —
permanently baking that raw warning text into the log's own visible content on the very first
`log()` call, regardless of whether scripting is actually enabled. This was a real, shipped bug:
`#log`'s seed HTML had its own `<noscript>⚠ JavaScript appears to be disabled…</noscript>` (a
redundant, log-local echo of the real disabled-JS warning), and it showed up as literal visible
text with JS fully working. Fixed by removing it — the top-of-`<body>` `<noscript>` banner (a big
red full-page warning, never touched by any JS) already covers the genuinely-disabled-JS case.
General rule: `<noscript>` is only safe near code that reads/writes `.textContent`/`.innerHTML` if
nothing ever WRITES through an ancestor of it.

**Log box / logged-text width split** (`#log`/`#logText`) — the log card's border/background used
to be capped at `max-width:100ch` directly on `#log`, leaving its right edge short of the
reconstruction panel's own edge on a wide window (the cap was meant to keep a wrapped LINE
readable, not shrink the box). Split into `#log` (the outer box — border/background/scroll, no
width cap) wrapping a plain child `#logText` (`max-width:80ch`, matching a standard terminal width)
that holds the actual text. `log()`/`clearLogBtn`/`exportLogBtn` all read/write `#logText`'s
`.textContent` now; `#log.scrollTop` (the outer box) is still what `log()` sets to autoscroll,
since `#logText` has no scrollbar of its own.

**`#log`'s height is a fixed 236px** (reported — the previous `height:clamp(180px,32vh,460px)`
rendered ~25 lines on a normal desktop viewport, mostly scrolled-past history rather than what just
happened), sized for exactly 12 text lines: `12 * 18px` (12px font × 1.5 line-height) + `20px`
padding (10px top+bottom, global `box-sizing:border-box`). A plain fixed height, not viewport-
relative — "12 lines" was the explicit ask regardless of screen size; `#log`'s own `overflow:auto`
still scrolls to whatever's beyond that.

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

### `micromanager_plugin/webSMLM_Streaming` (Java) — rebuild locally to test, never commit the jar

Editing any `.java` file under `micromanager_plugin/webSMLM_Streaming/src/` does **not** update
`target/webSMLM_Streaming.jar` by itself — that jar is a build artifact, and a stale one left in
place after a source edit is worse than no jar at all (it silently keeps running the old code,
with no signal that anything's out of date). **Rebuild it locally every time you need to actually
test a Java-source change**:

```sh
mvn package -Dmm.install.dir="C:\path\to\your\Micro-Manager-install"
```

(see `micromanager_plugin/webSMLM_Streaming/README.md`'s own *Building* section for the full
requirements — a local MM 2.0 install for the MM/ImageJ/scijava system-scoped jars, JDK 11+, Maven
3.6+). If `mvn` isn't on `PATH` in the current environment, don't skip the rebuild — compile and
jar manually instead, e.g. via `javac`/`jar` straight out of the JDK, using the same dependency
jars `pom.xml` lists (the MM install's own `MMJ_.jar`/`MMCoreJ.jar`/`ij.jar`/
`scijava-common-*.jar`, plus Java-WebSocket/guava/slf4j-api from `~/.m2/repository` if already
cached there from a prior `mvn` run) — compile all four source files together, then jar up the
compiled classes plus Java-WebSocket's own extracted classes (guava/slf4j-api stay `provided`,
i.e. compile-time only, matching `pom.xml`'s shade config — don't bundle them). Confirm the rebuilt
jar actually contains the change (e.g. `jar tf target/webSMLM_Streaming.jar` lists the expected
classes, or `javap -cp target/webSMLM_Streaming.jar <class>` shows the new/changed method) rather
than assuming the build succeeded.

**`target/` is gitignored — the compiled jar is never committed** (an earlier version of this
plugin shipped it in-tree; dropped on review: a binary rebuilt-and-recommitted on every edit grows
the repo forever with undiffable blobs, and git alone can't prove a committed jar actually matches
the source it sits next to). Distribute a built jar to end users via a GitHub Release asset (or
have them run the `mvn package` command above themselves) instead of expecting one to already be
in the repo.

## Branch & release workflow

- **`main`** is live: it is served by GitHub Pages (`hohlbeinlab.github.io/webSMLM/webSMLM.html`)
  and archived on Zenodo. **`webSMLM_local`** is the dev branch — do work there.
- Only push to `main`, merge, or cut a release **when the user explicitly asks.** Release = commit
  on `webSMLM_local` → push → `git checkout main && git merge --ff-only webSMLM_local` → push main.
- Cadence: **minor bumps (`0.x.0`) → cut a GitHub release + new Zenodo version DOI. Patch releases
  (`0.x.y`) → version bump + push to `main` only, no DOI.**
- Version lives in two spots in `webSMLM.html` (the `.pill` in the `<h1>`, and `#logText`'s own
  seed text — a child of `#log` itself since the box/logged-text width split, see the `<noscript>`
  gotcha section) plus `CITATION.cff`. Dev builds are marked `vX.Y.Z-dev · build YYYY-MM-DDx`;
  clear the dev marker to `vX.Y.Z · proof-of-concept` on release. **Bump the build letter suffix
  (`a`→`b`→`c`…) on every round of changes the user is about to test** — it's the only visible
  signal (pill + log stamp) that a hard-refreshed page is actually running the latest edits, not a
  cached prior build. Past `z` in a single day, roll over spreadsheet-column-style (`z`→`aa`→`ab`…)
  rather than moving to a new date — first needed 2026-08-24, which shipped enough same-day rounds
  to exhaust the single-letter alphabet. **Every build-letter bump also gets its own commit on
  `webSMLM_local`** (no need to ask first — this one's a standing instruction), so each testable
  round has real git history, not just an accumulating uncommitted diff. This is independent of
  releasing: `webSMLM_local` accumulates fine-grained commits continuously; `main` only receives
  them in a batch, at an explicit release, per the cadence above. **Same round: check the
  top-of-file MODULE INDEX comment against a fresh `grep -n "MODULE:"`** and refresh any line
  number that's drifted by more than a few lines — cheap to check every time, and it's the whole
  point of the index that it stays trustworthy rather than becoming another stale comment.
- Every release also updates `CHANGELOG.md` (newest first; DOI column) and, where the release
  closes out or changes a roadmap item, `docs/REFACTOR_PLAN.md`. Pages typically redeploys ~1-2 min
  after a push; check with `gh api repos/HohlbeinLab/webSMLM/pages/builds/latest`.
- **Read the Docs also rebuilds on every push to `main`** as of 2026-08-24 — a GitHub webhook
  (repo Settings → Webhooks, id `669780136`, events: `push`) targets RTD's own incoming-webhook URL
  for this project (`https://app.readthedocs.org/api/v2/webhook/websmlm/331808/`, HMAC-signed with a
  secret held only on the GitHub and RTD sides, never in this repo). No API-based check exists for
  this the way Pages has one (`gh api .../pages/builds/latest`) — after a release, either check the
  RTD project's own Builds page, or confirm the live site reflects the change a few minutes later.

## Reference material

- `README.md` — deliberately short: launch instructions, the guided workflow (kept in sync with the
  in-app **Quick guide** modal's own "Guided workflow" — update both together if either changes),
  data/privacy, scripting/headless, roadmap, distribution/citation, licence. Trimmed of its own
  former "What it does" feature list, performance table, algorithm reference list and "Known
  limitations" section (v0.11.6) — those are fully covered by `docs/DOCUMENTATION.md` (features,
  §9 references) and `docs/REFACTOR_PLAN.md` (limitations/roadmap) respectively now, so keeping a
  third, drifting copy in the README stopped being worth it.
- `docs/DOCUMENTATION.md` — detailed reference for every button/control/`PARAMS` entry, the
  on-disk file formats (settings/calibration/CSV JSON), the headless API/CLI (§8), and every
  algorithm reference (§9) — the place to check or update for exact defaults, ranges and
  behaviour, complementary to the deliberately sparse in-app **Quick guide**.
- `docs/REFACTOR_PLAN.md` — forward-looking roadmap only; shipped-feature history lives in
  `CHANGELOG.md` instead. Think in version numbers, not "phases".
- `experimental_data/` — sample stacks (gitignored large files) with a README of public sources
  and their camera/pixel-size parameters.
- `tools/` — scripting/headless tooling for advanced users, not needed for interactive use:
  `webSMLM-cli.mjs` (Node + Playwright, true headless, the recommended one), `browser_sweep.py`/
  `browser-sweep.sh` (stdlib-only Python / bash, drive a real visible browser for a parameter
  sweep). See each script's header comment and `docs/DOCUMENTATION.md` §8.

## Documentation build
- `docs/DOCUMENTATION.md` is the only authored source for the detailed Read the Docs
  manual. The Read the Docs build is Markdown-native (Sphinx + MyST).
- `docs/readthedocs/build_docs.py` splits `DOCUMENTATION.md` at each level-2 (`##`)
  heading into separate temporary Markdown pages so the published manual has one
  Read the Docs page per major section. It also generates the documentation
  `index.md`/toctree, preserves cross-section references, and adjusts relative
  documentation-image paths.
- Generated files are disposable and **must not be edited or committed**:
  `docs/readthedocs/content/`
  `docs/readthedocs/index.md`
  `docs/readthedocs/_build/`
  Documentation-content changes belong in `docs/DOCUMENTATION.md`; if the generated
  structure, links, or paths are wrong, fix `docs/readthedocs/build_docs.py` instead.
- Documentation images live once in `docs/images/` and are referenced from
  `DOCUMENTATION.md` as `images/...`.
- Read the Docs runs the splitter before Sphinx via `.readthedocs.yaml`. For a
  local strict build from the repository root:
      python docs/readthedocs/build_docs.py
      python -m sphinx -W --keep-going -b html docs/readthedocs docs/readthedocs/_build/html
- If generated documentation is wrong, fix `docs/DOCUMENTATION.md` or, when the
  generation logic itself is responsible, `docs/readthedocs/build_docs.py`.
- **In-app "more info…" popups** (`.hint` divs, the sidebar's own contextual help, distinct from
  both the Quick guide modal and this RTD manual) used to be hand-authored independently of
  `DOCUMENTATION.md` — a real drift risk (both describe the same controls, sometimes citing the
  same papers). `tools/sync_hints.mjs` (plain Node, zero dependencies) fixes this by making
  `DOCUMENTATION.md` the single source: each `.hint` div carries a stable `id="hint-<name>"`; the
  matching content lives inside a `<!-- HINT:<name> --> ... <!-- /HINT:<name> -->` marker in
  `DOCUMENTATION.md` (right after that control group's PARAMS table in §2), as **raw HTML**
  deliberately, not Markdown — byte-identical in both places, no Markdown→HTML conversion step to
  itself go stale. Edit a hint's content ONLY inside its `DOCUMENTATION.md` marker, then run
  `node tools/sync_hints.mjs` (rewrites `webSMLM.html`'s `.hint` divs to match, reindented flat) —
  never hand-edit a `.hint` div directly, it'll be overwritten on the next sync. `--check` exits 1
  without writing if `webSMLM.html` would change, for a pre-commit/CI-style drift check. The
  `<span class="pill">module: X</span>` label at the top of each `.hint` div is NOT part of the
  synced content (kept as fixed markup in `webSMLM.html`). All 13 `.hint` divs
  (`hint-memory`/`hint-liveStreaming`/`hint-simulation`/`hint-pcfo`/`hint-calibration`/
  `hint-detectfit`/`hint-export`/`hint-render`/`hint-drift`/`hint-locprecision`/`hint-sSMLM`/
  `hint-smfret`/`hint-spt`) use this mechanism. Each
  marker is placed as the INTRO to its DOCUMENTATION.md section, right after the PARAMS table — the
  surrounding prose picks up only where the popup leaves off, not restating it.
- **Quick guide** (the in-app modal, `helpBtn`) is deliberately thin: just the intro blurb, the
  5-step **Guided workflow** (step 2 briefly names the fit-method families and points at the docs
  for depth), **Acknowledgements**, and **License & author** — no per-module walkthrough, no
  citation list; `docs/DOCUMENTATION.md` (§9 "References & further reading" for citations) is the
  maintained source for that depth now, and `DOCUMENTATION.md` is what the `.hint` popups link to
  when they need to point somewhere. The modal's own text is hand-authored UI copy, not synced by
  `sync_hints.mjs` (that mechanism only covers `.hint` divs). `README.md`'s own "Guided workflow"
  section is kept as a copy of this same 5-step list — update both together — see **Reference
  material** below.