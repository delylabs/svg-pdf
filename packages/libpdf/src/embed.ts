import { ops, type PDF as LibPDF } from '@libpdf/core';

import {
    type BlendMode,
    computeViewBoxTransform,
    type Matrix2D,
    multiplyMatrix,
    parseSvgDocument,
    scaleMatrix,
    translateMatrix,
} from '@svg-pdf/core';
import { buildDrawContext, concat } from './draw/drawContext';
import { runInstructions } from './draw/drawInstructions';
import { createLinkTracker } from './draw/linkAnnotations';
import { normalizeImageForEmbed } from './normalizeImage';
import { fitImageToPage, type PageOrientation, resolvePageOrientation } from './pageGeometry';
import { normalizeRotation } from './rotation';

export interface EmbedSvgResult {
    readonly warnings: string[];
}

export type FetchImage = (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

// Called once per decoded `<image>` whose bytes aren't already JPEG/PNG. See `embedSvgInPdf`'s doc comment for the default (`normalizeImageForEmbed`) and when a caller needs to supply their own.
export type NormalizeImage = (bytes: Uint8Array, mimeType: string) => Promise<Uint8Array>;

// Asked once per distinct (fontFamily, fontWeight, fontStyle) combination actually used in the SVG — never per glyph or per run. Returning `null` (the default, if no matching font is available) falls back to the nearest standard-14 font, same as when no `fetchFont` is supplied at all.
export type FetchFont = (query: {
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
}) => Promise<Uint8Array | null>;

/**
 * Embeds an SVG as a genuine PDF vector graphic (not a rasterized image) —
 * every shape becomes real PDF path-fill/stroke operators, so it stays sharp
 * at any zoom level. See `@svg-pdf/core` for what SVG features are parsed.
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
 *
 * A decoded `<image>`'s bytes are only ever embedded directly if they're
 * already JPEG/PNG (what `@libpdf/core`'s `embedImage` understands) —
 * anything else (WebP, ...) goes through `normalizeImage` first, which
 * defaults to `normalizeImageForEmbed` (re-encodes via `OffscreenCanvas`,
 * available in a browser or worker with no extra dependency). In Node
 * (no `OffscreenCanvas`), that default throws instead, which is caught
 * and turned into a skipped-with-warning image, same as any other decode
 * failure — pass a `normalizeImage` function (e.g. one wrapping `sharp`)
 * to support non-JPEG/PNG images there.
 *
 * Text is always drawn with one of PDF's 14 standard fonts unless the
 * caller supplies `fetchFont` — this function never assumes a font is
 * available beyond those 14. When `fetchFont` is given, it's asked once
 * per distinct font-family/weight/style combination actually used in the
 * SVG (see `resolveTextLayout`); a `null` response, a throw, or no
 * `fetchFont` at all all fall back to the nearest standard-14 font the
 * same way `resolveStandardFont` in core already picks one.
 *
 * The main loop below stays a plain instruction dispatcher: matrix/clip/
 * link bookkeeping (`pushMatrix`/`popMatrix`/`linkStart`/`linkEnd`/
 * `pushClip`/`popClip`) is short enough to stay inline, while the five
 * content-drawing instruction types each delegate to their own `draw*`
 * module (`drawShape.ts`, `drawText.ts`, `drawTextPath.ts`, `drawImage.ts`,
 * `drawMarker.ts`), sharing state through the `DrawContext` built below.
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
        fetchFont?: FetchFont;
        normalizeImage?: NormalizeImage;
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
        fetchFont,
        normalizeImage = normalizeImageForEmbed,
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
        viewBoxHeight,
        preserveAspectRatio,
        instructions,
        warnings,
        gradients,
        patterns,
        markers,
        fontFaces,
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
     * Maps viewBox space onto the fitted draw box, honoring the root <svg>'s
     * own `preserveAspectRatio` (default "xMidYMid meet" — uniform scale,
     * centered, whole viewBox visible) via the same `computeViewBoxTransform`
     * used for `<use>`-of-`<symbol>` and nested <svg> in core. Divides by
     * `viewBoxWidth`/`viewBoxHeight` (the coordinate system shapes/text/
     * images are actually positioned in), not the display `width`/`height`
     * — those two can differ hugely (e.g. `width="297mm" viewBox="0 0 29700
     * 21000"`); dividing by the wrong one still "runs" but silently zooms
     * into one corner of the artwork instead of fitting all of it onto the
     * page. The result lands in a (0,0)-(drawWidth,drawHeight) local box,
     * still Y-down like viewBox space — `pageMatrix` then flips Y and
     * offsets to the draw box's actual position in PDF's Y-up page space.
     */
    const viewBoxToBoxMatrix = computeViewBoxTransform(
        viewBoxMinX,
        viewBoxMinY,
        viewBoxWidth,
        viewBoxHeight,
        drawWidth,
        drawHeight,
        preserveAspectRatio,
    );
    const pageMatrix = multiplyMatrix(
        scaleMatrix(1, -1),
        translateMatrix(drawX, drawY + drawHeight),
    );
    const rootMatrix: Matrix2D = multiplyMatrix(viewBoxToBoxMatrix, pageMatrix);

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

    const ctx = await buildDrawContext({
        doc,
        page,
        warnings,
        gradients,
        patterns,
        markers,
        rootMatrix,
        getBlendModeGsName,
        link: createLinkTracker(page),
        fetchImage,
        normalizeImage,
        fetchFont,
        instructions,
        fontFaces,
        embedDepth: 0,
    });

    await runInstructions(instructions, ctx, rootMatrix);

    page.drawOperators([ops.popGraphicsState()]);

    if (rotation !== 0) {
        page.setRotation(normalizeRotation(rotation));
    }

    return { warnings };
};
