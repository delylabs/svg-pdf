/**
 * Computes an approximate bounding box for an SVG path `d` string, in the
 * path's own local (pre-transform) coordinate space.
 *
 * `geometry/path.ts` needs this for `objectBoundingBox` gradients/clipPaths (the
 * default gradient units): the pattern matrix that positions a gradient has
 * to map into the shape's bounding box, and for `<rect>`/`<circle>`/etc. that
 * box comes straight from their attributes, but `<path>` only has an opaque
 * `d` string, so it has to actually be parsed.
 *
 * The arc-to-cubic conversion below is ported from fontello/svgpath (MIT
 * License, Copyright Vitaly Puzrin) — see THIRD_PARTY_NOTICES.md. The
 * tokenizer above it, however, is this project's own. Only the pieces
 * needed to normalize a path into absolute M/L/C segments were kept (no
 * relative/absolute round-trip, no matrix-transform-a-path support):
 * `@libpdf/core`'s own `appendSvgPath` already does real parsing+rendering,
 * this is only ever used to get an approximate extent for positioning, so
 * including curve control points in the box (rather than the tight curve
 * extent) is an intentional, cheap over-estimate.
 */

type RawSegment = [string, ...number[]];

const PARAM_COUNTS: Record<string, number> = {
    a: 7,
    c: 6,
    h: 1,
    l: 2,
    m: 2,
    q: 4,
    s: 4,
    t: 2,
    v: 1,
    z: 0,
};

const NUMBER_TOKEN_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

// Splits a `d` string into raw [command, ...args] segments (relative commands kept lowercase, shorthand kept as-is).
const parsePathSegments = (d: string): RawSegment[] => {
    const segments: RawSegment[] = [];
    const commandRe = /[MmLlHhVvCcSsQqTtAaZz]/g;
    let match: RegExpExecArray | null;
    const commandPositions: { cmd: string; index: number }[] = [];
    while ((match = commandRe.exec(d))) {
        commandPositions.push({ cmd: match[0], index: match.index });
    }

    for (let i = 0; i < commandPositions.length; i++) {
        const { cmd, index } = commandPositions[i];
        const end = i + 1 < commandPositions.length ? commandPositions[i + 1].index : d.length;
        const argsText = d.slice(index + 1, end);
        const isArc = cmd.toLowerCase() === 'a';
        const rawNumbers = (argsText.match(NUMBER_TOKEN_RE) ?? []).map(Number);
        const needed = PARAM_COUNTS[cmd.toLowerCase()];

        if (!needed) {
            segments.push([cmd]);
            continue;
        }

        /*
         * Arc flags (large-arc/sweep) are single digits, sometimes glued to the next number
         * with no separator (e.g. "1000"). The generic number regex can't tell those apart
         * reliably, so arcs are re-tokenized from the raw text instead.
         */
        const numbers = isArc ? parseArcArgs(argsText, PARAM_COUNTS.a) : rawNumbers;

        // Per spec, extra coordinate pairs after the first M/m are implicit linetos (L/l), not more moveTos.
        const isMove = cmd.toLowerCase() === 'm';
        const lineCmd = cmd === 'm' ? 'l' : 'L';
        let chunkIndex = 0;
        for (let offset = 0; offset + needed <= numbers.length; offset += needed) {
            const segCmd = isMove && chunkIndex > 0 ? lineCmd : cmd;
            segments.push([segCmd, ...numbers.slice(offset, offset + needed)]);
            chunkIndex++;
            if (needed === 0) break;
        }
    }

    return segments;
};

const ARC_TOKEN_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const FLAG_RE = /[01]/y;

