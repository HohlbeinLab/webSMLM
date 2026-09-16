// Minimal, dependency-free 16-bit grayscale uncompressed TIFF encoder —
// vanilla Node, no library. Exists solely to feed the live-streaming
// benches (tests/gpu/bench-livestream*.mjs) real TIFF bytes without shelling
// out to Python (the user explicitly asked for a vanilla-JS live-stream
// test, not a tools/test_livestream_demo.py dependency). Only needs to be
// decodable by UTIF.js (the decoder webSMLM.html already bundles), not a
// general-purpose writer — same "hand-write the small binary format"
// precedent as webSMLM.html's own ND2 reader (MODULE: in/out).
const TIFF_SHORT = 3, TIFF_LONG = 4;
const N_TAGS = 9;               // ImageWidth/Length, BitsPerSample, Compression,
const IFD_BYTES = 2 + N_TAGS * 12 + 4;   // PhotometricInterpretation, StripOffsets,
                                          // SamplesPerPixel, RowsPerStrip, StripByteCounts

// Chains one IFD + one image per frame, each IFD's "next IFD offset" pointing
// at the next frame's IFD (0 on the last) — an ordinary multi-page TIFF,
// exactly what loadTiffFile()'s multi-IFD walk (MODULE: in/out) already
// reads for real acquisition files.
export function encodeMultiFrameTiff16(frames, w, h) {
  const nFrames = frames.length;
  for (const px of frames) {
    if (px.length !== w * h) throw new Error(`encodeMultiFrameTiff16: a frame's pixel count (${px.length}) !== w*h (${w * h})`);
  }
  const dataBytes = w * h * 2;
  const perFrame = IFD_BYTES + dataBytes;
  const buf = Buffer.alloc(8 + perFrame * nFrames);

  buf.write('II', 0, 'ascii');          // little-endian
  buf.writeUInt16LE(42, 2);             // TIFF magic
  buf.writeUInt32LE(8, 4);              // offset to first IFD

  let ifdOff = 8;
  for (let f = 0; f < nFrames; f++) {
    const dataOffset = ifdOff + IFD_BYTES;
    const nextIfdOff = f < nFrames - 1 ? dataOffset + dataBytes : 0;

    let off = ifdOff;
    buf.writeUInt16LE(N_TAGS, off); off += 2;
    const entry = (tag, type, count, value) => {
      buf.writeUInt16LE(tag, off);
      buf.writeUInt16LE(type, off + 2);
      buf.writeUInt32LE(count, off + 4);
      if (type === TIFF_SHORT) { buf.writeUInt16LE(value, off + 8); buf.writeUInt16LE(0, off + 10); }
      else buf.writeUInt32LE(value, off + 8);
      off += 12;
    };
    entry(256, TIFF_LONG, 1, w);            // ImageWidth
    entry(257, TIFF_LONG, 1, h);            // ImageLength
    entry(258, TIFF_SHORT, 1, 16);          // BitsPerSample
    entry(259, TIFF_SHORT, 1, 1);           // Compression: none
    entry(262, TIFF_SHORT, 1, 1);           // PhotometricInterpretation: BlackIsZero
    entry(273, TIFF_LONG, 1, dataOffset);   // StripOffsets
    entry(277, TIFF_SHORT, 1, 1);           // SamplesPerPixel
    entry(278, TIFF_LONG, 1, h);            // RowsPerStrip: one strip covers the whole frame
    entry(279, TIFF_LONG, 1, dataBytes);    // StripByteCounts
    buf.writeUInt32LE(nextIfdOff, off);     // next IFD offset (0 = none)

    const px = frames[f];
    for (let i = 0; i < px.length; i++) buf.writeUInt16LE(px[i], dataOffset + i * 2);
    ifdOff = nextIfdOff || (dataOffset + dataBytes);
  }
  return buf;
}

export function encodeSingleFrameTiff16(pixels, w, h) {
  return encodeMultiFrameTiff16([pixels], w, h);
}

// A handful of Gaussian-ish blobs over a flat background — only needs to be
// a plausible, non-degenerate 16-bit frame for the live-stream wire-protocol
// tests, not photorealistic. Deterministic from `seed` so a test run is
// reproducible; a tiny hand-rolled LCG, not Math.random(), so a caller can
// seed it directly with no global-state save/restore dance.
export function makeSyntheticFrame(w, h, seed, nBlobs = 5) {
  let s = seed >>> 0;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pixels = new Uint16Array(w * h).fill(100);   // flat background, like a real camera offset
  for (let b = 0; b < nBlobs; b++) {
    const cx = rand() * w, cy = rand() * h, amp = 400 + rand() * 400, sigma = 1.2 + rand();
    const r = Math.ceil(sigma * 4);
    for (let dy = -r; dy <= r; dy++) {
      const py = Math.round(cy + dy); if (py < 0 || py >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const px2 = Math.round(cx + dx); if (px2 < 0 || px2 >= w) continue;
        const v = amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        const idx = py * w + px2;
        pixels[idx] = Math.min(65535, pixels[idx] + v);
      }
    }
  }
  return pixels;
}
