import { ops, PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText, hasFixtures, loadFixture } from './helpers';

describe('embedSvgInPdf (page setup)', () => {
    it('adds one page sized from the SVG viewBox (no pageSize given)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 200 100"><rect width="10" height="10"/></svg>',
            rotation: 0,
        });
        expect(doc.getPages()).toHaveLength(1);
        const page = doc.getPages()[0];
        expect(page.width).toBeCloseTo(200);
        expect(page.height).toBeCloseTo(100);
    });

    it('sizes the page from mm width/height (converted to points), not the raw viewBox numbers, when they differ hugely (e.g. a LibreOffice Draw export)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg width="297mm" height="210mm" viewBox="0 0 29700 21000"><rect width="10" height="10"/></svg>',
            rotation: 0,
        });
        const page = doc.getPages()[0];
        // A4 landscape in points, not the un-converted 297 x 210.
        expect(page.width).toBeCloseTo(841.89, 1);
        expect(page.height).toBeCloseTo(595.28, 1);
    });

    it('scales content by drawWidth/viewBoxWidth, not drawWidth/display-width, when they differ (the actual bug: without this, content is scaled ~100x too large and only a tiny corner of it is visible)', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg width="297mm" height="210mm" viewBox="0 0 29700 21000"><rect width="10" height="10"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
        expect(match).not.toBeNull();
        // scale = drawWidth (≈841.89pt) / viewBoxWidth (29700), not / display width (297).
        expect(Number(match![1])).toBeCloseTo(841.89 / 29700, 5);
    });

    it('letterboxes (uniform scale, centered) an aspect-mismatched viewBox by default, rather than distorting it', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg width="200" height="100" viewBox="0 0 50 50"><rect width="50" height="50"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
        expect(match).not.toBeNull();
        const [, a, d] = match!.map(Number);
        // Uniform scale (min of 200/50=4, 100/50=2 → 2), not the independent 4/2 stretch a naive per-axis fit would produce.
        expect(a).toBeCloseTo(2);
        expect(Math.abs(d)).toBeCloseTo(2);
    });

    it('stretches an aspect-mismatched viewBox independently for preserveAspectRatio="none"', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg width="200" height="100" viewBox="0 0 50 50" preserveAspectRatio="none"><rect width="50" height="50"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
        expect(match).not.toBeNull();
        const [, a, d] = match!.map(Number);
        expect(a).toBeCloseTo(4);
        expect(Math.abs(d)).toBeCloseTo(2);
    });

    it('applies page rotation', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
            rotation: 90,
        });
        expect(doc.getPages()[0].rotation).toBe(90);
    });

    it('returns collected warnings for unsupported elements instead of throwing', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 10 10"><image href="a.png" width="5" height="5"/><rect width="10" height="10"/></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('image'))).toBe(true);
        expect(doc.getPages()).toHaveLength(1);
    });

    it('throws FILE_CORRUPT_OR_INVALID for malformed SVG, matching the image-embed error convention', async () => {
        const doc = LibPDF.create();
        await expect(
            embedSvgInPdf(doc, {
                svgText: '<svg><rect></svg>',
                rotation: 0,
                name: 'bad.svg',
            }),
        ).rejects.toThrow(/FILE_CORRUPT_OR_INVALID: bad\.svg/);
    });

    it('centers the SVG within a larger explicit pageSize', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
            rotation: 0,
            pageSize: { width: 200, height: 300 },
        });
        const page = doc.getPages()[0];
        expect(page.width).toBeCloseTo(200);
        expect(page.height).toBeCloseTo(300);
    });
});

