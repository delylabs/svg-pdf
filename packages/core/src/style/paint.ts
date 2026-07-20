import type {
    BlendMode,
    FillRule,
    LineCap,
    LineJoin,
    Paint,
    PatternDef,
    ShapePaint,
    StandardFontName,
} from '../types';
import { parseFloats } from '../geometry/matrix';
import { CSS_NAMED_COLORS, parseSvgColor } from './color';
import { resolveGradientDef, type GradientDef } from './gradient';
import { URL_REF_RE } from './refs';
import { type CssRule, readPresentation } from './stylesheet';

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

export const DEFAULT_PAINT: ShapePaint = {
    fill: CSS_NAMED_COLORS.black,
    fillOpacity: 1,
    stroke: null,
    strokeOpacity: 1,
    strokeWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    fillRule: 'nonzero',
    dashArray: null,
    dashOffset: 0,
    blendMode: 'Normal',
    fontSize: 16,
    fontFamily: '',
    fontWeight: 'normal',
    fontStyle: 'normal',
    textAnchor: 'start',
};

/*
 * Narrow view of the tree-walking context that paint/attribute resolution
 * actually needs — kept separate from `parse/walk.ts`'s full `WalkContext`
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

// Concatenates only this element's own direct text-node children (not descendant elements' text).
export const collectDirectText = (el: Element): string => {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) out += node.nodeValue ?? ''; // 3 = Node.TEXT_NODE (no `Node` global in a worker)
    }
    return out.replace(/\s+/g, ' ').trim();
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
                const def = resolveGradientDef(refEl, ctx.idMap);
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
    const fillRuleRaw = readPresentation(el, 'fill-rule', ctx.cssRules);
    const dashArrayRaw = readPresentation(el, 'stroke-dasharray', ctx.cssRules);
    const dashOffsetRaw = readPresentation(el, 'stroke-dashoffset', ctx.cssRules);
    const blendModeRaw = readPresentation(el, 'mix-blend-mode', ctx.cssRules);
    const fontSizeRaw = readPresentation(el, 'font-size', ctx.cssRules);
    const fontFamilyRaw = readPresentation(el, 'font-family', ctx.cssRules);
    const fontWeightRaw = readPresentation(el, 'font-weight', ctx.cssRules);
    const fontStyleRaw = readPresentation(el, 'font-style', ctx.cssRules);
    const textAnchorRaw = readPresentation(el, 'text-anchor', ctx.cssRules);

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
        fillRule: (fillRuleRaw as FillRule) ?? inherited.fillRule,
        dashArray: dashArrayRaw !== null ? parseDashArray(dashArrayRaw) : inherited.dashArray,
        dashOffset: dashOffsetRaw !== null ? parseFloat(dashOffsetRaw) || 0 : inherited.dashOffset,
        // Not inherited, per CSS spec — each element defaults to 'Normal' unless it sets its own.
        blendMode: blendModeRaw
            ? (CSS_BLEND_MODES[blendModeRaw.trim().toLowerCase()] ?? 'Normal')
            : 'Normal',
        fontSize:
            fontSizeRaw !== null
                ? parseFontSize(fontSizeRaw, inherited.fontSize)
                : inherited.fontSize,
        fontFamily: fontFamilyRaw ?? inherited.fontFamily,
        fontWeight: fontWeightRaw ?? inherited.fontWeight,
        fontStyle: fontStyleRaw ?? inherited.fontStyle,
        textAnchor:
            textAnchorRaw === 'middle' || textAnchorRaw === 'end'
                ? textAnchorRaw
                : textAnchorRaw === 'start'
                  ? 'start'
                  : inherited.textAnchor,
    };
};
