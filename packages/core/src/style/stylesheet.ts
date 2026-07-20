// Inline `style="fill: ...; stroke: ..."` — deliberately not a full CSS parser (see plan v1 scope).
const parseInlineStyle = (styleAttr: string | null): Map<string, string> => {
    const result = new Map<string, string>();
    if (!styleAttr) return result;
    for (const decl of styleAttr.split(';')) {
        const [prop, ...rest] = decl.split(':');
        if (!prop || rest.length === 0) continue;
        result.set(prop.trim().toLowerCase(), rest.join(':').trim());
    }
    return result;
};

/*
 * `<style>` block support, scoped to the common case rather than real CSS:
 * one compound selector per rule — a bare tag name, `.class`, `#id`, or any
 * no-combinator combination of those on a single element (`tag.class`,
 * `.a.b`, `tag#id`, ...) — with `,`-separated lists sharing one rule (e.g.
 * `.a, .b { ... }`). Matched with CSS's usual id > class > tag specificity,
 * ties broken by source order (later wins). No combinators
 * (descendant/child/sibling), no pseudo-classes/attribute selectors, no
 * `!important`. At-rules (`@media`, `@keyframes`, etc.) are stripped
 * entirely rather than evaluated — a static PDF page has no viewport
 * breakpoints or animation timeline for them to apply to anyway.
 */
export interface CssRule {
    readonly tag: string | null;
    readonly classes: readonly string[];
    readonly id: string | null;
    readonly declarations: ReadonlyMap<string, string>;
    readonly order: number;
}

const COMPOUND_SELECTOR_RE = /^([A-Za-z][\w-]*)?((?:[.#][A-Za-z_][\w-]*)*)$/;
const SELECTOR_FRAGMENT_RE = /[.#][A-Za-z_][\w-]*/g;
const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

// Splits a compound selector like `tag.class#id` into its tag/classes/id parts, or returns null if it uses anything unsupported (combinators, pseudo-classes, attribute selectors, ...).
const parseCompoundSelector = (
    selector: string,
): { tag: string | null; classes: string[]; id: string | null } | null => {
    const match = COMPOUND_SELECTOR_RE.exec(selector);
    if (!match) return null;
    const [, tagRaw, fragments] = match;
    const tag = tagRaw ? tagRaw.toLowerCase() : null;
    const classes: string[] = [];
    let id: string | null = null;
    for (const fragment of fragments.match(SELECTOR_FRAGMENT_RE) ?? []) {
        if (fragment.startsWith('.')) classes.push(fragment.slice(1));
        else id = fragment.slice(1);
    }
    if (tag === null && classes.length === 0 && id === null) return null;
    return { tag, classes, id };
};

/*
 * `@font-face` support, scoped to the same "common case, not real CSS"
 * philosophy as the rest of this file: only a `src: url(data:...)` (an
 * inline-embedded font, decodable with no network access) is read — a
 * `src` pointing only at an external URL is left for `fetchFont` to supply
 * instead (see svgEmbed.ts), same reasoning as why `<image>` external URLs
 * need an opt-in fetcher rather than being read automatically. Multiple
 * `src` entries (format fallback lists) are supported by taking the first
 * one that's a `data:` URI.
 */
export interface FontFaceDef {
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    // The first `data:` URI found in `src`, or `null` if `src` only has external URLs (or is missing) — decoding is svgEmbed.ts's job, same as `<image>` data URIs.
    readonly dataUri: string | null;
}

const FONT_FACE_RE = /@font-face\s*\{([^{}]*)\}/g;
const DATA_URI_IN_SRC_RE = /url\(\s*(data:[^)]*)\)/i;

// Splits a `@font-face` block's declarations on `;`, but not inside `url(...)` — a `url(data:...)` commonly contains its own `;` (e.g. between the MIME type and `base64`), which a naive split would cut mid-URI.
const splitDeclarations = (block: string): string[] => {
    const result: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of block) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ';' && depth === 0) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) result.push(current);
    return result;
};

const parseFontFaceBlock = (block: string): Map<string, string> => {
    const result = new Map<string, string>();
    for (const decl of splitDeclarations(block)) {
        const [prop, ...rest] = decl.split(':');
        if (!prop || rest.length === 0) continue;
        result.set(prop.trim().toLowerCase(), rest.join(':').trim());
    }
    return result;
};

