import { describe, expect, it } from 'vitest';

import { DEFAULT_PAINT_ORDER, parsePaintOrder } from '../paint';

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
