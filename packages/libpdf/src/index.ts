/**
 * Embeds a `@svg-pdf/core`-parsed SVG into a `@libpdf/core` PDF document
 * as real vector drawing operators (paths, text, images, patterns/markers)
 * rather than a rasterized image — see `embed.ts` for how each SVG
 * instruction type maps onto PDF operators.
 */

export { embedSvgInPdf, type EmbedSvgResult, type FetchFont, type FetchImage } from './embed';
