import { defineConfig } from 'tsdown';

export default defineConfig([
    // Node/bundler consumers: dependencies stay external, resolved via npm as usual.
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        platform: 'neutral',
        dts: true,
        clean: true,
    },
    // CDN/<script> tag consumers: no npm resolution available, so dependencies are bundled in.
    {
        entry: { 'index.global': 'src/index.ts' },
        format: ['iife'],
        platform: 'browser',
        globalName: 'SvgPdfCore',
        deps: { alwaysBundle: ['@xmldom/xmldom', 'css-select', 'css-what'] },
        dts: false,
        clean: false,
        minify: true,
    },
]);
