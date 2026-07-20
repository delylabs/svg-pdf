import { num } from '../geometry/path';
import { computeCumulativeLengths, flattenPathToPolyline } from '../geometry/pathLength';
import { CSS_NAMED_COLORS, type RgbColor } from '../style/color';
import {
    applyTextTransform,
    collectDirectText,
    hasUnencodableChar,
    parseLengthOrEm,
    resolvePaint,
    resolveStandardFont,
} from '../style/paint';
import { resolveHref } from '../style/refs';
import type { ShapePaint } from '../types';
import type { WalkContext } from './context';

/*
 * Shared between an `<a>` encountered as an ordinary drawable element (via
 * `walkNode`) and one nested inside a `<text>` subtree (via
 * `walkTextElement`, e.g. `<text><a href="...">label</a></text>` — a common
 * real-world pattern for a link on a run of text or a `<tspan>`, not just a
 * whole shape/text block) — both need the exact same href resolution and
 * `#fragment` handling, so it's not duplicated between the two call sites.
 * Returns `null` for a missing/unsupported href (already warned).
 */
export function resolveLinkHref(el: Element, ctx: WalkContext): string | null {
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
export function walkTextElement(
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
