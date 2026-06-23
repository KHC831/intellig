/**
 * Property-based tests for SVG rendering of merge, branch split, terminal, and curve icons.
 *
 * Feature: git-graph-visual-improvements
 *
 * Uses fast-check to verify universal correctness properties of the
 * SVG rendering function across randomly generated inputs.
 *
 * Properties tested:
 * - Property 7: Merge commit renders diamond icon with lane color
 * - Property 8: Branch split renders split icon with lane color
 * - Property 9: Merge precedence over branch split
 * - Property 4: Terminal node rendering omits top line and shows ring
 * - Property 10: Graph curves are fully connected
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { getColumnX, IGraphRenderConfig } from '../../src/utils/graphRenderer';
import { paintFabricatedRow } from '../support/printModelTestKit';
import { ICommitNode, getColumnColor } from '../../src/git-core/commitGraph';
import { ICommit } from '../../src/git-core/interfaces/IGitService';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random hex string of the given length (for commit hashes).
 */
function arbitraryHexString(length: number): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: length,
    maxLength: length,
  });
}

/**
 * Generate a random ICommit with a specified number of parents.
 */
function arbitraryCommit(parentCount: number): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: arbitraryHexString(40),
    shortHash: arbitraryHexString(7),
    message: fc.string({ minLength: 1, maxLength: 50 }),
    author: fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }),
      email: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    committer: fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }),
      email: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    parents: fc
      .tuple(...Array.from({ length: parentCount }, () => arbitraryHexString(40)))
      .map((arr) => arr),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }),
  });
}

/**
 * Generate a random IGraphRenderConfig with reasonable bounds.
 */
function arbitraryGraphRenderConfig(): fc.Arbitrary<IGraphRenderConfig> {
  return fc.record({
    columnWidth: fc.integer({ min: 10, max: 50 }),
    rowHeight: fc.integer({ min: 20, max: 60 }),
    nodeRadius: fc.integer({ min: 3, max: 10 }),
    padding: fc.integer({ min: 5, max: 20 }),
    lineWidth: fc.integer({ min: 1, max: 4 }),
  });
}

/**
 * Generate a merge commit node (parents.length > 1) with valid graph data.
 * Merge commits have 2 or 3 parents.
 */
function arbitraryMergeCommitNode(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    return fc.integer({ min: 2, max: 3 }).chain((parentCount) => {
      const graphLinesArb = fc
        .tuple(
          ...Array.from({ length: parentCount }, (_, i) =>
            fc.record({
              fromColumn: fc.constant(graphColumn),
              toColumn: i === 0 ? fc.constant(graphColumn) : fc.integer({ min: 0, max: maxColumn }),
              color: fc.constant(getColumnColor(i === 0 ? graphColumn : i)),
              type: fc.constant(i === 0 ? ('commit' as const) : ('merge' as const)),
            })
          )
        )
        .map((arr) => arr);

      return fc.tuple(arbitraryCommit(parentCount), graphLinesArb).map(
        ([commit, graphLines]) =>
          ({
            commit,
            graphColumn,
            graphLines,
            branches: [],
            tags: [],
          }) as ICommitNode
      );
    });
  });
}

/**
 * Generate a non-merge commit node (parents.length <= 1) for branch split testing.
 * These have exactly 0 or 1 parent.
 */
function arbitraryNonMergeCommitNode(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    return fc.integer({ min: 0, max: 1 }).chain((parentCount) => {
      const graphLinesArb =
        parentCount === 0
          ? fc.constant([])
          : fc
              .tuple(
                fc.record({
                  fromColumn: fc.constant(graphColumn),
                  toColumn: fc.constant(graphColumn),
                  color: fc.constant(getColumnColor(graphColumn)),
                  type: fc.constant('commit' as const),
                })
              )
              .map((arr) => arr);

      return fc.tuple(arbitraryCommit(parentCount), graphLinesArb).map(
        ([commit, graphLines]) =>
          ({
            commit,
            graphColumn,
            graphLines,
            branches: [],
            tags: [],
          }) as ICommitNode
      );
    });
  });
}

