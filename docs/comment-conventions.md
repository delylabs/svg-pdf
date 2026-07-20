# Code Comment Conventions

This document summarizes the rules for writing comments across the Plotify project. Some of these rules are checked automatically — see the [Automated tooling](#automated-tooling-npm-run-lintcomments) section below.

**Reference source**: [TypeScript Style Guide — Comments & Documentation](https://ts.dev/style/#comments-documentation) (the TypeScript team's own official guide). The rules below are this project's application of that guide's principles, not rules invented independently.

**Status**: These conventions should be followed, but they are not a blocker for pull requests — a PR won't be rejected just for violating one of these rules. That said, at some point the codebase will go through a cleanup pass to bring non-compliant comments in line with these rules.

---

## 0. Foundation: JSDoc vs. regular comments

There are two kinds of comments, and what separates them isn't "how many lines," but **who the comment is written for**:

- **JSDoc** (`/** ... */`) — documentation for **consumers of the code** (anyone calling this function/class/type from elsewhere). Read by tooling: IDE hover tooltips, autocomplete, documentation generators (TypeDoc, etc.).
- **Regular comments** (`//` or `/* */`) — notes for **readers/maintainers of the code itself**, about implementation details. Read only by humans, not understood by any tooling.

The practical consequence: `/** */` is only "meaningful" (gets tooling benefits) when written **directly attached to a declaration** (a function, class, method, exported `const`, `interface`, etc.). If placed in the middle of a function body above an ordinary line of code (e.g. explaining a workaround), it isn't attached to any declaration — it gets no tooling benefit at all, and will only mislead readers (who may mistake it for official documentation instead of an implementation note). For that case, use a regular comment (`//` or `/* */`), **not** `/**`.

## 1. Self-explanatory code doesn't need a comment

Clear variable/function names, code structure, and types already explain **what** the code does. Comments aren't used to repeat something already visible from the code itself.

## 2. Code comments must be written in English

Regardless of the language used for talking/discussing this project, all comments inside the code (`//`, `/* */`, JSDoc) are written in English. This isn't checked automatically by `scripts/check-comment-convention.js` — it's purely a team agreement.

## 3. Inline `//` comments — 1 line, reason or context

When a comment is needed, write **why** the code is written that way (a hidden constraint, a workaround, context not visible from the code), not **what** it does. Keep it to 1 line, placed above or beside the code, without rambling.

```ts
// Workaround: @libpdf/core isolates a page's first drawOperators() call
page.drawOperators([ops.pushGraphicsState(), ops.popGraphicsState()]);
```

## 4. Needs more than 1 line → must use a block comment `/* */`

If the explanation doesn't fit on 1 line, use a block comment instead of stacking multiple `//` lines.

```ts
/*
 * @libpdf/core isolates a page's first drawOperators() call in its own
 * q/Q once a second call arrives (built-in mechanism to stop a watermark
 * from inheriting a stray CTM). This no-op call absorbs that isolation,
 * so the real matrix (now the second call) survives and stays in effect.
 */
```

## 5. Forbidden: block comment `/* */` for just 1 line

If the content is only 1 line, use `//`, not `/* */`.

```ts
/* Don't do this */
// Do this
```

**Exempted** from this rule:

- **JSDoc/TSDoc** (`/** ... */`) directly attached to a declaration (a function, class, method, exported `const`, etc.) — still allowed to be 1 line, because it's documentation for consumers of the code, read by tooling (IDE hover tooltips, TypeDoc, etc.), not just an explanatory note for maintainers. See [section 0](#0-foundation-jsdoc-vs-regular-comments).
- **Tool pragmas/directives** (`/* eslint-disable ... */`, `/* prettier-ignore */`, etc.) — not explanatory comments, but instructions for a specific tool.
- **JSX comments** (`{/* ... */}`) — JSX has no `//` form at all in the children position, so a single-line `/* */` is the only way to write a comment there. This is purely a JSX syntax requirement, not a style exception.
- **Comments inserted mid-line**, with more code following on the same line — e.g. naming an unclear argument: `foo(/* isEnabled */ true, /* strict */ false)`. In this position `//` can't be used at all since it would comment out the rest of the line (including the actual code), so a single-line `/* */` is the only option — for the same reason as the JSX exception above.

**Known limitation (not yet covered by the script)**: if a single-line `/* */` sits at the **end** of a line (no other code follows it on the same line) — e.g. `doSomething(); /* note */` — that's still a violation of this rule, since `//` could be used there perfectly well. But `scripts/check-comment-convention.js` currently doesn't detect this case: its check only reaches comments preceded by a newline (leading comments), while comments attached to the same line as preceding code (trailing comments) — both mid-line and end-of-line — aren't scanned yet. Needs manual review for now.

## 6. Forbidden: more than 1 consecutive line of `//` comments

If more than 1 line is needed, that's a sign it should be a block comment (rule #4), not multiple stacked `//` lines.

Two `//` comments separated by a blank line are **not** considered "consecutive" — each may stand on its own.

**Known limitation**: code temporarily disabled with `//` (not an explanatory comment) is conceptually out of scope for this rule — dead code should be deleted, not kept as a comment in any form. But syntactically, the automated checker can't distinguish "an overly long explanation" from "commented-out code," so both still get flagged as violations of #6 — manual review is needed when reading the results.

**Exempted**: single-line tool pragmas/directives (`// eslint-disable-next-line ...`, `// @ts-expect-error`, etc.) are never counted as part of a `//` run — a directive is an instruction for a tool, required to stand alone directly above the line it targets, not an explanatory comment that could be merged into a block comment.

## 7. Forbidden: a multi-line block comment `/* */` directly followed by another comment

A regular block comment (not JSDoc, not `//`) is written to explain the code **directly** below it. If what's directly below it turns out to be another comment (not code), one of two things happened: the two comments should be merged into one block, or the block comment above is now misplaced (usually because code was inserted later, separating the comment from its original target).

```ts
/* Bad: two blocks stacked with nothing in between */
/*
 * The second block's own target is gone — was it ever meant for the first?
 */
function foo() {}
```

**Exempted**: a file-header JSDoc (`/** ... */` at the very top of a file) followed by another JSDoc for the first declaration, and a `//` comment (a section label like `// Slots`) followed by another comment — both are valid combined patterns, not misplacement.

**Also applies to JSX comments**: two stacked `{/* ... */}` with no real code between them are caught by this rule too, even if each is only 1 line — because JSX has no other way to "merge" two notes into one block the way plain `//` can. "No code between them" here is judged by the JSX content between the two `{...}` containers, not just the raw text between the two comments (which will always contain a closing/opening `}`/`{`).

---

## Automated tooling: `npm run lint:comments`

`scripts/check-comment-convention.js` automatically checks rules #5, #6, and #7 across each package's `src/` (`packages/*/src`) and `scripts/` (excluding `node_modules`, `dist`, `build`, dot-prefixed folders/files, and `.d.ts`). Rule #5 also applies to **multi-line** JSDoc that isn't attached to a declaration (not just its single-line form) — see [section 0](#0-foundation-jsdoc-vs-regular-comments). Coverage includes comments that are the last line of a block/object/array/class (before a closing `}`/`]`, with no more code after) and comments inside JSX (`{/* ... */}`) — both are checked, not just comments followed by more code.

How it works: it uses the TypeScript AST (not regex) to find actual comments, so `//` or `/* */` text that happens to appear inside a string or template literal isn't counted.

```bash
npm run lint:comments              # check all files
node scripts/check-comment-convention.js path/to/file.ts   # check specific file
node scripts/check-comment-convention.js --ci              # exit code 1 if there are violations
```

Known limitations:

- Can't distinguish commented-out code from a long explanatory comment (see the note under rule #6) — both cases are still reported, and need manual judgment.
- `/* */` comments attached to the same line as preceding code (trailing comments) aren't scanned at all yet, including ones that should be violations of rule #5 (see the note under rule #5) — only comments preceded by a newline are covered currently.

## When in doubt

Ask: **"Does this comment explain why, or just repeat what's already clear from the code?"** If the answer is "repeats what," remove the comment. If "explains why," make sure it's just 1 line (`//`) or, if more is needed, a block comment (`/* */`) — never stack `//` multiple times.
