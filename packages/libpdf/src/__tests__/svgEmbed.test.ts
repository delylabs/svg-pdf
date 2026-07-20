import {
    measureText,
    ops,
    PDF as LibPDF,
    PdfArray,
    type PdfDict,
    type PdfRef,
    PdfStream,
} from '@libpdf/core';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { embedSvgInPdf } from '../svgEmbed';

// A real, minimal 1x1 transparent PNG — same constant as svgCodec.test.ts, aspectRatio 1 makes "meet" fit math easy to verify by hand.
const ONE_PIXEL_PNG_DATA_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// A real TTF already vendored as a dev dependency (visual-regression tests use the same pdfjs-dist package to rasterize PDFs) — reused here as stand-in "custom font bytes" for fetchFont tests, rather than adding a new font fixture just for this.
const LIBERATION_SANS_TTF = path.resolve(
    process.cwd(),
    'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
);

// Decodes a page's content stream to text for asserting on raw operators.
const getPageContentText = (doc: ReturnType<typeof LibPDF.create>, pageIndex: number): string => {
    const page = doc.getPages()[pageIndex];
    const contents = page.dict.get('Contents');
    if (!contents) return '';
    const refs = contents instanceof PdfArray ? [...contents] : [contents];
    return refs
        .map((ref) => doc.getObject(ref as PdfRef) as PdfStream)
        .map((stream) => new TextDecoder('latin1').decode(stream.getDecodedData()))
        .join('\n');
};

// Decodes the content stream of a named pattern resource (as registered in the page's /Resources /Pattern dict) — mirrors getPageContentText, but for a pattern's own private stream rather than the page's.
const getPatternContentText = (
    doc: ReturnType<typeof LibPDF.create>,
    pageIndex: number,
    patternName: string,
): string => {
    const page = doc.getPages()[pageIndex];
    const resources = page.dict.get('Resources') as PdfDict;
    const patternDict = resources.get('Pattern') as PdfDict;
    const patternRef = patternDict.get(patternName) as PdfRef;
    const patternStream = doc.getObject(patternRef) as PdfStream;
    return new TextDecoder('latin1').decode(patternStream.getDecodedData());
};

// Same idea as getPatternContentText, but for a Form XObject (/Resources /XObject) — used by <marker>.
const getXObjectContentText = (
    doc: ReturnType<typeof LibPDF.create>,
    pageIndex: number,
    xobjectName: string,
): string => {
    const page = doc.getPages()[pageIndex];
    const resources = page.dict.get('Resources') as PdfDict;
    const xobjectDict = resources.get('XObject') as PdfDict;
    const xobjectRef = xobjectDict.get(xobjectName) as PdfRef;
    const xobjectStream = doc.getObject(xobjectRef) as PdfStream;
    return new TextDecoder('latin1').decode(xobjectStream.getDecodedData());
};

