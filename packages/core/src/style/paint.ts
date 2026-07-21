import type {
    BlendMode,
    FillRule,
    LineCap,
    LineJoin,
    Paint,
    PaintOrder,
    PaintOrderElement,
    PatternDef,
    ShapePaint,
    StandardFontName,
    TextTransform,
} from '../types';
import { parseFloats } from '../geometry/matrix';
import { CSS_NAMED_COLORS, parseSvgColor } from './color';
import { resolveGradientDef, type GradientDef } from './gradient';
import { URL_REF_RE } from './refs';
import { type CssRule, readCssOnly, readPresentation } from './stylesheet';

// CSS `mix-blend-mode` keyword -> PDF `BlendMode` name (same set, PDF just uses PascalCase without hyphens).
const CSS_BLEND_MODES: Record<string, BlendMode> = {
    normal: 'Normal',
    multiply: 'Multiply',
    screen: 'Screen',
    overlay: 'Overlay',
    darken: 'Darken',
    lighten: 'Lighten',
    'color-dodge': 'ColorDodge',
    'color-burn': 'ColorBurn',
    'hard-light': 'HardLight',
    'soft-light': 'SoftLight',
    difference: 'Difference',
    exclusion: 'Exclusion',
    hue: 'Hue',
    saturation: 'Saturation',
    color: 'Color',
    luminosity: 'Luminosity',
};

export const DEFAULT_PAINT_ORDER: PaintOrder = ['fill', 'stroke', 'markers'];

/*
 * Parses SVG `paint-order`. Per spec: keywords `normal`, `fill`, `stroke`,
 * `markers` control the order in which shape layers paint. Missing keywords
 * are appended in their default order (`fill`, then `stroke`, then `markers`).
 */
export const parsePaintOrder = (raw: string | null, inherited: PaintOrder): PaintOrder => {
    if (!raw) return inherited;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'normal') return DEFAULT_PAINT_ORDER;
    const tokens = trimmed.split(/[\s,]+/);
    const result: PaintOrderElement[] = [];
    for (const token of tokens) {
        if (
            (token === 'fill' || token === 'stroke' || token === 'markers') &&
            !result.includes(token)
        ) {
            result.push(token);
        }
    }
    if (result.length === 0) return inherited;
    for (const defaultElement of DEFAULT_PAINT_ORDER) {
        if (!result.includes(defaultElement)) {
            result.push(defaultElement);
        }
    }
    return result;
};

export const DEFAULT_PAINT: ShapePaint = {
    fill: CSS_NAMED_COLORS.black,
    fillOpacity: 1,
    stroke: null,
    strokeOpacity: 1,
    strokeWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 4,
    fillRule: 'nonzero',
    dashArray: null,
    dashOffset: 0,
    paintOrder: DEFAULT_PAINT_ORDER,
    vectorEffect: 'none',
    blendMode: 'Normal',
    fontSize: 16,
    fontFamily: '',
    fontWeight: 'normal',
    fontStyle: 'normal',
    textAnchor: 'start',
    textTransform: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    preserveWhitespace: false,
    visible: true,
};

/*
 * Narrow view of the tree-walking context that paint/attribute resolution
 * actually needs — kept separate from `parse/context.ts`'s full `WalkContext`
 * (which additionally tracks `instructions`/`visitedUseIds`) so this module
 * doesn't have to import the walker just for a type.
 */
export interface PaintContext {
    readonly idMap: ReadonlyMap<string, Element>;
    readonly warnings: string[];
    readonly gradients: Map<string, GradientDef>;
    readonly patterns: Map<string, PatternDef>;
    readonly cssRules: readonly CssRule[];
    /*
     * Resolving a <pattern> means walking its (possibly arbitrary) child
     * content into an instruction list — that's `parse/walk.ts`'s job, not
     * this module's, so it's injected here as a callback rather than
     * importing the walker directly (which would create an import cycle,
     * since `parse/walk.ts` already imports `resolvePaint` from here).
     */
    readonly resolvePattern: (el: Element) => PatternDef | null;
}

/*
 * Parses `stroke-dasharray`. Per spec: "none"/empty/any negative value means no
 * dashing; an odd-length list repeats itself once ("5,3,2" -> "5,3,2,5,3,2") so
 * the pattern still alternates on/off around the whole path; all-zero is
 * equivalent to a solid stroke (would otherwise draw nothing at all).
 */
