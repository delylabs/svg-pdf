const DATA_URI_RE = /^data:([^,]*),([\s\S]*)$/;

/*
 * Decodes a `data:<mime>[;base64],<payload>` URI into raw bytes. The
 * `;base64` parameter is optional — plain/percent-encoded payloads (common
 * for hand-authored `data:image/svg+xml,...`) are decoded via
 * `decodeURIComponent` + UTF-8 encoding instead. Returns `null` for
 * anything else (missing/invalid payload) — the caller turns that into a
 * skip-with-warning.
 */
export const decodeDataUri = (href: string): { bytes: Uint8Array; mimeType: string } | null => {
    const match = DATA_URI_RE.exec(href);
    if (!match) return null;
    const [, header, payload] = match;
    const params = header.split(';');
    const mimeType = params[0] || 'image/png';
    const isBase64 = params.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
    try {
        if (isBase64) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return { bytes, mimeType };
        }
        return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
    } catch {
        return null;
    }
};

// Only http(s) is ever handed to `fetchImage` — a defense-in-depth check independent of whatever the caller's own fetcher does, so a malformed/unexpected href scheme (e.g. `file:`) can never reach it.
export const EXTERNAL_URL_RE = /^https?:\/\//i;
