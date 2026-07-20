import { ops, type PDF as LibPDF, type PDFFormXObject } from '@libpdf/core';

import {
    computePathBBox,
    isIdentityMatrix,
    type MarkerDef,
    type Matrix2D,
    multiplyMatrix,
    scaleMatrix,
    translateMatrix,
} from '@delylabs/plotify';
import { appendCellInstructions } from './cellOperators';

const concat = (m: Matrix2D) => ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

const transformPoint = (x: number, y: number, m: Matrix2D): [number, number] => [
    x * m.a + y * m.c + m.e,
    x * m.b + y * m.d + m.f,
];

/*
 * Turns a resolved <marker> into a reusable `@libpdf/core` Form XObject.
 *
 * Unlike a tiling pattern, a Form XObject is painted through an ordinary
 * `cm`/`Do` pair in the *page's own* content stream (see `svgEmbed.ts`'s
 * `'marker'` case) — so it inherits whatever CTM is active there just like
 * any other draw call, and can be positioned/rotated/scaled freely per use.
 * That means, unlike `pattern.ts`'s `resolvePatternFill`, there's no
 * axis-aligned-only restriction here: this function only has to build the
 * marker's own *internal* content once (shared across every vertex it's
 * used at); per-vertex placement (anchor, `orient`-derived angle,
 * markerUnits scale) is entirely `svgEmbed.ts`'s concern.
 *
 * `@libpdf/core`'s `FormXObjectOptions` has the same `{bbox, operators}`
 * shape as `TilingPatternOptions` (no resources field), so marker content
 * has the same scope limit pattern content does — see `cellOperators.ts`.
 */
export const buildMarkerFormXObject = (
    def: MarkerDef,
    doc: LibPDF,
    warnings: string[],
): PDFFormXObject | null => {
    if (def.markerWidth <= 0 || def.markerHeight <= 0) return null;

    // refX/refY are subtracted in the marker's own raw content units (viewBox units if present, else markerWidth/markerHeight units) *before* any viewBox-to-viewport scale — same order `<symbol>`'s existing viewBox handling in walk.ts uses.
    const refTranslate = translateMatrix(-def.refX, -def.refY);
    let contentMatrix = refTranslate;
    let rawBBox = { x: 0, y: 0, width: def.markerWidth, height: def.markerHeight };
    if (def.viewBox) {
        const { minX, minY, width, height } = def.viewBox;
        const scaleX = width > 0 ? def.markerWidth / width : 1;
        const scaleY = height > 0 ? def.markerHeight / height : 1;
        const viewBoxFitMatrix = multiplyMatrix(
            translateMatrix(-minX, -minY),
            scaleMatrix(scaleX, scaleY),
        );
        contentMatrix = multiplyMatrix(refTranslate, viewBoxFitMatrix);
        rawBBox = { x: minX, y: minY, width, height };
    }

    const [x0, y0] = transformPoint(rawBBox.x, rawBBox.y, contentMatrix);
    const [x1, y1] = transformPoint(
        rawBBox.x + rawBBox.width,
        rawBBox.y + rawBBox.height,
        contentMatrix,
    );
    let minX = Math.min(x0, x1);
    let minY = Math.min(y0, y1);
    let maxX = Math.max(x0, x1);
    let maxY = Math.max(y0, y1);

    /*
     * `overflow="visible"` opts the marker's content out of the
     * markerWidth/markerHeight clip (a common technique for a custom
     * arrowhead whose path coordinates deliberately extend past a small
     * nominal viewport, e.g. `markerWidth="1"` with path coordinates from
     * -1 to 0.6) — but a PDF Form XObject's /BBox is always a hard clip,
     * there's no PDF equivalent of "don't clip". So instead of the nominal
     * viewport rect above, the /BBox is grown to actually contain the
     * content's shapes (in the same pre-`contentMatrix` coordinate space
     * `rawBBox`'s corners were transformed from, above) — a best-effort,
     * shapes-only bbox (other instruction types are rare inside a
     * `<marker>` and are left to the nominal viewport rect instead).
     */
    if (def.overflowVisible) {
        for (const instruction of def.instructions) {
            if (instruction.type !== 'shape') continue;
            const shapeBBox = computePathBBox(instruction.d);
            if (!shapeBBox) continue;
            const corners: [number, number][] = [
                [shapeBBox.x, shapeBBox.y],
                [shapeBBox.x + shapeBBox.width, shapeBBox.y + shapeBBox.height],
            ];
            for (const [cx, cy] of corners) {
                const [px, py] = transformPoint(cx, cy, contentMatrix);
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
            }
        }
    }

    const bboxX = minX;
    const bboxY = minY;
    const bboxWidth = maxX - minX;
    const bboxHeight = maxY - minY;
    if (bboxWidth <= 0 || bboxHeight <= 0) return null;

    const operators: ReturnType<typeof ops.moveTo>[] = isIdentityMatrix(contentMatrix)
        ? []
        : [concat(contentMatrix)];
    appendCellInstructions(def.instructions, '<marker> content', operators, warnings);

    return doc.createFormXObject({
        bbox: { x: bboxX, y: bboxY, width: bboxWidth, height: bboxHeight },
        operators,
    });
};
