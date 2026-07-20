import type { BBoxRect } from './geometry/bbox';
import type { Matrix2D } from './geometry/matrix';
import type { RgbColor } from './style/color';
import type { GradientDef } from './style/gradient';
import type { MarkerOrient, MarkerUnits, MarkerViewBox } from './style/marker';
import type { PatternUnits } from './style/pattern';

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
     * a 1:100 ratio). svgEmbed.ts's root-matrix scale must divide by *this*,
     * never by the display `width`/`height` — dividing by the wrong one still
     * "works" (no crash) but silently scales all content by the wrong
     * factor, which if large enough effectively zooms into one corner of the
     * artwork instead of showing all of it.
     */
    readonly viewBoxWidth: number;
    readonly viewBoxHeight: number;
}

// --- Tree walking → drawing instructions ---------------------------------

export type FillRule = 'nonzero' | 'evenodd';
export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

/*
 * Matches @libpdf/core's own `BlendMode` type (PascalCase) rather than
 * importing it directly — this parsing layer stays library-agnostic, same as
 * the rest of this file; svgEmbed.ts passes the value straight through.
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
 * never produces this variant — see `resolvePatternDef` in `parse/walk.ts`).
 */
export interface PatternPaintRef {
    readonly kind: 'pattern';
    readonly patternId: string;
}

export type Paint = RgbColor | GradientPaintRef | PatternPaintRef | null;

export type TextAnchor = 'start' | 'middle' | 'end';

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
    readonly fillRule: FillRule;
    readonly dashArray: readonly number[] | null;
    readonly dashOffset: number;
    readonly blendMode: BlendMode;
    readonly fontSize: number;
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    readonly textAnchor: TextAnchor;
}

export interface ShapeInstruction extends ShapePaint {
    readonly type: 'shape';
    readonly d: string;
    /*
     * Absolute matrix from the viewBox root to this shape's own local space —
     * gradient/pattern matrices in PDF map to the page's default space
     * regardless of the current graphics-state CTM, so svgEmbed.ts needs this
     * to position a gradient correctly (see the module doc comment there).
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
    readonly fill: RgbColor;
    readonly fillOpacity: number;
    readonly textAnchor: TextAnchor;
    /*
     * True for a <tspan> with no `x` of its own that isn't the first run in
     * its sequence — it should start exactly where the previous sibling's
     * rendered text ended, not at `x` above (which is just a same-position
     * fallback for when it's drawn in isolation). svgEmbed.ts resolves the
     * real position at draw time via a running cursor (needs `measureText`).
     */
    readonly continuesFlow: boolean;
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
 * placement code in `parse/walk.ts` for how `angle`/`scale` fold in the
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

export type SvgInstruction =
    | { readonly type: 'pushMatrix'; readonly matrix: Matrix2D }
    | { readonly type: 'popMatrix' }
    | PushClipInstruction
    | { readonly type: 'popClip' }
    | ShapeInstruction
    | TextInstruction
    | ImageInstruction
    | MarkerInstruction;

/*
 * A resolved <pattern>'s tile geometry plus its content, already walked into
 * the same flat instruction list shapes/groups/text/images use elsewhere in
 * this file — see `resolvePatternDef` in `parse/walk.ts` for how it's built,
 * and `@delylabs/plotify-libpdf`'s pattern module for how a PDF adapter turns
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
 * is — see `resolveMarkerDef` in `parse/walk.ts`.
 */
export interface MarkerDef {
    readonly refX: number;
    readonly refY: number;
    readonly markerWidth: number;
    readonly markerHeight: number;
    readonly markerUnits: MarkerUnits;
    readonly orient: MarkerOrient;
    readonly viewBox: MarkerViewBox | null;
    readonly instructions: readonly SvgInstruction[];
}

export interface ParsedSvgDocument extends ParsedSvgSize {
    readonly instructions: SvgInstruction[];
    readonly warnings: string[];
    readonly gradients: ReadonlyMap<string, GradientDef>;
    readonly patterns: ReadonlyMap<string, PatternDef>;
    readonly markers: ReadonlyMap<string, MarkerDef>;
}
