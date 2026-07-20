import { MAX_USE_DEPTH, resolveHref } from './refs';
import { readPresentation } from './stylesheet';

export type MarkerUnits = 'strokeWidth' | 'userSpaceOnUse';
export type MarkerOrient = number | 'auto' | 'auto-start-reverse';

export interface MarkerViewBox {
    readonly minX: number;
    readonly minY: number;
    readonly width: number;
    readonly height: number;
}

/*
 * Everything about a <marker> except its drawable content — same split as
 * `PatternAttrs`/`PatternDef` in `style/pattern.ts` and `parse/pattern.ts`, and
 * for the same reason (this module never needs the tree walker just for a
 * type).
 */
export interface MarkerAttrs {
    readonly refX: number;
    readonly refY: number;
    readonly markerWidth: number;
    readonly markerHeight: number;
    readonly markerUnits: MarkerUnits;
    readonly orient: MarkerOrient;
    readonly viewBox: MarkerViewBox | null;
    /*
     * Per spec, a <marker>'s content defaults to clipped ("hidden") to its
     * markerWidth/markerHeight viewport — `overflow="visible"` opts out of
     * that clip, a common technique for a custom arrowhead whose path
     * coordinates deliberately extend past a small nominal viewport (see
     * `buildMarkerFormXObject`, which has to size the PDF Form XObject's
     * /BBox around the actual content instead when this is true, since a PDF
     * Form XObject's /BBox is always a hard clip — there's no PDF equivalent
     * of "don't clip" to fall back on).
     */
    readonly overflowVisible: boolean;
}

const num = (raw: string | null, fallback: number): number => {
    if (raw === null) return fallback;
    const parsed = parseFloat(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const parseOrient = (raw: string | null, fallback: MarkerOrient): MarkerOrient => {
    if (raw === null) return fallback;
    const trimmed = raw.trim();
    if (trimmed === 'auto') return 'auto';
    if (trimmed === 'auto-start-reverse') return 'auto-start-reverse';
    const parsed = parseFloat(trimmed);
    return Number.isNaN(parsed) ? fallback : (parsed * Math.PI) / 180;
};

const parseViewBox = (raw: string | null): MarkerViewBox | null => {
    if (!raw) return null;
    const numbers = raw.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number);
    if (!numbers || numbers.length !== 4) return null;
    return { minX: numbers[0], minY: numbers[1], width: numbers[2], height: numbers[3] };
};

/*
 * Resolves a <marker> element's own attributes, chasing a single
 * `href="#other"` inheritance link for whichever it doesn't set itself — same
 * convention gradients/patterns support, same cycle-guard as `<use>`.
 */
export const resolveMarkerAttrs = (
    el: Element,
    idMap: ReadonlyMap<string, Element>,
    visited: ReadonlySet<string>,
): MarkerAttrs | null => {
    if (el.tagName.toLowerCase() !== 'marker') return null;

    const id = el.getAttribute('id');
    const hrefId = resolveHref(el);
    let base: MarkerAttrs | null = null;
    if (hrefId && !visited.has(hrefId) && visited.size < MAX_USE_DEPTH) {
        const baseEl = idMap.get(hrefId);
        if (baseEl) {
            base = resolveMarkerAttrs(baseEl, idMap, new Set(visited).add(id ?? hrefId));
        }
    }

    return {
        refX: el.hasAttribute('refX') ? num(el.getAttribute('refX'), 0) : (base?.refX ?? 0),
        refY: el.hasAttribute('refY') ? num(el.getAttribute('refY'), 0) : (base?.refY ?? 0),
        markerWidth: el.hasAttribute('markerWidth')
            ? num(el.getAttribute('markerWidth'), 3)
            : (base?.markerWidth ?? 3),
        markerHeight: el.hasAttribute('markerHeight')
            ? num(el.getAttribute('markerHeight'), 3)
            : (base?.markerHeight ?? 3),
        markerUnits: el.hasAttribute('markerUnits')
            ? el.getAttribute('markerUnits')?.toLowerCase() === 'userspaceonuse'
                ? 'userSpaceOnUse'
                : 'strokeWidth'
            : (base?.markerUnits ?? 'strokeWidth'),
        orient: el.hasAttribute('orient')
            ? parseOrient(el.getAttribute('orient'), 0)
            : (base?.orient ?? 0),
        viewBox: el.hasAttribute('viewBox')
            ? parseViewBox(el.getAttribute('viewBox'))
            : (base?.viewBox ?? null),
        overflowVisible: (() => {
            const raw = readPresentation(el, 'overflow');
            return raw !== null ? raw.trim() === 'visible' : (base?.overflowVisible ?? false);
        })(),
    };
};

/*
 * A <marker> with no children of its own inherits content from the element
 * its `href` points to — same all-or-nothing rule as `findPatternContentEl`.
 */
export const findMarkerContentEl = (
    el: Element,
    idMap: ReadonlyMap<string, Element>,
    visited: ReadonlySet<string> = new Set(),
): Element | null => {
    if (el.children.length > 0) return el;
    const id = el.getAttribute('id');
    const hrefId = resolveHref(el);
    if (!hrefId || visited.has(hrefId) || visited.size >= MAX_USE_DEPTH) return null;
    const baseEl = idMap.get(hrefId);
    if (!baseEl) return null;
    return findMarkerContentEl(baseEl, idMap, new Set(visited).add(id ?? hrefId));
};
