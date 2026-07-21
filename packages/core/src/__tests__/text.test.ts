import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { shapesOf, textsOf, textPathsOf } from './helpers';

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

    it('omits charDx/charDy/charRotate for a plain scalar dx/dy (the fast draw path stays untouched)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10" dx="3" dy="4">Hi</text></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({ x: 8, y: 14 });
        expect(textsOf(doc)[0].charDx).toBeUndefined();
        expect(textsOf(doc)[0].charDy).toBeUndefined();
        expect(textsOf(doc)[0].charRotate).toBeUndefined();
    });

    it('attaches charDx/charDy for a multi-value dx/dy list', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10" dx="1 2 3" dy="4,5">Hi</text></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({
            x: 6,
            y: 14,
            charDx: [1, 2, 3],
            charDy: [4, 5],
        });
    });

    it('attaches charRotate even for a single rotate value (PDF text rotation is per-run, not per-glyph)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="5" y="10" rotate="15">Hi</text></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({ charRotate: [15] });
        expect(textsOf(doc)[0].charDx).toBeUndefined();
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

    it('threads flow through bare text interleaved with a nested element instead of merging it into one run', () => {
        /*
         * Mirrors the real bug: `<text>A <tspan>...</tspan> here</text>` used
         * to concatenate "A" and "here" into a single merged run drawn at
         * the text's own x, while the nested <tspan> (or an <a> further
         * inside it) was *also* treated as starting fresh at that same x —
         * producing two runs drawn on top of each other instead of "A", then
         * the tspan's text, then "here" flowing after it.
         */
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20">A <tspan>B</tspan> C</text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts.map((t) => t.text)).toEqual(['A ', 'B', ' C']);
        expect(texts[0]).toMatchObject({ continuesFlow: false, startsNewChunk: true });
        expect(texts[1]).toMatchObject({ continuesFlow: true, startsNewChunk: false });
        expect(texts[2]).toMatchObject({ continuesFlow: true, startsNewChunk: false });
    });

    it('threads flow through bare text around a link-wrapped tspan (the anchor-links.svg regression)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20">A <tspan><a href="https://example.com">link</a></tspan> here</text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts.map((t) => t.text)).toEqual(['A ', 'link', ' here']);
        expect(texts[0].continuesFlow).toBe(false);
        expect(texts[1].continuesFlow).toBe(true);
        expect(texts[2].continuesFlow).toBe(true);
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

    it('records text-anchor for embed.ts to resolve at draw time', () => {
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

    it('emits a textPath instruction with no warning for a valid <textPath href>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p">Curved</textPath></text></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape', 'textPath']);
        expect(doc.warnings.some((w) => w.includes('textPath'))).toBe(false);
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

    it('applies text-transform: uppercase/lowercase/capitalize to the run text', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text style="text-transform:uppercase">hello world</text><text y="10" style="text-transform:lowercase">HELLO WORLD</text><text y="20" style="text-transform:capitalize">hello world</text></svg>',
        );
        const texts = textsOf(doc);
        expect(texts[0].text).toBe('HELLO WORLD');
        expect(texts[1].text).toBe('hello world');
        expect(texts[2].text).toBe('Hello World');
    });

    it('ignores a bare text-transform="..." XML attribute (not a real SVG presentation attribute — only style/CSS is honored, matching browsers)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text text-transform="uppercase">hello world</text></svg>',
        );
        expect(textsOf(doc)[0].text).toBe('hello world');
    });

    it("resolves letter-spacing/word-spacing, including em units relative to the element's own font-size", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text font-size="10" letter-spacing="2" word-spacing="0.5em">A B</text></svg>',
        );
        expect(textsOf(doc)[0]).toMatchObject({ letterSpacing: 2, wordSpacing: 5 });
    });

    it('defaults letter-spacing/word-spacing to 0 when unset', () => {
        const doc = parseSvgDocument('<svg viewBox="0 0 100 100"><text>A</text></svg>');
        expect(textsOf(doc)[0]).toMatchObject({ letterSpacing: 0, wordSpacing: 0 });
    });

    it('preserves whitespace with xml:space="preserve" instead of collapsing it', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text xml:space="preserve">  a   b  </text></svg>',
        );
        expect(textsOf(doc)[0].text).toBe('  a   b  ');
    });

    it('collapses whitespace by default (no xml:space)', () => {
        const doc = parseSvgDocument('<svg viewBox="0 0 100 100"><text>  a   b  </text></svg>');
        expect(textsOf(doc)[0].text).toBe('a b');
    });

    it('inherits xml:space="preserve" from an ancestor down to a <tspan>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text xml:space="preserve">a<tspan>  b  </tspan></text></svg>',
        );
        expect(textsOf(doc)[1].text).toBe('  b  ');
    });

    it('an inner xml:space="default" turns collapsing back on for a descendant', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text xml:space="preserve">a<tspan xml:space="default">  b   c  </tspan></text></svg>',
        );
        expect(textsOf(doc)[1].text).toBe('b c');
    });

    it('treats white-space: pre the same as xml:space="preserve"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text style="white-space: pre">  a   b  </text></svg>',
        );
        expect(textsOf(doc)[0].text).toBe('  a   b  ');
    });
});

