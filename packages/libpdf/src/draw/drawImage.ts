import { ops } from '@libpdf/core';

import { type ImageInstruction, type Matrix2D } from '@svg-pdf/core';
import { normalizeImageForEmbed } from '../normalizeImage';
import { decodeDataUri, EXTERNAL_URL_RE } from './dataUri';
import { concat, type DrawContext, FLIP_Y } from './drawContext';

export const drawImage = async (
    instruction: ImageInstruction,
    ctx: DrawContext,
    currentMatrix: Matrix2D,
): Promise<void> => {
    let decoded = decodeDataUri(instruction.href);
    if (!decoded) {
        const isExternal = EXTERNAL_URL_RE.test(instruction.href);
        if (!isExternal) {
            ctx.warnings.push('<image> data: URI could not be decoded and was skipped');
            return;
        }
        if (!ctx.fetchImage) {
            ctx.warnings.push(
                '<image> with an external URL was skipped (no fetchImage function was provided)',
            );
            return;
        }
        try {
            decoded = await ctx.fetchImage(instruction.href);
        } catch {
            decoded = null;
        }
        if (!decoded) {
            ctx.warnings.push('<image> external URL could not be fetched and was skipped');
            return;
        }
    }
    let pdfImage;
    try {
        const embedBytes = await normalizeImageForEmbed(
            decoded.bytes.buffer as ArrayBuffer,
            decoded.mimeType,
        );
        pdfImage = ctx.doc.embedImage(new Uint8Array(embedBytes));
    } catch {
        ctx.warnings.push(
            '<image> could not be decoded (unsupported or corrupt embedded image data) and was skipped',
        );
        return;
    }

    /*
     * "meet" (the default): scale uniformly so the image fits
     * entirely inside the SVG-specified box, centered — matches
     * the common case. "none" just stretches to the exact box,
     * no math needed.
     */
    let imgX = instruction.x;
    let imgY = instruction.y;
    let imgWidth = instruction.width;
    let imgHeight = instruction.height;
    if (instruction.preserveAspectRatio === 'meet') {
        const boxAspect = instruction.width / instruction.height;
        if (pdfImage.aspectRatio > boxAspect) {
            imgHeight = instruction.width / pdfImage.aspectRatio;
        } else {
            imgWidth = instruction.height * pdfImage.aspectRatio;
        }
        imgX = instruction.x + (instruction.width - imgWidth) / 2;
        imgY = instruction.y + (instruction.height - imgHeight) / 2;
    }

    ctx.link.include({ x: imgX, y: imgY, width: imgWidth, height: imgHeight }, currentMatrix);

    // Same Y-flip reasoning as `drawText`: an image XObject's pixel data has a fixed "top row is up" orientation, unlike a filled path.
    ctx.page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y)]);
    ctx.page.drawImage(pdfImage, {
        x: imgX,
        y: -(imgY + imgHeight),
        width: imgWidth,
        height: imgHeight,
        opacity: instruction.opacity,
    });
    ctx.page.drawOperators([ops.popGraphicsState()]);
};
