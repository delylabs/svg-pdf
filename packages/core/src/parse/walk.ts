import {
    IDENTITY_MATRIX,
    isIdentityMatrix,
    type Matrix2D,
    multiplyMatrix,
    parseFloats,
    parseTransformList,
    scaleMatrix,
    translateMatrix,
} from '../geometry/matrix';
import { computeMarkerVertices, type MarkerVertex } from '../geometry/markerVertices';
import { computeShapeBBox, num, shapeToPathData } from '../geometry/path';
import { CSS_NAMED_COLORS, type RgbColor } from '../style/color';
import { findMarkerContentEl, resolveMarkerAttrs } from '../style/marker';
import {
    collectDirectText,
    DEFAULT_PAINT,
    hasUnencodableChar,
    type PaintContext,
    parseLengthOrEm,
    resolvePaint,
    resolveStandardFont,
} from '../style/paint';
import { findPatternContentEl, resolvePatternAttrs } from '../style/pattern';
import { MAX_USE_DEPTH, resolveHref, URL_REF_RE } from '../style/refs';
import { readPresentation } from '../style/stylesheet';
import type {
    FillRule,
    MarkerDef,
    PatternDef,
    PreserveAspectRatioMode,
    ShapePaint,
    SvgInstruction,
} from '../types';

export interface WalkContext extends PaintContext {
    readonly instructions: SvgInstruction[];
    readonly visitedUseIds: ReadonlySet<string>;
    readonly markers: Map<string, MarkerDef>;
    /*
     * Resolves a <marker> element with cycle protection scoped to the
     * *current* resolution chain — injected fresh (with an extended `visited`
     * set) each time `resolveMarkerDef` builds a nested content context, so a
     * marker whose own content marks a path pointing back to itself is caught
     * the same way `resolvePattern` catches a self-filling pattern.
     */
    readonly resolveMarker: (el: Element) => MarkerDef | null;
}

/*
 * Elements whose subtree is never drawn directly (referenced via <use>/url(#id),
 * or purely descriptive) but whose descendants still belong in the id map.
 */
const NON_RENDERED_CONTAINERS = new Set([
    'defs',
    'symbol',
    'lineargradient',
    'radialgradient',
    'clippath',
    'pattern',
    'mask',
    // Its rules were already read into `cssRules` in a separate pass — walking it as regular content would be wrong (its text is CSS, not drawable).
    'style',
]);

/*
 * Elements not supported in v1 — recorded as a warning, subtree skipped entirely
 * (their children have different semantics than plain drawable content, e.g. a
 * gradient's <stop> children, so descending into them would be wrong anyway).
 */
const UNSUPPORTED_ELEMENTS = new Set([
    // 'text'/'tspan'/'image' are handled separately below, not in this skip-and-warn set.
    'foreignobject',
    'filter',
    'svg', // nested <svg> — only the document root is handled
]);

const CONTAINER_ELEMENTS = new Set(['g', 'a', 'switch']);
const SHAPE_ELEMENTS = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polygon',
    'polyline',
]);

const withPush = (matrix: Matrix2D, ctx: WalkContext, draw: () => void): void => {
    const isIdentity =
        matrix.a === 1 &&
        matrix.b === 0 &&
        matrix.c === 0 &&
        matrix.d === 1 &&
        matrix.e === 0 &&
        matrix.f === 0;
    if (isIdentity) {
        draw();
        return;
    }
    ctx.instructions.push({ type: 'pushMatrix', matrix });
    draw();
    ctx.instructions.push({ type: 'popMatrix' });
};

/*
 * mask/filter are read here only to warn — neither is actually applied, so
 * silently ignoring them would render content differently than the source
 * without telling the user, which breaks the fail-safe promise for skipped
 * features. clip-path is resolved for real below (see `resolveClipPathFor`).
 */
const UNHANDLED_EFFECT_ATTRS = ['mask', 'filter'];

const warnUnhandledEffects = (el: Element, warnings: string[]): void => {
    for (const attr of UNHANDLED_EFFECT_ATTRS) {
        const value = readPresentation(el, attr);
        if (value && value.trim() !== 'none') {
            warnings.push(`${attr}="${value}" is not yet supported and was applied without it`);
        }
    }
};

