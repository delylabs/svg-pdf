import * as fs from 'fs';
import * as path from 'path';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import {
    circleToPathData,
    IDENTITY_MATRIX,
    type ImageInstruction,
    type Matrix2D,
    multiplyMatrix,
    parseSvgColor,
    parseSvgDocument,
    parseTransformList,
    polygonToPathData,
    rectToPathData,
    resolveSvgSize,
    type ShapeInstruction,
    type TextInstruction,
} from '..';

const el = (svg: string): Element => {
    const doc = new XmlDomParser({ onError: () => {} }).parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement as unknown as Element;
    // xmldom doesn't implement `firstElementChild` (ElementTraversal) — filter childNodes for an actual element (nodeType 1) instead.
    return Array.from(root.childNodes).find((n): n is Element => n.nodeType === 1)!;
};

const applyMatrix = (m: Matrix2D, x: number, y: number) => ({
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
});

describe('multiplyMatrix', () => {
    it('is the identity when combined with the identity matrix', () => {
        const m: Matrix2D = { a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 };
        expect(multiplyMatrix(m, IDENTITY_MATRIX)).toEqual(m);
        expect(multiplyMatrix(IDENTITY_MATRIX, m)).toEqual(m);
    });
});

describe('parseTransformList', () => {
    it('returns identity for null/empty input', () => {
        expect(parseTransformList(null)).toEqual(IDENTITY_MATRIX);
        expect(parseTransformList('')).toEqual(IDENTITY_MATRIX);
    });

    it('parses a single translate', () => {
        const m = parseTransformList('translate(10,20)');
        expect(applyMatrix(m, 0, 0)).toEqual({ x: 10, y: 20 });
    });

    it('parses a single scale (uniform when only one arg given)', () => {
        const m = parseTransformList('scale(2)');
        expect(applyMatrix(m, 3, 4)).toEqual({ x: 6, y: 8 });
    });

    it('parses rotate(90) as a quarter turn', () => {
        const m = parseTransformList('rotate(90)');
        const p = applyMatrix(m, 1, 0);
        expect(p.x).toBeCloseTo(0);
        expect(p.y).toBeCloseTo(1);
    });

    it('applies the rightmost/innermost function first: "translate(10,0) scale(2)"', () => {
        // Nests like <g translate(10,0)><g scale(2)>point</g></g> — scale applies first.
        const m = parseTransformList('translate(10,0) scale(2)');
        expect(applyMatrix(m, 1, 0)).toEqual({ x: 12, y: 0 });
    });

    it('parses an explicit matrix() the same as the raw SVG attribute values', () => {
        const m = parseTransformList('matrix(1,0,0,1,10,20)');
        expect(applyMatrix(m, 0, 0)).toEqual({ x: 10, y: 20 });
    });
});

