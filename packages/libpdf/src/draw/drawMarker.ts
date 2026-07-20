import { ops } from '@libpdf/core';

import {
    type MarkerInstruction,
    type Matrix2D,
    multiplyMatrix,
    scaleMatrix,
    translateMatrix,
} from '@delylabs/plotify';
import { concat, type DrawContext } from './drawContext';

// Same rotation convention as core's own (private) `rotateMatrix` in geometry/matrix.ts — kept local here since it's only ever needed for a marker's `orient`-derived angle, not general transform parsing.
const rotationMatrix = (radians: number): Matrix2D => {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
};

export const drawMarker = (instruction: MarkerInstruction, ctx: DrawContext): void => {
    const def = ctx.markers.get(instruction.markerId);
    if (!def) return;
    const xobject = ctx.getMarkerXObject(instruction.markerId, def);
    if (!xobject) return;
    const xobjectName = ctx.page.registerXObject(xobject);
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
    ctx.page.drawOperators([
        ops.pushGraphicsState(),
        concat(placementMatrix),
        ops.paintXObject(xobjectName),
        ops.popGraphicsState(),
    ]);
};