// Arc args are [rx, ry, x-axis-rotation, large-arc-flag, sweep-flag, x, y] — the two flags are single digits.
const parseArcArgs = (text: string, needed: number): number[] => {
    const results: number[] = [];
    let i = 0;
    const skipSep = () => {
        while (i < text.length && /[\s,]/.test(text[i])) i++;
    };
    while (i < text.length) {
        const groupStart = results.length % needed;
        for (let k = 0; k < needed && i < text.length; k++) {
            skipSep();
            const isFlag = (groupStart + k) % needed === 3 || (groupStart + k) % needed === 4;
            const re = isFlag ? FLAG_RE : ARC_TOKEN_RE;
            re.lastIndex = i;
            const m = re.exec(text);
            if (!m) return results;
            results.push(Number(m[0]));
            i = re.lastIndex;
        }
        skipSep();
    }
    return results;
};

// --- Arc-to-cubic-bezier conversion (ported from svgpath's a2c.js) ------

const TAU = Math.PI * 2;

const unitVectorAngle = (ux: number, uy: number, vx: number, vy: number): number => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    let dot = ux * vx + uy * vy;
    if (dot > 1) dot = 1;
    if (dot < -1) dot = -1;
    return sign * Math.acos(dot);
};

const getArcCenter = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fa: number,
    fs: number,
    rx: number,
    ry: number,
    sinPhi: number,
    cosPhi: number,
): [number, number, number, number] => {
    const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
    const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

    const rxSq = rx * rx;
    const rySq = ry * ry;
    const x1pSq = x1p * x1p;
    const y1pSq = y1p * y1p;

    let radicant = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
    if (radicant < 0) radicant = 0;
    radicant /= rxSq * y1pSq + rySq * x1pSq;
    radicant = Math.sqrt(radicant) * (fa === fs ? -1 : 1);

    const cxp = radicant * (rx / ry) * y1p;
    const cyp = radicant * (-ry / rx) * x1p;

    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const v1x = (x1p - cxp) / rx;
    const v1y = (y1p - cyp) / ry;
    const v2x = (-x1p - cxp) / rx;
    const v2y = (-y1p - cyp) / ry;

    const theta1 = unitVectorAngle(1, 0, v1x, v1y);
    let deltaTheta = unitVectorAngle(v1x, v1y, v2x, v2y);

    if (fs === 0 && deltaTheta > 0) deltaTheta -= TAU;
    if (fs === 1 && deltaTheta < 0) deltaTheta += TAU;

    return [cx, cy, theta1, deltaTheta];
};

const approximateUnitArc = (
    theta1: number,
    deltaTheta: number,
): [number, number, number, number, number, number, number, number] => {
    const alpha = (4 / 3) * Math.tan(deltaTheta / 4);
    const x1 = Math.cos(theta1);
    const y1 = Math.sin(theta1);
    const x2 = Math.cos(theta1 + deltaTheta);
    const y2 = Math.sin(theta1 + deltaTheta);
    return [x1, y1, x1 - y1 * alpha, y1 + x1 * alpha, x2 + y2 * alpha, y2 - x2 * alpha, x2, y2];
};

// Converts one SVG arc segment (endpoint parameterization) into a list of cubic bezier curves [cp1x, cp1y, cp2x, cp2y, x, y].
const arcToCubicCurves = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fa: number,
    fs: number,
    rxIn: number,
    ryIn: number,
    phiDeg: number,
): number[][] => {
    const sinPhi = Math.sin((phiDeg * TAU) / 360);
    const cosPhi = Math.cos((phiDeg * TAU) / 360);

    const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
    const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

    if ((x1p === 0 && y1p === 0) || rxIn === 0 || ryIn === 0) return [];

    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }

    const [cx, cy, theta1, deltaThetaTotal] = getArcCenter(
        x1,
        y1,
        x2,
        y2,
        fa,
        fs,
        rx,
        ry,
        sinPhi,
        cosPhi,
    );

    const segmentCount = Math.max(Math.ceil(Math.abs(deltaThetaTotal) / (TAU / 4)), 1);
    const deltaTheta = deltaThetaTotal / segmentCount;

    const curves: number[][] = [];
    let theta = theta1;
    for (let i = 0; i < segmentCount; i++) {
        const unit = approximateUnitArc(theta, deltaTheta);
        const curve: number[] = [];
        for (let p = 0; p < unit.length; p += 2) {
            const x = unit[p] * rx;
            const y = unit[p + 1] * ry;
            curve.push(cosPhi * x - sinPhi * y + cx, sinPhi * x + cosPhi * y + cy);
        }
        curves.push(curve);
        theta += deltaTheta;
    }
    return curves;
};

