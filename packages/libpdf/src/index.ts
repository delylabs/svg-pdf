/**
 * Embeds a `@delylabs/plotify`-parsed SVG into a `@libpdf/core` PDF document
 * as real vector drawing operators (paths, text, images, patterns/markers)
 * rather than a rasterized image — see `svgEmbed.ts` for how each SVG
 * instruction type maps onto PDF operators.
 */

export { embedSvgInPdf, type EmbedSvgResult, type FetchFont, type FetchImage } from './svgEmbed';
