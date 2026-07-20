import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import { IDENTITY_MATRIX, parseFloats } from '../geometry/matrix';
import type { GradientDef } from '../style/gradient';
import { DEFAULT_PAINT, resolvePaint } from '../style/paint';
import { parseStyleRules } from '../style/stylesheet';
import type {
    MarkerDef,
    ParsedSvgDocument,
    ParsedSvgSize,
    PatternDef,
    SvgInstruction,
} from '../types';
import {
    buildIdMap,
    resolveMarkerDef,
    resolvePatternDef,
    walkNode,
    type WalkContext,
} from './walk';

// CSS's default size for a replaced element (which an <svg> with no width/height/viewBox is treated as) when nothing else constrains it.
const FALLBACK_WIDTH = 300;
const FALLBACK_HEIGHT = 150;

// CSS unit -> points (1pt = 1/72in). Unitless/`px` is deliberately left at a 1:1 factor — not CSS-spec-accurate (real px is 1/96in), but changing it now would resize every already-correct unitless icon SVG this codec has ever handled, for a discrepancy nobody has reported.
const UNIT_TO_POINTS: Record<string, number> = {
    px: 1,
    pt: 1,
    mm: 72 / 25.4,
    cm: 72 / 2.54,
    in: 72,
    pc: 12,
};

const stripUnit = (value: string | null): number | null => {
    if (!value) return null;
    const trimmed = value.trim();
    // A percentage has no containing block to resolve against here, so treat it as absent.
    if (trimmed.endsWith('%')) return null;
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed)) return null;
    const unitMatch = /[a-z]+$/i.exec(trimmed);
    const unit = unitMatch ? unitMatch[0].toLowerCase() : 'px';
    const factor = UNIT_TO_POINTS[unit];
    // An unrecognized unit (e.g. `em`, which has no fixed physical size here) falls back to treating the number as unitless rather than dropping it entirely.
    return factor === undefined ? parsed : parsed * factor;
};

/**
 * Resolves the SVG's natural display size (in points, physical units like
 * `mm`/`cm`/`in` converted), its separate internal coordinate-system extent
 * (`viewBoxWidth`/`viewBoxHeight`), and the viewBox origin. When only one of
 * `viewBox`/`width`+`height` is present, the other is derived from it; with
 * neither, falls back to 300x150 (the browser's own default replaced-element
 * size when both are absent).
 */
export const resolveSvgSize = (root: Element): ParsedSvgSize => {
    const viewBoxAttr = root.getAttribute('viewBox');
    const viewBoxNumbers = viewBoxAttr ? parseFloats(viewBoxAttr) : null;
    const viewBox =
        viewBoxNumbers && viewBoxNumbers.length === 4
            ? {
                  minX: viewBoxNumbers[0],
                  minY: viewBoxNumbers[1],
                  width: viewBoxNumbers[2],
                  height: viewBoxNumbers[3],
              }
            : null;

    const explicitWidth = stripUnit(root.getAttribute('width'));
    const explicitHeight = stripUnit(root.getAttribute('height'));

    const width = explicitWidth ?? viewBox?.width ?? FALLBACK_WIDTH;
    const height = explicitHeight ?? viewBox?.height ?? FALLBACK_HEIGHT;

    return {
        width,
        height,
        viewBoxMinX: viewBox?.minX ?? 0,
        viewBoxMinY: viewBox?.minY ?? 0,
        viewBoxWidth: viewBox?.width ?? width,
        viewBoxHeight: viewBox?.height ?? height,
        preserveAspectRatio: root.getAttribute('preserveAspectRatio'),
    };
};

/**
 * Parses raw SVG text into a root `<svg>` element.
 *
 * Uses `@xmldom/xmldom` rather than the browser's native `DOMParser`: the
 * latter isn't reliably exposed inside a dedicated Web Worker across
 * browsers (confirmed by a runtime `DOMParser is not defined` here), while
 * xmldom is pure JS and produces the same `Element` interface (getAttribute,
 * tagName, children, textContent) the rest of this file relies on.
 */
export const parseSvgRoot = (svgText: string): Element => {
    /*
     * Non-fatal parse warnings would otherwise spam console.error; only
     * well-formedness errors (thrown as ParseError below) should stop parsing.
     */
    const parser = new XmlDomParser({ onError: () => {} });
    let doc: ReturnType<typeof parser.parseFromString>;
    try {
        doc = parser.parseFromString(svgText, 'image/svg+xml');
    } catch (error) {
        throw new Error(`Invalid SVG: ${error instanceof Error ? error.message : 'parse error'}`, {
            cause: error,
        });
    }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') {
        throw new Error('Invalid SVG: missing root <svg> element');
    }
    return root as unknown as Element;
};

// Parses SVG text into natural size + a flat instruction list ready for `svgEmbed.ts`.
export const parseSvgDocument = (svgText: string): ParsedSvgDocument => {
    const root = parseSvgRoot(svgText);
    const size = resolveSvgSize(root);
    const warnings: string[] = [];
    const instructions: SvgInstruction[] = [];
    const idMap = buildIdMap(root);
    const gradients = new Map<string, GradientDef>();
    const patterns = new Map<string, PatternDef>();
    const markers = new Map<string, MarkerDef>();
    const cssRules = parseStyleRules(root, warnings);

    /*
     * Icon libraries commonly set fill/stroke on the <svg> root itself, not per-shape.
     * `resolvePattern`/`resolveMarker` close over `rootCtx` itself (assigned below) —
     * safe since they're only ever called later, during the walk, never during this construction.
     */
    const rootCtx: WalkContext = {
        idMap,
        warnings,
        instructions,
        visitedUseIds: new Set(),
        gradients,
        patterns,
        markers,
        cssRules,
        resolvePattern: (el: Element) => resolvePatternDef(el, rootCtx),
        resolveMarker: (el: Element) => resolveMarkerDef(el, rootCtx),
    };
    const rootPaint = resolvePaint(root, DEFAULT_PAINT, rootCtx);
    for (const child of Array.from(root.children)) {
        walkNode(child, rootPaint, rootCtx, IDENTITY_MATRIX);
    }

    return { ...size, instructions, warnings, gradients, patterns, markers };
};
