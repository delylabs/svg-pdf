/**
 * Parses an SVG document into a flat, worker-safe instruction list that
 * `embed.ts` replays as PDF drawing calls — no DOM/canvas rendering
 * involved, so this runs in the PDF worker like every other codec here.
 *
 * Two things a DOM-based parser would normally lean on — text measuring and
 * CSS `<style>` parsing — both require a real attached `document`, which
 * doesn't exist in a Web Worker, so both are hand-rolled here instead.
 * `<text>` (see the "best effort" doc comment above `walkTextElement` in
 * `parse/text.ts`) draws with PDF's own standard-14 fonts by default —
 * measuring/matching a real requested font only happens if the adapter
 * embedding the PDF supplies one (see `fontFaces` below). `<style>` block
 * support (see the doc comment above `CssRule` in `style/stylesheet.ts`)
 * handles real CSS selector matching — combinators, pseudo-classes,
 * attribute selectors, comma-separated lists, not just plain tag/class/id —
 * and a real specificity/source-order cascade, just without `!important`;
 * `@media`/`@keyframes` blocks are parsed and stripped rather than
 * evaluated, since a static PDF page has no viewport breakpoints or
 * animation timeline for them to apply to. `@font-face` rules with an
 * inline `data:` URI are also parsed (see `fontFaces` on
 * `ParsedSvgDocument`) — actually embedding them into the PDF as real fonts
 * is the adapter's job, not this package's, so it's exposed as parsed data
 * rather than acted on here.
 */

export type {
    BlendMode,
    FillRule,
    GradientPaintRef,
    ImageInstruction,
    LineCap,
    LineJoin,
    LinkStartInstruction,
    MarkerDef,
    MarkerInstruction,
    Paint,
    PaintOrder,
    PaintOrderElement,
    ParsedSvgDocument,
    ParsedSvgSize,
    PatternDef,
    PatternPaintRef,
    PreserveAspectRatioMode,
    PushClipInstruction,
    ShapeInstruction,
    ShapePaint,
    StandardFontName,
    SvgInstruction,
    TextAnchor,
    TextInstruction,
    TextPathInstruction,
    TextTransform,
    VectorEffect,
} from './types';

export {
    getMatrixScale,
    IDENTITY_MATRIX,
    invertMatrix,
    isIdentityMatrix,
    type Matrix2D,
    multiplyMatrix,
    parseTransformList,
    scaleMatrix,
    translateMatrix,
} from './geometry/matrix';

export {
    circleToPathData,
    computeShapeBBox,
    ellipseElToPathData,
    lineToPathData,
    polygonToPathData,
    polylineToPathData,
    rectToPathData,
    shapeToPathData,
} from './geometry/path';

export { computeMarkerVertices, type MarkerVertex } from './geometry/markerVertices';

export {
    computeViewBoxTransform,
    parsePreserveAspectRatio,
    type ParsedPreserveAspectRatio,
    type PreserveAspectRatioAlign,
    type PreserveAspectRatioMeetOrSlice,
} from './geometry/viewBox';

export {
    type BBoxRect,
    computePathBBox,
    type NormalizedPathSegment,
    normalizePathData,
} from './geometry/bbox';

export {
    computeCumulativeLengths,
    flattenPathToPolyline,
    type PathPoint,
    pointAtLength,
    type PointOnPath,
} from './geometry/pathLength';

export { parseSvgColor, type RgbColor } from './style/color';
export { DEFAULT_PAINT_ORDER, parsePaintOrder } from './style/paint';

export type {
    GradientDef,
    GradientStop,
    GradientUnits,
    LinearGradientDef,
    RadialGradientDef,
} from './style/gradient';

export type { PatternUnits } from './style/pattern';

export type { MarkerOrient, MarkerUnits, MarkerViewBox } from './style/marker';

export type { FontFaceDef } from './style/stylesheet';

export { parseSvgDocument, parseSvgRoot, resolveSvgSize } from './parse/document';
