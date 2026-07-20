# Plotify

`@delylabs/plotify` — a worker-safe, PDF-engine-agnostic SVG-to-PDF vector parser.

**Status:** pre-release (`0.x`), not yet published to npm.

## Motivation

Turning an SVG into a real PDF vector — not a rasterized image, so it stays sharp at any zoom — is a common need (icons, logos, exported diagrams) with a few different approaches in the JS ecosystem: some tools rasterize via a headless browser, some go through canvas-to-PNG, and some embed true vector paths. Each trade-off suits different use cases.

For real vector embedding specifically, two established options exist, each tied to one PDF library: [`svg2pdf.js`](https://github.com/yWorks/svg2pdf.js) (paired with `jsPDF`, browser-oriented) and [`svg-to-pdfkit`](https://github.com/alafr/SVG-to-PDFKit) (paired with `PDFKit`, Node-oriented and DOM-free). Both are mature, widely used tools, but `svg2pdf.js`'s architecture has two specific constraints that partly motivated Plotify's own design: two of its modules call `document.createElement`/`document.implementation.createHTMLDocument` directly, so it can't run in a Web Worker, and its drawing calls are written straight against `jsPDF`'s API, so targeting a different PDF library means rewriting that layer.

Plotify takes a different structural approach: a DOM-free core (`DOMParser` only) that parses SVG into a neutral instruction list, plus separate **adapter** packages that translate that list into calls for one specific PDF library. Anything the parser can't handle is skipped individually with a collected warning instead of failing the whole conversion.

## Usage

```ts
import { PDF as LibPDF } from '@libpdf/core';
import { embedSvgInPdf } from '@delylabs/plotify-libpdf';
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
  core/     @delylabs/plotify           Parses SVG into a flat instruction list.
  libpdf/   @delylabs/plotify-libpdf    Adapter for @libpdf/core.
```

Future adapters follow the same pattern, named after the library they target, for example: `@delylabs/plotify-jspdf`, `@delylabs/plotify-pdf-lib`, etc.

> `@libpdf/core` is named here only to describe compatibility — Plotify is not affiliated with or endorsed by that project.

MIT licensed (see `LICENSE`; third-party code this project ports from is credited in `THIRD_PARTY_NOTICES.md`). Not set up yet: CI, npm publishing.

## Supported

Shapes (`path`/`rect`/`circle`/`ellipse`/`line`/`polygon`/`polyline`), nested `<g>` transforms, `<use>`/`<defs>`/`<symbol>`, linear/radial gradients, `<pattern>` tiling (translate/scale placement only — see below), `<marker>` (`marker-start`/`-mid`/`-end`, `orient="auto"`/`"auto-start-reverse"`/fixed angle, `markerUnits`, `refX`/`refY`, `viewBox` — see below), `<clipPath>` (including `objectBoundingBox` units), `stroke-dasharray`, `mix-blend-mode`, simple `<style>` selectors (tag/class/id), best-effort `<text>`/`<tspan>` (standard-14 fonts, no font embedding), and `<image>` (inline `data:` URIs always; external `http`/`https` URLs only if a `fetchImage` function is passed in — see [`docs/usage.md`](docs/usage.md) — since fetching them by default would be an SSRF risk for anyone converting untrusted, user-supplied SVGs).

`<pattern>` support has two scope limits, both from `@libpdf/core` having no way to position a tiling pattern other than through absolute, axis-aligned numbers: a pattern reached through a rotated/skewed transform (its own `patternTransform` or an ancestor `<g>`) is skipped with a warning rather than tiled incorrectly, and pattern _content_ is limited to shapes with a solid fill/stroke (no nested gradients/patterns, `<text>`, or `<image>` — each skipped individually with a warning, same fail-safe policy as everywhere else). `<marker>` content has the same solid-fill/stroke-only limit (both are built from a `@libpdf/core` resource with no way to register a font/image/shading/nested pattern into it), but marker _placement_ itself has no such restriction — a marker is painted as an ordinary positioned object, so it rotates/scales freely.

## Not yet supported

- Nested `<svg>`
- `<a href>` as a PDF link annotation
- CSS selectors beyond simple tag/class/id
- `xml:space="preserve"` / `white-space: pre`
- `text-transform`, `letter-spacing`, `word-spacing`
- Full text-chunk layout (multi-`<tspan>` positioning is a simplified single-line flow heuristic, not measurement-based with `dx`/`dy` arrays)
- `<textPath>`
- `<mask>` — also currently blocked by `@libpdf/core` itself (no soft-mask option in its `ExtGState` API)
- `filter="url(#...)"` (blur/drop-shadow) — a genuine PDF vector limitation, not a scope choice

## Development

This is an npm workspaces monorepo (`packages/*`) — no separate per-package install step needed.

```bash
git clone <repo-url>
cd plotify
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