interface ResolvedClip {
    readonly paths: string[];
    readonly clipRule: FillRule;
    readonly bboxMatrix: Matrix2D | null;
}

/*
 * Resolves `clip-path="url(#id)"` into concrete path data. Scoped to the
 * common real-world case — a <clipPath> containing one or more plain shapes
 * with no transform of their own (Illustrator/Figma exports overwhelmingly
 * look like this); a clip child with its own `transform`, or
 * clipPathUnits="objectBoundingBox" applied to a non-shape (e.g. a <g>)
 * target, is skipped with a warning rather than attempted, consistent with
 * the fail-safe pattern used everywhere else in this file.
 */
const resolveClipPathFor = (el: Element, ctx: WalkContext): ResolvedClip | null => {
    const clipPathAttr = readPresentation(el, 'clip-path');
    if (!clipPathAttr || clipPathAttr.trim() === 'none') return null;

    const refId = URL_REF_RE.exec(clipPathAttr)?.[1];
    const clipEl = refId ? ctx.idMap.get(refId) : undefined;
    if (!clipEl || clipEl.tagName.toLowerCase() !== 'clippath') {
        ctx.warnings.push(`clip-path="${clipPathAttr}" target not found and was skipped`);
        return null;
    }

    const isObjectBoundingBox =
        clipEl.getAttribute('clipPathUnits')?.toLowerCase() === 'objectboundingbox';
    let bboxMatrix: Matrix2D | null = null;
    if (isObjectBoundingBox) {
        const bbox = computeShapeBBox(el);
        if (!bbox) {
            ctx.warnings.push(
                `clip-path="${clipPathAttr}" with clipPathUnits="objectBoundingBox" on a non-shape element is not supported and was skipped`,
            );
            return null;
        }
        bboxMatrix = {
            a: bbox.width,
            b: 0,
            c: 0,
            d: bbox.height,
            e: bbox.x,
            f: bbox.y,
        };
    }

    const paths: string[] = [];
    for (const child of Array.from(clipEl.children)) {
        if (!SHAPE_ELEMENTS.has(child.tagName.toLowerCase())) continue;
        if (
            child.hasAttribute('transform') &&
            !isIdentityMatrix(parseTransformList(child.getAttribute('transform')))
        ) {
            ctx.warnings.push(
                `<clipPath> child with its own transform is not supported and was skipped`,
            );
            continue;
        }
        const d = shapeToPathData(child);
        if (d) paths.push(d);
    }
    if (paths.length === 0) return null;

    const clipRule = readPresentation(clipEl, 'clip-rule') === 'evenodd' ? 'evenodd' : 'nonzero';
    return { paths, clipRule, bboxMatrix };
};

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
            resolvePattern: (patternEl: Element) => resolvePatternDef(patternEl, ctx, nextVisited),
            resolveMarker: ctx.resolveMarker,
        };
        for (const child of Array.from(contentEl.children)) {
            walkNode(child, DEFAULT_PAINT, contentCtx, IDENTITY_MATRIX);
        }
    }

    return { ...attrs, instructions };
};

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

