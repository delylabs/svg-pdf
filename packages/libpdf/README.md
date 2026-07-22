# @svg-pdf/libpdf

Embeds an SVG document as real, sharp vector content into a PDF made with [`@libpdf/core`](https://libpdf.documenso.com/) — not a rasterized image, so it stays crisp at any zoom.

This package is an **adapter**: it parses SVG using [`@svg-pdf/core`](https://www.npmjs.com/package/@svg-pdf/core) (a DOM-free parser that turns SVG into a neutral instruction list) and translates the result into `@libpdf/core` drawing calls. Anything the parser can't handle is skipped individually with a warning, instead of failing the whole conversion.

## Install

`@libpdf/core` — the library that actually writes PDF files — is a **peer dependency**: it won't come along automatically, so install both yourself:

```
npm install @svg-pdf/libpdf @libpdf/core
```

This is done deliberately rather than bundling a private copy of `@libpdf/core`, because _you_ are the one who creates the PDF document object using `@libpdf/core` and then hands it to `@svg-pdf/libpdf` to draw into — if the two ended up using separately-installed copies of `@libpdf/core`, they wouldn't recognize each other's objects as "the same kind of thing," causing confusing bugs.

## Quick start

```ts
import { PDF as LibPDF } from '@libpdf/core';
import { embedSvgInPdf } from '@svg-pdf/libpdf';
import * as fs from 'fs';

const svgText = '<svg viewBox="0 0 200 100"><rect width="10" height="10"/></svg>';

const doc = LibPDF.create();
const { warnings } = await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    // optional: pageSize, orientation ('portrait' | 'landscape'), margin
});

if (warnings.length > 0) {
    console.warn('Unsupported SVG features were skipped:', warnings);
}

fs.writeFileSync('output.pdf', await doc.save());
```

Create an empty PDF document, call `embedSvgInPdf` to draw your SVG into it as one page, then save the PDF. `embedSvgInPdf` never throws just because your SVG uses an unsupported feature — it skips that one piece and adds a message to `warnings`. The only time it throws is if the SVG text itself can't be parsed (not valid XML).

## Fetching external `<image>` URLs

An `<image href="https://example.com/photo.png">` pointing at the web is **not** fetched by default — it's skipped with a warning instead. This is a deliberate safety default: automatically fetching arbitrary URLs found inside someone else's SVG could be abused to make your server request things it shouldn't reach (a class of attack called SSRF).

If you trust your SVGs, pass a `fetchImage` function and decide for yourself what's safe to fetch:

```ts
await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    fetchImage: async (url) => {
        const res = await fetch(url);
        if (!res.ok) return null;
        return {
            bytes: new Uint8Array(await res.arrayBuffer()),
            mimeType: res.headers.get('content-type') ?? 'image/png',
        };
    },
});
```

## Embedding custom fonts

By default, text is drawn using one of PDF's 14 built-in "standard" fonts (like Helvetica), matched to your SVG's `font-family`/`font-weight`/`font-style`. To embed a real, custom font instead, pass a `fetchFont` function — called once per distinct font actually used, not once per letter:

```ts
await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    fetchFont: async ({ fontFamily, fontWeight, fontStyle }) => {
        if (fontFamily === 'Poppins') return fs.readFileSync('./fonts/Poppins-Regular.ttf');
        return null; // falls back to the closest standard font
    },
});
```

If the SVG already embeds its own font inline via `@font-face { src: url(data:font/ttf;base64,...) }`, that's used automatically — no `fetchFont` needed.

## Embedding non-JPEG/PNG images

JPEG and PNG are embedded as-is. Any other format (WebP, for example) needs converting to PNG first — this happens automatically via `OffscreenCanvas` in a browser/Worker, but that API doesn't exist in plain Node.js. In Node, supply your own `normalizeImage` function (for example, using `sharp`):

```ts
import sharp from 'sharp';

await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    normalizeImage: async (bytes, mimeType) => sharp(bytes).png().toBuffer(),
});
```

`@svg-pdf/libpdf` deliberately doesn't bundle `sharp` or any other Node-only image library itself, to stay lightweight and runnable unmodified in a browser.

## Using the parser standalone

If you just want the parsed, structured representation of an SVG — without turning it into a PDF — use [`@svg-pdf/core`](https://www.npmjs.com/package/@svg-pdf/core) directly via its `parseSvgDocument` function.

## What's supported

Shapes and grouping, gradients and `<pattern>`, `<marker>`, `<clipPath>`, fills/strokes/blending, real CSS selector matching inside `<style>`, best-effort `<text>` including `<textPath>`, `<image>`, and `<a href>` link regions. The [supported-features doc](https://github.com/delylabs/svg-pdf/blob/main/docs/supported-features.md) in the repo has the full, up-to-date list of what's supported, what's out of scope and why, and what's not supported yet.

## License

MIT.
