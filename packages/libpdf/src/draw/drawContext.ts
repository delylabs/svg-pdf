import {
    type FontInput,
    ops,
    type PDF as LibPDF,
    type PDFFormXObject,
    type PDFPage,
} from '@libpdf/core';

import {
    type BlendMode,
    type FontFaceDef,
    type GradientDef,
    type MarkerDef,
    type Matrix2D,
    type PatternDef,
    type SvgInstruction,
    type TextInstruction,
} from '@svg-pdf/core';
import { type FetchFont, type FetchImage, type NormalizeImage } from '../svgEmbed';
import { buildMarkerFormXObject } from '../resources/marker';
import { type LinkTracker } from './linkAnnotations';
import { resolveTextLayout } from './textLayout';
import { type CharLayout } from './textLayout';

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
    readonly textCharLayout: WeakMap<TextInstruction, CharLayout>;
    readonly fetchImage: FetchImage | undefined;
    readonly normalizeImage: NormalizeImage;
    // Running x-cursor for <tspan>-without-its-own-x "flow" runs (see `continuesFlow`'s doc comment on `TextInstruction` in `@svg-pdf/core`'s types.ts) — only read when the next 'text' instruction is actually flagged, so unrelated text blocks never leak into each other.
    flowCursorX: number | null;
    /*
     * How many `<image>`-with-SVG-payload documents deep this context is
     * nested (0 for the top-level document). Used by `drawImage.ts` to cap
     * recursion against a self-referencing payload — see
     * `MAX_IMAGE_EMBED_DEPTH`.
     */
    readonly embedDepth: number;
}

/*
 * Assembles a full `DrawContext` for one parsed document (top-level or a
 * nested SVG-as-image payload). Each call builds its own `getMarkerXObject`
 * cache and resolves its own text layout, since marker `id`s and text runs
 * are only meaningful within the document they were parsed from — a nested
 * document must never resolve against the outer document's resources.
 * Shared, environment-level pieces (`doc`/`page`/`warnings`/`link`/
 * `getBlendModeGsName`/`fetchImage`/`normalizeImage`/`fetchFont`) are passed
 * through by the caller instead of rebuilt.
 */
export const buildDrawContext = async (options: {
    doc: LibPDF;
    page: PDFPage;
    warnings: string[];
    gradients: ReadonlyMap<string, GradientDef>;
    patterns: ReadonlyMap<string, PatternDef>;
    markers: ReadonlyMap<string, MarkerDef>;
    rootMatrix: Matrix2D;
    getBlendModeGsName: (mode: BlendMode) => string;
    link: LinkTracker;
    fetchImage: FetchImage | undefined;
    normalizeImage: NormalizeImage;
    fetchFont: FetchFont | undefined;
    instructions: readonly SvgInstruction[];
    fontFaces: readonly FontFaceDef[];
    embedDepth: number;
}): Promise<DrawContext> => {
    const {
        doc,
        page,
        warnings,
        gradients,
        patterns,
        markers,
        rootMatrix,
        getBlendModeGsName,
        link,
        fetchImage,
        normalizeImage,
        fetchFont,
        instructions,
        fontFaces,
        embedDepth,
    } = options;

    const markerXObjects = new Map<string, PDFFormXObject | null>();
    const getMarkerXObject = (markerId: string, def: MarkerDef): PDFFormXObject | null => {
        if (markerXObjects.has(markerId)) return markerXObjects.get(markerId) ?? null;
        const xobject = buildMarkerFormXObject(def, doc, warnings);
        markerXObjects.set(markerId, xobject);
        return xobject;
    };

    const { textWidths, textAnchorOffsets, textFonts, textCharLayout } = await resolveTextLayout(
        instructions,
        fontFaces,
        doc,
        fetchFont,
        warnings,
    );

    return {
        doc,
        page,
        warnings,
        gradients,
        patterns,
        markers,
        rootMatrix,
        getBlendModeGsName,
        getMarkerXObject,
        link,
        textWidths,
        textAnchorOffsets,
        textFonts,
        textCharLayout,
        fetchImage,
        normalizeImage,
        flowCursorX: null,
        embedDepth,
    };
};
