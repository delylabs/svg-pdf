import { ops } from '@libpdf/core';

import {
    computeViewBoxTransform,
    type ImageInstruction,
    type Matrix2D,
    multiplyMatrix,
    parseSvgDocument,
    translateMatrix,
} from '@svg-pdf/core';
import { decodeDataUri, EXTERNAL_URL_RE } from './dataUri';
import { buildDrawContext, concat, type DrawContext, FLIP_Y } from './drawContext';
import { runInstructions } from './drawInstructions';

/*
 * An SVG-as-image data URI can reference itself, directly or through a
 * longer cycle — `parseSvgDocument` resets each nested document's own id
 * namespace, so nothing else guards against this. Caps recursion instead
 * of letting it hang or overflow the call stack.
 */
const MAX_IMAGE_EMBED_DEPTH = 8;

const SVG_MIME_RE = /svg/i;
const SVG_TAG_RE = /^(?:\s|<!--[\s\S]*?-->|<\?xml[^>]*\?>|<!DOCTYPE[^>]*>)*<svg[\s>]/i;

/*
 * Payload is treated as an SVG document (drawn as real vector content, see
 * `drawSvgPayload`) when the fetched/decoded mime type says so, or — since
 * data URIs are often mislabeled or missing a mime type entirely — when
 * the decoded bytes themselves start with a `<svg` root tag once decoded
 * as UTF-8 text.
 */
const isSvgPayload = (bytes: Uint8Array, mimeType: string): boolean => {
    if (SVG_MIME_RE.test(mimeType)) return true;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return false;
    }
    return SVG_TAG_RE.test(text);
};

/*
 * Draws an `<image>` whose payload is itself an SVG document as real PDF
 * vector content instead of rasterizing it, so it stays sharp at any zoom.
 * Parses the payload as an independent second document (its own id
 * namespace, `<defs>`, and stylesheet — nothing from the outer document's
 * resolved resources leaks in) and replays its instructions into the same
 * page content stream, fit into the `<image>`'s box the same way a nested
 * `<svg>`/`<use>`-of-`<symbol>` fits into its own viewport in core's
 * `walk.ts` (offset + `computeViewBoxTransform`) — not `embed.ts`'s
 * page-root logic, which also Y-flips for landing on a Y-up PDF page, and
 * isn't needed here since we're already inside the outer Y-down instruction
 * space.
 */
const drawSvgPayload = async (
    svgBytes: Uint8Array,
    instruction: ImageInstruction,
    ctx: DrawContext,
    currentMatrix: Matrix2D,
): Promise<void> => {
    if (ctx.embedDepth >= MAX_IMAGE_EMBED_DEPTH) {
        ctx.warnings.push('<image> nesting too deep (possible self-reference) and was skipped');
        return;
    }

    let parsed;
    try {
        parsed = parseSvgDocument(new TextDecoder('utf-8').decode(svgBytes));
    } catch {
        ctx.warnings.push('<image> SVG payload could not be parsed and was skipped');
        return;
    }
    for (const warning of parsed.warnings) ctx.warnings.push(warning);

    const localMatrix = multiplyMatrix(
        computeViewBoxTransform(
            parsed.viewBoxMinX,
            parsed.viewBoxMinY,
            parsed.viewBoxWidth,
            parsed.viewBoxHeight,
            instruction.width,
            instruction.height,
            instruction.preserveAspectRatio === 'none' ? 'none' : 'xMidYMid meet',
        ),
        translateMatrix(instruction.x, instruction.y),
    );

    ctx.link.include(
        {
            x: instruction.x,
            y: instruction.y,
            width: instruction.width,
            height: instruction.height,
        },
        currentMatrix,
    );

    const nestedCtx = await buildDrawContext({
        doc: ctx.doc,
        page: ctx.page,
        warnings: ctx.warnings,
        gradients: parsed.gradients,
        patterns: parsed.patterns,
        markers: parsed.markers,
        rootMatrix: multiplyMatrix(localMatrix, currentMatrix),
        getBlendModeGsName: ctx.getBlendModeGsName,
        link: ctx.link,
        fetchImage: ctx.fetchImage,
        normalizeImage: ctx.normalizeImage,
        fetchFont: undefined,
        instructions: parsed.instructions,
        fontFaces: parsed.fontFaces,
        embedDepth: ctx.embedDepth + 1,
    });

    ctx.page.drawOperators([ops.pushGraphicsState(), concat(localMatrix)]);
    if (instruction.opacity < 1) {
        const gs = ctx.doc.createExtGState({
            fillOpacity: instruction.opacity,
            strokeOpacity: instruction.opacity,
        });
        ctx.page.drawOperators([ops.setGraphicsState(ctx.page.registerExtGState(gs))]);
    }
    await runInstructions(parsed.instructions, nestedCtx, nestedCtx.rootMatrix);
    ctx.page.drawOperators([ops.popGraphicsState()]);
};

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

    if (isSvgPayload(decoded.bytes, decoded.mimeType)) {
        await drawSvgPayload(decoded.bytes, instruction, ctx, currentMatrix);
        return;
    }

    let pdfImage;
    try {
        const embedBytes = await ctx.normalizeImage(decoded.bytes, decoded.mimeType);
        pdfImage = ctx.doc.embedImage(embedBytes);
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
