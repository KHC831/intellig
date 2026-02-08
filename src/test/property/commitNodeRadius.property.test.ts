/**
 * Property-based tests for commit node circle radius.
 *
 * Feature: git-graph-details-improvements
 * Property 1: Commit node circles use reduced radius
 *
 * Uses fast-check to verify that all commit node circles rendered by
 * renderGraphSvg() use a radius of 4 pixels (reduced from the previous 6),
 * for both normal commits and merge commits.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  renderGraphSvg,
  DEFAULT_GRAPH_CONFIG,
} from '../../utils/graphRenderer';
import { ICommitNode, getColumnColor } from '../../utils/commitGraph';
import { ICommit } from '../../services/interfaces/IGitService';

// ─── Generators ───────────────────────────────────────────────────────────────

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
    parents: fc.tuple(...Array.from({ length: parentCount }, () => arbitraryHexString(40))).map(
      (arr) => arr
    ),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }),
  });
}

/**
 * Generate a random ICommitNode with a valid graphColumn (0 to maxColumn).
 * Generates graphLines where fromColumn equals the node's graphColumn.
 * parentCount controls the number of parents (0, 1, or 2+).
 */
function arbitraryCommitNode(maxColumn: number, parentCount?: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    const parentCountArb =
      parentCount !== undefined
        ? fc.constant(parentCount)
        : fc.integer({ min: 0, max: 2 });

    return parentCountArb.chain((pCount) => {
      const graphLinesArb =
        pCount === 0
          ? fc.constant([])
          : fc
              .tuple(
                ...Array.from({ length: pCount }, (_, i) =>
                  fc.record({
                    fromColumn: fc.constant(graphColumn),
                    toColumn:
                      i === 0
                        ? fc.constant(graphColumn)
                        : fc.integer({ min: 0, max: maxColumn }),
                    color: fc.constant(getColumnColor(graphColumn)),
                    type: fc.constant(i === 0 ? ('commit' as const) : ('merge' as const)),
                  })
                )
              )
              .map((arr) => arr);

      return fc.tuple(arbitraryCommit(pCount), graphLinesArb).map(
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
 * Generate a random ICommitNode that is guaranteed to be a merge commit (parents.length >= 2).
 */
function arbitraryMergeCommitNode(maxColumn: number): fc.Arbitrary<ICommitNode> {
  return fc.integer({ min: 0, max: maxColumn }).chain((graphColumn) => {
    return fc.integer({ min: 2, max: 3 }).chain((parentCount) => {
      const graphLinesArb = fc
        .tuple(
          ...Array.from({ length: parentCount }, (_, i) =>
            fc.record({
              fromColumn: fc.constant(graphColumn),
              toColumn:
                i === 0
                  ? fc.constant(graphColumn)
                  : fc.integer({ min: 0, max: maxColumn }),
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

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Extract all circle elements from an SVG string.
 * Returns an array of objects with r (radius) attribute.
 */
function extractCircleRadii(svg: string): string[] {
  const circleRegex = /<circle\s+[^>]*r="([^"]+)"[^>]*\/>/g;
  const radii: string[] = [];
  let match;
  while ((match = circleRegex.exec(svg)) !== null) {
    radii.push(match[1]);
  }
  return radii;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-details-improvements - Commit Node Radius Property Tests', () => {
  describe('Property 1: Commit node circles use reduced radius', () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * For any ICommitNode (including merge commits), the SVG output of
     * renderGraphSvg() SHALL contain a <circle> element with r="4"
     * and SHALL NOT contain a circle with r="6".
     */
    it('Feature: git-graph-details-improvements, Property 1: Commit node circles use reduced radius — normal commits', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNode(10, 1),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG);

            const radii = extractCircleRadii(svg);

            // There should be at least one circle (the commit node)
            assert.ok(radii.length >= 1, `SVG should contain at least one circle element, got ${radii.length}`);

            // All circles should have r="4"
            for (const r of radii) {
              assert.strictEqual(
                r,
                '4',
                `All commit node circles should have r="4", but found r="${r}"`
              );
            }

            // No circle should have r="6" (the old radius)
            assert.ok(
              !radii.includes('6'),
              'No circle should have the old radius r="6"'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-details-improvements, Property 1: Commit node circles use reduced radius — merge commits', () => {
      fc.assert(
        fc.property(
          arbitraryMergeCommitNode(10),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG);

            const radii = extractCircleRadii(svg);

            // There should be at least one circle (the merge commit node)
            assert.ok(radii.length >= 1, `SVG should contain at least one circle element for merge commit, got ${radii.length}`);

            // All circles should have r="4" (reduced radius applies to merge commits too)
            for (const r of radii) {
              assert.strictEqual(
                r,
                '4',
                `Merge commit node circles should have r="4", but found r="${r}"`
              );
            }

            // No circle should have r="6" (the old radius)
            assert.ok(
              !radii.includes('6'),
              'No merge commit circle should have the old radius r="6"'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: git-graph-details-improvements, Property 1: Commit node circles use reduced radius — root commits (no parents)', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNode(10, 0),
          fc.integer({ min: 0, max: 100 }),
          (node, rowIndex) => {
            const activeLanes = new Set([node.graphColumn]);
            const svg = renderGraphSvg(node, rowIndex, activeLanes, DEFAULT_GRAPH_CONFIG);

            const radii = extractCircleRadii(svg);

            // There should be at least one circle (the root commit node)
            assert.ok(radii.length >= 1, `SVG should contain at least one circle element for root commit, got ${radii.length}`);

            // All circles should have r="4"
            for (const r of radii) {
              assert.strictEqual(
                r,
                '4',
                `Root commit node circles should have r="4", but found r="${r}"`
              );
            }

            // No circle should have r="6"
            assert.ok(
              !radii.includes('6'),
              'No root commit circle should have the old radius r="6"'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
