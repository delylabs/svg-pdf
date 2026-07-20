const DATA_URI_RE = /^data:([^;,]*);base64,([\s\S]*)$/;

// Decodes a `data:<mime>;base64,<payload>` URI into raw bytes. Returns `null` for anything else (missing/invalid base64) — the caller turns that into a skip-with-warning.
export const decodeDataUri = (href: string): { bytes: Uint8Array; mimeType: string } | null => {
    const match = DATA_URI_RE.exec(href);
    if (!match) return null;
    const [, mimeType, base64] = match;
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return { bytes, mimeType: mimeType || 'image/png' };
    } catch {
        return null;
    }
};

// Only http(s) is ever handed to `fetchImage` — a defense-in-depth check independent of whatever the caller's own fetcher does, so a malformed/unexpected href scheme (e.g. `file:`) can never reach it.
export const EXTERNAL_URL_RE = /^https?:\/\//i;