describe('embedSvgInPdf (transforms)', () => {
    it('wraps nested <g transform> content in balanced push/pop graphics state operators', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><g transform="translate(10,10)"><rect width="5" height="5" fill="#000000"/></g></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
        expect(pushCount).toBeGreaterThanOrEqual(2); // root matrix push + the <g>'s own push
    });

    it('keeps the root viewBox-to-page matrix active for the first drawn shape', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><g transform="translate(10,10)"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></g></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const fillIndex = content.indexOf('1 0 0 rg');
        expect(fillIndex).toBeGreaterThan(-1);
        const before = content.slice(0, fillIndex);
        const pushCount = (before.match(/(^|\s)q(\s|$)/g) ?? []).length;
        const popCount = (before.match(/(^|\s)Q(\s|$)/g) ?? []).length;
        /*
         * Root matrix push + the <g>'s own push must both still be open when the
         * shape draws. @libpdf/core isolates a page's very first drawOperators()
         * call in its own q/Q once a second call arrives (see the canary test
         * below) — the workaround in embed.ts is a no-op first call so the
         * root matrix survives as the *second* call instead. If that regresses,
         * this nets to 0 or 1 instead of 2.
         */
        expect(pushCount - popCount).toBeGreaterThanOrEqual(2);
        expect(before).toContain('1 0 0 -1 0 100 cm');
    });
});

describe('embedSvgInPdf (nested svg)', () => {
    it('draws content from a nested <svg>, offset and scaled to its own viewBox', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><svg x="10" y="20" width="40" height="20" viewBox="0 0 20 10"><rect width="20" height="10" fill="#ff0000"/></svg></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/1 0 0 rg/);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
    });

    it('clips content to the nested viewport by default', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><svg width="20" height="10"><rect width="20" height="10" fill="#ff0000"/></svg></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\bW\b\s*\n?\s*n\b/);
    });

    it('defaults a nested <svg> without explicit width/height to 100% of the parent viewport', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><svg><rect width="10" height="10" fill="#ff0000"/></svg></svg>',
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/1 0 0 rg/);
    });
});

describe.skipIf(!hasFixtures)('embedSvgInPdf (real-world-shaped fixtures)', () => {
    it('embeds a minimal line icon as a single sized page', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('icon-line-simple.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        expect(doc.getPages()).toHaveLength(1);
        expect(doc.getPages()[0].width).toBeCloseTo(24);
    });

    it('embeds a flag-shaped SVG with visible fill content', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('star-ring.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        expect(content.length).toBeGreaterThan(1000);
    });

    it('embeds a stress-test mandala (220+ paths through a real matrix() root transform)', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('stress-mandala.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
        expect(pushCount).toBeGreaterThan(200);
    }, 15000);

    it('embeds a kitchen-sink SVG (gradients/patterns/clip/mask/filter/text/CSS at once) without throwing', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('kitchen-sink.svg'),
            rotation: 0,
        });
        expect(doc.getPages()).toHaveLength(1);
        expect(doc.getPages()[0].width).toBeCloseTo(800);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('correctly sizes and scales a mm/viewBox-mismatched export', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: loadFixture('libreoffice-export-sample.svg'),
            rotation: 0,
        });
        expect(doc.getPages()).toHaveLength(1);
        const page = doc.getPages()[0];
        // A4 landscape in points, not the un-converted 297 x 210.
        expect(page.width).toBeCloseTo(841.89, 0);
        expect(page.height).toBeCloseTo(595.28, 0);
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
        expect(match).not.toBeNull();
        // scale = drawWidth (≈841.89pt) / viewBoxWidth (29700) ≈ 0.02835, not / display width (297) ≈ 2.835 (100x too large).
        expect(Number(match![1])).toBeCloseTo(841.89 / 29700, 3);
        // @libpdf/core names every embedded XObject (images included) with an "Fm" prefix, not "Im".
        expect(content).toMatch(/\/\w+ Do/);
    });
});

describe('@libpdf/core content-stream isolation quirk (canary)', () => {
    it('still isolates the page’s first drawOperators() call once a second call arrives', () => {
        const doc = LibPDF.create();
        const page = doc.addPage({ width: 100, height: 100 });
        page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(2, 0, 0, 2, 0, 0)]);
        page.drawOperators([ops.pushGraphicsState(), ops.popGraphicsState()]);
        const content = getPageContentText(doc, 0);
        /*
         * If @libpdf/core ever stops isolating a page's first drawOperators()
         * call, this assertion fails — that's the signal to delete the no-op
         * first call workaround in embed.ts (see its comment) and this test.
         */
        expect(content).toMatch(/2 0 0 2 0 0 cm\s*\n?\s*Q/);
    });
});
