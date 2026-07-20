import {
    IDENTITY_MATRIX,
    type Matrix2D,
    multiplyMatrix,
    parseFloats,
    parseTransformList,
    translateMatrix,
} from '../geometry/matrix';
import { computeViewBoxTransform } from '../geometry/viewBox';
import { computeShapeBBox, num, shapeToPathData } from '../geometry/path';
import { resolvePaint } from '../style/paint';
import { MAX_USE_DEPTH, resolveHref } from '../style/refs';
import { readPresentation } from '../style/stylesheet';
import type { PreserveAspectRatioMode, ShapePaint } from '../types';
import { SHAPE_ELEMENTS, withClip } from './clip';
import type { WalkContext } from './context';
import { emitMarkerInstructions } from './marker';
import { resolveLinkHref, walkTextElement } from './text';

export type { WalkContext } from './context';

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
 * features. clip-path is resolved for real (see `resolveClipPathFor` in `./clip`).
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
     * not a parsing one. Actual decode (and any fetch) happens in the
     * adapter (e.g. `@delylabs/plotify-libpdf`'s `draw/drawImage.ts`).
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
