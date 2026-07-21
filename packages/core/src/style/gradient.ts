import { IDENTITY_MATRIX, type Matrix2D, parseTransformList } from '../geometry/matrix';
import { CSS_NAMED_COLORS, parseSvgColor, type RgbColor } from './color';
import { MAX_USE_DEPTH, resolveHref } from './refs';
import { type CssRule, readPresentation } from './stylesheet';

export type GradientUnits = 'objectBoundingBox' | 'userSpaceOnUse';

export interface GradientStop {
    readonly offset: number;
    readonly color: RgbColor;
    readonly opacity: number;
}

interface GradientDefBase {
    readonly stops: GradientStop[];
    readonly gradientUnits: GradientUnits;
    readonly gradientTransform: Matrix2D;
}

export interface LinearGradientDef extends GradientDefBase {
    readonly type: 'linear';
    // [x1, y1, x2, y2] in gradientUnits space.
    readonly coords: readonly [number, number, number, number];
}

export interface RadialGradientDef extends GradientDefBase {
    readonly type: 'radial';
    // [fx, fy, 0, cx, cy, r] — matches @libpdf/core's RadialShadingOptions.coords.
    readonly coords: readonly [number, number, number, number, number, number];
}

export type GradientDef = LinearGradientDef | RadialGradientDef;

/*
 * A bare number or a "50%" percentage — both resolve to the same 0-1 range for
 * objectBoundingBox gradients (the common case); for userSpaceOnUse, percentages
 * resolving against the actual viewport is out of scope (rare in real SVGs).
 */
const parseGradientCoord = (raw: string | null, fallback: number): number => {
    if (raw === null) return fallback;
    const trimmed = raw.trim();
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed)) return fallback;
    return trimmed.endsWith('%') ? parsed / 100 : parsed;
};

const readGradientStops = (
    el: Element,
    cssRules: readonly CssRule[] | undefined,
): GradientStop[] => {
    const stops: GradientStop[] = [];
    for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== 'stop') continue;
        const offset = Math.min(
            1,
            Math.max(0, parseGradientCoord(child.getAttribute('offset'), 0)),
        );
        const color =
            parseSvgColor(readPresentation(child, 'stop-color', cssRules)) ??
            CSS_NAMED_COLORS.black;
        const opacityRaw = readPresentation(child, 'stop-opacity', cssRules);
        const opacity =
            opacityRaw === null ? 1 : Math.min(1, Math.max(0, parseFloat(opacityRaw) || 0));
        stops.push({ offset, color, opacity });
    }
    return stops;
};

/*
 * Resolves a <linearGradient>/<radialGradient> element into a fully-merged
 * definition, chasing a single `href="#other"` inheritance link (a common
 * Illustrator pattern: one gradient defines shared stops, others reuse them
 * with different coords/transform) — same cycle-guard pattern as <use>.
 */
export const resolveGradientDef = (
    el: Element,
    idMap: ReadonlyMap<string, Element>,
    cssRules?: readonly CssRule[],
    visited: ReadonlySet<string> = new Set(),
): GradientDef | null => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;

    const id = el.getAttribute('id');
    const hrefId = resolveHref(el);
    let base: GradientDef | null = null;
    if (hrefId && !visited.has(hrefId) && visited.size < MAX_USE_DEPTH) {
        const baseEl = idMap.get(hrefId);
        if (baseEl) {
            base = resolveGradientDef(
                baseEl,
                idMap,
                cssRules,
                new Set(visited).add(id ?? hrefId),
            );
        }
    }

    const gradientUnits: GradientUnits =
        el.getAttribute('gradientUnits')?.toLowerCase() === 'userspaceonuse'
            ? 'userSpaceOnUse'
            : el.hasAttribute('gradientUnits')
              ? 'objectBoundingBox'
              : (base?.gradientUnits ?? 'objectBoundingBox');

    const gradientTransform = el.hasAttribute('gradientTransform')
        ? parseTransformList(el.getAttribute('gradientTransform'))
        : (base?.gradientTransform ?? IDENTITY_MATRIX);

    const ownStops = readGradientStops(el, cssRules);
    const stops = ownStops.length > 0 ? ownStops : (base?.stops ?? []);

    if (tag === 'lineargradient') {
        const baseCoords = base?.type === 'linear' ? base.coords : null;
        const coords: [number, number, number, number] = [
            parseGradientCoord(el.getAttribute('x1'), baseCoords?.[0] ?? 0),
            parseGradientCoord(el.getAttribute('y1'), baseCoords?.[1] ?? 0),
            parseGradientCoord(el.getAttribute('x2'), baseCoords?.[2] ?? 1),
            parseGradientCoord(el.getAttribute('y2'), baseCoords?.[3] ?? 0),
        ];
        return {
            type: 'linear',
            coords,
            stops,
            gradientUnits,
            gradientTransform,
        };
    }

    const baseCoords = base?.type === 'radial' ? base.coords : null;
    const cx = parseGradientCoord(el.getAttribute('cx'), baseCoords?.[3] ?? 0.5);
    const cy = parseGradientCoord(el.getAttribute('cy'), baseCoords?.[4] ?? 0.5);
    const r = parseGradientCoord(el.getAttribute('r'), baseCoords?.[5] ?? 0.5);
    const fx = el.hasAttribute('fx')
        ? parseGradientCoord(el.getAttribute('fx'), cx)
        : (baseCoords?.[0] ?? cx);
    const fy = el.hasAttribute('fy')
        ? parseGradientCoord(el.getAttribute('fy'), cy)
        : (baseCoords?.[1] ?? cy);
    const coords: [number, number, number, number, number, number] = [fx, fy, 0, cx, cy, r];
    return { type: 'radial', coords, stops, gradientUnits, gradientTransform };
};
