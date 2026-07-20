/*
 * Manual visual-check tool: renders SVG files through svg-pdf exactly the
 * way the library does, so you can open the resulting PDFs yourself and
 * judge them with your own eyes instead of trusting only the automated
 * pixel-diff test suite (whose tolerance can mask small positional bugs —
 * see packages/libpdf/src/__tests__/svgEmbed.visual.test.ts's
 * MAX_MISMATCH_RATIO).
 *
 * Usage:
 *   npm run render -- <input.svg> <output.pdf>     renders one file
 *   npm run render                                 renders every fixture in
 *                                                  test-fixtures/custom into
 *                                                  test-fixtures/rendered/
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { PDF as LibPDF } from '@libpdf/core';
import { embedSvgInPdf } from '@svg-pdf/libpdf';

const FIXTURES_DIR = path.join(import.meta.dirname, '../test-fixtures/custom');
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, '../test-fixtures/rendered');

const renderOne = async (inputPath: string, outputPath: string): Promise<void> => {
    const svgText = readFileSync(inputPath, 'utf8');
    const doc = LibPDF.create();
    await embedSvgInPdf(doc, { svgText, rotation: 0 });
    writeFileSync(outputPath, await doc.save());
    console.log(`Wrote ${outputPath}`);
};

const [inputPath, outputPath] = process.argv.slice(2);

if (inputPath && outputPath) {
    await renderOne(inputPath, outputPath);
} else if (!inputPath) {
    mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
    const fixtures = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.svg'));
    for (const name of fixtures) {
        await renderOne(
            path.join(FIXTURES_DIR, name),
            path.join(DEFAULT_OUT_DIR, name.replace(/\.svg$/, '.pdf')),
        );
    }
} else {
    console.error(
        'Usage: npm run render -- <input.svg> <output.pdf>  (or no args to render all of test-fixtures/custom)',
    );
    process.exit(1);
}
