import { is } from 'css-select';
import type { Selector } from 'css-what';

/*
 * `css-select`'s `Adapter<Node, ElementNode>` interface, implemented for
 * `@xmldom/xmldom`'s DOM-like nodes. Typed against the ambient `Node`/
 * `Element` from TypeScript's `DOM` lib rather than xmldom's own types —
 * same convention `parse/document.ts` uses (xmldom's runtime shape is
 * structurally compatible; there's no real DOM at runtime in Node/Worker,
 * this is purely a structural-typing convenience).
 *
 * xmldom has no `previousElementSibling`/`nextElementSibling`, only the
 * raw (non-element-filtered) `previousSibling`/`nextSibling` — sibling
 * traversal here works off `getChildren`/`isTag` instead, same as
 * `getSiblings` below.
 *
 * `getName` deliberately does not lowercase `tagName` — SVG is XML, where
 * tag/attribute names are case-sensitive (`linearGradient`, `viewBox`,
 * ...); this codebase's own lowercasing (e.g. `walk.ts`'s
 * `el.tagName.toLowerCase()`) is for its own internal dispatch against a
 * fixed lowercase tag set, not something a CSS selector author's exact
 * spelling should be forced through.
 */

const childrenOf = (node: Node): Node[] => {
    const result: Node[] = [];
    for (let i = 0; i < node.childNodes.length; i++) {
        result.push(node.childNodes[i]);
    }
    return result;
};

const isAncestorOf = (candidate: Node, node: Node): boolean => {
    let current: Node | null = node.parentNode;
    while (current) {
        if (current === candidate) return true;
        current = current.parentNode;
    }
    return false;
};

const xmldomAdapter = {
    isTag: (node: Node): node is Element => node.nodeType === 1,
    getAttributeValue: (element: Element, name: string): string | undefined =>
        element.getAttribute(name) ?? undefined,
    getChildren: childrenOf,
    getName: (element: Element): string => element.tagName,
    getParent: (node: Element): Node | null => {
        const parent = node.parentNode;
        return parent && parent.nodeType === 1 ? parent : null;
    },
    getSiblings: (node: Node): Node[] => (node.parentNode ? childrenOf(node.parentNode) : [node]),
    getText: (node: Node): string => node.textContent ?? '',
    hasAttrib: (element: Element, name: string): boolean => element.hasAttribute(name),
    removeSubsets: (nodes: Node[]): Node[] =>
        nodes.filter((node) => !nodes.some((other) => other !== node && isAncestorOf(other, node))),
    equals: (a: Node, b: Node): boolean => a === b,
};

/*
 * `tokens` is one comma-branch's already-parsed selector (see
 * `stylesheet.ts`'s `parseStyleRules`, which parses the whole `<style>`
 * rule's selector list once via `css-what` and stores each branch
 * separately) — wrapped in an extra array because `css-select`'s `Query`
 * type represents "a list of comma-separated alternatives"
 * (`Selector[][]`), and a single already-split branch is just one
 * alternative.
 *
 * Fails closed (no match) on any runtime error rather than throwing.
 * Genuinely invalid selector *syntax* is already caught once, at parse
 * time in `parseStyleRules` — a selector reaching here already parsed
 * successfully when its `CssRule` was created, so this is a defensive
 * backstop, not the primary fail-safe path.
 */
export const matchesSelector = (el: Element, tokens: readonly Selector[]): boolean => {
    try {
        return is(el, [tokens as Selector[]], { adapter: xmldomAdapter, xmlMode: true });
    } catch {
        return false;
    }
};