/**
 * Generate a commit node with cross-lane graph lines (fromColumn !== toColumn).
 * Ensures at least one graph line crosses lanes for curve testing.
 */
function arbitraryNodeWithCrossLaneLines(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return (
    fc
      .integer({ min: 0, max: maxColumn })
      .chain((graphColumn) => {
        // Generate 1-3 cross-lane lines
        return fc.integer({ min: 1, max: 3 }).chain((lineCount) => {
          const linesArb = fc.tuple(
            ...Array.from({ length: lineCount }, (_, i) => {
              // Ensure toColumn differs from fromColumn (graphColumn)
              return fc
                .integer({ min: 0, max: maxColumn })
                .filter((toCol) => toCol !== graphColumn)
                .map((toColumn) => ({
                  fromColumn: graphColumn,
                  toColumn,
                  color: getColumnColor(toColumn),
                  type: (i === 0 ? 'commit' : 'merge') as 'commit' | 'merge' | 'branch',
                }));
            })
          );

          // Parent count matches line count (each line goes to a parent)
          return fc.tuple(arbitraryCommit(lineCount), linesArb).map(
            ([commit, graphLines]) =>
              ({
                commit,
                graphColumn,
                graphLines,
                branches: [],
                tags: [],
              }) as ICommitNode
          );
        });
      })
      // Filter to ensure we actually have cross-lane lines (the filter above should guarantee this,
      // but be safe)
      .filter((node) => node.graphLines.some((l) => l.fromColumn !== l.toColumn))
  );
}

// ─── SVG Parsing Helpers ──────────────────────────────────────────────────────

/**
 * Check if SVG contains a rotated rect (diamond) element.
 * Looks for <rect ... transform="rotate(45, ..." pattern.
 */
function containsDiamondRect(svg: string): boolean {
  return /<rect\s[^>]*transform="rotate\(45,/.test(svg);
}

/**
 * Extract the fill color from a rotated rect (diamond) element.
 */
function extractDiamondFill(svg: string): string | null {
  const match = svg.match(/<rect\s[^>]*fill="([^"]+)"[^>]*transform="rotate\(45,/);
  return match ? match[1] : null;
}

/**
 * Check if SVG contains a plain commit circle (a circle with matching fill and stroke,
 * NOT a ring circle which has fill="none").
 */
function containsPlainCommitCircle(svg: string): boolean {
  const circleRegex =
    /<circle\s+cx="[^"]+"\s+cy="[^"]+"\s+r="[^"]+"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s*\/>/g;
  let match;
  while ((match = circleRegex.exec(svg)) !== null) {
    const fill = match[1];
    const stroke = match[2];
    // A plain commit circle has fill === stroke (not a ring, not a diamond)
    if (fill === stroke && fill !== 'none') {
      return true;
    }
  }
  return false;
}

/**
 * Check if SVG contains tick mark line elements (branch split indicators).
 * Tick marks are short lines originating from the bottom of the commit circle,
 * angled at ±30° — they have non-integer y2 values (not full-height vertical lines).
 */
function containsTickMarkLines(svg: string, nodeColor: string): boolean {
  // Tick marks are lines with the node's color that are NOT vertical pass-through lines.
  // They are angled lines (x1 !== x2) originating from the bottom of the commit circle.
  const lineRegex =
    /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  let match;
  while ((match = lineRegex.exec(svg)) !== null) {
    const stroke = match[5];

    if (stroke !== nodeColor) {
      continue;
    }

    // Tick marks have x1 !== x2 (they are angled, not vertical)
    const lineX1 = parseFloat(match[1]);
    const lineX2 = parseFloat(match[3]);
    if (lineX1 !== lineX2) {
      return true;
    }
  }
  return false;
}

