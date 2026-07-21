import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { shapesOf } from './helpers';

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

    it('applies a descendant combinator selector', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>g .big { fill: #ff0000; }</style><rect class="big" width="5" height="5"/><g><rect class="big" width="5" height="5"/></g></svg>',
        );
        const [outside, inside] = shapesOf(doc);
        expect(outside.fill).toEqual({ r: 0, g: 0, b: 0 });
        expect(inside.fill).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('applies a child combinator selector, requiring a direct parent-child relationship', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>g > .big { fill: #ff0000; }</style><g><rect class="big" width="5" height="5"/><svg width="5" height="5"><rect class="big" width="5" height="5"/></svg></g></svg>',
        );
        const [directChild, throughOtherParent] = shapesOf(doc);
        expect(directChild.fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(throughOtherParent.fill).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('applies an attribute selector', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>[data-role="hero"] { fill: #ff0000; }</style><rect data-role="hero" width="5" height="5"/><rect width="5" height="5"/></svg>',
        );
        const [withAttr, without] = shapesOf(doc);
        expect(withAttr.fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(without.fill).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('applies a :not() pseudo-class selector', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>rect:not(.skip) { fill: #ff0000; }</style><rect width="5" height="5"/><rect class="skip" width="5" height="5"/></svg>',
        );
        const [matched, skipped] = shapesOf(doc);
        expect(matched.fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(skipped.fill).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('ranks an attribute selector equally with a class selector, so source order decides', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>[data-role="hero"] { fill: #ff0000; } .big { fill: #00ff00; }</style><rect data-role="hero" class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('warns and skips a genuinely malformed selector without affecting other rules', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>[unclosed { fill: #ff0000; } .ok { fill: #00ff00; }</style><rect class="ok" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 0, g: 255, b: 0 });
        expect(doc.warnings.some((w) => w.includes('<style> selector'))).toBe(true);
    });

    it('applies a compound tag.class selector, requiring both to match', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>rect.big { fill: #ff0000; } circle.big { fill: #00ff00; }</style><rect class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('applies a compound .a.b selector, requiring every class to be present', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>.a.b { fill: #ff0000; }</style><rect class="a b c" width="5" height="5"/><rect class="a" width="5" height="5"/></svg>',
        );
        const [first, second] = shapesOf(doc);
        expect(first.fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(second.fill).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('ranks a compound tag.class selector above a plain class selector of equal source order', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>rect.big { fill: #ff0000; } .big { fill: #00ff00; }</style><rect class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
    });
});
