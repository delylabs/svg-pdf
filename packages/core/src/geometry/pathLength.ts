import { normalizePathData } from './bbox';

export interface PathPoint {
    readonly x: number;
    readonly y: number;
}

// Fixed subdivision count per cubic curve — adaptive subdivision (finer on sharper curves) would track length more precisely, but a flat 16 segments is already far smoother than <textPath> glyph spacing can visually distinguish, for the added complexity it'd cost.
const CURVE_SEGMENTS = 16;

const sampleCubic = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
): PathPoint[] => {
    const points: PathPoint[] = [];
    for (let i = 1; i <= CURVE_SEGMENTS; i++) {
        const t = i / CURVE_SEGMENTS;
        const mt = 1 - t;
        const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
        const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
        points.push({ x, y });
    }
    return points;
};

/*
 * Flattens an SVG path `d` string into a polyline approximation — every
 * M/L point kept exactly, every C subdivided into `CURVE_SEGMENTS` line
 * segments (arcs are already converted to cubics by `normalizePathData`,
 * so no separate arc handling is needed here). Multiple subpaths (more
 * than one `M`) are concatenated into one continuous polyline rather than
 * kept separate — an acceptable trim for `<textPath>`'s use case, where
 * the referenced path is overwhelmingly a single open path.
 */
export const flattenPathToPolyline = (d: string): PathPoint[] => {
    const segments = normalizePathData(d);
    const points: PathPoint[] = [];
    let x = 0;
    let y = 0;
    let subpathStartX = 0;
    let subpathStartY = 0;
    for (const seg of segments) {
        switch (seg.cmd) {
            case 'M':
                points.push({ x: seg.x, y: seg.y });
                x = subpathStartX = seg.x;
                y = subpathStartY = seg.y;
                break;
            case 'L':
                points.push({ x: seg.x, y: seg.y });
                x = seg.x;
                y = seg.y;
                break;
            case 'C':
                points.push(...sampleCubic(x, y, seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y));
                x = seg.x;
                y = seg.y;
                break;
            case 'Z':
                points.push({ x: subpathStartX, y: subpathStartY });
                x = subpathStartX;
                y = subpathStartY;
                break;
        }
    }
    return points;
};

// Cumulative Euclidean distance up to and including each point (`cumLengths[0]` is always 0); same length as `points`.
export const computeCumulativeLengths = (points: readonly PathPoint[]): number[] => {
    const cumLengths: number[] = [0];
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        cumLengths.push(cumLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return cumLengths;
};

export interface PointOnPath extends PathPoint {
    // Tangent direction in radians, `atan2(dy, dx)` — the path's own (Y-down) local space, same convention as everything else in `geometry/`.
    readonly angle: number;
}

/*
 * Finds the point (and tangent direction) at `distance` along a polyline
 * already reduced via `flattenPathToPolyline`/`computeCumulativeLengths`.
 * Returns `null` for a distance outside `[0, totalLength]` — the caller
 * (embed.ts) decides whether that means "stop drawing" (a character
 * that would fall past the end of the path).
 */
export const pointAtLength = (
    points: readonly PathPoint[],
    cumLengths: readonly number[],
    distance: number,
): PointOnPath | null => {
    if (points.length < 2 || distance < 0 || distance > cumLengths[cumLengths.length - 1]) {
        return null;
    }
    // Linear scan (textPath polylines are small — a handful to a few hundred points) rather than a binary search, for simplicity.
    let i = 1;
    while (i < cumLengths.length - 1 && cumLengths[i] < distance) i++;
    const segStart = cumLengths[i - 1];
    const segEnd = cumLengths[i];
    const segLength = segEnd - segStart;
    const t = segLength > 0 ? (distance - segStart) / segLength : 0;
    const p0 = points[i - 1];
    const p1 = points[i];
    return {
        x: p0.x + (p1.x - p0.x) * t,
        y: p0.y + (p1.y - p0.y) * t,
        angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    };
};