describe('resolveSvgSize', () => {
    it('uses viewBox when width/height are absent', () => {
        const root = el('<svg viewBox="0 0 200 100"><rect/></svg>').parentElement!;
        const size = resolveSvgSize(root);
        expect(size).toEqual({
            width: 200,
            height: 100,
            viewBoxMinX: 0,
            viewBoxMinY: 0,
            viewBoxWidth: 200,
            viewBoxHeight: 100,
        });
    });

    it('uses width/height when viewBox is absent', () => {
        const root = el('<svg width="50" height="60"><rect/></svg>').parentElement!;
        expect(resolveSvgSize(root)).toEqual({
            width: 50,
            height: 60,
            viewBoxMinX: 0,
            viewBoxMinY: 0,
            viewBoxWidth: 50,
            viewBoxHeight: 60,
        });
    });

    it('preserves a non-zero viewBox origin', () => {
        const root = el('<svg viewBox="10 10 100 100"><rect/></svg>').parentElement!;
        expect(resolveSvgSize(root)).toEqual({
            width: 100,
            height: 100,
            viewBoxMinX: 10,
            viewBoxMinY: 10,
            viewBoxWidth: 100,
            viewBoxHeight: 100,
        });
    });

    it('falls back to a 100x100 default when neither is present', () => {
        const root = el('<svg><rect/></svg>').parentElement!;
        expect(resolveSvgSize(root)).toEqual({
            width: 100,
            height: 100,
            viewBoxMinX: 0,
            viewBoxMinY: 0,
            viewBoxWidth: 100,
            viewBoxHeight: 100,
        });
    });

    it('keeps width/height in the same "user unit = point" space as viewBoxWidth/Height when both are unitless', () => {
        const root = el(
            '<svg width="24" height="24" viewBox="0 0 24 24"><rect/></svg>',
        ).parentElement!;
        expect(resolveSvgSize(root)).toEqual({
            width: 24,
            height: 24,
            viewBoxMinX: 0,
            viewBoxMinY: 0,
            viewBoxWidth: 24,
            viewBoxHeight: 24,
        });
    });

    it('converts physical units (mm) to points for width/height, while viewBoxWidth/Height keep the raw internal coordinate extent', () => {
        // A real-world case (LibreOffice Draw export): 297mm x 210mm (A4 landscape) with a 1/100mm internal coordinate system.
        const root = el(
            '<svg width="297mm" height="210mm" viewBox="0 0 29700 21000"><rect/></svg>',
        ).parentElement!;
        const size = resolveSvgSize(root);
        expect(size.width).toBeCloseTo(841.89, 1);
        expect(size.height).toBeCloseTo(595.28, 1);
        expect(size.viewBoxWidth).toBe(29700);
        expect(size.viewBoxHeight).toBe(21000);
    });

    it('converts cm/in/pt/pc units to points', () => {
        expect(
            resolveSvgSize(el('<svg width="1cm" height="1cm"><rect/></svg>').parentElement!).width,
        ).toBeCloseTo(28.35, 1);
        expect(
            resolveSvgSize(el('<svg width="1in" height="1in"><rect/></svg>').parentElement!).width,
        ).toBeCloseTo(72, 1);
        expect(
            resolveSvgSize(el('<svg width="12pt" height="12pt"><rect/></svg>').parentElement!)
                .width,
        ).toBeCloseTo(12, 1);
        expect(
            resolveSvgSize(el('<svg width="1pc" height="1pc"><rect/></svg>').parentElement!).width,
        ).toBeCloseTo(12, 1);
    });
});

