import { describe, expect, it } from 'vitest';

import { DEFAULT_PAINT_ORDER, parsePaintOrder, parseSvgDocument } from '..';

describe('parsePaintOrder', () => {
    it('parses normal, empty, or null as DEFAULT_PAINT_ORDER', () => {
        expect(parsePaintOrder(null, DEFAULT_PAINT_ORDER)).toEqual(DEFAULT_PAINT_ORDER);
        expect(parsePaintOrder('', DEFAULT_PAINT_ORDER)).toEqual(DEFAULT_PAINT_ORDER);
        expect(parsePaintOrder('normal', DEFAULT_PAINT_ORDER)).toEqual(DEFAULT_PAINT_ORDER);
    });

    it('appends missing keywords in default order', () => {
        expect(parsePaintOrder('stroke', DEFAULT_PAINT_ORDER)).toEqual([
            'stroke',
            'fill',
            'markers',
        ]);
        expect(parsePaintOrder('markers stroke', DEFAULT_PAINT_ORDER)).toEqual([
            'markers',
            'stroke',
            'fill',
        ]);
    });

    it('handles explicit full combinations', () => {
        expect(parsePaintOrder('stroke fill markers', DEFAULT_PAINT_ORDER)).toEqual([
            'stroke',
            'fill',
            'markers',
        ]);
        expect(parsePaintOrder('stroke markers fill', DEFAULT_PAINT_ORDER)).toEqual([
            'stroke',
            'markers',
            'fill',
        ]);
    });

    it('falls back to inherited for unknown tokens only', () => {
        expect(parsePaintOrder('invalid', ['stroke', 'fill', 'markers'])).toEqual([
            'stroke',
            'fill',
            'markers',
        ]);
    });
});

describe('parseSvgDocument with paint-order', () => {
    it('extracts paint-order attribute and CSS style on shapes', () => {
        const svg = `
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <style>
                    .reversed { paint-order: stroke fill; }
                </style>
                <rect x="0" y="0" width="10" height="10" paint-order="stroke fill markers" />
                <rect class="reversed" x="10" y="10" width="10" height="10" />
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const shapes = parsed.instructions.filter((i) => i.type === 'shape');
        expect(shapes).toHaveLength(2);
        expect(shapes[0].paintOrder).toEqual(['stroke', 'fill', 'markers']);
        expect(shapes[1].paintOrder).toEqual(['stroke', 'fill', 'markers']);
    });
});
