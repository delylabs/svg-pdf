# Usage

## Quick start

```ts
import { PDF as LibPDF } from '@libpdf/core';
import { embedSvgInPdf } from '@delylabs/plotify-libpdf';
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

By default, `<image>` elements with an external URL are skipped (with a warning) rather than fetched — Plotify never makes a network request on its own. That's a deliberate safety default: a server processing untrusted, user-supplied SVGs that blindly fetched every `<image href="...">` would be an SSRF vector (e.g. reaching a cloud metadata endpoint or an internal-only service).

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

## Using the parser standalone

`@delylabs/plotify` (the `core` package) can be used on its own via `parseSvgDocument` if you want the parsed instruction list without going through a PDF adapter — see `packages/core/src/index.ts` for its full exports.
