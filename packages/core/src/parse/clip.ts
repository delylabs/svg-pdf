import {
    IDENTITY_MATRIX,
    isIdentityMatrix,
    type Matrix2D,
    multiplyMatrix,
    parseTransformList,
    translateMatrix,
} from '../geometry/matrix';
import { computeShapeBBox, num, shapeToPathData, transformPathData } from '../geometry/path';
import { resolveHref, URL_REF_RE } from '../style/refs';
import { readPresentation } from '../style/stylesheet';
import type { FillRule } from '../types';
import type { WalkContext } from './context';

export const SHAPE_ELEMENTS = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polygon',
    'polyline',
]);

interface ResolvedClip {
    readonly paths: string[];
    readonly clipRule: FillRule;
    readonly bboxMatrix: Matrix2D | null;
}

const bakedPath = (d: string, m: Matrix2D): string =>
    isIdentityMatrix(m) ? d : transformPathData(d, m);

/*
 * Collects path data from a <clipPath>'s content, recursing into <g> (a
 * grouping wrapper, common when multiple shapes are meant to union together)
 * and dereferencing <use> (very common in Illustrator/Figma exports:
 * `<clipPath><use href="#shape"/></clipPath>` reusing shared geometry). Any
 * `transform` along the way — on the <g>, the <use>, or the shape a <use>
 * points at — as well as a <use>'s own x/y offset, is folded into a running
 * matrix and baked directly into the resulting shape's path coordinates via
 * `transformPathData`, since a <clipPath>'s region is built from raw path
 * strings rather than drawn through the normal transform-stack machinery
 * every other element uses. Any child tag this doesn't know how to turn
 * into path data (e.g. <text>) is skipped with a warning instead of
 * silently dropped, so a smaller-than-expected clip region always has a
 * paper trail.
 */
const collectClipPaths = (
    children: Iterable<Element>,
    ctx: WalkContext,
    paths: string[],
    matrix: Matrix2D,
): void => {
    for (const child of children) {
        const tag = child.tagName.toLowerCase();
        const childMatrix = multiplyMatrix(
            parseTransformList(child.getAttribute('transform')),
            matrix,
        );

        if (tag === 'g') {
            collectClipPaths(Array.from(child.children), ctx, paths, childMatrix);
            continue;
        }
        if (tag === 'use') {
            const refId = resolveHref(child);
            const refEl = refId ? ctx.idMap.get(refId) : undefined;
            if (!refEl || !SHAPE_ELEMENTS.has(refEl.tagName.toLowerCase())) {
                ctx.warnings.push('<clipPath> <use> without a valid href to a shape was skipped');
                continue;
            }
            const ux = num(child.getAttribute('x'), 0);
            const uy = num(child.getAttribute('y'), 0);
            const useMatrix = multiplyMatrix(translateMatrix(ux, uy), childMatrix);
            const refMatrix = multiplyMatrix(
                parseTransformList(refEl.getAttribute('transform')),
                useMatrix,
            );
            const d = shapeToPathData(refEl, ctx.viewport);
            if (d) paths.push(bakedPath(d, refMatrix));
            continue;
        }
        if (!SHAPE_ELEMENTS.has(tag)) {
            ctx.warnings.push(`<clipPath> child <${tag}> is not supported and was skipped`);
            continue;
        }
        const d = shapeToPathData(child, ctx.viewport);
        if (d) paths.push(bakedPath(d, childMatrix));
    }
};

/*
 * Resolves `clip-path="url(#id)"` into concrete path data. Returns `null`
 * when there's no clip-path to apply at all (no/invalid `clip-path`
 * attribute, or a broken `url(#id)` reference — per spec, both mean "as if
 * clip-path weren't specified," so the target draws normally, unclipped).
 * Returns a `ResolvedClip` with an *empty* `paths` array when the reference
 * is valid but nothing inside it could be resolved (e.g. every child was
 * unsupported) — per spec an empty clip region clips away everything, the
 * opposite of "no clip," so callers must not treat the two the same way
 * (see `withClip` below).
 */
export const resolveClipPathFor = (el: Element, ctx: WalkContext): ResolvedClip | null => {
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
    collectClipPaths(Array.from(clipEl.children), ctx, paths, IDENTITY_MATRIX);

    const clipRule = readPresentation(clipEl, 'clip-rule') === 'evenodd' ? 'evenodd' : 'nonzero';
    return { paths, clipRule, bboxMatrix };
};

// Wraps `draw` in pushClip/popClip instructions when `el` has a resolvable clip-path.
export const withClip = (el: Element, ctx: WalkContext, draw: () => void): void => {
    const clip = resolveClipPathFor(el, ctx);
    if (!clip) {
        draw();
        return;
    }
    // An empty clip region (clipPath resolved, but nothing inside it usable) clips away everything — draw() must not run.
    if (clip.paths.length === 0) return;
    ctx.instructions.push({ type: 'pushClip', ...clip });
    draw();
    ctx.instructions.push({ type: 'popClip' });
};
