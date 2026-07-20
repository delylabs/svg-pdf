export interface Matrix2D {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly e: number;
    readonly f: number;
}

export const IDENTITY_MATRIX: Matrix2D = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
};

/**
 * Combines two matrices as "apply m1 first, then m2" (m1 ∘ m2 in row-vector
 * form: [x y 1] * m1 * m2). This is the same convention SVG's own
 * `matrix(a,b,c,d,e,f)` and PDF's `cm` operator both use, so matrices built
 * here can be handed to @libpdf/core's `ops.concatMatrix()` unmodified.
 */
export const multiplyMatrix = (m1: Matrix2D, m2: Matrix2D): Matrix2D => ({
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
});

export const isIdentityMatrix = (m: Matrix2D): boolean =>
    m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/*
 * Standard 2x3 affine inverse — used to "undo" a clipPathUnits=objectBoundingBox
 * scale after building the clip path, without touching the clip itself (see
 * the `pushClip` handling in svgEmbed.ts for why that can't just be a q/Q pop).
 */
export const invertMatrix = (m: Matrix2D): Matrix2D => {
    const det = m.a * m.d - m.b * m.c;
    if (det === 0) return IDENTITY_MATRIX;
    const a = m.d / det;
    const b = -m.b / det;
    const c = -m.c / det;
    const d = m.a / det;
    return {
        a,
        b,
        c,
        d,
        e: -(m.e * a + m.f * c),
        f: -(m.e * b + m.f * d),
    };
};

const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export const parseFloats = (input: string): number[] => (input.match(NUMBER_RE) ?? []).map(Number);

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export const translateMatrix = (tx: number, ty = 0): Matrix2D => ({
    ...IDENTITY_MATRIX,
    e: tx,
    f: ty,
});

export const scaleMatrix = (sx: number, sy = sx): Matrix2D => ({
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: 0,
    f: 0,
});

const rotateMatrix = (deg: number, cx = 0, cy = 0): Matrix2D => {
    const rad = degToRad(deg);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotation: Matrix2D = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
    if (cx === 0 && cy === 0) return rotation;
    return multiplyMatrix(
        multiplyMatrix(translateMatrix(cx, cy), rotation),
        translateMatrix(-cx, -cy),
    );
};

const skewXMatrix = (deg: number): Matrix2D => ({
    ...IDENTITY_MATRIX,
    c: Math.tan(degToRad(deg)),
});

const skewYMatrix = (deg: number): Matrix2D => ({
    ...IDENTITY_MATRIX,
    b: Math.tan(degToRad(deg)),
});

const TRANSFORM_FN_RE = /(\w+)\s*\(([^)]*)\)/g;

/**
 * Parses an SVG `transform` attribute value (e.g. `"translate(10,20) scale(2)"`)
 * into a single net matrix. Per the SVG spec, functions listed left to right
 * nest like `<g transform="A"><g transform="B">` — B (written second, but
 * innermost) applies to a point first, then A applies to that result. Folding
 * the list with `multiplyMatrix(fn, accumulatedSoFar)` — instead of the other
 * way round — reproduces that inside-out application order.
 */
export const parseTransformList = (transformAttr: string | null): Matrix2D => {
    if (!transformAttr) return IDENTITY_MATRIX;

    let combined = IDENTITY_MATRIX;
    for (const match of transformAttr.matchAll(TRANSFORM_FN_RE)) {
        const [, name, argsRaw] = match;
        const args = parseFloats(argsRaw);
        let fn: Matrix2D;
        switch (name) {
            case 'translate':
                fn = translateMatrix(args[0] ?? 0, args[1] ?? 0);
                break;
            case 'scale':
                fn = scaleMatrix(args[0] ?? 1, args[1] ?? args[0] ?? 1);
                break;
            case 'rotate':
                fn = rotateMatrix(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
                break;
            case 'skewX':
                fn = skewXMatrix(args[0] ?? 0);
                break;
            case 'skewY':
                fn = skewYMatrix(args[0] ?? 0);
                break;
            case 'matrix':
                fn = {
                    a: args[0] ?? 1,
                    b: args[1] ?? 0,
                    c: args[2] ?? 0,
                    d: args[3] ?? 1,
                    e: args[4] ?? 0,
                    f: args[5] ?? 0,
                };
                break;
            default:
                continue;
        }
        combined = multiplyMatrix(fn, combined);
    }
    return combined;
};
