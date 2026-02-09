/**
 * Property-based tests for menu positioning within viewport.
 *
 * Feature: git-graph-context-menu
 *
 * Uses fast-check to verify that the computed menu position always stays
 * within the viewport boundaries for any cursor position and viewport dimensions.
 *
 * Properties tested:
 *   3 — Menu positioning stays within viewport
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';

// ─── Constants matching the webview JS ────────────────────────────────────────

const COMMIT_MENU_WIDTH = 220;
const COMMIT_MENU_HEIGHT = 400;
const MENU_MARGIN = 10;

// ─── Pure logic extracted from webview JS ─────────────────────────────────────

/**
 * Computes the menu position given cursor coordinates and viewport dimensions.
 *
 * This mirrors the positioning logic in showCommitContextMenu():
 *   left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x
 *   top  = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y
 *
 * @param x - Cursor X position
 * @param y - Cursor Y position
 * @param viewportWidth - Viewport width
 * @param viewportHeight - Viewport height
 * @param menuWidth - Menu width
 * @param menuHeight - Menu height
 * @returns The computed { left, top } position
 */
function computeMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth: number,
  menuHeight: number
): { left: number; top: number } {
  const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - MENU_MARGIN : x;
  const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - MENU_MARGIN : y;
  return { left, top };
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Menu Positioning Property Tests', () => {
  // Feature: git-graph-context-menu, Property 3: Menu positioning stays within viewport
  describe('Property 3: Menu positioning stays within viewport', () => {
    /**
     * **Validates: Requirements 6.3**
     *
     * For any cursor position (x, y) and viewport dimensions (width, height),
     * the computed menu position (left, top) should satisfy:
     * left >= 0, top >= 0, left + menuWidth <= viewportWidth,
     * and top + menuHeight <= viewportHeight.
     */
    it('should keep the menu within viewport bounds for any cursor position and viewport size', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 4000 }),
          fc.integer({ min: 0, max: 4000 }),
          fc.integer({ min: COMMIT_MENU_WIDTH + MENU_MARGIN, max: 4000 }),
          fc.integer({ min: COMMIT_MENU_HEIGHT + MENU_MARGIN, max: 4000 }),
          (x, y, viewportWidth, viewportHeight) => {
            const { left, top } = computeMenuPosition(
              x,
              y,
              viewportWidth,
              viewportHeight,
              COMMIT_MENU_WIDTH,
              COMMIT_MENU_HEIGHT
            );

            assert.ok(
              left >= 0,
              `left (${left}) should be >= 0 for cursor (${x}, ${y}) in viewport (${viewportWidth}x${viewportHeight})`
            );
            assert.ok(
              top >= 0,
              `top (${top}) should be >= 0 for cursor (${x}, ${y}) in viewport (${viewportWidth}x${viewportHeight})`
            );
            assert.ok(
              left + COMMIT_MENU_WIDTH <= viewportWidth,
              `left + menuWidth (${left + COMMIT_MENU_WIDTH}) should be <= viewportWidth (${viewportWidth})`
            );
            assert.ok(
              top + COMMIT_MENU_HEIGHT <= viewportHeight,
              `top + menuHeight (${top + COMMIT_MENU_HEIGHT}) should be <= viewportHeight (${viewportHeight})`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
