# Test fixtures

## `w3c-svg11/`

A curated subset of the official **W3C SVG 1.1 Test Suite** (<http://www.w3.org/Graphics/SVG/WG/wiki/Test_Suite_Overview>), chosen to exercise SVG features tracked as gaps in svg-pdf's own README.

These files are for **manual inspection only** — the automated visual regression suite doesn't run them (it only scans `custom/`). That's not an oversight: most of these files would fail an automated pass/fail pixel comparison for reasons that have nothing to do with a real svg-pdf bug. Two common reasons why:

- The file uses a generic `font-family` like `sans-serif` with no specific font attached. Our comparison tool (resvg) substitutes its own built-in fallback font, which looks visibly different from the font svg-pdf actually uses — so the pixels never match, even when svg-pdf's output is correct.
- The file deliberately exercises a feature svg-pdf doesn't support yet, and already says so elsewhere (`<mask>`, `filter`, or gradient/pattern fill on `<text>`) — so a mismatch there is expected, not a new bug.

**License note**: these files carry W3C's own copyright, embedded verbatim in each file's header comment. W3C dual-licenses its test suites — a permissive **W3C 3-clause BSD License** (copying and modification both permitted) or a stricter **W3C Test Suite License** (copying only). Per W3C's own policy, "the choice of license is up to the licensee for every single use" — see `LICENSE-SVG.txt` in this directory for svg-pdf's election (the BSD variant) and its full text.

## `custom/`

SVGs authored directly for svg-pdf — not vendored from anywhere, no third-party license to track. Used by the unit suites' fixture-based tests and the visual regression suite, and for exercising SVG feature gaps during development.