describe('shape → path conversion', () => {
    it('converts a plain rect to a closed 4-line path', () => {
        const d = rectToPathData(el('<svg><rect x="10" y="20" width="30" height="40"/></svg>'));
        expect(d).toBe('M 10 20 H 40 V 60 H 10 Z');
    });

    it('converts a circle to a 4-arc closed path starting at the rightmost point (matching browser convention)', () => {
        const d = circleToPathData(el('<svg><circle cx="0" cy="0" r="10"/></svg>'));
        expect(d.startsWith('M 10 0')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
    });

    it('converts a polygon to a closed path', () => {
        const d = polygonToPathData(el('<svg><polygon points="0,0 10,0 5,10"/></svg>'));
        expect(d).toBe('M 0 0 L 10 0 L 5 10 Z');
    });
});

describe('parseSvgColor', () => {
    it('parses 3 and 6-digit hex', () => {
        expect(parseSvgColor('#f00')).toEqual({ r: 255, g: 0, b: 0 });
        expect(parseSvgColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('parses rgb()', () => {
        expect(parseSvgColor('rgb(10, 20, 30)')).toEqual({
            r: 10,
            g: 20,
            b: 30,
        });
    });

    it('parses named CSS colors', () => {
        expect(parseSvgColor('cornflowerblue')).toEqual({
            r: 100,
            g: 149,
            b: 237,
        });
    });

    it('treats none/transparent as no paint', () => {
        expect(parseSvgColor('none')).toBeNull();
        expect(parseSvgColor('transparent')).toBeNull();
        expect(parseSvgColor(null)).toBeNull();
    });
});

const shapesOf = (doc: ReturnType<typeof parseSvgDocument>): ShapeInstruction[] =>
    doc.instructions.filter((i): i is ShapeInstruction => i.type === 'shape');

const textsOf = (doc: ReturnType<typeof parseSvgDocument>): TextInstruction[] =>
    doc.instructions.filter((i): i is TextInstruction => i.type === 'text');

const imagesOf = (doc: ReturnType<typeof parseSvgDocument>): ImageInstruction[] =>
    doc.instructions.filter((i): i is ImageInstruction => i.type === 'image');

// A real, minimal 1x1 transparent PNG — deterministic for aspect-ratio math in svgEmbed tests too.
const ONE_PIXEL_PNG_DATA_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('parseSvgDocument', () => {
    it('parses a simple single-path icon with a solid fill', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 24 24"><path d="M0 0 L24 24" fill="#ff0000"/></svg>',
        );
        expect(doc.warnings).toEqual([]);
        const shapes = shapesOf(doc);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(shapes[0].d).toBe('M0 0 L24 24');
    });

    it('emits push/pop matrix instructions around a transformed group', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g transform="translate(10,10)"><rect x="0" y="0" width="5" height="5"/></g></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushMatrix', 'shape', 'popMatrix']);
    });

    it('does not push a matrix for an identity transform', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g transform="translate(0,0)"><rect width="5" height="5"/></g></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
    });

    it('inherits fill from an ancestor <g> when a shape does not set its own', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g fill="#00ff00"><rect width="5" height="5"/></g></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('never fills a <line> even when a fill is inherited (zero-area element, per spec)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g fill="#00ff00"><line x1="0" y1="0" x2="10" y2="10" stroke="#000"/></g></svg>',
        );
        expect(shapesOf(doc)[0].fill).toBeNull();
    });

    it('parses stroke-dasharray/stroke-dashoffset', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-dasharray="5,3" stroke-dashoffset="2"/></svg>',
        );
        expect(shapesOf(doc)[0].dashArray).toEqual([5, 3]);
        expect(shapesOf(doc)[0].dashOffset).toBe(2);
    });

    it('repeats an odd-length dasharray once, per spec', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-dasharray="5,3,2"/></svg>',
        );
        expect(shapesOf(doc)[0].dashArray).toEqual([5, 3, 2, 5, 3, 2]);
    });

    it('treats stroke-dasharray="none" and an all-zero list as a solid stroke', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-dasharray="none"/><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-dasharray="0,0"/></svg>',
        );
        expect(shapesOf(doc)[0].dashArray).toBeNull();
        expect(shapesOf(doc)[1].dashArray).toBeNull();
    });

    it("draws a <symbol>'s children through <use> instead of skipping it as a non-rendered container", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="star" viewBox="0 0 20 20"><polygon points="10,1 19,19 1,19" fill="gold"/></symbol></defs><use href="#star" x="10" y="20" width="30" height="30"/></svg>',
        );
        expect(doc.warnings).toEqual([]);
        expect(shapesOf(doc)).toHaveLength(1);
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 215, b: 0 });
    });

    it("scales a <symbol>'s viewBox to the <use> width/height, per spec", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="20" height="20"/></svg>',
        );
        expect(
            doc.instructions.some(
                (i) => i.type === 'pushMatrix' && i.matrix.a === 2 && i.matrix.d === 2,
            ),
        ).toBe(true);
    });

    it('resolves a simple non-recursive <use> reference', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><rect id="box" width="5" height="5" fill="#0000ff"/></defs><use href="#box" x="10" y="20"/></svg>',
        );
        const shapes = shapesOf(doc);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].fill).toEqual({ r: 0, g: 0, b: 255 });
        expect(doc.warnings).toEqual([]);
    });

    it('skips a self-referencing <use> cycle with a warning instead of infinite-looping', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g id="loop"><use href="#loop"/></g></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('cycle'))).toBe(true);
    });

    it('skips unsupported elements with a warning but keeps supported siblings', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><foreignObject width="5" height="5"><p>x</p></foreignObject><rect width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)).toHaveLength(1);
        expect(doc.warnings.some((w) => w.includes('foreignobject'))).toBe(true);
    });

    it('throws a clear error for malformed SVG instead of crashing silently', () => {
        expect(() => parseSvgDocument('<svg><rect></svg>')).toThrow(/Invalid SVG/);
    });

    it('throws for a document without a root <svg>', () => {
        expect(() => parseSvgDocument('<not-svg></not-svg>')).toThrow(/Invalid SVG/);
    });
});

