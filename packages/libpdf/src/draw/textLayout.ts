import { type EmbeddedFont, type FontInput, measureText, type PDF as LibPDF } from '@libpdf/core';

import { type FontFaceDef, type SvgInstruction, type TextInstruction } from '@delylabs/plotify';
import { type FetchFont } from '../svgEmbed';
import { decodeDataUri } from './dataUri';

/*
 * Matches a <text> run's requested font against a parsed `@font-face` def:
 * family compared case-insensitively (CSS itself is case-insensitive
 * here), weight/style compared as trimmed/lowercased strings — a simple,
 * literal match rather than real CSS font-matching (weight ranges,
 * `font-stretch`, etc.), consistent with this codebase's "common case,
 * not full CSS" scope everywhere else `font-weight`/`font-style` are read.
 */
const findFontFaceMatch = (
    fontFaces: readonly FontFaceDef[],
    fontFamily: string,
    fontWeight: string,
    fontStyle: string,
): FontFaceDef | null =>
    fontFaces.find(
        (face) =>
            face.fontFamily.toLowerCase() === fontFamily.trim().toLowerCase() &&
            face.fontWeight.trim().toLowerCase() === fontWeight.trim().toLowerCase() &&
            face.fontStyle.trim().toLowerCase() === fontStyle.trim().toLowerCase(),
    ) ?? null;

export interface TextLayout {
    readonly textWidths: WeakMap<TextInstruction, number>;
    readonly textAnchorOffsets: WeakMap<TextInstruction, number>;
    readonly textFonts: WeakMap<TextInstruction, FontInput>;
}

/*
 * `text-anchor` applies to a whole text chunk (every run back to the
 * last one with its own explicit x/y — see `startsNewChunk`'s doc
 * comment in types.ts), not to each run individually. A pre-pass groups
 * runs into chunks by document order (they're always contiguous in
 * `instructions`, since walkTextElement never interleaves a <text>
 * subtree's runs with any pushMatrix/popMatrix), measures each run once,
 * and computes one shared anchor offset per chunk from its total advance
 * width — the same two-pass "measure everything, then offset" shape
 * svg2pdf.js's TextChunk uses. `svgEmbed.ts`'s main loop just looks the
 * results up instead of computing anchor offsets per run.
 *
 * The same pass also resolves each run's actual font, once per distinct
 * (fontFamily, fontWeight, fontStyle) combination (cached by that key,
 * not per instruction): first checked against any inline `@font-face`
 * (`src: url(data:...)`) parsed from the SVG's own `<style>` — no I/O
 * needed, it's already embedded in the document — then, if unmatched,
 * asked of the caller-supplied `fetchFont`. Either source's bytes are
 * embedded via `doc.embedFont()`, and the resulting `EmbeddedFont` is
 * used for both measurement and drawing instead of `instruction.font`'s
 * standard-14 fallback. A missing/failed font warns once per
 * combination and keeps the standard-14 fallback rather than failing
 * the whole document.
 */
export const resolveTextLayout = async (
    instructions: readonly SvgInstruction[],
    fontFaces: readonly FontFaceDef[],
    doc: LibPDF,
    fetchFont: FetchFont | undefined,
    warnings: string[],
): Promise<TextLayout> => {
    const textWidths = new WeakMap<TextInstruction, number>();
    const textAnchorOffsets = new WeakMap<TextInstruction, number>();
    const textFonts = new WeakMap<TextInstruction, FontInput>();

    const embeddedFontCache = new Map<string, EmbeddedFont | null>();
    let chunk: TextInstruction[] = [];
    const flushChunk = (): void => {
        if (chunk.length === 0) return;
        const totalWidth = chunk.reduce((sum, run) => sum + (textWidths.get(run) ?? 0), 0);
        const offset =
            chunk[0].textAnchor === 'middle'
                ? -totalWidth / 2
                : chunk[0].textAnchor === 'end'
                  ? -totalWidth
                  : 0;
        for (const run of chunk) textAnchorOffsets.set(run, offset);
        chunk = [];
    };
    for (const instruction of instructions) {
        if (instruction.type !== 'text') continue;
        let font: FontInput = instruction.font;
        const key = `${instruction.fontFamily}${instruction.fontWeight}${instruction.fontStyle}`;
        if (!embeddedFontCache.has(key)) {
            let embedded: EmbeddedFont | null = null;
            const fontFace = findFontFaceMatch(
                fontFaces,
                instruction.fontFamily,
                instruction.fontWeight,
                instruction.fontStyle,
            );
            if (fontFace) {
                const decoded = fontFace.dataUri ? decodeDataUri(fontFace.dataUri) : null;
                if (decoded) {
                    try {
                        embedded = doc.embedFont(decoded.bytes);
                    } catch {
                        warnings.push(
                            `@font-face "${fontFace.fontFamily}" could not be embedded and was skipped; falling back to a standard font`,
                        );
                    }
                } else {
                    warnings.push(
                        `@font-face "${fontFace.fontFamily}" src: data: URI could not be decoded and was skipped; falling back to a standard font`,
                    );
                }
            } else if (fetchFont) {
                try {
                    const bytes = await fetchFont({
                        fontFamily: instruction.fontFamily,
                        fontWeight: instruction.fontWeight,
                        fontStyle: instruction.fontStyle,
                    });
                    if (bytes) {
                        embedded = doc.embedFont(bytes);
                    } else {
                        warnings.push(
                            `No font was found for "${instruction.fontFamily}" (weight ${instruction.fontWeight}, style ${instruction.fontStyle}); falling back to a standard font`,
                        );
                    }
                } catch {
                    warnings.push(
                        `Font "${instruction.fontFamily}" (weight ${instruction.fontWeight}, style ${instruction.fontStyle}) could not be embedded and was skipped; falling back to a standard font`,
                    );
                }
            }
            embeddedFontCache.set(key, embedded);
        }
        const embedded = embeddedFontCache.get(key) ?? null;
        if (embedded) font = embedded;
        textFonts.set(instruction, font);
        /*
         * `letterSpacing`/`wordSpacing` are drawn via PDF's own `Tc`/`Tw`
         * text-state operators (see `drawText.ts`), which add their amount
         * after every character/every literal space shown respectively —
         * mirroring that exactly here (rather than approximating) keeps
         * this measured width the same number PDF will actually render at,
         * so text-anchor/flow-cursor math stays exact instead of drifting
         * when spacing is non-zero.
         */
        const numSpaces = (instruction.text.match(/ /g) ?? []).length;
        const width =
            measureText(instruction.text, font, instruction.fontSize) +
            instruction.letterSpacing * instruction.text.length +
            instruction.wordSpacing * numSpaces;
        textWidths.set(instruction, width);
        if (instruction.startsNewChunk) flushChunk();
        chunk.push(instruction);
    }
    flushChunk();

    return { textWidths, textAnchorOffsets, textFonts };
};