describe('parseSvgDocument (textPath)', () => {
    it('warns and skips when href points at a missing element', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text><textPath href="#missing">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('valid href to a <path>'))).toBe(true);
    });

    it('warns and skips when href points at a non-<path> element', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect id="r" width="10" height="10"/><text><textPath href="#r">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('valid href to a <path>'))).toBe(true);
    });

    it('resolves startOffset as a percentage of the path length', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p" startOffset="50%">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)[0]).toMatchObject({ startDistance: 50 });
    });

    it('resolves a plain-number startOffset as an absolute distance', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p" startOffset="30">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)[0]).toMatchObject({ startDistance: 30 });
    });

    it('defaults startOffset to 0 when absent', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)[0]).toMatchObject({ startDistance: 0 });
    });

    it("rescales startOffset by the referenced path's own pathLength attribute", () => {
        // The path is geometrically 100 units long but declares pathLength="50" — so its own units are 2x real units, and startOffset="25" (in the path's own units) should resolve to 50 real units.
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" pathLength="50" d="M0 0 L100 0"/><text><textPath href="#p" startOffset="25">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)[0]).toMatchObject({ startDistance: 50 });
    });

    it('flattens the referenced path into a polyline with matching cumulative lengths', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p">Curved</textPath></text></svg>',
        );
        const tp = textPathsOf(doc)[0] as unknown as {
            points: { x: number; y: number }[];
            cumLengths: number[];
        };
        expect(tp.points[0]).toEqual({ x: 0, y: 0 });
        expect(tp.points[tp.points.length - 1]).toEqual({ x: 100, y: 0 });
        expect(tp.cumLengths[tp.cumLengths.length - 1]).toBeCloseTo(100);
    });

    it('parses nested <tspan> children inside a <textPath> into separate textPath runs', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p">A<tspan>B</tspan></textPath></text></svg>',
        );
        expect(textPathsOf(doc)).toHaveLength(2);
        expect(doc.warnings.some((w) => w.includes('nested <tspan>'))).toBe(false);
    });

    it('resolves a plain-number textLength with no warning (default lengthAdjust="spacing")', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p" textLength="50">Curved</textPath></text></svg>',
        );
        const tp = textPathsOf(doc)[0] as unknown as { textLength: number | null };
        expect(tp.textLength).toBe(50);
        expect(doc.warnings.some((w) => w.includes('textLength'))).toBe(false);
    });

    it("resolves a percentage textLength against the referenced path's total length", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p" textLength="50%">Curved</textPath></text></svg>',
        );
        const tp = textPathsOf(doc)[0] as unknown as { textLength: number | null };
        expect(tp.textLength).toBeCloseTo(50);
    });

    it('parses lengthAdjust="spacingAndGlyphs" without warning', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text><textPath href="#p" textLength="50" lengthAdjust="spacingAndGlyphs">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)).toHaveLength(1);
        expect(doc.warnings.some((w) => w.includes('spacingAndGlyphs'))).toBe(false);
    });

    it('inherits fill/font-size from the ancestor <text>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text fill="#0000ff" font-size="20"><textPath href="#p">Curved</textPath></text></svg>',
        );
        expect(textPathsOf(doc)[0]).toMatchObject({
            fill: { r: 0, g: 0, b: 255 },
            fontSize: 20,
        });
    });

    it('skips drawing (without a crash) when fill is none', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><path id="p" d="M0 0 L100 0"/><text fill="none"><textPath href="#p">Invisible</textPath></text></svg>',
        );
        expect(textPathsOf(doc)).toHaveLength(0);
    });

    it('carries per-tspan fill/font-weight and flow flags across a mixed run (text + styled tspan + tail)', () => {
        const svg = `
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                <path id="curve" d="M 10 100 Q 100 10 190 100" />
                <text>
                    <textPath href="#curve">
                        Header <tspan fill="#ff0000" font-weight="bold">Bold Sub</tspan> Tail
                    </textPath>
                </text>
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const textPaths = textPathsOf(parsed);
        expect(textPaths.length).toBeGreaterThanOrEqual(2);
        expect(textPaths[0].continuesFlow).toBe(false);
        expect(textPaths[0].startsNewChunk).toBe(true);
        expect(textPaths[1].continuesFlow).toBe(true);
        expect(textPaths[1].startsNewChunk).toBe(false);
        expect(textPaths[1].fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(textPaths[1].fontWeight).toBe('bold');
    });
});

describe('parseSvgDocument (@font-face)', () => {
    it('parses a @font-face with a data: URI src, defaulting weight/style to normal', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(data:font/ttf;base64,AAAA) format("truetype"); }</style></svg>',
        );
        expect(doc.fontFaces).toEqual([
            {
                fontFamily: 'CustomSans',
                fontWeight: 'normal',
                fontStyle: 'normal',
                dataUri: 'data:font/ttf;base64,AAAA',
            },
        ]);
    });

    it('reads explicit font-weight/font-style off a @font-face', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: CustomSans; font-weight: bold; font-style: italic; src: url(data:font/ttf;base64,AAAA); }</style></svg>',
        );
        expect(doc.fontFaces[0].fontWeight).toBe('bold');
        expect(doc.fontFaces[0].fontStyle).toBe('italic');
    });

    it('does not mis-split a src declaration at the ";" inside a data: URI', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: CustomSans; src: url(data:font/ttf;base64,AAAA==); }</style></svg>',
        );
        expect(doc.fontFaces[0].dataUri).toBe('data:font/ttf;base64,AAAA==');
    });

    it('picks the first data: URI out of a multi-source src list', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: CustomSans; src: url(data:font/woff2;base64,BBBB) format("woff2"), url(data:font/ttf;base64,AAAA) format("truetype"); }</style></svg>',
        );
        expect(doc.fontFaces[0].dataUri).toBe('data:font/woff2;base64,BBBB');
    });

    it('warns and skips a @font-face whose src has no data: URI (external-only, not auto-embedded)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: CustomSans; src: url(https://example.com/font.ttf); }</style></svg>',
        );
        expect(doc.fontFaces).toEqual([]);
        expect(doc.warnings.some((w) => w.includes('@font-face'))).toBe(true);
    });

    it('does not include a @font-face missing font-family or src', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { src: url(data:font/ttf;base64,AAAA); }</style></svg>',
        );
        expect(doc.fontFaces).toEqual([]);
    });

    it('still strips @font-face out of normal <style> rule parsing (no bogus selector warning)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><style>@font-face { font-family: CustomSans; src: url(data:font/ttf;base64,AAAA); } .big { fill: #ff0000; }</style><rect class="big" width="5" height="5"/></svg>',
        );
        expect(shapesOf(doc)[0].fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(doc.warnings.some((w) => w.includes('<style> selector'))).toBe(false);
    });
});

describe('parseSvgDocument (<a href> link)', () => {
    it('brackets an <a href> subtree with linkStart/linkEnd carrying the href', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><a href="https://example.com"><rect width="10" height="10"/></a></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['linkStart', 'shape', 'linkEnd']);
        expect(doc.instructions[0]).toMatchObject({
            type: 'linkStart',
            href: 'https://example.com',
        });
    });

    it('reads xlink:href as a fallback', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://example.com"><rect width="10" height="10"/></a></svg>',
        );
        expect(doc.instructions[0]).toMatchObject({
            type: 'linkStart',
            href: 'https://example.com',
        });
    });

    it('treats an <a> without href as a plain transparent group (no link instructions)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><a><rect width="10" height="10"/></a></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
    });

    it('warns and skips an internal fragment href (no cross-page target in a single-page PDF)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><a href="#somewhere"><rect width="10" height="10"/></a></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
        expect(doc.warnings.some((w) => w.includes('fragment'))).toBe(true);
    });

    it("still applies the <a>'s own transform/clip to its wrapped content", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><a href="https://example.com" transform="translate(5,5)"><rect width="10" height="10"/></a></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual([
            'pushMatrix',
            'linkStart',
            'shape',
            'linkEnd',
            'popMatrix',
        ]);
    });

    it('brackets an <a> nested directly inside <text> (a link on bare text, not a whole block)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20"><a href="https://example.com">Click</a></text></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['linkStart', 'text', 'linkEnd']);
        expect(doc.instructions[1]).toMatchObject({ text: 'Click', x: 10, y: 20 });
    });

    it('brackets an <a> wrapping a <tspan> nested inside <text>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20"><a href="https://example.com"><tspan>Click</tspan></a></text></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['linkStart', 'text', 'linkEnd']);
    });

    it('brackets an <a> nested inside a <tspan> (link on part of a line)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><text x="10" y="20">A <tspan><a href="https://example.com">link</a></tspan></text></svg>',
        );
        const types = doc.instructions.map((i) => i.type);
        expect(types).toEqual(['text', 'linkStart', 'text', 'linkEnd']);
    });
});
