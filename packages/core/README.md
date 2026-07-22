# @svg-pdf/core

Parses an SVG document into a flat instruction list that isn't tied to any specific PDF library — no DOM/canvas rendering involved, so it runs the same in Node, the browser, and a Web Worker.

On its own, this package doesn't produce a PDF file — it just reads SVG and hands back a neutral, structured description of what to draw (shapes, gradients, text, etc., plus a list of anything it had to skip). Turning that into an actual PDF is the job of a separate **adapter** package, one per PDF library — for example [`@svg-pdf/libpdf`](https://www.npmjs.com/package/@svg-pdf/libpdf), which targets [`@libpdf/core`](https://libpdf.documenso.com/). This split exists so the parsing logic isn't tied to any one PDF library, and so it can run somewhere a full DOM isn't available, like a Web Worker.

## Install

```
npm install @svg-pdf/core
```

Also available as a standalone browser bundle (no build tool or npm install needed) via CDN:

```html
<script src="https://unpkg.com/@svg-pdf/core"></script>
<script>
    const doc = SvgPdfCore.parseSvgDocument(svgText);
</script>
```

## Usage

```ts
import { parseSvgDocument } from '@svg-pdf/core';

const doc = parseSvgDocument('<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>');

console.log(doc.instructions); // flat instruction list, ready for an adapter to draw
console.log(doc.warnings); // anything the parser had to skip, with a plain-English reason
```

`parseSvgDocument` never throws just because your SVG uses a feature it doesn't support yet — it skips that one piece and records a warning, so the rest of the document still comes through. The only time it throws is if the SVG text itself isn't valid XML.

## What's supported

Shapes and grouping (`<path>`, `<rect>`, `<circle>`, `<g>`, `<use>`, `<symbol>`, `<switch>`, nested `<svg>`, transforms), linear/radial gradients and `<pattern>`, `<marker>` (arrowheads and dots on line vertices), `<clipPath>`, fills/strokes/blending (`fill-rule`, dash patterns, `mix-blend-mode`, etc.), real CSS selector matching inside `<style>` (not just simple tag/class/id), best-effort `<text>` including `<textPath>`, `<image>` (including an SVG payload embedded inside another SVG), and `<a href>` link regions.

There are a handful of documented limits too — some are deliberate design choices (e.g. `@libpdf/core`-specific constraints on adapters), some are features not implemented yet. The [supported-features doc](https://github.com/delylabs/svg-pdf/blob/main/docs/supported-features.md) in the repo has the full, up-to-date list of what's supported, what's out of scope and why, and what's not supported yet.

## License

MIT.
