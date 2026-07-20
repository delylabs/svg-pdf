# File & Folder Naming Conventions

This document summarizes the file and folder naming rules across the Plotify project. The core principle: **casing follows a file's role, not its folder's location.** A folder can contain a mix of naming styles, as long as each file follows the rule for its own kind.

---

## 1. Folders

All folder names across the project use **kebab-case** for multi-word names (e.g. `test-fixtures/`), and plain lowercase for single-word names (e.g. `core/`, `libpdf/`, `geometry/`, `style/`, `parse/`, `scripts/`, `config/`, `docs/`).

Reason: the filesystem isn't always case-sensitive (Windows, default macOS) — all-lowercase avoids ambiguity, and kebab-case is the standard way to join multiple words under that constraint.

## 2. Code files (`.ts`)

Every module (geometry math, style resolution, parsing, PDF adapters, utilities) follows one rule:

| Kind of file                                                | Rule          | Example                                                                  |
| ----------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| Any regular module (parser, geometry, style, adapter, util) | **camelCase** | `matrix.ts`, `bbox.ts`, `walk.ts`, `svgEmbed.ts`, `pageGeometry.ts`      |
| Test file, mirroring the subject under test                 | **camelCase** | `svgCodec.test.ts`, `svgEmbed.visual.test.ts`, `raster.ts` (test helper) |

Test files live under `__tests__/` (the double-underscore prefix is a Vitest/Jest convention marking the directory as test-only, not part of the published package) — the folder name itself is exempt from the kebab-case folder rule for that reason (see section 4).

## 3. Docs (`.md`)

Hand-authored Markdown files use **kebab-case**, same as folders — e.g. `comment-conventions.md`, `naming-conventions.md`, `roadmap.md`. There's no separate rule here; it's the same reasoning as section 1, applied to files instead of directories.

## 4. Legitimate exceptions (don't generalize these to the rules above)

Some files/folders intentionally don't follow the general rule, because they follow an external convention or tool that takes precedence:

- **`__tests__/`** — double-underscore prefix, a Vitest/Jest convention for marking test directories. Not kebab-case, not a project choice.
- **`scripts/*.js`, `scripts/hooks/commit-msg`** — kebab-case (or a single bare word for the hook, since git hook filenames are fixed by git itself, e.g. `commit-msg`), the common Node.js convention for CLI/tooling scripts.
- **`config/*.config.ts`, `tsconfig*.json`, `.prettierignore`, `eslint.config.js`** — config filenames already standardized by their respective ecosystems (TypeScript, Prettier, ESLint, Vitest). Not this project's choice to make.
- **`test-fixtures/w3c-svg11/*.svg`** — filenames mirror the upstream W3C SVG Test Suite's own naming exactly, to keep them traceable back to their source (see `test-fixtures/README.md` for the vendoring/license note).

## 5. When in doubt

Ask: **"What kind of file is this?"**, not "what style does this folder usually use?" Casing follows the answer to that first question:

- A regular module (parsing, geometry, style, adapter, util, or test) → camelCase
- Matches one of the exceptions above → follow that convention instead

If a new file doesn't clearly fit a category, default to camelCase — it's the dominant convention across this entire project.
