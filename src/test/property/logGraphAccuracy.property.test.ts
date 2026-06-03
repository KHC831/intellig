import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IAuthor } from '../../git-core/interfaces/IGitService';
import {
  generateCommitGraph,
  ICommitNode,
  IBranchRef,
  isMergeCommit,
  isRootCommit,
} from '../../git-core/commitGraph';

/**
 * Property-based tests for Log Graph Accuracy.
 * Feature: intellig-vscode, Property 24: Log Graph Accuracy
 *
 *
 * Property Description:
 * For any repository, the Log View graph SHALL accurately represent the parent-child
 * relationships between commits, including merge commits with multiple parents.
 *
 * - 9.1: WHEN a user opens the Log_View, THE Extension SHALL display commit history
 *        with a graph showing branch and merge relationships
 */
describe('Log Graph Accuracy Property Tests', () => {
  /**
   * Arbitrary generator for commit hashes (40 character hex strings).
   */
  const commitHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    {
      minLength: 40,
      maxLength: 40,
    }
  );

  /**
   * Arbitrary generator for short commit hashes (7 character hex strings).
   */
  const shortHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    {
      minLength: 7,
      maxLength: 7,
    }
  );

  /**
   * Arbitrary generator for author names.
   */
  const authorNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '.split('')),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for author information.
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: authorNameArb,
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit messages (single line).
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.!?'.split('')
      ),
      { minLength: 1, maxLength: 100 }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for dates within a reasonable range.
   */
  const dateArb: fc.Arbitrary<Date> = fc.date({
    min: new Date('2020-01-01'),
    max: new Date('2024-12-31'),
  });

  /**
   * Create a commit with the given hash and parents.
   */
  function createCommit(
    hash: string,
    shortHash: string,
    parents: string[],
    message: string,
    author: IAuthor,
    date: Date
  ): ICommit {
    return {
      hash,
      shortHash,
      message,
      author,
      committer: author,
      parents,
      authorDate: date,
      commitDate: date,
    };
  }

  /**
   * Generate a deterministic commit history for more controlled testing.
   */
  const deterministicCommitHistoryArb: fc.Arbitrary<ICommit[]> = fc
    .tuple(
      fc.integer({ min: 1, max: 10 }), // Number of commits
      fc.boolean(), // Include merge commits
      fc.array(commitHashArb, { minLength: 15, maxLength: 15 }),
      fc.array(shortHashArb, { minLength: 15, maxLength: 15 }),
      fc.array(commitMessageArb, { minLength: 15, maxLength: 15 }),
      fc.array(authorArb, { minLength: 15, maxLength: 15 }),
      fc.array(dateArb, { minLength: 15, maxLength: 15 })
    )
    .map(([numCommits, includeMerge, hashes, shortHashes, messages, authors, dates]) => {
      const commits: ICommit[] = [];
      const sortedDates = [...dates].sort((a, b) => b.getTime() - a.getTime());

      for (let i = 0; i < numCommits; i++) {
        let parents: string[] = [];

        if (i === numCommits - 1) {
          // Last commit (oldest) - root commit
          parents = [];
        } else if (includeMerge && i === 0 && numCommits >= 3) {
          // First commit (newest) - merge commit if we have enough commits
          parents = [hashes[1], hashes[2]];
        } else {
          // Normal commit - parent is the next commit in the list
          parents = [hashes[i + 1]];
        }

        commits.push(
          createCommit(hashes[i], shortHashes[i], parents, messages[i], authors[i], sortedDates[i])
        );
      }

      return commits;
    });

  describe('Property 24: Log Graph Accuracy', () => {
    /**
     * Property: Every commit in the graph has a valid column assignment (non-negative).
     */
    it('Property: Every commit has a valid non-negative column assignment', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: All commits have non-negative column assignments
          for (const node of nodes) {
            assert.ok(
              node.graphColumn >= 0,
              `Commit ${node.commit.shortHash} should have non-negative column, got ${node.graphColumn}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Graph lines accurately represent parent-child relationships.
     * Each commit should have graph lines connecting to all its parents.
     */
    it('Property: Graph lines accurately represent parent-child relationships', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Create a map for quick lookup
          const nodeMap = new Map<string, ICommitNode>();
          for (const node of nodes) {
            nodeMap.set(node.commit.hash, node);
          }

          // Assert: Each commit has graph lines for each parent
          for (const node of nodes) {
            const commit = node.commit;
            const parentCount = commit.parents.length;

            // Number of graph lines should match number of parents
            assert.strictEqual(
              node.graphLines.length,
              parentCount,
              `Commit ${commit.shortHash} should have ${parentCount} graph lines for ${parentCount} parents, got ${node.graphLines.length}`
            );

            // Each graph line should start from this commit's column
            for (const line of node.graphLines) {
              assert.strictEqual(
                line.fromColumn,
                node.graphColumn,
                `Graph line should start from commit's column ${node.graphColumn}, got ${line.fromColumn}`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Root commits (no parents) have no graph lines.
     */
    it('Property: Root commits have no graph lines', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: Root commits have no graph lines
          for (const node of nodes) {
            if (isRootCommit(node.commit)) {
              assert.strictEqual(
                node.graphLines.length,
                0,
                `Root commit ${node.commit.shortHash} should have no graph lines`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Merge commits have multiple graph lines (one per parent).
     */
    it('Property: Merge commits have multiple graph lines for multiple parents', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: Merge commits have graph lines for each parent
          for (const node of nodes) {
            if (isMergeCommit(node.commit)) {
              const parentCount = node.commit.parents.length;
              assert.strictEqual(
                node.graphLines.length,
                parentCount,
                `Merge commit ${node.commit.shortHash} should have ${parentCount} graph lines`
              );

              // At least one line should be marked as 'merge' type
              const mergeLines = node.graphLines.filter((l) => l.type === 'merge');
              assert.ok(
                mergeLines.length >= 1,
                `Merge commit should have at least one 'merge' type line`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Single-parent commits have exactly one graph line.
     */
    it('Property: Single-parent commits have exactly one graph line', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: Single-parent commits have exactly one graph line
          for (const node of nodes) {
            const parentCount = node.commit.parents.length;
            if (parentCount === 1) {
              assert.strictEqual(
                node.graphLines.length,
                1,
                `Single-parent commit ${node.commit.shortHash} should have exactly 1 graph line`
              );
              assert.strictEqual(
                node.graphLines[0].type,
                'commit',
                `Single-parent commit should have 'commit' type line`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Graph preserves commit order (output order matches input order).
     */
    it('Property: Graph preserves commit order', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: Output order matches input order
          assert.strictEqual(
            nodes.length,
            commits.length,
            'Number of nodes should match number of commits'
          );

          for (let i = 0; i < commits.length; i++) {
            assert.strictEqual(
              nodes[i].commit.hash,
              commits[i].hash,
              `Node at index ${i} should have commit hash ${commits[i].hash}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All graph line columns are non-negative.
     */
    it('Property: All graph line columns are non-negative', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: All line columns are non-negative
          for (const node of nodes) {
            for (const line of node.graphLines) {
              assert.ok(
                line.fromColumn >= 0,
                `Line fromColumn should be non-negative, got ${line.fromColumn}`
              );
              assert.ok(
                line.toColumn >= 0,
                `Line toColumn should be non-negative, got ${line.toColumn}`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Graph lines have valid types (commit, merge, or branch).
     */
    it('Property: Graph lines have valid types', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: All lines have valid types
          const validTypes = ['commit', 'merge', 'branch'];
          for (const node of nodes) {
            for (const line of node.graphLines) {
              assert.ok(
                validTypes.includes(line.type),
                `Line type should be one of ${validTypes.join(', ')}, got ${line.type}`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Graph lines have non-empty color strings.
     */
    it('Property: Graph lines have non-empty color strings', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: All lines have non-empty colors
          for (const node of nodes) {
            for (const line of node.graphLines) {
              assert.ok(line.color && line.color.length > 0, `Line color should be non-empty`);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty commit list produces empty graph.
     */
    it('Property: Empty commit list produces empty graph', () => {
      fc.assert(
        fc.property(fc.constant([]), (commits: ICommit[]) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: Empty input produces empty output
          assert.strictEqual(nodes.length, 0, 'Empty commit list should produce empty graph');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Branch and tag maps are correctly associated with commits.
     */
    it('Property: Branch and tag maps are correctly associated with commits', () => {
      fc.assert(
        fc.property(
          deterministicCommitHistoryArb,
          fc.array(
            fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
              minLength: 1,
              maxLength: 10,
            }),
            { minLength: 0, maxLength: 5 }
          ),
          fc.array(
            fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
              minLength: 1,
              maxLength: 10,
            }),
            { minLength: 0, maxLength: 3 }
          ),
          (commits, branchNames, tagNames) => {
            if (commits.length === 0) {
              return true;
            }

            // Create branch and tag maps
            const branchMap = new Map<string, IBranchRef[]>();
            const tagMap = new Map<string, string[]>();

            // Branch names → typed refs. These tests don't assert
            // classification, so we derive type from the slash convention.
            const branchRefs: IBranchRef[] = branchNames.map(
              (name: string) =>
                ({ name, type: name.includes('/') ? 'remote' : 'local' }) as IBranchRef
            );

            // Assign branches and tags to first commit
            const firstCommitHash = commits[0].hash;
            if (branchRefs.length > 0) {
              branchMap.set(firstCommitHash, branchRefs);
            }
            if (tagNames.length > 0) {
              tagMap.set(firstCommitHash, tagNames);
            }

            // Act
            const nodes = generateCommitGraph(commits, branchMap, tagMap);

            // Assert: First commit has the correct branches and tags
            const firstNode = nodes[0];
            assert.deepStrictEqual(
              firstNode.branches,
              branchRefs,
              'First commit should have assigned branches'
            );
            assert.deepStrictEqual(
              firstNode.tags,
              tagNames,
              'First commit should have assigned tags'
            );

            // Assert: Other commits have empty branches and tags (unless assigned)
            for (let i = 1; i < nodes.length; i++) {
              const node = nodes[i];
              const expectedBranches = branchMap.get(node.commit.hash) || [];
              const expectedTags = tagMap.get(node.commit.hash) || [];
              assert.deepStrictEqual(node.branches, expectedBranches);
              assert.deepStrictEqual(node.tags, expectedTags);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: First parent line is always of type 'commit' for merge commits.
     */
    it('Property: First parent line is type commit for merge commits', () => {
      fc.assert(
        fc.property(deterministicCommitHistoryArb, (commits) => {
          // Act
          const nodes = generateCommitGraph(commits);

          // Assert: For merge commits, first line is 'commit' type
          for (const node of nodes) {
            if (isMergeCommit(node.commit) && node.graphLines.length > 0) {
              assert.strictEqual(
                node.graphLines[0].type,
                'commit',
                `First parent line of merge commit should be 'commit' type`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Graph handles linear history correctly.
     */
    it('Property: Graph handles linear history correctly', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.array(commitHashArb, { minLength: 15, maxLength: 15 }),
          fc.array(shortHashArb, { minLength: 15, maxLength: 15 }),
          fc.array(commitMessageArb, { minLength: 15, maxLength: 15 }),
          fc.array(authorArb, { minLength: 15, maxLength: 15 }),
          fc.array(dateArb, { minLength: 15, maxLength: 15 }),
          (numCommits, hashes, shortHashes, messages, authors, dates) => {
            // Create a linear history (each commit has exactly one parent except root)
            const commits: ICommit[] = [];
            const sortedDates = [...dates].sort((a, b) => b.getTime() - a.getTime());

            for (let i = 0; i < numCommits; i++) {
              const parents = i === numCommits - 1 ? [] : [hashes[i + 1]];
              commits.push(
                createCommit(
                  hashes[i],
                  shortHashes[i],
                  parents,
                  messages[i],
                  authors[i],
                  sortedDates[i]
                )
              );
            }

            // Act
            const nodes = generateCommitGraph(commits);

            // Assert: All commits except root have exactly one graph line
            for (let i = 0; i < nodes.length - 1; i++) {
              assert.strictEqual(
                nodes[i].graphLines.length,
                1,
                `Commit ${i} in linear history should have exactly 1 graph line`
              );
            }

            // Assert: Root commit has no graph lines
            assert.strictEqual(
              nodes[nodes.length - 1].graphLines.length,
              0,
              'Root commit should have no graph lines'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
