import { IDENTITY_MATRIX, type Matrix2D, parseTransformList } from '../geometry/matrix';
import { MAX_USE_DEPTH, resolveHref } from './refs';

export type PatternUnits = 'objectBoundingBox' | 'userSpaceOnUse';

/*
 * Everything about a <pattern> except its drawable content — kept separate
 * from the full `PatternDef` (in `types.ts`, which also carries the resolved
 * `instructions`) so this module never has to import the tree walker just for
 * a type, same reasoning as `PaintContext` in `style/paint.ts`.
 */
export interface PatternAttrs {
    readonly patternUnits: PatternUnits;
    // Default differs from patternUnits: userSpaceOnUse, not objectBoundingBox.
    readonly patternContentUnits: PatternUnits;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly patternTransform: Matrix2D;
}

const parseUnits = (raw: string | null, fallback: PatternUnits): PatternUnits =>
    raw === null
        ? fallback
        : raw.toLowerCase() === 'userspaceonuse'
          ? 'userSpaceOnUse'
          : 'objectBoundingBox';

const num = (raw: string | null, fallback: number): number => {
    if (raw === null) return fallback;
    const parsed = parseFloat(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
};

/*
 * Resolves a <pattern> element's own attributes, chasing a single
 * `href="#other"` inheritance link for whichever attributes it doesn't set
 * itself — same Illustrator-style "one pattern holds the shared geometry,
 * others tweak it" convention gradients support (see `resolveGradientDef`),
 * and the same cycle-guard pattern as `<use>`.
 */
export const resolvePatternAttrs = (
    el: Element,
    idMap: ReadonlyMap<string, Element>,
    visited: ReadonlySet<string>,
): PatternAttrs | null => {
    if (el.tagName.toLowerCase() !== 'pattern') return null;

    const id = el.getAttribute('id');
    const hrefId = resolveHref(el);
    let base: PatternAttrs | null = null;
    if (hrefId && !visited.has(hrefId) && visited.size < MAX_USE_DEPTH) {
        const baseEl = idMap.get(hrefId);
        if (baseEl) {
            base = resolvePatternAttrs(baseEl, idMap, new Set(visited).add(id ?? hrefId));
        }
    }

    return {
        patternUnits: el.hasAttribute('patternUnits')
            ? parseUnits(el.getAttribute('patternUnits'), 'objectBoundingBox')
            : (base?.patternUnits ?? 'objectBoundingBox'),
        patternContentUnits: el.hasAttribute('patternContentUnits')
            ? parseUnits(el.getAttribute('patternContentUnits'), 'userSpaceOnUse')
            : (base?.patternContentUnits ?? 'userSpaceOnUse'),
        x: el.hasAttribute('x') ? num(el.getAttribute('x'), 0) : (base?.x ?? 0),
        y: el.hasAttribute('y') ? num(el.getAttribute('y'), 0) : (base?.y ?? 0),
        width: el.hasAttribute('width') ? num(el.getAttribute('width'), 0) : (base?.width ?? 0),
        height: el.hasAttribute('height') ? num(el.getAttribute('height'), 0) : (base?.height ?? 0),
        patternTransform: el.hasAttribute('patternTransform')
            ? parseTransformList(el.getAttribute('patternTransform'))
            : (base?.patternTransform ?? IDENTITY_MATRIX),
    };
};

/*
 * A <pattern> with no children of its own inherits its content from the
 * element its `href` points to (chased until one with actual children is
 * found, or the chain runs out) — per spec, content is all-or-nothing
 * (never merged across the chain), unlike the individual attributes above.
 */
export const findPatternContentEl = (
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
    return findPatternContentEl(baseEl, idMap, new Set(visited).add(id ?? hrefId));
};
