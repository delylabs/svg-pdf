import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { shapesOf } from './helpers';

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

    it('applies a <style> rule to a gradient <stop>, not just its own stop-color attribute', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>stop:first-child { stop-color: #123456; }</style><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        const def = doc.gradients.get('g');
        expect(def?.stops).toEqual([
            { offset: 0, color: { r: 0x12, g: 0x34, b: 0x56 }, opacity: 1 },
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

    it("clamps an out-of-order stop offset up to the previous stop's offset instead of leaving it non-monotonic", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0.5" stop-color="#ff0000"/><stop offset="0.2" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        const def = doc.gradients.get('g');
        expect(def?.stops.map((s) => s.offset)).toEqual([0.5, 0.5, 1]);
    });

    it('warns when spreadMethod is "reflect" or "repeat" (drawn as the default "pad" instead)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g" spreadMethod="reflect"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('spreadMethod="reflect"'))).toBe(true);
    });

    it('does not warn for the default spreadMethod="pad" (or when absent)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g" spreadMethod="pad"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(doc.warnings).toEqual([]);
    });

    it('warns when any stop has stop-opacity less than 1 (drawn fully opaque instead)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="0"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('stop-opacity'))).toBe(true);
    });

    it('does not warn when every stop-opacity is 1 (or unset)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff" stop-opacity="1"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
        );
        expect(doc.warnings).toEqual([]);
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
