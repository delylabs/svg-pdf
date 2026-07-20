import { type BBoxRect, computePathBBox } from './bbox';
import { parseFloats } from './matrix';

// --- Shape → path `d` conversion -----------------------------------------

export const num = (value: string | null, fallback = 0): number => {
    if (value === null || value === '') return fallback;
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
};

// Bézier approximation constant for a quarter circle, same technique svg2pdf.js uses.
const KAPPA = 0.5522847498;

export const rectToPathData = (el: Element): string => {
    const x = num(el.getAttribute('x'));
    const y = num(el.getAttribute('y'));
    const width = num(el.getAttribute('width'));
    const height = num(el.getAttribute('height'));
    let rx = el.hasAttribute('rx') ? num(el.getAttribute('rx')) : null;
    let ry = el.hasAttribute('ry') ? num(el.getAttribute('ry')) : null;
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

export const circleToPathData = (el: Element): string => {
    const cx = num(el.getAttribute('cx'));
    const cy = num(el.getAttribute('cy'));
    const r = num(el.getAttribute('r'));
    return ellipseToPathData(cx, cy, r, r);
};

export const ellipseElToPathData = (el: Element): string => {
    const cx = num(el.getAttribute('cx'));
    const cy = num(el.getAttribute('cy'));
    const rx = num(el.getAttribute('rx'));
    const ry = num(el.getAttribute('ry'));
    return ellipseToPathData(cx, cy, rx, ry);
};

export const lineToPathData = (el: Element): string => {
    const x1 = num(el.getAttribute('x1'));
    const y1 = num(el.getAttribute('y1'));
    const x2 = num(el.getAttribute('x2'));
    const y2 = num(el.getAttribute('y2'));
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

export const shapeToPathData = (el: Element): string | null => {
    switch (el.tagName.toLowerCase()) {
        case 'path':
            return el.getAttribute('d');
        case 'rect':
            return rectToPathData(el);
        case 'circle':
            return circleToPathData(el);
        case 'ellipse':
            return ellipseElToPathData(el);
        case 'line':
            return lineToPathData(el);
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
export const computeShapeBBox = (el: Element): BBoxRect | null => {
    switch (el.tagName.toLowerCase()) {
        case 'rect': {
            const x = num(el.getAttribute('x'));
            const y = num(el.getAttribute('y'));
            const width = num(el.getAttribute('width'));
            const height = num(el.getAttribute('height'));
            return { x, y, width, height };
        }
        case 'circle': {
            const cx = num(el.getAttribute('cx'));
            const cy = num(el.getAttribute('cy'));
            const r = num(el.getAttribute('r'));
            return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
        }
        case 'ellipse': {
            const cx = num(el.getAttribute('cx'));
            const cy = num(el.getAttribute('cy'));
            const rx = num(el.getAttribute('rx'));
            const ry = num(el.getAttribute('ry'));
            return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
        }
        case 'line': {
            const x1 = num(el.getAttribute('x1'));
            const y1 = num(el.getAttribute('y1'));
            const x2 = num(el.getAttribute('x2'));
            const y2 = num(el.getAttribute('y2'));
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
