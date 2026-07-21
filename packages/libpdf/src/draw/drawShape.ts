import { ops } from '@libpdf/core';

import {
    computePathBBox,
    getMatrixScale,
    type Matrix2D,
    type ShapeInstruction,
} from '@svg-pdf/core';
import { resolvePaint } from '../resources/paint';
import { type DrawContext } from './drawContext';

export const drawShape = (
    instruction: ShapeInstruction,
    ctx: DrawContext,
    currentMatrix: Matrix2D,
): void => {
    /*
     * Included regardless of fill/stroke — an invisible
     * `fill="none"` shape wrapped in an `<a>` is a common
     * real-world "transparent clickable overlay" pattern, and
     * its geometry (not its paint) is what defines the
     * intended clickable region.
     */
    const localBBox = computePathBBox(instruction.d);
    if (localBBox) ctx.link.include(localBBox, currentMatrix);

    if (!instruction.fill && !instruction.stroke) return;
    const fill = resolvePaint(
        instruction.fill,
        ctx.doc,
        ctx.gradients,
        ctx.patterns,
        instruction.groupMatrix,
        ctx.rootMatrix,
        instruction.bbox,
        ctx.warnings,
    );
    const stroke = resolvePaint(
        instruction.stroke,
        ctx.doc,
        ctx.gradients,
        ctx.patterns,
        instruction.groupMatrix,
        ctx.rootMatrix,
        instruction.bbox,
        ctx.warnings,
    );
    const strokeWidth =
        instruction.vectorEffect === 'non-scaling-stroke'
            ? instruction.strokeWidth / getMatrixScale(currentMatrix)
            : instruction.strokeWidth;

    const hasBlendMode = instruction.blendMode !== 'Normal';
    if (hasBlendMode) {
        ctx.page.drawOperators([
            ops.pushGraphicsState(),
            ops.setGraphicsState(ctx.getBlendModeGsName(instruction.blendMode)),
        ]);
    }

    const isDefaultOrder =
        instruction.paintOrder.indexOf('fill') < instruction.paintOrder.indexOf('stroke');

    if (isDefaultOrder) {
        ctx.page.drawSvgPath(instruction.d, {
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
                borderWidth: strokeWidth,
                borderOpacity: instruction.strokeOpacity,
                lineCap: instruction.lineCap,
                lineJoin: instruction.lineJoin,
                miterLimit: instruction.miterLimit,
                ...(instruction.dashArray && {
                    dashArray: [...instruction.dashArray],
                    dashPhase: instruction.dashOffset,
                }),
                ...(stroke.pattern
                    ? { borderPattern: stroke.pattern }
                    : { borderColor: stroke.color }),
            }),
        });
    } else {
        for (const layer of instruction.paintOrder) {
            if (layer === 'stroke' && stroke && strokeWidth > 0) {
                ctx.page.drawSvgPath(instruction.d, {
                    x: 0,
                    y: 0,
                    scale: 1,
                    flipY: false,
                    borderWidth: strokeWidth,
                    borderOpacity: instruction.strokeOpacity,
                    lineCap: instruction.lineCap,
                    lineJoin: instruction.lineJoin,
                    miterLimit: instruction.miterLimit,
                    ...(instruction.dashArray && {
                        dashArray: [...instruction.dashArray],
                        dashPhase: instruction.dashOffset,
                    }),
                    ...(stroke.pattern
                        ? { borderPattern: stroke.pattern }
                        : { borderColor: stroke.color }),
                });
            } else if (layer === 'fill' && (fill?.pattern || fill?.color)) {
                ctx.page.drawSvgPath(instruction.d, {
                    x: 0,
                    y: 0,
                    scale: 1,
                    flipY: false,
                    windingRule: instruction.fillRule,
                    ...(fill?.pattern
                        ? { pattern: fill.pattern, opacity: instruction.fillOpacity }
                        : { color: fill.color, opacity: instruction.fillOpacity }),
                });
            }
        }
    }

    if (hasBlendMode) {
        ctx.page.drawOperators([ops.popGraphicsState()]);
    }
};
