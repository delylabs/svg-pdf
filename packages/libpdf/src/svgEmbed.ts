import { measureText, ops, type PDF as LibPDF } from '@libpdf/core';

import { type BlendMode, invertMatrix, type Matrix2D, parseSvgDocument } from '@delylabs/plotify';
import { normalizeImageForEmbed } from './normalizeImage';
import { fitImageToPage, type PageOrientation, resolvePageOrientation } from './pageGeometry';
import { resolvePaint, toPdfColor } from './paint';
import { normalizeRotation } from './rotation';

const concat = (m: Matrix2D) => ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

// Counter-flips the ambient CTM's inherited Y-flip for anything (text glyphs, image XObjects) whose own "up" direction isn't transform-agnostic like a filled path is — see the doc comments at each call site.
const FLIP_Y: Matrix2D = { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };

const DATA_URI_RE = /^data:([^;,]*);base64,([\s\S]*)$/;

// Decodes a `data:<mime>;base64,<payload>` URI into raw bytes. Returns `null` for anything else (missing/invalid base64) — the caller turns that into a skip-with-warning.
const decodeDataUri = (href: string): { bytes: Uint8Array; mimeType: string } | null => {
    const match = DATA_URI_RE.exec(href);
    if (!match) return null;
    const [, mimeType, base64] = match;
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return { bytes, mimeType: mimeType || 'image/png' };
    } catch {
        return null;
    }
};

// Only http(s) is ever handed to `fetchImage` — a defense-in-depth check independent of whatever the caller's own fetcher does, so a malformed/unexpected href scheme (e.g. `file:`) can never reach it.
const EXTERNAL_URL_RE = /^https?:\/\//i;

export interface EmbedSvgResult {
    readonly warnings: string[];
}

