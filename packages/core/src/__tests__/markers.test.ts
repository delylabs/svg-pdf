import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { markersOf } from './helpers';

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
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" style="marker:url(#m)"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(2);
    });

    it('lets an explicit marker-mid="none" override the `marker` shorthand for just that position', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><path d="M0,0 L10,0 L20,0" style="marker:url(#m)" marker-mid="none"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(2);
        expect(markersOf(doc).every((m) => m.markerId === 'm')).toBe(true);
    });

    it('ignores a bare marker="..." XML attribute (the shorthand is CSS-only — only style/CSS is honored, matching browsers)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker="url(#m)"/></svg>',
        );
        expect(markersOf(doc)).toHaveLength(0);
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

    it('defaults overflowVisible to false (clipped), and reads overflow="visible" when set', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="a" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker><marker id="b" overflow="visible" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#a)" marker-end="url(#b)"/></svg>',
        );
        expect(doc.markers.get('a')?.overflowVisible).toBe(false);
        expect(doc.markers.get('b')?.overflowVisible).toBe(true);
    });

    it('inherits overflowVisible from another <marker> via href when not set on the referencing marker', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="base" overflow="visible" markerWidth="4" markerHeight="4"><circle cx="2" cy="2" r="2"/></marker><marker id="m" href="#base"/></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
        );
        expect(doc.markers.get('m')?.overflowVisible).toBe(true);
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

    it('flips only the marker-start instance 180° for orient="auto-start-reverse" (marker-mid/-end unaffected)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><circle cx="2" cy="2" r="2"/></marker></defs><path d="M0,0 L10,0 L20,0" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/></svg>',
        );
        const markers = markersOf(doc);
        const start = markers.find((m) => m.type === 'marker' && m.x === 0);
        const mid = markers.find((m) => m.type === 'marker' && m.x === 10);
        const end = markers.find((m) => m.type === 'marker' && m.x === 20);
        // The path points straight along +x (angle 0), so a plain "auto" marker-start would also be 0 — reversed, it should be π (or -π).
        expect(Math.abs(start && 'angle' in start ? start.angle : NaN)).toBeCloseTo(Math.PI);
        expect(mid && 'angle' in mid ? mid.angle : NaN).toBeCloseTo(0);
        expect(end && 'angle' in end ? end.angle : NaN).toBeCloseTo(0);
    });

    it('warns and skips a marker that references itself (a reference cycle)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><marker id="m" markerWidth="4" markerHeight="4"><line x1="0" y1="0" x2="1" y2="1" marker-start="url(#m)"/></marker></defs><line x1="0" y1="0" x2="10" y2="0" marker-start="url(#m)"/></svg>',
        );
        expect(doc.warnings.some((w) => w.includes('forms a cycle'))).toBe(true);
    });
});