describe('parseSvgDocument (mix-blend-mode)', () => {
    it('parses mix-blend-mode from an inline style attribute', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="5" fill="#f00" style="mix-blend-mode: multiply;"/></svg>',
        );
        expect(shapesOf(doc)[0].blendMode).toBe('Multiply');
    });

    it('maps hyphenated CSS blend mode names to PDF PascalCase', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="5" fill="#f00" style="mix-blend-mode: color-dodge;"/></svg>',
        );
        expect(shapesOf(doc)[0].blendMode).toBe('ColorDodge');
    });

    it('defaults to Normal and does not inherit from an ancestor (mix-blend-mode is non-inherited, per spec)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g style="mix-blend-mode: multiply;"><circle cx="5" cy="5" r="5" fill="#f00"/></g></svg>',
        );
        expect(shapesOf(doc)[0].blendMode).toBe('Normal');
    });

    it('falls back to Normal for an unrecognized blend mode value', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><circle cx="5" cy="5" r="5" fill="#f00" style="mix-blend-mode: not-a-real-mode;"/></svg>',
        );
        expect(shapesOf(doc)[0].blendMode).toBe('Normal');
    });
});

describe('parseSvgDocument (gradients)', () => {
    it('resolves a linear gradient fill with default (objectBoundingBox) units', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(doc.warnings).toEqual([]);
        const shape = shapesOf(doc)[0];
        expect(shape.fill).toEqual({ kind: 'gradient', gradientId: 'g' });
        expect(shape.bbox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
        const def = doc.gradients.get('g');
        expect(def?.type).toBe('linear');
        expect(def?.gradientUnits).toBe('objectBoundingBox');
        // Default x1/y1/x2/y2 per spec: 0%,0%,100%,0%.
        expect(def?.coords).toEqual([0, 0, 1, 0]);
        expect(def?.stops).toEqual([
            { offset: 0, color: { r: 255, g: 0, b: 0 }, opacity: 1 },
            { offset: 1, color: { r: 0, g: 0, b: 255 }, opacity: 1 },
        ]);
    });

    it('resolves a radial gradient with explicit coords and userSpaceOnUse units', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40" fx="30" fy="30"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><circle cx="50" cy="50" r="40" fill="url(#g)"/></svg>',
        );
        const def = doc.gradients.get('g');
        expect(def?.type).toBe('radial');
        expect(def?.gradientUnits).toBe('userSpaceOnUse');
        expect(def?.coords).toEqual([30, 30, 0, 50, 50, 40]);
        // userSpaceOnUse doesn't need the shape's bbox.
        expect(shapesOf(doc)[0].bbox).toBeNull();
    });

    it('inherits stops/coords from another gradient via href', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs>' +
                '<linearGradient id="base" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
                '<linearGradient id="derived" href="#base" x1="0" y1="1" x2="1" y2="1"/>' +
                '</defs><rect width="10" height="10" fill="url(#derived)"/></svg>',
        );
        const def = doc.gradients.get('derived');
        expect(def?.coords).toEqual([0, 1, 1, 1]);
        expect(def?.stops).toHaveLength(2);
    });

    it("resolves a single-stop gradient directly to that stop's solid color", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
        expect(doc.gradients.size).toBe(0);
    });

    it('treats a 0-stop gradient as no paint, per spec', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toBeNull();
    });

    it('warns and falls back to no paint for an unresolvable url() reference', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" fill="url(#missing)"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toBeNull();
        expect(doc.warnings.some((w) => w.includes('reference target not found'))).toBe(true);
    });
});

