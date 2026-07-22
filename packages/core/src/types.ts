import type { BBoxRect } from './geometry/bbox';
import type { Matrix2D } from './geometry/matrix';
import type { RgbColor } from './style/color';
import type { GradientDef } from './style/gradient';
import type { MarkerOrient, MarkerUnits, MarkerViewBox } from './style/marker';
import type { PatternUnits } from './style/pattern';
import type { FontFaceDef } from './style/stylesheet';

// --- Document parsing (viewBox / natural size) ---------------------------

export interface ParsedSvgSize {
    // Natural *display* size, in points — what the page becomes when no target pageSize is given.
    readonly width: number;
    readonly height: number;
    readonly viewBoxMinX: number;
    readonly viewBoxMinY: number;
    /*
     * The coordinate system every shape/text/image position in this document
     * is actually expressed in. Equal to `width`/`height` above whenever
     * there's no `viewBox`, or a `viewBox` that happens to share the same
     * numeric width/height (the overwhelmingly common case for hand-authored
     * icon SVGs) — but can differ hugely from it otherwise (e.g. a CAD/
     * LibreOffice Draw export with `width="297mm" viewBox="0 0 29700 21000"`,
     * a 1:100 ratio). embed.ts's root-matrix scale must divide by *this*,
     * never by the display `width`/`height` — dividing by the wrong one still
     * "works" (no crash) but silently scales all content by the wrong
     * factor, which if large enough effectively zooms into one corner of the
     * artwork instead of showing all of it.
     */
    readonly viewBoxWidth: number;
    readonly viewBoxHeight: number;
    // The root <svg>'s own raw `preserveAspectRatio` attribute (unparsed — embed.ts feeds it straight into `computeViewBoxTransform`), or `null` if absent (defaults to "xMidYMid meet").
    readonly preserveAspectRatio: string | null;
}

// --- Tree walking → drawing instructions ---------------------------------

export type FillRule = 'nonzero' | 'evenodd';
export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

/*
 * Matches @libpdf/core's own `BlendMode` type (PascalCase) rather than
 * importing it directly — this parsing layer stays independent of any one
 * PDF library, same as the rest of this file; embed.ts passes the value
 * straight through.
 */
export type BlendMode =
    | 'Normal'
    | 'Multiply'
    | 'Screen'
    | 'Overlay'
    | 'Darken'
    | 'Lighten'
    | 'ColorDodge'
    | 'ColorBurn'
    | 'HardLight'
    | 'SoftLight'
    | 'Difference'
    | 'Exclusion'
    | 'Hue'
    | 'Saturation'
    | 'Color'
    | 'Luminosity';

/*
 * A fill/stroke that resolved to `url(#id)` pointing at a multi-stop gradient
 * (0-stop resolves to `null`, 1-stop resolves directly to that stop's solid
 * color — both per spec — so this variant only ever appears for 2+ stops).
 */
export interface GradientPaintRef {
    readonly kind: 'gradient';
    readonly gradientId: string;
}

/*
 * A fill/stroke that resolved to `url(#id)` pointing at a <pattern> with a
 * positive width/height (a 0-size pattern renders nothing, per spec, so
 * never produces this variant — see `resolvePatternDef` in `parse/pattern.ts`).
 */
export interface PatternPaintRef {
    readonly kind: 'pattern';
    readonly patternId: string;
}

export type Paint = RgbColor | GradientPaintRef | PatternPaintRef | null;

export type PaintOrderElement = 'fill' | 'stroke' | 'markers';
export type PaintOrder = readonly PaintOrderElement[];

export type VectorEffect = 'none' | 'non-scaling-stroke';

export type TextAnchor = 'start' | 'middle' | 'end';

export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

/*
 * PDF's 14 built-in fonts — the only ones <text> support draws with (see the
 * `<text>` section below for why: no font embedding/matching subsystem).
 */
export type StandardFontName =
    | 'Helvetica'
    | 'Helvetica-Bold'
    | 'Helvetica-Oblique'
    | 'Helvetica-BoldOblique'
    | 'Times-Roman'
    | 'Times-Bold'
    | 'Times-Italic'
    | 'Times-BoldItalic'
    | 'Courier'
    | 'Courier-Bold'
    | 'Courier-Oblique'
    | 'Courier-BoldOblique';

