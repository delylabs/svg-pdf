# Test fixtures

## `w3c-svg11/`

A curated subset of the official **W3C SVG 1.1 Test Suite** (<http://www.w3.org/Graphics/SVG/WG/wiki/Test_Suite_Overview>), chosen to exercise SVG features tracked as gaps in svg-pdf's own README.

**License note**: these files carry W3C's own copyright, embedded verbatim in each file's header comment. W3C dual-licenses its test suites — a permissive **W3C 3-clause BSD License** (copying and modification both permitted) or a stricter **W3C Test Suite License** (copying only). Per W3C's own policy, "the choice of license is up to the licensee for every single use" — see `LICENSE-SVG.txt` in this directory for svg-pdf's election (the BSD variant) and its full text.

## `custom/`

SVGs authored directly for svg-pdf — not vendored from anywhere, no third-party license to track. Used by `svgCodec.test.ts`'s fixture tests and for exercising SVG feature gaps during development.
