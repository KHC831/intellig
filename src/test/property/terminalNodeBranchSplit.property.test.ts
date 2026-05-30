/**
 * Property-based tests for terminal node and branch split detection.
 *
 * Feature: git-graph-visual-improvements
 * Property 4: Terminal node rendering omits top line and shows ring (detection part)
 *
 *
 * Tests that:
 * 1. Terminal nodes are exactly those commits whose hash does NOT appear as a parent of any other commit
 * 2. computeChildCountMap correctly counts how many children each commit has
 * 3. isBranchSplit returns true iff child count > 1
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommitNode,
  IGraphLine,
  computeTerminalNodes,
  computeChildCountMap,
  isBranchSplit,
  getColumnColor,
} from '../../git-core/commitGraph';

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
        const nodeArbs = hashes.map((hash, index) => {
          // Parents can only be nodes that appear later in the array (higher index = older)
          const possibleParents = hashes.slice(index + 1);
          const maxParents = Math.min(possibleParents.length, 3);

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
          const hashToColumn = new Map<string, number>();
          for (const [hash, , graphColumn] of nodeDataArray) {
            hashToColumn.set(hash, graphColumn);
          }

          return nodeDataArray.map(([hash, parents, graphColumn]) => {
            const graphLines: IGraphLine[] = parents.map((parentHash, i) => {
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

/**
 * Generate a commit graph that is guaranteed to have at least one branch split
 * (a commit that is a parent of more than one other commit).
 *
 * Creates a graph with at least 3 nodes where the last node is a parent of
 * at least 2 other nodes.
 */
