# Roadmap

## Design principle: works in Worker, Browser, and Node

Not just "worker-safe" — every package should run in all three environments. Any new adapter should be designed against this requirement from the start, not patched in afterward.

## Feature gaps

`<mask>` and `filter="url(#...)"` (see `docs/supported-features.md`'s "Not yet supported" list) are both blocked on external constraints, not svg-pdf's own work — `<mask>` needs `@libpdf/core` to expose soft-mask support first, and `filter` is a hard PDF-format limitation. Nothing actionable remains here for now.

## Before npm publish: spec audit

Go feature-by-feature through `docs/supported-features.md`'s "Supported" list, checking each one against the relevant SVG2/PDF spec section plus its existing tests/fixtures — re-verifying what's already claimed as supported, not searching for net-new features. (A full read of the SVG2/PDF specs from scratch is out of scope; that's a much bigger, open-ended effort than this project needs right now.)

## After that

npm publish.
