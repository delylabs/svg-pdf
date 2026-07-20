import { isIdentityMatrix, type Matrix2D, parseTransformList } from '../geometry/matrix';
import { computeShapeBBox, shapeToPathData } from '../geometry/path';
import { URL_REF_RE } from '../style/refs';
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

/*
 * Resolves `clip-path="url(#id)"` into concrete path data. Scoped to the
 * common real-world case — a <clipPath> containing one or more plain shapes
 * with no transform of their own (Illustrator/Figma exports overwhelmingly
 * look like this); a clip child with its own `transform`, or
 * clipPathUnits="objectBoundingBox" applied to a non-shape (e.g. a <g>)
 * target, is skipped with a warning rather than attempted, consistent with
 * the fail-safe pattern used everywhere else in this file.
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

// Wraps `draw` in pushClip/popClip instructions when `el` has a resolvable clip-path.
export const withClip = (el: Element, ctx: WalkContext, draw: () => void): void => {
    const clip = resolveClipPathFor(el, ctx);
    if (!clip) {
        draw();
        return;
    }
    ctx.instructions.push({ type: 'pushClip', ...clip });
    draw();
    ctx.instructions.push({ type: 'popClip' });
};
