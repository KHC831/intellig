/**
 * Property-based tests for renderGraphSvg.
 *
 * Feature: git-graph-visualization
 *
 * Uses fast-check to verify universal correctness properties of the
 * SVG rendering function across randomly generated inputs.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  renderGraphSvg,
  IGraphRenderConfig,
  DEFAULT_GRAPH_CONFIG,
  getColumnX,
  computeActiveLanes,
  computeGraphWidth,
} from '../../utils/graphRenderer';
import { ICommitNode, getColumnColor, getMaxGraphColumn } from '../../utils/commitGraph';
import { ICommit } from '../../services/interfaces/IGitService';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random valid IGraphRenderConfig with reasonable bounds.
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
 * Generate a random hex string of the given length.
 */
function arbitraryHexString(length: number): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: length,
    maxLength: length,
  });
}

/**
 * Generate a random ICommit.
 * @param parentCount - number of parent hashes to generate
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
 * Generate a random ICommitNode with a valid graphColumn (0 to maxColumn).
 * Generates graphLines where fromColumn equals the node's graphColumn.
 */
function arbitraryCommitNode(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    // Decide number of parents: 0, 1, or 2
    return fc.integer({ min: 0, max: 2 }).chain((parentCount) => {
      // Generate graph lines: one per parent, fromColumn = graphColumn
      const graphLinesArb =
        parentCount === 0
          ? fc.constant([])
          : fc
              .tuple(
                ...Array.from({ length: parentCount }, (_, i) =>
                  fc.record({
                    fromColumn: fc.constant(graphColumn),
                    toColumn:
                      i === 0
                        ? fc.constant(graphColumn) // first parent stays in same lane
                        : fc.integer({ min: 0, max: maxColumn }), // other parents can go to any lane
                    color: fc.constant(getColumnColor(graphColumn)),
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
 * Generate a random ICommitNode that is guaranteed to be a merge commit (parents.length > 1).
 */
function arbitraryMergeCommitNode(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    // 2 or 3 parents for merge
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
 * Generate a random ICommitNode that is guaranteed to be a non-merge commit (parents.length <= 1).
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

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Extract all circle elements from an SVG string.
 * Returns an array of objects with cx, cy, r, fill, stroke attributes.
 */
function extractCircles(
  svg: string
): Array<{ cx: string; cy: string; r: string; fill: string; stroke: string }> {
  const circleRegex =
    /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s*\/>/g;
  const circles: Array<{ cx: string; cy: string; r: string; fill: string; stroke: string }> = [];
  let match;
  while ((match = circleRegex.exec(svg)) !== null) {
    circles.push({
      cx: match[1],
      cy: match[2],
      r: match[3],
      fill: match[4],
      stroke: match[5],
    });
  }
  return circles;
}

/**
 * Extract all line elements from an SVG string.
 * Returns an array of objects with x1, y1, x2, y2, stroke attributes.
 */
function extractLines(
  svg: string
): Array<{ x1: string; y1: string; x2: string; y2: string; stroke: string }> {
  const lineRegex =
    /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const lines: Array<{ x1: string; y1: string; x2: string; y2: string; stroke: string }> = [];
  let match;
  while ((match = lineRegex.exec(svg)) !== null) {
    lines.push({
      x1: match[1],
      y1: match[2],
      x2: match[3],
      y2: match[4],
      stroke: match[5],
    });
  }
  return lines;
}

/**
 * Extract all path elements from an SVG string.
 * Returns an array of objects with d (path data) and stroke attributes.
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

describe('Feature: git-graph-visualization - renderGraphSvg Property Tests', () => {
  describe('Property 1: Commit node presence and position', () => {
    /**
     *
     * For any ICommitNode and valid IGraphRenderConfig, calling renderGraphSvg()
     * SHALL produce an SVG string containing a <circle> element whose cx attribute
     * equals node.graphColumn * config.columnWidth + config.padding + config.columnWidth / 2
     * and whose cy equals config.rowHeight / 2, with r equal to config.nodeRadius.
     */
    it('Feature: git-graph-visualization, Property 1: Commit node presence and position', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          arbitraryGraphRenderConfig(),
          (node, rowIndex, config) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(node, rowIndex, activeLanes, config, false, false);

            const expectedCx = getColumnX(node.graphColumn, config);
            const expectedCy = config.rowHeight / 2;
            const expectedR = config.nodeRadius;
            const isMerge = node.commit.parents.length > 1;

            if (isMerge) {
              // Merge commits render a diamond (rotated <rect>) instead of a circle
              const rectRegex = /<rect\s+[^>]*transform="rotate\(45,\s*([^,]+),\s*([^)]+)\)"\s*\/>/;
              const rectMatch = svg.match(rectRegex);
              assert.ok(
                rectMatch,
                `SVG should contain a rotated rect (diamond) for merge commit at cx=${expectedCx}, cy=${expectedCy}`
              );
            } else {
              const circles = extractCircles(svg);
              assert.ok(circles.length >= 1, 'SVG should contain at least one circle element');

              // Find the commit node circle
              const commitCircle = circles.find(
                (c) =>
                  parseFloat(c.cx) === expectedCx &&
                  parseFloat(c.cy) === expectedCy &&
                  parseFloat(c.r) === expectedR
              );

              assert.ok(
                commitCircle,
                `SVG should contain a circle at cx=${expectedCx}, cy=${expectedCy}, r=${expectedR}. ` +
                  `Found circles: ${JSON.stringify(circles)}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: Merge commit visual distinction', () => {
    /**
     *
     * For any ICommitNode where node.commit.parents.length > 1, the SVG output
     * SHALL contain a circle element with a stroke color different from its fill color.
     * For any ICommitNode where node.commit.parents.length <= 1, the circle SHALL
     * have matching fill and stroke colors.
     */
    it('Feature: git-graph-visualization, Property 2: Merge commit visual distinction — merge commits have contrasting stroke', () => {
      fc.assert(
        fc.property(
          arbitraryMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(
              node,
              rowIndex,
              activeLanes,
              DEFAULT_GRAPH_CONFIG,
              false,
              false
            );

            // Merge commits now render a diamond (rotated <rect>) with white stroke
            // instead of a circle with contrasting stroke
            const rectRegex =
              /<rect\s+[^>]*fill="([^"]+)"\s+stroke="([^"]+)"[^>]*transform="rotate\(45/;
            const rectMatch = svg.match(rectRegex);
            assert.ok(rectMatch, 'SVG should contain a rotated rect (diamond) for merge commit');

            const fill = rectMatch[1];
            const stroke = rectMatch[2];
            assert.notStrictEqual(
              fill,
              stroke,
              `Merge commit diamond should have different fill (${fill}) and stroke (${stroke})`
            );
            assert.strictEqual(
              stroke,
              '#ffffff',
              `Merge commit diamond should have white stroke, got ${stroke}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 2: Merge commit visual distinction — non-merge commits have matching stroke', () => {
      fc.assert(
        fc.property(
          arbitraryNonMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(
              node,
              rowIndex,
              activeLanes,
              DEFAULT_GRAPH_CONFIG,
              false,
              false
            );

            const circles = extractCircles(svg);
            assert.ok(circles.length >= 1, 'SVG should contain at least one circle');

            // The last circle is the commit node (drawn on top)
            const commitCircle = circles[circles.length - 1];
            assert.strictEqual(
              commitCircle.fill,
              commitCircle.stroke,
              `Non-merge commit circle should have matching fill (${commitCircle.fill}) and stroke (${commitCircle.stroke})`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Color determinism', () => {
    /**
     *
     * For any lane index n, getColumnColor(n) SHALL always return the same value.
     * Furthermore, for any SVG produced by renderGraphSvg(), all elements associated
     * with lane index n SHALL use getColumnColor(n) as their color.
     */
    it('Feature: git-graph-visualization, Property 3: Color determinism — getColumnColor is deterministic and cyclic', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1000 }), (laneIndex) => {
          const color1 = getColumnColor(laneIndex);
          const color2 = getColumnColor(laneIndex);

          // Same input always produces same output
          assert.strictEqual(color1, color2, 'getColumnColor should be deterministic');

          // Verify cycling: color at n should equal color at n + paletteSize
          // We know the palette has 10 colors
          const paletteSize = 10;
          const colorCycled = getColumnColor(laneIndex + paletteSize);
          assert.strictEqual(
            color1,
            colorCycled,
            `getColumnColor(${laneIndex}) should equal getColumnColor(${laneIndex + paletteSize})`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 3: Color determinism — commit node uses lane color', () => {
      fc.assert(
        fc.property(arbitraryCommitNode(10), fc.integer({ min: 0, max: 100 }), (node, rowIndex) => {
          const activeLanes = new Set([node.graphColumn]);
          const svg = renderGraphSvg(
            node,
            rowIndex,
            activeLanes,
            DEFAULT_GRAPH_CONFIG,
            false,
            false
          );

          const expectedColor = getColumnColor(node.graphColumn);
          const isMerge = node.commit.parents.length > 1;

          if (isMerge) {
            // Merge commits render a diamond (rotated <rect>) — check fill color
            const rectRegex = /<rect\s+[^>]*fill="([^"]+)"/;
            const rectMatch = svg.match(rectRegex);
            assert.ok(rectMatch, 'SVG should contain a rect for merge commit');
            assert.strictEqual(
              rectMatch[1],
              expectedColor,
              `Merge commit diamond fill (${rectMatch[1]}) should match lane color (${expectedColor}) for column ${node.graphColumn}`
            );
          } else {
            const circles = extractCircles(svg);
            assert.ok(circles.length >= 1, 'SVG should contain at least one circle');

            // The commit node circle's fill should match the lane color
            const commitCircle = circles[circles.length - 1];
            assert.strictEqual(
              commitCircle.fill,
              expectedColor,
              `Commit node fill (${commitCircle.fill}) should match lane color (${expectedColor}) for column ${node.graphColumn}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 3: Color determinism — pass-through lane lines use correct lane color', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 10 }),
          (node, rowIndex, extraLane) => {
            // Ensure the extra lane is different from the commit's column
            const passThroughLane =
              extraLane === node.graphColumn ? (node.graphColumn + 1) % 11 : extraLane;

            const activeLanes = new Set([node.graphColumn, passThroughLane]);
            const svg = renderGraphSvg(
              node,
              rowIndex,
              activeLanes,
              DEFAULT_GRAPH_CONFIG,
              false,
              false
            );

            const expectedColor = getColumnColor(passThroughLane);
            const expectedX = getColumnX(passThroughLane, DEFAULT_GRAPH_CONFIG);

            // Check if this lane is a bezier target (cross-lane graphLine ends here)
            const isBezierTarget = node.graphLines.some(
              (l) => l.fromColumn !== l.toColumn && l.toColumn === passThroughLane
            );

            const lines = extractLines(svg);

            if (isBezierTarget) {
              // Bezier target lanes get half-height pass-through (y=0 to y=centerY)
              const halfHeightLine = lines.find(
                (l) =>
                  parseFloat(l.x1) === expectedX &&
                  parseFloat(l.y1) === 0 &&
                  parseFloat(l.x2) === expectedX &&
                  parseFloat(l.y2) === DEFAULT_GRAPH_CONFIG.rowHeight / 2
              );

              assert.ok(
                halfHeightLine,
                `Should have a half-height pass-through line at x=${expectedX} for bezier-target lane ${passThroughLane}`
              );
              assert.strictEqual(
                halfHeightLine.stroke,
                expectedColor,
                `Half-height pass-through line stroke (${halfHeightLine.stroke}) should match lane color (${expectedColor}) for lane ${passThroughLane}`
              );
            } else {
              // Non-bezier-target lanes get full-height pass-through
              const passThroughLine = lines.find(
                (l) =>
                  parseFloat(l.x1) === expectedX &&
                  parseFloat(l.y1) === 0 &&
                  parseFloat(l.x2) === expectedX &&
                  parseFloat(l.y2) === DEFAULT_GRAPH_CONFIG.rowHeight
              );

              assert.ok(
                passThroughLine,
                `Should have a pass-through line at x=${expectedX} for lane ${passThroughLane}`
              );
              assert.strictEqual(
                passThroughLine.stroke,
                expectedColor,
                `Pass-through line stroke (${passThroughLine.stroke}) should match lane color (${expectedColor}) for lane ${passThroughLane}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Active lane vertical lines', () => {
    /**
     *
     * For any commit row with a set of active lanes, the SVG output of renderGraphSvg()
     * SHALL contain a vertical line element for each active lane index in the set.
     * Each vertical line SHALL span from y=0 to y=rowHeight for pass-through lanes
     * (lanes where the lane index differs from node.graphColumn).
     */
    it('Feature: git-graph-visualization, Property 4: Active lane vertical lines', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNode(8),
          fc.integer({ min: 0, max: 100 }),
          fc.uniqueArray(fc.integer({ min: 0, max: 8 }), { minLength: 1, maxLength: 6 }),
          (node, rowIndex, extraLanes) => {
            // Build active lanes set: always include the commit's own column + extra lanes
            const activeLanes = new Set([node.graphColumn, ...extraLanes]);
            const config = DEFAULT_GRAPH_CONFIG;
            const svg = renderGraphSvg(node, rowIndex, activeLanes, config, false, false);

            const lines = extractLines(svg);

            // Compute bezier target lanes (lanes where a cross-lane graphLine ends)
            const bezierTargetLanes = new Set<number>();
            for (const line of node.graphLines) {
              if (line.fromColumn !== line.toColumn) {
                bezierTargetLanes.add(line.toColumn);
              }
            }

            // Check each pass-through lane (active lanes that are NOT the commit's column)
            for (const lane of activeLanes) {
              if (lane === node.graphColumn) {
                continue; // commit's own lane is handled differently (split segments)
              }

              const expectedX = getColumnX(lane, config);

              if (bezierTargetLanes.has(lane)) {
                // Bezier target lanes get a half-height pass-through (y=0 to y=centerY)
                // to avoid the "2 lines" visual artifact
                const halfHeightLine = lines.find(
                  (l) =>
                    parseFloat(l.x1) === expectedX &&
                    parseFloat(l.y1) === 0 &&
                    parseFloat(l.x2) === expectedX &&
                    parseFloat(l.y2) === config.rowHeight / 2
                );

                assert.ok(
                  halfHeightLine,
                  `Should have a half-height vertical line (y1=0, y2=${config.rowHeight / 2}) at x=${expectedX} for bezier-target pass-through lane ${lane}. ` +
                    `Active lanes: [${[...activeLanes].join(', ')}], commit column: ${node.graphColumn}`
                );
              } else {
                // Non-bezier-target lanes get a full-height pass-through
                const fullHeightLine = lines.find(
                  (l) =>
                    parseFloat(l.x1) === expectedX &&
                    parseFloat(l.y1) === 0 &&
                    parseFloat(l.x2) === expectedX &&
                    parseFloat(l.y2) === config.rowHeight
                );

                assert.ok(
                  fullHeightLine,
                  `Should have a full-height vertical line (y1=0, y2=${config.rowHeight}) at x=${expectedX} for pass-through lane ${lane}. ` +
                    `Active lanes: [${[...activeLanes].join(', ')}], commit column: ${node.graphColumn}`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5: Merge and branch line rendering', () => {
    /**
     *
     * For any ICommitNode with graphLines entries where fromColumn !== toColumn,
     * the SVG output SHALL contain a <path> element for each such line, connecting
     * the x-position of fromColumn to the x-position of toColumn.
     */
    it('Feature: git-graph-visualization, Property 5: Merge and branch line rendering', () => {
      fc.assert(
        fc.property(
          arbitraryMergeCommitNode(8),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const config = DEFAULT_GRAPH_CONFIG;
            const svg = renderGraphSvg(node, rowIndex, activeLanes, config, false, false);

            // Get all graphLines where fromColumn !== toColumn
            const crossLaneLines = node.graphLines.filter((l) => l.fromColumn !== l.toColumn);

            if (crossLaneLines.length === 0) {
              return; // No cross-lane lines to check
            }

            const paths = extractPaths(svg);

            for (const line of crossLaneLines) {
              const fromX = getColumnX(line.fromColumn, config);
              const toX = getColumnX(line.toColumn, config);
              const centerY = config.rowHeight / 2;
              const bottomY = config.rowHeight;

              // Expected bezier path: M fromX,centerY C fromX,bottomY toX,centerY toX,bottomY
              const expectedD = `M ${fromX},${centerY} C ${fromX},${bottomY} ${toX},${centerY} ${toX},${bottomY}`;

              const matchingPath = paths.find((p) => p.d === expectedD);

              assert.ok(
                matchingPath,
                `SVG should contain a path for line from column ${line.fromColumn} (x=${fromX}) to column ${line.toColumn} (x=${toX}). ` +
                  `Expected d="${expectedD}". Found paths: ${JSON.stringify(paths.map((p) => p.d))}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 8: Graceful handling of invalid lane data', () => {
    /**
     *
     * For any ICommitNode with out-of-bounds lane indices (negative values, or values
     * exceeding 1000), renderGraphSvg() SHALL not throw an exception and SHALL produce
     * a valid SVG string (starting with <svg and ending with </svg>).
     */
    it('Feature: git-graph-visualization, Property 8: Graceful handling of invalid lane data — negative lane indices', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1000, max: -1 }),
          fc.integer({ min: 0, max: 100 }),
          (negativeColumn, rowIndex) => {
            const commit: ICommit = {
              hash: 'a'.repeat(40),
              shortHash: 'a'.repeat(7),
              message: 'test commit',
              author: { name: 'Test', email: 'test@test.com' },
              committer: { name: 'Test', email: 'test@test.com' },
              parents: ['b'.repeat(40)],
              authorDate: new Date(),
              commitDate: new Date(),
            };

            const node: ICommitNode = {
              commit,
              graphColumn: negativeColumn,
              graphLines: [
                {
                  fromColumn: negativeColumn,
                  toColumn: negativeColumn - 1,
                  color: '#000',
                  type: 'commit',
                },
              ],
              branches: [],
              tags: [],
            };

            const activeLanes = new Set([negativeColumn]);

            // Should not throw
            let svg: string;
            try {
              svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG, false, false);
            } catch (e) {
              assert.fail(
                `renderGraphSvg should not throw for negative lane index ${negativeColumn}: ${String(e)}`
              );
              return;
            }

            // Should produce valid SVG wrapper
            assert.ok(
              svg.startsWith('<svg'),
              `SVG should start with <svg, got: ${svg.substring(0, 50)}`
            );
            assert.ok(
              svg.endsWith('</svg>'),
              `SVG should end with </svg>, got: ${svg.substring(svg.length - 20)}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 8: Graceful handling of invalid lane data — lane indices exceeding 1000', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1001, max: 5000 }),
          fc.integer({ min: 0, max: 100 }),
          (largeColumn, rowIndex) => {
            const commit: ICommit = {
              hash: 'c'.repeat(40),
              shortHash: 'c'.repeat(7),
              message: 'test commit',
              author: { name: 'Test', email: 'test@test.com' },
              committer: { name: 'Test', email: 'test@test.com' },
              parents: [],
              authorDate: new Date(),
              commitDate: new Date(),
            };

            const node: ICommitNode = {
              commit,
              graphColumn: largeColumn,
              graphLines: [
                {
                  fromColumn: largeColumn,
                  toColumn: largeColumn + 1,
                  color: '#000',
                  type: 'merge',
                },
              ],
              branches: [],
              tags: [],
            };

            const activeLanes = new Set([largeColumn]);

            // Should not throw
            let svg: string;
            try {
              svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG, false, false);
            } catch (e) {
              assert.fail(
                `renderGraphSvg should not throw for large lane index ${largeColumn}: ${String(e)}`
              );
              return;
            }

            // Should produce valid SVG wrapper
            assert.ok(
              svg.startsWith('<svg'),
              `SVG should start with <svg, got: ${svg.substring(0, 50)}`
            );
            assert.ok(
              svg.endsWith('</svg>'),
              `SVG should end with </svg>, got: ${svg.substring(svg.length - 20)}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 8: Graceful handling of invalid lane data — mixed valid and invalid lanes', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 5 }),
          fc.integer({ min: 0, max: 100 }),
          (validColumn, rowIndex) => {
            const commit: ICommit = {
              hash: 'd'.repeat(40),
              shortHash: 'd'.repeat(7),
              message: 'test commit',
              author: { name: 'Test', email: 'test@test.com' },
              committer: { name: 'Test', email: 'test@test.com' },
              parents: ['e'.repeat(40)],
              authorDate: new Date(),
              commitDate: new Date(),
            };

            const node: ICommitNode = {
              commit,
              graphColumn: validColumn,
              graphLines: [
                {
                  fromColumn: validColumn,
                  toColumn: -5, // invalid
                  color: '#000',
                  type: 'merge',
                },
                {
                  fromColumn: validColumn,
                  toColumn: 2000, // invalid (> 1000)
                  color: '#000',
                  type: 'branch',
                },
              ],
              branches: [],
              tags: [],
            };

            const activeLanes = new Set([validColumn, -3, 1500]);

            // Should not throw
            let svg: string;
            try {
              svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG, false, false);
            } catch (e) {
              assert.fail(
                `renderGraphSvg should not throw with mixed valid/invalid lanes: ${String(e)}`
              );
              return;
            }

            // Should produce valid SVG wrapper
            assert.ok(svg.startsWith('<svg'), `SVG should start with <svg`);
            assert.ok(svg.endsWith('</svg>'), `SVG should end with </svg>`);

            // The valid commit node should still be rendered
            const circles = extractCircles(svg);
            assert.ok(
              circles.length >= 1,
              'Valid commit node should still be rendered despite invalid lanes'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// ─── Generator for ICommitNode arrays ─────────────────────────────────────────

/**
 * Generate an array of ICommitNode with consistent parent relationships.
 *
 * Produces arrays where:
 * - Each node has a unique hash
 * - Parent hashes reference nodes that appear later in the array (topological order: newest first)
 * - graphLines are consistent with parent relationships
 * - graphColumn values are within [0, maxColumns]
 *
 * @param maxNodes - Maximum number of nodes to generate (min 1)
 * @param maxColumns - Maximum column index (0-based)
 */
function arbitraryCommitNodeArray(
  maxNodes: number,
  maxColumns: number
): fc.Arbitrary<ICommitNode[]> {
  return fc.integer({ min: 1, max: maxNodes }).chain((count) => {
    return fc
      .uniqueArray(arbitraryHexString(40), { minLength: count, maxLength: count })
      .chain((hashes) => {
        // For each node, generate its column and parent selection
        const nodeArbs = hashes.map((hash, index) => {
          // Parents can only be nodes that appear later in the array (higher index = older)
          const possibleParents = hashes.slice(index + 1);
          const maxParents = Math.min(possibleParents.length, 2);

          return fc.integer({ min: 0, max: maxParents }).chain((parentCount) => {
            const parentsArb =
              parentCount === 0
                ? fc.constant([] as string[])
                : fc.shuffledSubarray(possibleParents, {
                    minLength: parentCount,
                    maxLength: parentCount,
                  });

            return fc.tuple(fc.constant(hash), parentsArb, fc.integer({ min: 0, max: maxColumns }));
          });
        });

        return fc.tuple(...nodeArbs).map((nodeDataArray) => {
          // Build a hash-to-column map so we can look up parent columns for graphLines
          const hashToColumn = new Map<string, number>();
          for (const [hash, , graphColumn] of nodeDataArray) {
            hashToColumn.set(hash, graphColumn);
          }

          return nodeDataArray.map(([hash, parents, graphColumn]) => {
            const graphLines = parents.map((parentHash, i) => {
              const parentColumn = hashToColumn.get(parentHash) ?? graphColumn;
              return {
                fromColumn: graphColumn,
                toColumn: parentColumn,
                color: getColumnColor(i === 0 ? graphColumn : parentColumn),
                type: (i === 0 ? 'commit' : 'merge') as 'commit' | 'merge' | 'branch',
              };
            });

            return {
              commit: {
                hash,
                shortHash: hash.substring(0, 7),
                message: `Commit ${hash.substring(0, 7)}`,
                author: { name: 'Test', email: 'test@test.com' },
                committer: { name: 'Test', email: 'test@test.com' },
                parents,
                authorDate: new Date(),
                commitDate: new Date(),
              },
              graphColumn,
              graphLines,
              branches: [],
              tags: [],
            } as ICommitNode;
          });
        });
      });
  });
}

// ─── Property Tests for computeGraphWidth and computeActiveLanes ──────────────

describe('Feature: git-graph-visualization - computeGraphWidth Property Tests', () => {
  describe('Property 6: Dynamic graph width computation', () => {
    /**
     *
     * For any non-empty ICommitNode[] array and valid IGraphRenderConfig,
     * computeGraphWidth(nodes, config) SHALL return
     * (maxColumn + 1) * config.columnWidth + config.padding * 2,
     * where maxColumn is the maximum value among all node.graphColumn
     * and all line.fromColumn / line.toColumn across all nodes.
     */
    it('Feature: git-graph-visualization, Property 6: Dynamic graph width computation', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNodeArray(10, 8),
          arbitraryGraphRenderConfig(),
          (nodes, config) => {
            const width = computeGraphWidth(nodes, config);

            // Compute the expected maxColumn using getMaxGraphColumn
            const maxCol = getMaxGraphColumn(nodes);

            const expectedWidth = (maxCol + 1) * config.columnWidth + config.padding * 2;

            assert.strictEqual(
              width,
              expectedWidth,
              `computeGraphWidth should return (${maxCol} + 1) * ${config.columnWidth} + ${config.padding} * 2 = ${expectedWidth}, ` +
                `but got ${width}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 6: Dynamic graph width computation — empty array returns 0', () => {
      fc.assert(
        fc.property(arbitraryGraphRenderConfig(), (config) => {
          const width = computeGraphWidth([], config);
          assert.strictEqual(width, 0, 'computeGraphWidth should return 0 for empty arrays');
        }),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 6: Dynamic graph width computation — width accounts for graphLine columns', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNodeArray(10, 8),
          arbitraryGraphRenderConfig(),
          (nodes, config) => {
            const width = computeGraphWidth(nodes, config);

            // Manually compute maxColumn by scanning all graphColumns and graphLine columns
            let manualMaxCol = 0;
            for (const node of nodes) {
              manualMaxCol = Math.max(manualMaxCol, node.graphColumn);
              for (const line of node.graphLines) {
                manualMaxCol = Math.max(manualMaxCol, line.fromColumn, line.toColumn);
              }
            }

            const expectedWidth = (manualMaxCol + 1) * config.columnWidth + config.padding * 2;

            assert.strictEqual(
              width,
              expectedWidth,
              `Width should account for max column across graphColumns and graphLines. ` +
                `Manual maxCol=${manualMaxCol}, expected width=${expectedWidth}, got ${width}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

describe('Feature: git-graph-visualization - computeActiveLanes Property Tests', () => {
  describe('Property 7: Active lane computation invariants', () => {
    /**
     *
     * For any ICommitNode[] array, computeActiveLanes(nodes) SHALL produce a map
     * where for each row index i:
     *   1. nodes[i].graphColumn is in activeLanes.get(i)
     *   2. For each graphLine in nodes[i].graphLines where the parent commit
     *      appears at a later row index: line.toColumn is in activeLanes.get(i)
     */
    it('Feature: git-graph-visualization, Property 7: Active lane computation invariants — own column is active', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 8), (nodes) => {
          const activeLaneMap = computeActiveLanes(nodes);

          // For each row index i, nodes[i].graphColumn must be in activeLanes.get(i)
          for (let i = 0; i < nodes.length; i++) {
            const activeLanes = activeLaneMap.get(i);
            assert.ok(activeLanes !== undefined, `activeLaneMap should have an entry for row ${i}`);
            assert.ok(
              activeLanes.has(nodes[i].graphColumn),
              `Row ${i}: nodes[${i}].graphColumn (${nodes[i].graphColumn}) should be in active lanes. ` +
                `Active lanes: [${[...activeLanes].join(', ')}]`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 7: Active lane computation invariants — parent toColumn is active', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 8), (nodes) => {
          const activeLaneMap = computeActiveLanes(nodes);

          // Build hash-to-row-index map
          const hashToRow = new Map<string, number>();
          for (let i = 0; i < nodes.length; i++) {
            hashToRow.set(nodes[i].commit.hash, i);
          }

          // For each row index i, for each graphLine in nodes[i].graphLines
          // where the parent commit appears at a later row index,
          // line.toColumn should be in activeLanes.get(i)
          for (let i = 0; i < nodes.length; i++) {
            const activeLanes = activeLaneMap.get(i)!;

            for (const line of nodes[i].graphLines) {
              // Find the parent commit that this line targets
              // by checking if any parent hash maps to a later row
              // and that parent's graphColumn matches line.toColumn
              let targetRow = -1;

              for (const parentHash of nodes[i].commit.parents) {
                const parentRow = hashToRow.get(parentHash);
                if (parentRow !== undefined && parentRow > i) {
                  // Check if this parent's column matches the line's toColumn
                  if (nodes[parentRow].graphColumn === line.toColumn) {
                    targetRow = parentRow;
                    break;
                  }
                }
              }

              // Fallback: if no parent matched by column, find any parent at a later row
              if (targetRow === -1) {
                for (const parentHash of nodes[i].commit.parents) {
                  const parentRow = hashToRow.get(parentHash);
                  if (parentRow !== undefined && parentRow > i) {
                    targetRow = parentRow;
                    break;
                  }
                }
              }

              if (targetRow > i) {
                assert.ok(
                  activeLanes.has(line.toColumn),
                  `Row ${i}: line.toColumn (${line.toColumn}) should be in active lanes ` +
                    `because parent appears at later row ${targetRow}. ` +
                    `Active lanes: [${[...activeLanes].join(', ')}]`
                );
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-visualization, Property 7: Active lane computation invariants — empty array returns empty map', () => {
      const activeLaneMap = computeActiveLanes([]);
      assert.strictEqual(
        activeLaneMap.size,
        0,
        'computeActiveLanes([]) should return an empty map'
      );
    });
  });
});
