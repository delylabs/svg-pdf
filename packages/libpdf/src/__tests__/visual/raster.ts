import { createCanvas } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const STANDARD_FONT_DATA_URL = `${path
    .join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
    .replace(/\\/g, '/')}/`;

export interface RasterImage {
    width: number;
    height: number;
    rgba: Buffer;
}

export const rasterizeSvg = (svgText: string, width: number): RasterImage => {
    const resvg = new Resvg(svgText, {
        fitTo: { mode: 'width', value: Math.round(width) },
        background: 'white',
    });
    const rendered = resvg.render();
    return {
        width: rendered.width,
        height: rendered.height,
        rgba: Buffer.from(rendered.pixels),
    };
};

export const rasterizePdfPage = async (
    pdfBytes: Uint8Array,
    pageIndex: number,
    scale: number,
): Promise<RasterImage> => {
    const pdf = await pdfjsLib.getDocument({
        data: pdfBytes,
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
    }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
        width: canvas.width,
        height: canvas.height,
        rgba: Buffer.from(imageData.data),
    };
};
