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

export const parseStyleRules = (root: Element, warnings: string[]): CssRule[] => {
    const rules: CssRule[] = [];
    let order = 0;
    const stack = [root];
    while (stack.length > 0) {
        const el = stack.pop()!;
        if (el.tagName?.toLowerCase() === 'style') {
            const cssText = stripAtRules((el.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, ''));
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
    return rules;
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
