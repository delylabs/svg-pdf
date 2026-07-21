import * as fs from 'fs';
import * as path from 'path';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import type {
    ImageInstruction,
    MarkerInstruction,
    ParsedSvgDocument,
    ShapeInstruction,
    TextInstruction,
    TextPathInstruction,
} from '..';

type ParsedDoc = ParsedSvgDocument;

export const el = (svg: string): Element => {
    const doc = new XmlDomParser({ onError: () => {} }).parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement as unknown as Element;
    // xmldom doesn't implement `firstElementChild` (ElementTraversal) — filter childNodes for an actual element (nodeType 1) instead.
    return Array.from(root.childNodes).find((n): n is Element => n.nodeType === 1)!;
};

export const shapesOf = (doc: ParsedDoc): ShapeInstruction[] =>
    doc.instructions.filter((i): i is ShapeInstruction => i.type === 'shape');

export const textsOf = (doc: ParsedDoc): TextInstruction[] =>
    doc.instructions.filter((i): i is TextInstruction => i.type === 'text');

export const imagesOf = (doc: ParsedDoc): ImageInstruction[] =>
    doc.instructions.filter((i): i is ImageInstruction => i.type === 'image');

export const markersOf = (doc: ParsedDoc): MarkerInstruction[] =>
    doc.instructions.filter((i): i is MarkerInstruction => i.type === 'marker');

export const textPathsOf = (doc: ParsedDoc): TextPathInstruction[] =>
    doc.instructions.filter((i): i is TextPathInstruction => i.type === 'textPath');

// A real, minimal 1x1 transparent PNG — deterministic for aspect-ratio math in svgEmbed tests too.
export const ONE_PIXEL_PNG_DATA_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const FIXTURES_DIR = path.resolve(process.cwd(), 'test-fixtures/custom');

export const hasFixtures = fs.existsSync(FIXTURES_DIR);

export const loadFixture = (name: string): string =>
    fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
