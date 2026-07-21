import { invertMatrix, type Matrix2D, multiplyMatrix, type SvgInstruction } from '@svg-pdf/core';
import { ops } from '@libpdf/core';

import { concat, type DrawContext } from './drawContext';
import { drawImage } from './drawImage';
import { drawMarker } from './drawMarker';
import { drawShape } from './drawShape';
import { drawText } from './drawText';
import { drawTextPath } from './drawTextPath';

/*
 * Replays one parsed document's instruction stream into `ctx.page`'s
 * content stream, starting from `rootMatrix` as the ambient CTM. Shared by
 * `embedSvgInPdf` (the top-level document) and `drawImage.ts` (a nested
 * SVG-as-image document) — see each call site's own doc comment for how
 * `rootMatrix` is derived in each case.
 *
 * Mirrors core's own `accMatrix` accumulation (see `walk.ts`'s
 * `elMatrix`/`groupMatrix`) on this side of the fence: `pushMatrix`/
 * `popMatrix` instructions are the only things that change the ambient
 * transform a shape/text/image instruction's local coordinates are drawn
 * under, so tracking them here gives the exact matrix PDF's own CTM has
 * active at that instruction — needed to turn an `<a>`'s wrapped content
 * into one absolute, page-space `Rect` (see `linkAnnotations.ts`), since
 * annotations aren't part of the content stream and can't just inherit the
 * CTM the way a `drawSvgPath`/`drawText` call does.
 */
export const runInstructions = async (
    instructions: readonly SvgInstruction[],
    ctx: DrawContext,
    rootMatrix: Matrix2D,
): Promise<void> => {
    let currentMatrix: Matrix2D = rootMatrix;
    const matrixStack: Matrix2D[] = [];

    for (const instruction of instructions) {
        switch (instruction.type) {
            case 'pushMatrix':
                ctx.page.drawOperators([ops.pushGraphicsState(), concat(instruction.matrix)]);
                matrixStack.push(currentMatrix);
                currentMatrix = multiplyMatrix(instruction.matrix, currentMatrix);
                break;
            case 'popMatrix':
                ctx.page.drawOperators([ops.popGraphicsState()]);
                currentMatrix = matrixStack.pop() ?? rootMatrix;
                break;
            case 'linkStart':
                ctx.link.start(instruction.href);
                break;
            case 'linkEnd':
                ctx.link.flush();
                break;
            case 'shape':
                drawShape(instruction, ctx, currentMatrix);
                break;
            case 'pushClip': {
                ctx.page.drawOperators([ops.pushGraphicsState()]);
                if (instruction.bboxMatrix) {
                    ctx.page.drawOperators([concat(instruction.bboxMatrix)]);
                }
                let pathBuilder = ctx.page.drawPath();
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
                ctx.page.drawOperators([ops.endPath()]);
                if (instruction.bboxMatrix) {
                    ctx.page.drawOperators([concat(invertMatrix(instruction.bboxMatrix))]);
                }
                break;
            }
            case 'popClip':
                ctx.page.drawOperators([ops.popGraphicsState()]);
                break;
            case 'text':
                drawText(instruction, ctx, currentMatrix);
                break;
            case 'textPath':
                drawTextPath(instruction, ctx);
                break;
            case 'image':
                await drawImage(instruction, ctx, currentMatrix);
                break;
            case 'marker':
                drawMarker(instruction, ctx);
                break;
        }
    }
    // Defensive only — a well-formed instruction stream always closes every `linkStart` with a `linkEnd` before the loop ends.
    ctx.link.flush();
};
