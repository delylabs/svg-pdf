import { type BBoxRect, computePathBBox } from './bbox';
import { parseFloats } from './matrix';

// --- Shape → path `d` conversion -----------------------------------------

/*
 * `basis` is the percentage reference for this one value (e.g. the current
 * viewport width when reading `x`/`width`, its height for `y`/`height`) —
 * per spec, a plain `%` string resolves against it. Left undefined at call
 * sites with no viewport in scope (e.g. the standalone `rectToPathData(el)`
 * calls in tests), in which case a `%` string just falls back to whatever
 * numeric prefix `parseFloat` finds, same as before this existed.
 */
export const num = (value: string | null, fallback = 0, basis?: number): number => {
    if (value === null || value === '') return fallback;
    const trimmed = value.trim();
    if (basis !== undefined && trimmed.endsWith('%')) {
        const pct = parseFloat(trimmed);
        return Number.isNaN(pct) ? fallback : (pct / 100) * basis;
    }
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
};

// Bézier approximation constant for a quarter circle, same technique svg2pdf.js uses.
const KAPPA = 0.5522847498;

/*
 * The current SVG viewport a shape's own `%`-valued geometry resolves
 * against — per spec, horizontal lengths (x/width/...) use its width,
 * vertical ones (y/height/...) use its height, and lengths that aren't
 * purely one or the other (a circle's `r`) use the viewport diagonal
 * divided by √2. Only the root `<svg>`'s viewBox is threaded in as this
 * today — a nested `<svg>`/`<symbol>` establishing its own smaller viewport
 * for its own children isn't tracked yet, so percentages inside one still
 * resolve against the root's, not their own local viewport.
 */
export interface ShapeViewport {
    readonly width: number;
    readonly height: number;
}

const diagonalBasis = (viewport: ShapeViewport): number =>
    Math.sqrt(viewport.width ** 2 + viewport.height ** 2) / Math.SQRT2;

export const rectToPathData = (el: Element, viewport?: ShapeViewport): string => {
    const x = num(el.getAttribute('x'), 0, viewport?.width);
    const y = num(el.getAttribute('y'), 0, viewport?.height);
    const width = num(el.getAttribute('width'), 0, viewport?.width);
    const height = num(el.getAttribute('height'), 0, viewport?.height);
    let rx = el.hasAttribute('rx') ? num(el.getAttribute('rx'), 0, viewport?.width) : null;
    let ry = el.hasAttribute('ry') ? num(el.getAttribute('ry'), 0, viewport?.height) : null;
    if (rx === null && ry === null) {
        return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    }
    rx = Math.min(rx ?? ry ?? 0, width / 2);
    ry = Math.min(ry ?? rx ?? 0, height / 2);
    const right = x + width;
    const bottom = y + height;
    return [
        `M ${x + rx} ${y}`,
        `H ${right - rx}`,
        `C ${right - rx + rx * KAPPA} ${y} ${right} ${y + ry - ry * KAPPA} ${right} ${y + ry}`,
        `V ${bottom - ry}`,
        `C ${right} ${bottom - ry + ry * KAPPA} ${right - rx + rx * KAPPA} ${bottom} ${right - rx} ${bottom}`,
        `H ${x + rx}`,
        `C ${x + rx - rx * KAPPA} ${bottom} ${x} ${bottom - ry + ry * KAPPA} ${x} ${bottom - ry}`,
        `V ${y + ry}`,
        `C ${x} ${y + ry - ry * KAPPA} ${x + rx - rx * KAPPA} ${y} ${x + rx} ${y}`,
        'Z',
    ].join(' ');
};

/*
 * Starts at the rightmost point (cx+rx, cy) and sweeps through the bottom,
 * left, then top before closing — matching the parametric convention
 * (x=cx+rx·cos(t), y=cy+ry·sin(t), t: 0→2π) browsers use internally when
 * converting <circle>/<ellipse> to a path. This matters beyond just the
 * `d` string being "equivalent": stroke-dasharray's phase is measured from
 * the path's start point, so a different start point visibly shifts where
 * the dash pattern's gaps land compared to the source SVG rendered in a browser.
 */
const ellipseToPathData = (cx: number, cy: number, rx: number, ry: number): string => {
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return [
        `M ${cx + rx} ${cy}`,
        `C ${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}`,
        `C ${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}`,
        `C ${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}`,
        `C ${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}`,
        'Z',
    ].join(' ');
};

export const circleToPathData = (el: Element, viewport?: ShapeViewport): string => {
    const cx = num(el.getAttribute('cx'), 0, viewport?.width);
    const cy = num(el.getAttribute('cy'), 0, viewport?.height);
    const r = num(el.getAttribute('r'), 0, viewport && diagonalBasis(viewport));
    return ellipseToPathData(cx, cy, r, r);
};

