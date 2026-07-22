import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { shapesOf, textsOf } from './helpers';

describe('parseSvgDocument (currentColor)', () => {
    it('resolves fill="currentColor" against the color set on the same element', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" fill="currentColor" color="#ff0000"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
    });

    it("resolves currentColor against an ancestor's color when the element itself doesn't set one", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g color="#00ff00"><rect width="10" height="10" fill="currentColor"/></g></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('resolves currentColor set via a CSS style rule, not just the presentation attribute', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.icon { color: #0000ff; }</style><rect class="icon" width="10" height="10" fill="currentColor"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('falls back to black when no ancestor sets color, matching the pre-existing default', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" fill="currentColor"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('resolves stroke="currentColor" independently of fill', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" stroke="currentColor" color="#123456"/></svg>',
        );
        expect(shapesOf(doc)[0].stroke).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
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

describe('parseSvgDocument (display/visibility)', () => {
    it('omits an element and its whole subtree for display="none"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g display="none"><rect width="10" height="10"/><rect width="20" height="20"/></g><circle cx="50" cy="50" r="5"/></svg>',
        );
        expect(shapesOf(doc)).toHaveLength(1);
    });

    it('omits an element reached indirectly through a <use> reference for display="none"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><rect id="r" display="none" width="10" height="10"/></defs><use href="#r"/></svg>',
        );
        expect(shapesOf(doc)).toHaveLength(0);
    });

    it('draws nothing for visibility="hidden" but still walks children (a descendant can turn itself back on)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g visibility="hidden"><rect width="10" height="10"/><rect visibility="visible" width="20" height="20"/></g></svg>',
        );
        expect(shapesOf(doc)).toHaveLength(1);
        expect(shapesOf(doc)[0].d).toContain('20');
    });

    it('inherits visibility="hidden" down to a plain <text> run', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text visibility="hidden">hidden</text></svg>',
        );
        expect(textsOf(doc)).toHaveLength(0);
    });

    it('treats visibility="collapse" the same as "hidden"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect visibility="collapse" width="10" height="10"/></svg>',
        );
        expect(shapesOf(doc)).toHaveLength(0);
    });
});

describe('parseSvgDocument (stroke-miterlimit)', () => {
    it("defaults to 4 (SVG default), not left to the PDF writer's own default", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" stroke="#000"/></svg>',
        );
        expect(shapesOf(doc)[0].miterLimit).toBe(4);
    });

    it('resolves an explicit stroke-miterlimit and inherits it to children', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g stroke-miterlimit="8"><rect width="10" height="10" stroke="#000"/></g></svg>',
        );
        expect(shapesOf(doc)[0].miterLimit).toBe(8);
    });

    it('falls back to the inherited value for a non-numeric stroke-miterlimit instead of NaN', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g stroke-miterlimit="8"><rect width="10" height="10" stroke="#000" stroke-miterlimit="not-a-number"/></g></svg>',
        );
        expect(shapesOf(doc)[0].miterLimit).toBe(8);
    });
});

describe('parseSvgDocument (invalid numeric presentation values)', () => {
    it('falls back to the inherited stroke-width for a non-numeric value instead of NaN', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g stroke-width="3"><rect width="10" height="10" stroke="#000" stroke-width="thin"/></g></svg>',
        );
        expect(shapesOf(doc)[0].strokeWidth).toBe(3);
    });

    it('falls back to the inherited stroke-dashoffset for a non-numeric value instead of 0', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g stroke-dashoffset="5"><rect width="10" height="10" stroke="#000" stroke-dasharray="1,1" stroke-dashoffset="bogus"/></g></svg>',
        );
        expect(shapesOf(doc)[0].dashOffset).toBe(5);
    });
});

describe('parseSvgDocument (stroke-linecap/stroke-linejoin/fill-rule)', () => {
    it('resolves valid keyword values', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" stroke="#000" stroke-linecap="round" stroke-linejoin="bevel" fill-rule="evenodd"/></svg>',
        );
        expect(shapesOf(doc)[0]).toMatchObject({
            lineCap: 'round',
            lineJoin: 'bevel',
            fillRule: 'evenodd',
        });
    });

    it('falls back to the inherited value for an unrecognized keyword instead of passing it through unchecked', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><g stroke-linecap="round" stroke-linejoin="bevel" fill-rule="evenodd"><rect width="10" height="10" stroke="#000" stroke-linecap="flat" stroke-linejoin="pointy" fill-rule="zigzag"/></g></svg>',
        );
        expect(shapesOf(doc)[0]).toMatchObject({
            lineCap: 'round',
            lineJoin: 'bevel',
            fillRule: 'evenodd',
        });
    });
});

describe('parseSvgDocument (paint-order)', () => {
    it('extracts paint-order attribute and CSS style on shapes', () => {
        const svg = `
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <style>
                    .reversed { paint-order: stroke fill; }
                </style>
                <rect x="0" y="0" width="10" height="10" paint-order="stroke fill markers" />
                <rect class="reversed" x="10" y="10" width="10" height="10" />
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const shapes = shapesOf(parsed);
        expect(shapes).toHaveLength(2);
        expect(shapes[0].paintOrder).toEqual(['stroke', 'fill', 'markers']);
        expect(shapes[1].paintOrder).toEqual(['stroke', 'fill', 'markers']);
    });
});

describe('parseSvgDocument (vector-effect)', () => {
    it('extracts vector-effect attribute and CSS property on shapes', () => {
        const svg = `
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <style>
                    .non-scaling { vector-effect: non-scaling-stroke; }
                </style>
                <circle cx="20" cy="20" r="10" vector-effect="non-scaling-stroke" />
                <circle class="non-scaling" cx="50" cy="50" r="10" />
                <circle cx="80" cy="80" r="10" />
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const shapes = shapesOf(parsed);
        expect(shapes).toHaveLength(3);
        expect(shapes[0].vectorEffect).toBe('non-scaling-stroke');
        expect(shapes[1].vectorEffect).toBe('non-scaling-stroke');
        expect(shapes[2].vectorEffect).toBe('none');
    });
});
