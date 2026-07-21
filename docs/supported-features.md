# Supported features

This page lists which SVG features svg-pdf can turn into a PDF, which ones have some limitation you should know about, and which ones aren't supported at all yet.

## Supported

### Shapes and grouping

- Basic shapes: `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polygon>`, `<polyline>`.
- `<g>` for grouping elements together, including nested groups and transforms (move/rotate/scale).
- `<use>` (reusing another element), `<defs>` (defining reusable content without drawing it directly), and `<symbol>` (a reusable "template" with its own size and coordinate system).
- A nested `<svg>` (an `<svg>` placed inside another `<svg>`) and a `<symbol>` both work like a "picture within a picture" — a self-contained area with its own `x`/`y`/`width`/`height`/`viewBox`. By default, anything that would spill outside that area gets clipped off (hidden); adding `overflow="visible"` turns that off. See the caveats below for a detail about sizing this area using percentages (e.g. `width="50%"`).
- `preserveAspectRatio` (with both scaling modes, `meet` and `slice`, and all 9 alignment keywords) — this controls how content gets scaled and positioned when its natural proportions don't match the box it needs to fit into. Supported on the root `<svg>`, on `<symbol>`, and on a nested `<svg>` alike.

### Colors: gradients and repeating patterns

- Linear and radial gradients (smooth color transitions).
- `<pattern>` — a small piece of artwork repeated ("tiled") to fill a shape, like a checkerboard or a texture. See the caveats below for two limitations on this.

### Markers (arrowheads and dots on line vertices)

`<marker>` lets you automatically place a small shape (like an arrowhead) at the start, middle, or end points of a line or path. Supported: `marker-start`/`marker-mid`/`marker-end`, auto-orienting to match the line's direction (`orient="auto"`/`"auto-start-reverse"`) or a fixed angle, `markerUnits` (whether the marker scales with the stroke width), `refX`/`refY` (the marker's own anchor point), its own `viewBox`, and `overflow="visible"`. See the caveats below for what marker _content_ can and can't include.

### Clipping shapes

`<clipPath>` lets you "cut out" a shape so only part of what's underneath shows through — including clip regions sized as a percentage of the shape they're applied to (`objectBoundingBox` units), not just fixed page coordinates.

### Strokes and blending

- `stroke-dasharray` (dashed/dotted line patterns).
- `mix-blend-mode` (how overlapping colors combine — the same kind of "Multiply," "Screen," etc. blend modes found in image editors).

### CSS inside `<style>`

Full CSS selector support — not just simple `tag`/`.class`/`#id` selectors, but combinators (matching by parent/child/sibling relationships), pseudo-classes (like `:not()`, `:first-child`), and attribute selectors (like `[fill="none"]`) too. Matched using real CSS rules for "which style wins when several rules apply" (more specific selectors win; a tie goes to whichever rule appears later in the file).

### Text

- Text alignment (`text-anchor`) that correctly accounts for an entire run of text, not just one piece at a time.
- `text-transform` (automatic upper/lowercasing).
- `letter-spacing`/`word-spacing`.
- Preserving whitespace exactly as written (`xml:space="preserve"`/`white-space: pre`), instead of collapsing extra spaces the way SVG normally does.
- `<textPath>` — text that flows along a curved line instead of a straight one.
- Fonts: by default, text is drawn using one of PDF's 14 built-in standard fonts (a fixed set every PDF reader supports without needing anything extra embedded). A real, custom font is used instead if the SVG embeds one directly (`@font-face { src: url(data:...) }`), or if you supply your own font via a `fetchFont` function — see [`usage.md`](usage.md).

### Images

- `<image>` elements whose image data is embedded directly inside the SVG file (`data:` URIs) always work.
- `<image>` elements pointing at an external web address (`http`/`https`) are only fetched if you explicitly supply a `fetchImage` function — see [`usage.md`](usage.md). This isn't a missing feature; it's a deliberate safety default, since automatically fetching arbitrary URLs from an SVG someone else gave you could be abused to make your server request things it shouldn't (an attack technique called SSRF).

### Links

`<a href>` turns whatever it wraps into a clickable region in the PDF (a "link annotation"). See the caveats below for the shape and scope of that clickable region.

## Things to know (caveats and partial support)

Each item below notes _why_ it's limited, using four categories: a **PDF format limitation** means no PDF writer could do better, since the PDF format itself has no equivalent feature. An **`@libpdf/core` limitation** means the specific library svg-pdf currently uses to write PDF bytes (not svg-pdf itself) doesn't expose the API needed yet — fixable if that library adds it, or if svg-pdf adds support for a different PDF-writing library. A **design choice** means it works today but is deliberately off by default (usually for safety), with a way to opt in. **Not yet implemented** means there's no technical blocker at all — it's just future work.

