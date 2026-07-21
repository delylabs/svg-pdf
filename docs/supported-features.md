# Supported features

This page lists which SVG features svg-pdf can turn into a PDF, which ones have some limitation you should know about, and which ones aren't supported at all yet.

## Supported

### Shapes and grouping

- Basic shapes: `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polygon>`, `<polyline>`.
- `<g>` for grouping elements together, including nested groups and transforms (move/rotate/scale).
- `<use>` (reusing another element), `<defs>` (defining reusable content without drawing it directly), and `<symbol>` (a reusable "template" with its own size and coordinate system).
- A nested `<svg>` (an `<svg>` placed inside another `<svg>`) and a `<symbol>` both work like a "picture within a picture" — a self-contained area with its own `x`/`y`/`width`/`height`/`viewBox`. By default, anything that would spill outside that area gets clipped off (hidden); adding `overflow="visible"` turns that off. Percentage sizes (like `width="50%"`) inside one are measured against the right area too — resolved relative to whichever "picture within a picture" area they actually live in, not always the outermost SVG, and this applies to any shape's percentage-based sizing inside one as well.
- `preserveAspectRatio` (with both scaling modes, `meet` and `slice`, and all 9 alignment keywords) — this controls how content gets scaled and positioned when its natural proportions don't match the box it needs to fit into. Supported on the root `<svg>`, on `<symbol>`, and on a nested `<svg>` alike.
- `display="none"` (completely omits an element and its subtree, including when reached indirectly via `<use>`) and `visibility="hidden"`/`"collapse"` (hides rendering while still walking children, allowing nested `visibility="visible"` elements to turn rendering back on).

### Colors: gradients and repeating patterns

- Linear and radial gradients (smooth color transitions).
- `<pattern>` — a small piece of artwork repeated ("tiled") to fill a shape, like a checkerboard or a texture. See the caveats below for two limitations on this.

### Markers (arrowheads and dots on line vertices)

`<marker>` lets you automatically place a small shape (like an arrowhead) at the start, middle, or end points of a line or path. Supported: `marker-start`/`marker-mid`/`marker-end`, auto-orienting to match the line's direction (`orient="auto"`/`"auto-start-reverse"`) or a fixed angle, `markerUnits` (whether the marker scales with the stroke width), `refX`/`refY` (the marker's own anchor point), its own `viewBox`, and `overflow="visible"`. See the caveats below for what marker _content_ can and can't include.

### Clipping shapes

`<clipPath>` lets you "cut out" a shape so only part of what's underneath shows through — including clip regions sized as a percentage of the shape they're applied to (`objectBoundingBox` units), not just fixed page coordinates.

### Strokes and blending

- `stroke-dasharray` (dashed/dotted line patterns).
- `stroke-miterlimit` (controls the limit on ratio of miter length to stroke-width for miter joins, defaulting to SVG's spec default of 4).
- `mix-blend-mode` (how overlapping colors combine — the same kind of "Multiply," "Screen," etc. blend modes found in image editors).

### CSS inside `<style>`

Full CSS selector support — not just simple `tag`/`.class`/`#id` selectors, but combinators (matching by parent/child/sibling relationships), pseudo-classes (like `:not()`, `:first-child`), and attribute selectors (like `[fill="none"]`) too. Matched using real CSS rules for "which style wins when several rules apply" (more specific selectors win; a tie goes to whichever rule appears later in the file).

### Text

- Text alignment (`text-anchor`) that correctly accounts for an entire run of text, not just one piece at a time.
- `text-transform` (automatic upper/lowercasing).
- `letter-spacing`/`word-spacing`.
- Preserving whitespace exactly as written (`xml:space="preserve"`/`white-space: pre`), instead of collapsing extra spaces the way SVG normally does.
- Per-character positioning: `dx`/`dy`/`rotate` with a list of values on `<text>`/`<tspan>`, letting you nudge or rotate individual characters instead of a whole line.
- `<textPath>` — text that flows along a curved line instead of a straight one.
- Fonts: by default, text is drawn using one of PDF's 14 built-in standard fonts (a fixed set every PDF reader supports without needing anything extra embedded). A real, custom font is used instead if the SVG embeds one directly (`@font-face { src: url(data:...) }`), or if you supply your own font via a `fetchFont` function — see [`usage.md`](usage.md).

### Images

- `<image>` elements whose image data is embedded directly inside the SVG file (`data:` URIs) always work.
- `<image>` elements pointing at an external web address (`http`/`https`) are only fetched if you explicitly supply a `fetchImage` function — see [`usage.md`](usage.md). This isn't a missing feature; it's a deliberate safety default, since automatically fetching arbitrary URLs from an SVG someone else gave you could be abused to make your server request things it shouldn't (an attack technique called SSRF).
- An `<image>` whose data is itself an SVG document (a `data:image/svg+xml...` URI, or an `.svg` file fetched via `fetchImage`) is rendered as real vector content — parsed and drawn the same way the outer SVG is, not rasterized — fit into the `<image>`'s box the same way `meet`/`none` sizing already works for raster images (alignment keywords beyond centering aren't supported here either, matching the existing raster `preserveAspectRatio` behavior). A payload that references itself (directly or through a longer cycle) is caught by a nesting-depth limit and skipped with a warning instead of hanging.

