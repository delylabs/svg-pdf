import { describe, expect, it } from 'vitest';

import { parseSvgDocument } from '..';

describe('parseSvgDocument with textPath enhancements', () => {
    it('parses nested tspan elements inside textPath', () => {
        const svg = `
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                <path id="curve" d="M 10 100 Q 100 10 190 100" />
                <text>
                    <textPath href="#curve">
                        Header <tspan fill="#ff0000" font-weight="bold">Bold Sub</tspan> Tail
                    </textPath>
                </text>
            </svg>
        `;
        const parsed = parseSvgDocument(svg);
        const textPaths = parsed.instructions.filter((i) => i.type === 'textPath');
        expect(textPaths.length).toBeGreaterThanOrEqual(2);
        expect(textPaths[0].continuesFlow).toBe(false);
        expect(textPaths[0].startsNewChunk).toBe(true);
        expect(textPaths[1].continuesFlow).toBe(true);
        expect(textPaths[1].startsNewChunk).toBe(false);
        expect(textPaths[1].fill).toEqual({ r: 255, g: 0, b: 0 });
        expect(textPaths[1].fontWeight).toBe('bold');
    });
});