export const ellipseElToPathData = (el: Element, viewport?: ShapeViewport): string => {
    const cx = num(el.getAttribute('cx'), 0, viewport?.width);
    const cy = num(el.getAttribute('cy'), 0, viewport?.height);
    const rx = num(el.getAttribute('rx'), 0, viewport?.width);
    const ry = num(el.getAttribute('ry'), 0, viewport?.height);
    return ellipseToPathData(cx, cy, rx, ry);
};

export const lineToPathData = (el: Element, viewport?: ShapeViewport): string => {
    const x1 = num(el.getAttribute('x1'), 0, viewport?.width);
    const y1 = num(el.getAttribute('y1'), 0, viewport?.height);
    const x2 = num(el.getAttribute('x2'), 0, viewport?.width);
    const y2 = num(el.getAttribute('y2'), 0, viewport?.height);
    return `M ${x1} ${y1} L ${x2} ${y2}`;
};

const pointsToPathData = (pointsAttr: string | null, close: boolean): string => {
    const numbers = parseFloats(pointsAttr ?? '');
    if (numbers.length < 2) return '';
    const commands = [`M ${numbers[0]} ${numbers[1]}`];
    for (let i = 2; i + 1 < numbers.length; i += 2) {
        commands.push(`L ${numbers[i]} ${numbers[i + 1]}`);
    }
    if (close) commands.push('Z');
    return commands.join(' ');
};

export const polygonToPathData = (el: Element): string =>
    pointsToPathData(el.getAttribute('points'), true);

export const polylineToPathData = (el: Element): string =>
    pointsToPathData(el.getAttribute('points'), false);

export const shapeToPathData = (el: Element, viewport?: ShapeViewport): string | null => {
    switch (el.tagName.toLowerCase()) {
        case 'path':
            return el.getAttribute('d');
        case 'rect':
            return rectToPathData(el, viewport);
        case 'circle':
            return circleToPathData(el, viewport);
        case 'ellipse':
            return ellipseElToPathData(el, viewport);
        case 'line':
            return lineToPathData(el, viewport);
        case 'polygon':
            return polygonToPathData(el);
        case 'polyline':
            return polylineToPathData(el);
        default:
            return null;
    }
};

/*
 * A shape's own bounding box, in its local (pre-transform) coordinate space —
 * needed to position objectBoundingBox-units gradients/clipPaths (the SVG
 * default for both). Simple shapes read it straight from their attributes;
 * `<path>` needs `bbox.ts`'s approximate parse since `d` is opaque.
 */
export const computeShapeBBox = (el: Element, viewport?: ShapeViewport): BBoxRect | null => {
    switch (el.tagName.toLowerCase()) {
        case 'rect': {
            const x = num(el.getAttribute('x'), 0, viewport?.width);
            const y = num(el.getAttribute('y'), 0, viewport?.height);
            const width = num(el.getAttribute('width'), 0, viewport?.width);
            const height = num(el.getAttribute('height'), 0, viewport?.height);
            return { x, y, width, height };
        }
        case 'circle': {
            const cx = num(el.getAttribute('cx'), 0, viewport?.width);
            const cy = num(el.getAttribute('cy'), 0, viewport?.height);
            const r = num(el.getAttribute('r'), 0, viewport && diagonalBasis(viewport));
            return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
        }
        case 'ellipse': {
            const cx = num(el.getAttribute('cx'), 0, viewport?.width);
            const cy = num(el.getAttribute('cy'), 0, viewport?.height);
            const rx = num(el.getAttribute('rx'), 0, viewport?.width);
            const ry = num(el.getAttribute('ry'), 0, viewport?.height);
            return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
        }
        case 'line': {
            const x1 = num(el.getAttribute('x1'), 0, viewport?.width);
            const y1 = num(el.getAttribute('y1'), 0, viewport?.height);
            const x2 = num(el.getAttribute('x2'), 0, viewport?.width);
            const y2 = num(el.getAttribute('y2'), 0, viewport?.height);
            return {
                x: Math.min(x1, x2),
                y: Math.min(y1, y2),
                width: Math.abs(x2 - x1),
                height: Math.abs(y2 - y1),
            };
        }
        case 'polygon':
        case 'polyline': {
            const numbers = parseFloats(el.getAttribute('points') ?? '');
            if (numbers.length < 2) return null;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let i = 0; i + 1 < numbers.length; i += 2) {
                minX = Math.min(minX, numbers[i]);
                maxX = Math.max(maxX, numbers[i]);
                minY = Math.min(minY, numbers[i + 1]);
                maxY = Math.max(maxY, numbers[i + 1]);
            }
            return {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
            };
        }
        case 'path': {
            const d = el.getAttribute('d');
            return d ? computePathBBox(d) : null;
        }
        default:
            return null;
    }
};
