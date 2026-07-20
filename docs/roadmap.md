# Roadmap

## Design principle: works in Worker, Browser, and Node

Not just "worker-safe" — every package should run in all three environments.
Any new adapter should be designed against this requirement from the start,
not patched in afterward.

## Feature gaps to close

See README's "Not yet supported" list.

## After that

git init, `package.json`/build tooling per package, `LICENSE` +
`THIRD_PARTY_NOTICES`, tests, CI, npm publish.