// --- Normalized (absolute M/L/C/Z) path segments -------------------------

/*
 * A path `d` string reduced to only absolute moveto/lineto/curveto/closepath
 * segments — H/V/S/T expanded, arcs converted to cubic beziers, all relative
 * commands resolved to absolute coordinates. Used both for this module's own
 * bbox estimation and (via `@svg-pdf/libpdf`'s pattern-cell operator
 * builder) to turn arbitrary path data into raw PDF path-construction
 * operators without a second, independent path parser.
 */
export type NormalizedPathSegment =
    | { readonly cmd: 'M'; readonly x: number; readonly y: number }
    | { readonly cmd: 'L'; readonly x: number; readonly y: number }
    | {
          readonly cmd: 'C';
          readonly x1: number;
          readonly y1: number;
          readonly x2: number;
          readonly y2: number;
          readonly x: number;
          readonly y: number;
      }
    | { readonly cmd: 'Z' };

/**
 * Parses an SVG path `d` string into a flat list of absolute M/L/C/Z
 * segments (see `NormalizedPathSegment`). Returns an empty array for an
 * empty/unparseable path.
 */
export const normalizePathData = (d: string): NormalizedPathSegment[] => {
    const segments = parsePathSegments(d);
    const out: NormalizedPathSegment[] = [];

    let x = 0;
    let y = 0;
    let subpathStartX = 0;
    let subpathStartY = 0;
    // S/T shorthand curves mirror the previous curve's control point around the current point.
    let prevCubicControl: [number, number] | null = null;
    let prevQuadControl: [number, number] | null = null;

    for (const seg of segments) {
        const [rawCmd, ...args] = seg;
        const cmd = rawCmd;
        const isRelative = cmd === cmd.toLowerCase();
        const cmdUC = cmd.toUpperCase();
        const rel = (v: number, axis: 'x' | 'y') => (isRelative ? v + (axis === 'x' ? x : y) : v);

        if (cmdUC !== 'S') prevCubicControl = null;
        if (cmdUC !== 'T') prevQuadControl = null;

        switch (cmdUC) {
            case 'M': {
                x = rel(args[0], 'x');
                y = rel(args[1], 'y');
                subpathStartX = x;
                subpathStartY = y;
                out.push({ cmd: 'M', x, y });
                break;
            }
            case 'L': {
                x = rel(args[0], 'x');
                y = rel(args[1], 'y');
                out.push({ cmd: 'L', x, y });
                break;
            }
            case 'H': {
                x = rel(args[0], 'x');
                out.push({ cmd: 'L', x, y });
                break;
            }
            case 'V': {
                y = rel(args[0], 'y');
                out.push({ cmd: 'L', x, y });
                break;
            }
            case 'C': {
                const cp1x = rel(args[0], 'x');
                const cp1y = rel(args[1], 'y');
                const cp2x = rel(args[2], 'x');
                const cp2y = rel(args[3], 'y');
                const ex = rel(args[4], 'x');
                const ey = rel(args[5], 'y');
                out.push({ cmd: 'C', x1: cp1x, y1: cp1y, x2: cp2x, y2: cp2y, x: ex, y: ey });
                prevCubicControl = [cp2x, cp2y];
                x = ex;
                y = ey;
                break;
            }
            case 'S': {
                const cp1 = prevCubicControl
                    ? [2 * x - prevCubicControl[0], 2 * y - prevCubicControl[1]]
                    : [x, y];
                const cp2x = rel(args[0], 'x');
                const cp2y = rel(args[1], 'y');
                const ex = rel(args[2], 'x');
                const ey = rel(args[3], 'y');
                out.push({ cmd: 'C', x1: cp1[0], y1: cp1[1], x2: cp2x, y2: cp2y, x: ex, y: ey });
                prevCubicControl = [cp2x, cp2y];
                x = ex;
                y = ey;
                break;
            }
            case 'Q': {
                const cpx = rel(args[0], 'x');
                const cpy = rel(args[1], 'y');
                const ex = rel(args[2], 'x');
                const ey = rel(args[3], 'y');
                // Quadratic-to-cubic: cp1 = P0 + 2/3(QCP-P0), cp2 = P1 + 2/3(QCP-P1).
                out.push({
                    cmd: 'C',
                    x1: x + (2 / 3) * (cpx - x),
                    y1: y + (2 / 3) * (cpy - y),
                    x2: ex + (2 / 3) * (cpx - ex),
                    y2: ey + (2 / 3) * (cpy - ey),
                    x: ex,
                    y: ey,
                });
                prevQuadControl = [cpx, cpy];
                x = ex;
                y = ey;
                break;
            }
            case 'T': {
                const cp: [number, number] = prevQuadControl
                    ? [2 * x - prevQuadControl[0], 2 * y - prevQuadControl[1]]
                    : [x, y];
                const ex = rel(args[0], 'x');
                const ey = rel(args[1], 'y');
                out.push({
                    cmd: 'C',
                    x1: x + (2 / 3) * (cp[0] - x),
                    y1: y + (2 / 3) * (cp[1] - y),
                    x2: ex + (2 / 3) * (cp[0] - ex),
                    y2: ey + (2 / 3) * (cp[1] - ey),
                    x: ex,
                    y: ey,
                });
                prevQuadControl = cp;
                x = ex;
                y = ey;
                break;
            }
            case 'A': {
                const rx = args[0];
                const ry = args[1];
                const rotation = args[2];
                const largeArc = args[3];
                const sweep = args[4];
                const ex = rel(args[5], 'x');
                const ey = rel(args[6], 'y');
                const curves = arcToCubicCurves(x, y, ex, ey, largeArc, sweep, rx, ry, rotation);
                // Each curve is [startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY] — the start point is redundant (already the running x/y) so only indices 2-7 feed the cubic segment.
                for (const curve of curves) {
                    out.push({
                        cmd: 'C',
                        x1: curve[2],
                        y1: curve[3],
                        x2: curve[4],
                        y2: curve[5],
                        x: curve[6],
                        y: curve[7],
                    });
                }
                if (curves.length === 0) out.push({ cmd: 'L', x: ex, y: ey });
                x = ex;
                y = ey;
                break;
            }
            case 'Z': {
                x = subpathStartX;
                y = subpathStartY;
                out.push({ cmd: 'Z' });
                break;
            }
        }
    }

    return out;
};