describe('parseSvgDocument (patterns)', () => {
    it('resolves a <pattern> reference and walks its content', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="5" fill="red"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
        );
        const fill = shapesOf(doc)[0].fill;
        expect(fill).toEqual({ kind: 'pattern', patternId: 'p' });
        const def = doc.patterns.get('p');
        expect(def).toBeDefined();
        expect(def?.patternUnits).toBe('userSpaceOnUse');
        expect(def?.width).toBe(10);
        expect(def?.instructions.some((i) => i.type === 'shape')).toBe(true);
    });

    it('defaults patternUnits to objectBoundingBox and patternContentUnits to userSpaceOnUse', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="0.1" height="0.1"><rect width="5" height="5"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
        );
        const def = doc.patterns.get('p');
        expect(def?.patternUnits).toBe('objectBoundingBox');
        expect(def?.patternContentUnits).toBe('userSpaceOnUse');
        expect(def?.width).toBe(0.1);
    });

    it('inherits attributes and content from another <pattern> via href', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><pattern id="base" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="blue"/></pattern><pattern id="p" href="#base" patternTransform="translate(2,3)"/></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
        );
        const def = doc.patterns.get('p');
        expect(def?.width).toBe(10);
        expect(def?.patternTransform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 2, f: 3 });
        expect(def?.instructions.some((i) => i.type === 'shape')).toBe(true);
    });

    it('treats a 0-size pattern as no paint, per spec', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="0" height="0"/></defs><rect width="10" height="10" fill="url(#p)"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toBeNull();
        expect(doc.patterns.size).toBe(0);
    });

    it('warns and skips a pattern that fills itself (a reference cycle)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10"><rect width="10" height="10" fill="url(#p)"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('forms a cycle'))).toBe(true);
        const def = doc.patterns.get('p');
        const innerShape = def?.instructions.find((i) => i.type === 'shape');
        expect(innerShape && 'fill' in innerShape ? innerShape.fill : undefined).toBeNull();
    });
});

const markersOf = (doc: ReturnType<typeof parseSvgDocument>) =>
    doc.instructions.filter((i) => i.type === 'marker');

describe('parseSvgDocument (markers)', () => {
    it('emits a marker instruction per vertex for marker-start/-mid/-end', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><path d="M0,0 L50,0 L50,50" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/></svg>',
        );
        const markers = markersOf(doc);
        expect(markers).toHaveLength(3);
        expect(markers.every((m) => m.markerId === 'm')).toBe(true);
        expect(doc.markers.get('m')).toBeDefined();
    });

    it('supports the `marker` shorthand for all three positions', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker="url(#m)"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(2);
    });

    it('lets an explicit marker-mid="none" override the `marker` shorthand for just that position', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><path d="M0,0 L10,0 L20,0" marker="url(#m)" marker-mid="none"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(2);
        expect(markersOf(doc).every((m) => m.markerId === 'm')).toBe(true);
    });

    it('does not emit markers for a <rect>/<circle>/<ellipse> (not marker-eligible per spec)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><rect width="10" height="10" marker-start="url(#m)"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(0);
    });

    it('warns and skips a marker reference that does not resolve to a <marker>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#missing)"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('marker reference'))).toBe(true);
    });

    it('resolves markerUnits to scale strokeWidth by default, or 1 for userSpaceOnUse', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="a" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker><marker id="b" markerWidth="4" markerHeight="4" markerUnits="userSpaceOnUse"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" stroke-width="3" marker-start="url(#a)" marker-end="url(#b)"/></svg>',
        );
        const markers = markersOf(doc);
        const start = markers.find((m) => m.type === 'marker' && m.markerId === 'a');
        const end = markers.find((m) => m.type === 'marker' && m.markerId === 'b');
        expect(start && 'scale' in start ? start.scale : undefined).toBe(3);
        expect(end && 'scale' in end ? end.scale : undefined).toBe(1);
    });

    it('inherits attributes and content from another <marker> via href', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="base" markerWidth="5" markerHeight="5" orient="auto"><circle cx="2" cy="2" r="2"/></marker><marker id="m" href="#base" refX="1" refY="1"/></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
        );
        const def = doc.markers.get('m');
        expect(def?.markerWidth).toBe(5);
        expect(def?.refX).toBe(1);
        expect(def?.orient).toBe('auto');
        expect(def?.instructions.some((i) => i.type === 'shape')).toBe(true);
    });

    it('warns and skips a marker that references itself (a reference cycle)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><line x1="0" y1="0" x2="1" y2="1" marker-start="url(#m)"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('forms a cycle'))).toBe(true);
    });
});