export interface ShapePaint {
    readonly fill: Paint;
    readonly fillOpacity: number;
    readonly stroke: Paint;
    readonly strokeOpacity: number;
    readonly strokeWidth: number;
    readonly lineCap: LineCap;
    readonly lineJoin: LineJoin;
    // SVG's own default (4) differs from PDF's native default (10), so this is always resolved and applied explicitly rather than left to the PDF writer's own default.
    readonly miterLimit: number;
    readonly fillRule: FillRule;
    readonly dashArray: readonly number[] | null;
    readonly dashOffset: number;
    readonly paintOrder: PaintOrder;
    readonly vectorEffect: VectorEffect;
    readonly blendMode: BlendMode;
    readonly fontSize: number;
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    readonly textAnchor: TextAnchor;
    // Applied to a run's text content itself (before it becomes a TextInstruction), not carried into drawing — see `applyTextTransform` in style/paint.ts.
    readonly textTransform: TextTransform;
    readonly letterSpacing: number;
    readonly wordSpacing: number;
    /*
     * From `xml:space="preserve"` (checked directly on each element, not
     * via `readPresentation`/CSS — it's an XML attribute, not a stylable
     * property) or CSS `white-space: pre`. When true, `collectDirectText`
     * skips its usual whitespace-collapsing.
     */
    readonly preserveWhitespace: boolean;
    /*
     * From `visibility` (`hidden`/`collapse` -> false, `visible` -> true,
     * inherited otherwise) — unlike `display:none` (handled separately in
     * `parse/walk.ts` by skipping the subtree outright, since it also blocks
     * indirect rendering through `<use>`), an invisible element still has to
     * be walked: a `visibility:hidden` ancestor's descendant can turn itself
     * back on with its own `visibility:visible`, per spec. Each leaf
     * draw-instruction push site checks this directly instead of it being
     * threaded onto the instruction itself, since an invisible element never
     * produces an instruction at all.
     */
    readonly visible: boolean;
}

export interface ShapeInstruction extends ShapePaint {
    readonly type: 'shape';
    readonly d: string;
    /*
     * Absolute matrix from the viewBox root to this shape's own local space —
     * gradient/pattern matrices in PDF map to the page's default space
     * regardless of the current graphics-state CTM, so the adapter needs
     * this to position a gradient correctly (see `buildPatternMatrix` in
     * `@svg-pdf/libpdf`'s `resources/paint.ts`).
     */
    readonly groupMatrix: Matrix2D;
    // Local bounding box, computed lazily only for objectBoundingBox-units gradient/clip.
    readonly bbox: BBoxRect | null;
}

export interface PushClipInstruction {
    readonly type: 'pushClip';
    readonly paths: readonly string[];
    readonly clipRule: FillRule;
    /*
     * Set when clipPathUnits="objectBoundingBox" — the clip paths above are in
     * unit-square space and need this scale/translate to land on the target's bbox.
     */
    readonly bboxMatrix: Matrix2D | null;
}

/*
 * A single positioned run of text (one <text> or <tspan> with its own direct
 * text content) — see the `<text>` support section below for the scope this
 * covers and what it deliberately doesn't.
 */
