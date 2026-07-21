import { measureText, ops } from '@libpdf/core';

import { pointAtLength, type TextPathInstruction } from '@svg-pdf/core';
import { toPdfColor } from '../resources/paint';
import { concat, type DrawContext, FLIP_Y } from './drawContext';

/*
 * Unlike a plain 'text' run (one string, one Tj), each character here needs
 * its own position *and* rotation (the path's tangent at that point), so
 * it's drawn with its own drawText() call instead of PDF's native Tc/Tw
 * spacing operators — letterSpacing/wordSpacing are folded straight into
 * how far `dist` advances between characters instead. No fetchFont/
 * @font-face lookup here (kept to `instruction.font`'s standard-14 fallback
 * only) — a deliberate scope trim, not a technical limitation.
 *
 * `textLength`, when set, is honored by distributing the difference between
 * the text's natural advance and the requested length evenly across every
 * character's step (`extraPerChar`) — this is `lengthAdjust="spacing"`,
 * the SVG default; glyphs themselves are never resized (that would be
 * `lengthAdjust="spacingAndGlyphs"`, which core already warns is
 * unsupported when it's requested).
 */
export const drawTextPath = (instruction: TextPathInstruction, ctx: DrawContext): void => {
    const chars = Array.from(instruction.text);
    const charWidths = chars.map((ch) => measureText(ch, instruction.font, instruction.fontSize));
    const naturalAdvance =
        charWidths.reduce((sum, w) => sum + w, 0) +
        instruction.letterSpacing * chars.length +
        instruction.wordSpacing * chars.filter((ch) => ch === ' ').length;
    const extraPerChar =
        instruction.textLength !== null && chars.length > 0
            ? (instruction.textLength - naturalAdvance) / chars.length
            : 0;
    const totalAdvance = naturalAdvance + extraPerChar * chars.length;
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
             * Same Y-flip reasoning as `drawText`, applied to both position
             * and angle: this bracket's FLIP_Y mirrors whatever's drawn
             * inside it, so a tangent angle computed in the un-flipped
             * local space (`atan2` in Y-down coordinates) has to be negated
             * here to still point the right way once mirrored back.
             */
            ctx.page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y)]);
            ctx.page.drawText(ch, {
                x: point.x,
                y: -point.y,
                rotate: { angle: -(point.angle * 180) / Math.PI },
                font: instruction.font,
                size: instruction.fontSize,
                color: toPdfColor(instruction.fill),
                opacity: instruction.fillOpacity,
            });
            ctx.page.drawOperators([ops.popGraphicsState()]);
        }
        dist +=
            charWidth +
            instruction.letterSpacing +
            (ch === ' ' ? instruction.wordSpacing : 0) +
            extraPerChar;
    }
};