describe('parseSvgDocument (clip-path)', () => {
    it('emits pushClip/popClip around a clipped shape (userSpaceOnUse, the clipPathUnits default)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushClip', 'shape', 'popClip']);
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.bboxMatrix).toBeNull();
        expect(pushClip.paths).toHaveLength(1);
    });

    it('computes a bboxMatrix for clipPathUnits="objectBoundingBox"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1"/></clipPath></defs><rect x="10" y="20" width="30" height="40" clip-path="url(#c)"/></svg>',
        );
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.bboxMatrix).toEqual({
            a: 30,
            b: 0,
            c: 0,
            d: 40,
            e: 10,
            f: 20,
        });
    });

    it('skips a clip-path child that has its own transform, with a warning', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="0" cy="0" r="20" transform="translate(50,50)"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        // No usable clip child survived, so clipping is skipped entirely (fail-safe: draw unclipped).
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
        expect(doc.warnings.some((w) => w.includes('own transform'))).toBe(true);
    });

    it('warns and skips when clip-path target is missing', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" clip-path="url(#missing)"/></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
        expect(doc.warnings.some((w) => w.includes('not found'))).toBe(true);
    });
});

describe('parseSvgDocument (text)', () => {
    it('parses a simple <text> with position, size, and fill', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20" font-size="14" fill="#ff0000">Hello</text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({
            text: 'Hello',
            x: 10,
            y: 20,
            fontSize: 14,
            fill: { r: 255, g: 0, b: 0 },
            font: 'Helvetica',
        });
    });

    it('maps generic font-family/weight/style to one of the standard-14 fonts', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text font-family="Georgia, serif" font-weight="bold" font-style="italic">A</text></svg>',
        );
        expect(textsOf(doc)[0].font).toBe('Times-BoldItalic');
    });

    it('resolves a <tspan> without its own x/y relative to the parent, and dy/dx offsets', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10">A<tspan dy="12">B</tspan></text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts).toHaveLength(2);
        expect(texts[0]).toMatchObject({ text: 'A', x: 5, y: 10 });
        expect(texts[1]).toMatchObject({ text: 'B', x: 5, y: 22 });
    });

    it('marks a sole/first tspan (even without its own x) as not continuing a flow', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10"><tspan>Hello</tspan></text></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({ continuesFlow: false });
    });

    it("marks a non-first sibling tspan without its own x as continuing the previous run's text flow (the LibreOffice/OpenOffice per-word-tspan pattern)", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10"><tspan>Hello</tspan><tspan>World</tspan></text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts).toHaveLength(2);
        expect(texts[0]).toMatchObject({ text: 'Hello', continuesFlow: false });
        expect(texts[1]).toMatchObject({ text: 'World', continuesFlow: true });
    });

    it('does not mark a tspan with its own x as continuing, even when it is not the first sibling', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10"><tspan>Hello</tspan><tspan x="50">World</tspan></text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts[1]).toMatchObject({
            text: 'World',
            continuesFlow: false,
            x: 50,
        });
    });

    it('resets the flow for the first child of a fresh absolutely-positioned tspan, even without its own x', () => {
        /*
         * Mirrors the real bug: a <text> with two separate lines, each an
         * absolutely-positioned <tspan> wrapping further no-x runs — the
         * second line's first run must NOT continue from the first line's
         * last run just because it also lacks an `x`.
         */
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text><tspan x="5" y="10"><tspan>Line1</tspan></tspan><tspan x="5" y="30"><tspan>Line2</tspan></tspan></text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts).toHaveLength(2);
        expect(texts[0]).toMatchObject({
            text: 'Line1',
            x: 5,
            continuesFlow: false,
        });
        expect(texts[1]).toMatchObject({
            text: 'Line2',
            x: 5,
            continuesFlow: false,
        });
    });

    it('inherits fill/font-size from an ancestor <g>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g fill="#0000ff" font-size="20"><text x="0" y="0">Blue</text></g></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({
            fill: { r: 0, g: 0, b: 255 },
            fontSize: 20,
        });
    });

    it('records text-anchor for svgEmbed.ts to resolve at draw time', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text text-anchor="middle">C</text></svg>',
        );
        expect(textsOf(doc)[0].textAnchor).toBe('middle');
    });

    it('warns and falls back to solid black when fill is a gradient', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><text fill="url(#g)">D</text></svg>',
        );
        expect(textsOf(doc)[0].fill).toEqual({ r: 0, g: 0, b: 0 });
        expect(doc.warnings.some((w) => w.includes('gradient/pattern fill'))).toBe(true);
    });

    it('skips <textPath> with a warning', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p">Curved</textPath></text></svg>',
        );
        expect(textsOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('textPath'))).toBe(true);
    });

    it('warns when text contains characters outside Latin/Latin-1', () => {
        const doc = parseSvgDocument('<svg viewBox="0 0 100 100"><text>你好</text></svg>');
        expect(doc.warnings.some((w) => w.includes('outside the basic Latin'))).toBe(true);
    });

    it('skips drawing (without a crash) when fill is none', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text fill="none">Invisible</text></svg>',
        );
        expect(textsOf(doc)).toHaveLength(0);
    });

    it('warns when text has a stroke (still drawn, just without one)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text stroke="#000000">Outlined</text></svg>',
        );
        expect(textsOf(doc)).toHaveLength(1);
        expect(doc.warnings.some((w) => w.startsWith('stroke on <text>'))).toBe(true);
    });

    it('does not warn about stroke when text has none', () => {
        const doc = parseSvgDocument('<svg viewBox="0 0 100 100"><text>Plain</text></svg>');
        expect(doc.warnings.some((w) => w.startsWith('stroke on <text>'))).toBe(false);
    });
});

