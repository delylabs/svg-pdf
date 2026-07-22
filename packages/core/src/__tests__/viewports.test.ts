import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';
import { shapesOf } from './helpers';

describe('parseSvgDocument (nested svg)', () => {
    it('places a nested <svg> at its x/y offset and scales its viewBox to fit width/height', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 400 200"><svg x="10" y="20" width="100" height="50" viewBox="0 0 50 25"><rect width="50" height="25" fill="#ff0000"/></svg></svg>',
        );
        const types = doc.instructions.map((i) => i.type);
        expect(types).toEqual([
            'pushMatrix',
            'pushClip',
            'pushMatrix',
            'shape',
            'popMatrix',
            'popClip',
            'popMatrix',
        ]);
        const offsetPush = doc.instructions[0];
        if (offsetPush.type !== 'pushMatrix') throw new Error('unreachable');
        expect(offsetPush.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
        const viewBoxPush = doc.instructions[2];
        if (viewBoxPush.type !== 'pushMatrix') throw new Error('unreachable');
        // 100/50 = 2, 50/25 = 2 — uniform 2x scale here, no translate since viewBox origin is 0,0.
        expect(viewBoxPush.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    });

    it('letterboxes an aspect-mismatched nested <svg> viewBox by default, rather than stretching it', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 400 200"><svg width="40" height="20" viewBox="0 0 10 10"><rect width="10" height="10"/></svg></svg>',
        );
        const viewBoxPush = doc.instructions.find(
            (i) => i.type === 'pushMatrix' && i.matrix.a === i.matrix.d,
        );
        if (!viewBoxPush || viewBoxPush.type !== 'pushMatrix') throw new Error('unreachable');
        // 40x20 viewport, 10x10 viewBox: width ratio 4, height ratio 2 — meet picks the smaller (2).
        expect(viewBoxPush.matrix.a).toBe(2);
        expect(viewBoxPush.matrix.d).toBe(2);
        expect(viewBoxPush.matrix.e).toBe(10); // (40 - 10*2) / 2, centered
    });

    it('clips content to the nested viewport by default (a rect the size of width/height)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><svg width="20" height="10" viewBox="0 0 20 10"><rect width="20" height="10"/></svg></svg>',
        );
        const pushClip = doc.instructions.find((i) => i.type === 'pushClip');
        if (!pushClip || pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toEqual(['M 0 0 H 20 V 10 H 0 Z']);
    });

    it('skips the viewport clip for overflow="visible"', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><svg width="20" height="10" overflow="visible"><rect width="20" height="10"/></svg></svg>',
        );
        expect(doc.instructions.some((i) => i.type === 'pushClip')).toBe(false);
    });

    it('also skips the viewport clip for overflow="auto" (behaves like "visible" here)', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><svg width="20" height="10" overflow="auto"><rect width="20" height="10"/></svg></svg>',
        );
        expect(doc.instructions.some((i) => i.type === 'pushClip')).toBe(false);
    });

    it('defaults a nested <svg> without explicit width/height to 100% of the parent viewport', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><svg><rect width="10" height="10"/></svg></svg>',
        );
        expect(doc.instructions.some((i) => i.type === 'shape')).toBe(true);
        const pushClip = doc.instructions.find((i) => i.type === 'pushClip');
        if (!pushClip || pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toEqual(['M 0 0 H 100 V 100 H 0 Z']);
    });

    it("resolves a nested <svg>'s percentage width/height/x/y against the parent viewport", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 200 100"><svg x="10%" y="20%" width="50%" height="50%"><rect width="10" height="10"/></svg></svg>',
        );
        const offsetPush = doc.instructions[0];
        if (offsetPush.type !== 'pushMatrix') throw new Error('unreachable');
        expect(offsetPush.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 });
        const pushClip = doc.instructions.find((i) => i.type === 'pushClip');
        if (!pushClip || pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toEqual(['M 0 0 H 100 V 50 H 0 Z']);
    });

    it("resolves a shape's own percentage geometry inside a nested <svg> against that nested viewport, not the root's", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 400 400"><svg width="40" height="40"><rect width="50%" height="50%" fill="#00ff00"/></svg></svg>',
        );
        const shape = shapesOf(doc).find((s) => s.fill && 'r' in s.fill && s.fill.g === 255);
        expect(shape?.d).toBe('M 0 0 H 20 V 20 H 0 Z');
    });

    it("resolves a shape's percentage geometry against a nested <svg>'s own viewBox, not its pre-scale width/height", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 400 400"><svg width="40" height="40" viewBox="0 0 10 10"><rect width="50%" height="50%" fill="#00ff00"/></svg></svg>',
        );
        const shape = shapesOf(doc).find((s) => s.fill && 'r' in s.fill && s.fill.g === 255);
        expect(shape?.d).toBe('M 0 0 H 5 V 5 H 0 Z');
    });

    it('lets a <use> reference a shape inside a nested <svg>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><svg width="50" height="50"><rect id="box" width="10" height="10" fill="#00ff00"/></svg><use href="#box" x="20" y="20"/></svg>',
        );
        expect(shapesOf(doc).some((s) => s.fill && 'r' in s.fill && s.fill.g === 255)).toBe(true);
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

    it('renders nothing (not "unclipped") when no clip child survives, with a warning', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><text>nope</text></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        // A valid <clipPath> that resolves to zero usable paths clips away everything, per spec -- the opposite of "no clip-path at all".
        expect(doc.instructions).toHaveLength(0);
        expect(doc.warnings.some((w) => w.includes('<text>'))).toBe(true);
    });

    it("bakes a clip child's own transform directly into its path coordinates", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="0" cy="0" r="20" transform="translate(50,50)"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushClip', 'shape', 'popClip']);
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toHaveLength(1);
        // Circle's own first point (20,0) shifted by translate(50,50) -> (70,50).
        expect(pushClip.paths[0].startsWith('M 70 50')).toBe(true);
    });

    it('warns and skips (draws unclipped) when clip-path target is missing', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><rect width="10" height="10" clip-path="url(#missing)"/></svg>',
        );
        // A broken url(#id) reference means "as if clip-path weren't specified" per spec -- unlike an empty-but-valid <clipPath>, this draws normally.
        expect(doc.instructions.map((i) => i.type)).toEqual(['shape']);
        expect(doc.warnings.some((w) => w.includes('not found'))).toBe(true);
    });

    it('resolves a <use> referencing shared shape geometry inside a <clipPath>', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><circle id="shape" cx="50" cy="50" r="20"/><clipPath id="c"><use href="#shape"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        expect(doc.instructions.map((i) => i.type)).toEqual(['pushClip', 'shape', 'popClip']);
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toHaveLength(1);
    });

    it("bakes a <use>'s own x/y offset into the referenced shape's path inside a <clipPath>", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><circle id="shape" cx="0" cy="0" r="20"/><clipPath id="c"><use href="#shape" x="10"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        // Circle's own first point (20,0) shifted by the <use>'s x="10" -> (30,0).
        expect(pushClip.paths[0].startsWith('M 30 0')).toBe(true);
    });

    it('recurses into a <g> wrapping multiple clip shapes', () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><g><circle cx="30" cy="30" r="10"/><rect x="50" y="50" width="10" height="10"/></g></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        expect(pushClip.paths).toHaveLength(2);
    });

    it("bakes a <g>'s own transform into its children's paths inside a <clipPath>", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><clipPath id="c"><g transform="translate(10,10)"><circle cx="30" cy="30" r="10"/></g></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        // Circle's own first point (cx+r, cy) = (40,30) shifted by the <g>'s translate(10,10) -> (50,40).
        expect(pushClip.paths[0].startsWith('M 50 40')).toBe(true);
    });

    it("bakes nested <g>/<use> transforms and a referenced shape's own transform together", () => {
        const doc = parseSvgDocument(
            '<svg viewBox="0 0 100 100"><defs><circle id="shape" cx="0" cy="0" r="10" transform="translate(5,0)"/><clipPath id="c"><g transform="translate(20,0)"><use href="#shape" x="0" y="20"/></g></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/></svg>',
        );
        const pushClip = doc.instructions[0];
        if (pushClip.type !== 'pushClip') throw new Error('unreachable');
        // Circle's own first point (10,0) -> shape's own transform (+5,0)=(15,0) -> <use> x/y (0,20)=(15,20) -> <g> transform (+20,0)=(35,20).
        expect(pushClip.paths[0].startsWith('M 35 20')).toBe(true);
    });
});