- **Patterns and markers with rotation** _(@libpdf/core limitation)_: if a `<pattern>` is reached through a rotated or skewed transform (its own `patternTransform`, or an ancestor `<g>` that's rotated/skewed), it's skipped with a warning instead of being drawn incorrectly. `@libpdf/core`'s tiling-pattern API can only position a repeating pattern using plain, non-rotated numbers — it has no way to hand it a rotation matrix.
- **Pattern and marker content is limited to solid colors** _(@libpdf/core limitation)_: the inside of a `<pattern>` or `<marker>` can only contain shapes with a plain solid fill/stroke — not another gradient, another pattern, text, or an image nested inside it. Anything like that is skipped individually with a warning. Both are built internally from a bare list of drawing operators with no resource dictionary of their own, so there's nowhere to register a nested font/image/gradient/pattern. (This only affects what's _inside_ the pattern/marker; a marker's overall placement — its rotation, scale, position — is unrestricted.)
- **Opacity inside a pattern/marker isn't honored** _(@libpdf/core limitation)_: `fill-opacity`/`stroke-opacity`/`opacity` used _inside_ a `<pattern>` or `<marker>`'s own content don't currently have any effect (drawn fully opaque instead, with a warning) — same root cause as above: no resource dictionary means no place to attach the transparency setting. Opacity on the _shape the pattern/marker is applied to_ works fine; this limitation is only about opacity used inside the pattern/marker's own artwork.
- **`<clipPath>` content is limited to shapes, `<g>`, and `<use>`** _(not yet implemented)_: plain shapes work directly; a `<g>` wrapping several shapes (to union them together) and a `<use>` reusing another shape's geometry both work too, including nested combinations of the two, with any `transform`/offset along the way applied correctly. Something else inside a `<clipPath>` (like `<text>` or `<image>`) is skipped with a warning instead of being drawn wrong. If every child of a `<clipPath>` ends up skipped this way, the clip region is empty and nothing draws at all (an empty clip region hides everything, per spec) rather than drawing unclipped.
- **`@font-face` only works when the font data is embedded directly** _(design choice)_ in the SVG (`src: url(data:...)`) — a `@font-face` pointing at an external URL instead is skipped with a warning, for the same safety reason external images aren't fetched automatically (see [Images](#images) above). Matching an SVG's requested `font-family`/`font-weight`/`font-style` against an available `@font-face` is a simple, case-insensitive text match, not the more flexible matching real browsers do.
- **Per-character positioning** (`dx`/`dy`/`rotate` with a list of values on `<text>`/`<tspan>`, letting you nudge or rotate individual characters instead of a whole line) is supported.
- **`word-spacing` may not visibly do anything with a custom embedded font** _(PDF format limitation)_ — this is a quirk of the PDF format itself, not something svg-pdf can work around: PDF's word-spacing feature only works with a certain kind of font encoding that standard fonts always use, but embedded custom fonts typically don't. `letter-spacing` isn't affected and works either way.
- **A link's clickable area is a rectangle** _(PDF format limitation)_ (a box around everything it wraps — shapes, text, images, even invisible ones), not an exact outline of the shape — so a link wrapped around a star icon gets a rectangular click target around the star. PDF link annotations are always rectangles; there's no way to give one an arbitrary outline, the same way most SVG to PDF tools handle it.
- **A link pointing at the same page (`href="#fragment"`) is skipped with a warning** _(design choice)_, since each SVG becomes one standalone PDF page with nothing else to jump to. PDF itself supports internal links between pages/destinations — this would need svg-pdf to support multiple pages or multiple linked SVGs first. Any other kind of link (an external URL, `mailto:`, `tel:`, etc.) is used as-is.
- **An `<image>` whose data is itself an SVG (a `data:image/svg+xml...` URI, or an `.svg` file fetched via `fetchImage`) isn't drawn as crisp vector content** _(not yet implemented)_: svg-pdf always treats `<image>` bytes as a raster picture to embed, never as a nested SVG document to render. In Node this SVG-as-image case fails to decode and is skipped with a warning (there's no `OffscreenCanvas` to rasterize it with either); this is a real but comparatively uncommon pattern next to plain PNG/JPEG image data.
- **Text-along-a-path (`<textPath>`)** _(not yet implemented, for what's left)_: each character is individually positioned and rotated to follow the path's curve, starting at a given offset (`startOffset`, as a plain number or a percentage) along the path, respecting the path's own `pathLength` if it has one, and shifted by `text-anchor` the same way regular text is. It always uses a standard font rather than a custom one from `fetchFont`/`@font-face`. Two things aren't supported yet:
    - `textLength` (stretching/compressing the text to fit an exact length) works in its default mode, which only adjusts the spacing _between_ characters. `lengthAdjust="spacingAndGlyphs"`, which would also resize the characters themselves, isn't supported — it falls back to spacing-only with a warning.
    - Nesting a `<tspan>` inside a `<textPath>` isn't supported — its children are skipped with a warning, and only the `<textPath>`'s own direct text is used.
- **Percentage sizes (like `width="50%"`) inside a nested `<svg>` or `<symbol>` are measured against the right area**: they're calculated relative to whichever "picture within a picture" area they actually live in, not always the outermost SVG. This applies to a nested `<svg>`/`<symbol>`'s own size and position, and to any shape's percentage-based sizing inside one.

## Not yet supported

- **`<mask>`** _(@libpdf/core limitation)_ (hiding part of an image using a gradient of transparency) — PDF itself has an equivalent feature (soft masks), so this isn't a PDF format limitation; `@libpdf/core` just doesn't expose that capability yet. Fixable once that library (or a future alternative one svg-pdf could switch to) supports it.
- **`filter="url(#...)"`** _(PDF format limitation)_ (effects like blur or drop-shadow) — PDF as a vector format has no raster-effect primitives to draw on; this isn't something any PDF-writing library could paper over, so it's not something that can be reasonably worked around.
