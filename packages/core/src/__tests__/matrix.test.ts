import { describe, expect, it } from 'vitest';

import { IDENTITY_MATRIX, type Matrix2D, multiplyMatrix, parseTransformList } from '..';

const applyMatrix = (m: Matrix2D, x: number, y: number) => ({
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
});

describe('multiplyMatrix', () => {
    it('is the identity when combined with the identity matrix', () => {
        const m: Matrix2D = { a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 };
        expect(multiplyMatrix(m, IDENTITY_MATRIX)).toEqual(m);
        expect(multiplyMatrix(IDENTITY_MATRIX, m)).toEqual(m);
    });
});

describe('parseTransformList', () => {
    it('returns identity for null/empty input', () => {
        expect(parseTransformList(null)).toEqual(IDENTITY_MATRIX);
        expect(parseTransformList('')).toEqual(IDENTITY_MATRIX);
    });

    it('parses a single translate', () => {
        const m = parseTransformList('translate(10,20)');
        expect(applyMatrix(m, 0, 0)).toEqual({ x: 10, y: 20 });
    });

    it('parses a single scale (uniform when only one arg given)', () => {
        const m = parseTransformList('scale(2)');
        expect(applyMatrix(m, 3, 4)).toEqual({ x: 6, y: 8 });
    });

    it('parses rotate(90) as a quarter turn', () => {
        const m = parseTransformList('rotate(90)');
        const p = applyMatrix(m, 1, 0);
        expect(p.x).toBeCloseTo(0);
        expect(p.y).toBeCloseTo(1);
    });

    it('applies the rightmost/innermost function first: "translate(10,0) scale(2)"', () => {
        // Nests like <g translate(10,0)><g scale(2)>point</g></g> — scale applies first.
        const m = parseTransformList('translate(10,0) scale(2)');
        expect(applyMatrix(m, 1, 0)).toEqual({ x: 12, y: 0 });
    });

    it('parses an explicit matrix() the same as the raw SVG attribute values', () => {
        const m = parseTransformList('matrix(1,0,0,1,10,20)');
        expect(applyMatrix(m, 0, 0)).toEqual({ x: 10, y: 20 });
    });
});
