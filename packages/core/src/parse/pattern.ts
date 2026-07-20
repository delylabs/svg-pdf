import { IDENTITY_MATRIX } from '../geometry/matrix';
import { DEFAULT_PAINT } from '../style/paint';
import { findPatternContentEl, resolvePatternAttrs } from '../style/pattern';
import { MAX_USE_DEPTH } from '../style/refs';
import type { PatternDef, SvgInstruction } from '../types';
import type { WalkContext } from './context';
import { walkNode } from './walk';

/*
 * Resolves a <pattern> element (its own attrs, plus attrs/content inherited
 * via `href`) into a `PatternDef`, walking its content into a flat
 * instruction list the exact same way the rest of this file does — so a
 * pattern cell can contain nested <g>s, other shapes, even another
 * `url(#...)` fill, not just a flat list of shapes like <clipPath> supports.
 * `visited` guards against both an `href` cycle and a pattern whose own
 * content fills itself (directly or indirectly) with itself — reused for
 * both since either one means "already resolving this id, stop".
 */
export const resolvePatternDef = (
    el: Element,
    ctx: WalkContext,
    visited: ReadonlySet<string> = new Set(),
): PatternDef | null => {
    const attrs = resolvePatternAttrs(el, ctx.idMap, visited);
    if (!attrs) return null;
    if (attrs.width <= 0 || attrs.height <= 0) return null;

    const id = el.getAttribute('id') ?? '';
    if (visited.has(id) || visited.size >= MAX_USE_DEPTH) {
        ctx.warnings.push(
            '<pattern> reference forms a cycle or is nested too deeply and was skipped',
        );
        return null;
    }
    const nextVisited = new Set(visited).add(id);

    const contentEl = findPatternContentEl(el, ctx.idMap);
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
            resolvePattern: (patternEl: Element) => resolvePatternDef(patternEl, ctx, nextVisited),
            resolveMarker: ctx.resolveMarker,
        };
        for (const child of Array.from(contentEl.children)) {
            walkNode(child, DEFAULT_PAINT, contentCtx, IDENTITY_MATRIX);
        }
    }

    return { ...attrs, instructions };
};