// --- Bounding box from normalized (absolute M/L/C) points ---------------

interface BBoxAccumulator {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    any: boolean;
}

const include = (acc: BBoxAccumulator, x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    acc.any = true;
    if (x < acc.minX) acc.minX = x;
    if (y < acc.minY) acc.minY = y;
    if (x > acc.maxX) acc.maxX = x;
    if (y > acc.maxY) acc.maxY = y;
};

export interface BBoxRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Parses an SVG path `d` string and returns an approximate bounding box
 * (includes bezier control points and arc-approximation curve points rather
 * than the exact tight curve extent — a deliberate, cheap over-estimate).
 * Returns `null` for an empty/unparseable path.
 */
export const computePathBBox = (d: string): BBoxRect | null => {
    const segments = normalizePathData(d);
    if (segments.length === 0) return null;

    const acc: BBoxAccumulator = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        any: false,
    };

    for (const seg of segments) {
        switch (seg.cmd) {
            case 'M':
            case 'L':
                include(acc, seg.x, seg.y);
                break;
            case 'C':
                include(acc, seg.x1, seg.y1);
                include(acc, seg.x2, seg.y2);
                include(acc, seg.x, seg.y);
                break;
            case 'Z':
                break;
        }
    }

    if (!acc.any) return null;
    return {
        x: acc.minX,
        y: acc.minY,
        width: acc.maxX - acc.minX,
        height: acc.maxY - acc.minY,
    };
};
