import { describe, expect, it } from 'vitest';

import { computePathBBox } from '../geometry/bbox';

describe('computePathBBox', () => {
    it('returns null for an empty/unparseable path', () => {
        expect(computePathBBox('')).toBeNull();
    });

    it('computes the bbox of a simple absolute line path', () => {
        const box = computePathBBox('M 10 20 L 110 20 L 110 70 L 10 70 Z');
        expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    });

    it('resolves relative commands against the current point', () => {
        // Same rectangle as above, written with relative commands.
        const box = computePathBBox('m 10 20 l 100 0 l 0 50 l -100 0 z');
        expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    });

    it('treats extra coordinate pairs after M as implicit linetos', () => {
        // M with 3 points then Z should close back to the first point, not the last.
        const box = computePathBBox('M 0 0 100 0 100 100 Z');
        expect(box).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    });

    it('includes cubic bezier control points in the box (over-estimate, not tight fit)', () => {
        const box = computePathBBox('M 0 0 C 0 -50 100 -50 100 0');
        expect(box).not.toBeNull();
        expect(box!.y).toBeLessThanOrEqual(-50);
    });

    it('expands S (smooth cubic) shorthand using the mirrored previous control point', () => {
        const box = computePathBBox('M 0 0 C 0 10 10 10 10 0 S 30 -10 30 0');
        expect(box).not.toBeNull();
        expect(box!.width).toBeCloseTo(30);
    });

    it('expands T (smooth quadratic) shorthand using the mirrored previous control point', () => {
        const box = computePathBBox('M 0 0 Q 10 20 20 0 T 40 0');
        expect(box).not.toBeNull();
        expect(box!.width).toBeCloseTo(40);
    });

    it('handles H/V shorthand line commands', () => {
        const box = computePathBBox('M 0 0 H 50 V 30 H 0 Z');
        expect(box).toEqual({ x: 0, y: 0, width: 50, height: 30 });
    });

    it('approximates an arc within its bounding radius', () => {
        // Quarter-circle arc of radius 50 from (50,0) to (0,50) centered at origin.
        const box = computePathBBox('M 50 0 A 50 50 0 0 1 0 50');
        expect(box).not.toBeNull();
        expect(box!.x).toBeCloseTo(0, 0);
        expect(box!.y).toBeCloseTo(0, 0);
        expect(box!.width).toBeCloseTo(50, 0);
        expect(box!.height).toBeCloseTo(50, 0);
    });

    it('handles multiple subpaths, each with their own close point', () => {
        const box = computePathBBox('M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z');
        expect(box).toEqual({ x: 0, y: 0, width: 30, height: 30 });
    });
});
