# Usage

## Before you start: installing `@libpdf/core`

`@svg-pdf/libpdf` needs `@libpdf/core` (the library that actually writes PDF files) to be installed in your own project too — it won't come along automatically when you install `@svg-pdf/libpdf`. So install both:

```sh
npm install @svg-pdf/libpdf @libpdf/core
```

This is a "peer dependency" — a fancy way of saying "this package expects _you_ to install this other package yourself, at a version you both agree on," instead of quietly bundling its own private copy. It's done this way because _you_ are the one who creates the PDF document object (`doc`, in the example below) using `@libpdf/core`, and then hand it to `@svg-pdf/libpdf` to draw into. If `@svg-pdf/libpdf` used a different, separately-installed copy of `@libpdf/core` internally, you could end up with two different copies of the same library in your project at once — which can cause confusing bugs, since the two copies don't recognize objects created by each other as "the same kind of thing." Installing it yourself avoids that entirely.

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

Step by step: create an empty PDF document, then call `embedSvgInPdf` to draw your SVG into it as one page, then save the PDF to a file (or wherever you need the bytes).

`embedSvgInPdf` is built to never throw an error just because your SVG uses some feature it doesn't support yet — it simply skips that one feature and adds a short message to `warnings`, so the rest of the SVG still renders. The _only_ time it throws is if the SVG text itself can't be parsed at all (e.g. it's not valid XML).

## Fetching external `<image>` URLs

If your SVG has an `<image href="https://example.com/photo.png">` pointing at an image on the web, `@svg-pdf/libpdf` will **not** fetch it by default — it skips it and adds a warning instead. This is a deliberate safety choice, not a missing feature.

Here's why: imagine a server that lets users upload arbitrary SVG files and converts them to PDF. If that server automatically fetched every `<image>` URL found inside, an attacker could craft an SVG pointing at an internal address the server can reach but the outside world can't (like a cloud provider's internal configuration endpoint) — tricking the server into leaking that data back out through the generated PDF. This class of attack is commonly called SSRF (Server-Side Request Forgery). Since `@svg-pdf/libpdf` doesn't know how much you trust the SVGs you're processing, the safe default is to never make network requests on its own.

If you _do_ trust your SVGs (or want to add your own safety checks), pass a `fetchImage` function and decide for yourself what's safe to fetch — for example, only allow certain domains, add a timeout, or route requests through a proxy:

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

By default, all text is drawn using one of PDF's 14 "standard" fonts — a fixed set of fonts (like Helvetica and Times) that every PDF reader is guaranteed to support without needing them embedded in the file. `@svg-pdf/libpdf` picks the closest match based on your SVG's `font-family`/`font-weight`/`font-style` (e.g. a bold sans-serif font maps to `Helvetica-Bold`). The actual font requested in the SVG is never embedded unless you ask for it.

To use a real, embedded font instead, pass a `fetchFont` function. It's called once for each distinct combination of `font-family`/`font-weight`/`font-style` actually used in the SVG (not once per letter or per line of text — that would be wasteful). It should return the font file's raw bytes, or `null` if you don't have a matching font — in which case it quietly falls back to the closest standard font, exactly as if you hadn't passed `fetchFont` at all:

```ts
await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    fetchFont: async ({ fontFamily, fontWeight, fontStyle }) => {
        if (fontFamily === 'Poppins') {
            return fs.readFileSync('./fonts/Poppins-Regular.ttf');
        }
        return null;
    },
});
```

There's one exception where you don't need `fetchFont` at all: if the SVG already embeds its own font data inline, via `@font-face { font-family: "Poppins"; src: url(data:font/ttf;base64,...); }`, that font is used automatically — the data is already sitting right there in the SVG, so there's nothing to fetch. If both an inline `@font-face` and your `fetchFont` function could supply the same font, the inline one wins and `fetchFont` isn't even called for it. If a `@font-face` instead points at an external URL (not inline `data:` bytes), it's treated the same as an external `<image>` above — not fetched automatically — so use `fetchFont` to supply that font yourself.

## Embedding non-JPEG/PNG images

JPEG and PNG images are embedded as-is — those are the two formats `@libpdf/core` can read directly, no extra work needed. Any other format (WebP, for example) needs to be converted to PNG first, which happens automatically through a browser/Web Worker feature called `OffscreenCanvas` (a way to draw and process images without needing an on-screen `<canvas>` element). This works out of the box in a browser or Web Worker, since `OffscreenCanvas` is built in there — but it does **not** exist in plain Node.js.

So, if you're running in Node.js and need to support image formats other than JPEG/PNG, you need to supply your own `normalizeImage` function that does the conversion — for example, using the popular `sharp` image library:

```ts
import sharp from 'sharp';

await embedSvgInPdf(doc, {
    svgText,
    rotation: 0,
    normalizeImage: async (bytes, mimeType) => sharp(bytes).png().toBuffer(),
});
```

`@svg-pdf/libpdf` deliberately doesn't include `sharp` (or any other Node-only image library) itself — that keeps it lightweight and able to run unmodified in a browser, where such libraries wouldn't work anyway. If you don't supply `normalizeImage` and a non-JPEG/PNG image shows up while running in Node, that one image is just skipped (with a warning) rather than crashing the whole PDF generation.

## Using the parser standalone

If you just want the parsed, structured representation of an SVG — without going through `@svg-pdf/libpdf` to turn it into a PDF — you can use `@svg-pdf/core` (the underlying parser package) directly via its `parseSvgDocument` function. See `packages/core/src/index.ts` for everything else it exports.