const parseDashArray = (raw: string): number[] | null => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'none') return null;
    const numbers = parseFloats(trimmed);
    if (numbers.length === 0 || numbers.some((n) => n < 0)) return null;
    if (numbers.every((n) => n === 0)) return null;
    return numbers.length % 2 === 0 ? numbers : [...numbers, ...numbers];
};

// `font-size` supports relative "Nem" (multiplies the inherited size); px/pt/unitless all parse fine via parseFloat's own prefix stop.
const parseFontSize = (raw: string, inherited: number): number => {
    const trimmed = raw.trim();
    if (trimmed.endsWith('em')) return (parseFloat(trimmed) || 1) * inherited;
    const parsed = parseFloat(trimmed);
    return Number.isNaN(parsed) ? inherited : parsed;
};

// Same relative-unit handling as `parseFontSize`, for `dx`/`dy` on <text>/<tspan> (absent -> 0, not "unchanged").
export const parseLengthOrEm = (raw: string | null, fontSize: number): number => {
    if (!raw) return 0;
    const trimmed = raw.trim();
    if (trimmed.endsWith('em')) return (parseFloat(trimmed) || 0) * fontSize;
    const parsed = parseFloat(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
};

const LIST_SEPARATOR_RE = /[\s,]+/;

/*
 * Per-character `dx`/`dy` list form (SVG allows a whole list, one value per
 * character, not just a single shift for the whole run) — each entry parsed
 * the same em-aware way as the scalar `parseLengthOrEm` above.
 */
export const parseLengthOrEmList = (raw: string | null, fontSize: number): number[] =>
    (raw ?? '')
        .trim()
        .split(LIST_SEPARATOR_RE)
        .filter((s) => s !== '')
        .map((s) => parseLengthOrEm(s, fontSize));

// Per-character `rotate` list on <text>/<tspan> — always plain degrees, no `em`/unit support per spec.
export const parseNumberList = (raw: string | null): number[] =>
    (raw ?? '')
        .trim()
        .split(LIST_SEPARATOR_RE)
        .filter((s) => s !== '')
        .map((s) => parseFloat(s))
        .filter((n) => !Number.isNaN(n));

/*
 * Maps CSS font-family/-weight/-style to one of PDF's 14 standard fonts —
 * there's no font-matching/embedding subsystem here (see the `<text>`
 * section), so the SVG's actual requested font is never honored, only its
 * generic family/weight/style are approximated.
 */
export const resolveStandardFont = (
    fontFamily: string,
    fontWeight: string,
    fontStyle: string,
): StandardFontName => {
    const familyLower = fontFamily.toLowerCase();
    const isMono = familyLower.includes('mono') || familyLower.includes('courier');
    const isSerif = !familyLower.includes('sans') && familyLower.includes('serif');
    const weightNum = parseFloat(fontWeight);
    const isBold =
        fontWeight.trim().toLowerCase() === 'bold' ||
        (!Number.isNaN(weightNum) && weightNum >= 600);
    const isItalic = ['italic', 'oblique'].includes(fontStyle.trim().toLowerCase());

    if (isMono) {
        if (isBold && isItalic) return 'Courier-BoldOblique';
        if (isBold) return 'Courier-Bold';
        if (isItalic) return 'Courier-Oblique';
        return 'Courier';
    }
    if (isSerif) {
        if (isBold && isItalic) return 'Times-BoldItalic';
        if (isBold) return 'Times-Bold';
        if (isItalic) return 'Times-Italic';
        return 'Times-Roman';
    }
    if (isBold && isItalic) return 'Helvetica-BoldOblique';
    if (isBold) return 'Helvetica-Bold';
    if (isItalic) return 'Helvetica-Oblique';
    return 'Helvetica';
};

// Concatenates only this element's own direct text-node children (not descendant elements' text). Whitespace is collapsed to a single space and trimmed, same as browsers do by default — unless `preserveWhitespace` (from `xml:space="preserve"`/`white-space: pre`) says not to.
export const collectDirectText = (el: Element, preserveWhitespace: boolean): string => {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) out += node.nodeValue ?? ''; // 3 = Node.TEXT_NODE (no `Node` global in a worker)
    }
    return preserveWhitespace ? out : out.replace(/\s+/g, ' ').trim();
};

