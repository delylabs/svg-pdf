import { describe, expect, it } from 'vitest';

import { parseSvgColor } from '..';

describe('parseSvgColor', () => {
    it('parses 3 and 6-digit hex', () => {
        expect(parseSvgColor('#f00')).toEqual({ r: 255, g: 0, b: 0 });
        expect(parseSvgColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('parses rgb()', () => {
        expect(parseSvgColor('rgb(10, 20, 30)')).toEqual({
            r: 10,
            g: 20,
            b: 30,
        });
    });

    it('parses named CSS colors', () => {
        expect(parseSvgColor('cornflowerblue')).toEqual({
            r: 100,
            g: 149,
            b: 237,
        });
    });

    it('treats none/transparent as no paint', () => {
        expect(parseSvgColor('none')).toBeNull();
        expect(parseSvgColor('transparent')).toBeNull();
        expect(parseSvgColor(null)).toBeNull();
    });
});
