import {
    type PdfArray,
    type PdfDict,
    type PdfRef,
    type PdfStream,
    PDF as LibPDF,
} from '@libpdf/core';

import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { getPageContentText, getXObjectContentText } from './helpers';

describe('embedSvgInPdf (markers)', () => {
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
                '<svg viewBox="0 0 100 100"><defs><marker id="dot" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2" fill="#0000ff"/></marker></defs><path d="M10,10 L50,10 L50,50" style="marker:url(#dot)"/></svg>',
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

    it('clips a marker Form XObject to its markerWidth/markerHeight viewport by default', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="1" markerHeight="1"><path d="M -1 -0.6 L 0.6 0 L -1 0.6 Z" fill="orange"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const [, xobjectName] = content.match(/\/(Fm\d+)\s+Do/) ?? [];
        const resources = doc.getPages()[0].dict.get('Resources') as PdfDict;
        const xobjectDict = resources.get('XObject') as PdfDict;
        const xobjectRef = xobjectDict.get(xobjectName!) as PdfRef;
        const xobjectStream = doc.getObject(xobjectRef) as PdfStream;
        // PDF's /BBox is [llx, lly, urx, ury] — for the 1x1 viewport at the origin this happens to equal [x, y, x+width, y+height] = [0, 0, 1, 1].
        const bboxArray = [...(xobjectStream.get('BBox') as PdfArray)].map(
            (n) => (n as { value: number }).value,
        );
        // The path's actual content (x from -1 to 0.6) extends well past the nominal 1x1 viewport — clipped to it by default (per spec, a <marker>'s content defaults to overflow: hidden).
        expect(bboxArray).toEqual([0, 0, 1, 1]);
    });

    it('grows the Form XObject bbox to fit the actual content for overflow="visible" instead of clipping to markerWidth/markerHeight', async () => {
        const doc = LibPDF.create();
        await embedSvgInPdf(doc, {
            svgText:
                '<svg viewBox="0 0 100 100"><defs><marker id="m" overflow="visible" markerWidth="1" markerHeight="1"><path d="M -1 -0.6 L 0.6 0 L -1 0.6 Z" fill="orange"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
            rotation: 0,
        });
        const content = getPageContentText(doc, 0);
        const [, xobjectName] = content.match(/\/(Fm\d+)\s+Do/) ?? [];
        const resources = doc.getPages()[0].dict.get('Resources') as PdfDict;
        const xobjectDict = resources.get('XObject') as PdfDict;
        const xobjectRef = xobjectDict.get(xobjectName!) as PdfRef;
        const xobjectStream = doc.getObject(xobjectRef) as PdfStream;
        // PDF's /BBox is [llx, lly, urx, ury] (corner coordinates, not x/y/width/height).
        const [llx, lly, urx, ury] = [...(xobjectStream.get('BBox') as PdfArray)].map(
            (n) => (n as { value: number }).value,
        );
        // Must actually contain the path's real extent (x: -1 to 0.6, y: -0.6 to 0.6), not just the nominal 1x1 viewport.
        expect(llx).toBeLessThanOrEqual(-1);
        expect(lly).toBeLessThanOrEqual(-0.6);
        expect(urx).toBeGreaterThanOrEqual(0.6);
        expect(ury).toBeGreaterThanOrEqual(0.6);
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
