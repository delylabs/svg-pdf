import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SRC_DIRS = fs
    .readdirSync(path.join(ROOT, 'packages'))
    .map((pkg) => path.join('packages', pkg, 'src'))
    .concat('scripts');
const FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', 'build']);

// Recursively collects source files, skipping node_modules/dist/build and any dotfile/dot-folder.
function getFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.') || IGNORED_DIR_NAMES.has(entry)) continue;
        const entryPath = path.join(dir, entry);
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
            results = results.concat(getFiles(entryPath));
        } else if (
            FILE_EXTENSIONS.includes(path.extname(entry)) &&
            !entry.endsWith('.d.ts') // ambient/generated declarations, not hand-written
        ) {
            results.push(entryPath);
        }
    }
    return results;
}

// Keywords used by tool directives, not by explanatory prose comments.
const PRAGMA_KEYWORDS =
    '(eslint-disable|eslint-enable|@ts-expect-error|@ts-ignore|@ts-nocheck|@ts-check|prettier-ignore|istanbul|webpack)';
const SINGLE_LINE_PRAGMA_RE = new RegExp(`^//\\s*${PRAGMA_KEYWORDS}`);

function isSingleLinePragma(commentText) {
    return SINGLE_LINE_PRAGMA_RE.test(commentText);
}

function scriptKindFor(filePath) {
    if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
    if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
}

/*
 * JSDoc only "means" something (hover tooltips, TypeDoc, ...) when it's the
 * leading comment of an actual declaration — see docs/comment-conventions.md
 * section 0. A /** comment floating above an ordinary statement doesn't
 * attach to anything, so it doesn't get the single-line exemption.
 */
const DECLARATION_KINDS = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.EnumMember,
    ts.SyntaxKind.ModuleDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.MethodSignature,
    ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.PropertySignature,
    ts.SyntaxKind.PropertyAssignment,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.ExportAssignment,
    ts.SyntaxKind.Parameter,
]);

/*
 * A declaration inside a function/method body (a local variable, a nested
 * helper function, ...) has no life outside that closure — no hover benefit
 * anywhere else, so it doesn't count as "for users of the code" either.
 */
const FUNCTION_LIKE_KINDS = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
]);

/*
 * A property of an object a function returns is part of that function's
 * public shape (callers destructure it), even though it sits inside the body.
 */
function isReturnedObjectProperty(node) {
    if (
        node.kind !== ts.SyntaxKind.PropertyAssignment &&
        node.kind !== ts.SyntaxKind.ShorthandPropertyAssignment
    ) {
        return false;
    }
    const objectLiteral = node.parent;
    if (objectLiteral?.kind !== ts.SyntaxKind.ObjectLiteralExpression) {
        return false;
    }
    let container = objectLiteral.parent;
    if (container?.kind === ts.SyntaxKind.ParenthesizedExpression) {
        container = container.parent;
    }
    return (
        container?.kind === ts.SyntaxKind.ReturnStatement ||
        (container?.kind === ts.SyntaxKind.ArrowFunction && container.body === objectLiteral)
    );
}

/*
 * Comments only ever sit in the gaps between real tokens, never inside a
 * string or template literal's own text — so we anchor the search to every
 * AST node's start position (TS has already correctly parsed template
 * literals with multiple substitutions) instead of re-lexing raw text
 * ourselves, which previously misread comment-like text sitting inside a
 * template literal as an actual comment.
 */
