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
 * The re-encode path uses `OffscreenCanvas` (available in both the main
 * thread and a Worker), so this default works out of the box in a browser
 * or worker with no extra dependency. In Node (no `OffscreenCanvas`) it
 * throws instead of silently failing — `drawImage.ts` catches that and
 * skips the image with a warning, same fail-safe policy as everywhere
 * else. A Node caller who needs non-JPEG/PNG images can pass their own
 * `normalizeImage` to `embedSvgInPdf` (e.g. wrapping `sharp`) — this
 * function deliberately doesn't depend on any Node-only image library
 * itself, so `@svg-pdf/libpdf` has nothing that breaks a browser bundle.
 */
export const normalizeImageForEmbed = async (
    bytes: Uint8Array,
    mimeType: string,
): Promise<Uint8Array> => {
    if (hasMagicBytes(bytes, JPEG_MAGIC) || hasMagicBytes(bytes, PNG_MAGIC)) {
        return bytes;
    }

    if (typeof OffscreenCanvas === 'undefined') {
        throw new Error(
            `Cannot decode "${mimeType}" images without OffscreenCanvas (unavailable in this environment) — pass a normalizeImage function to embedSvgInPdf to handle this format`,
        );
    }

    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create canvas for image conversion');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await pngBlob.arrayBuffer());
};
