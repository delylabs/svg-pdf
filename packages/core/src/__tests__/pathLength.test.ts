import { describe, expect, it } from 'vitest';

import {
    computeCumulativeLengths,
    flattenPathToPolyline,
    pointAtLength,
} from '../geometry/pathLength';

describe('flattenPathToPolyline', () => {
    it('keeps M/L points exactly, with no extra subdivision', () => {
        const points = flattenPathToPolyline('M0 0 L100 0 L100 100');
        expect(points).toEqual([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
        ]);
    });

    it('subdivides a cubic curve into multiple line segments', () => {
        const points = flattenPathToPolyline('M0 0 C0 100 100 100 100 0');
        expect(points.length).toBeGreaterThan(2);
        expect(points[0]).toEqual({ x: 0, y: 0 });
        expect(points[points.length - 1]).toEqual({ x: 100, y: 0 });
    });

    it('flattens an elliptical arc (converted to cubics by normalizePathData) into a smooth polyline', () => {
        const points = flattenPathToPolyline('M0 0 A 50 50 0 0 1 100 0');
        expect(points.length).toBeGreaterThan(4);
        expect(points[0]).toEqual({ x: 0, y: 0 });
        expect(points[points.length - 1].x).toBeCloseTo(100);
        expect(points[points.length - 1].y).toBeCloseTo(0);
    });

    it('closes back to the subpath start on Z', () => {
        const points = flattenPathToPolyline('M0 0 L100 0 L100 100 Z');
        expect(points[points.length - 1]).toEqual({ x: 0, y: 0 });
    });

    it('returns an empty array for an empty/unparseable path', () => {
        expect(flattenPathToPolyline('')).toEqual([]);
    });
});

describe('computeCumulativeLengths', () => {
    it('starts at 0 and accumulates straight-line distances', () => {
        const points = [
            { x: 0, y: 0 },
            { x: 3, y: 4 },
            { x: 3, y: 10 },
        ];
        expect(computeCumulativeLengths(points)).toEqual([0, 5, 11]);
    });

    it('returns [0] for a single point', () => {
        expect(computeCumulativeLengths([{ x: 5, y: 5 }])).toEqual([0]);
    });
});

describe('pointAtLength', () => {
    const points = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
    ];
    const cumLengths = computeCumulativeLengths(points);

    it('returns the exact point at distance 0', () => {
        expect(pointAtLength(points, cumLengths, 0)).toEqual({ x: 0, y: 0, angle: 0 });
    });

    it('interpolates a midpoint within a segment', () => {
        const p = pointAtLength(points, cumLengths, 50);
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(50);
        expect(p!.y).toBeCloseTo(0);
        expect(p!.angle).toBeCloseTo(0);
    });

    it('crosses into the next segment with a different tangent angle', () => {
        const p = pointAtLength(points, cumLengths, 150);
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(100);
        expect(p!.y).toBeCloseTo(50);
        expect(p!.angle).toBeCloseTo(Math.PI / 2);
    });

    it('returns the exact final point at the total length', () => {
        const total = cumLengths[cumLengths.length - 1];
        const p = pointAtLength(points, cumLengths, total);
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(100);
        expect(p!.y).toBeCloseTo(100);
    });

    it('returns null for a distance past the end of the path', () => {
        const total = cumLengths[cumLengths.length - 1];
        expect(pointAtLength(points, cumLengths, total + 1)).toBeNull();
    });

    it('returns null for a negative distance', () => {
        expect(pointAtLength(points, cumLengths, -1)).toBeNull();
    });

    it('returns null for fewer than 2 points', () => {
        expect(pointAtLength([{ x: 0, y: 0 }], [0], 0)).toBeNull();
    });
});