export type FetchImage = (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

/**
 * Embeds an SVG as a genuine PDF vector graphic (not a rasterized image) —
 * every shape becomes real PDF path-fill/stroke operators, so it stays sharp
 * at any zoom level. See `@delylabs/plotify-core` for what SVG features are parsed.
 *
 * Positioning works by pushing one root matrix that maps the SVG's viewBox
 * straight onto the page's fitted/centered draw box (scale + Y-flip + origin
 * offset combined), then replaying each nested `<g>`/`<use>` transform as its
 * own `pushGraphicsState()`/`concatMatrix()`/`popGraphicsState()` bracket —
 * PDF's own graphics-state stack accumulates these exactly like nested SVG
 * groups do, so no per-shape matrix math is needed here at all.
 *
 * `<image>` elements with an external (http/https) `href` are only ever
 * fetched if the caller supplies `fetchImage` — this function never makes
 * a network request on its own. That's a deliberate safety default: a
 * server processing untrusted, user-supplied SVGs that blindly fetched
 * every `<image href="...">` would be an SSRF vector (e.g. reaching a
 * cloud metadata endpoint or an internal-only service). Callers that know
 * their own trust boundary can pass a `fetchImage` that wraps a plain
 * `fetch`, or one with an allowlist/timeout/proxy layered on top.
 */
export const embedSvgInPdf = async (
    doc: LibPDF,
    svg: {
        svgText: string;
        rotation: number;
        name?: string;
        pageSize?: { width: number; height: number };
        orientation?: PageOrientation;
        margin?: number;
        fetchImage?: FetchImage;
    },
): Promise<EmbedSvgResult> => {
    const {
        svgText,
        rotation,
        name,
        pageSize,
        orientation = 'portrait',
        margin = 0,
        fetchImage,
    } = svg;

    let parsed;
    try {
        parsed = parseSvgDocument(svgText);
    } catch (e) {
        throw new Error(`FILE_CORRUPT_OR_INVALID: ${name || 'Unknown SVG'}`, {
            cause: e,
        });
    }

    const {
        width,
        height,
        viewBoxMinX,
        viewBoxMinY,
        viewBoxWidth,
        instructions,
        warnings,
        gradients,
    } = parsed;

    const resolvedPageSize = pageSize
        ? resolvePageOrientation(pageSize, orientation, width, height)
        : undefined;
    const { pageWidth, pageHeight, drawX, drawY, drawWidth, drawHeight } = fitImageToPage(
        width,
        height,
        resolvedPageSize,
        margin,
    );

    const page = doc.addPage({ width: pageWidth, height: pageHeight });

    /*
     * Workaround: @libpdf/core's PDFPage.appendContent() isolates the page's
     * very first drawOperators()/drawSvgPath() call by wrapping it in its own
     * q/Q as soon as a second call arrives (meant for "add a watermark over
     * existing content" use, so the new content can't inherit a stray CTM) —
     * see node_modules/@libpdf/core/dist/index.mjs's appendContent(). That
     * silently discards our root viewBox-to-page matrix below, since it's
     * always this page's first call. A no-op first call absorbs that
     * isolation instead, so the real root matrix (now the *second* call)
     * survives and composes normally with every nested <g>/shape after it.
     */
    page.drawOperators([ops.pushGraphicsState(), ops.popGraphicsState()]);

    /*
     * Maps viewBox space (Y-down) onto the fitted draw box in PDF space (Y-up):
     * scale uniformly, negate d to flip Y, then offset so the viewBox's
     * top-left lands on the draw box's top-left (drawY + drawHeight, since
     * PDF Y grows up). Divides by `viewBoxWidth` (the coordinate system
     * shapes/text/images are actually positioned in), not the display
     * `width` — those two can differ hugely (e.g. `width="297mm"
     * viewBox="0 0 29700 21000"`); dividing by the wrong one still "runs"
     * but silently zooms into one corner of the artwork instead of fitting
     * all of it onto the page.
     */
    const scale = viewBoxWidth > 0 ? drawWidth / viewBoxWidth : 1;
    const rootMatrix: Matrix2D = {
        a: scale,
        b: 0,
        c: 0,
        d: -scale,
        e: drawX - scale * viewBoxMinX,
        f: drawY + drawHeight + scale * viewBoxMinY,
    };

    page.drawOperators([ops.pushGraphicsState(), concat(rootMatrix)]);

    // Blend mode isn't a drawSvgPath() option — it needs its own ExtGState, cached so repeated modes reuse one resource.
    const blendModeGsNames = new Map<BlendMode, string>();
    const getBlendModeGsName = (mode: BlendMode): string => {
        const cached = blendModeGsNames.get(mode);
        if (cached) return cached;
        const name = page.registerExtGState(doc.createExtGState({ blendMode: mode }));
        blendModeGsNames.set(mode, name);
        return name;
    };

    // Running x-cursor for <tspan>-without-its-own-x "flow" runs (see `continuesFlow`'s doc comment in svgCodec.ts) — only read when the next 'text' instruction is actually flagged, so unrelated text blocks never leak into each other.
    let flowCursorX: number | null = null;

    for (const instruction of instructions) {
        switch (instruction.type) {
            case 'pushMatrix':
                page.drawOperators([ops.pushGraphicsState(), concat(instruction.matrix)]);
                break;
            case 'popMatrix':
                page.drawOperators([ops.popGraphicsState()]);
                break;
            case 'shape': {
                if (!instruction.fill && !instruction.stroke) break;
                const fill = resolvePaint(
                    instruction.fill,
                    doc,
                    gradients,
                    instruction.groupMatrix,
                    rootMatrix,
                    instruction.bbox,
                );
                const stroke = resolvePaint(
                    instruction.stroke,
                    doc,
                    gradients,
                    instruction.groupMatrix,
                    rootMatrix,
                    instruction.bbox,
                );
                const hasBlendMode = instruction.blendMode !== 'Normal';
                if (hasBlendMode) {
                    page.drawOperators([
                        ops.pushGraphicsState(),
                        ops.setGraphicsState(getBlendModeGsName(instruction.blendMode)),
                    ]);
                }
                page.drawSvgPath(instruction.d, {
                    x: 0,
                    y: 0,
                    scale: 1,
                    flipY: false,
                    windingRule: instruction.fillRule,
                    ...(fill?.pattern
                        ? {
                              pattern: fill.pattern,
                              opacity: instruction.fillOpacity,
                          }
                        : fill?.color
                          ? {
                                color: fill.color,
                                opacity: instruction.fillOpacity,
                            }
                          : {}),
                    ...(stroke && {
                        borderWidth: instruction.strokeWidth,
                        borderOpacity: instruction.strokeOpacity,
                        lineCap: instruction.lineCap,
                        lineJoin: instruction.lineJoin,
                        ...(instruction.dashArray && {
                            dashArray: [...instruction.dashArray],
                            dashPhase: instruction.dashOffset,
                        }),
                        ...(stroke.pattern
                            ? { borderPattern: stroke.pattern }
                            : { borderColor: stroke.color }),
                    }),
                });
                if (hasBlendMode) {
                    page.drawOperators([ops.popGraphicsState()]);
                }
                break;
            }
            case 'pushClip': {
                page.drawOperators([ops.pushGraphicsState()]);
                if (instruction.bboxMatrix) {
                    page.drawOperators([concat(instruction.bboxMatrix)]);
                }
                let pathBuilder = page.drawPath();
                for (const d of instruction.paths) {
                    pathBuilder = pathBuilder.appendSvgPath(d, {
                        flipY: false,
                    });
                }
                if (instruction.clipRule === 'evenodd') {
                    pathBuilder.clipEvenOdd();
                } else {
                    pathBuilder.clip();
                }
                // `W`/`W*` alone only sets the clip flag; `n` ends the path as a no-op paint.
                page.drawOperators([ops.endPath()]);
                if (instruction.bboxMatrix) {
                    page.drawOperators([concat(invertMatrix(instruction.bboxMatrix))]);
                }
                break;
            }
            case 'popClip':
                page.drawOperators([ops.popGraphicsState()]);
                break;
            case 'text': {
                /*
                 * The ambient CTM here already has an odd number of Y-flips
                 * baked in (from rootMatrix's viewBox-to-page mapping, plus
                 * whatever nested <g> transforms did). That's harmless for
                 * filled paths — flipping the points that define a shape
                 * still reproduces the same shape — but a font glyph is
                 * drawn upright in its own space regardless of the CTM, so
                 * without correction text would render upside-down/mirrored.
                 * A local counter Y-flip right here cancels exactly that,
                 * while still inheriting any real rotation from ancestors.
                 */
                const textWidth = measureText(
                    instruction.text,
                    instruction.font,
                    instruction.fontSize,
                );
                const startX: number =
                    instruction.continuesFlow && flowCursorX !== null ? flowCursorX : instruction.x;
                flowCursorX = startX + textWidth;
                const anchorOffsetX =
                    instruction.textAnchor === 'middle'
                        ? -textWidth / 2
                        : instruction.textAnchor === 'end'
                          ? -textWidth
                          : 0;
                page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y)]);
                page.drawText(instruction.text, {
                    x: startX + anchorOffsetX,
                    y: -instruction.y,
                    font: instruction.font,
                    size: instruction.fontSize,
                    color: toPdfColor(instruction.fill),
                    opacity: instruction.fillOpacity,
                });
                page.drawOperators([ops.popGraphicsState()]);
                break;
            }
            case 'image': {
                let decoded = decodeDataUri(instruction.href);
                if (!decoded) {
                    const isExternal = EXTERNAL_URL_RE.test(instruction.href);
                    if (!isExternal) {
                        warnings.push('<image> data: URI could not be decoded and was skipped');
                        break;
                    }
                    if (!fetchImage) {
                        warnings.push(
                            '<image> with an external URL was skipped (no fetchImage function was provided)',
                        );
                        break;
                    }
                    try {
                        decoded = await fetchImage(instruction.href);
                    } catch {
                        decoded = null;
                    }
                    if (!decoded) {
                        warnings.push('<image> external URL could not be fetched and was skipped');
                        break;
                    }
                }
                let pdfImage;
                try {
                    const embedBytes = await normalizeImageForEmbed(
                        decoded.bytes.buffer as ArrayBuffer,
                        decoded.mimeType,
                    );
                    pdfImage = doc.embedImage(new Uint8Array(embedBytes));
                } catch {
                    warnings.push(
                        '<image> could not be decoded (unsupported or corrupt embedded image data) and was skipped',
                    );
                    break;
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

                // Same Y-flip reasoning as 'text' above: an image XObject's pixel data has a fixed "top row is up" orientation, unlike a filled path.
                page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y)]);
                page.drawImage(pdfImage, {
                    x: imgX,
                    y: -(imgY + imgHeight),
                    width: imgWidth,
                    height: imgHeight,
                    opacity: instruction.opacity,
                });
                page.drawOperators([ops.popGraphicsState()]);
                break;
            }
        }
    }

    page.drawOperators([ops.popGraphicsState()]);

    if (rotation !== 0) {
        page.setRotation(normalizeRotation(rotation));
    }

    return { warnings };
};