describe('embedSvgInPdf', () => {
    describe('page setup', () => {
        it('adds one page sized from the SVG viewBox (no pageSize given)', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: '<svg viewBox="0 0 200 100"><rect width="10" height="10"/></svg>',
                rotation: 0,
            });
            expect(doc.getPages()).toHaveLength(1);
            const page = doc.getPages()[0];
            expect(page.width).toBeCloseTo(200);
            expect(page.height).toBeCloseTo(100);
        });

        it('sizes the page from mm width/height (converted to points), not the raw viewBox numbers, when they differ hugely (e.g. a LibreOffice Draw export)', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg width="297mm" height="210mm" viewBox="0 0 29700 21000"><rect width="10" height="10"/></svg>',
                rotation: 0,
            });
            const page = doc.getPages()[0];
            // A4 landscape in points, not the un-converted 297 x 210.
            expect(page.width).toBeCloseTo(841.89, 1);
            expect(page.height).toBeCloseTo(595.28, 1);
        });

        it('scales content by drawWidth/viewBoxWidth, not drawWidth/display-width, when they differ (the actual bug: without this, content is scaled ~100x too large and only a tiny corner of it is visible)', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg width="297mm" height="210mm" viewBox="0 0 29700 21000"><rect width="10" height="10"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
            expect(match).not.toBeNull();
            // scale = drawWidth (≈841.89pt) / viewBoxWidth (29700), not / display width (297).
            expect(Number(match![1])).toBeCloseTo(841.89 / 29700, 5);
        });

        it('letterboxes (uniform scale, centered) an aspect-mismatched viewBox by default, rather than distorting it', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg width="200" height="100" viewBox="0 0 50 50"><rect width="50" height="50"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
            expect(match).not.toBeNull();
            const [, a, d] = match!.map(Number);
            // Uniform scale (min of 200/50=4, 100/50=2 → 2), not the independent 4/2 stretch a naive per-axis fit would produce.
            expect(a).toBeCloseTo(2);
            expect(Math.abs(d)).toBeCloseTo(2);
        });

        it('stretches an aspect-mismatched viewBox independently for preserveAspectRatio="none"', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg width="200" height="100" viewBox="0 0 50 50" preserveAspectRatio="none"><rect width="50" height="50"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
            expect(match).not.toBeNull();
            const [, a, d] = match!.map(Number);
            expect(a).toBeCloseTo(4);
            expect(Math.abs(d)).toBeCloseTo(2);
        });

        it('applies page rotation', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
                rotation: 90,
            });
            expect(doc.getPages()[0].rotation).toBe(90);
        });

        it('returns collected warnings for unsupported elements instead of throwing', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><image href="a.png" width="5" height="5"/><rect width="10" height="10"/></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('image'))).toBe(true);
            expect(doc.getPages()).toHaveLength(1);
        });

        it('throws FILE_CORRUPT_OR_INVALID for malformed SVG, matching the image-embed error convention', async () => {
            const doc = LibPDF.create();
            await expect(
                embedSvgInPdf(doc, {
                    svgText: '<svg><rect></svg>',
                    rotation: 0,
                    name: 'bad.svg',
                }),
            ).rejects.toThrow(/FILE_CORRUPT_OR_INVALID: bad\.svg/);
        });

        it('centers the SVG within a larger explicit pageSize', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
                rotation: 0,
                pageSize: { width: 200, height: 300 },
            });
            const page = doc.getPages()[0];
            expect(page.width).toBeCloseTo(200);
            expect(page.height).toBeCloseTo(300);
        });
    });

    describe('shapes', () => {
        it('emits fill and stroke color operators for a shape with both set', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000" stroke="#0000ff"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/1 0 0 rg/); // non-stroking (fill) red
            expect(content).toMatch(/0 0 1 RG/); // stroking (border) blue
            expect(content).toMatch(/\bB\b/); // combined fill+stroke paint operator
        });

        it('draws nothing for a shape with fill="none" stroke="none" (no fallback black fill)', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="none"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/0 0 0 rg/); // no default black fill leaked in
        });
    });

    describe('transforms', () => {
        it('wraps nested <g transform> content in balanced push/pop graphics state operators', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><g transform="translate(10,10)"><rect width="5" height="5" fill="#000000"/></g></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);
            expect(pushCount).toBeGreaterThanOrEqual(2); // root matrix push + the <g>'s own push
        });

        it('keeps the root viewBox-to-page matrix active for the first drawn shape', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><g transform="translate(10,10)"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></g></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const fillIndex = content.indexOf('1 0 0 rg');
            expect(fillIndex).toBeGreaterThan(-1);
            const before = content.slice(0, fillIndex);
            const pushCount = (before.match(/(^|\s)q(\s|$)/g) ?? []).length;
            const popCount = (before.match(/(^|\s)Q(\s|$)/g) ?? []).length;
            /*
             * Root matrix push + the <g>'s own push must both still be open when the
             * shape draws. @libpdf/core isolates a page's very first drawOperators()
             * call in its own q/Q once a second call arrives (see the canary test
             * below) — the workaround in svgEmbed.ts is a no-op first call so the
             * root matrix survives as the *second* call instead. If that regresses,
             * this nets to 0 or 1 instead of 2.
             */
            expect(pushCount - popCount).toBeGreaterThanOrEqual(2);
            expect(before).toContain('1 0 0 -1 0 100 cm');
        });
    });

    describe('nested svg', () => {
        it('draws content from a nested <svg>, offset and scaled to its own viewBox', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><svg x="10" y="20" width="40" height="20" viewBox="0 0 20 10"><rect width="20" height="10" fill="#ff0000"/></svg></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/1 0 0 rg/);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);
        });

        it('clips content to the nested viewport by default', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><svg width="20" height="10"><rect width="20" height="10" fill="#ff0000"/></svg></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\bW\b\s*\n?\s*n\b/);
        });

        it('draws nothing but a warning for a nested <svg> without explicit width/height', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><svg><rect width="10" height="10" fill="#ff0000"/></svg></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('nested <svg>'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/rg/);
        });
    });

    describe('gradients', () => {
        it('fills a gradient-referencing shape with a pattern instead of a solid color', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            // Pattern color space + a named pattern resource selected for fill, not a plain `rg` solid fill.
            expect(content).toMatch(/\/Pattern\s+cs/);
            expect(content).toMatch(/\/P\d+\s+scn/);
            expect(content).not.toMatch(/1 0 0 rg/);
        });
    });

    describe('patterns', () => {
        it('fills a <pattern>-referencing shape with a tiling pattern whose cell draws the pattern content', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="5" fill="#ff0000"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/Pattern\s+cs/);
            const match = content.match(/\/(P\d+)\s+scn/);
            expect(match).not.toBeNull();
            const patternContent = getPatternContentText(doc, 0, match![1]);
            // The pattern cell's own content stream draws the circle with its solid fill color, via a real path-construction + fill operator (not just a reference to something else).
            expect(patternContent).toMatch(/1 0 0 rg/);
            expect(patternContent).toMatch(/\bf\b/);
        });

        it("positions an objectBoundingBox (default) pattern tile using the filled shape's bbox", async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="0.5" height="0.5"><rect width="1" height="1" fill="#00ff00"/></pattern></defs><rect x="10" y="10" width="40" height="40" fill="url(#p)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/Pattern\s+cs/);
        });

        it('warns and falls back to no fill for a pattern reached through a rotated transform', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#ff0000"/></pattern></defs><g transform="rotate(45)"><rect width="100" height="100" fill="url(#p)"/></g></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('rotated or skewed'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/\/Pattern\s+cs/);
        });

        it('warns and skips unsupported content (e.g. <image>) inside a <pattern> cell, but still draws the rest', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/><circle cx="5" cy="5" r="5" fill="#0000ff"/></pattern></defs><rect width="100" height="100" fill="url(#p)"/></svg>`,
                rotation: 0,
            });
            expect(
                result.warnings.some((w) => w.includes('<image> inside <pattern> content')),
            ).toBe(true);
            const content = getPageContentText(doc, 0);
            const match = content.match(/\/(P\d+)\s+scn/);
            expect(match).not.toBeNull();
            const patternContent = getPatternContentText(doc, 0, match![1]);
            expect(patternContent).toMatch(/0 0 1 rg/);
        });
    });

    describe('markers', () => {
        it('paints a Form XObject for each marker-start/-mid/-end vertex on a marked path', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><marker id="arrow" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="#ff0000"/></marker></defs><path d="M10,10 L50,10 L50,50" stroke="#000000" fill="none" marker-start="url(#arrow)" marker-mid="url(#arrow)" marker-end="url(#arrow)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const doMatches = [...content.matchAll(/\/(Fm\d+)\s+Do/g)];
            expect(doMatches).toHaveLength(3);
            const xobjectContent = getXObjectContentText(doc, 0, doMatches[0][1]);
            expect(xobjectContent).toMatch(/1 0 0 rg/);
            expect(xobjectContent).toMatch(/\bf\b/);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);
        });

        it('reuses one Form XObject across every vertex that references the same marker', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><marker id="dot" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2" fill="#0000ff"/></marker></defs><path d="M10,10 L50,10 L50,50" marker="url(#dot)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const names = new Set([...content.matchAll(/\/(Fm\d+)\s+Do/g)].map((m) => m[1]));
            expect(names.size).toBe(1);
        });

        it('scales a marker by stroke-width for the markerUnits default, but not for userSpaceOnUse', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><marker id="a" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker><marker id="b" markerWidth="4" markerHeight="4" markerUnits="userSpaceOnUse"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" stroke-width="5" marker-start="url(#a)" marker-end="url(#b)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            // Each marker instance's placement matrix starts with pushGraphicsState + a `cm` (scale * rotate * translate) right before its `Do` — capture the `cm`'s leading (scale-dominated) component for each.
            const cmMatches = [
                ...content.matchAll(
                    /([-\d.]+)\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+cm\s+\/Fm\d+\s+Do/g,
                ),
            ];
            expect(cmMatches).toHaveLength(2);
            expect(Math.abs(parseFloat(cmMatches[0][1]))).toBeCloseTo(5);
            expect(Math.abs(parseFloat(cmMatches[1][1]))).toBeCloseTo(1);
        });

        it('warns and skips unsupported content (e.g. <text>) inside a <marker> cell', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="10" markerHeight="10"><text x="0" y="5">hi</text><circle cx="5" cy="5" r="4" fill="#00ff00"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('<text> inside <marker> content'))).toBe(
                true,
            );
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/Fm\d+\s+Do/);
        });
    });

    describe('mix-blend-mode', () => {
        it('registers an ExtGState with the requested blend mode for mix-blend-mode', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ff0000" style="mix-blend-mode: multiply;"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/GS\d+\s+gs/);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);

            const saved = await doc.save();
            const raw = new TextDecoder('latin1').decode(saved);
            expect(raw).toMatch(/\/BM\s*\/Multiply/);
        });
    });

    describe('stroke-dasharray', () => {
        it('emits a dash pattern operator for a stroke with stroke-dasharray', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="0" stroke="#000000" stroke-dasharray="5,3" stroke-dashoffset="2"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\[5 3\]\s*2\s*d/);
        });

        it('does not emit a dash pattern operator for a plain (non-dashed) stroke', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="0" stroke="#000000"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/\bd\b/);
        });
    });

    describe('clip-path', () => {
        it('emits a balanced clip (W n) bracket around a clip-path target', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath></defs><rect width="100" height="100" fill="#ff0000" clip-path="url(#c)"/></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\bW\b\s*\n?\s*n\b/);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);
        });
    });

    describe('text', () => {
        it('draws <text> with a Tj showText operator wrapped in a balanced q/Q bracket', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><text x="10" y="20" fill="#ff0000">Hello</text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/<48656C6C6F>\s*Tj/);
            const pushCount = (content.match(/\bq\b/g) ?? []).length;
            const popCount = (content.match(/\bQ\b/g) ?? []).length;
            expect(pushCount).toBe(popCount);
        });

        it('shifts x left by exactly half the font-measured text width for text-anchor=middle', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle">Hi</text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            expect(match).not.toBeNull();
            const expectedWidth = measureText('Hi', 'Helvetica', 16);
            expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
        });

        it('shifts x left by exactly the full font-measured text width for text-anchor=end', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="end">Hi</text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            expect(match).not.toBeNull();
            const expectedWidth = measureText('Hi', 'Helvetica', 16);
            expect(Number(match![1])).toBeCloseTo(50 - expectedWidth, 5);
        });

        it("draws consecutive flow-continuing tspans starting exactly where the previous one's measured text ended", async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 200 100"><text x="10" y="20"><tspan>Hello</tspan><tspan>World</tspan></text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const matches = [...content.matchAll(/1 0 0 1 (-?[\d.]+) -20 Tm/g)].map((m) =>
                Number(m[1]),
            );
            expect(matches).toHaveLength(2);
            expect(matches[0]).toBeCloseTo(10, 5);
            const helloWidth = measureText('Hello', 'Helvetica', 16);
            expect(matches[1]).toBeCloseTo(10 + helloWidth, 5);
        });

        it('does not let a flow-continuing tspan leak into an unrelated later text run', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 200 100"><text><tspan x="10" y="20"><tspan>Line1</tspan></tspan><tspan x="10" y="40"><tspan>Line2</tspan></tspan></text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const firstLineX = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            const secondLineX = content.match(/1 0 0 1 (-?[\d.]+) -40 Tm/);
            expect(firstLineX).not.toBeNull();
            expect(secondLineX).not.toBeNull();
            expect(Number(firstLineX![1])).toBeCloseTo(10, 5);
            // Must start at its own x=10, not continue from Line1's end (10 + measured width of "Line1").
            expect(Number(secondLineX![1])).toBeCloseTo(10, 5);
        });

        it('applies text-anchor once to a whole multi-tspan chunk (by total width), not separately per run', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 200 100"><text x="50" y="20" text-anchor="middle"><tspan>Hello</tspan><tspan>World</tspan></text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const matches = [...content.matchAll(/1 0 0 1 (-?[\d.]+) -20 Tm/g)].map((m) =>
                Number(m[1]),
            );
            expect(matches).toHaveLength(2);
            const helloWidth = measureText('Hello', 'Helvetica', 16);
            const worldWidth = measureText('World', 'Helvetica', 16);
            const chunkOffset = -(helloWidth + worldWidth) / 2;
            // Both runs shift by the same offset (from the chunk's combined width) — not
            // each centered around its own width, which would put a gap in the middle.
            expect(matches[0]).toBeCloseTo(50 + chunkOffset, 5);
            expect(matches[1]).toBeCloseTo(50 + chunkOffset + helloWidth, 5);
        });

        it('starts a new anchor chunk for a tspan with its own y, even without its own x (x-cursor still flows)', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 200 100"><text x="50" text-anchor="middle"><tspan y="20">Hi</tspan><tspan y="40">World</tspan></text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const firstLine = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            const secondLine = content.match(/1 0 0 1 (-?[\d.]+) -40 Tm/);
            expect(firstLine).not.toBeNull();
            expect(secondLine).not.toBeNull();
            const hiWidth = measureText('Hi', 'Helvetica', 16);
            const worldWidth = measureText('World', 'Helvetica', 16);
            // First run: its own one-run chunk, centered on x=50 as usual.
            expect(Number(firstLine![1])).toBeCloseTo(50 - hiWidth / 2, 5);
            // Second run: a *new* anchor chunk (own y), so it's centered using only its
            // own width — but the x-cursor isn't reset by y alone, so its unanchored
            // start is still "Hi"'s *unshifted* end (x=50 + hiWidth, before any anchor
            // offset — the cursor tracks natural flow, not the anchored draw position),
            // per spec (only x/dx affect the run cursor).
            expect(Number(secondLine![1])).toBeCloseTo(50 + hiWidth - worldWidth / 2, 5);
        });

        it('embeds a custom font via fetchFont and uses its own measured metrics for text-anchor positioning', async () => {
            const doc = LibPDF.create();
            const fontBytes = new Uint8Array(fs.readFileSync(LIBERATION_SANS_TTF));
            const fetchFont = vi.fn(async () => fontBytes);
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle" font-family="CustomSans">Hi</text></svg>',
                rotation: 0,
                fetchFont,
            });
            expect(fetchFont).toHaveBeenCalledWith({
                fontFamily: 'CustomSans',
                fontWeight: 'normal',
                fontStyle: 'normal',
            });
            const embedded = doc.embedFont(fontBytes);
            const expectedWidth = measureText('Hi', embedded, 16);
            const content = getPageContentText(doc, 0);
            const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            expect(match).not.toBeNull();
            expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
        });

        it('calls fetchFont only once for repeated runs sharing the same family/weight/style', async () => {
            const doc = LibPDF.create();
            const fontBytes = new Uint8Array(fs.readFileSync(LIBERATION_SANS_TTF));
            const fetchFont = vi.fn(async () => fontBytes);
            await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100" font-family="CustomSans"><text x="10" y="20">Hello</text><text x="10" y="40">World</text></svg>',
                rotation: 0,
                fetchFont,
            });
            expect(fetchFont).toHaveBeenCalledTimes(1);
        });

        it('warns and falls back to a standard font when fetchFont returns null', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><text x="50" y="20" text-anchor="middle" font-family="Missing">Hi</text></svg>',
                rotation: 0,
                fetchFont: async () => null,
            });
            expect(result.warnings.some((w) => w.includes('No font was found'))).toBe(true);
            const content = getPageContentText(doc, 0);
            const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            expect(match).not.toBeNull();
            const expectedWidth = measureText('Hi', 'Helvetica', 16);
            expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
        });

        it('warns and falls back to a standard font (without crashing) when fetchFont throws', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText: '<svg viewBox="0 0 100 100"><text x="10" y="20">Hi</text></svg>',
                rotation: 0,
                fetchFont: async () => {
                    throw new Error('font lookup failed');
                },
            });
            expect(result.warnings.some((w) => w.includes('could not be embedded'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/Tj/);
        });

        it('never calls fetchFont when not provided', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: '<svg viewBox="0 0 100 100"><text x="10" y="20">Hi</text></svg>',
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/Tj/);
        });

        it('embeds a font declared inline via @font-face src: url(data:...), with no fetchFont needed', async () => {
            const doc = LibPDF.create();
            const fontBytes = fs.readFileSync(LIBERATION_SANS_TTF);
            const dataUri = `data:font/ttf;base64,${fontBytes.toString('base64')}`;
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(${dataUri}); }</style><text x="50" y="20" text-anchor="middle" font-family="CustomSans">Hi</text></svg>`,
                rotation: 0,
            });
            expect(result.warnings).toEqual([]);
            const embedded = doc.embedFont(new Uint8Array(fontBytes));
            const expectedWidth = measureText('Hi', embedded, 16);
            const content = getPageContentText(doc, 0);
            const match = content.match(/1 0 0 1 (-?[\d.]+) -20 Tm/);
            expect(match).not.toBeNull();
            expect(Number(match![1])).toBeCloseTo(50 - expectedWidth / 2, 5);
        });

        it('prefers an inline @font-face match over fetchFont for the same family/weight/style', async () => {
            const doc = LibPDF.create();
            const fontBytes = fs.readFileSync(LIBERATION_SANS_TTF);
            const dataUri = `data:font/ttf;base64,${fontBytes.toString('base64')}`;
            const fetchFont = vi.fn(async () => {
                throw new Error('should never be called — @font-face already matched');
            });
            const result = await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(${dataUri}); }</style><text x="10" y="20" font-family="CustomSans">Hi</text></svg>`,
                rotation: 0,
                fetchFont,
            });
            expect(fetchFont).not.toHaveBeenCalled();
            expect(result.warnings).toEqual([]);
        });

        it('warns and falls back to a standard font when a @font-face src: data: URI cannot be decoded', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><style>@font-face { font-family: "CustomSans"; src: url(data:font/ttf;base64,!!!not-valid-base64!!!); }</style><text x="10" y="20" font-family="CustomSans">Hi</text></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/Tj/);
        });
    });

    describe('image', () => {
        it('draws a data: URI <image> stretched to the exact box for preserveAspectRatio="none"', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40" preserveAspectRatio="none"/></svg>`,
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(
                /([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\s*\/\w+ Do/,
            );
            expect(match).not.toBeNull();
            const [, w, h, x, y] = match!.map(Number);
            expect(w).toBeCloseTo(30);
            expect(h).toBeCloseTo(40);
            expect(x).toBeCloseTo(10);
            // -(imgY + imgHeight) = -(20 + 40)
            expect(y).toBeCloseTo(-60);
        });

        it('fits (centers + scales) a square image inside a non-square box for the default "meet" mode', async () => {
            const doc = LibPDF.create();
            await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" x="10" y="20" width="30" height="40"/></svg>`,
                rotation: 0,
            });
            const content = getPageContentText(doc, 0);
            const match = content.match(
                /([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\s*\/\w+ Do/,
            );
            expect(match).not.toBeNull();
            const [, w, h, x, y] = match!.map(Number);
            // A 1:1 image in a 30x40 box: constrained by the narrower dimension (30), so it draws as 30x30, centered vertically.
            expect(w).toBeCloseTo(30);
            expect(h).toBeCloseTo(30);
            expect(x).toBeCloseTo(10);
            // imgY = 20 + (40 - 30) / 2 = 25; drawImage y = -(imgY + imgHeight) = -(25 + 30)
            expect(y).toBeCloseTo(-55);
        });

        it('warns and skips (without crashing) when the data: URI is not valid base64', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><image href="data:image/png;base64,!!!not-valid-base64!!!" width="10" height="10"/></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/Do\b/);
        });

        it('warns and skips an external-URL <image> when no fetchImage function is provided (default: no network requests)', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
                rotation: 0,
            });
            expect(result.warnings.some((w) => w.includes('fetchImage'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/Do\b/);
        });

        it('embeds an external-URL <image> by calling the caller-supplied fetchImage', async () => {
            const doc = LibPDF.create();
            const pngBase64 = ONE_PIXEL_PNG_DATA_URI.slice(ONE_PIXEL_PNG_DATA_URI.indexOf(',') + 1);
            const bytes = new Uint8Array(Buffer.from(pngBase64, 'base64'));
            const fetchImage = vi.fn(async () => ({ bytes, mimeType: 'image/png' }));
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
                rotation: 0,
                fetchImage,
            });
            expect(fetchImage).toHaveBeenCalledWith('https://example.com/a.png');
            expect(result.warnings).toEqual([]);
            const content = getPageContentText(doc, 0);
            expect(content).toMatch(/\/\w+ Do/);
        });

        it('warns and skips (without crashing) when fetchImage throws or returns null', async () => {
            const doc = LibPDF.create();
            const result = await embedSvgInPdf(doc, {
                svgText:
                    '<svg viewBox="0 0 100 100"><image href="https://example.com/a.png" width="10" height="10"/></svg>',
                rotation: 0,
                fetchImage: async () => {
                    throw new Error('network error');
                },
            });
            expect(result.warnings.some((w) => w.includes('could not be fetched'))).toBe(true);
            const content = getPageContentText(doc, 0);
            expect(content).not.toMatch(/Do\b/);
        });

        it('never calls fetchImage for a non-external href, even if provided', async () => {
            const doc = LibPDF.create();
            const fetchImage = vi.fn();
            await embedSvgInPdf(doc, {
                svgText: `<svg viewBox="0 0 100 100"><image href="${ONE_PIXEL_PNG_DATA_URI}" width="10" height="10"/></svg>`,
                rotation: 0,
                fetchImage,
            });
            expect(fetchImage).not.toHaveBeenCalled();
        });
    });
});

