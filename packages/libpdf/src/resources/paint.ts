import { type PDF as LibPDF, type PDFPattern, rgb } from '@libpdf/core';

import {
    IDENTITY_MATRIX,
    type BBoxRect,
    type GradientDef,
    type Matrix2D,
    multiplyMatrix,
    type Paint,
    type PatternDef,
    type RgbColor,
} from '@svg-pdf/core';
import { resolvePatternFill } from './pattern';

export const toPdfColor = (color: RgbColor) => rgb(color.r / 255, color.g / 255, color.b / 255);

/*
 * @libpdf/core's shading-function builder always spans the *entire* [0,1]
 * function domain across whatever stops it's given — it has no notion of SVG
 * gradient "pad" extend behavior (holding the first/last stop's color solid
 * outside the stops' own offset range). A stop list that doesn't itself start
 * at 0 and end at 1 (extremely common in real SVGs — e.g. Illustrator often
 * exports offsets like 0.1..0.9) makes it blend color across the *whole*
 * page-space span of the gradient instead of holding solid before the first/
 * after the last stop, per spec. Padding with synthetic stops at 0/1 (same
 * color as the nearest real stop) reproduces the correct pad behavior using
 * only the stops-list API @libpdf/core exposes.
 */
const withPaddedDomain = <T extends { readonly offset: number }>(stops: readonly T[]): T[] => {
    if (stops.length === 0) return [...stops];
    const first = stops[0];
    const last = stops[stops.length - 1];
    return [
        ...(first.offset > 0 ? [{ ...first, offset: 0 }] : []),
        ...stops,
        ...(last.offset < 1 ? [{ ...last, offset: 1 }] : []),
    ];
};

/*
 * @libpdf/core's shading-function builder also creates one PDF Type 2
 * (exponential) sub-function per consecutive pair of stops, with each stop's
 * own offset feeding directly into the Bounds array as a sub-domain boundary
 * — a PDF Type 3 (stitching) function's Domain/Bounds must be *strictly*
 * increasing, so two stops sharing the exact same offset (a legitimate SVG
 * "hard stop" — either authored directly, or produced by `@svg-pdf/core`'s
 * own spec-mandated clamping of out-of-order offsets up to the previous
 * stop's) produces a zero-width sub-domain whose Bounds entries collide,
 * which real PDF viewers handle unpredictably. Nudging a duplicate offset up
 * by a tiny epsilon keeps the same visual result — the transition still
 * happens well within a single output pixel at any realistic render scale —
 * while keeping every sub-domain's bounds distinct; the same technique other
 * SVG-to-PDF tools use to represent a hard gradient stop in PDF. Needs to
 * survive `@libpdf/core`'s own number serialization, which rounds every PDF
 * number to 5 decimal places (`toFixed(5)`) — an epsilon smaller than that
 * (e.g. 1e-6) gets rounded straight back to the original, duplicate value.
 */
const MIN_STOP_GAP = 1e-4;
const withStrictlyIncreasingOffsets = <T extends { readonly offset: number }>(
    stops: readonly T[],
): T[] => {
    const result: T[] = [];
    for (const stop of stops) {
        const previous = result[result.length - 1];
        const offset =
            previous && stop.offset <= previous.offset
                ? Math.min(1, previous.offset + MIN_STOP_GAP)
                : stop.offset;
        result.push(offset === stop.offset ? stop : { ...stop, offset });
    }
    return result;
};

const normalizeGradientStops = <T extends { readonly offset: number }>(stops: readonly T[]): T[] =>
    withStrictlyIncreasingOffsets(withPaddedDomain(stops));

/*
 * A shading pattern's matrix maps to the PDF page's *default* coordinate
 * system, unlike a solid color, which just inherits whatever `cm`s are
 * currently on the graphics-state stack. So instead of relying on the nested
 * pushGraphicsState()/concatMatrix() brackets in embed.ts
 * (`instruction.groupMatrix`), gradients need their own matrix baked in
 * explicitly: gradientTransform, then (for the default objectBoundingBox
 * units) a scale/translate into the shape's own bbox, then the shape's
 * accumulated group matrix, then the root viewBox-to-page matrix — see
 * `@svg-pdf/core`'s `ShapeInstruction` doc.
 */
const buildPatternMatrix = (
    gradientDef: GradientDef,
    groupMatrix: Matrix2D,
    rootMatrix: Matrix2D,
    bbox: BBoxRect | null,
): Matrix2D => {
    const unitsMatrix: Matrix2D =
        gradientDef.gradientUnits === 'userSpaceOnUse' || !bbox
            ? IDENTITY_MATRIX
            : {
                  a: bbox.width,
                  b: 0,
                  c: 0,
                  d: bbox.height,
                  e: bbox.x,
                  f: bbox.y,
              };
    return multiplyMatrix(
        gradientDef.gradientTransform,
        multiplyMatrix(unitsMatrix, multiplyMatrix(groupMatrix, rootMatrix)),
    );
};

export interface ResolvedPaint {
    readonly color?: ReturnType<typeof rgb>;
    readonly pattern?: PDFPattern;
}

// Resolves a shape's fill/stroke `Paint` into either a solid PDF color or a shading/tiling pattern.
export const resolvePaint = (
    paint: Paint,
    doc: LibPDF,
    gradients: ReadonlyMap<string, GradientDef>,
    patterns: ReadonlyMap<string, PatternDef>,
    groupMatrix: Matrix2D,
    rootMatrix: Matrix2D,
    bbox: BBoxRect | null,
    warnings: string[],
): ResolvedPaint | null => {
    if (paint === null) return null;
    if (typeof paint === 'object' && 'kind' in paint) {
        if (paint.kind === 'gradient') {
            const def = gradients.get(paint.gradientId);
            if (!def) return null;
            const stops = normalizeGradientStops(
                def.stops.map((stop) => ({
                    offset: stop.offset,
                    color: toPdfColor(stop.color),
                })),
            );
            const shading =
                def.type === 'linear'
                    ? doc.createAxialShading({ coords: [...def.coords], stops })
                    : doc.createRadialShading({ coords: [...def.coords], stops });
            const matrix = buildPatternMatrix(def, groupMatrix, rootMatrix, bbox);
            const pattern = doc.createShadingPattern({
                shading,
                matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
            });
            return { pattern };
        }
        const def = patterns.get(paint.patternId);
        if (!def) return null;
        const pattern = resolvePatternFill(def, doc, groupMatrix, rootMatrix, bbox, warnings);
        if (!pattern) return null;
        return { pattern };
    }
    return { color: toPdfColor(paint) };
};