describe('parseSvgDocument (<style> class/id/tag rules)', () => {
    it('applies a class selector', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.big { fill: #ff0000; }</style><rect class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('applies a tag selector and an id selector, with id winning over class over tag', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>rect { fill: #111111; } .mid { fill: #222222; } #top { fill: #333333; }</style><rect id="top" class="mid" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 51, g: 51, b: 51 });
    });

    it('supports a comma-separated selector list sharing one rule', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.a, .b { fill: #00ff00; }</style><rect class="b" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('lets an inline style="" attribute override a class rule (highest priority, per spec)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.big { fill: #ff0000; }</style><rect class="big" style="fill:#0000ff" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('a class rule outranks a plain presentation attribute (per spec, only inline style="" beats a stylesheet rule)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.big { fill: #ff0000; }</style><rect class="big" fill="#0000ff" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('strips @-rules (e.g. @keyframes) instead of misparsing their nested braces', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.big { fill: #ff0000; } @keyframes spin { 100% { transform: rotate(360deg); } }</style><rect class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(doc.warnings).toEqual([]);
    });

    it('warns and skips an unsupported selector (combinator) without affecting other rules', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>g .big { fill: #ff0000; } .ok { fill: #00ff00; }</style><rect class="ok" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
        expect(doc.warnings.some((w) => w.includes('<style> selector'))).toBe(true);
    });
});

describe('parseSvgDocument (image)', () => {
    it('parses an inline data: URI <image> with position/size', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40"/></svg>`,
        );
        const images = imagesOf(doc);
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({
            href: ONE_PIXEL_PNG_DATA_URI,
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            preserveAspectRatio: 'meet',
            opacity: 1,
        });
    });

    it('reads xlink:href as a fallback', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></svg>`,
        );
        expect(imagesOf(doc)).toHaveLength(1);
    });

    it("passes an external URL href through unchanged (fetching it is an adapter/caller concern, not this layer's)", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
        );
        expect(imagesOf(doc)).toHaveLength(1);
        expect(imagesOf(doc)[0]).toMatchObject({ href: 'https://example.com/a.png' });
        expect(doc.warnings).toEqual([]);
    });

    it('warns and skips when href is missing', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><image width="10" height="10"/></svg>',
        );
        expect(imagesOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('without a href'))).toBe(true);
    });

    it('skips silently (no instruction, no warning) when width or height is zero', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="0" height="10"/></svg>`,
        );
        expect(imagesOf(doc)).toHaveLength(0);
        expect(doc.warnings).toEqual([]);
    });

    it('parses preserveAspectRatio="none" as the stretch mode', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" preserveAspectRatio="none"/></svg>`,
        );
        expect(imagesOf(doc)[0].preserveAspectRatio).toBe('none');
    });

    it('falls back to "meet" with a warning for a "slice" preserveAspectRatio', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" preserveAspectRatio="xMidYMid slice"/></svg>`,
        );
        expect(imagesOf(doc)[0].preserveAspectRatio).toBe('meet');
        expect(doc.warnings.some((w) => w.includes('"slice"'))).toBe(true);
    });

    it('carries opacity through from the presentation attribute', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10" opacity="0.4"/></svg>`,
        );
        expect(imagesOf(doc)[0].opacity).toBeCloseTo(0.4);
    });

    it('wraps a transformed <image> in a pushMatrix/popMatrix bracket', () => {
        const doc = parseSvgDocument(
            `<svg viewBox="0 0 100 100"><g transform="translate(5,5)"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></g></svg>`,
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushMatrix', 'image', 'popMatrix']);
    });
});