export interface TextInstruction {
    readonly type: 'text';
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly fontSize: number;
    readonly font: StandardFontName;
    /*
     * The raw font-family/weight/style this run actually requested, before
     * `resolveStandardFont` collapsed it down to one of the 14 names above.
     * Unused by `font` support today (still standard-14 only), but kept
     * alongside it so a future font-embedding adapter can match against the
     * real request instead of an already-substituted fallback.
     */
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    readonly fill: RgbColor;
    readonly fillOpacity: number;
    readonly textAnchor: TextAnchor;
    /*
     * Extra spacing (in points, already resolved from any `em`/`normal`
     * source unit) added after every character (`letterSpacing`) or after
     * every literal space character (`wordSpacing`) — passed straight
     * through to PDF's own `Tc`/`Tw` text-state operators in
     * `draw/drawText.ts`, so measurement here must add the exact same
     * amount those operators will add at draw time (see `textWidths` in
     * `draw/textLayout.ts`).
     */
    readonly letterSpacing: number;
    readonly wordSpacing: number;
    /*
     * True for a <tspan> with no `x` of its own that isn't the first run in
     * its sequence — it should start exactly where the previous sibling's
     * rendered text ended, not at `x` above (which is just a same-position
     * fallback for when it's drawn in isolation). `draw/drawText.ts` resolves the
     * real position at draw time via a running cursor (needs `measureText`).
     */
    readonly continuesFlow: boolean;
    /*
     * False for a <tspan> with no `x`/`y` of its own that isn't the first run
     * in its sequence — it belongs to the same text chunk as the run before
     * it, so `text-anchor` must be resolved once for the whole chunk (total
     * advance width across every run in it) rather than per run. Distinct
     * from `continuesFlow`: an own `y` (no `x`) starts a new anchor chunk per
     * spec even though the x-cursor still isn't reset.
     */
    readonly startsNewChunk: boolean;
    /*
     * Per-character `dx`/`dy`/`rotate` lists (SVG allows one value per
     * character, not just a single shift for the whole run) — set only
     * when the run actually needs per-character drawing: 2+ `dx`/`dy`
     * values, or any `rotate` at all (PDF text rotation is a per-`Tj`-call
     * matrix, not per-glyph, so even one `rotate` value forces this path).
     * A single-value `dx`/`dy` list is mathematically identical to
     * shifting the whole run once (see `x`/`y` above), so it's folded into
     * those instead and these three stay `undefined` — the overwhelmingly
     * common case draws exactly as it did before this field existed.
     * Missing `dx`/`dy` entries default to 0 per character; a missing
     * `rotate` entry repeats the list's last value, both per spec. See
     * `draw/textLayout.ts`'s `computeCharLayout` for how these are walked.
     */
    readonly charDx?: readonly number[];
    readonly charDy?: readonly number[];
    readonly charRotate?: readonly number[];
}

/*
 * Text drawn along a `<textPath href="#id">`'s referenced `<path>` — kept
 * as its own instruction type rather than reusing `TextInstruction`
 * because per-character placement/rotation along a curve is fundamentally
 * different from a single positioned string, and (like the anchor-chunk
 * pre-pass and `<a>` link bboxing) genuinely needs `measureText`, which
 * this module deliberately never touches — so this instruction carries
 * everything the adapter needs (already-flattened path geometry, already-
 * resolved start distance) to do that character-by-character walk itself
 * (see `@svg-pdf/libpdf`'s `draw/drawTextPath.ts`).
 * `textLength` is supported in its default `lengthAdjust="spacing"` mode
 * (inter-character spacing is stretched/compressed to hit an exact total
 * length; glyphs themselves stay their natural width) — see `textLength`
 * below. `lengthAdjust="spacingAndGlyphs"` (which would also resize the
 * glyphs) and nested `<tspan>` children inside a `<textPath>` are out of
 * scope — only the `<textPath>` element's own direct text content is used.
 */
export interface TextPathInstruction {
    readonly type: 'textPath';
    readonly text: string;
    // Flattened polyline approximation of the referenced <path>'s `d`, and its cumulative per-point length — see `geometry/pathLength.ts`.
    readonly points: readonly { readonly x: number; readonly y: number }[];
    readonly cumLengths: readonly number[];
    // Already resolved from `startOffset` (px or %) and the referenced path's own `pathLength` rescaling, if any — an absolute distance along `points`/`cumLengths`' units.
    readonly startDistance: number;
    readonly fontSize: number;
    readonly font: StandardFontName;
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    readonly fill: RgbColor;
    readonly fillOpacity: number;
    readonly textAnchor: TextAnchor;
    readonly letterSpacing: number;
    readonly wordSpacing: number;
    // Resolved `textLength` (plain number or % of the path's total length), or null if absent/invalid — see the doc comment above.
    readonly textLength: number | null;
    readonly lengthAdjust?: 'spacing' | 'spacingAndGlyphs';
    readonly continuesFlow: boolean;
    readonly startsNewChunk: boolean;
}

/*
 * "meet" (the SVG default: scale uniformly to fit within the box, centered)
 * is the only fit mode implemented — "slice" (scale to fill, cropping
 * overflow) falls back to "meet" with a warning; align keywords other than
 * the default (xMidYMid) aren't distinguished at all. "none" (stretch,
 * ignoring aspect ratio) is trivial to support exactly, so it is.
 */
export type PreserveAspectRatioMode = 'none' | 'meet';

// A raster <image>. `href` may be an inline `data:` URI or an external URL — see the doc comment above its parsing in walk.ts. "slice" preserveAspectRatio is deliberately out of scope.
export interface ImageInstruction {
    readonly type: 'image';
    readonly href: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly preserveAspectRatio: PreserveAspectRatioMode;
    readonly opacity: number;
}

