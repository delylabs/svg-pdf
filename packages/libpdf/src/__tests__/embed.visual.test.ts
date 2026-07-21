import { PDF as LibPDF } from '@libpdf/core';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { embedSvgInPdf } from '../embed';
import { diffImages, encodePng } from './visual/diff';
import { rasterizePdfPage, rasterizeSvg } from './visual/raster';

const FIXTURES_DIR = path.join(__dirname, '../../../../test-fixtures/custom');
const DEBUG_OUT_DIR = path.join(__dirname, '../../../../test-fixtures/visual-baselines/.debug');

const TARGET_WIDTH = 800;
const MAX_MISMATCH_RATIO = 0.05;

/*
 * Fixtures whose root exercises an SVG feature svg-pdf doesn't parse yet
 * (tracked in the package README's "Not yet supported" list) necessarily
 * render blank/near-blank until that gap closes — comparing them against
 * their full source SVG would always fail for a reason unrelated to
 * regressions, so they're excluded here rather than given a fake threshold.
 */
const KNOWN_UNSUPPORTED_ROOT: Record<string, string> = {};

/*
 * `rasterizeSvg` (the "ground truth" side of every comparison below) is
 * powered by resvg — generally excellent SVG-spec compliance, but not
 * perfect. When a fixture's PDF output visually looks *correct* on manual
 * inspection (and/or is independently covered by a passing parse-level unit
 * test) while resvg's own rendering of the same source SVG is missing
 * content, that's a resvg bug, not a svg-pdf regression — don't "fix" our
 * code to match resvg's wrong output. Instead, write the fixture so it
 * avoids the specific trigger while still exercising the feature under
 * test (same approach as `symbol-viewport-percent.svg` and
 * `clip-path-use-and-group.svg`). Known triggers so far, so a future
 * mismatch matching one of these is recognized quickly instead of
 * re-investigated from scratch:
 * - A `<symbol>` whose children use percentage-based geometry (`width="50%"`
 *   etc.) — resvg mispositions/misrenders them. See git history around
 *   `symbol-viewport-percent.svg` for the original investigation.
 * - A `<g>` element nested directly inside a `<clipPath>` — resvg drops it
 *   (and everything inside it) from the clip region entirely, with or
 *   without a `transform` on the `<g>`. A `<clipPath>` child with its own
 *   `transform` attribute (no `<g>` wrapper) renders fine.
 */

const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.svg') && !(name in KNOWN_UNSUPPORTED_ROOT));

// Collected instead of logged per-test, so the mismatch ratios print as one block instead of a "stdout | ..." header per fixture.
const mismatchSummary: string[] = [];
afterAll(() => {
    console.log(mismatchSummary.join('\n'));
});

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

        mismatchSummary.push(
            `${fixtureName}: ${(result.mismatchRatio * 100).toFixed(2)}% mismatch`,
        );

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
