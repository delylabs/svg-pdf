import { normalizePathData } from './bbox';

/*
 * Where a marker attaches along a path, and the tangent angle `orient="auto"`
 * rotates it to (radians, in the path's own local pre-transform coordinate
 * space — same convention every other angle/matrix in this codebase uses, so
 * composing it with the shape's ambient transform later needs no special
 * Y-flip handling, see `parse/marker.ts`'s marker placement code).
 */
export interface MarkerVertex {
    readonly x: number;
    readonly y: number;
    readonly angle: number;
    readonly type: 'start' | 'mid' | 'end';
}

interface RawVertex {
    x: number;
    y: number;
    dirIn: [number, number] | null;
    dirOut: [number, number] | null;
}

const setDir = (
    target: [number, number] | null,
    dx: number,
    dy: number,
): [number, number] | null => {
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? [dx / len, dy / len] : target;
};

/*
 * Splits a path into its vertices (every M/L/C endpoint, including the
 * implicit vertex Z closes back to) with the tangent direction(s) touching
 * each one — the raw material `computeMarkerVertices` below turns into
 * marker-start/-mid/-end placements. A standalone helper since the direction
 * bookkeeping (an M with no following segment has no tangent at all; Z
 * updates its subpath's *first* vertex, not a new one) doesn't belong mixed
 * into the angle/type logic that only cares about the overall first/last.
 */
const computePathVertices = (d: string): RawVertex[] => {
    const segments = normalizePathData(d);
    const vertices: RawVertex[] = [];
    let current = { x: 0, y: 0 };
    let subpathStart = { x: 0, y: 0 };
    let subpathStartIndex = -1;
    let currentIndex = -1;

    for (const seg of segments) {
        if (seg.cmd === 'M') {
            current = { x: seg.x, y: seg.y };
            subpathStart = current;
            vertices.push({ x: seg.x, y: seg.y, dirIn: null, dirOut: null });
            currentIndex = vertices.length - 1;
            subpathStartIndex = currentIndex;
            continue;
        }
        if (seg.cmd === 'Z') {
            if (
                subpathStartIndex >= 0 &&
                (current.x !== subpathStart.x || current.y !== subpathStart.y)
            ) {
                const dx = subpathStart.x - current.x;
                const dy = subpathStart.y - current.y;
                vertices[currentIndex].dirOut = setDir(vertices[currentIndex].dirOut, dx, dy);
                vertices[subpathStartIndex].dirIn = setDir(
                    vertices[subpathStartIndex].dirIn,
                    dx,
                    dy,
                );
            }
            current = subpathStart;
            currentIndex = subpathStartIndex;
            continue;
        }

        const prev = current;
        vertices.push({ x: seg.x, y: seg.y, dirIn: null, dirOut: null });
        const nextIndex = vertices.length - 1;

        if (seg.cmd === 'L') {
            vertices[currentIndex].dirOut = setDir(
                vertices[currentIndex].dirOut,
                seg.x - prev.x,
                seg.y - prev.y,
            );
            vertices[nextIndex].dirIn = setDir(
                vertices[nextIndex].dirIn,
                seg.x - prev.x,
                seg.y - prev.y,
            );
        } else {
            // Cubic tangents: leaving the start point toward cp1 (or cp2/end if cp1 coincides with the start), arriving at the end from cp2 (or cp1/start if cp2 coincides with the end).
            const outCandidate: [number, number] =
                Math.hypot(seg.x1 - prev.x, seg.y1 - prev.y) > 1e-9
                    ? [seg.x1 - prev.x, seg.y1 - prev.y]
                    : [seg.x2 - prev.x, seg.y2 - prev.y];
            vertices[currentIndex].dirOut = setDir(
                vertices[currentIndex].dirOut,
                outCandidate[0],
                outCandidate[1],
            );
            const inCandidate: [number, number] =
                Math.hypot(seg.x - seg.x2, seg.y - seg.y2) > 1e-9
                    ? [seg.x - seg.x2, seg.y - seg.y2]
                    : [seg.x - seg.x1, seg.y - seg.y1];
            vertices[nextIndex].dirIn = setDir(
                vertices[nextIndex].dirIn,
                inCandidate[0],
                inCandidate[1],
            );
        }

        current = { x: seg.x, y: seg.y };
        currentIndex = nextIndex;
    }

    return vertices;
};

/*
 * Computes marker-start/-mid/-end placements for a path — vertex position
 * plus the tangent angle `orient="auto"` uses. Per spec: marker-start is
 * always the outgoing direction only (no incoming segment exists before the
 * very first point, even on a closed subpath); marker-end is always the
 * incoming direction only (the arriving segment); every other vertex is
 * marker-mid, oriented along the bisector of its incoming and outgoing
 * tangents (falling back to whichever one exists, or 0 if the vertex is
 * isolated).
 *
 * Scoping note: on a *closed* subpath (ends in `Z`), the spec treats the
 * closing edge's arrival as the true "last vertex" (coinciding with the
 * subpath's start point) for marker-end purposes. This implementation
 * instead places marker-end at the last *explicit* command's endpoint (the
 * vertex just before `Z`), using that segment's own incoming tangent — the
 * overwhelmingly common real-world case (arrowheads on open paths/lines/
 * curves) is unaffected; only closed-shape marker-end orientation differs
 * from a strict spec reading.
 */
export const computeMarkerVertices = (d: string): MarkerVertex[] => {
    const vertices = computePathVertices(d);
    if (vertices.length === 0) return [];

    return vertices.map((v, i): MarkerVertex => {
        const type: MarkerVertex['type'] =
            i === 0 ? 'start' : i === vertices.length - 1 ? 'end' : 'mid';
        let angle: number;
        if (type === 'start') {
            angle = v.dirOut ? Math.atan2(v.dirOut[1], v.dirOut[0]) : 0;
        } else if (type === 'end') {
            angle = v.dirIn ? Math.atan2(v.dirIn[1], v.dirIn[0]) : 0;
        } else if (v.dirIn && v.dirOut) {
            const bx = v.dirIn[0] + v.dirOut[0];
            const by = v.dirIn[1] + v.dirOut[1];
            angle =
                Math.hypot(bx, by) > 1e-9
                    ? Math.atan2(by, bx)
                    : Math.atan2(v.dirOut[1], v.dirOut[0]);
        } else {
            const only = v.dirIn ?? v.dirOut;
            angle = only ? Math.atan2(only[1], only[0]) : 0;
        }
        return { x: v.x, y: v.y, angle, type };
    });
};
