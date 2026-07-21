import { describe, expect, it } from 'vitest';

import { parseSvgDocument, resolveSvgSize } from '..';
import { el, hasFixtures, loadFixture, shapesOf, textsOf } from './helpers';

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
            preserveAspectRatio: null,
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
            preserveAspectRatio: null,
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
            preserveAspectRatio: null,
        });
    });

    it('falls back to the CSS default replaced-element size (300x150) when neither is present', () => {
        const root = el('<svg><rect/></svg>').parentElement!;
        expect(resolveSvgSize(root)).toEqual({
            width: 300,
            height: 150,
            viewBoxMinX: 0,
            viewBoxMinY: 0,
            viewBoxWidth: 300,
            viewBoxHeight: 150,
            preserveAspectRatio: null,
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
            preserveAspectRatio: null,
        });
    });

    it('reads the raw preserveAspectRatio attribute unparsed', () => {
        const root = el(
            '<svg viewBox="0 0 100 100" preserveAspectRatio="xMinYMax slice"><rect/></svg>',
        ).parentElement!;
        expect(resolveSvgSize(root).preserveAspectRatio).toBe('xMinYMax slice');
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

    it("resolves a top-level shape's %-valued geometry against the root viewBox size", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 200 100"><rect x="2%" y="2%" width="96%" height="96%"/></svg>',
        );
        expect(shapesOf(doc)[0].d).toBe('M 4 2 H 196 V 98 H 4 Z');
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

    it('letterboxes (uniform scale, centered) an aspect-mismatched <symbol> viewBox by default, rather than stretching it', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="40" height="20"/></svg>',
        );
        const push = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d,
        );
        if (!push || push.type !== 'pushMatrix') throw new Error('unreachable');
        // 40x20 viewport, 10x10 viewBox: width ratio 4, height ratio 2 — meet picks the smaller (2), centering horizontally.
        expect(push.matrix.a).toBe(2);
        expect(push.matrix.d).toBe(2);
        expect(push.matrix.e).toBe(10); // (40 - 10*2) / 2
    });

    it('stretches a <symbol> viewBox independently when preserveAspectRatio="none"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="40" height="20"/></svg>',
        );
        const push = doc.instructions.find((i) => i.type === 'pushMatrix' && i.matrix.a === 4);
        if (!push || push.type !== 'pushMatrix') throw new Error('unreachable');
        expect(push.matrix.a).toBe(4);
        expect(push.matrix.d).toBe(2);
    });

    it("clips a <symbol>'s content to its resolved width/height by default", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box"><rect width="50" height="50" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="20" height="10"/></svg>',
        );
        const pushClip = doc.instructions.find((i) => i.type === 'pushClip');
        if (!pushClip || pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toEqual(['M 0 0 H 20 V 10 H 0 Z']);
    });

    it('skips the viewport clip for a <symbol> with overflow="visible"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box" overflow="visible"><rect width="50" height="50" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="20" height="10"/></svg>',
        );
        expect(doc.instructions.some((i) => i.type === 'pushClip')).toBe(false);
    });

    it("resolves <use>'s percentage x/y against the current viewport", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 200 100"><defs><symbol id="box"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box" x="10%" y="10%"/></svg>',
        );
        // No viewBox on the symbol, so the only pushMatrix is the plain x/y offset.
        const push = doc.instructions.find((i) => i.type === 'pushMatrix');
        if (!push || push.type !== 'pushMatrix') throw new Error('unreachable');
        expect(push.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 20, f: 10 });
    });

    it("resolves <use>'s percentage width/height against the current viewport when scaling a <symbol>'s viewBox", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 200 100"><defs><symbol id="box" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box" x="0" y="0" width="50%" height="50%"/></svg>',
        );
        const push = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d,
        );
        if (!push || push.type !== 'pushMatrix') throw new Error('unreachable');
        // 50%/50% of a 200x100 viewport is 100x50; 10x10 viewBox: width ratio 10, height ratio 5 — meet picks the smaller (5), centering horizontally.
        expect(push.matrix.a).toBe(5);
        expect(push.matrix.d).toBe(5);
        expect(push.matrix.e).toBe(25); // (100 - 10*5) / 2
        expect(push.matrix.f).toBe(0);
    });

    it("falls back to the <symbol>'s own width/height when <use> omits them, instead of drawing unscaled", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><symbol id="box" viewBox="0 0 10 10" width="20" height="20"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box"/></svg>',
        );
        const scalePush = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d && i.matrix.a !== 1,
        );
        if (!scalePush || scalePush.type !== 'pushMatrix') throw new Error('unreachable');
        expect(scalePush.matrix.a).toBe(2);
        expect(scalePush.matrix.d).toBe(2);
    });

    it('gives <use> referencing a nested <svg> the same width/height override treatment as referencing a <symbol>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><svg id="box" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg></defs><use href="#box" x="0" y="0" width="20" height="20"/></svg>',
        );
        expect(
            doc.instructions.some(
                (i) => i.type === 'pushMatrix' && i.matrix.a === 2 && i.matrix.d === 2,
            ),
        ).toBe(true);
    });

    it("falls back to the referenced <svg>'s own width/height when <use> omits them, instead of drawing unscaled", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><svg id="box" viewBox="0 0 10 10" width="20" height="20"><rect width="10" height="10" fill="#000"/></svg></defs><use href="#box"/></svg>',
        );
        const scalePush = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d && i.matrix.a !== 1,
        );
        if (!scalePush || scalePush.type !== 'pushMatrix') throw new Error('unreachable');
        expect(scalePush.matrix.a).toBe(2);
        expect(scalePush.matrix.d).toBe(2);
    });

    it("ignores the referenced <svg>'s own x/y, using only the <use>'s x/y (per spec)", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><svg id="box" x="99" y="99" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg></defs><use href="#box" x="5" y="5"/></svg>',
        );
        const offsetPush = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.e === 5 && i.matrix.f === 5,
        );
        expect(offsetPush).toBeDefined();
        expect(doc.instructions.some((i) => i.type === 'pushMatrix' && i.matrix.e === 99)).toBe(
            false,
        );
    });

    it('falls back to 100% of the current viewport when neither <use> nor <symbol> specify width/height', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 40 20"><defs><symbol id="box" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></symbol></defs><use href="#box"/></svg>',
        );
        const scalePush = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d && i.matrix.a !== 1,
        );
        if (!scalePush || scalePush.type !== 'pushMatrix') throw new Error('unreachable');
        // 40x20 viewport, 10x10 viewBox: width ratio 4, height ratio 2 — meet picks the smaller (2).
        expect(scalePush.matrix.a).toBe(2);
        expect(scalePush.matrix.d).toBe(2);
    });

    it("resolves a shape's own percentage geometry inside a <symbol> against that symbol's viewBox, not the root's", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 400 400"><defs><symbol id="box" viewBox="0 0 10 10"><rect width="50%" height="50%" fill="#00ff00"/></symbol></defs><use href="#box" width="40" height="40"/></svg>',
        );
        const shape = shapesOf(doc).find((s) => s.fill && 'r' in s.fill && s.fill.g === 255);
        expect(shape?.d).toBe('M 0 0 H 5 V 5 H 0 Z');
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
        // Gradients/patterns/clip-path/<text>/<style> class rules/<textPath> here are all now supported.
        expect(doc.warnings.some((w) => w.includes('gradient reference'))).toBe(false);
        expect(doc.warnings.some((w) => w.startsWith('clip-path='))).toBe(false);
        expect(doc.warnings.some((w) => w.includes('pattern reference'))).toBe(false);
        expect(doc.warnings.some((w) => w.includes('textPath'))).toBe(false);
        expect(doc.instructions.some((i) => i.type === 'textPath')).toBe(true);
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
