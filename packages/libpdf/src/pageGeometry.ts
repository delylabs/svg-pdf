export type PageOrientation = 'portrait' | 'landscape' | 'auto';

/**
 * Applies an orientation to a canonical portrait page size (width <= height).
 * `'auto'` picks landscape when the image itself is wider than it is tall.
 */
export const resolvePageOrientation = (
    pageSize: { width: number; height: number },
    orientation: PageOrientation,
    imgWidth: number,
    imgHeight: number,
): { width: number; height: number } => {
    const wantsLandscape =
        orientation === 'landscape' || (orientation === 'auto' && imgWidth > imgHeight);
    return wantsLandscape ? { width: pageSize.height, height: pageSize.width } : pageSize;
};

/**
 * Fits an image onto a page, centered, respecting an optional margin.
 * With no `pageSize`, the page grows to hug the image plus the margin
 * (image drawn at native size). With a `pageSize`, the image is scaled
 * to fill the margin-inset box while preserving aspect ratio, then centered.
 */
export const fitImageToPage = (
    imgWidth: number,
    imgHeight: number,
    pageSize?: { width: number; height: number },
    margin = 0,
) => {
    const pageWidth = pageSize ? pageSize.width : imgWidth + margin * 2;
    const pageHeight = pageSize ? pageSize.height : imgHeight + margin * 2;
    const scale = pageSize
        ? Math.min((pageWidth - margin * 2) / imgWidth, (pageHeight - margin * 2) / imgHeight)
        : 1;
    const drawWidth = imgWidth * scale;
    const drawHeight = imgHeight * scale;

    return {
        pageWidth,
        pageHeight,
        drawWidth,
        drawHeight,
        drawX: (pageWidth - drawWidth) / 2,
        drawY: (pageHeight - drawHeight) / 2,
    };
};
