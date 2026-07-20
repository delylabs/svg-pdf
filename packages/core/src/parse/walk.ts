import {
    IDENTITY_MATRIX,
    isIdentityMatrix,
    type Matrix2D,
    multiplyMatrix,
    parseFloats,
    parseTransformList,
    translateMatrix,
} from '../geometry/matrix';
import { computeMarkerVertices, type MarkerVertex } from '../geometry/markerVertices';
import { computeViewBoxTransform } from '../geometry/viewBox';
import { computeShapeBBox, num, type ShapeViewport, shapeToPathData } from '../geometry/path';
import { computeCumulativeLengths, flattenPathToPolyline } from '../geometry/pathLength';
import { CSS_NAMED_COLORS, type RgbColor } from '../style/color';
import { findMarkerContentEl, resolveMarkerAttrs } from '../style/marker';
import {
    applyTextTransform,
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
import { readCssOnly, readPresentation } from '../style/stylesheet';
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
     * The root <svg>'s viewBox size — the percentage basis for a shape's own
     * `%`-valued geometry (`x="50%"`, etc). A nested `<svg>`/`<symbol>`
     * establishing its own smaller viewport isn't tracked, so this stays the
     * root's size throughout the whole walk, not the locally nested one.
     */
    readonly viewport: ShapeViewport;
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
    // 'text'/'tspan'/'image'/'svg' are handled separately below, not in this skip-and-warn set.
    'foreignobject',
    'filter',
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
        const bbox = computeShapeBBox(el, ctx.viewport);
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
        const d = shapeToPathData(child, ctx.viewport);
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
 * Shared between an `<a>` encountered as an ordinary drawable element (via
 * `walkNode`) and one nested inside a `<text>` subtree (via
 * `walkTextElement`, e.g. `<text><a href="...">label</a></text>` — a common
 * real-world pattern for a link on a run of text or a `<tspan>`, not just a
 * whole shape/text block) — both need the exact same href resolution and
 * `#fragment` handling, so it's not duplicated between the two call sites.
 * Returns `null` for a missing/unsupported href (already warned).
 */
function resolveLinkHref(el: Element, ctx: WalkContext): string | null {
    const hrefRaw = el.getAttribute('href') ?? el.getAttribute('xlink:href');
    if (!hrefRaw) return null;
    if (hrefRaw.startsWith('#')) {
        ctx.warnings.push(
            '<a href="#..."> (an internal same-page fragment link) is not supported and was skipped',
        );
        return null;
    }
    return hrefRaw;
}

/*
 * Shared between a regular <text>/<tspan> run and a <textPath> run: resolves
 * the actual solid fill to draw with (gradient/pattern falls back to solid
 * black, with a warning — <text> fill only ever supports a solid color) and
 * emits the unencodable-character/stroke warnings, all in one place so
 * `<textPath>` doesn't have to duplicate this. Returns `null` when there's
 * nothing to draw (transparent fill), same meaning as `paint.fill === null`.
 */
function resolveTextFillAndWarn(
    paint: ShapePaint,
    text: string,
    ctx: WalkContext,
): RgbColor | null {
    if (paint.fill === null) return null;
    let fill: RgbColor;
    if (typeof paint.fill === 'object' && 'kind' in paint.fill) {
        ctx.warnings.push(
            'gradient/pattern fill on <text> is not supported and was drawn with a solid black fill instead',
        );
        fill = CSS_NAMED_COLORS.black;
    } else {
        fill = paint.fill;
    }
    if (hasUnencodableChar(text)) {
        ctx.warnings.push(
            '<text> contains characters outside the basic Latin/Latin-1 range (e.g. CJK, Arabic, emoji) that standard PDF fonts cannot render and were shown blank',
        );
    }
    // Only fires when a stroke is actually set on text (rare), so it stays quiet for the overwhelming majority of SVGs that don't.
    if (paint.stroke !== null) {
        ctx.warnings.push('stroke on <text> is not supported and was drawn without one');
    }
    return fill;
}

/*
 * <textPath href="#id"> draws its text along the referenced <path>'s
 * geometry instead of at a fixed x/y — see `TextPathInstruction`'s doc
 * comment in types.ts for why this needs its own instruction type and what
 * it deliberately doesn't support (textLength/lengthAdjust, nested tspans).
 * `startOffset` accepts a plain number (in the referenced path's own
 * length units, rescaled by its `pathLength` attribute if set) or a `%` of
 * the path's total length.
 */
function walkTextPathElement(el: Element, inherited: ShapePaint, ctx: WalkContext): void {
    const paint = resolvePaint(el, inherited, ctx);
    const refId = resolveHref(el);
    const refEl = refId ? ctx.idMap.get(refId) : undefined;
    if (!refEl || refEl.tagName.toLowerCase() !== 'path') {
        ctx.warnings.push('<textPath> without a valid href to a <path> was skipped');
        return;
    }
    const points = flattenPathToPolyline(refEl.getAttribute('d') ?? '');
    if (points.length < 2) {
        ctx.warnings.push('<textPath> referenced a <path> with no usable geometry and was skipped');
        return;
    }
    const cumLengths = computeCumulativeLengths(points);
    const totalLength = cumLengths[cumLengths.length - 1];
    const pathLengthAttr = refEl.hasAttribute('pathLength')
        ? num(refEl.getAttribute('pathLength'))
        : null;
    // Per spec, pathLength lets the author declare the path's length in their own units — the ratio to the real flattened length rescales startOffset to match.
    const lengthScale = pathLengthAttr && pathLengthAttr > 0 ? totalLength / pathLengthAttr : 1;
    const startOffsetRaw = (el.getAttribute('startOffset') ?? '').trim();
    let startDistance = 0;
    if (startOffsetRaw.endsWith('%')) {
        const pct = parseFloat(startOffsetRaw);
        startDistance = Number.isNaN(pct) ? 0 : (pct / 100) * totalLength;
    } else if (startOffsetRaw !== '') {
        const raw = parseFloat(startOffsetRaw);
        startDistance = Number.isNaN(raw) ? 0 : raw * lengthScale;
    }

    if (el.children.length > 0) {
        ctx.warnings.push(
            '<textPath> with nested <tspan> children is not supported — only its own direct text content was used',
        );
    }
    if (el.hasAttribute('textLength')) {
        ctx.warnings.push(
            '<textPath textLength="..."> (stretching/compressing text to fit an exact length) is not supported and was ignored',
        );
    }

    const ownText = applyTextTransform(
        collectDirectText(el, paint.preserveWhitespace),
        paint.textTransform,
    );
    const fill = resolveTextFillAndWarn(paint, ownText, ctx);
    if (ownText && fill) {
        ctx.instructions.push({
            type: 'textPath',
            text: ownText,
            points,
            cumLengths,
            startDistance,
            fontSize: paint.fontSize,
            font: resolveStandardFont(paint.fontFamily, paint.fontWeight, paint.fontStyle),
            fontFamily: paint.fontFamily,
            fontWeight: paint.fontWeight,
            fontStyle: paint.fontStyle,
            fill,
            fillOpacity: paint.fillOpacity,
            textAnchor: paint.textAnchor,
            letterSpacing: paint.letterSpacing,
            wordSpacing: paint.wordSpacing,
        });
    }
}

/*
 * <text>/<tspan> support, scoped to "best effort" rather than full fidelity:
 * always drawn with one of PDF's 14 standard fonts (font-family is mapped to
 * generic serif/sans/mono, never matched/embedded — no font subsystem here),
 * Latin/Latin-1 characters only (see `hasUnencodableChar`), no text stroke,
 * no gradient/pattern fill (falls back to solid black).
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
 *
 * Per spec, `text-anchor` applies to a whole *text chunk* (every run back to
 * the last run with its own explicit `x` or `y`), not to each run
 * individually — a chunk's total advance width determines one shared offset
 * for all its runs. `startsNewChunk` marks where a chunk begins (own `x` or
 * `y`, or first-in-sequence); svgEmbed.ts groups runs by it before applying
 * `textAnchor`. Note this is a coarser, per-run approximation of the real
 * per-*character* chunk rule (a `<tspan>` with only some of its child
 * characters repositioned still doesn't split into two chunks here).
 *
 * `<textPath>` is handled separately by `walkTextPathElement` above — see
 * its own doc comment and `TextPathInstruction` in types.ts.
 *
 * `<a>` can also appear *inside* a `<text>` subtree (wrapping a run of bare
 * text or a `<tspan>`, e.g. `<text>A <a href="..."><tspan>link</tspan></a></text>`)
 * rather than only wrapping a whole `<text>`/shape from outside via
 * `walkNode`'s own `<a>` handling — spec-wise it has no `x`/`y`/`dx`/`dy` of
 * its own, so it falls through the same run/recursion logic below as a
 * transparent, position-inheriting wrapper (exactly like a `<tspan>` with no
 * position of its own would), just also bracketed with `linkStart`/`linkEnd`.
 *
 * A `<text>`/`<tspan>` can also interleave bare text with element children,
 * e.g. `<text>A <tspan>link</tspan> here</text>` — "A " and " here" are two
 * separate direct text-node children of the outer element, sitting either
 * side of the `<tspan>`. Each direct text node is walked as its own run (in
 * document order, alongside recursion into element children) rather than
 * concatenated into one merged run the way `collectDirectText` does for
 * warning-purposes text below — merging them would draw "A" and "here" as if
 * contiguous while the `<tspan>` run in between started over at the same x,
 * producing overlapping text instead of "A", then the tspan, then "here"
 * flowing after it. `chunkCursor` threads `continuesFlow`/`startsNewChunk`
 * across this whole interleaved sequence so only the very first run (own
 * `x`/`y`, or first in the parent's sequence) starts fresh.
 */
function walkTextElement(
    el: Element,
    inherited: ShapePaint,
    ctx: WalkContext,
    cursorX: number,
    cursorY: number,
    isFirstInSequence: boolean,
): void {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textpath') {
        walkTextPathElement(el, inherited, ctx);
        return;
    }
    const linkHref = tag === 'a' ? resolveLinkHref(el, ctx) : null;
    if (linkHref !== null) ctx.instructions.push({ type: 'linkStart', href: linkHref });

    const paint = resolvePaint(el, inherited, ctx);
    const hasOwnX = el.hasAttribute('x');
    const hasOwnY = el.hasAttribute('y');
    const ownX = hasOwnX ? num(el.getAttribute('x')) : cursorX;
    const ownY = hasOwnY ? num(el.getAttribute('y')) : cursorY;
    const x = ownX + parseLengthOrEm(el.getAttribute('dx'), paint.fontSize);
    const y = ownY + parseLengthOrEm(el.getAttribute('dy'), paint.fontSize);

    // Warning-purposes only (unencodable chars / stroke-on-text / gradient fallback) — the actual drawn text below is built per direct-text-node run, not from this merged string.
    const warnText = applyTextTransform(
        collectDirectText(el, paint.preserveWhitespace),
        paint.textTransform,
    );
    const fill = resolveTextFillAndWarn(paint, warnText, ctx);

    /*
     * `firstChild` tracks whether the run about to be processed is the first
     * one encountered while walking *this* element's own childNodes — always
     * starts `true` (mirrors the original "first element child always
     * resets" rule), independent of `isFirstInSequence`.
     *
     * A direct text-node run still needs the real `isFirstInSequence`/
     * `hasOwnX`/`hasOwnY` (only while `firstChild` is still true — i.e. it's
     * this element's *first* run) to reproduce what used to be its single
     * merged "own text" run. `startsNewChunk`/`continuesFlow` are
     * independent per spec (a tspan with only its own `y` starts a new
     * anchor chunk *without* resetting the x-flow cursor), so they're
     * computed separately, not as complements of each other.
     *
     * Handing off to a *child element*, though, must only inherit this
     * element's own freshness (`isFirstInSequence || hasOwnX` — `hasOwnY`
     * doesn't reset the flow cursor, per spec) while `firstChild` is still
     * true, i.e. nothing has been drawn at this level yet. Once something
     * has (a text-node run, or a previous child), a further pass-through
     * child with no position of its own (like a bare `<tspan>` or `<a>`)
     * must continue that flow rather than resetting — that was the actual
     * root cause of text drawn after a nested `<tspan>`/`<a>` overlapping
     * with what came before it.
     */
    let firstChild = true;
    const elIsFresh = isFirstInSequence || hasOwnX;

    const childNodes = Array.from(el.childNodes);
    childNodes.forEach((node, index) => {
        if (node.nodeType === 3) {
            // 3 = Node.TEXT_NODE (no `Node` global in a worker)
            const raw = node.nodeValue ?? '';
            let text = raw;
            if (!paint.preserveWhitespace) {
                text = text.replace(/\s+/g, ' ');
                // Only the leading edge of the very first node and the trailing edge of the very last node get trimmed — matches how a single merged run would only trim its own outer edges, while an interior boundary space next to a sibling element stays as a real separator.
                if (index === 0) text = text.replace(/^ /, '');
                if (index === childNodes.length - 1) text = text.replace(/ $/, '');
            }
            const runText = applyTextTransform(text, paint.textTransform);
            if (runText && fill) {
                const isOwnFirstRun = firstChild;
                ctx.instructions.push({
                    type: 'text',
                    text: runText,
                    x,
                    y,
                    fontSize: paint.fontSize,
                    font: resolveStandardFont(paint.fontFamily, paint.fontWeight, paint.fontStyle),
                    fontFamily: paint.fontFamily,
                    fontWeight: paint.fontWeight,
                    fontStyle: paint.fontStyle,
                    fill,
                    fillOpacity: paint.fillOpacity,
                    textAnchor: paint.textAnchor,
                    letterSpacing: paint.letterSpacing,
                    wordSpacing: paint.wordSpacing,
                    continuesFlow: isOwnFirstRun ? !isFirstInSequence && !hasOwnX : true,
                    startsNewChunk: isOwnFirstRun ? isFirstInSequence || hasOwnX || hasOwnY : false,
                });
                firstChild = false;
            }
        } else if (node.nodeType === 1) {
            // 1 = Node.ELEMENT_NODE
            walkTextElement(node as Element, paint, ctx, x, y, firstChild && elIsFresh);
            firstChild = false;
        }
    });

    if (linkHref !== null) ctx.instructions.push({ type: 'linkEnd' });
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
                symbolMatrix = computeViewBoxTransform(
                    vbX,
                    vbY,
                    vbWidth,
                    vbHeight,
                    useWidth,
                    useHeight,
                    referenced.getAttribute('preserveAspectRatio'),
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

    /*
     * A nested <svg> establishes its own viewport (per spec, clipped to it by
     * default) at (x,y) with size (width,height) in the parent's coordinate
     * system, optionally with its own viewBox scaled to fit that viewport —
     * the exact same transform math as `<use>`-of-`<symbol>` above, plus an
     * explicit x/y offset and a viewport clip instead of relying on the
     * referencing element's own clip-path.
     *
     * Scope limit: width/height must be explicit numbers here. Per spec they
     * default to 100% of the *parent* viewport when absent, but Plotify
     * doesn't track a live "current viewport size" for percentage resolution
     * anywhere else in the codebase (the root <svg>'s own width/height
     * fallback in `resolveSvgSize` is a one-time computation, not something
     * threaded through the walk) — so an absent width/height is skipped with
     * a warning rather than guessed at.
     */
    if (tag === 'svg') {
        const width = el.hasAttribute('width') ? num(el.getAttribute('width')) : null;
        const height = el.hasAttribute('height') ? num(el.getAttribute('height')) : null;
        if (width === null || height === null || width <= 0 || height <= 0) {
            ctx.warnings.push(
                'nested <svg> without explicit numeric width/height (percentage sizing is not supported) was skipped',
            );
            return;
        }
        const x = num(el.getAttribute('x'));
        const y = num(el.getAttribute('y'));
        const paint = resolvePaint(el, inherited, ctx);
        const offsetMatrix = multiplyMatrix(translateMatrix(x, y), transform);

        const viewBoxNumbers = el.hasAttribute('viewBox')
            ? parseFloats(el.getAttribute('viewBox') ?? '')
            : null;
        let viewBoxMatrix = IDENTITY_MATRIX;
        if (viewBoxNumbers?.length === 4) {
            const [vbX, vbY, vbWidth, vbHeight] = viewBoxNumbers;
            viewBoxMatrix = computeViewBoxTransform(
                vbX,
                vbY,
                vbWidth,
                vbHeight,
                width,
                height,
                el.getAttribute('preserveAspectRatio'),
            );
        }
        const overflowVisible = readPresentation(el, 'overflow')?.trim() === 'visible';

        withPush(offsetMatrix, ctx, () => {
            const clipViewport = !overflowVisible;
            if (clipViewport) {
                ctx.instructions.push({
                    type: 'pushClip',
                    paths: [`M 0 0 H ${width} V ${height} H 0 Z`],
                    clipRule: 'nonzero',
                    bboxMatrix: null,
                });
            }
            withPush(viewBoxMatrix, ctx, () => {
                const nextAccMatrix = multiplyMatrix(
                    viewBoxMatrix,
                    multiplyMatrix(offsetMatrix, accMatrix),
                );
                for (const child of Array.from(el.children)) {
                    walkNode(child, paint, ctx, nextAccMatrix);
                }
            });
            if (clipViewport) ctx.instructions.push({ type: 'popClip' });
        });
        return;
    }

    if (CONTAINER_ELEMENTS.has(tag)) {
        const paint = resolvePaint(el, inherited, ctx);
        /*
         * `<a>` becomes a clickable PDF link annotation over whatever it
         * wraps — but only for a real cross-document/external target.
         * `href="#fragment"` has no PDF equivalent here (each SVG becomes
         * one standalone page, not a multi-page document with named
         * destinations to jump between), so it's warned and treated as a
         * plain transparent group instead, same as `<g>`.
         */
        const linkHref = tag === 'a' ? resolveLinkHref(el, ctx) : null;
        withPush(transform, ctx, () => {
            withClip(el, ctx, () => {
                if (linkHref !== null) ctx.instructions.push({ type: 'linkStart', href: linkHref });
                for (const child of Array.from(el.children)) {
                    walkNode(child, paint, ctx, elMatrix);
                }
                if (linkHref !== null) ctx.instructions.push({ type: 'linkEnd' });
            });
        });
        return;
    }

    if (SHAPE_ELEMENTS.has(tag)) {
        const d = shapeToPathData(el, ctx.viewport);
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
        const bbox = needsBBox ? computeShapeBBox(el, ctx.viewport) : null;
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