function arbitraryGraphWithBranchSplit(maxColumns: number): fc.Arbitrary<ICommitNode[]> {
  return fc.integer({ min: 3, max: 10 }).chain((count) => {
    return fc
      .uniqueArray(arbitraryHexString(40), { minLength: count, maxLength: count })
      .chain((hashes) => {
        return fc
          .tuple(...hashes.map(() => fc.integer({ min: 0, max: maxColumns })))
          .map((columns) => {
            // Make the last hash a parent of at least the first two nodes
            const sharedParentHash = hashes[count - 1];

            return hashes.map((hash, index) => {
              let parents: string[];
              if (index < 2) {
                // First two nodes both have the last node as parent (creating a branch split)
                parents = [sharedParentHash];
              } else if (index === count - 1) {
                // Last node is the root
                parents = [];
              } else {
                // Other nodes have the next node as parent
                parents = [hashes[index + 1]];
              }

              const graphColumn = columns[index];
              const graphLines: IGraphLine[] = parents.map((parentHash) => ({
                fromColumn: graphColumn,
                toColumn: columns[hashes.indexOf(parentHash)] ?? graphColumn,
                color: getColumnColor(graphColumn),
                type: 'commit' as const,
              }));

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

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-visual-improvements - Terminal Node and Branch Split Detection', () => {
  describe('Property 4: Terminal node rendering omits top line and shows ring (detection part)', () => {
    /**
     *
     * For any generated commit graph, terminal nodes are exactly those commits
     * whose hash does NOT appear as a parent of any other commit in the graph.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Terminal node detection — terminal nodes are exactly those not appearing as parents', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          // Act
          const terminalNodes = computeTerminalNodes(nodes);

          // Compute expected terminal nodes manually
          const parentHashes = new Set<string>();
          for (const node of nodes) {
            for (const parentHash of node.commit.parents) {
              parentHashes.add(parentHash);
            }
          }

          const expectedTerminal = new Set<string>();
          for (const node of nodes) {
            if (!parentHashes.has(node.commit.hash)) {
              expectedTerminal.add(node.commit.hash);
            }
          }

          // Assert: terminal nodes match expected
          assert.strictEqual(
            terminalNodes.size,
            expectedTerminal.size,
            `Terminal node count mismatch: got ${terminalNodes.size}, expected ${expectedTerminal.size}`
          );

          for (const hash of expectedTerminal) {
            assert.ok(
              terminalNodes.has(hash),
              `Expected hash ${hash.substring(0, 7)} to be terminal but it was not`
            );
          }

          for (const hash of terminalNodes) {
            assert.ok(
              expectedTerminal.has(hash),
              `Hash ${hash.substring(0, 7)} was marked terminal but should not be`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * Terminal nodes should never include a hash that appears as a parent of another commit.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Terminal node detection — no terminal node appears as a parent', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          const terminalNodes = computeTerminalNodes(nodes);

          // Collect all parent hashes
          const parentHashes = new Set<string>();
          for (const node of nodes) {
            for (const parentHash of node.commit.parents) {
              parentHashes.add(parentHash);
            }
          }

          // Assert: no terminal node appears as a parent
          for (const terminalHash of terminalNodes) {
            assert.ok(
              !parentHashes.has(terminalHash),
              `Terminal node ${terminalHash.substring(0, 7)} should not appear as a parent of any commit`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * Every commit that IS a parent of another commit should NOT be in the terminal set.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Terminal node detection — all parent-referenced commits are non-terminal', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          const terminalNodes = computeTerminalNodes(nodes);

          // For each node, check that all its parents (that exist in the graph) are non-terminal
          const hashesInGraph = new Set(nodes.map((n) => n.commit.hash));

          for (const node of nodes) {
            for (const parentHash of node.commit.parents) {
              if (hashesInGraph.has(parentHash)) {
                assert.ok(
                  !terminalNodes.has(parentHash),
                  `Parent hash ${parentHash.substring(0, 7)} should not be terminal since it is referenced as a parent`
                );
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * Empty input should produce an empty terminal set.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Terminal node detection — empty graph returns empty set', () => {
      const terminalNodes = computeTerminalNodes([]);
      assert.strictEqual(terminalNodes.size, 0, 'Empty graph should produce empty terminal set');
    });
  });

  describe('computeChildCountMap correctness', () => {
    /**
     *
     * For any generated commit graph, computeChildCountMap correctly counts
     * how many times each hash appears as a parent across all commits.
     */
    it('Feature: git-graph-visual-improvements, Property 4: computeChildCountMap — counts match manual parent reference counting', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          // Act
          const childCountMap = computeChildCountMap(nodes);

          // Compute expected counts manually
          const expectedCounts = new Map<string, number>();
          for (const node of nodes) {
            for (const parentHash of node.commit.parents) {
              expectedCounts.set(parentHash, (expectedCounts.get(parentHash) || 0) + 1);
            }
          }

          // Assert: maps have the same keys and values
          assert.strictEqual(
            childCountMap.size,
            expectedCounts.size,
            `Child count map size mismatch: got ${childCountMap.size}, expected ${expectedCounts.size}`
          );

          for (const [hash, expectedCount] of expectedCounts) {
            const actualCount = childCountMap.get(hash);
            assert.strictEqual(
              actualCount,
              expectedCount,
              `Child count for ${hash.substring(0, 7)}: got ${actualCount}, expected ${expectedCount}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * All values in the child count map should be positive integers.
     */
    it('Feature: git-graph-visual-improvements, Property 4: computeChildCountMap — all counts are positive integers', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          const childCountMap = computeChildCountMap(nodes);

          for (const [hash, count] of childCountMap) {
            assert.ok(
              Number.isInteger(count) && count > 0,
              `Child count for ${hash.substring(0, 7)} should be a positive integer, got ${count}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * Empty input should produce an empty child count map.
     */
    it('Feature: git-graph-visual-improvements, Property 4: computeChildCountMap — empty graph returns empty map', () => {
      const childCountMap = computeChildCountMap([]);
      assert.strictEqual(childCountMap.size, 0, 'Empty graph should produce empty child count map');
    });
  });

  describe('isBranchSplit correctness', () => {
    /**
     *
     * For any generated commit graph, isBranchSplit returns true if and only if
     * the commit's child count is greater than 1.
     */
    it('Feature: git-graph-visual-improvements, Property 4: isBranchSplit — returns true iff child count > 1', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          const childCountMap = computeChildCountMap(nodes);

          for (const node of nodes) {
            const hash = node.commit.hash;
            const childCount = childCountMap.get(hash) || 0;
            const result = isBranchSplit(hash, childCountMap);

            assert.strictEqual(
              result,
              childCount > 1,
              `isBranchSplit for ${hash.substring(0, 7)} with child count ${childCount}: got ${result}, expected ${childCount > 1}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * isBranchSplit should return false for hashes not in the child count map.
     */
    it('Feature: git-graph-visual-improvements, Property 4: isBranchSplit — returns false for unknown hashes', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNodeArray(10, 5),
          arbitraryHexString(40),
          (nodes, unknownHash) => {
            const childCountMap = computeChildCountMap(nodes);

            // Only test if the hash is truly not in the map
            if (!childCountMap.has(unknownHash)) {
              assert.strictEqual(
                isBranchSplit(unknownHash, childCountMap),
                false,
                `isBranchSplit should return false for hash ${unknownHash.substring(0, 7)} not in child count map`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     *
     * In a graph with a guaranteed branch split, at least one commit should
     * have isBranchSplit return true.
     */
    it('Feature: git-graph-visual-improvements, Property 4: isBranchSplit — detects branch splits in graphs with known splits', () => {
      fc.assert(
        fc.property(arbitraryGraphWithBranchSplit(5), (nodes) => {
          const childCountMap = computeChildCountMap(nodes);

          // At least one commit should be a branch split
          let foundBranchSplit = false;
          for (const node of nodes) {
            if (isBranchSplit(node.commit.hash, childCountMap)) {
              foundBranchSplit = true;
              break;
            }
          }

          assert.ok(
            foundBranchSplit,
            'Graph with a guaranteed branch split should have at least one commit where isBranchSplit returns true'
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Terminal nodes and child count map consistency', () => {
    /**
     *
     * Terminal nodes (no children) should have child count 0 or be absent from the child count map.
     * Non-terminal nodes should have child count >= 1.
     */
    it('Feature: git-graph-visual-improvements, Property 4: Consistency — terminal nodes have zero children, non-terminal have >= 1', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeArray(10, 5), (nodes) => {
          const terminalNodes = computeTerminalNodes(nodes);
          const childCountMap = computeChildCountMap(nodes);

          for (const node of nodes) {
            const hash = node.commit.hash;
            const childCount = childCountMap.get(hash) || 0;

            if (terminalNodes.has(hash)) {
              // Terminal nodes should have 0 children
              assert.strictEqual(
                childCount,
                0,
                `Terminal node ${hash.substring(0, 7)} should have 0 children, got ${childCount}`
              );
            } else {
              // Non-terminal nodes that are in the graph should have >= 1 children
              // (they are referenced as parents by at least one other commit)
              assert.ok(
                childCount >= 1,
                `Non-terminal node ${hash.substring(0, 7)} should have >= 1 children, got ${childCount}`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
