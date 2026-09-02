package org.kjamartens.websmlm.streaming;

import ij.ImagePlus;
import ij.ImageStack;
import ij.io.FileSaver;
import ij.process.ByteProcessor;
import ij.process.ShortProcessor;
import org.micromanager.data.Image;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.List;

/**
 * Encodes a batch of raw MM {@link Image} frames as a single ImageJ-style multi-page TIFF
 * (byte-for-byte the same "ImageJ, contiguous" layout tools/test_livestream_demo.py produces
 * via tifffile's imagej=True, which is what webSMLM's loadTiffFile() fast path expects).
 * Split out of {@link StreamingController} - a pure, stateless transformation with no session
 * lifecycle/networking concerns of its own, unlike the rest of that class.
 */
final class ImageJTiffChunkEncoder {

    private ImageJTiffChunkEncoder() {
    }

    /**
     * Builds an ImageJ ImageStack from the raw pixel buffers and writes it out via
     * ij.io.FileSaver#saveAsTiff, which produces the standard ImageJ TIFF format (the
     * "ImageJ=1.xx / images=N" description tag on a multi-slice stack) - the same format
     * tifffile.imwrite(..., imagej=True) produces on the Python demo side. Routed through a
     * short-lived temp file rather than an in-memory ij.io.TiffEncoder call: FileSaver's
     * file-based API is the stable, well-documented ImageJ1 entry point, at the cost of one
     * small local disk round trip per chunk.
     *
     * Deliberately calls the generic saveAsTiff(), NOT saveAsTiffStack() - saveAsTiffStack()
     * refuses a single-slice ImageStack ("This is not a stack", returns false) while
     * saveAsTiff() writes a correct ImageJ-tagged TIFF for both a 1-slice and an N-slice
     * stack alike (verified against both cases via tifffile). This matters because the
     * default "Frames per chunk" is 1, which is the single-slice case.
     */
    static byte[] encode(List<Image> images) throws IOException {
        if (images.isEmpty()) {
            throw new IllegalArgumentException("empty batch");
        }
        Image first = images.get(0);
        int width = first.getWidth();
        int height = first.getHeight();

        ImageStack stack = new ImageStack(width, height);
        for (Image img : images) {
            int bpp = img.getBytesPerPixel();
            Object pixels = img.getRawPixels();
            if (bpp == 2) {
                stack.addSlice(new ShortProcessor(width, height, (short[]) pixels, null));
            } else if (bpp == 1) {
                stack.addSlice(new ByteProcessor(width, height, (byte[]) pixels));
            } else {
                throw new IOException("Unsupported pixel depth (" + bpp + " bytes/px); "
                        + "webSMLM_Streaming currently only supports 8-bit and 16-bit grayscale cameras.");
            }
        }

        ImagePlus imp = new ImagePlus("chunk", stack);
        File tmp = File.createTempFile("websmlm_chunk_", ".tif");
        try {
            FileSaver saver = new FileSaver(imp);
            boolean ok = saver.saveAsTiff(tmp.getAbsolutePath());
            if (!ok) {
                throw new IOException("ImageJ FileSaver.saveAsTiff() returned false");
            }
            return Files.readAllBytes(tmp.toPath());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }
}
