import { PDF as LibPDF } from '@libpdf/core';

import { describe, expect, it, vi } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText, ONE_PIXEL_PNG_DATA_URI } from './helpers';

describe('embedSvgInPdf (image)', () => {
    it('draws a data: URI <image> stretched to the exact box for preserveAspectRatio="none"', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40" preserveAspectRatio="none"/></svg>`,
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\s*\/\w+ Do/);
        expect(match).not.toBeNull();
        const [, w, h, x, y] = match!.map(Number);
        expect(w).toBeCloseTo(30);
        expect(h).toBeCloseTo(40);
        expect(x).toBeCloseTo(10);
        // -(imgY + imgHeight) = -(20 + 40)
        expect(y).toBeCloseTo(-60);
    });

    it('fits (centers + scales) a square image inside a non-square box for the default "meet" mode', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40"/></svg>`,
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\s*\/\w+ Do/);
        expect(match).not.toBeNull();
        const [, w, h, x, y] = match!.map(Number);
        // A 1:1 image in a 30x40 box: constrained by the narrower dimension (30), so it draws as 30x30, centered vertically.
        expect(w).toBeCloseTo(30);
        expect(h).toBeCloseTo(30);
        expect(x).toBeCloseTo(10);
        // imgY = 20 + (40 - 30) / 2 = 25; drawImage y = -(imgY + imgHeight) = -(25 + 30)
        expect(y).toBeCloseTo(-55);
    });

    it('warns and skips (without crashing) when the data: URI is not valid base64', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><image href="data:image/png;base64,!!!not-valid-base64!!!" width="10" height="10"/></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/Do\b/);
    });

    it('warns and skips an external-URL <image> when no fetchImage function is provided (default: no network requests)', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('fetchImage'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/Do\b/);
    });

    it('embeds an external-URL <image> by calling the caller-supplied fetchImage', async () => {
        const doc = LibPDF.create();
        const pngBase64 = ONE_PIXEL_PNG_DATA_URI.slice(ONE_PIXEL_PNG_DATA_URI.indexOf(',') + 1);
        const bytes = new Uint8Array(Buffer.from(pngBase64, 'base64'));
        const fetchImage = vi.fn(async () => ({ bytes, mimeType: 'image/png' }));
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
            rotation: 0,
            fetchImage,
        });
        expect(fetchImage).toHaveBeenCalledWith('https://example.com/a.png');
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\/\w+ Do/);
    });

    it('warns and skips (without crashing) when fetchImage throws or returns null', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
            rotation: 0,
            fetchImage: async () => {
                throw new Error('network error');
            },
        });
        expect(result.warnings.some((w) => w.includes('could not be fetched'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/Do\b/);
    });

    it('never calls fetchImage for a non-external href, even if provided', async () => {
        const doc = LibPDF.create();
        const fetchImage = vi.fn();
        await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></svg>`,
            rotation: 0,
            fetchImage,
        });
        expect(fetchImage).not.toHaveBeenCalled();
    });

    it('warns and skips a non-JPEG/PNG image when no normalizeImage is supplied (no OffscreenCanvas in Node)', async () => {
        const doc = LibPDF.create();
        const webpDataUri = `data:image/webp;base64,${Buffer.from('not-a-real-image').toString('base64')}`;
        const result = await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><image href="${webpDataUri}" width="10" height="10"/></svg>`,
            rotation: 0,
        });
        expect(result.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
        const content = getPageContentText(doc, 0);
        expect(content).not.toMatch(/Do\b/);
    });

    it('embeds a non-JPEG/PNG image by calling the caller-supplied normalizeImage', async () => {
        const doc = LibPDF.create();
        const webpDataUri = `data:image/webp;base64,${Buffer.from('not-a-real-image').toString('base64')}`;
        const pngBase64 = ONE_PIXEL_PNG_DATA_URI.slice(ONE_PIXEL_PNG_DATA_URI.indexOf(',') + 1);
        const pngBytes = new Uint8Array(Buffer.from(pngBase64, 'base64'));
        const normalizeImage = vi.fn(async () => pngBytes);
        const result = await embedSvgInPdf(doc, {
            svgText: `<svg viewBox="0 0 100 100"><image href="${webpDataUri}" width="10" height="10"/></svg>`,
            rotation: 0,
            normalizeImage,
        });
        expect(normalizeImage).toHaveBeenCalledWith(
            new Uint8Array(Buffer.from('not-a-real-image')),
            'image/webp',
        );
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        expect(content).toMatch(/\/\w+ Do/);
    });

    describe('SVG payload', () => {
        const innerSvg =
            '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';
        const base64SvgDataUri = `data:image/svg+xml;base64,${Buffer.from(innerSvg).toString('base64')}`;
        const plainSvgDataUri = `data:image/svg+xml,${encodeURIComponent(innerSvg)}`;

        it('draws a base64 SVG-payload <image> as real path-fill operators, not an image XObject', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${base64SvgDataUri}" x="10" y="20" width="30" height="40"/></svg>`,
                rotation: 0,
            });
            expect(result.warnings).toEqual([]);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/\/\w+ Do/);
            expect(content).toMatch(/\bf\*?\b/);
        });

        it('draws a plain/percent-encoded (non-base64) SVG-payload <image> identically', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${plainSvgDataUri}" x="10" y="20" width="30" height="40"/></svg>`,
                rotation: 0,
            });
            expect(result.warnings).toEqual([]);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/\/\w+ Do/);
            expect(content).toMatch(/\bf\*?\b/);
        });

        it('fits the SVG payload into the box differently for "none" vs the default "meet"', async () => {
            const wideInner =
                '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
            const wideDataUri = `data:image/svg+xml;base64,${Buffer.from(wideInner).toString('base64')}`;

            const meetDoc = LibPDF.create();
            await embedSvgInPdf(meetDoc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${wideDataUri}" x="0" y="0" width="30" height="40"/></svg>`,
                rotation: 0,
            });
            const meetContent = getPageContentText(meetDoc, 0);

            const noneDoc = LibPDF.create();
            await embedSvgInPdf(noneDoc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${wideDataUri}" x="0" y="0" width="30" height="40" preserveAspectRatio="none"/></svg>`,
                rotation: 0,
            });
            const noneContent = getPageContentText(noneDoc, 0);

            // "meet" uniformly scales a 10x10 viewBox into a 30x40 box (constrained by the narrower dimension, 30x30); "none" stretches to fill it exactly (30x40) — the two resulting `cm` matrices differ.
            expect(meetContent).not.toBe(noneContent);
        });

        it('registers a ca/CA ExtGState for opacity on an SVG-payload <image>', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${base64SvgDataUri}" x="0" y="0" width="10" height="10" opacity="0.5"/></svg>`,
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/GS\d+ gs/);
        });

        it('renders an external .svg fetched via fetchImage as vector content', async () => {
            const doc = LibPDF.create();
            const fetchImage = vi.fn(async () => ({
                bytes: new TextEncoder().encode(innerSvg),
                mimeType: 'image/svg+xml',
            }));
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><image href="https://example.com/a.svg" width="10" height="10"/></svg>',
                rotation: 0,
                fetchImage,
            });
            expect(fetchImage).toHaveBeenCalledWith('https://example.com/a.svg');
            expect(result.warnings).toEqual([]);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/\/\w+ Do/);
            expect(content).toMatch(/\bf\*?\b/);
        });

        it('warns and skips a malformed SVG payload instead of throwing', async () => {
            const doc = LibPDF.create();
            const malformedDataUri = `data:image/svg+xml;base64,${Buffer.from('<svg><rect').toString('base64')}`;
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${malformedDataUri}" width="10" height="10"/></svg>`,
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('could not be parsed'))).toBe(true);
        });

        it('stops recursing past the nesting-depth limit instead of hanging (guards against self-reference)', async () => {
            /*
             * A true A->A self-reference can't be constructed as a
             * literal data: URI (it would have to encode its own exact
             * bytes); this instead chains distinct SVG-payload
             * <image>s past MAX_IMAGE_EMBED_DEPTH, which exercises the
             * same guard a self-reference (or a longer A->B->A cycle)
             * would eventually hit.
             */
            const buildNestedSvg = (depth: number): string => {
                if (depth === 0)
                    return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
                const innerDataUri = `data:image/svg+xml;base64,${Buffer.from(buildNestedSvg(depth - 1)).toString('base64')}`;
                return `<svg viewBox="0 0 10 10"><image href="${innerDataUri}" width="10" height="10"/></svg>`;
            };
            const deepDataUri = `data:image/svg+xml;base64,${Buffer.from(buildNestedSvg(10)).toString('base64')}`;
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${deepDataUri}" width="10" height="10"/></svg>`,
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('nesting too deep'))).toBe(true);
        });
    });
});
