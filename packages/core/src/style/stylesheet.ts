import { parse as cssWhatParse, type Selector, SelectorType } from 'css-what';

import { matchesSelector } from './domAdapter';

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
 * `<style>` block support: real selector matching (combinators,
 * pseudo-classes, attribute selectors, ...) is delegated to `css-select`
 * (see `domAdapter.ts`) rather than hand-rolled — a general CSS selector
 * engine is a much bigger undertaking than the rest of the SVG spec, and
 * `css-select` already gets it right. What stays hand-rolled here is
 * everything *around* matching: reading `<style>` text into rule blocks,
 * a `,`-separated selector list sharing one rule (e.g. `.a, .b { ... }`)
 * becoming one `CssRule` per branch, and the cascade itself — CSS's usual
 * specificity ordering, ties broken by source order (later wins). No
 * `!important`. At-rules (`@media`, `@keyframes`, etc.) are stripped
 * entirely rather than evaluated — a static PDF page has no viewport
 * breakpoints or animation timeline for them to apply to anyway.
 */
export interface CssRule {
    readonly selector: readonly Selector[];
    readonly specificity: number;
    readonly declarations: ReadonlyMap<string, string>;
    readonly order: number;
}

const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

/*
 * CSS specificity: (id count, class/attribute/pseudo-class count,
 * type/pseudo-element count), combined into one number the same way the
 * old tag/class/id-only matcher already weighted them (id: 100, class:
 * 10, tag: 1) so relative ordering of already-passing rules doesn't
 * shift now that arbitrary selectors are possible. `css-what` represents
 * both `#id` and `.class` as `Attribute` tokens (not distinct token
 * kinds), so an id is an `Attribute` token specifically named `id`.
 */
const computeSpecificity = (tokens: readonly Selector[]): number => {
    let idCount = 0;
    let classCount = 0;
    let typeCount = 0;
    for (const token of tokens) {
        if (token.type === SelectorType.Attribute) {
            if (token.name === 'id') idCount++;
            else classCount++;
        } else if (token.type === SelectorType.Pseudo) {
            classCount++;
        } else if (token.type === SelectorType.Tag || token.type === SelectorType.PseudoElement) {
            typeCount++;
        }
    }
    return idCount * 100 + classCount * 10 + typeCount;
};

/*
 * `@font-face` support, scoped to the same "common case, not real CSS"
 * philosophy as the rest of this file: only a `src: url(data:...)` (an
 * inline-embedded font, decodable with no network access) is read — a
 * `src` pointing only at an external URL is left for `fetchFont` to supply
 * instead (see embed.ts), same reasoning as why `<image>` external URLs
 * need an opt-in fetcher rather than being read automatically. Multiple
 * `src` entries (format fallback lists) are supported by taking the first
 * one that's a `data:` URI.
 */
export interface FontFaceDef {
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly fontStyle: string;
    // The first `data:` URI found in `src`, or `null` if `src` only has external URLs (or is missing) — decoding is the adapter's job (e.g. `draw/dataUri.ts`), same as `<image>` data URIs.
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
                /*
                 * `css-what`'s `parse` handles the whole `,`-separated list at
                 * once (respecting parens, so `:not(a, b)` isn't split
                 * mid-argument the way a naive `.split(',')` would) and returns
                 * one token array per branch — each becomes its own `CssRule`.
                 */
                let branches: Selector[][];
                try {
                    branches = cssWhatParse(selectorListRaw.trim());
                } catch {
                    warnings.push(
                        `<style> selector "${selectorListRaw.trim()}" could not be parsed and was skipped`,
                    );
                    continue;
                }
                for (const selector of branches) {
                    if (selector.length === 0) continue;
                    rules.push({
                        selector,
                        specificity: computeSpecificity(selector),
                        declarations,
                        order: order++,
                    });
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
    let best: { value: string; specificity: number; order: number } | null = null;
    for (const rule of cssRules) {
        const value = rule.declarations.get(prop);
        if (value === undefined) continue;
        if (!matchesSelector(el, rule.selector)) continue;
        if (
            !best ||
            rule.specificity > best.specificity ||
            (rule.specificity === best.specificity && rule.order > best.order)
        ) {
            best = { value, specificity: rule.specificity, order: rule.order };
        }
    }
    return best?.value ?? null;
};

/*
 * `cssRules` is optional so call sites that don't have a `WalkContext` handy
 * (clip-path/mask/filter reads) keep working unchanged — they just don't get
 * `<style>` class support, which is an acceptable, much rarer gap than
 * fill/stroke/font on shapes and text or gradient `<stop>` colors (both of
 * which do thread `cssRules` through, see `resolveGradientDef` in
 * `gradient.ts`).
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

/*
 * Like `readPresentation`, but without the bare-XML-attribute fallback.
 * Some CSS properties (`text-transform` among them) were never defined as
 * SVG presentation attributes, so browsers only honor them via `style="..."`
 * or a `<style>` rule — a plain `text-transform="uppercase"` attribute is
 * inert. Use this for properties that are CSS-only, not presentation
 * attributes, to match that behavior.
 */
export const readCssOnly = (
    el: Element,
    name: string,
    cssRules?: readonly CssRule[],
): string | null => {
    const style = parseInlineStyle(el.getAttribute('style'));
    if (style.has(name)) return style.get(name)!;
    return cssRules ? cssValueFor(el, name, cssRules) : null;
};
