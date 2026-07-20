import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type { RasterImage } from './raster';

export const encodePng = (image: RasterImage): Buffer => {
    const png = new PNG({ width: image.width, height: image.height });
    image.rgba.copy(png.data);
    return PNG.sync.write(png);
};

export const decodePng = (buffer: Buffer): RasterImage => {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, rgba: png.data };
};

/*
 * Nearest-neighbor resample, used only to absorb the odd 1-2px rounding
 * mismatch between two independently-computed pixel dimensions (resvg
 * deriving height from its own aspect-ratio math, pdfjs-dist deriving it
 * from a page-point scale factor) before a pixel-for-pixel diff.
 */
const resample = (image: RasterImage, width: number, height: number): RasterImage => {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
        for (let x = 0; x < width; x++) {
            const srcX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
            const srcI = (srcY * image.width + srcX) * 4;
            const dstI = (y * width + x) * 4;
            image.rgba.copy(rgba, dstI, srcI, srcI + 4);
        }
    }
    return { width, height, rgba };
};

const MAX_AUTO_RESAMPLE_RATIO = 0.03;

export interface DiffResult {
    mismatchedPixels: number;
    mismatchRatio: number;
    diffPng: Buffer;
}

export const diffImages = (a: RasterImage, b: RasterImage): DiffResult => {
    let imgA = a;
    let imgB = b;
    if (a.width !== b.width || a.height !== b.height) {
        const widthRatio = Math.abs(a.width - b.width) / Math.max(a.width, b.width);
        const heightRatio = Math.abs(a.height - b.height) / Math.max(a.height, b.height);
        if (widthRatio > MAX_AUTO_RESAMPLE_RATIO || heightRatio > MAX_AUTO_RESAMPLE_RATIO) {
            throw new Error(
                `Image size mismatch too large to auto-resample: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
            );
        }
        const width = Math.min(a.width, b.width);
        const height = Math.min(a.height, b.height);
        imgA = resample(a, width, height);
        imgB = resample(b, width, height);
    }
    const diff = Buffer.alloc(imgA.width * imgA.height * 4);
    const mismatchedPixels = pixelmatch(imgA.rgba, imgB.rgba, diff, imgA.width, imgA.height, {
        threshold: 0.15,
    });
    const mismatchRatio = mismatchedPixels / (imgA.width * imgA.height);
    const diffPng = encodePng({ width: imgA.width, height: imgA.height, rgba: diff });
    return { mismatchedPixels, mismatchRatio, diffPng };
};