const FIXTURES_DIR = path.resolve(process.cwd(), 'test-fixtures/custom');
const hasFixtures = fs.existsSync(FIXTURES_DIR);

const loadFixture = (name: string): string =>
    fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');

describe.skipIf(!hasFixtures)('embedSvgInPdf (real-world-shaped fixtures)', () => {
    it('embeds a minimal line icon as a single sized page', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('icon-line-simple.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        expect(doc.getPages()).toHaveLength(1);
        expect(doc.getPages()[0].width).toBeCloseTo(24);
    });

    it('embeds a flag-shaped SVG with visible fill content', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('star-ring.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        expect(content.length).toBeGreaterThan(1000);
    });

    it('embeds a stress-test mandala (220+ paths through a real matrix() root transform)', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('stress-mandala.svg'),
            rotation: 0,
        });
        expect(result.warnings).toEqual([]);
        const content = getPageContentText(doc, 0);
        const pushCount = (content.match(/\bq\b/g) ?? []).length;
        const popCount = (content.match(/\bQ\b/g) ?? []).length;
        expect(pushCount).toBe(popCount);
        expect(pushCount).toBeGreaterThan(200);
    }, 15000);

    it('embeds a kitchen-sink SVG (gradients/patterns/clip/mask/filter/text/CSS at once) without throwing', async () => {
        const doc = LibPDF.create();
        const result = await embedSvgInPdf(doc, {
            svgText: loadFixture('kitchen-sink.svg'),
            rotation: 0,
        });
        expect(doc.getPages()).toHaveLength(1);
        expect(doc.getPages()[0].width).toBeCloseTo(800);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('correctly sizes and scales a mm/viewBox-mismatched export', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText: loadFixture('libreoffice-export-sample.svg'),
            rotation: 0,
        });
        expect(doc.getPages()).toHaveLength(1);
        const page = doc.getPages()[0];
        // A4 landscape in points, not the un-converted 297 x 210.
        expect(page.width).toBeCloseTo(841.89, 0);
        expect(page.height).toBeCloseTo(595.28, 0);
        const content = getPageContentText(doc, 0);
        const match = content.match(/([\d.-]+) 0 0 (-?[\d.-]+) [\d.-]+ [\d.-]+ cm/);
        expect(match).not.toBeNull();
        // scale = drawWidth (≈841.89pt) / viewBoxWidth (29700) ≈ 0.02835, not / display width (297) ≈ 2.835 (100x too large).
        expect(Number(match![1])).toBeCloseTo(841.89 / 29700, 3);
        // @libpdf/core names every embedded XObject (images included) with an "Fm" prefix, not "Im".
        expect(content).toMatch(/\/\w+ Do/);
    });
});

describe('@libpdf/core content-stream isolation quirk (canary)', () => {
    it('still isolates the page’s first drawOperators() call once a second call arrives', () => {
        const doc = LibPDF.create();
        const page = doc.addPage({ width: 100, height: 100 });
        page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(2, 0, 0, 2, 0, 0)]);
        page.drawOperators([ops.pushGraphicsState(), ops.popGraphicsState()]);
        const content = getPageContentText(doc, 0);
        /*
         * If @libpdf/core ever stops isolating a page's first drawOperators()
         * call, this assertion fails — that's the signal to delete the no-op
         * first call workaround in svgEmbed.ts (see its comment) and this test.
         */
        expect(content).toMatch(/2 0 0 2 0 0 cm\s*\n?\s*Q/);
    });
});
