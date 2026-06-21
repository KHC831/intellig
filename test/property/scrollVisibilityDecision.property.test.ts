/**
 * Property-based tests for the pure scroll-visibility decision predicate.
 *
 * Feature: git-graph-branch-click-scroll
 *
 * Target: src/git-core/gitToolWindow/scrollVisibility.ts
 *
 * These tests pin the contract of `shouldScrollToRow` / `isRowFullyVisible`,
 * the pure core of the branch-click scroll fix. Each property is tagged with
 * its feature + property reference and the requirements it validates. Tasks
 * 1.2–1.5 append four more property `it` blocks into the single top-level
 * `describe` below.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IRowViewportGeometry,
  isRowFullyVisible,
  shouldScrollToRow,
} from '../../src/git-core/gitToolWindow/scrollVisibility';

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * A finite, non-negative pixel coordinate. Bounded so the arithmetic relations
 * (row inside / crossing viewport) stay well-defined and shrinking is fast.
 */
function arbitraryPx(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 100000 });
}

/**
 * Generate geometry where the row lies entirely within the viewport:
 * `viewportTop <= rowTop <= rowBottom <= viewportBottom`.
 *
 * Strategy: pick the viewport bounds first (with a non-negative height), then
 * place the row's top/bottom anywhere inside that closed interval.
 */
function arbitraryFullyVisibleGeometry(): fc.Arbitrary<IRowViewportGeometry> {
  return arbitraryPx()
    .chain((viewportTop) =>
      // viewportBottom >= viewportTop (non-negative viewport height).
      fc
        .integer({ min: viewportTop, max: 100000 })
        .map((viewportBottom) => ({ viewportTop, viewportBottom }))
    )
    .chain(({ viewportTop, viewportBottom }) =>
      // rowTop and rowBottom both inside [viewportTop, viewportBottom], rowBottom >= rowTop.
      fc
        .integer({ min: viewportTop, max: viewportBottom })
        .chain((rowTop) =>
          fc
            .integer({ min: rowTop, max: viewportBottom })
            .map((rowBottom) => ({ viewportTop, viewportBottom, rowTop, rowBottom }))
        )
    );
}

/**
 * Generate geometry where the row is NOT fully visible because it crosses a
 * viewport edge: the row extends above the viewport top (`rowTop < viewportTop`)
 * OR below the viewport bottom (`rowBottom > viewportBottom`). The invariants
 * `rowBottom >= rowTop` and `viewportBottom >= viewportTop` are always held.
 *
 * Strategy: build each crossing direction by construction so it is always
 * feasible (no impossible "full-span viewport" case), then pick one:
 *
 * - "above": leave room above by choosing `viewportTop >= 1`, then place
 *   `rowTop` strictly below `viewportTop` (`0 <= rowTop <= viewportTop - 1`) with
 *   `rowBottom >= rowTop`.
 * - "below": leave room below by choosing `viewportBottom <= 99999`, then place
 *   `rowBottom` strictly above `viewportBottom`
 *   (`viewportBottom + 1 <= rowBottom <= 100000`) with `rowTop <= rowBottom`.
 */
function arbitraryOffScreenGeometry(): fc.Arbitrary<IRowViewportGeometry> {
  // Row crosses ABOVE the viewport top: rowTop < viewportTop.
  const above = fc
    .integer({ min: 1, max: 100000 })
    .chain((viewportTop) =>
      fc
        .integer({ min: viewportTop, max: 100000 })
        .map((viewportBottom) => ({ viewportTop, viewportBottom }))
    )
    .chain(({ viewportTop, viewportBottom }) =>
      fc
        .integer({ min: 0, max: viewportTop - 1 })
        .chain((rowTop) =>
          fc
            .integer({ min: rowTop, max: 100000 })
            .map((rowBottom) => ({ viewportTop, viewportBottom, rowTop, rowBottom }))
        )
    );

  // Row crosses BELOW the viewport bottom: rowBottom > viewportBottom.
  const below = fc
    .integer({ min: 0, max: 99999 })
    .chain((viewportTop) =>
      fc
        .integer({ min: viewportTop, max: 99999 })
        .map((viewportBottom) => ({ viewportTop, viewportBottom }))
    )
    .chain(({ viewportTop, viewportBottom }) =>
      fc
        .integer({ min: viewportBottom + 1, max: 100000 })
        .chain((rowBottom) =>
          fc
            .integer({ min: 0, max: rowBottom })
            .map((rowTop) => ({ viewportTop, viewportBottom, rowTop, rowBottom }))
        )
    );

  return fc.oneof(above, below);
}

/**
 * Generate fully arbitrary non-negative geometry that holds only the two
 * structural invariants the predicate assumes: `rowBottom >= rowTop` and
 * `viewportBottom >= viewportTop`. Both fully-visible and off-screen cases are
 * reachable here, which is exactly what Property 3 needs to exercise the
 * inverse relationship across the whole input space.
 *
 * Strategy: pick `rowTop`/`viewportTop` freely, then pick each bottom edge at or
 * above its corresponding top edge to satisfy the non-negative-height invariants.
 */
