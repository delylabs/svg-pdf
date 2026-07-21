import { PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText } from './helpers';

describe('embedSvgInPdf (shapes)', () => {
    it('emits fill and stroke color operators for a shape with both set', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000" stroke="#0000ff"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/1 0 0 rg/); // non-stroking (fill) red
        expect(content).toMatch(/0 0 1 RG/); // stroking (border) blue
        expect(content).toMatch(/\bB\b/); // combined fill+stroke paint operator
    });

    it('draws nothing for a shape with fill="none" stroke="none" (no fallback black fill)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="none"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/0 0 0 rg/); // no default black fill leaked in
    });

    it("emits an explicit stroke-miterlimit operator, defaulting to 4 (SVG default) rather than the PDF writer's own default", async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><rect width="10" height="10" stroke="#000" stroke-miterlimit="8"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\b8 M\b/);
    });

    it('draws nothing for display="none"', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><rect display="none" width="10" height="10" fill="#ff0000"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/1 0 0 rg/);
    });

    it('draws nothing for visibility="hidden" but still draws a visibility="visible" descendant', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><g visibility="hidden"><rect width="5" height="5" fill="#ff0000"/><rect visibility="visible" width="10" height="10" fill="#00ff00"/></g></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/1 0 0 rg/);
        expect(content).toMatch(/0 1 0 rg/);
    });
});

describe('embedSvgInPdf (mix-blend-mode)', () => {
    it('registers an ExtGState with the requested blend mode for mix-blend-mode', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ff0000" style="mix-blend-mode: multiply;"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\/GS\d+\s+gs/);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);

        const saved = await doc.save();
        const raw = new TextDecoder('latin1').decode(saved);
        expect(raw).toMatch(/\/BM\s*\/Multiply/);
    });
});

describe('embedSvgInPdf (stroke-dasharray)', () => {
    it('emits a dash pattern operator for a stroke with stroke-dasharray', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="0" stroke="#000000" stroke-dasharray="5,3" stroke-dashoffset="2"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\[5 3\]\s*2\s*d/);
    });

    it('does not emit a dash pattern operator for a plain (non-dashed) stroke', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="0" stroke="#000000"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/\bd\b/);
    });
});

describe('embedSvgInPdf (clip-path)', () => {
    it('emits a balanced clip (W n) bracket around a clip-path target', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath></defs><rect width="100" height="100" fill="#ff0000" clip-path="url(#c)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\bW\b\s*\n?\s*n\b/);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
    });
});
