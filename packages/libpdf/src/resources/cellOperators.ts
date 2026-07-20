import { lineCapToNumber, lineJoinToNumber, ops } from '@libpdf/core';

import {
    normalizePathData,
    type Paint,
    type RgbColor,
    type SvgInstruction,
} from '@delylabs/plotify';
import { pathSegmentsToOperators } from './pathOperators';

const concat = (m: { a: number; b: number; c: number; d: number; e: number; f: number }) =>
    ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

/*
 * A "cell" here means self-contained PDF content with no resource dictionary
 * of its own — both `@libpdf/core`'s tiling patterns (`pattern.ts`) and Form
 * XObjects (`marker.ts`) are built from a bare `operators: Operator[]` array
 * with no way to register a font/image/shading/nested pattern into it. So a
 * cell's fill/stroke can only ever be a solid color, and it can't contain
 * <text>/<image>/clip-path — each dropped with a warning (`what` names the
 * kind of cell in the message, e.g. "<pattern> content" or "<marker> content").
 */
const resolveSolidColor = (
    paint: Paint,
    which: string,
    what: string,
    warnings: string[],
): RgbColor | null => {
    if (paint === null) return null;
    if (typeof paint === 'object' && 'kind' in paint) {
        warnings.push(`gradient/pattern ${which} inside ${what} is not supported and was skipped`);
        return null;
    }
    return paint;
};

const appendShapeOperators = (
    instruction: Extract<SvgInstruction, { type: 'shape' }>,
    what: string,
    operators: ReturnType<typeof ops.moveTo>[],
    warnings: string[],
): void => {
    if (!instruction.fill && !instruction.stroke) return;
    const fillColor = resolveSolidColor(instruction.fill, 'fill', what, warnings);
    const strokeColor = resolveSolidColor(instruction.stroke, 'stroke', what, warnings);
    if (!fillColor && !strokeColor) return;

    if (instruction.fillOpacity < 1 || instruction.strokeOpacity < 1) {
        warnings.push(
            `fill-opacity/stroke-opacity on ${what} is not supported and was drawn fully opaque`,
        );
    }
    if (instruction.blendMode !== 'Normal') {
        warnings.push(
            `mix-blend-mode on ${what} is not supported and was drawn with normal blending`,
        );
    }
    if (instruction.dashArray) {
        warnings.push(
            `stroke-dasharray on ${what} is not supported and was drawn as a solid stroke instead`,
        );
    }

    if (fillColor) {
        operators.push(
            ops.setNonStrokingRGB(fillColor.r / 255, fillColor.g / 255, fillColor.b / 255),
        );
    }
    if (strokeColor) {
        operators.push(
            ops.setLineWidth(instruction.strokeWidth),
            ops.setLineCap(lineCapToNumber(instruction.lineCap)),
            ops.setLineJoin(lineJoinToNumber(instruction.lineJoin)),
            ops.setStrokingRGB(strokeColor.r / 255, strokeColor.g / 255, strokeColor.b / 255),
        );
    }
    operators.push(...pathSegmentsToOperators(normalizePathData(instruction.d)));
    if (fillColor && strokeColor) {
        operators.push(
            instruction.fillRule === 'evenodd' ? ops.fillAndStrokeEvenOdd() : ops.fillAndStroke(),
        );
    } else if (fillColor) {
        operators.push(instruction.fillRule === 'evenodd' ? ops.fillEvenOdd() : ops.fill());
    } else if (strokeColor) {
        operators.push(ops.stroke());
    }
};

// Replays a <pattern>/<marker> content instruction list as raw operators — see the module doc comment above for what's in/out of scope and why.
export const appendCellInstructions = (
    instructions: readonly SvgInstruction[],
    what: string,
    operators: ReturnType<typeof ops.moveTo>[],
    warnings: string[],
): void => {
    for (const instruction of instructions) {
        switch (instruction.type) {
            case 'pushMatrix':
                operators.push(ops.pushGraphicsState(), concat(instruction.matrix));
                break;
            case 'popMatrix':
                operators.push(ops.popGraphicsState());
                break;
            case 'shape':
                appendShapeOperators(instruction, what, operators, warnings);
                break;
            case 'text':
            case 'image':
                warnings.push(
                    `<${instruction.type}> inside ${what} is not supported by the current PDF adapter and was skipped`,
                );
                break;
            case 'pushClip':
                warnings.push(
                    `clip-path inside ${what} is not supported by the current PDF adapter and was applied without it`,
                );
                break;
            case 'popClip':
            case 'marker':
                break;
        }
    }
};
