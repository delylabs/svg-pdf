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
 *
 * `endIndex` is the true "last vertex of the whole path" per spec — for a
 * path ending in `Z`, that's the closing subpath's *start* vertex (where the
 * closing edge lands), not the last vertex pushed onto the array. It falls
 * out naturally: `currentIndex` already points there after `Z` is processed
 * below, so no separate bookkeeping is needed for the common (open-path)
 * case where it's simply the last pushed vertex.
 */
const computePathVertices = (d: string): { vertices: RawVertex[]; endIndex: number } => {
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

    return { vertices, endIndex: currentIndex };
};

/*
 * Outgoing-only for marker-start; bisector-of-incoming-and-outgoing (falling back to whichever exists) for marker-mid
 * and marker-end alike — an 'end' vertex only has both directions when it's a closed subpath's start/end point, a plain
 * open path's true last vertex has no outgoing direction, so this reduces to "incoming only" for it, same as before.
 */
const angleFor = (v: RawVertex, type: MarkerVertex['type']): number => {
    if (type === 'start') return v.dirOut ? Math.atan2(v.dirOut[1], v.dirOut[0]) : 0;
    if (v.dirIn && v.dirOut) {
        const bx = v.dirIn[0] + v.dirOut[0];
        const by = v.dirIn[1] + v.dirOut[1];
        return Math.hypot(bx, by) > 1e-9
            ? Math.atan2(by, bx)
            : Math.atan2(v.dirOut[1], v.dirOut[0]);
    }
    const only = v.dirIn ?? v.dirOut;
    return only ? Math.atan2(only[1], only[0]) : 0;
};

/*
 * Computes marker-start/-mid/-end placements for a path — vertex position
 * plus the tangent angle `orient="auto"` uses. Every other vertex is
 * marker-mid; marker-start and marker-end go at the overall first/last
 * vertex respectively — see `computePathVertices`'s `endIndex` for how
 * "last" is found on a closed subpath.
 *
 * A single-subpath path that closes with `Z` (the common case — a plain
 * polygon/rect `d`) has its marker-end coincide *positionally* with
 * marker-start (`endIndex === 0`): both belong at that shared point, just
 * with different orientations (start uses only the outgoing edge, end
 * bisects the closing edge with the first edge). Since each array slot can
 * only carry one `type`, that slot is emitted as `'start'` by the main pass
 * below, and a second `'end'` entry at the same position is appended afterwards.
 */
export const computeMarkerVertices = (d: string): MarkerVertex[] => {
    const { vertices, endIndex } = computePathVertices(d);
    if (vertices.length === 0) return [];

    const result = vertices.map((v, i): MarkerVertex => {
        const type: MarkerVertex['type'] = i === 0 ? 'start' : i === endIndex ? 'end' : 'mid';
        return { x: v.x, y: v.y, angle: angleFor(v, type), type };
    });

    if (endIndex === 0 && vertices[0].dirIn) {
        result.push({
            x: vertices[0].x,
            y: vertices[0].y,
            angle: angleFor(vertices[0], 'end'),
            type: 'end',
        });
    }

    return result;
};