/*
 * One marker-start/-mid/-end placement along a path/line/polyline/polygon —
 * see `computeMarkerVertices` (geometry/markerVertices.ts) for how vertex
 * position/tangent angle are derived, and `resolveMarkerDef`/the `<marker>`
 * placement code in `parse/marker.ts` for how `angle`/`scale` fold in the
 * marker's own `orient`/`markerUnits`. `x`/`y`/`angle` are in the referencing
 * shape's own local (pre-transform) space, same as `ShapeInstruction.d` —
 * an adapter draws a marker exactly where it draws the shape's path, under
 * the same ambient transform, no separate matrix needed (unlike gradients/
 * patterns — a marker is painted as an ordinary positioned XObject, not a
 * fill/stroke paint anchored to the page's absolute space).
 */
export interface MarkerInstruction {
    readonly type: 'marker';
    readonly markerId: string;
    readonly x: number;
    readonly y: number;
    readonly angle: number;
    // Already resolved from the marker's markerUnits: the referencing shape's strokeWidth, or 1 for userSpaceOnUse.
    readonly scale: number;
}

/*
 * Brackets an `<a href="...">`'s subtree, same shape as pushMatrix/popMatrix
 * — everything drawn between a `linkStart`/`linkEnd` pair should become one
 * clickable region in the output PDF. Not resolved into a single rect here:
 * an adapter needs its own drawing-time coordinate math (accumulating each
 * inner shape/text/image's rendered extent under the ambient transform) to
 * turn this into a PDF link annotation, the same reason gradients need
 * `ShapeInstruction.groupMatrix` rather than a plain absolute box — so this
 * stays a bracket instead of a precomputed rect. A `href="#fragment"` (no
 * cross-page target makes sense for a single-page-per-SVG PDF) never
 * produces this instruction at all — see `resolveLinkHref` in `parse/text.ts`.
 */
export interface LinkStartInstruction {
    readonly type: 'linkStart';
    readonly href: string;
}

export type SvgInstruction =
    | { readonly type: 'pushMatrix'; readonly matrix: Matrix2D }
    | { readonly type: 'popMatrix' }
    | PushClipInstruction
    | { readonly type: 'popClip' }
    | ShapeInstruction
    | TextInstruction
    | TextPathInstruction
    | ImageInstruction
    | MarkerInstruction
    | LinkStartInstruction
    | { readonly type: 'linkEnd' };

/*
 * A resolved <pattern>'s tile geometry plus its content, already walked into
 * the same flat instruction list shapes/groups/text/images use elsewhere in
 * this file — see `resolvePatternDef` in `parse/pattern.ts` for how it's built,
 * and `@svg-pdf/libpdf`'s pattern module for how a PDF adapter turns
 * it into an actual tiling pattern (a real library constraint scopes which of
 * these instruction types it can honor inside a pattern cell — not every
 * adapter needs to support the same subset core parses here).
 */
export interface PatternDef {
    readonly patternUnits: PatternUnits;
    readonly patternContentUnits: PatternUnits;
    // In patternUnits space (a 0-1 fraction of the referencing shape's bbox for the objectBoundingBox default, or absolute for userSpaceOnUse).
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly patternTransform: Matrix2D;
    readonly instructions: readonly SvgInstruction[];
}

/*
 * A resolved <marker>'s geometry (viewport size/units, reference point,
 * default orientation) plus its content, walked the same way `PatternDef`'s
 * is — see `resolveMarkerDef` in `parse/marker.ts`.
 */
export interface MarkerDef {
    readonly refX: number;
    readonly refY: number;
    readonly markerWidth: number;
    readonly markerHeight: number;
    readonly markerUnits: MarkerUnits;
    readonly orient: MarkerOrient;
    readonly viewBox: MarkerViewBox | null;
    readonly overflowVisible: boolean;
    readonly instructions: readonly SvgInstruction[];
}

export interface ParsedSvgDocument extends ParsedSvgSize {
    readonly instructions: SvgInstruction[];
    readonly warnings: string[];
    readonly gradients: ReadonlyMap<string, GradientDef>;
    readonly patterns: ReadonlyMap<string, PatternDef>;
    readonly markers: ReadonlyMap<string, MarkerDef>;
    readonly fontFaces: readonly FontFaceDef[];
}