### Links

`<a href>` turns whatever it wraps into a clickable region in the PDF (a "link annotation"). See the caveats below for the shape and scope of that clickable region.

## Things to know (caveats and limitations)

Grouped by _why_ each one exists, not by how severe it is — a "not yet implemented" item and a "PDF format limitation" item might look equally broken from the outside, but only one of them can ever be fixed.

### Not yet implemented

No technical blocker — just future work.

- **`<clipPath>` content is limited to shapes, `<g>`, and `<use>`**: plain shapes work directly; a `<g>` wrapping several shapes (to union them together) and a `<use>` reusing another shape's geometry both work too, including nested combinations of the two, with any `transform`/offset along the way applied correctly. Something else inside a `<clipPath>` (like `<text>` or `<image>`) is skipped with a warning instead of being drawn wrong. If every child of a `<clipPath>` ends up skipped this way, the clip region is empty and nothing draws at all (an empty clip region hides everything, per spec) rather than drawing unclipped.
- **Text-along-a-path (`<textPath>`)**: each character is individually positioned and rotated to follow the path's curve, starting at a given offset (`startOffset`, as a plain number or a percentage) along the path, respecting the path's own `pathLength` if it has one, and shifted by `text-anchor` the same way regular text is. It always uses a standard font rather than a custom one from `fetchFont`/`@font-face`. Two things aren't supported yet:
    - `textLength` (stretching/compressing the text to fit an exact length) works in its default mode, which only adjusts the spacing _between_ characters. `lengthAdjust="spacingAndGlyphs"`, which would also resize the characters themselves, isn't supported — it falls back to spacing-only with a warning.
    - Nesting a `<tspan>` inside a `<textPath>` isn't supported — its children are skipped with a warning, and only the `<textPath>`'s own direct text is used.
