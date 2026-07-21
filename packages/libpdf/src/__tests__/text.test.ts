import { measureText, PDF as LibPDF } from '@libpdf/core';
import * as fs from 'fs';

import { describe, expect, it, vi } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText, LIBERATION_SANS_TTF } from './helpers';

describe('embedSvgInPdf (text)', () => {
    it('draws <text> with a Tj showText operator wrapped in a balanced q/Q bracket', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="10" y="20" fill="#ff0000">Hello</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/<48656C6C6F>\s*Tj/);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
    });

    it('shifts x left by exactly half the font-measured text width for text-anchor=middle', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        const expectedWidth = measureText('Hi', 'Helvetica', 16);
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
    });

    it('shifts x left by exactly the full font-measured text width for text-anchor=end', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="end">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        const expectedWidth = measureText('Hi', 'Helvetica', 16);
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth, 5);
    });

    it("draws consecutive flow-continuing tspans starting exactly where the previous one's measured text ended", async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 200 100"><text x="10" y="20"><tspan>Hello</tspan><tspan>World</tspan></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [...content.matchAll(/1 0 0 1 (-?[\d.]+) -20 Tm/g)].map((m) =>
            Number(m[1]),
        );
        expect(matches).toHaveLength(2);
        expect(matches[0]).toBeCloseTo(10, 5);
        const helloWidth = measureText('Hello', 'Helvetica', 16);
        expect(matches[1]).toBeCloseTo(10 + helloWidth, 5);
    });

    it('does not let a flow-continuing tspan leak into an unrelated later text run', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 200 100"><text><tspan x="10" y="20"><tspan>Line1</tspan></tspan><tspan x="10" y="40"><tspan>Line2</tspan></tspan></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const firstLineX = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        const secondLineX = content.match(/1 0 0 1 (-?[\d.]+) -40 Tm/);
        expect(firstLineX).not.toBeNull();
        expect(secondLineX).not.toBeNull();
        expect(Number(firstLineX![1])).toBeCloseTo(10, 5);
        // Must start at its own x=10, not continue from Line1's end (10 + measured width of "Line1").
        expect(Number(secondLineX![1])).toBeCloseTo(10, 5);
    });

    it('flows bare text around a nested <tspan> instead of drawing both at the same x (the anchor-links.svg overlap regression)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 200 100"><text x="10" y="20">A <tspan>B</tspan> C</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const xs = [...content.matchAll(/1 0 0 1 (-?[\d.]+) -20 Tm/g)].map((m) => Number(m[1]));
        expect(xs).toHaveLength(3);
        const aWidth = measureText('A ', 'Helvetica', 16);
        const bWidth = measureText('B', 'Helvetica', 16);
        expect(xs[0]).toBeCloseTo(10, 5);
        expect(xs[1]).toBeCloseTo(10 + aWidth, 5);
        expect(xs[2]).toBeCloseTo(10 + aWidth + bWidth, 5);
    });

    it('applies text-anchor once to a whole multi-tspan chunk (by total width), not separately per run', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 200 100"><text x="50" y="20" text-anchor="middle"><tspan>Hello</tspan><tspan>World</tspan></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [...content.matchAll(/1 0 0 1 (-?[\d.]+) -20 Tm/g)].map((m) =>
            Number(m[1]),
        );
        expect(matches).toHaveLength(2);
        const helloWidth = measureText('Hello', 'Helvetica', 16);
        const worldWidth = measureText('World', 'Helvetica', 16);
        const chunkOffset = -(helloWidth + worldWidth) / 2;
        /* Both runs shift by the same offset (from the chunk's combined width) — not
         * each centered around its own width, which would put a gap in the middle. */
        expect(matches[0]).toBeCloseTo(50 + chunkOffset, 5);
        expect(matches[1]).toBeCloseTo(50 + chunkOffset + helloWidth, 5);
    });

    it('starts a new anchor chunk for a tspan with its own y, even without its own x (x-cursor still flows)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 200 100"><text x="50" text-anchor="middle"><tspan y="20">Hi</tspan><tspan y="40">World</tspan></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const firstLine = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        const secondLine = content.match(/1 0 0 1 (-?[\d.]+) -40 Tm/);
        expect(firstLine).not.toBeNull();
        expect(secondLine).not.toBeNull();
        const hiWidth = measureText('Hi', 'Helvetica', 16);
        const worldWidth = measureText('World', 'Helvetica', 16);
        // First run: its own one-run chunk, centered on x=50 as usual.
        expect(Number(firstLine![1])).toBeCloseTo(50 - hiWidth / 2, 5);
        /*
         * Second run: a *new* anchor chunk (own y), so it's centered using only its
         * own width — but the x-cursor isn't reset by y alone, so its unanchored
         * start is still "Hi"'s *unshifted* end (x=50 + hiWidth, before any anchor
         * offset — the cursor tracks natural flow, not the anchored draw position),
         * per spec (only x/dx affect the run cursor).
         */
        expect(Number(secondLine![1])).toBeCloseTo(50 + hiWidth - worldWidth / 2, 5);
    });

    it('embeds a custom font via fetchFont and uses its own measured metrics for text-anchor positioning', async () => {
        const doc = LibPDF.create();
        const fontBytes = new Uint8Array(fs.readFileSync(LIBERATION_SANS_TTF));
        const fetchFont = vi.fn(async () => fontBytes);
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle" font-family="CustomSans">Hi</text></svg>',
            rotation: 0,
            fetchFont,
        });
        expect(fetchFont).toHaveBeenCalledWith({
            fontFamily: 'CustomSans',
            fontWeight: 'normal',
            fontStyle: 'normal',
        });
        const embedded = doc.embedFont(fontBytes);
        const expectedWidth = measureText('Hi', embedded, 16);
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
    });

    it('calls fetchFont only once for repeated runs sharing the same family/weight/style', async () => {
        const doc = LibPDF.create();
        const fontBytes = new Uint8Array(fs.readFileSync(LIBERATION_SANS_TTF));
        const fetchFont = vi.fn(async () => fontBytes);
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100" font-family="CustomSans"><text x="10" y="20">Hello</text><text x="10" y="40">World</text></svg>',
            rotation: 0,
            fetchFont,
        });
        expect(fetchFont).toHaveBeenCalledTimes(1);
    });

    it('warns and falls back to a standard font when fetchFont returns null', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle" font-family="Missing">Hi</text></svg>',
            rotation: 0,
            fetchFont: async () => null,
        });
        expect(result.warnings.some((w) => w.includes('No font was found'))).toBe(true);
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        const expectedWidth = measureText('Hi', 'Helvetica', 16);
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
    });

    it('warns and falls back to a standard font (without crashing) when fetchFont throws', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 100 100"><text x="10" y="20">Hi</text></svg>',
            rotation: 0,
            fetchFont: async () => {
                throw new Error('font lookup failed');
            },
        });
        expect(result.warnings.some((w) => w.includes('could not be embedded'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/Tj/);
    });

    it('never calls fetchFont when not provided', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 100 100"><text x="10" y="20">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/Tj/);
    });

    it('embeds a font declared inline via @font-face src: url(data:...), with no fetchFont needed', async () => {
        const doc = LibPDF.create();
        const fontBytes = fs.readFileSync(LIBERATION_SANS_TTF);
        const dataUri = `data:font/ttf;base64,${fontBytes.toString('base64')}`;
        const result = await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(${dataUri}); }</style><text x="50" y="20" text-anchor="middle" font-family="CustomSans">Hi</text></svg>`,
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const embedded = doc.embedFont(new Uint8Array(fontBytes));
        const expectedWidth = measureText('Hi', embedded, 16);
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
    });

    it('prefers an inline @font-face match over fetchFont for the same family/weight/style', async () => {
        const doc = LibPDF.create();
        const fontBytes = fs.readFileSync(LIBERATION_SANS_TTF);
        const dataUri = `data:font/ttf;base64,${fontBytes.toString('base64')}`;
        const fetchFont = vi.fn(async () => {
            throw new Error('should never be called — @font-face already matched');
        });
        const result = await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(${dataUri}); }</style><text x="10" y="20" font-family="CustomSans">Hi</text></svg>`,
            rotation: 0,
            fetchFont,
        });
        expect(fetchFont).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([]);
    });

    it('warns and falls back to a standard font when a @font-face src: data: URI cannot be decoded', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(data:font/ttf;base64,!!!not-valid-base64!!!); }</style><text x="10" y="20" font-family="CustomSans">Hi</text></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/Tj/);
    });

    it('emits a Tc operator for letter-spacing, ahead of the Tj it applies to', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="10" y="20" letter-spacing="2">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/2 Tc[\s\S]*Tj/);
    });

    it('emits a Tw operator for word-spacing', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="10" y="20" word-spacing="3">A B</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/3 Tw[\s\S]*Tj/);
    });

    it('does not emit Tc/Tw when letter-spacing/word-spacing are unset (default)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 100 100"><text x="10" y="20">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/\bTc\b/);
        expect(content).not.toMatch(/\bTw\b/);
    });

    it('includes letter-spacing in the measured width used for text-anchor centering', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle" letter-spacing="3">Hi</text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
        expect(match).not.toBeNull();
        const baseWidth = measureText('Hi', 'Helvetica', 16);
        const expectedWidth = baseWidth + 3 * 'Hi'.length;
        expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
    });
});
