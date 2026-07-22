import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { imagesOf, ONE_PIXEL_PNG_DATA_URI } from './helpers';

describe('parseSvgDocument (image)', () => {
    it('parses an inline data: URI <image> with position/size', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40"/></svg>`,
        );
        const images = imagesOf(doc);
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({
            href: ONE_PIXEL_PNG_DATA_URI,
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            preserveAspectRatio: 'meet',
            opacity: 1,
        });
    });

    it('reads xlink:href as a fallback', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></svg>`,
        );
        expect(imagesOf(doc)).toHaveLength(1);
    });

    it("passes an external URL href through unchanged (fetching it is an adapter/caller concern, not this layer's)", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
        );
        expect(imagesOf(doc)).toHaveLength(1);
        expect(imagesOf(doc)[0]).toMatchObject({ href: 'https://example.com/a.png' });
        expect(doc.warnings).toEqual([]);
    });

    it('warns and skips when href is missing', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><image width="10" height="10"/></svg>',
        );
        expect(imagesOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('without a href'))).toBe(true);
    });

    it('skips silently (no instruction, no warning) when width or height is zero', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="0" height="10"/></svg>`,
        );
        expect(imagesOf(doc)).toHaveLength(0);
        expect(doc.warnings).toEqual([]);
    });

    it('warns and skips (rather than silently vanishing) when width or height is omitted entirely', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" height="10"/></svg>`,
        );
        expect(imagesOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('intrinsic image-size'))).toBe(true);
    });

    it('parses preserveAspectRatio="none" as the stretch mode', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" preserveAspectRatio="none"/></svg>`,
        );
        expect(imagesOf(doc)[0].preserveAspectRatio).toBe('none');
    });

    it('falls back to "meet" with a warning for a "slice" preserveAspectRatio', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" preserveAspectRatio="xMidYMid slice"/></svg>`,
        );
        expect(imagesOf(doc)[0].preserveAspectRatio).toBe('meet');
        expect(doc.warnings.some((w) => w.includes('"slice"'))).toBe(true);
    });

    it('carries opacity through from the presentation attribute', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" opacity="0.4"/></svg>`,
        );
        expect(imagesOf(doc)[0].opacity).toBeCloseTo(0.4);
    });

    it('wraps a transformed <image> in a pushMatrix/popMatrix bracket', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><g transform="translate(5,5)"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></g></svg>`,
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushMatrix', 'image', 'popMatrix']);
    });
});
