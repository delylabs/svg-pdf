import { defineConfig } from 'tsdown';

// No CDN/IIFE build here: the @libpdf/core peer dependency ships ESM-only,
// with no browser bundle of its own, so a standalone <script>-tag build
// isn't possible until it provides one.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'neutral',
    dts: true,
    clean: true,
});