const FIXTURES_DIR = path.resolve(process.cwd(), 'test-fixtures/custom');
const hasFixtures = fs.existsSync(FIXTURES_DIR);

const loadFixture = (name: string): string =>
    fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');

describe.skipIf(!hasFixtures)('parseSvgDocument (real-world-shaped fixtures)', () => {
    it('parses a minimal single-shape line icon with no warnings', () => {
        const doc = parseSvgDocument(loadFixture('icon-line-simple.svg'));
        expect(doc.warnings).toEqual([]);
        expect(shapesOf(doc)).toHaveLength(1);
        expect(shapesOf(doc)[0].stroke).not.toBeNull();
    });

    it('parses a flag-shaped SVG, inheriting fill through <g> across many paths', () => {
        const doc = parseSvgDocument(loadFixture('star-ring.svg'));
        expect(doc.warnings).toEqual([]);
        const shapes = shapesOf(doc);
        expect(shapes.length).toBeGreaterThan(30);
        expect(shapes.every((s) => s.fill !== null)).toBe(true);
    });

    it('parses a stress-test mandala (220+ grouped paths, a real matrix() transform) without warnings', () => {
        const doc = parseSvgDocument(loadFixture('stress-mandala.svg'));
        expect(doc.warnings).toEqual([]);
        expect(shapesOf(doc).length).toBeGreaterThan(200);
        expect(doc.instructions.some((i) => i.type === 'pushMatrix')).toBe(true);
    });

    it('degrades gracefully on a kitchen-sink SVG combining every v1.1+ feature at once', () => {
        const doc = parseSvgDocument(loadFixture('kitchen-sink.svg'));
        expect(doc.width).toBe(800);
        expect(doc.height).toBe(600);
        expect(shapesOf(doc).length).toBeGreaterThan(0);
        expect(doc.warnings.some((w) => w.startsWith('filter='))).toBe(true);
        // Gradients/patterns/clip-path/<text>/<style> class rules here are now supported; only <textPath> still warns.
        expect(doc.warnings.some((w) => w.includes('gradient reference'))).toBe(false);
        expect(doc.warnings.some((w) => w.startsWith('clip-path='))).toBe(false);
        expect(doc.warnings.some((w) => w.includes('pattern reference'))).toBe(false);
        expect(doc.warnings.some((w) => w.includes('textPath'))).toBe(true);
        // @keyframes is an at-rule (stripped entirely, not a selector) — shouldn't produce an "unsupported selector" warning.
        expect(doc.warnings.some((w) => w.includes('<style> selector'))).toBe(false);
        const titleText = textsOf(doc).find((t) => t.text.startsWith('SVG Integrated'));
        expect(titleText).toMatchObject({
            fontSize: 18,
            font: 'Helvetica-Bold',
        });
        const sectionHeader = textsOf(doc).find((t) => t.text.startsWith('1. Shapes'));
        expect(sectionHeader).toMatchObject({
            fontSize: 14,
            fill: { r: 51, g: 51, b: 51 },
        });
        expect(doc.gradients.size).toBeGreaterThan(0);
        expect(doc.patterns.size).toBeGreaterThan(0);
        expect(doc.instructions.some((i) => i.type === 'pushClip')).toBe(true);
        expect(doc.instructions.some((i) => i.type === 'text')).toBe(true);
    });
});
