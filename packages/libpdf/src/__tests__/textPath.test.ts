import { measureText, PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText } from './helpers';

describe('embedSvgInPdf (textPath)', () => {
    it('draws one Tj per character, each at its own x position along a horizontal path', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" startOffset="10">AB</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const tjCount = (content.match(/Tj/g) ?? []).length;
        expect(tjCount).toBe(2);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches).toHaveLength(2);
        const widthA = measureText('A', 'Helvetica', 16);
        expect(Number(matches[0][5])).toBeCloseTo(10, 5);
        expect(Number(matches[0][6])).toBeCloseTo(-5, 5);
        expect(Number(matches[1][5])).toBeCloseTo(10 + widthA, 5);
        expect(Number(matches[1][6])).toBeCloseTo(-5, 5);
    });

    it('rotates a character to match a non-horizontal path tangent', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 200"><path id="p" d="M50 0 L50 200"/><text><textPath href="#p">A</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        // A vertical (Y-down) path segment: local tangent angle is +90°, negated for FLIP_Y to -90° (0 -1 1 0 50 0 cm).
        expect(content).toMatch(/0 -1 1 0 50 0 cm/);
    });

    it('shifts the start distance back by half the total advance for text-anchor="middle"', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" startOffset="100" text-anchor="middle">AB</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches).toHaveLength(2);
        const widthA = measureText('A', 'Helvetica', 16);
        const widthB = measureText('B', 'Helvetica', 16);
        const totalAdvance = widthA + widthB;
        expect(Number(matches[0][5])).toBeCloseTo(100 - totalAdvance / 2, 5);
    });

    it('resolves a percentage startOffset relative to the path length', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" startOffset="50%">A</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches.length).toBeGreaterThanOrEqual(1);
        expect(Number(matches[0][5])).toBeCloseTo(500, 5);
    });

    it('stretches inter-character spacing to fit an explicit textLength', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" textLength="200">AB</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches).toHaveLength(2);
        // Natural advance (no textLength) would place 'B' at width(A); textLength="200" stretches that gap so B lands further out.
        const widthA = measureText('A', 'Helvetica', 16);
        expect(Number(matches[0][5])).toBeCloseTo(0, 5);
        expect(Number(matches[1][5])).toBeGreaterThan(widthA);
    });

    it('compresses inter-character spacing when textLength is shorter than the natural advance', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" textLength="5">AB</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches).toHaveLength(2);
        const widthA = measureText('A', 'Helvetica', 16);
        const widthB = measureText('B', 'Helvetica', 16);
        const naturalAdvance = widthA + widthB;
        const extraPerChar = (5 - naturalAdvance) / 2;
        expect(Number(matches[1][5])).toBeCloseTo(widthA + extraPerChar, 5);
        expect(Number(matches[1][5])).toBeLessThan(widthA);
    });

    it('resizes glyphs horizontally when lengthAdjust="spacingAndGlyphs" is requested', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 1000 100"><path id="p" d="M0 5 L1000 5"/><text><textPath href="#p" textLength="200" lengthAdjust="spacingAndGlyphs">AB</textPath></text></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('spacingAndGlyphs'))).toBe(false);
        const content = getPageContentText(doc, 0);
        const matches = [
            ...content.matchAll(
                /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\n\nq\n0 0 0 rg\nBT\n\/F0 16 Tf\n1 0 0 1 0 0 Tm/g,
            ),
        ];
        expect(matches).toHaveLength(2);
        const widthA = measureText('A', 'Helvetica', 16);
        const widthB = measureText('B', 'Helvetica', 16);
        const expectedScale = 200 / (widthA + widthB);
        expect(Number(matches[0][1])).toBeCloseTo(expectedScale, 4);
    });

    it('stops drawing characters that would fall past the end of the path', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 50 100"><path id="p" d="M0 5 L20 5"/><text><textPath href="#p">Hello World</textPath></text></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const tjCount = (content.match(/Tj/g) ?? []).length;
        expect(tjCount).toBeGreaterThan(0);
        expect(tjCount).toBeLessThan('Hello World'.length);
    });

    it('warns and skips when href points at a missing path', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text><textPath href="#missing">Curved</textPath></text></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('valid href to a <path>'))).toBe(true);
    });
});