// `marker="url(#id)"` is shorthand for all three of marker-start/-mid/-end; an explicit longhand (including "none") on the element overrides the shorthand for that one position only.
const resolveMarkerRefs = (el: Element, ctx: WalkContext): ResolvedMarkerRefs => {
    const shorthand = readPresentation(el, 'marker');
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
const emitMarkerInstructions = (
    el: Element,
    d: string,
    paint: ShapePaint,
    ctx: WalkContext,
): void => {
    if (!MARKER_ELIGIBLE_ELEMENTS.has(el.tagName.toLowerCase())) return;
    const refs = resolveMarkerRefs(el, ctx);
    if (!refs.start && !refs.mid && !refs.end) return;

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

// Wraps `draw` in pushClip/popClip instructions when `el` has a resolvable clip-path.
const withClip = (el: Element, ctx: WalkContext, draw: () => void): void => {
    const clip = resolveClipPathFor(el, ctx);
    if (!clip) {
        draw();
        return;
    }
    ctx.instructions.push({ type: 'pushClip', ...clip });
    draw();
    ctx.instructions.push({ type: 'popClip' });
};

/*
 * <text>/<tspan> support, scoped to "best effort" rather than full fidelity:
 * always drawn with one of PDF's 14 standard fonts (font-family is mapped to
 * generic serif/sans/mono, never matched/embedded — no font subsystem here),
 * Latin/Latin-1 characters only (see `hasUnencodableChar`), no text stroke,
 * no gradient/pattern fill (falls back to solid black), and <textPath> is
 * skipped with a warning (no path-following layout).
 *
 * A <tspan> without its own x/y either continues an in-progress flow (the
 * common real-world case — e.g. a LibreOffice/OpenOffice export putting every
 * word of a line in its own sibling <tspan> with no x/y at all, meant to
 * render one after another starting exactly where the previous one's text
 * ended) or, if it's the *first* child of an absolutely-positioned parent,
 * starts at that parent's resolved position instead — `isFirstInSequence`
 * below is what tells those two cases apart, so the first run after a fresh
 * position never continues from whatever unrelated text last measured
 * somewhere else. Only non-first siblings lacking their own `x` are marked
 * `continuesFlow`; svgEmbed.ts resolves the actual continuation position at
 * draw time via a running cursor (it needs `measureText`, a library function
 * this module deliberately never touches). This still isn't full per-glyph
 * text-flow layout (no bidi, no per-character kerning beyond the font's own
 * built-in metrics), but it correctly threads multi-run lines.
 */
function walkTextElement(
    el: Element,
    inherited: ShapePaint,
    ctx: WalkContext,
    cursorX: number,
    cursorY: number,
    isFirstInSequence: boolean,
): void {
    if (el.tagName.toLowerCase() === 'textpath') {
        ctx.warnings.push('<textPath> (text drawn along a path) is not supported and was skipped');
        return;
    }

    const paint = resolvePaint(el, inherited, ctx);
    const hasOwnX = el.hasAttribute('x');
    const ownX = hasOwnX ? num(el.getAttribute('x')) : cursorX;
    const ownY = el.hasAttribute('y') ? num(el.getAttribute('y')) : cursorY;
    const x = ownX + parseLengthOrEm(el.getAttribute('dx'), paint.fontSize);
    const y = ownY + parseLengthOrEm(el.getAttribute('dy'), paint.fontSize);
    const continuesFlow = !isFirstInSequence && !hasOwnX;

    const ownText = collectDirectText(el);
    if (ownText && paint.fill !== null) {
        let fill: RgbColor;
        if (typeof paint.fill === 'object' && 'kind' in paint.fill) {
            ctx.warnings.push(
                'gradient/pattern fill on <text> is not supported and was drawn with a solid black fill instead',
            );
            fill = CSS_NAMED_COLORS.black;
        } else {
            fill = paint.fill;
        }
        if (hasUnencodableChar(ownText)) {
            ctx.warnings.push(
                '<text> contains characters outside the basic Latin/Latin-1 range (e.g. CJK, Arabic, emoji) that standard PDF fonts cannot render and were shown blank',
            );
        }
        // Only fires when a stroke is actually set on text (rare), so it stays quiet for the overwhelming majority of SVGs that don't.
        if (paint.stroke !== null) {
            ctx.warnings.push('stroke on <text> is not supported and was drawn without one');
        }
        ctx.instructions.push({
            type: 'text',
            text: ownText,
            x,
            y,
            fontSize: paint.fontSize,
            font: resolveStandardFont(paint.fontFamily, paint.fontWeight, paint.fontStyle),
            fill,
            fillOpacity: paint.fillOpacity,
            textAnchor: paint.textAnchor,
            continuesFlow,
        });
    }

    let firstChild = true;
    for (const child of Array.from(el.children)) {
        walkTextElement(child, paint, ctx, x, y, firstChild);
        firstChild = false;
    }
}

export function walkNode(
    el: Element,
    inherited: ShapePaint,
    ctx: WalkContext,
    accMatrix: Matrix2D,
): void {
    const tag = el.tagName.toLowerCase();

    if (NON_RENDERED_CONTAINERS.has(tag)) return;

    if (UNSUPPORTED_ELEMENTS.has(tag)) {
        ctx.warnings.push(`<${tag}> is not supported yet and was skipped`);
        return;
    }

    warnUnhandledEffects(el, ctx.warnings);

    const transform = parseTransformList(el.getAttribute('transform'));
    const elMatrix = multiplyMatrix(transform, accMatrix);

    if (tag === 'use') {
        const refId = resolveHref(el);
        if (!refId) {
            ctx.warnings.push('<use> without a valid href was skipped');
            return;
        }
        if (ctx.visitedUseIds.has(refId) || ctx.visitedUseIds.size >= MAX_USE_DEPTH) {
            ctx.warnings.push(
                `<use href="#${refId}"> forms a cycle or is nested too deeply and was skipped`,
            );
            return;
        }
        const referenced = ctx.idMap.get(refId);
        if (!referenced) {
            ctx.warnings.push(`<use href="#${refId}"> target not found and was skipped`);
            return;
        }
        const x = num(el.getAttribute('x'));
        const y = num(el.getAttribute('y'));
        const paint = resolvePaint(el, inherited, ctx);
        const useMatrix = multiplyMatrix(translateMatrix(x, y), transform);

        /*
         * A <symbol> only ever renders through a <use> (it's in
         * NON_RENDERED_CONTAINERS so walking it directly is a no-op) — its
         * children have to be walked here instead. Per spec it also
         * establishes a new viewport: if it has a viewBox and the <use>
         * specifies width/height, that viewBox scales to fit, same idea as
         * the root <svg>'s own viewBox-to-page fit.
         */
        const referencedTag = referenced.tagName.toLowerCase();
        const isSymbol = referencedTag === 'symbol';
        let symbolMatrix = IDENTITY_MATRIX;
        if (isSymbol) {
            const viewBoxNumbers = referenced.hasAttribute('viewBox')
                ? parseFloats(referenced.getAttribute('viewBox') ?? '')
                : null;
            const useWidth = el.hasAttribute('width') ? num(el.getAttribute('width')) : null;
            const useHeight = el.hasAttribute('height') ? num(el.getAttribute('height')) : null;
            if (viewBoxNumbers?.length === 4 && useWidth && useHeight) {
                const [vbX, vbY, vbWidth, vbHeight] = viewBoxNumbers;
                const scaleX = vbWidth > 0 ? useWidth / vbWidth : 1;
                const scaleY = vbHeight > 0 ? useHeight / vbHeight : 1;
                symbolMatrix = multiplyMatrix(
                    translateMatrix(-vbX, -vbY),
                    scaleMatrix(scaleX, scaleY),
                );
            }
        }
        const finalMatrix = multiplyMatrix(symbolMatrix, useMatrix);

        withPush(finalMatrix, ctx, () => {
            withClip(el, ctx, () => {
                const nextCtx: WalkContext = {
                    ...ctx,
                    visitedUseIds: new Set(ctx.visitedUseIds).add(refId),
                };
                const nextAccMatrix = multiplyMatrix(finalMatrix, accMatrix);
                if (isSymbol) {
                    for (const child of Array.from(referenced.children)) {
                        walkNode(child, paint, nextCtx, nextAccMatrix);
                    }
                } else {
                    walkNode(referenced, paint, nextCtx, nextAccMatrix);
                }
            });
        });
        return;
    }

    if (tag === 'text') {
        withPush(transform, ctx, () => {
            withClip(el, ctx, () => {
                walkTextElement(el, inherited, ctx, 0, 0, true);
            });
        });
        return;
    }

    /*
     * A great many "SVG"s found in the wild are really just a raster photo
     * wrapped in an <svg> shell — supporting this is worth more in practice
     * than it looks despite the narrow scope: only "meet"/"none"
     * preserveAspectRatio (see the type doc above). This layer only
     * extracts the raw `href` unchanged — it doesn't judge whether it's an
     * inline `data:` URI or an external URL, since fetching policy (whether
     * to fetch at all, timeouts, allowlists) is an adapter/caller concern,
     * not a parsing one. Actual decode (and any fetch) happens in
     * svgEmbed.ts.
     */
    if (tag === 'image') {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
        if (!href) {
            ctx.warnings.push('<image> without a href was skipped');
            return;
        }
        const width = num(el.getAttribute('width'));
        const height = num(el.getAttribute('height'));
        if (width <= 0 || height <= 0) return;
        const x = num(el.getAttribute('x'));
        const y = num(el.getAttribute('y'));
        const paint = resolvePaint(el, inherited, ctx);
        const parRaw = (el.getAttribute('preserveAspectRatio') ?? '').trim();
        if (parRaw.includes('slice')) {
            ctx.warnings.push(
                '<image> preserveAspectRatio "slice" is not supported and was drawn as "meet" (scaled to fit, not cropped) instead',
            );
        }
        const preserveAspectRatio: PreserveAspectRatioMode = parRaw.startsWith('none')
            ? 'none'
            : 'meet';
        withPush(transform, ctx, () => {
            withClip(el, ctx, () => {
                ctx.instructions.push({
                    type: 'image',
                    href,
                    x,
                    y,
                    width,
                    height,
                    preserveAspectRatio,
                    opacity: paint.fillOpacity,
                });
            });
        });
        return;
    }

    if (CONTAINER_ELEMENTS.has(tag)) {
        const paint = resolvePaint(el, inherited, ctx);
        withPush(transform, ctx, () => {
            withClip(el, ctx, () => {
                for (const child of Array.from(el.children)) {
                    walkNode(child, paint, ctx, elMatrix);
                }
            });
        });
        return;
    }

    if (SHAPE_ELEMENTS.has(tag)) {
        const d = shapeToPathData(el);
        if (!d) return;
        const resolvedPaint = resolvePaint(el, inherited, ctx);
        /*
         * A <line> has zero area, so per spec its `fill` never paints anything,
         * no matter what it's set to (browsers never show one). Some PDF
         * viewers still render a faint hairline when a zero-area path is
         * filled (the auto-closed degenerate polygon isn't perfectly
         * zero-width in their rasterizer), so this has to be forced to `null`
         * here rather than left to resolve to the inherited/default fill.
         */
        const paint: ShapePaint = tag === 'line' ? { ...resolvedPaint, fill: null } : resolvedPaint;
        const needsBBox = [paint.fill, paint.stroke].some((p) => {
            if (p === null || typeof p !== 'object' || !('kind' in p)) return false;
            if (p.kind === 'gradient') {
                return ctx.gradients.get(p.gradientId)?.gradientUnits !== 'userSpaceOnUse';
            }
            const def = ctx.patterns.get(p.patternId);
            return (
                def?.patternUnits !== 'userSpaceOnUse' ||
                def?.patternContentUnits !== 'userSpaceOnUse'
            );
        });
        const bbox = needsBBox ? computeShapeBBox(el) : null;
        withPush(transform, ctx, () => {
            withClip(el, ctx, () => {
                ctx.instructions.push({
                    type: 'shape',
                    d,
                    groupMatrix: elMatrix,
                    bbox,
                    ...paint,
                });
                emitMarkerInstructions(el, d, paint, ctx);
            });
        });
        return;
    }

    /*
     * Unknown element (metadata, title, desc, etc.) — descend in case it wraps
     * drawable content (some tools emit non-standard wrapper tags), but don't
     * warn since most of these are legitimately inert.
     */
    for (const child of Array.from(el.children)) {
        walkNode(child, inherited, ctx, accMatrix);
    }
}

export const buildIdMap = (root: Element): Map<string, Element> => {
    const idMap = new Map<string, Element>();
    const stack = [root];
    while (stack.length > 0) {
        const el = stack.pop()!;
        const id = el.getAttribute('id');
        if (id) idMap.set(id, el);
        stack.push(...Array.from(el.children));
    }
    return idMap;
};
