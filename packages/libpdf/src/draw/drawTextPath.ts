import { measureText, ops } from '@libpdf/core';

import { Matrix2D, pointAtLength, type TextPathInstruction } from '@svg-pdf/core';
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
    const font = ctx.textFonts.get(instruction) ?? instruction.font;
    const chars = Array.from(instruction.text);
    const charWidths = chars.map((ch) => measureText(ch, font, instruction.fontSize));
    const naturalAdvance =
        charWidths.reduce((sum, w) => sum + w, 0) +
        instruction.letterSpacing * chars.length +
        instruction.wordSpacing * chars.filter((ch) => ch === ' ').length;
    const isSpacingAndGlyphs = instruction.lengthAdjust === 'spacingAndGlyphs';
    const scaleX =
        instruction.textLength !== null &&
        instruction.textLength > 0 &&
        chars.length > 0 &&
        naturalAdvance > 0 &&
        isSpacingAndGlyphs
            ? instruction.textLength / naturalAdvance
            : 1;
    const extraPerChar =
        instruction.textLength !== null && chars.length > 0 && !isSpacingAndGlyphs
            ? (instruction.textLength - naturalAdvance) / chars.length
            : 0;
    const totalAdvance = isSpacingAndGlyphs
        ? (instruction.textLength ?? naturalAdvance)
        : naturalAdvance + extraPerChar * chars.length;
    const anchorShift =
        instruction.textAnchor === 'middle'
            ? -totalAdvance / 2
            : instruction.textAnchor === 'end'
              ? -totalAdvance
              : 0;
    let dist =
        instruction.continuesFlow && ctx.textPathDistance !== null
            ? ctx.textPathDistance
            : instruction.startDistance + anchorShift;
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const charWidth = charWidths[i];
        const point = pointAtLength(instruction.points, instruction.cumLengths, dist);
        if (point) {
            /*
             * Same Y-flip reasoning as `drawText`, applied to position, angle,
             * and optional horizontal glyph scaling (lengthAdjust="spacingAndGlyphs").
             * `concat(FLIP_Y)` cancels the ambient rootMatrix Y-flip so glyphs stay upright.
             * `mLocal` then rotates by -point.angle in Y-up space, scales X by scaleX,
             * and translates to (point.x, -point.y).
             */
            const cosA = Math.cos(point.angle);
            const sinA = Math.sin(point.angle);
            const mLocal: Matrix2D = {
                a: scaleX * cosA,
                b: -scaleX * sinA,
                c: sinA,
                d: cosA,
                e: point.x,
                f: -point.y,
            };
            ctx.page.drawOperators([ops.pushGraphicsState(), concat(FLIP_Y), concat(mLocal)]);
            ctx.page.drawText(ch, {
                x: 0,
                y: 0,
                font,
                size: instruction.fontSize,
                color: toPdfColor(instruction.fill),
                opacity: instruction.fillOpacity,
            });
            ctx.page.drawOperators([ops.popGraphicsState()]);
        }
        dist +=
            (charWidth + instruction.letterSpacing + (ch === ' ' ? instruction.wordSpacing : 0)) *
                scaleX +
            extraPerChar;
    }
    ctx.textPathDistance = dist;
};
