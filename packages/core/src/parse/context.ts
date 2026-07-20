import type { ShapeViewport } from '../geometry/path';
import type { PaintContext } from '../style/paint';
import type { MarkerDef, SvgInstruction } from '../types';

export interface WalkContext extends PaintContext {
    readonly instructions: SvgInstruction[];
    readonly visitedUseIds: ReadonlySet<string>;
    readonly markers: Map<string, MarkerDef>;
    /*
     * The root <svg>'s viewBox size — the percentage basis for a shape's own
     * `%`-valued geometry (`x="50%"`, etc). A nested `<svg>`/`<symbol>`
     * establishing its own smaller viewport isn't tracked, so this stays the
     * root's size throughout the whole walk, not the locally nested one.
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
