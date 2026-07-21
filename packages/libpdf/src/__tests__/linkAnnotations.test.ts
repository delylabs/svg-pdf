import { PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText } from './helpers';

describe('embedSvgInPdf (<a href> link annotations)', () => {
    it('adds a clickable link annotation sized to the wrapped shape, in page space', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><a href="https://example.com"><rect x="10" y="20" width="30" height="40"/></a></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        expect(links[0].uri).toBe('https://example.com');
        // viewBox (0,0,100,100) maps 1:1 onto a 100x100 page, Y-flipped: local y=20..60 becomes page y=40..80.
        expect(links[0].rect.x).toBeCloseTo(10);
        expect(links[0].rect.width).toBeCloseTo(30);
        expect(links[0].rect.y).toBeCloseTo(40);
        expect(links[0].rect.height).toBeCloseTo(40);
    });

    it('does not add a link annotation for an <a> without an href', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 100 100"><a><rect width="10" height="10"/></a></svg>',
            rotation: 0,
        });
        expect(doc.getPages()[0].getLinkAnnotations()).toHaveLength(0);
    });

    it('does not add a link annotation for an <a> wrapping no drawable content', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 100 100"><a href="https://example.com"></a></svg>',
            rotation: 0,
        });
        expect(doc.getPages()[0].getLinkAnnotations()).toHaveLength(0);
    });

    it('unions the bboxes of every shape/text/image wrapped in the same <a>', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><a href="https://example.com"><rect x="10" y="10" width="10" height="10"/><rect x="60" y="60" width="10" height="10"/></a></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        // Union of (10,10)-(20,20) and (60,60)-(70,70) in local space, y-flipped onto the page.
        expect(links[0].rect.x).toBeCloseTo(10);
        expect(links[0].rect.width).toBeCloseTo(60);
        expect(links[0].rect.y).toBeCloseTo(30);
        expect(links[0].rect.height).toBeCloseTo(60);
    });

    it('includes an invisible (fill="none") shape in the link area — a common clickable-overlay pattern', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><a href="https://example.com"><rect x="10" y="10" width="20" height="20" fill="none"/></a></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        expect(links[0].rect.width).toBeCloseTo(20);
        expect(links[0].rect.height).toBeCloseTo(20);
    });

    it('warns and skips an internal fragment href, drawing the content without a link', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><a href="#somewhere"><rect width="10" height="10"/></a></svg>',
            rotation: 0,
        });
        expect(doc.getPages()[0].getLinkAnnotations()).toHaveLength(0);
        expect(result.warnings.some((w) => w.includes('fragment'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\bf\b/);
    });

    it('positions the link correctly under a nested transform', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><g transform="translate(20,0)"><a href="https://example.com"><rect x="0" y="0" width="10" height="10"/></a></g></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        expect(links[0].rect.x).toBeCloseTo(20);
        expect(links[0].rect.width).toBeCloseTo(10);
    });

    it('adds a link annotation for an <a> nested directly inside <text> (a link on bare text)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="10" y="20"><a href="https://example.com">Click</a></text></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        expect(links[0].uri).toBe('https://example.com');
    });

    it('adds a link annotation for an <a> nested inside a <tspan>', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><text x="10" y="20">A <tspan><a href="https://example.com">link</a></tspan></text></svg>',
            rotation: 0,
        });
        const links = doc.getPages()[0].getLinkAnnotations();
        expect(links).toHaveLength(1);
        expect(links[0].uri).toBe('https://example.com');
    });
});
