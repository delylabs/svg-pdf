/**
 * Parses an SVG document into a flat, worker-safe instruction list that
 * `svgEmbed.ts` replays as PDF drawing calls — no DOM/canvas rendering
 * involved, so this runs in the PDF worker like every other codec here.
 *
 * Two things a DOM-based parser would normally lean on — text measuring and
 * CSS `<style>` cascade parsing — both require a real attached `document`,
 * which doesn't exist in a Web Worker, so both are hand-rolled here instead:
 * `<text>` (see the "best effort" doc comment above `walkTextElement` in
 * `parse/walk.ts`) draws with PDF's own standard-14 fonts rather than
 * measuring/matching real ones, and `<style>` block support (see the doc
 * comment above `CssRule` in `style/stylesheet.ts`) only covers simple
 * tag/class/id selectors, not the full CSS cascade.
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
} from './types';

export {
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
