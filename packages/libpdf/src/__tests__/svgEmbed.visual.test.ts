import { PDF as LibPDF } from '@libpdf/core';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../svgEmbed';
import { diffImages, encodePng } from './visual/diff';
import { rasterizePdfPage, rasterizeSvg } from './visual/raster';

const FIXTURES_DIR = path.join(__dirname, '../../../../test-fixtures/custom');
const DEBUG_OUT_DIR = path.join(__dirname, '../../../../test-fixtures/visual-baselines/.debug');

const TARGET_WIDTH = 800;
const MAX_MISMATCH_RATIO = 0.12;

/*
 * Fixtures whose root exercises an SVG feature Plotify doesn't parse yet
 * (tracked in the package README's "Not yet supported" list) necessarily
 * render blank/near-blank until that gap closes — comparing them against
 * their full source SVG would always fail for a reason unrelated to
 * regressions, so they're excluded here rather than given a fake threshold.
 */
const KNOWN_UNSUPPORTED_ROOT: Record<string, string> = {
    'nested-svg-scene.svg': 'nested <svg> is not parsed yet',
};

const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.svg') && !(name in KNOWN_UNSUPPORTED_ROOT));

describe('SVG-vs-PDF visual regression (custom fixtures)', () => {
    it.each(fixtures)('%s renders close to its source SVG', async (fixtureName) => {
        const svgText = fs.readFileSync(path.join(FIXTURES_DIR, fixtureName), 'utf8');

        const doc = LibPDF.create();
        await embedSvgInPdf(doc, { svgText, rotation: 0 });
        const page = doc.getPages()[0];
        const pdfBytes = await doc.save();

        const scale = TARGET_WIDTH / page.width;
        const svgRaster = rasterizeSvg(svgText, TARGET_WIDTH);
        const pdfRaster = await rasterizePdfPage(pdfBytes, 0, scale);

        const result = diffImages(svgRaster, pdfRaster);

        if (result.mismatchRatio > MAX_MISMATCH_RATIO) {
            fs.mkdirSync(DEBUG_OUT_DIR, { recursive: true });
            const base = fixtureName.replace(/\.svg$/, '');
            fs.writeFileSync(path.join(DEBUG_OUT_DIR, `${base}.diff.png`), result.diffPng);
            fs.writeFileSync(path.join(DEBUG_OUT_DIR, `${base}.svg.png`), encodePng(svgRaster));
            fs.writeFileSync(path.join(DEBUG_OUT_DIR, `${base}.pdf.png`), encodePng(pdfRaster));
        }

        expect(
            result.mismatchRatio,
            `mismatch ratio ${(result.mismatchRatio * 100).toFixed(2)}% exceeds ${(MAX_MISMATCH_RATIO * 100).toFixed(0)}% for ${fixtureName} (see ${DEBUG_OUT_DIR})`,
        ).toBeLessThanOrEqual(MAX_MISMATCH_RATIO);
    });
});
