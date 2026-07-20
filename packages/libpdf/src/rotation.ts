/**
 * @libpdf/core's setRotation() only accepts the 0/90/180/270 literal union, unlike
 * pdf-lib's degrees() which accepted any number. Non-multiples of 90 are silently reset
 * to 0 internally instead of rounded, so normalize defensively before calling it.
 */
export const normalizeRotation = (deg: number): 0 | 90 | 180 | 270 => {
    const normalized = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
    return normalized as 0 | 90 | 180 | 270;
};