/**
 * Check if SVG contains an outer ring circle (fill="none", used for terminal nodes).
 */
function containsOuterRing(svg: string): boolean {
  return /<circle\s[^>]*fill="none"[^>]*\/>/.test(svg);
}

/**
 * Check if SVG contains a vertical line from y=0 to y=centerY at a given x position.
 */
function containsTopToCenterLine(svg: string, x: number, centerY: number): boolean {
  const lineRegex =
    /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s+stroke="[^"]+"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  let match;
  while ((match = lineRegex.exec(svg)) !== null) {
    const lx1 = parseFloat(match[1]);
    const ly1 = parseFloat(match[2]);
    const lx2 = parseFloat(match[3]);
    const ly2 = parseFloat(match[4]);

    if (lx1 === x && ly1 === 0 && lx2 === x && ly2 === centerY) {
      return true;
    }
  }
  return false;
}

/**
 * Extract all path elements from an SVG string.
 */
function extractPaths(svg: string): Array<{ d: string; stroke: string }> {
  const pathRegex =
    /<path\s+d="([^"]+)"\s+stroke="([^"]+)"\s+fill="[^"]+"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const paths: Array<{ d: string; stroke: string }> = [];
  let match;
  while ((match = pathRegex.exec(svg)) !== null) {
    paths.push({
      d: match[1],
      stroke: match[2],
    });
  }
  return paths;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-visual-improvements - SVG Rendering Property Tests', () => {
  describe('Property 7: Merge commit renders diamond icon with lane color', () => {
    /**
     *
     * For any commit node with more than one parent (merge commit), the SVG output
     * should contain a rotated <rect> (diamond) element filled with the color returned
     * by getColumnColor(node.graphColumn), and should NOT contain a plain commit circle.
     */
    it('Feature: git-graph-visual-improvements, Property 7: Merge commit renders diamond icon with lane color', () => {
      fc.assert(
        fc.property(
          arbitraryMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = paintFabricatedRow(node, rowIndex, { activeLanes }, config);

            const expectedColor = getColumnColor(node.graphColumn);

            // Should contain a diamond (rotated rect)
            assert.ok(
              containsDiamondRect(svg),
              `Merge commit (parents=${node.commit.parents.length}) should render a diamond <rect> element. SVG: ${svg}`
            );

            // Diamond fill should match lane color
            const diamondFill = extractDiamondFill(svg);
            assert.strictEqual(
              diamondFill,
              expectedColor,
              `Diamond fill (${diamondFill}) should match lane color (${expectedColor}) for column ${node.graphColumn}`
            );

            // Should NOT contain a plain commit circle (fill === stroke, non-"none")
            assert.ok(
              !containsPlainCommitCircle(svg),
              `Merge commit should NOT contain a plain commit circle. SVG: ${svg}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 8: Branch split renders split icon with lane color', () => {
    /**
     *
     * For any commit node flagged as a branch split point (and NOT a merge commit),
     * the SVG output should contain tick mark <line> elements using the color from
     * getColumnColor(node.graphColumn).
     */
    it('Feature: git-graph-visual-improvements, Property 8: Branch split renders split icon with lane color', () => {
      fc.assert(
        fc.property(
          arbitraryNonMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            // Render with isBranchSplitPoint=true, isTerminal=false
            const svg = paintFabricatedRow(
              node,
              rowIndex,
              { activeLanes, isBranchSplit: true },
              config
            );

            const expectedColor = getColumnColor(node.graphColumn);

            // Should contain tick mark lines with the lane color
            assert.ok(
              containsTickMarkLines(svg, expectedColor),
              `Branch split node (non-merge) should render tick mark <line> elements with color ${expectedColor}. SVG: ${svg}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 9: Merge precedence over branch split', () => {
    /**
     *
     * For any commit node that is both a merge commit (parents.length > 1) and a
     * branch split point, the SVG output should contain the diamond (merge) icon
     * and should NOT contain the branch split tick marks.
     */
    it('Feature: git-graph-visual-improvements, Property 9: Merge precedence over branch split', () => {
      fc.assert(
        fc.property(
          arbitraryMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            // Render with BOTH isBranchSplitPoint=true AND merge (parents > 1)
            const svg = paintFabricatedRow(
              node,
              rowIndex,
              { activeLanes, isBranchSplit: true },
              config
            );

            const expectedColor = getColumnColor(node.graphColumn);

            // Should contain diamond (merge takes precedence)
            assert.ok(
              containsDiamondRect(svg),
              `Merge+split commit should render diamond icon (merge precedence). SVG: ${svg}`
            );

            // Should NOT contain tick mark lines (merge overrides branch split)
            assert.ok(
              !containsTickMarkLines(svg, expectedColor),
              `Merge+split commit should NOT render branch split tick marks. SVG: ${svg}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Terminal node rendering omits top line and shows ring', () => {
    /**
     *
     * For any commit node rendered as a terminal node (isTerminal=true), the SVG output
     * should contain an outer ring circle element AND should NOT contain a vertical line
     * segment from y=0 to y=centerY at the commit's column x-position.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Terminal node rendering omits top line and shows ring', () => {
      fc.assert(
        fc.property(
          arbitraryNonMergeCommitNode(10),
          fc.integer({ min: 1, max: 100 }), // rowIndex > 0 so top line would normally appear
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            // Render as terminal node
            const svg = paintFabricatedRow(
              node,
              rowIndex,
              { activeLanes, isTerminal: true },
              config
            );

            const commitX = getColumnX(node.graphColumn, config);
            const centerY = config.rowHeight / 2;

            // Should contain an outer ring circle (fill="none")
            assert.ok(
              containsOuterRing(svg),
              `Terminal node should render an outer ring circle (fill="none"). SVG: ${svg}`
            );

            // Should NOT contain a top-to-center vertical line at the commit's x position
            assert.ok(
              !containsTopToCenterLine(svg, commitX, centerY),
              `Terminal node should NOT have a vertical line from y=0 to y=${centerY} at x=${commitX}. SVG: ${svg}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 10: Graph curves are fully connected', () => {
    /**
     *
     * For any commit node with graph lines where fromColumn differs from toColumn,
     * the bezier curve path in the SVG should start at coordinates
     * (getColumnX(fromColumn), centerY) and end at (getColumnX(toColumn), bottomY).
     */
    it('Feature: git-graph-visual-improvements, Property 10: Graph curves are fully connected', () => {
      fc.assert(
        fc.property(
          arbitraryNodeWithCrossLaneLines(10),
          fc.integer({ min: 0, max: 100 }),
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = paintFabricatedRow(node, rowIndex, { activeLanes }, config);

            const centerY = config.rowHeight / 2;
            const bottomY = config.rowHeight;

            const paths = extractPaths(svg);

            // For each cross-lane graph line, verify the bezier curve coordinates
            const crossLaneLines = node.graphLines.filter((l) => l.fromColumn !== l.toColumn);

            for (const line of crossLaneLines) {
              const fromX = getColumnX(line.fromColumn, config);
              const toX = getColumnX(line.toColumn, config);

              // Expected bezier: M fromX,centerY C fromX,bottomY toX,centerY toX,bottomY
              const expectedD = `M ${fromX},${centerY} C ${fromX},${bottomY} ${toX},${centerY} ${toX},${bottomY}`;

              const matchingPath = paths.find((p) => p.d === expectedD);

              assert.ok(
                matchingPath,
                `Cross-lane line from column ${line.fromColumn} (x=${fromX}) to column ${line.toColumn} (x=${toX}) ` +
                  `should produce a bezier path starting at (${fromX},${centerY}) and ending at (${toX},${bottomY}). ` +
                  `Expected d="${expectedD}". Found paths: ${JSON.stringify(paths.map((p) => p.d))}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
