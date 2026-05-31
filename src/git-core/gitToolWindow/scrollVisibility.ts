/**
 * Pure scroll-visibility predicate for the Git Tool Window commit graph.
 *
 * Feature: git-graph-branch-click-scroll.
 *
 * This is a dependency-free module — it imports neither `vscode` nor any DOM
 * type. It holds the *pure* part of the branch-click scroll decision: given the
 * four numbers describing a commit row's vertical extent relative to its scroll
 * container's viewport, decide whether the row is fully visible and, from that,
 * whether the webview should scroll to bring it into view.
 *
 * Why a separate module (ADR-009 host-owns-logic): the actual geometry
 * measurement (`getBoundingClientRect`, `scrollTop`, `clientHeight`) happens in
 * the webview because the scroll position is webview-owned ephemeral UI state
 * (ADR-009 §2). Inline-script template literals are hard to unit test, so the
 * decision is extracted here as a pure predicate that is property-testable, and
 * the inline script mirrors the identical `>=` / `<=` comparison.
 *
 * Conventions pinned by tests:
 * - **Edge touch counts as visible.** A row whose top edge sits exactly on the
 *   viewport top (`rowTop === viewportTop`) or whose bottom edge sits exactly on
 *   the viewport bottom (`rowBottom === viewportBottom`) is considered fully
 *   visible. This is why the comparisons use `>=` and `<=` rather than `>` / `<`.
 * - **A row taller than the viewport can never be fully visible.** When
 *   `rowBottom - rowTop > viewportBottom - viewportTop`, the row cannot fit
 *   inside the viewport, so `isRowFullyVisible` returns `false` and
 *   `shouldScrollToRow` returns `true` — we still bring such a row into view.
 */

/** Vertical geometry of a commit row relative to its scroll container. */
export interface IRowViewportGeometry {
  /** Row top edge, in the scroll container's content coordinate space (px). */
  rowTop: number;
  /** Row bottom edge (rowTop + rowHeight), same space (px). rowBottom >= rowTop. */
  rowBottom: number;
  /** Visible viewport top = container scrollTop (px). */
  viewportTop: number;
  /** Visible viewport bottom = scrollTop + clientHeight (px). viewportBottom >= viewportTop. */
  viewportBottom: number;
}

/**
 * A row is fully visible when its entire vertical extent lies within the
 * viewport: `rowTop >= viewportTop` AND `rowBottom <= viewportBottom`.
 *
 * Edge rows touching the boundary exactly count as fully visible (the `>=` /
 * `<=` convention). A row taller than the viewport can never satisfy both
 * comparisons, so it is reported as not fully visible.
 */
export function isRowFullyVisible(g: IRowViewportGeometry): boolean {
  return g.rowTop >= g.viewportTop && g.rowBottom <= g.viewportBottom;
}

/**
 * The scroll decision: scroll iff the row is NOT fully visible.
 * Pure inverse of {@link isRowFullyVisible}; named for call-site clarity.
 */
export function shouldScrollToRow(g: IRowViewportGeometry): boolean {
  return !isRowFullyVisible(g);
}