// Extracts every `@font-face` block's declarations from raw <style> text — called before `stripAtRules` discards them (rule parsing has no use for `@`-rules otherwise).
const parseFontFaceRules = (cssText: string, warnings: string[]): FontFaceDef[] => {
    const defs: FontFaceDef[] = [];
    for (const match of cssText.matchAll(FONT_FACE_RE)) {
        const declarations = parseFontFaceBlock(match[1]);
        const fontFamily = declarations.get('font-family')?.replace(/^["']|["']$/g, '');
        const src = declarations.get('src');
        if (!fontFamily || !src) continue;
        const dataUriMatch = DATA_URI_IN_SRC_RE.exec(src);
        if (!dataUriMatch) {
            warnings.push(
                `@font-face "${fontFamily}" was skipped (only src: url(data:...) is read automatically; use fetchFont for externally-hosted fonts)`,
            );
            continue;
        }
        defs.push({
            fontFamily,
            fontWeight: declarations.get('font-weight') ?? 'normal',
            fontStyle: declarations.get('font-style') ?? 'normal',
            dataUri: dataUriMatch[1],
        });
    }
    return defs;
};

// Removes `@media`/`@keyframes`/etc. blocks (including their nested `{ }`s) before rule parsing, tracking brace depth so nested blocks aren't cut short.
const stripAtRules = (cssText: string): string => {
    let result = '';
    let i = 0;
    while (i < cssText.length) {
        if (cssText[i] !== '@') {
            result += cssText[i];
            i++;
            continue;
        }
        let depth = 0;
        let j = i;
        while (j < cssText.length) {
            if (cssText[j] === '{') depth++;
            else if (cssText[j] === '}') {
                depth--;
                if (depth === 0) {
                    j++;
                    break;
                }
            }
            j++;
        }
        i = j;
    }
    return result;
};

export const parseStyleRules = (
    root: Element,
    warnings: string[],
): { cssRules: CssRule[]; fontFaces: FontFaceDef[] } => {
    const rules: CssRule[] = [];
    const fontFaces: FontFaceDef[] = [];
    let order = 0;
    const stack = [root];
    while (stack.length > 0) {
        const el = stack.pop()!;
        if (el.tagName?.toLowerCase() === 'style') {
            const rawCssText = (el.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
            fontFaces.push(...parseFontFaceRules(rawCssText, warnings));
            const cssText = stripAtRules(rawCssText);
            for (const match of cssText.matchAll(CSS_RULE_RE)) {
                const [, selectorListRaw, declBlock] = match;
                const declarations = parseInlineStyle(declBlock);
                if (declarations.size === 0) continue;
                for (const rawSelector of selectorListRaw.split(',')) {
                    const selector = rawSelector.trim();
                    if (selector === '') continue;
                    const parsed = parseCompoundSelector(selector);
                    if (parsed) {
                        rules.push({ ...parsed, declarations, order: order++ });
                    } else {
                        warnings.push(
                            `<style> selector "${selector}" (combinators/pseudo-classes/attribute selectors are not supported) was skipped`,
                        );
                    }
                }
            }
        } else {
            stack.push(...Array.from(el.children));
        }
    }
    return { cssRules: rules, fontFaces };
};

// Finds the winning declaration (if any) for `prop` on `el` across all matching rules, per the specificity/order rule documented above.
const cssValueFor = (el: Element, prop: string, cssRules: readonly CssRule[]): string | null => {
    const classes = el.getAttribute('class')?.trim().split(/\s+/) ?? [];
    const id = el.getAttribute('id');
    const tag = el.tagName.toLowerCase();
    let best: { value: string; specificity: number; order: number } | null = null;
    for (const rule of cssRules) {
        const value = rule.declarations.get(prop);
        if (value === undefined) continue;
        const matches =
            (rule.tag === null || rule.tag === tag) &&
            (rule.id === null || rule.id === id) &&
            rule.classes.every((c) => classes.includes(c));
        if (!matches) continue;
        const specificity =
            (rule.id !== null ? 100 : 0) + rule.classes.length * 10 + (rule.tag !== null ? 1 : 0);
        if (
            !best ||
            specificity > best.specificity ||
            (specificity === best.specificity && rule.order > best.order)
        ) {
            best = { value, specificity, order: rule.order };
        }
    }
    return best?.value ?? null;
};

/*
 * `cssRules` is optional so call sites that don't have a `WalkContext` handy
 * (gradient stops, clip-path/mask/filter reads) keep working unchanged —
 * they just don't get `<style>` class support, which is an acceptable, much
 * rarer gap than fill/stroke/font on shapes and text.
 */
export const readPresentation = (
    el: Element,
    name: string,
    cssRules?: readonly CssRule[],
): string | null => {
    const style = parseInlineStyle(el.getAttribute('style'));
    if (style.has(name)) return style.get(name)!;
    const cssValue = cssRules ? cssValueFor(el, name, cssRules) : null;
    return cssValue ?? el.getAttribute(name);
};
