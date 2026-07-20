import { ops } from '@libpdf/core';

import { type Matrix2D, type TextInstruction } from '@svg-pdf/core';
import { toPdfColor } from '../resources/paint';
import { concat, type DrawContext, FLIP_Y } from './drawContext';

export const drawText = (
    instruction: TextInstruction,
    ctx: DrawContext,
    currentMatrix: Matrix2D,
): void => {
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
    const textWidth = ctx.textWidths.get(instruction) ?? 0;
    const startX: number =
        instruction.continuesFlow && ctx.flowCursorX !== null ? ctx.flowCursorX : instruction.x;
    ctx.flowCursorX = startX + textWidth;
    const anchorOffsetX = ctx.textAnchorOffsets.get(instruction) ?? 0;
    /*
     * No real glyph ascent/descent metrics are threaded through
     * here (same "no library-specific font math in the shared
     * path" reasoning as elsewhere) — approximated the same way
     * @libpdf/core's own `drawText` rotate-bounds math does for
     * a standard font (ascent ~0.8em above baseline, descent
     * ~0.2em below), which is only ever used for a link's
     * clickable-area estimate, not for anything pixel-exact.
     */
    ctx.link.include(
        {
            x: startX + anchorOffsetX,
            y: instruction.y - instruction.fontSize * 0.8,
            width: textWidth,
            height: instruction.fontSize,
        },
        currentMatrix,
    );
    const spacingOps = [
        ...(instruction.letterSpacing !== 0 ? [ops.setCharSpacing(instruction.letterSpacing)] : []),
        ...(instruction.wordSpacing !== 0 ? [ops.setWordSpacing(instruction.wordSpacing)] : []),
    ];
    // Tc/Tw are text-state parameters, saved/restored by q/Q same as any other graphics state — scoping them inside this instruction's own push/pop bracket means drawText() (which pushes its own nested q/Q but never touches Tc/Tw itself) still inherits them for its Tj call, with no explicit reset needed after.
    ctx.page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y), ...spacingOps]);
    ctx.page.drawText(instruction.text, {
        x: startX + anchorOffsetX,
        y: -instruction.y,
        font: ctx.textFonts.get(instruction) ?? instruction.font,
        size: instruction.fontSize,
        color: toPdfColor(instruction.fill),
        opacity: instruction.fillOpacity,
    });
    ctx.page.drawOperators([ops.popGraphicsState()]);
};
