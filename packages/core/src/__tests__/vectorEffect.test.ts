import { describe, expect, it } from 'vitest';

import { getMatrixScale, IDENTITY_MATRIX, parseSvgDocument, scaleMatrix } from '..';

describe('getMatrixScale', () => {
    it('computes scale 1 for identity matrix', () => {
        expect(getMatrixScale(IDENTITY_MATRIX)).toBe(1);
    });

    it('computes scale for uniform scaling matrix', () => {
        expect(getMatrixScale(scaleMatrix(2))).toBe(2);
        expect(getMatrixScale(scaleMatrix(0.5))).toBe(0.5);
    });

    it('computes scale for non-uniform scaling matrix', () => {
        expect(getMatrixScale(scaleMatrix(2, 8))).toBe(4);
    });
});

describe('parseSvgDocument with vector-effect', () => {
    it('extracts vector-effect attribute and CSS property on shapes', () => {
        const svg = `
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <style>
                    .non-scaling { vector-effect: non-scaling-stroke; }
                </style>
                <circle cx="20" cy="20" r="10" vector-effect="non-scaling-stroke" />
                <circle class="non-scaling" cx="50" cy="50" r="10" />
                <circle cx="80" cy="80" r="10" />
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const shapes = parsed.instructions.filter((i) => i.type === 'shape');
        expect(shapes).toHaveLength(3);
        expect(shapes[0].vectorEffect).toBe('non-scaling-stroke');
        expect(shapes[1].vectorEffect).toBe('non-scaling-stroke');
        expect(shapes[2].vectorEffect).toBe('none');
    });
});
