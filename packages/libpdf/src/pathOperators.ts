import { ops } from '@libpdf/core';

import type { NormalizedPathSegment } from '@delylabs/plotify';

// Converts core's normalized (absolute M/L/C/Z) path segments into raw PDF path-construction operators — used to build a pattern cell's content, which (unlike a page) has no `PathBuilder`/`appendSvgPath` of its own to draw through (see `pattern.ts`'s module doc comment).
export const pathSegmentsToOperators = (
    segments: readonly NormalizedPathSegment[],
): ReturnType<typeof ops.moveTo>[] =>
    segments.map((seg) => {
        switch (seg.cmd) {
            case 'M':
                return ops.moveTo(seg.x, seg.y);
            case 'L':
                return ops.lineTo(seg.x, seg.y);
            case 'C':
                return ops.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
            case 'Z':
                return ops.closePath();
        }
    });
