import { PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText, getPatternContentText, ONE_PIXEL_PNG_DATA_URI } from './helpers';

describe('embedSvgInPdf (gradients)', () => {
    it('fills a gradient-referencing shape with a pattern instead of a solid color', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        // Pattern color space + a named pattern resource selected for fill, not a plain `rg` solid fill.
        expect(content).toMatch(/\/Pattern\s+cs/);
        expect(content).toMatch(/\/P\d+\s+scn/);
        expect(content).not.toMatch(/1 0 0 rg/);
    });
});

describe('embedSvgInPdf (patterns)', () => {
    it('fills a <pattern>-referencing shape with a tiling pattern whose cell draws the pattern content', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="5" fill="#ff0000"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\/Pattern\s+cs/);
        const match = content.match(/\/(P\d+)\s+scn/);
        expect(match).not.toBeNull();
        const patternContent = getPatternContentText(doc, 0, match![1]);
        // The pattern cell's own content stream draws the circle with its solid fill color, via a real path-construction + fill operator (not just a reference to something else).
        expect(patternContent).toMatch(/1 0 0 rg/);
        expect(patternContent).toMatch(/\bf\b/);
    });

    it("positions an objectBoundingBox (default) pattern tile using the filled shape's bbox", async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="0.5" height="0.5"><rect width="1" height="1" fill="#00ff00"/></pattern></defs><rect x="10" y="10" width="40" height="40" fill="url(#p)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\/Pattern\s+cs/);
    });

    it('warns and falls back to no fill for a pattern reached through a rotated transform', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#ff0000"/></pattern></defs><g transform="rotate(45)"><rect width="100" height="100" fill="url(#p)"/></g></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('rotated or skewed'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/\/Pattern\s+cs/);
    });

    it('shifts pattern content by the tile x/y offset to stay aligned with the bbox instead of getting clipped by it', async () => {
        /*
         * Mirrors the real bug: a <pattern x="4" ...> moves where the
         * tile's bbox sits in device space, but the content itself is
         * still authored starting at its own local (0,0) — if the
         * content operators aren't shifted by that same offset, they
         * land outside (or only partially inside) the now-relocated
         * bbox and get clipped by it, since a PDF tiling pattern's
         * /BBox is always a hard clip.
         */
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse" x="4"><rect width="6" height="12" fill="#33aa55"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/\/(P\d+)\s+scn/);
        expect(match).not.toBeNull();
        const patternContent = getPatternContentText(doc, 0, match![1]);
        // The content-drawing `cm` (applied once, before the rect's own local-origin path data) must carry the tile's x=4 offset in its `e` component — otherwise the rect is drawn outside the also-shifted bbox and gets clipped away.
        const cm = patternContent.match(
            /^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm/m,
        );
        expect(cm).not.toBeNull();
        expect(Number(cm![5])).toBeCloseTo(4, 5);
    });

    it('warns and skips unsupported content (e.g. <image>) inside a <pattern> cell, but still draws the rest', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/><circle cx="5" cy="5" r="5" fill="#0000ff"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>`,
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('<image> inside <pattern> content'))).toBe(
            true,
        );
        const content = getPageContentText(doc, 0);
        const match = content.match(/\/(P\d+)\s+scn/);
        expect(match).not.toBeNull();
        const patternContent = getPatternContentText(doc, 0, match![1]);
        expect(patternContent).toMatch(/0 0 1 rg/);
    });
});
