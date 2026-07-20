import {
    type FontInput,
    ops,
    type PDF as LibPDF,
    type PDFFormXObject,
    type PDFPage,
} from '@libpdf/core';

import {
    type BlendMode,
    type GradientDef,
    type MarkerDef,
    type Matrix2D,
    type PatternDef,
    type TextInstruction,
} from '@delylabs/plotify';
import { type FetchImage } from '../svgEmbed';
import { type LinkTracker } from './linkAnnotations';

export const concat = (m: Matrix2D): ReturnType<typeof ops.concatMatrix> =>
    ops.concatMatrix(m.a, m.b, m.c, m.d, m.e, m.f);

// Counter-flips the ambient CTM's inherited Y-flip for anything (text glyphs, image XObjects) whose own "up" direction isn't transform-agnostic like a filled path is — see the doc comments at each call site.
export const FLIP_Y: Matrix2D = { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };

/*
 * Bundles the resources every instruction-drawing handler (`drawShape.ts`,
 * `drawText.ts`, etc.) needs, mirroring the role `WalkContext` plays in
 * core's own `parse/` split. Unlike `WalkContext`, most of this is set up
 * once by `embedSvgInPdf` and never changes — `flowCursorX` is the one
 * field a handler (`drawText`) both reads and writes across separate
 * instructions. The ambient CTM deliberately isn't a field here: it's only
 * mutated by `pushMatrix`/`popMatrix`, which stay inline in `svgEmbed.ts`'s
 * own loop, and is instead passed as an explicit parameter to whichever
 * handlers need to read it (for link-bbox purposes).
 */
export interface DrawContext {
    readonly doc: LibPDF;
    readonly page: PDFPage;
    readonly warnings: string[];
    readonly gradients: ReadonlyMap<string, GradientDef>;
    readonly patterns: ReadonlyMap<string, PatternDef>;
    readonly markers: ReadonlyMap<string, MarkerDef>;
    readonly rootMatrix: Matrix2D;
    readonly getBlendModeGsName: (mode: BlendMode) => string;
    readonly getMarkerXObject: (markerId: string, def: MarkerDef) => PDFFormXObject | null;
    readonly link: LinkTracker;
    readonly textWidths: WeakMap<TextInstruction, number>;
    readonly textAnchorOffsets: WeakMap<TextInstruction, number>;
    readonly textFonts: WeakMap<TextInstruction, FontInput>;
    readonly fetchImage: FetchImage | undefined;
    // Running x-cursor for <tspan>-without-its-own-x "flow" runs (see `continuesFlow`'s doc comment in svgCodec.ts) — only read when the next 'text' instruction is actually flagged, so unrelated text blocks never leak into each other.
    flowCursorX: number | null;
}
