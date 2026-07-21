import { describe, expect, it } from 'vitest';

import { computeMarkerVertices } from '../markerVertices';

describe('computeMarkerVertices', () => {
    it('returns an empty list for an empty/unparseable path', () => {
        expect(computeMarkerVertices('')).toEqual([]);
    });

    it('places start/end on a straight 2-point line, both angled along it', () => {
        const vertices = computeMarkerVertices('M 0 0 L 10 0');
        expect(vertices).toHaveLength(2);
        expect(vertices[0]).toMatchObject({ x: 0, y: 0, angle: 0, type: 'start' });
        expect(vertices[1]).toMatchObject({ x: 10, y: 0, angle: 0, type: 'end' });
    });

    it('orients the mid vertex of a right angle along the bisector', () => {
        const vertices = computeMarkerVertices('M 0 0 L 10 0 L 10 10');
        expect(vertices).toHaveLength(3);
        expect(vertices[1].type).toBe('mid');
        // Incoming (1,0) + outgoing (0,1) bisects to 45°.
        expect(vertices[1].angle).toBeCloseTo(Math.PI / 4);
    });

    it('points marker-end back along the incoming segment for a line going left', () => {
        const vertices = computeMarkerVertices('M 10 0 L 0 0');
        expect(vertices[1]).toMatchObject({ x: 0, y: 0, type: 'end' });
        expect(vertices[1].angle).toBeCloseTo(Math.PI);
    });

    it('resolves a lone moveto with no following segment to angle 0', () => {
        const vertices = computeMarkerVertices('M 5 5');
        expect(vertices).toEqual([{ x: 5, y: 5, angle: 0, type: 'start' }]);
    });

    it('orients tangents from cubic curve control points, not the chord', () => {
        // A curve that leaves straight up (control point directly above the start) then arrives from the left.
        const vertices = computeMarkerVertices('M 0 0 C 0 -10 -10 -10 -10 0');
        expect(vertices[0].angle).toBeCloseTo(-Math.PI / 2);
    });

    it('closes a square: start uses only the outgoing edge, ignoring the Z closing tangent', () => {
        const vertices = computeMarkerVertices('M 0 0 L 10 0 L 10 10 L 0 10 Z');
        expect(vertices[0]).toMatchObject({ x: 0, y: 0, type: 'start' });
        // Outgoing edge (0,0)->(10,0) points along +x, not the Z-closing edge's -y direction.
        expect(vertices[0].angle).toBeCloseTo(0);
    });

    it('places a coincident marker-end at the closing point of a single closed subpath, bisecting the closing and first edges', () => {
        const vertices = computeMarkerVertices('M 0 0 L 10 0 L 10 10 L 0 10 Z');
        // 4 corners -> start + 3 mid (the corner right before Z is now mid, not end) + a separately-appended end at the shared start/end point.
        expect(vertices.map((v) => v.type)).toEqual(['start', 'mid', 'mid', 'mid', 'end']);
        const end = vertices[vertices.length - 1];
        expect(end).toMatchObject({ x: 0, y: 0 });
        // Closing edge (0,10)->(0,0) is (0,-1); first edge (0,0)->(10,0) is (1,0); bisector is -45°.
        expect(end.angle).toBeCloseTo(-Math.PI / 4);
    });

    it('treats every vertex between the first and last as marker-mid, including across multiple subpaths', () => {
        const vertices = computeMarkerVertices('M 0 0 L 10 0 Z M 20 20 L 30 20');
        expect(vertices.map((v) => v.type)).toEqual(['start', 'mid', 'mid', 'end']);
    });

    it("does not duplicate marker-end when a closed subpath isn't the very first vertex of the path", () => {
        // The last subpath's own start (20,20) is a distinct vertex from the path's overall first vertex (0,0), so no coincidence/duplication applies.
        const vertices = computeMarkerVertices('M 0 0 L 10 0 M 20 20 L 30 20 L 30 30 Z');
        expect(vertices.map((v) => v.type)).toEqual(['start', 'mid', 'end', 'mid', 'mid']);
        expect(vertices.filter((v) => v.type === 'end')).toHaveLength(1);
    });
});
