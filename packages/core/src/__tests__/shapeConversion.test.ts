import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

import { circleToPathData, polygonToPathData, rectToPathData } from '..';

const el = (svg: string): Element => {
    const doc = new XmlDomParser({ onError: () => {} }).parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement as unknown as Element;
    // xmldom doesn't implement `firstElementChild` (ElementTraversal) — filter childNodes for an actual element (nodeType 1) instead.
    return Array.from(root.childNodes).find((n): n is Element => n.nodeType === 1)!;
};

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
