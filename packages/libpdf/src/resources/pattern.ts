import { ops, type PDF as LibPDF, type PDFTilingPattern } from '@libpdf/core';

import {
    type BBoxRect,
    IDENTITY_MATRIX,
    type Matrix2D,
    multiplyMatrix,
    type PatternDef,
    translateMatrix,
} from '@svg-pdf/core';
import { appendCellInstructions } from './cellOperators';

const EPSILON = 1e-6;

const concat = (m: Matrix2D) => ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

const transformPoint = (x: number, y: number, m: Matrix2D): [number, number] => [
    x * m.a + y * m.c + m.e,
    x * m.b + y * m.d + m.f,
];

/*
 * Turns a resolved <pattern> into an `@libpdf/core` tiling pattern.
 *
 * Unlike its shading patterns, `@libpdf/core`'s `TilingPatternOptions` has no
 * `/Matrix` field — every number handed to `createTilingPattern` (`bbox`,
 * `xStep`, `yStep`) is interpreted directly in the page's absolute default
 * space, not a separate pattern-local space the way PDF patterns normally
 * work. So instead of building a small pattern-space matrix the way gradients
 * do (`paint.ts`'s `buildPatternMatrix`), the whole placement chain —
 * patternUnits' bbox scale, `patternTransform`, the referencing shape's own
 * `groupMatrix`, the root viewBox-to-page matrix — has to be pre-multiplied
 * into absolute `bbox`/`xStep`/`yStep` numbers here. `bbox`/`xStep`/`yStep`
 * are always axis-aligned, so a chain that reduces to anything other than a
 * scale+translate (e.g. a `patternTransform` rotation, or a rotated ancestor
 * `<g>`) can't be represented that way — skipped with a warning rather than
 * drawn with the wrong tiling grid, same fail-safe policy used everywhere
 * else in this adapter. The pattern's own *content* doesn't have this
 * problem (it draws under a real `concatMatrix`, a genuine PDF `cm`), so a
 * pattern with unsupported placement still has fully well-formed content —
 * it's only ever the placement that gets rejected. (A Form XObject, used for
 * `<marker>` in `marker.ts`, doesn't have this problem at all — it's placed
 * via an ordinary `cm`/`Do` pair in the page's own content stream, which can
 * rotate freely.)
 */
export const resolvePatternFill = (
    def: PatternDef,
    doc: LibPDF,
    groupMatrix: Matrix2D,
    rootMatrix: Matrix2D,
    bbox: BBoxRect | null,
    warnings: string[],
): PDFTilingPattern | null => {
    const isObjectBoundingBox = def.patternUnits === 'objectBoundingBox';
    if (isObjectBoundingBox && !bbox) return null;

    const tileX = isObjectBoundingBox ? def.x * (bbox as BBoxRect).width : def.x;
    const tileY = isObjectBoundingBox ? def.y * (bbox as BBoxRect).height : def.y;
    const tileWidth = isObjectBoundingBox ? def.width * (bbox as BBoxRect).width : def.width;
    const tileHeight = isObjectBoundingBox ? def.height * (bbox as BBoxRect).height : def.height;
    if (tileWidth <= 0 || tileHeight <= 0) return null;

    const ambientMatrix = multiplyMatrix(groupMatrix, rootMatrix);
    const fullMatrix = multiplyMatrix(def.patternTransform, ambientMatrix);
    if (Math.abs(fullMatrix.b) > EPSILON || Math.abs(fullMatrix.c) > EPSILON) {
        warnings.push(
            'pattern fill with a rotated or skewed transform is not yet supported and was skipped',
        );
        return null;
    }

    const [x0, y0] = transformPoint(tileX, tileY, fullMatrix);
    const [x1, y1] = transformPoint(tileX + tileWidth, tileY + tileHeight, fullMatrix);
    const deviceX = Math.min(x0, x1);
    const deviceY = Math.min(y0, y1);
    const deviceWidth = Math.abs(x1 - x0);
    const deviceHeight = Math.abs(y1 - y0);
    if (deviceWidth <= 0 || deviceHeight <= 0) return null;

    // patternContentUnits="objectBoundingBox" scales content coordinates by the referencing shape's bbox — same idea as patternUnits, but applied only to content, not to the tile's own placement.
    const contentUnitsMatrix: Matrix2D =
        def.patternContentUnits === 'objectBoundingBox' && bbox
            ? { a: bbox.width, b: 0, c: 0, d: bbox.height, e: 0, f: 0 }
            : IDENTITY_MATRIX;
    /*
     * The tile's own content is authored relative to its local (0,0) origin
     * (e.g. a `<rect width="6">` inside a `<pattern x="4" ...>` still starts
     * at x=0 in its own markup), but `deviceX`/`deviceY` above already baked
     * the `x`/`y` tile-origin offset into where the *bbox* sits in device
     * space. Without also translating the content by that same offset here,
     * content and bbox land in different places — content drawn at the
     * unshifted local origin gets clipped by a bbox that has moved out from
     * under it (only their overlap survives PDF's hard bbox clip), instead
     * of the two staying aligned the way `<pattern x="4">`'s offset intends.
     */
    const contentMatrix = multiplyMatrix(
        multiplyMatrix(contentUnitsMatrix, translateMatrix(tileX, tileY)),
        fullMatrix,
    );

    const operators: ReturnType<typeof ops.moveTo>[] = [concat(contentMatrix)];
    appendCellInstructions(def.instructions, '<pattern> content', operators, warnings);

    return doc.createTilingPattern({
        bbox: { x: deviceX, y: deviceY, width: deviceWidth, height: deviceHeight },
        xStep: deviceWidth,
        yStep: deviceHeight,
        operators,
    });
};
