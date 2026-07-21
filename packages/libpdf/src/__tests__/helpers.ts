import { type PDF as LibPDF, PdfArray, type PdfDict, type PdfRef, PdfStream } from '@libpdf/core';
import * as fs from 'fs';
import * as path from 'path';

// A real, minimal 1x1 transparent PNG — same constant as core's __tests__/helpers.ts, aspectRatio 1 makes "meet" fit math easy to verify by hand.
export const ONE_PIXEL_PNG_DATA_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// A real TTF already vendored as a dev dependency (visual-regression tests use the same pdfjs-dist package to rasterize PDFs) — reused here as stand-in "custom font bytes" for fetchFont tests, rather than adding a new font fixture just for this.
export const LIBERATION_SANS_TTF = path.resolve(
    process.cwd(),
    'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
);

// Decodes a page's content stream to text for asserting on raw operators.
export const getPageContentText = (
    doc: ReturnType<typeof LibPDF.create>,
    pageIndex: number,
): string => {
    const page = doc.getPages()[pageIndex];
    const contents = page.dict.get('Contents');
    if (!contents) return '';
    const refs = contents instanceof PdfArray ? [...contents] : [contents];
    return refs
        .map((ref) => doc.getObject(ref as PdfRef) as PdfStream)
        .map((stream) => new TextDecoder('latin1').decode(stream.getDecodedData()))
        .join('\n');
};

// Decodes the content stream of a named pattern resource (as registered in the page's /Resources /Pattern dict) — mirrors getPageContentText, but for a pattern's own private stream rather than the page's.
export const getPatternContentText = (
    doc: ReturnType<typeof LibPDF.create>,
    pageIndex: number,
    patternName: string,
): string => {
    const page = doc.getPages()[pageIndex];
    const resources = page.dict.get('Resources') as PdfDict;
    const patternDict = resources.get('Pattern') as PdfDict;
    const patternRef = patternDict.get(patternName) as PdfRef;
    const patternStream = doc.getObject(patternRef) as PdfStream;
    return new TextDecoder('latin1').decode(patternStream.getDecodedData());
};

// Same idea as getPatternContentText, but for a Form XObject (/Resources /XObject) — used by <marker>.
export const getXObjectContentText = (
    doc: ReturnType<typeof LibPDF.create>,
    pageIndex: number,
    xobjectName: string,
): string => {
    const page = doc.getPages()[pageIndex];
    const resources = page.dict.get('Resources') as PdfDict;
    const xobjectDict = resources.get('XObject') as PdfDict;
    const xobjectRef = xobjectDict.get(xobjectName) as PdfRef;
    const xobjectStream = doc.getObject(xobjectRef) as PdfStream;
    return new TextDecoder('latin1').decode(xobjectStream.getDecodedData());
};

const FIXTURES_DIR = path.resolve(process.cwd(), 'test-fixtures/custom');

export const hasFixtures = fs.existsSync(FIXTURES_DIR);

export const loadFixture = (name: string): string =>
    fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
