import { describe, expect, it } from 'vitest';

import { computeViewBoxTransform, parsePreserveAspectRatio } from '..';

describe('parsePreserveAspectRatio', () => {
    it('defaults to xMidYMid meet for null/empty/unrecognized input', () => {
        expect(parsePreserveAspectRatio(null)).toEqual({ align: 'xMidYMid', meetOrSlice: 'meet' });
        expect(parsePreserveAspectRatio('')).toEqual({ align: 'xMidYMid', meetOrSlice: 'meet' });
        expect(parsePreserveAspectRatio('bogus')).toEqual({
            align: 'xMidYMid',
            meetOrSlice: 'meet',
        });
    });

    it('parses an explicit align and meetOrSlice', () => {
        expect(parsePreserveAspectRatio('xMinYMax slice')).toEqual({
            align: 'xMinYMax',
            meetOrSlice: 'slice',
        });
    });

    it('defaults meetOrSlice to meet when only align is given', () => {
        expect(parsePreserveAspectRatio('xMaxYMin')).toEqual({
            align: 'xMaxYMin',
            meetOrSlice: 'meet',
        });
    });

    it('ignores a leading "defer" keyword', () => {
        expect(parsePreserveAspectRatio('defer xMinYMin meet')).toEqual({
            align: 'xMinYMin',
            meetOrSlice: 'meet',
        });
    });

    it('parses "none" as an align value with no alignment offset', () => {
        expect(parsePreserveAspectRatio('none')).toEqual({ align: 'none', meetOrSlice: 'meet' });
    });
});

describe('computeViewBoxTransform', () => {
    it('stretches each axis independently for align="none"', () => {
        const m = computeViewBoxTransform(0, 0, 50, 25, 100, 100, 'none');
        expect(m).toEqual({ a: 2, b: 0, c: 0, d: 4, e: 0, f: 0 });
    });

    it('uses the smaller ratio and centers for the default "xMidYMid meet"', () => {
        // 100x50 viewBox into a 100x100 viewport: width ratio 1, height ratio 2 — meet picks the smaller (1), centering vertically.
        const m = computeViewBoxTransform(0, 0, 100, 50, 100, 100, null);
        expect(m.a).toBeCloseTo(1);
        expect(m.d).toBeCloseTo(1);
        // Leftover height (100 - 50*1 = 50) split evenly: offset by 25.
        expect(m.f).toBeCloseTo(25);
        expect(m.e).toBeCloseTo(0);
    });

    it('uses the larger ratio (overflowing) for "meet slice"', () => {
        const m = computeViewBoxTransform(0, 0, 100, 50, 100, 100, 'xMidYMid slice');
        expect(m.a).toBeCloseTo(2);
        expect(m.d).toBeCloseTo(2);
    });

    it('pins content to the min edge for xMinYMin (no centering offset)', () => {
        const m = computeViewBoxTransform(0, 0, 100, 50, 100, 100, 'xMinYMin meet');
        expect(m.e).toBeCloseTo(0);
        expect(m.f).toBeCloseTo(0);
    });

    it('pins content to the max edge for xMaxYMax', () => {
        const m = computeViewBoxTransform(0, 0, 100, 50, 100, 100, 'xMaxYMax meet');
        expect(m.e).toBeCloseTo(0);
        expect(m.f).toBeCloseTo(50); // full leftover height (100 - 50) on the max side
    });

    it('folds the viewBox origin into the translation', () => {
        const m = computeViewBoxTransform(10, 20, 100, 100, 100, 100, 'none');
        expect(m.e).toBeCloseTo(-10);
        expect(m.f).toBeCloseTo(-20);
    });
});
