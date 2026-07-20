import {
    type EmbeddedFont,
    type FontInput,
    measureText,
    ops,
    type PDF as LibPDF,
    type PDFFormXObject,
} from '@libpdf/core';

import {
    type BBoxRect,
    type BlendMode,
    computePathBBox,
    computeViewBoxTransform,
    type FontFaceDef,
    invertMatrix,
    type MarkerDef,
    type Matrix2D,
    multiplyMatrix,
    parseSvgDocument,
    pointAtLength,
    scaleMatrix,
    type TextInstruction,
    translateMatrix,
} from '@delylabs/plotify';
import { buildMarkerFormXObject } from './marker';
import { normalizeImageForEmbed } from './normalizeImage';
import { fitImageToPage, type PageOrientation, resolvePageOrientation } from './pageGeometry';
import { resolvePaint, toPdfColor } from './paint';
import { normalizeRotation } from './rotation';

const concat = (m: Matrix2D) => ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

// Same rotation convention as core's own (private) `rotateMatrix` in geometry/matrix.ts — kept local here since it's only ever needed for a marker's `orient`-derived angle, not general transform parsing.
const rotationMatrix = (radians: number): Matrix2D => {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
};

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

/*
 * Matches a <text> run's requested font against a parsed `@font-face` def:
 * family compared case-insensitively (CSS itself is case-insensitive
 * here), weight/style compared as trimmed/lowercased strings — a simple,
 * literal match rather than real CSS font-matching (weight ranges,
 * `font-stretch`, etc.), consistent with this codebase's "common case,
 * not full CSS" scope everywhere else `font-weight`/`font-style` are read.
 */
const findFontFaceMatch = (
    fontFaces: readonly FontFaceDef[],
    fontFamily: string,
    fontWeight: string,
    fontStyle: string,
): FontFaceDef | null =>
    fontFaces.find(
        (face) =>
            face.fontFamily.toLowerCase() === fontFamily.trim().toLowerCase() &&
            face.fontWeight.trim().toLowerCase() === fontWeight.trim().toLowerCase() &&
            face.fontStyle.trim().toLowerCase() === fontStyle.trim().toLowerCase(),
    ) ?? null;

export interface EmbedSvgResult {
    readonly warnings: string[];
}

