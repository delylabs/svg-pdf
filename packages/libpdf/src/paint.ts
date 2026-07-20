import { type PDF as LibPDF, rgb } from '@libpdf/core';

import {
    IDENTITY_MATRIX,
    type BBoxRect,
    type GradientDef,
    type Matrix2D,
    multiplyMatrix,
    type Paint,
    type RgbColor,
} from '@delylabs/plotify';

export const toPdfColor = (color: RgbColor) => rgb(color.r / 255, color.g / 255, color.b / 255);

/*
 * A shading pattern's matrix maps to the PDF page's *default* coordinate
 * system, unlike a solid color, which just inherits whatever `cm`s are
 * currently on the graphics-state stack. So instead of relying on the nested
 * pushGraphicsState()/concatMatrix() brackets in svgEmbed.ts
 * (`instruction.groupMatrix`), gradients need their own matrix baked in
 * explicitly: gradientTransform, then (for the default objectBoundingBox
 * units) a scale/translate into the shape's own bbox, then the shape's
 * accumulated group matrix, then the root viewBox-to-page matrix — see
 * `@delylabs/plotify`'s `ShapeInstruction` doc.
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
    readonly pattern?: ReturnType<LibPDF['createShadingPattern']>;
}

// Resolves a shape's fill/stroke `Paint` into either a solid PDF color or a shading pattern.
export const resolvePaint = (
    paint: Paint,
    doc: LibPDF,
    gradients: ReadonlyMap<string, GradientDef>,
    groupMatrix: Matrix2D,
    rootMatrix: Matrix2D,
    bbox: BBoxRect | null,
): ResolvedPaint | null => {
    if (paint === null) return null;
    if (typeof paint === 'object' && 'kind' in paint) {
        const def = gradients.get(paint.gradientId);
        if (!def) return null;
        const stops = def.stops.map((stop) => ({
            offset: stop.offset,
            color: toPdfColor(stop.color),
        }));
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
    return { color: toPdfColor(paint) };
};
