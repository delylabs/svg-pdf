import type { ShapeViewport } from '../geometry/path';
import type { PaintContext } from '../style/paint';
import type { MarkerDef, SvgInstruction } from '../types';

export interface WalkContext extends PaintContext {
    readonly instructions: SvgInstruction[];
    readonly visitedUseIds: ReadonlySet<string>;
    readonly markers: Map<string, MarkerDef>;
    /*
     * The current viewport's size (its viewBox, if it has one, else its raw
     * width/height) — the percentage basis for a shape's own `%`-valued
     * geometry (`x="50%"`, etc). Starts as the root <svg>'s size and is
     * swapped for a narrower `WalkContext` (see `walk.ts`'s `tag === 'svg'`
     * branch) while walking a nested `<svg>`'s children, so percentages
     * resolve against whichever viewport their element actually lives in.
     * `<symbol>` (reached via `<use>`) does not yet get the same treatment.
     */
    readonly viewport: ShapeViewport;
    /*
     * Resolves a <marker> element with cycle protection scoped to the
     * *current* resolution chain — injected fresh (with an extended `visited`
     * set) each time `resolveMarkerDef` builds a nested content context, so a
     * marker whose own content marks a path pointing back to itself is caught
     * the same way `resolvePattern` catches a self-filling pattern.
     */
    readonly resolveMarker: (el: Element) => MarkerDef | null;
}
