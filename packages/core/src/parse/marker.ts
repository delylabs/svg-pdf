import { IDENTITY_MATRIX } from '../geometry/matrix';
import { computeMarkerVertices, type MarkerVertex } from '../geometry/markerVertices';
import { DEFAULT_PAINT } from '../style/paint';
import { findMarkerContentEl, resolveMarkerAttrs } from '../style/marker';
import { MAX_USE_DEPTH, URL_REF_RE } from '../style/refs';
import { readCssOnly, readPresentation } from '../style/stylesheet';
import type { MarkerDef, ShapePaint, SvgInstruction } from '../types';
import type { WalkContext } from './context';
import { walkNode } from './walk';

/*
 * Resolves a <marker> element (attrs + content, chasing `href` inheritance
 * the same way `resolvePatternDef` does) into a `MarkerDef`. `visited` guards
 * against the same class of cycle — a marker whose own content draws a path
 * that references itself (or a chain back to itself) as a marker.
 */
export const resolveMarkerDef = (
    el: Element,
    ctx: WalkContext,
    visited: ReadonlySet<string> = new Set(),
): MarkerDef | null => {
    const attrs = resolveMarkerAttrs(el, ctx.idMap, visited);
    if (!attrs) return null;

    const id = el.getAttribute('id') ?? '';
    if (visited.has(id) || visited.size >= MAX_USE_DEPTH) {
        ctx.warnings.push(
            '<marker> reference forms a cycle or is nested too deeply and was skipped',
        );
        return null;
    }
    const nextVisited = new Set(visited).add(id);

    const contentEl = findMarkerContentEl(el, ctx.idMap);
    const instructions: SvgInstruction[] = [];
    if (contentEl) {
        const contentCtx: WalkContext = {
            idMap: ctx.idMap,
            warnings: ctx.warnings,
            instructions,
            visitedUseIds: new Set(),
            gradients: ctx.gradients,
            patterns: ctx.patterns,
            markers: ctx.markers,
            cssRules: ctx.cssRules,
            viewport: ctx.viewport,
            resolvePattern: ctx.resolvePattern,
            resolveMarker: (markerEl: Element) => resolveMarkerDef(markerEl, ctx, nextVisited),
        };
        for (const child of Array.from(contentEl.children)) {
            walkNode(child, DEFAULT_PAINT, contentCtx, IDENTITY_MATRIX);
        }
    }

    return { ...attrs, instructions };
};

const MARKER_ELIGIBLE_ELEMENTS = new Set(['path', 'line', 'polyline', 'polygon']);

interface ResolvedMarkerRefs {
    readonly start: string | null;
    readonly mid: string | null;
    readonly end: string | null;
}

// `marker` (the shorthand for marker-start/-mid/-end) is CSS-only, not an SVG presentation attribute — unlike its longhands, a bare `marker="url(#id)"` attribute is inert in browsers, only `style="marker:url(#id)"`/CSS is honored.
const resolveMarkerRefs = (el: Element, ctx: WalkContext): ResolvedMarkerRefs => {
    const shorthand = readCssOnly(el, 'marker', ctx.cssRules);
    const shorthandId =
        shorthand && shorthand.trim() !== 'none' ? (URL_REF_RE.exec(shorthand)?.[1] ?? null) : null;
    const resolveOne = (propName: string): string | null => {
        const raw = readPresentation(el, propName, ctx.cssRules);
        if (raw === null) return shorthandId;
        if (raw.trim() === 'none') return null;
        return URL_REF_RE.exec(raw)?.[1] ?? null;
    };
    return {
        start: resolveOne('marker-start'),
        mid: resolveOne('marker-mid'),
        end: resolveOne('marker-end'),
    };
};

// orient="auto-start-reverse" only flips the marker-start instance 180° — marker-mid/-end using the same <marker> element behave exactly like plain "auto".
const resolveMarkerAngle = (def: MarkerDef, vertex: MarkerVertex): number => {
    if (def.orient === 'auto') return vertex.angle;
    if (def.orient === 'auto-start-reverse') {
        return vertex.type === 'start' ? vertex.angle + Math.PI : vertex.angle;
    }
    return def.orient;
};

/*
 * Emits one `marker` instruction per marker-eligible vertex on `el` (a
 * path/line/polyline/polygon with at least one of marker-start/-mid/-end
 * set) — called from within the same withPush/withClip bracket the shape
 * itself draws in, so markers inherit its transform/clip for free.
 */
export const emitMarkerInstructions = (
    el: Element,
    d: string,
    paint: ShapePaint,
    ctx: WalkContext,
): void => {
    if (!MARKER_ELIGIBLE_ELEMENTS.has(el.tagName.toLowerCase())) return;
    const refs = resolveMarkerRefs(el, ctx);
    if (!refs.start && !refs.mid && !refs.end) return;
    if (paint.paintOrder[paint.paintOrder.length - 1] !== 'markers') {
        ctx.warnings.push(
            'paint-order with markers before fill or stroke is not supported — markers are always drawn last',
        );
    }

    const defFor = (refId: string | null): MarkerDef | null => {
        if (!refId) return null;
        const refEl = ctx.idMap.get(refId);
        if (!refEl || refEl.tagName.toLowerCase() !== 'marker') {
            ctx.warnings.push(`marker reference "url(#${refId})" target not found and was skipped`);
            return null;
        }
        const def = ctx.resolveMarker(refEl);
        if (def) ctx.markers.set(refId, def);
        return def;
    };
    const startDef = defFor(refs.start);
    const midDef = refs.mid === refs.start ? startDef : defFor(refs.mid);
    const endDef =
        refs.end === refs.start ? startDef : refs.end === refs.mid ? midDef : defFor(refs.end);
    if (!startDef && !midDef && !endDef) return;

    for (const vertex of computeMarkerVertices(d)) {
        const [refId, def] =
            vertex.type === 'start'
                ? [refs.start, startDef]
                : vertex.type === 'mid'
                  ? [refs.mid, midDef]
                  : [refs.end, endDef];
        if (!refId || !def) continue;
        ctx.instructions.push({
            type: 'marker',
            markerId: refId,
            x: vertex.x,
            y: vertex.y,
            angle: resolveMarkerAngle(def, vertex),
            scale: def.markerUnits === 'strokeWidth' ? paint.strokeWidth : 1,
        });
    }
};