export type FetchImage = (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

// Asked once per distinct (fontFamily, fontWeight, fontStyle) combination actually used in the SVG — never per glyph or per run. Returning `null` (the default, if no matching font is available) falls back to the nearest standard-14 font, same as when no `fetchFont` is supplied at all.
export type FetchFont = (query: {
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
}) => Promise<Uint8Array | null>;

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
 *
 * Text is always drawn with one of PDF's 14 standard fonts unless the
 * caller supplies `fetchFont` — this function never assumes a font is
 * available beyond those 14. When `fetchFont` is given, it's asked once
 * per distinct font-family/weight/style combination actually used in the
 * SVG (see the pre-pass below); a `null` response, a throw, or no
 * `fetchFont` at all all fall back to the nearest standard-14 font the
 * same way `resolveStandardFont` in core already picks one.
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

    // Running x-cursor for <tspan>-without-its-own-x "flow" runs (see `continuesFlow`'s doc comment in svgCodec.ts) — only read when the next 'text' instruction is actually flagged, so unrelated text blocks never leak into each other.
    let flowCursorX: number | null = null;

    /*
     * `text-anchor` applies to a whole text chunk (every run back to the
     * last one with its own explicit x/y — see `startsNewChunk`'s doc
     * comment in types.ts), not to each run individually. A pre-pass groups
     * runs into chunks by document order (they're always contiguous in
     * `instructions`, since walkTextElement never interleaves a <text>
     * subtree's runs with any pushMatrix/popMatrix), measures each run once,
     * and computes one shared anchor offset per chunk from its total advance
     * width — the same two-pass "measure everything, then offset" shape
     * svg2pdf.js's TextChunk uses. The main loop below just looks the
     * results up instead of computing anchor offsets per run.
     *
     * The same pass also resolves each run's actual font, once per distinct
     * (fontFamily, fontWeight, fontStyle) combination (cached by that key,
     * not per instruction): first checked against any inline `@font-face`
     * (`src: url(data:...)`) parsed from the SVG's own `<style>` — no I/O
     * needed, it's already embedded in the document — then, if unmatched,
     * asked of the caller-supplied `fetchFont`. Either source's bytes are
     * embedded via `doc.embedFont()`, and the resulting `EmbeddedFont` is
     * used for both measurement and drawing instead of `instruction.font`'s
     * standard-14 fallback. A missing/failed font warns once per
     * combination and keeps the standard-14 fallback rather than failing
     * the whole document.
     */
    const textWidths = new WeakMap<TextInstruction, number>();
    const textAnchorOffsets = new WeakMap<TextInstruction, number>();
    const textFonts = new WeakMap<TextInstruction, FontInput>();
    {
        const embeddedFontCache = new Map<string, EmbeddedFont | null>();
        let chunk: TextInstruction[] = [];
        const flushChunk = (): void => {
            if (chunk.length === 0) return;
            const totalWidth = chunk.reduce((sum, run) => sum + (textWidths.get(run) ?? 0), 0);
            const offset =
                chunk[0].textAnchor === 'middle'
                    ? -totalWidth / 2
                    : chunk[0].textAnchor === 'end'
                      ? -totalWidth
                      : 0;
            for (const run of chunk) textAnchorOffsets.set(run, offset);
            chunk = [];
        };
        for (const instruction of instructions) {
            if (instruction.type !== 'text') continue;
            let font: FontInput = instruction.font;
            const key = `${instruction.fontFamily}${instruction.fontWeight}${instruction.fontStyle}`;
            if (!embeddedFontCache.has(key)) {
                let embedded: EmbeddedFont | null = null;
                const fontFace = findFontFaceMatch(
                    fontFaces,
                    instruction.fontFamily,
                    instruction.fontWeight,
                    instruction.fontStyle,
                );
                if (fontFace) {
                    const decoded = fontFace.dataUri ? decodeDataUri(fontFace.dataUri) : null;
                    if (decoded) {
                        try {
                            embedded = doc.embedFont(decoded.bytes);
                        } catch {
                            warnings.push(
                                `@font-face "${fontFace.fontFamily}" could not be embedded and was skipped; falling back to a standard font`,
                            );
                        }
                    } else {
                        warnings.push(
                            `@font-face "${fontFace.fontFamily}" src: data: URI could not be decoded and was skipped; falling back to a standard font`,
                        );
                    }
                } else if (fetchFont) {
                    try {
                        const bytes = await fetchFont({
                            fontFamily: instruction.fontFamily,
                            fontWeight: instruction.fontWeight,
                            fontStyle: instruction.fontStyle,
                        });
                        if (bytes) {
                            embedded = doc.embedFont(bytes);
                        } else {
                            warnings.push(
                                `No font was found for "${instruction.fontFamily}" (weight ${instruction.fontWeight}, style ${instruction.fontStyle}); falling back to a standard font`,
                            );
                        }
                    } catch {
                        warnings.push(
                            `Font "${instruction.fontFamily}" (weight ${instruction.fontWeight}, style ${instruction.fontStyle}) could not be embedded and was skipped; falling back to a standard font`,
                        );
                    }
                }
                embeddedFontCache.set(key, embedded);
            }
            const embedded = embeddedFontCache.get(key) ?? null;
            if (embedded) font = embedded;
            textFonts.set(instruction, font);
            /*
             * `letterSpacing`/`wordSpacing` are drawn via PDF's own `Tc`/`Tw`
             * text-state operators (see the 'text' case below), which add
             * their amount after every character/every literal space shown
             * respectively — mirroring that exactly here (rather than
             * approximating) keeps this measured width the same number PDF
             * will actually render at, so text-anchor/flow-cursor math
             * stays exact instead of drifting when spacing is non-zero.
             */
            const numSpaces = (instruction.text.match(/ /g) ?? []).length;
            const width =
                measureText(instruction.text, font, instruction.fontSize) +
                instruction.letterSpacing * instruction.text.length +
                instruction.wordSpacing * numSpaces;
            textWidths.set(instruction, width);
            if (instruction.startsNewChunk) flushChunk();
            chunk.push(instruction);
        }
        flushChunk();
    }

    // A <marker>'s Form XObject only needs building once (its content never varies per vertex) — cached by id, `null` remembered too so a marker that failed to build (e.g. zero markerWidth/markerHeight) isn't retried at every vertex.
    const markerXObjects = new Map<string, PDFFormXObject | null>();
    const getMarkerXObject = (markerId: string, def: MarkerDef): PDFFormXObject | null => {
        if (markerXObjects.has(markerId)) return markerXObjects.get(markerId) ?? null;
        const xobject = buildMarkerFormXObject(def, doc, warnings);
        markerXObjects.set(markerId, xobject);
        return xobject;
    };

    /*
     * Mirrors core's own `accMatrix` accumulation (see `walk.ts`'s
     * `elMatrix`/`groupMatrix`) on this side of the fence: `pushMatrix`/
     * `popMatrix` instructions are the only things that change the ambient
     * transform a shape/text/image instruction's local coordinates are
     * drawn under, so tracking them here gives the exact matrix PDF's own
     * CTM has active at that instruction — needed to turn an `<a>`'s
     * wrapped content into one absolute, page-space `Rect` for
     * `addLinkAnnotation` (annotations aren't part of the content stream,
     * so they can't just inherit the CTM the way a `drawSvgPath`/`drawText`
     * call does).
     */
    let currentMatrix: Matrix2D = rootMatrix;
    const matrixStack: Matrix2D[] = [];
    const transformPoint = (m: Matrix2D, x: number, y: number): { x: number; y: number } => ({
        x: m.a * x + m.c * y + m.e,
        y: m.b * x + m.d * y + m.f,
    });

    // Open `<a>` link's accumulating page-space bbox — `null` when no link is currently open. Only one at a time: nested `<a>` isn't meaningful content, so a stray nested `linkStart` flushes the outer one first rather than losing it.
    let openLink: { href: string; minX: number; minY: number; maxX: number; maxY: number } | null =
        null;
    const includeLinkBBox = (localBBox: BBoxRect): void => {
        if (!openLink) return;
        const corners = [
            [localBBox.x, localBBox.y],
            [localBBox.x + localBBox.width, localBBox.y],
            [localBBox.x, localBBox.y + localBBox.height],
            [localBBox.x + localBBox.width, localBBox.y + localBBox.height],
        ];
        for (const [x, y] of corners) {
            const p = transformPoint(currentMatrix, x, y);
            openLink.minX = Math.min(openLink.minX, p.x);
            openLink.minY = Math.min(openLink.minY, p.y);
            openLink.maxX = Math.max(openLink.maxX, p.x);
            openLink.maxY = Math.max(openLink.maxY, p.y);
        }
    };
    const flushLink = (): void => {
        if (!openLink) return;
        const { href, minX, minY, maxX, maxY } = openLink;
        if (maxX > minX && maxY > minY) {
            page.addLinkAnnotation({
                rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
                uri: href,
            });
        }
        openLink = null;
    };

    for (const instruction of instructions) {
        switch (instruction.type) {
            case 'pushMatrix':
                page.drawOperators([ops.pushGraphicsState(), concat(instruction.matrix)]);
                matrixStack.push(currentMatrix);
                currentMatrix = multiplyMatrix(instruction.matrix, currentMatrix);
                break;
            case 'popMatrix':
                page.drawOperators([ops.popGraphicsState()]);
                currentMatrix = matrixStack.pop() ?? rootMatrix;
                break;
            case 'linkStart':
                flushLink();
                openLink = {
                    href: instruction.href,
                    minX: Infinity,
                    minY: Infinity,
                    maxX: -Infinity,
                    maxY: -Infinity,
                };
                break;
            case 'linkEnd':
                flushLink();
                break;
            case 'shape': {
                /*
                 * Included regardless of fill/stroke — an invisible
                 * `fill="none"` shape wrapped in an `<a>` is a common
                 * real-world "transparent clickable overlay" pattern, and
                 * its geometry (not its paint) is what defines the
                 * intended clickable region.
                 */
                if (openLink) {
                    const localBBox = computePathBBox(instruction.d);
                    if (localBBox) includeLinkBBox(localBBox);
                }
                if (!instruction.fill && !instruction.stroke) break;
                const fill = resolvePaint(
                    instruction.fill,
                    doc,
                    gradients,
                    patterns,
                    instruction.groupMatrix,
                    rootMatrix,
                    instruction.bbox,
                    warnings,
                );
                const stroke = resolvePaint(
                    instruction.stroke,
                    doc,
                    gradients,
                    patterns,
                    instruction.groupMatrix,
                    rootMatrix,
                    instruction.bbox,
                    warnings,
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
                const textWidth = textWidths.get(instruction) ?? 0;
                const startX: number =
                    instruction.continuesFlow && flowCursorX !== null ? flowCursorX : instruction.x;
                flowCursorX = startX + textWidth;
                const anchorOffsetX = textAnchorOffsets.get(instruction) ?? 0;
                /*
                 * No real glyph ascent/descent metrics are threaded through
                 * here (same "no library-specific font math in the shared
                 * path" reasoning as elsewhere) — approximated the same way
                 * @libpdf/core's own `drawText` rotate-bounds math does for
                 * a standard font (ascent ~0.8em above baseline, descent
                 * ~0.2em below), which is only ever used for a link's
                 * clickable-area estimate, not for anything pixel-exact.
                 */
                if (openLink) {
                    includeLinkBBox({
                        x: startX + anchorOffsetX,
                        y: instruction.y - instruction.fontSize * 0.8,
                        width: textWidth,
                        height: instruction.fontSize,
                    });
                }
                const spacingOps = [
                    ...(instruction.letterSpacing !== 0
                        ? [ops.setCharSpacing(instruction.letterSpacing)]
                        : []),
                    ...(instruction.wordSpacing !== 0
                        ? [ops.setWordSpacing(instruction.wordSpacing)]
                        : []),
                ];
                // Tc/Tw are text-state parameters, saved/restored by q/Q same as any other graphics state — scoping them inside this instruction's own push/pop bracket means drawText() (which pushes its own nested q/Q but never touches Tc/Tw itself) still inherits them for its Tj call, with no explicit reset needed after.
                page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y), ...spacingOps]);
                page.drawText(instruction.text, {
                    x: startX + anchorOffsetX,
                    y: -instruction.y,
                    font: textFonts.get(instruction) ?? instruction.font,
                    size: instruction.fontSize,
                    color: toPdfColor(instruction.fill),
                    opacity: instruction.fillOpacity,
                });
                page.drawOperators([ops.popGraphicsState()]);
                break;
            }
            case 'textPath': {
                /*
                 * Unlike a plain 'text' run (one string, one Tj), each
                 * character here needs its own position *and* rotation (the
                 * path's tangent at that point), so it's drawn with its own
                 * drawText() call instead of PDF's native Tc/Tw spacing
                 * operators — letterSpacing/wordSpacing are folded straight
                 * into how far `dist` advances between characters instead.
                 * No fetchFont/@font-face lookup here (kept to
                 * `instruction.font`'s standard-14 fallback only) — a
                 * deliberate scope trim, not a technical limitation.
                 */
                const chars = Array.from(instruction.text);
                const charWidths = chars.map((ch) =>
                    measureText(ch, instruction.font, instruction.fontSize),
                );
                const totalAdvance =
                    charWidths.reduce((sum, w) => sum + w, 0) +
                    instruction.letterSpacing * chars.length +
                    instruction.wordSpacing * chars.filter((ch) => ch === ' ').length;
                const anchorShift =
                    instruction.textAnchor === 'middle'
                        ? -totalAdvance / 2
                        : instruction.textAnchor === 'end'
                          ? -totalAdvance
                          : 0;
                let dist = instruction.startDistance + anchorShift;
                for (let i = 0; i < chars.length; i++) {
                    const ch = chars[i];
                    const charWidth = charWidths[i];
                    const point = pointAtLength(instruction.points, instruction.cumLengths, dist);
                    if (point) {
                        /*
                         * Same Y-flip reasoning as 'text' above, applied to
                         * both position and angle: this bracket's FLIP_Y
                         * mirrors whatever's drawn inside it, so a tangent
                         * angle computed in the un-flipped local space (`atan2`
                         * in Y-down coordinates) has to be negated here to
                         * still point the right way once mirrored back.
                         */
                        page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y)]);
                        page.drawText(ch, {
                            x: point.x,
                            y: -point.y,
                            rotate: { angle: -(point.angle * 180) / Math.PI },
                            font: instruction.font,
                            size: instruction.fontSize,
                            color: toPdfColor(instruction.fill),
                            opacity: instruction.fillOpacity,
                        });
                        page.drawOperators([ops.popGraphicsState()]);
                    }
                    dist +=
                        charWidth +
                        instruction.letterSpacing +
                        (ch === ' ' ? instruction.wordSpacing : 0);
                }
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

                if (openLink) {
                    includeLinkBBox({ x: imgX, y: imgY, width: imgWidth, height: imgHeight });
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
            case 'marker': {
                const def = markers.get(instruction.markerId);
                if (!def) break;
                const xobject = getMarkerXObject(instruction.markerId, def);
                if (!xobject) break;
                const xobjectName = page.registerXObject(xobject);
                /*
                 * Painted through an ordinary cm/Do pair, so (unlike a
                 * gradient/pattern fill) it just inherits whatever CTM the
                 * surrounding pushMatrix instructions already established —
                 * no groupMatrix/rootMatrix needed here, same reasoning as
                 * why a 'shape' instruction's own `d` draws untransformed.
                 */
                const placementMatrix = multiplyMatrix(
                    scaleMatrix(instruction.scale),
                    multiplyMatrix(
                        rotationMatrix(instruction.angle),
                        translateMatrix(instruction.x, instruction.y),
                    ),
                );
                page.drawOperators([
                    ops.pushGraphicsState(),
                    concat(placementMatrix),
                    ops.paintXObject(xobjectName),
                    ops.popGraphicsState(),
                ]);
                break;
            }
        }
    }
    // Defensive only — a well-formed instruction stream always closes every `linkStart` with a `linkEnd` before the loop ends.
    flushLink();

    page.drawOperators([ops.popGraphicsState()]);

    if (rotation !== 0) {
        page.setRotation(normalizeRotation(rotation));
    }

    return { warnings };
};