function arbitraryGeometry(): fc.Arbitrary<IRowViewportGeometry> {
  return fc
    .record({ rowTop: arbitraryPx(), viewportTop: arbitraryPx() })
    .chain(({ rowTop, viewportTop }) =>
      fc
        .integer({ min: rowTop, max: 100000 })
        .chain((rowBottom) =>
          fc
            .integer({ min: viewportTop, max: 100000 })
            .map((viewportBottom) => ({ rowTop, rowBottom, viewportTop, viewportBottom }))
        )
    );
}

/**
 * Generate geometry where the row is strictly TALLER than the viewport:
 * `rowBottom - rowTop > viewportBottom - viewportTop`. The structural
 * invariants `rowBottom >= rowTop` and `viewportBottom >= viewportTop` are
 * always held.
 *
 * Strategy (by construction so the "taller than viewport" relation always
 * holds): pick the viewport top and a non-negative viewport height first, then
 * pick a row height STRICTLY greater than the viewport height
 * (`rowHeight >= viewportHeight + 1`), then place the row's top anywhere and
 * derive its bottom from the chosen height.
 */
function arbitraryTallerThanViewportGeometry(): fc.Arbitrary<IRowViewportGeometry> {
  return arbitraryPx()
    .chain((viewportTop) =>
      // Non-negative viewport height; bounded so a strictly larger row height fits.
      fc.integer({ min: 0, max: 99999 }).map((viewportHeight) => ({ viewportTop, viewportHeight }))
    )
    .chain(({ viewportTop, viewportHeight }) =>
      // Row height strictly exceeds the viewport height.
      fc.integer({ min: viewportHeight + 1, max: 100000 }).chain((rowHeight) =>
        arbitraryPx().map((rowTop) => ({
          viewportTop,
          viewportBottom: viewportTop + viewportHeight,
          rowTop,
          rowBottom: rowTop + rowHeight,
        }))
      )
    );
}

/**
 * Generate geometry where the row touches a viewport edge exactly while
 * otherwise remaining inside the viewport, so the row stays fully visible:
 * either `rowTop === viewportTop` (top-touch) or `rowBottom === viewportBottom`
 * (bottom-touch). The structural invariants `rowBottom >= rowTop` and
 * `viewportBottom >= viewportTop` are always held.
 *
 * Strategy (by construction so the edge-touch always holds AND the row never
 * crosses the opposite edge): pick the viewport top and a non-negative viewport
 * height first, then pick one of two directions:
 *
 * - "top-touch": pin `rowTop = viewportTop`, then place `rowBottom` anywhere in
 *   `[rowTop, viewportBottom]` so the row stays inside the viewport.
 * - "bottom-touch": pin `rowBottom = viewportBottom`, then place `rowTop`
 *   anywhere in `[viewportTop, rowBottom]` so the row stays inside the viewport.
 */
