# Supported features

## Supported

Shapes (`path`/`rect`/`circle`/`ellipse`/`line`/`polygon`/`polyline`), nested `<g>` transforms, `<use>`/`<defs>`/`<symbol>`, nested `<svg>` (own `x`/`y`/`width`/`height`/`viewBox`, clipped to its viewport by default — see below), `preserveAspectRatio` (`meet`/`slice`, all 9 alignment keywords) on the root `<svg>`, `<symbol>`, and nested `<svg>` alike, linear/radial gradients, `<pattern>` tiling (translate/scale placement only — see below), `<marker>` (`marker-start`/`-mid`/`-end`, `orient="auto"`/`"auto-start-reverse"`/fixed angle, `markerUnits`, `refX`/`refY`, `viewBox` — see below), `<clipPath>` (including `objectBoundingBox` units), `stroke-dasharray`, `mix-blend-mode`, `<style>` selectors (tag/class/id, and no-combinator compound combinations of those, e.g. `rect.big`, `.a.b`), best-effort `<text>`/`<tspan>` (standard-14 fonts, no font embedding), and `<image>` (inline `data:` URIs always; external `http`/`https` URLs only if a `fetchImage` function is passed in — see [`usage.md`](usage.md) — since fetching them by default would be an SSRF risk for anyone converting untrusted, user-supplied SVGs).

`<pattern>` support has two scope limits, both from `@libpdf/core` having no way to position a tiling pattern other than through absolute, axis-aligned numbers: a pattern reached through a rotated/skewed transform (its own `patternTransform` or an ancestor `<g>`) is skipped with a warning rather than tiled incorrectly, and pattern _content_ is limited to shapes with a solid fill/stroke (no nested gradients/patterns, `<text>`, or `<image>` — each skipped individually with a warning, same fail-safe policy as everywhere else). `<marker>` content has the same solid-fill/stroke-only limit (both are built from a `@libpdf/core` resource with no way to register a font/image/shading/nested pattern into it), but marker _placement_ itself has no such restriction — a marker is painted as an ordinary positioned object, so it rotates/scales freely.

A nested `<svg>` needs an explicit numeric `width`/`height` — per spec these default to 100% of the parent viewport when absent, but resolving that requires tracking a live "current viewport size" that nothing else in the codebase does yet (percentage units are only resolved once, for the root `<svg>`'s own size), so a nested `<svg>` missing them is skipped with a warning rather than guessed at.

## Not yet supported

- `<a href>` as a PDF link annotation
- CSS selectors beyond tag/class/id/compound combinations (no combinators, pseudo-classes, or attribute selectors)
- `xml:space="preserve"` / `white-space: pre`
- `text-transform`, `letter-spacing`, `word-spacing`
- Full text-chunk layout (multi-`<tspan>` positioning is a simplified single-line flow heuristic, not measurement-based with `dx`/`dy` arrays)
- `<textPath>`
- `<mask>` — also currently blocked by `@libpdf/core` itself (no soft-mask option in its `ExtGState` API)
- `filter="url(#...)"` (blur/drop-shadow) — a genuine PDF vector limitation, not a scope choice
- Percentage units on anything other than the root `<svg>`'s own `width`/`height` (e.g. `x="50%"` on a nested `<svg>`, `width="100%"` on a shape) — resolving these generally requires threading a live "current viewport size" through parsing, which nothing in the codebase does yet