function collectComments(sourceFile, text) {
    const byStart = new Map();
    const attachedToDeclaration = new Set();
    const jsxCommentPositions = new Set();
    const jsxCommentContainers = new Map();
    let funcBodyDepth = 0;

    /*
     * A comment that's the last thing inside a container (block, object,
     * array, class body, ...) before its closing brace/bracket never leads
     * another node — forEachChild only walks real children, so it has no
     * node.pos to attach to. Tracking each container's last visited child
     * and scanning the gap up to the container's own end catches exactly
     * that dangling case, for every container kind, without special-casing
     * each one individually.
     */
    const visitChildrenTracking = (node, visitFn) => {
        let lastChildEnd;
        ts.forEachChild(node, (child) => {
            visitFn(child);
            lastChildEnd = child.end;
        });
        return lastChildEnd;
    };

    const visit = (node) => {
        for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
            byStart.set(range.pos, range);
            if (
                DECLARATION_KINDS.has(node.kind) &&
                (funcBodyDepth === 0 || isReturnedObjectProperty(node))
            ) {
                attachedToDeclaration.add(range.pos);
            }
        }

        /*
         * `{/* comment only *\/}` parses as a JsxExpression with no
         * `expression` — it has no child at all, so the normal traversal
         * (and the trailing-comment scan below, which needs a last child)
         * never reaches it. The comment sits on the same line right after
         * `{` (no line break), which makes it a *trailing* comment of `{`
         * rather than a leading one — getLeadingCommentRanges only ever
         * collects trivia that starts after a newline (or at pos 0), so it
         * misses this; getTrailingCommentRanges is the one that scans same-
         * line trivia. JSX also has no `//` form, so these comments are
         * marked separately: rule #5 must exempt them (no alternative
         * syntax exists) and rule #7's stacking check must still catch two
         * of them stacked back to back despite each being single-line.
         */
        if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression) {
            const openBracePos = node.getStart(sourceFile) + 1;
            const jsxComments = [
                ...(ts.getTrailingCommentRanges(text, openBracePos) ?? []),
                ...(ts.getLeadingCommentRanges(text, openBracePos) ?? []),
            ];
            for (const range of jsxComments) {
                byStart.set(range.pos, range);
                jsxCommentPositions.add(range.pos);
                /*
                 * The gap between two stacked JSX comments must be measured
                 * from `{...}` container to `{...}` container, not comment
                 * to comment — the text between the comments themselves
                 * always includes the enclosing `}`/`{` pair, which isn't
                 * whitespace even when nothing meaningful sits between them.
                 */
                jsxCommentContainers.set(range.pos, {
                    start: node.getStart(sourceFile),
                    end: node.end,
                });
            }
        }

        let lastChildEnd;
        if (FUNCTION_LIKE_KINDS.has(node.kind) && node.body) {
            visitChildrenTracking(node, (child) => {
                if (child !== node.body) visit(child);
            });
            funcBodyDepth++;
            visit(node.body);
            funcBodyDepth--;
            lastChildEnd = node.body.end;
        } else {
            lastChildEnd = visitChildrenTracking(node, visit);
        }

        if (lastChildEnd !== undefined) {
            for (const range of ts.getLeadingCommentRanges(text, lastChildEnd) ?? []) {
                if (range.end <= node.end) byStart.set(range.pos, range);
            }
        }
    };
    visit(sourceFile);
    for (const range of ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.pos) ?? []) {
        byStart.set(range.pos, range);
    }

    /*
     * A /** *\/ before the file's very first statement is a file-overview
     * comment (documents the module as a whole), not tied to one declaration.
     */
    if (sourceFile.statements.length > 0) {
        for (const range of ts.getLeadingCommentRanges(text, sourceFile.statements[0].pos) ?? []) {
            attachedToDeclaration.add(range.pos);
        }
    }

    return {
        comments: [...byStart.values()].sort((a, b) => a.pos - b.pos),
        attachedToDeclaration,
        jsxCommentPositions,
        jsxCommentContainers,
    };
}

function checkFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const scriptKind = scriptKindFor(filePath);
    const sourceFile = ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
    );

    const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
    const violations = [];
    let pendingRun = [];

    const flushRun = () => {
        if (pendingRun.length > 1) {
            violations.push({
                type: 'consecutive-line-comments',
                startLine: pendingRun[0],
                endLine: pendingRun[pendingRun.length - 1],
                count: pendingRun.length,
            });
        }
        pendingRun = [];
    };

    const { comments, attachedToDeclaration, jsxCommentPositions, jsxCommentContainers } =
        collectComments(sourceFile, text);
    let previousComment = null;
    for (const range of comments) {
        const commentText = text.slice(range.pos, range.end);
        const startLine = lineOf(range.pos);
        const endLine = lineOf(range.end - 1);
        const isJsxComment = jsxCommentPositions.has(range.pos);

        /*
         * A multi-line plain /* *\/ block (rules #3/#4) exists specifically
         * to explain the code immediately below it — if that "immediately
         * below" turns out to be just another comment, its target is gone
         * (this is exactly how a misplaced comment happens after an edit).
         * File-header /** *\/ and // section labels legitimately precede
         * another comment (e.g. a label followed by that item's own doc),
         * so only a plain, multi-line, non-JSDoc block triggers this.
         * JSX comments (`{/* *\/}`) are the one exception that's allowed to
         * be single-line here: JSX has no `//` form at all, so two of them
         * stacked back to back is the same "target is gone" problem even
         * though neither one spans multiple lines.
         */
        if (previousComment) {
            const prevText = text.slice(previousComment.pos, previousComment.end);
            const prevStartLine = lineOf(previousComment.pos);
            const prevEndLine = lineOf(previousComment.end - 1);
            const prevIsJsxComment = jsxCommentPositions.has(previousComment.pos);
            const prevIsPlainMultiLineBlock =
                previousComment.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
                !prevText.startsWith('/**') &&
                prevStartLine !== prevEndLine;
            let nothingBetween = text.slice(previousComment.end, range.pos).trim() === '';
            if (prevIsJsxComment && isJsxComment) {
                const prevContainer = jsxCommentContainers.get(previousComment.pos);
                const curContainer = jsxCommentContainers.get(range.pos);
                nothingBetween = text.slice(prevContainer.end, curContainer.start).trim() === '';
            }
            const isStackedPair = prevIsPlainMultiLineBlock || (prevIsJsxComment && isJsxComment);
            if (isStackedPair && nothingBetween) {
                violations.push({
                    type: 'stacked-comments',
                    startLine: prevStartLine,
                    endLine,
                });
            }
        }
        previousComment = range;

        if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
            /*
             * A `// eslint-disable-next-line ...` / `// @ts-expect-error` line is a
             * directive for a tool, not prose explaining the code below it — it must
             * stay a standalone `//` immediately above the line it targets, so it can
             * never be folded into a block comment or counted toward a "these should
             * be one block" run. Without this, a single explanatory // line sitting
             * directly above one of these directives got misread as 2 stacked prose
             * comments needing consolidation.
             */
            if (isSingleLinePragma(commentText)) {
                flushRun();
                continue;
            }
            const lastLine = pendingRun[pendingRun.length - 1];
            if (pendingRun.length > 0 && startLine === lastLine + 1) {
                pendingRun.push(startLine);
            } else {
                flushRun();
                pendingRun = [startLine];
            }
        } else {
            flushRun();
            const isJsDocStyle = commentText.startsWith('/**');
            const isAttached = attachedToDeclaration.has(range.pos);
            // Tool directives (eslint-disable, prettier-ignore, ...), not prose comments
            const isPragma = new RegExp(`^/\\*\\s*${PRAGMA_KEYWORDS}`).test(commentText);

            if (startLine === endLine) {
                if (!(isJsDocStyle && isAttached) && !isPragma && !isJsxComment) {
                    violations.push({
                        type: 'single-line-block-comment',
                        startLine,
                        text: commentText.trim(),
                    });
                }
            } else if (isJsDocStyle && !isAttached) {
                violations.push({
                    type: 'misplaced-jsdoc',
                    startLine,
                    endLine,
                });
            }
        }
    }
    flushRun();

    return violations;
}

function main() {
    const isCI = process.argv.includes('--ci');
    const fileArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const files =
        fileArgs.length > 0
            ? fileArgs.map((f) => path.resolve(f))
            : SRC_DIRS.flatMap((dir) => getFiles(path.join(ROOT, dir)));

    console.log(`Checking ${files.length} files for comment-convention violations...`);

    let totalViolations = 0;
    for (const file of files) {
        let violations;
        try {
            violations = checkFile(file);
        } catch (e) {
            console.warn(`Failed to parse ${path.relative(ROOT, file)}: ${e.message}`);
            continue;
        }
        if (violations.length === 0) continue;

        const relPath = path.relative(ROOT, file);
        for (const v of violations) {
            totalViolations++;
            if (v.type === 'consecutive-line-comments') {
                console.log(
                    `${relPath}:${v.startLine}-${v.endLine}  ${v.count} consecutive // lines — combine into one /* */ block or a single // line`,
                );
            } else if (v.type === 'misplaced-jsdoc') {
                console.log(
                    `${relPath}:${v.startLine}-${v.endLine}  /** */ not attached to a declaration — use /* */ instead`,
                );
            } else if (v.type === 'stacked-comments') {
                console.log(
                    `${relPath}:${v.startLine}-${v.endLine}  two separate comments with no code between them — merge into one block or fix placement`,
                );
            } else {
                console.log(
                    `${relPath}:${v.startLine}  single-line /* */ comment — use // instead: ${v.text}`,
                );
            }
        }
    }

    console.log();
    if (totalViolations === 0) {
        console.log('No comment-convention violations found.');
        return;
    }
    console.log(`${totalViolations} violation(s) found.`);
    if (isCI) process.exitCode = 1;
}

main();