function arbitraryBoundaryTouchingGeometry(): fc.Arbitrary<IRowViewportGeometry> {
  const base = arbitraryPx().chain((viewportTop) =>
    // Non-negative viewport height.
    fc
      .integer({ min: 0, max: 100000 })
      .map((viewportHeight) => ({ viewportTop, viewportBottom: viewportTop + viewportHeight }))
  );

  // Row touches the TOP edge exactly: rowTop === viewportTop, rowBottom inside.
  const topTouch = base.chain(({ viewportTop, viewportBottom }) =>
    fc.integer({ min: viewportTop, max: viewportBottom }).map((rowBottom) => ({
      viewportTop,
      viewportBottom,
      rowTop: viewportTop,
      rowBottom,
    }))
  );

  // Row touches the BOTTOM edge exactly: rowBottom === viewportBottom, rowTop inside.
  const bottomTouch = base.chain(({ viewportTop, viewportBottom }) =>
    fc.integer({ min: viewportTop, max: viewportBottom }).map((rowTop) => ({
      viewportTop,
      viewportBottom,
      rowTop,
      rowBottom: viewportBottom,
    }))
  );

  return fc.oneof(topTouch, bottomTouch);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-branch-click-scroll - Scroll Visibility Decision Property Tests', () => {
  /**
   * Property 1: Fully-visible rows are never scrolled.
   *
   * Feature: git-graph-branch-click-scroll, Property 1
   *
   * For any row/viewport geometry where the row lies entirely within the
   * viewport (`rowTop >= viewportTop` and `rowBottom <= viewportBottom`),
   * `shouldScrollToRow` SHALL return `false`.
   *
   */
  it('Feature: git-graph-branch-click-scroll, Property 1: Fully-visible rows are never scrolled', () => {
    fc.assert(
      fc.property(arbitraryFullyVisibleGeometry(), (g) => {
        // Guard the generator invariant so a generator bug can't mask a real failure.
        assert.ok(
          g.viewportTop <= g.rowTop && g.rowTop <= g.rowBottom && g.rowBottom <= g.viewportBottom,
          `generator should place the row fully inside the viewport: ${JSON.stringify(g)}`
        );

        assert.strictEqual(
          shouldScrollToRow(g),
          false,
          `fully-visible row should not be scrolled: ${JSON.stringify(g)}`
        );
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Off-screen rows are always scrolled.
   *
   * Feature: git-graph-branch-click-scroll, Property 2
   *
   * For any row/viewport geometry where the row extends above the viewport top
   * (`rowTop < viewportTop`) or below the viewport bottom
   * (`rowBottom > viewportBottom`) — i.e. the row is not fully visible —
   * `shouldScrollToRow` SHALL return `true`.
   *
   */
  it('Feature: git-graph-branch-click-scroll, Property 2: Off-screen rows are always scrolled', () => {
    fc.assert(
      fc.property(arbitraryOffScreenGeometry(), (g) => {
        // Guard the generator invariants so a generator bug can't mask a real failure.
        assert.ok(
          g.rowBottom >= g.rowTop && g.viewportBottom >= g.viewportTop,
          `generator should hold non-negative row/viewport heights: ${JSON.stringify(g)}`
        );
        assert.ok(
          g.rowTop < g.viewportTop || g.rowBottom > g.viewportBottom,
          `generator should place the row crossing a viewport edge: ${JSON.stringify(g)}`
        );

        assert.strictEqual(
          shouldScrollToRow(g),
          true,
          `off-screen row should be scrolled: ${JSON.stringify(g)}`
        );
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: The scroll decision is the exact inverse of full visibility.
   *
   * Feature: git-graph-branch-click-scroll, Property 3
   *
   * For any row/viewport geometry, `shouldScrollToRow(g)` SHALL equal
   * `!isRowFullyVisible(g)`. This pins the exact inverse relationship between
   * the two predicates so a future refactor cannot make them disagree.
   *
   */
  it('Feature: git-graph-branch-click-scroll, Property 3: The scroll decision is the exact inverse of full visibility', () => {
    fc.assert(
      fc.property(arbitraryGeometry(), (g) => {
        // Guard the generator invariants so a generator bug can't mask a real failure.
        assert.ok(
          g.rowBottom >= g.rowTop && g.viewportBottom >= g.viewportTop,
          `generator should hold non-negative row/viewport heights: ${JSON.stringify(g)}`
        );

        assert.strictEqual(
          shouldScrollToRow(g),
          !isRowFullyVisible(g),
          `scroll decision should be the exact inverse of full visibility: ${JSON.stringify(g)}`
        );
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Rows taller than the viewport are always scrolled into view.
   *
   * Feature: git-graph-branch-click-scroll, Property 4
   *
   * For any geometry where the row's height strictly exceeds the viewport's
   * height (`rowBottom - rowTop > viewportBottom - viewportTop`), such a row can
   * never fit entirely within the viewport, so `shouldScrollToRow` SHALL return
   * `true` — we still bring the row into view.
   *
   */
  it('Feature: git-graph-branch-click-scroll, Property 4: Rows taller than the viewport are always scrolled into view', () => {
    fc.assert(
      fc.property(arbitraryTallerThanViewportGeometry(), (g) => {
        // Guard the generator invariants so a generator bug can't mask a real failure.
        assert.ok(
          g.rowBottom >= g.rowTop && g.viewportBottom >= g.viewportTop,
          `generator should hold non-negative row/viewport heights: ${JSON.stringify(g)}`
        );
        assert.ok(
          g.rowBottom - g.rowTop > g.viewportBottom - g.viewportTop,
          `generator should make the row strictly taller than the viewport: ${JSON.stringify(g)}`
        );

        assert.strictEqual(
          shouldScrollToRow(g),
          true,
          `row taller than the viewport should always be scrolled into view: ${JSON.stringify(g)}`
        );
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Boundary-touching rows count as visible (no scroll).
   *
   * Feature: git-graph-branch-click-scroll, Property 5
   *
   * For any geometry where the row touches a viewport edge exactly
   * (`rowTop === viewportTop` or `rowBottom === viewportBottom`) while otherwise
   * remaining within the viewport, the row is fully visible, so
   * `shouldScrollToRow` SHALL return `false`. This pins the `>=` / `<=`
   * "edge touch counts as visible" convention.
   *
   */
  it('Feature: git-graph-branch-click-scroll, Property 5: Boundary-touching rows count as visible (no scroll)', () => {
    fc.assert(
      fc.property(arbitraryBoundaryTouchingGeometry(), (g) => {
        // Guard the generator invariants so a generator bug can't mask a real failure.
        assert.ok(
          g.rowBottom >= g.rowTop && g.viewportBottom >= g.viewportTop,
          `generator should hold non-negative row/viewport heights: ${JSON.stringify(g)}`
        );
        assert.ok(
          g.rowTop === g.viewportTop || g.rowBottom === g.viewportBottom,
          `generator should make the row touch a viewport edge exactly: ${JSON.stringify(g)}`
        );
        assert.ok(
          g.rowTop >= g.viewportTop && g.rowBottom <= g.viewportBottom,
          `generator should keep the row otherwise inside the viewport: ${JSON.stringify(g)}`
        );

        assert.strictEqual(
          shouldScrollToRow(g),
          false,
          `boundary-touching row should count as visible (no scroll): ${JSON.stringify(g)}`
        );
      }),
      { numRuns: 100 }
    );
  });
});
