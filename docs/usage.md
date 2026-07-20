# Usage

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

`embedSvgInPdf` never throws for unsupported SVG features — it skips them individually and reports each one in `warnings`. It only throws if the SVG itself fails to parse (malformed XML).

## Fetching external `<image>` URLs

By default, `<image>` elements with an external URL are skipped (with a warning) rather than fetched — svg-pdf never makes a network request on its own. That's a deliberate safety default: a server processing untrusted, user-supplied SVGs that blindly fetched every `<image href="...">` would be an SSRF vector (e.g. reaching a cloud metadata endpoint or an internal-only service).

To support them, pass a `fetchImage` function; you decide what's safe to fetch (an allowlist, a timeout, a proxy) since that depends entirely on where the SVG came from:

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

By default, `<text>` is drawn with one of PDF's 14 standard fonts, matched from the SVG's `font-family`/`font-weight`/`font-style` (e.g. a bold sans-serif family maps to `Helvetica-Bold`) — the SVG's actual requested font is never embedded.

To embed a real font instead, pass a `fetchFont` function. It's called once per distinct `font-family`/`font-weight`/`font-style` combination actually used in the SVG (not per character or per run), and should return the font's raw bytes, or `null` if you have no matching font — which falls back to the standard-14 choice, same as if `fetchFont` weren't passed at all:

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

A font declared inline in the SVG itself via `@font-face { font-family: "Poppins"; src: url(data:font/ttf;base64,...); }` is embedded automatically, with no `fetchFont` needed — it's already in the document, so there's nothing to fetch. If a `<text>`'s `font-family`/`font-weight`/`font-style` matches both an inline `@font-face` and what `fetchFont` would supply, the inline one wins (`fetchFont` isn't even called for it). An externally-hosted `@font-face src` (a plain URL, not `data:`) isn't fetched automatically — same reasoning as external `<image>` URLs — so use `fetchFont` for those instead.

## Using the parser standalone

`@svg-pdf/core` (the `core` package) can be used on its own via `parseSvgDocument` if you want the parsed instruction list without going through a PDF adapter — see `packages/core/src/index.ts` for its full exports.
