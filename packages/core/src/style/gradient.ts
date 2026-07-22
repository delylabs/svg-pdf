import { IDENTITY_MATRIX, type Matrix2D, parseTransformList } from '../geometry/matrix';
import { CSS_NAMED_COLORS, parseSvgColor, resolveCurrentColor, type RgbColor } from './color';
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

/*
 * `stop-color` isn't an inherited CSS property (its initial value is black,
 * per spec) — but an explicit `inherit` keyword always forces the parent
 * element's own computed value regardless, and `<stop>`'s parent is the
 * `<linearGradient>`/`<radialGradient>` itself. Rare in practice (real
 * export tooling doesn't emit it), but cheap to walk: climb past any chain
 * of ancestors that also say "inherit", stopping at the first one that sets
 * `stop-color` to something else, or falling back to the property's own
 * initial value (black) if none do.
 */
const resolveInheritedStopColor = (
    el: Element,
    cssRules: readonly CssRule[] | undefined,
): RgbColor => {
    let node: Node | null = el.parentNode;
    while (node && node.nodeType === 1) {
        const raw = readPresentation(node as Element, 'stop-color', cssRules);
        if (raw === null) return CSS_NAMED_COLORS.black;
        const trimmed = raw.trim();
        if (trimmed === 'inherit') {
            node = (node as Element).parentNode;
            continue;
        }
        if (trimmed === 'currentColor') return resolveCurrentColor(node as Element, cssRules);
        return parseSvgColor(raw) ?? CSS_NAMED_COLORS.black;
    }
    return CSS_NAMED_COLORS.black;
};

const resolveStopColor = (stopEl: Element, cssRules: readonly CssRule[] | undefined): RgbColor => {
    const raw = readPresentation(stopEl, 'stop-color', cssRules);
    if (raw === null) return CSS_NAMED_COLORS.black;
    const trimmed = raw.trim();
    if (trimmed === 'inherit') return resolveInheritedStopColor(stopEl, cssRules);
    if (trimmed === 'currentColor') return resolveCurrentColor(stopEl, cssRules);
    return parseSvgColor(raw) ?? CSS_NAMED_COLORS.black;
};

const readGradientStops = (
    el: Element,
    cssRules: readonly CssRule[] | undefined,
): GradientStop[] => {
    const stops: GradientStop[] = [];
    // Per spec, each stop's offset is clamped up to at least the previous (already-clamped) stop's offset, not just to [0,1] independently — otherwise an out-of-order offset list (rare, but seen from buggy exporters) produces a PDF shading function with a non-monotonic domain.
    let previousOffset = 0;
    for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== 'stop') continue;
        const rawOffset = Math.min(
            1,
            Math.max(0, parseGradientCoord(child.getAttribute('offset'), 0)),
        );
        const offset = Math.max(rawOffset, previousOffset);
        previousOffset = offset;
        const color = resolveStopColor(child, cssRules);
        const opacityRaw = readPresentation(child, 'stop-opacity', cssRules);
        const opacity =
            opacityRaw === null ? 1 : Math.min(1, Math.max(0, parseFloat(opacityRaw) || 0));
        stops.push({ offset, color, opacity });
    }
    return stops;
};

// `spreadMethod="reflect"/"repeat"` (spec default: "pad") has no equivalent in @libpdf/core's tiling-pattern-free shading API, which always pads — checked against only the element's own attribute (not chased through href inheritance like gradientUnits/gradientTransform above), matching this module's existing "best effort" scope.
const warnUnsupportedSpreadMethod = (el: Element, warnings: string[] | undefined): void => {
    const spreadMethod = el.getAttribute('spreadMethod')?.trim().toLowerCase();
    if (spreadMethod === 'reflect' || spreadMethod === 'repeat') {
        warnings?.push(
            `spreadMethod="${spreadMethod}" is not supported and was drawn as "pad" (the default) instead`,
        );
    }
};

/*
 * `stop-opacity` isn't currently honored — a PDF shading function's stops
 * carry only RGB, no per-stop alpha; reproducing varying transparency along
 * a gradient needs a luminosity soft mask, which `@libpdf/core` doesn't
 * expose an API for yet (same root cause as the `<mask>` gap documented in
 * supported-features.md). Checked once per element's own stop list (not the
 * merged `stops` a derived-via-href gradient ends up with), so an inherited
 * base gradient's non-opaque stops only warn once, at the element that
 * actually owns them.
 */
const warnUnsupportedStopOpacity = (
    stops: readonly GradientStop[],
    warnings: string[] | undefined,
): void => {
    if (stops.some((stop) => stop.opacity !== 1)) {
        warnings?.push('stop-opacity is not supported and stops were drawn fully opaque instead');
    }
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
    warnings?: string[],
    visited: ReadonlySet<string> = new Set(),
): GradientDef | null => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;

    warnUnsupportedSpreadMethod(el, warnings);

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
                warnings,
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
    warnUnsupportedStopOpacity(ownStops, warnings);
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