// `text-transform`, applied to a run's already-collected text content (case mapping only — no locale-aware casing, same "common case" scope as the rest of this module).
export const applyTextTransform = (text: string, transform: TextTransform): string => {
    switch (transform) {
        case 'uppercase':
            return text.toUpperCase();
        case 'lowercase':
            return text.toLowerCase();
        case 'capitalize':
            return text.replace(/\b\w/g, (ch) => ch.toUpperCase());
        default:
            return text;
    }
};

// Standard-14 fonts use WinAnsi-ish encoding (~Latin-1); anything beyond that silently renders blank, so it's worth a warning.
export const hasUnencodableChar = (text: string): boolean =>
    Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) > 255);

// Resolves fill/stroke, falling back to `inherited` for anything unset on `el`.
export const resolvePaint = (el: Element, inherited: ShapePaint, ctx: PaintContext): ShapePaint => {
    const resolveColorAttr = (name: string, currentValue: Paint): Paint => {
        const raw = readPresentation(el, name, ctx.cssRules);
        if (raw === null) return currentValue;
        const trimmed = raw.trim();
        if (trimmed.startsWith('url(')) {
            const refId = URL_REF_RE.exec(trimmed)?.[1];
            const refEl = refId ? ctx.idMap.get(refId) : undefined;
            const refTag = refEl?.tagName.toLowerCase();
            if (refEl && refId && (refTag === 'lineargradient' || refTag === 'radialgradient')) {
                const def = resolveGradientDef(refEl, ctx.idMap, ctx.cssRules);
                if (!def || def.stops.length === 0) return null;
                if (def.stops.length === 1) return def.stops[0].color;
                ctx.gradients.set(refId, def);
                return { kind: 'gradient', gradientId: refId };
            }
            if (refEl && refId && refTag === 'pattern') {
                const def = ctx.resolvePattern(refEl);
                if (!def) return null;
                ctx.patterns.set(refId, def);
                return { kind: 'pattern', patternId: refId };
            }
            ctx.warnings.push(`${name}="${trimmed}" reference target not found and was skipped`);
            return null;
        }
        return parseSvgColor(trimmed);
    };

    const opacityOf = (name: string, current: number): number => {
        const raw = readPresentation(el, name, ctx.cssRules);
        if (raw === null) return current;
        const parsed = parseFloat(raw);
        return Number.isNaN(parsed) ? current : Math.min(1, Math.max(0, parsed));
    };

    const elementOpacity = opacityOf('opacity', 1);
    const strokeWidthRaw = readPresentation(el, 'stroke-width', ctx.cssRules);
    const lineCapRaw = readPresentation(el, 'stroke-linecap', ctx.cssRules);
    const lineJoinRaw = readPresentation(el, 'stroke-linejoin', ctx.cssRules);
    const miterLimitRaw = readPresentation(el, 'stroke-miterlimit', ctx.cssRules);
    const fillRuleRaw = readPresentation(el, 'fill-rule', ctx.cssRules);
    const visibilityRaw = readPresentation(el, 'visibility', ctx.cssRules);
    const dashArrayRaw = readPresentation(el, 'stroke-dasharray', ctx.cssRules);
    const dashOffsetRaw = readPresentation(el, 'stroke-dashoffset', ctx.cssRules);
    const paintOrderRaw = readPresentation(el, 'paint-order', ctx.cssRules);
    const vectorEffectRaw = readPresentation(el, 'vector-effect', ctx.cssRules);
    // `mix-blend-mode` is CSS-only, not an SVG presentation attribute — a bare `mix-blend-mode="multiply"` attribute is inert in browsers.
    const blendModeRaw = readCssOnly(el, 'mix-blend-mode', ctx.cssRules);
    const fontSizeRaw = readPresentation(el, 'font-size', ctx.cssRules);
    const fontFamilyRaw = readPresentation(el, 'font-family', ctx.cssRules);
    const fontWeightRaw = readPresentation(el, 'font-weight', ctx.cssRules);
    const fontStyleRaw = readPresentation(el, 'font-style', ctx.cssRules);
    const textAnchorRaw = readPresentation(el, 'text-anchor', ctx.cssRules);
    // `text-transform` is CSS-only, not an SVG presentation attribute — a bare `text-transform="uppercase"` attribute is inert in browsers.
    const textTransformRaw = readCssOnly(el, 'text-transform', ctx.cssRules);
    const letterSpacingRaw = readPresentation(el, 'letter-spacing', ctx.cssRules);
    const wordSpacingRaw = readPresentation(el, 'word-spacing', ctx.cssRules);
    const whiteSpaceRaw = readPresentation(el, 'white-space', ctx.cssRules);
    // `xml:space` is an XML attribute, not a CSS property — never routed through `readPresentation`/`cssRules`, only ever read straight off the element.
    const xmlSpaceRaw = el.getAttribute('xml:space');

    const fontSize =
        fontSizeRaw !== null ? parseFontSize(fontSizeRaw, inherited.fontSize) : inherited.fontSize;

    return {
        fill: resolveColorAttr('fill', inherited.fill),
        fillOpacity: opacityOf('fill-opacity', inherited.fillOpacity) * elementOpacity,
        stroke: resolveColorAttr('stroke', inherited.stroke),
        strokeOpacity: opacityOf('stroke-opacity', inherited.strokeOpacity) * elementOpacity,
        strokeWidth: strokeWidthRaw
            ? (parseFloat(strokeWidthRaw) ?? inherited.strokeWidth)
            : inherited.strokeWidth,
        lineCap: (lineCapRaw as LineCap) ?? inherited.lineCap,
        lineJoin: (lineJoinRaw as LineJoin) ?? inherited.lineJoin,
        miterLimit:
            miterLimitRaw !== null
                ? (parseFloat(miterLimitRaw) ?? inherited.miterLimit)
                : inherited.miterLimit,
        fillRule: (fillRuleRaw as FillRule) ?? inherited.fillRule,
        dashArray: dashArrayRaw !== null ? parseDashArray(dashArrayRaw) : inherited.dashArray,
        dashOffset: dashOffsetRaw !== null ? parseFloat(dashOffsetRaw) || 0 : inherited.dashOffset,
        paintOrder: parsePaintOrder(paintOrderRaw, inherited.paintOrder),
        vectorEffect:
            vectorEffectRaw !== null
                ? vectorEffectRaw.trim() === 'non-scaling-stroke'
                    ? 'non-scaling-stroke'
                    : 'none'
                : inherited.vectorEffect,
        // Not inherited, per CSS spec — each element defaults to 'Normal' unless it sets its own.
        blendMode: blendModeRaw
            ? (CSS_BLEND_MODES[blendModeRaw.trim().toLowerCase()] ?? 'Normal')
            : 'Normal',
        fontSize,
        fontFamily: fontFamilyRaw ?? inherited.fontFamily,
        fontWeight: fontWeightRaw ?? inherited.fontWeight,
        fontStyle: fontStyleRaw ?? inherited.fontStyle,
        textAnchor:
            textAnchorRaw === 'middle' || textAnchorRaw === 'end'
                ? textAnchorRaw
                : textAnchorRaw === 'start'
                  ? 'start'
                  : inherited.textAnchor,
        textTransform: (['uppercase', 'lowercase', 'capitalize', 'none'] as const).includes(
            textTransformRaw as TextTransform,
        )
            ? (textTransformRaw as TextTransform)
            : inherited.textTransform,
        letterSpacing:
            letterSpacingRaw !== null
                ? parseLengthOrEm(letterSpacingRaw, fontSize)
                : inherited.letterSpacing,
        wordSpacing:
            wordSpacingRaw !== null
                ? parseLengthOrEm(wordSpacingRaw, fontSize)
                : inherited.wordSpacing,
        preserveWhitespace:
            xmlSpaceRaw === 'preserve'
                ? true
                : xmlSpaceRaw === 'default'
                  ? false
                  : whiteSpaceRaw === 'pre'
                    ? true
                    : whiteSpaceRaw !== null
                      ? false
                      : inherited.preserveWhitespace,
        visible:
            visibilityRaw === 'hidden' || visibilityRaw === 'collapse'
                ? false
                : visibilityRaw === 'visible'
                  ? true
                  : inherited.visible,
    };
};
