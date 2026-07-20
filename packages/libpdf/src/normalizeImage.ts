const JPEG_MAGIC = [0xff, 0xd8];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const hasMagicBytes = (bytes: Uint8Array, magic: number[]): boolean =>
    magic.every((byte, i) => bytes[i] === byte);

/**
 * doc.embedImage() only decodes raw JPEG/PNG bytes. Any other format the
 * environment can decode (WebP, etc.) is re-encoded to PNG first — lossless,
 * so this adds no quality loss beyond what the source already had. JPEG/PNG
 * bytes pass through untouched (checked by magic bytes, not the declared
 * MIME type) so the common case pays no extra decode/encode cost.
 *
 * Two re-encode paths, picked at runtime rather than by build target, per
 * this project's "same code runs in Node/Browser/Worker" principle:
 * `OffscreenCanvas` (available in both the main thread and a Worker) when
 * present, `sharp` (a real Node dependency, dynamically imported so
 * browser/worker bundlers never have to resolve it) when it isn't.
 *
 * TODO: Dely PDF's original version of this also decoded TIFF by hand (via
 * UTIF.js), for its own general image-conversion tools. That branch was
 * deliberately dropped here — an SVG's inline `<image>` is realistically
 * always JPEG/PNG/WebP/GIF (design-tool exports), so pulling in a TIFF
 * decoder as a hard dependency of this adapter isn't worth it unless a real
 * SVG-with-embedded-TIFF case shows up.
 */
export const normalizeImageForEmbed = async (
    buffer: ArrayBuffer,
    type: string,
): Promise<ArrayBuffer> => {
    const bytes = new Uint8Array(buffer);
    if (hasMagicBytes(bytes, JPEG_MAGIC) || hasMagicBytes(bytes, PNG_MAGIC)) {
        return buffer;
    }

    if (typeof OffscreenCanvas === 'undefined') {
        const { default: sharp } = await import('sharp');
        const pngBuffer = await sharp(bytes).png().toBuffer();
        return pngBuffer.buffer.slice(
            pngBuffer.byteOffset,
            pngBuffer.byteOffset + pngBuffer.byteLength,
        ) as ArrayBuffer;
    }

    const bitmap = await createImageBitmap(new Blob([buffer], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create canvas for image conversion');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return pngBlob.arrayBuffer();
};
