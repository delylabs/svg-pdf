import { type PDFPage } from '@libpdf/core';

import { type BBoxRect, type Matrix2D } from '@svg-pdf/core';

const transformPoint = (m: Matrix2D, x: number, y: number): { x: number; y: number } => ({
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
});

export interface LinkTracker {
    // Opens a new link, flushing whatever was previously open — nested `<a>` isn't meaningful content, so a stray nested `linkStart` flushes the outer one first rather than losing it.
    start(href: string): void;
    // Grows the currently-open link's page-space bbox to include `localBBox` (in the coordinate space `currentMatrix` maps from). No-op when no link is open.
    include(localBBox: BBoxRect, currentMatrix: Matrix2D): void;
    // Emits the accumulated link annotation (if any) and closes it.
    flush(): void;
}

// Tracks an `<a>` wrapping shape/text/image content's accumulating page-space bounding box, so it can become one absolute `Rect` for `addLinkAnnotation` once the `<a>` subtree ends.
export const createLinkTracker = (page: PDFPage): LinkTracker => {
    let openLink: { href: string; minX: number; minY: number; maxX: number; maxY: number } | null =
        null;

    const flush = (): void => {
        if (!openLink) return;
        const { href, minX, minY, maxX, maxY } = openLink;
        if (maxX > minX && maxY > minY) {
            page.addLinkAnnotation({
                rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
                uri: href,
            });
        }
        openLink = null;
    };

    return {
        start(href) {
            flush();
            openLink = { href, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        },
        include(localBBox, currentMatrix) {
            if (!openLink) return;
            const corners = [
                [localBBox.x, localBBox.y],
                [localBBox.x + localBBox.width, localBBox.y],
                [localBBox.x, localBBox.y + localBBox.height],
                [localBBox.x + localBBox.width, localBBox.y + localBBox.height],
            ];
            for (const [x, y] of corners) {
                const p = transformPoint(currentMatrix, x, y);
                openLink.minX = Math.min(openLink.minX, p.x);
                openLink.minY = Math.min(openLink.minY, p.y);
                openLink.maxX = Math.max(openLink.maxX, p.x);
                openLink.maxY = Math.max(openLink.maxY, p.y);
            }
        },
        flush,
    };
};
