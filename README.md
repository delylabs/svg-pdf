# svg-pdf

`@svg-pdf/core` — a worker-safe, PDF-engine-agnostic SVG-to-PDF vector parser.

**Status:** pre-release (`0.x`), not yet published to npm.

## Motivation

Turning an SVG into a real PDF vector — not a rasterized image, so it stays sharp at any zoom — is a common need (icons, logos, exported diagrams) with a few different approaches in the JS ecosystem: some tools rasterize via a headless browser, some go through canvas-to-PNG, and some embed true vector paths. Each trade-off suits different use cases.

For real vector embedding specifically, two established options exist, each tied to one PDF library: [`svg2pdf.js`](https://github.com/yWorks/svg2pdf.js) (paired with `jsPDF`, browser-oriented) and [`svg-to-pdfkit`](https://github.com/alafr/SVG-to-PDFKit) (paired with `PDFKit`, Node-oriented and DOM-free). Both are mature, widely used tools, but `svg2pdf.js`'s architecture has two specific constraints that partly motivated svg-pdf's own design: two of its modules call `document.createElement`/`document.implementation.createHTMLDocument` directly, so it can't run in a Web Worker, and its drawing calls are written straight against `jsPDF`'s API, so targeting a different PDF library means rewriting that layer.

svg-pdf takes a different structural approach: a DOM-free core (`DOMParser` only) that parses SVG into a neutral instruction list, plus separate **adapter** packages that translate that list into calls for one specific PDF library. Anything the parser can't handle is skipped individually with a collected warning instead of failing the whole conversion.

## Usage

```ts
import { PDF as LibPDF } from '@libpdf/core';
import { embedSvgInPdf } from '@svg-pdf/libpdf';
import * as fs from 'fs';

const svgText = '<svg viewBox="0 0 200 100"><rect width="10" height="10"/></svg>';

const doc = LibPDF.create();
const { warnings } = await embedSvgInPdf(doc, { svgText, rotation: 0 });

fs.writeFileSync('output.pdf', await doc.save());
```

See [`docs/usage.md`](docs/usage.md) for the full API (page size/orientation/margin options, fetching external `<image>` URLs, using the parser standalone).

## Package layout

```
packages/
  core/     @svg-pdf/core     Parses SVG into a flat instruction list.
  libpdf/   @svg-pdf/libpdf   Adapter for @libpdf/core.
```

Future adapters follow the same pattern, named after the library they target, for example: `@svg-pdf/jspdf`, `@svg-pdf/pdfkit`, etc.

> `@libpdf/core` is named here only to describe compatibility — svg-pdf is not affiliated with or endorsed by that project.

MIT licensed (see `LICENSE`; third-party code this project ports from is credited in `THIRD_PARTY_NOTICES.md`). Not set up yet: CI, npm publishing.

## Supported

Shapes, groups, `<use>`/`<symbol>`, nested `<svg>`, gradients, `<pattern>`, `<marker>`, `<clipPath>`, `<style>` (simple selectors), best-effort `<text>`, and `<image>` — with a handful of documented scope limits (mostly `@libpdf/core` API constraints, plus a few percentage-unit/aspect-ratio edge cases). See [`docs/supported-features.md`](docs/supported-features.md) for the full list of what's supported, what's out of scope and why, and what's not supported yet.

## Development

This is an npm workspaces monorepo (`packages/*`) — no separate per-package install step needed.

```bash
git clone <repo-url>
cd svg-pdf
npm install            # also wires up the local git hooks, see "Contributing"
npm run test           # unit tests
npm run test:visual    # SVG-vs-PDF visual regression tests (renders both and diffs pixels)
npm run typecheck      # tsc -b across all packages
npm run lint           # ESLint
npm run format         # Prettier --write
npm run docs:structure # regenerates docs/project-structure.txt
```

## Contributing

Commit messages are checked by a local git hook (installed automatically by `npm install`): the header must be `<type>: <subject>`, where `<type>` is one of `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`. See `docs/comment-conventions.md` and `docs/naming-conventions.md` for the project's comment and file-naming conventions.