- **Opacity on a `<g>` isn't isolated**: per spec, a group's own `opacity` should render the whole group to an offscreen buffer first and only make that combined result translucent, so overlapping children inside the group still look fully solid against each other. Instead, svg-pdf multiplies the group's opacity straight into each child's own `fill-opacity`/`stroke-opacity`, so where two children inside the same opacity group overlap, that overlap ends up visibly more transparent than it should (each layer's translucency stacks). `fill-opacity`/`stroke-opacity`/`opacity` set directly on a single shape (not a group) aren't affected by this.
- **`@media` blocks inside `<style>` are discarded, not evaluated**: any rule written inside an `@media { ... }` block is dropped before CSS matching happens, so it's never applied regardless of what the media condition says. Rules outside an `@media` block are unaffected.
- **`paint-order`** (the CSS property that lets you draw stroke on top of fill instead of the default fill-then-stroke, useful for a thick outline that shouldn't cover a shape's interior) isn't read at all — everything always draws in the default fill-then-stroke order.
- **`vector-effect="non-scaling-stroke"`** (keeps a stroke's width constant on screen no matter how much its shape is scaled, useful for something like a map pin whose outline should stay thin even when the map is zoomed in) isn't read at all — a stroke's width always scales along with its shape.

### Design choice

Works today, but deliberately off by default (usually for safety), with a way to opt in.

- **`@font-face` only works when the font data is embedded directly** in the SVG (`src: url(data:...)`) — a `@font-face` pointing at an external URL instead is skipped with a warning, for the same safety reason external images aren't fetched automatically (see [Images](#images) above). Matching an SVG's requested `font-family`/`font-weight`/`font-style` against an available `@font-face` is a simple, case-insensitive text match, not the more flexible matching real browsers do.
- **A link pointing at the same page (`href="#fragment"`) is skipped with a warning**, since each SVG becomes one standalone PDF page with nothing else to jump to. PDF itself supports internal links between pages/destinations — this would need svg-pdf to support multiple pages or multiple linked SVGs first. Any other kind of link (an external URL, `mailto:`, `tel:`, etc.) is used as-is.

### `@libpdf/core` limitation

The specific library svg-pdf currently uses to write PDF bytes (not svg-pdf itself) doesn't expose the API needed yet — fixable if that library adds it, or if svg-pdf adds support for a different PDF-writing library.

- **Patterns and markers with rotation**: if a `<pattern>` is reached through a rotated or skewed transform (its own `patternTransform`, or an ancestor `<g>` that's rotated/skewed), it's skipped with a warning instead of being drawn incorrectly. `@libpdf/core`'s tiling-pattern API can only position a repeating pattern using plain, non-rotated numbers — it has no way to hand it a rotation matrix.
- **Pattern and marker content is limited to solid colors**: the inside of a `<pattern>` or `<marker>` can only contain shapes with a plain solid fill/stroke — not another gradient, another pattern, text, or an image nested inside it. Anything like that is skipped individually with a warning. Both are built internally from a bare list of drawing operators with no resource dictionary of their own, so there's nowhere to register a nested font/image/gradient/pattern. (This only affects what's _inside_ the pattern/marker; a marker's overall placement — its rotation, scale, position — is unrestricted.)
- **Opacity inside a pattern/marker isn't honored**: `fill-opacity`/`stroke-opacity`/`opacity` used _inside_ a `<pattern>` or `<marker>`'s own content don't currently have any effect (drawn fully opaque instead, with a warning) — same root cause as above: no resource dictionary means no place to attach the transparency setting. Opacity on the _shape the pattern/marker is applied to_ works fine; this limitation is only about opacity used inside the pattern/marker's own artwork.
- **`<mask>`** (hiding part of an image using a gradient of transparency) — PDF itself has an equivalent feature (soft masks), so this isn't a PDF format limitation; `@libpdf/core` just doesn't expose that capability yet. Fixable once that library (or a future alternative one svg-pdf could switch to) supports it.

### PDF format limitation

No PDF writer could do better, since the PDF format itself has no equivalent feature.

- **`word-spacing` may not visibly do anything with a custom embedded font** — this is a quirk of the PDF format itself, not something svg-pdf can work around: PDF's word-spacing feature only works with a certain kind of font encoding that standard fonts always use, but embedded custom fonts typically don't. `letter-spacing` isn't affected and works either way.
- **A link's clickable area is a rectangle** (a box around everything it wraps — shapes, text, images, even invisible ones), not an exact outline of the shape — so a link wrapped around a star icon gets a rectangular click target around the star. PDF link annotations are always rectangles; there's no way to give one an arbitrary outline, the same way most SVG to PDF tools handle it.
- **`filter="url(#...)"`** (effects like blur or drop-shadow) — PDF as a vector format has no raster-effect primitives to draw on; this isn't something any PDF-writing library could paper over, so it's not something that can be reasonably worked around.
