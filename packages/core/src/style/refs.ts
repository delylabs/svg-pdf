// Shared helpers for resolving `href="#id"`/`url(#id)` references to other elements.

export const resolveHref = (el: Element): string | null => {
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
    if (!href || !href.startsWith('#')) return null;
    return href.slice(1);
};

export const MAX_USE_DEPTH = 12;

export const URL_REF_RE = /url\(\s*["']?#([^"')]+)["']?\s*\)/;
