# Roadmap

## Design principle: works in Worker, Browser, and Node

Not just "worker-safe" — every package should run in all three environments. Any new adapter should be designed against this requirement from the start, not patched in afterward.

## Feature gaps

Actionable gaps — no technical blocker, just not done yet. Full detail on each lives in `docs/supported-features.md`, under "Things to know" → "Not yet implemented". Planned to be picked off gradually after the npm publish below.

- `<clipPath>` content limited to shapes/`<g>`/`<use>` — text, images, etc. inside one are skipped instead of supported.
- Opacity on a `<g>` isn't isolated — overlapping children inside an opacity group look more transparent than they should.
- `@media` blocks inside `<style>` are discarded, not evaluated.
- `<switch>` always shows its first alternative without checking its condition.
- `stroke-width` as a percentage isn't resolved against the viewport.

## Spec audit — done

- Phase 1: test file relocation — done
- Phase 2: spec-compliance fixes — done
- Phase 3: coverage gaps from the audit — done
- Phase 4: polish, API surface, and docs — done

## To do

Publish prep (build output + `exports` maps instead of `main: src/index.ts`), then npm publish.
