import { type Matrix2D, multiplyMatrix, scaleMatrix, translateMatrix } from './matrix';

export type PreserveAspectRatioAlign =
    | 'none'
    | 'xMinYMin'
    | 'xMidYMin'
    | 'xMaxYMin'
    | 'xMinYMid'
    | 'xMidYMid'
    | 'xMaxYMid'
    | 'xMinYMax'
    | 'xMidYMax'
    | 'xMaxYMax';

export type PreserveAspectRatioMeetOrSlice = 'meet' | 'slice';

export interface ParsedPreserveAspectRatio {
    readonly align: PreserveAspectRatioAlign;
    readonly meetOrSlice: PreserveAspectRatioMeetOrSlice;
}

const ALIGN_VALUES = new Set<string>([
    'none',
    'xMinYMin',
    'xMidYMin',
    'xMaxYMin',
    'xMinYMid',
    'xMidYMid',
    'xMaxYMid',
    'xMinYMax',
    'xMidYMax',
    'xMaxYMax',
]);

// Per spec section 7.11: an absent/empty/unrecognized value defaults to "xMidYMid meet".
export const parsePreserveAspectRatio = (value: string | null): ParsedPreserveAspectRatio => {
    const parts = (value ?? '')
        .trim()
        .split(/\s+/)
        .filter((p) => p !== '' && p !== 'defer');
    const alignRaw = parts[0];
    const align: PreserveAspectRatioAlign = ALIGN_VALUES.has(alignRaw)
        ? (alignRaw as PreserveAspectRatioAlign)
        : 'xMidYMid';
    const meetOrSlice: PreserveAspectRatioMeetOrSlice = parts[1] === 'slice' ? 'slice' : 'meet';
    return { align, meetOrSlice };
};

/*
 * Maps `viewBox` space onto a (vpWidth x vpHeight) viewport per spec section
 * 7.11 — the shared algorithm behind the root <svg>'s own viewBox-to-page
 * fit, `<use>`-of-`<symbol>`, and nested <svg>. The returned matrix positions
 * the viewport's origin at (0,0) in its *own* local space; a separate
 * translate (the root's page-centering offset, a nested <svg>'s x/y, etc.)
 * composes on top of this by the caller, same as before this existed.
 *
 * `align="none"` stretches each axis independently to exactly fill the
 * viewport (no letterboxing). Otherwise both axes share one uniform scale —
 * the smaller of the two ratios for "meet" (the whole viewBox fits inside,
 * built-in letterboxing), the larger for "slice" (the viewport is fully
 * covered, the viewBox overflows and relies on the caller's own clip) — and
 * any leftover space is distributed per the alignment keyword (Min: none of
 * it, Mid: split evenly on both sides, Max: all of it on the leading side).
 */
export const computeViewBoxTransform = (
    vbX: number,
    vbY: number,
    vbWidth: number,
    vbHeight: number,
    vpWidth: number,
    vpHeight: number,
    preserveAspectRatio: string | null,
): Matrix2D => {
    const { align, meetOrSlice } = parsePreserveAspectRatio(preserveAspectRatio);
    const rawScaleX = vbWidth > 0 ? vpWidth / vbWidth : 1;
    const rawScaleY = vbHeight > 0 ? vpHeight / vbHeight : 1;

    let scaleX = rawScaleX;
    let scaleY = rawScaleY;
    if (align !== 'none') {
        const scale =
            meetOrSlice === 'slice'
                ? Math.max(rawScaleX, rawScaleY)
                : Math.min(rawScaleX, rawScaleY);
        scaleX = scale;
        scaleY = scale;
    }

    let alignOffsetX = 0;
    let alignOffsetY = 0;
    if (align !== 'none') {
        const extraWidth = vpWidth - vbWidth * scaleX;
        const extraHeight = vpHeight - vbHeight * scaleY;
        if (align.startsWith('xMid')) alignOffsetX = extraWidth / 2;
        else if (align.startsWith('xMax')) alignOffsetX = extraWidth;
        if (align.endsWith('YMid')) alignOffsetY = extraHeight / 2;
        else if (align.endsWith('YMax')) alignOffsetY = extraHeight;
    }

    return multiplyMatrix(
        multiplyMatrix(translateMatrix(-vbX, -vbY), scaleMatrix(scaleX, scaleY)),
        translateMatrix(alignOffsetX, alignOffsetY),
    );
};
