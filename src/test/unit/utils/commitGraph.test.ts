/**
 * Unit tests for commit graph generation utilities.
 *
 * Tests cover:
 * - generateCommitGraph() for creating graph visualization data
 * - Handling of linear commit history
 * - Handling of merge commits with multiple parents
 * - Lane (column) assignment for branches
 * - Graph line generation
 *
 * Requirements: 9.1 (Log) - Display commit history with graph visualization
 */

import * as assert from 'assert';
import {
  generateCommitGraph,
  getMaxGraphColumn,
  isMergeCommit,
  isRootCommit,
  getActiveLaneCount,
  getColumnColor,
  ICommitNode,
} from '../../../utils/commitGraph';
import { ICommit } from '../../../services/interfaces/IGitService';

/**
 * Helper function to create a mock commit for testing.
 */
function createMockCommit(
  hash: string,
  parents: string[] = [],
  message: string = 'Test commit'
): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: { name: 'Test Author', email: 'test@example.com' },
    committer: { name: 'Test Author', email: 'test@example.com' },
    parents,
    authorDate: new Date(),
    commitDate: new Date(),
  };
}

describe('Commit Graph Generation', () => {
  describe('generateCommitGraph()', () => {
    describe('Empty input', () => {
      it('should return empty array for empty input', () => {
        const result = generateCommitGraph([]);
        assert.deepStrictEqual(result, []);
      });
    });

    describe('Single commit (root)', () => {
      it('should handle a single root commit', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].commit.hash, 'abc123');
        assert.strictEqual(result[0].graphColumn, 0);
        assert.strictEqual(result[0].graphLines.length, 0); // Root has no parent lines
      });
    });

    describe('Linear history', () => {
      it('should handle linear commit history', () => {
        // Commits in topological order (newest first)
        const commits = [
          createMockCommit('commit3', ['commit2'], 'Third commit'),
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 3);

        // All commits should be in the same column (lane 0)
        assert.strictEqual(result[0].graphColumn, 0);
        assert.strictEqual(result[1].graphColumn, 0);
        assert.strictEqual(result[2].graphColumn, 0);

        // First two commits should have lines to their parents
        assert.strictEqual(result[0].graphLines.length, 1);
        assert.strictEqual(result[0].graphLines[0].fromColumn, 0);
        assert.strictEqual(result[0].graphLines[0].toColumn, 0);
        assert.strictEqual(result[0].graphLines[0].type, 'commit');

        assert.strictEqual(result[1].graphLines.length, 1);
        assert.strictEqual(result[1].graphLines[0].fromColumn, 0);
        assert.strictEqual(result[1].graphLines[0].toColumn, 0);
        assert.strictEqual(result[1].graphLines[0].type, 'commit');

        // Root commit has no lines
        assert.strictEqual(result[2].graphLines.length, 0);
      });

      it('should assign correct line types for normal commits', () => {
        const commits = [
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result[0].graphLines[0].type, 'commit');
      });
    });

    describe('Merge commits', () => {
      it('should handle a simple merge commit', () => {
        // Merge commit with two parents
        const commits = [
          createMockCommit('merge', ['main2', 'feature1'], 'Merge feature into main'),
          createMockCommit('main2', ['main1'], 'Main commit 2'),
          createMockCommit('feature1', ['main1'], 'Feature commit'),
          createMockCommit('main1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 4);

        // Merge commit should have two graph lines
        const mergeNode = result[0];
        assert.strictEqual(mergeNode.graphLines.length, 2);

        // First line should be to first parent (main line)
        assert.strictEqual(mergeNode.graphLines[0].type, 'commit');

        // Second line should be to second parent (merged branch)
        assert.strictEqual(mergeNode.graphLines[1].type, 'merge');
      });

      it('should handle merge commit with three parents (octopus merge)', () => {
        const commits = [
          createMockCommit('octopus', ['parent1', 'parent2', 'parent3'], 'Octopus merge'),
          createMockCommit('parent1', ['base'], 'Parent 1'),
          createMockCommit('parent2', ['base'], 'Parent 2'),
          createMockCommit('parent3', ['base'], 'Parent 3'),
          createMockCommit('base', [], 'Base commit'),
        ];

        const result = generateCommitGraph(commits);

        // Octopus merge should have three graph lines
        const octopusNode = result[0];
        assert.strictEqual(octopusNode.graphLines.length, 3);

        // First line is main, others are merge lines
        assert.strictEqual(octopusNode.graphLines[0].type, 'commit');
        assert.strictEqual(octopusNode.graphLines[1].type, 'merge');
        assert.strictEqual(octopusNode.graphLines[2].type, 'merge');
      });
    });

    describe('Branch and merge scenario', () => {
      it('should handle a typical branch and merge workflow', () => {
        // Simulating:
        // * merge (main)
        // |\
        // | * feature2
        // | * feature1
        // * | main2
        // |/
        // * main1 (base)
        const commits = [
          createMockCommit('merge', ['main2', 'feature2'], 'Merge feature'),
          createMockCommit('feature2', ['feature1'], 'Feature 2'),
          createMockCommit('main2', ['main1'], 'Main 2'),
          createMockCommit('feature1', ['main1'], 'Feature 1'),
          createMockCommit('main1', [], 'Main 1'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 5);

        // Verify merge commit has two lines
        assert.strictEqual(result[0].graphLines.length, 2);
      });
    });

    describe('Branch and tag mapping', () => {
      it('should include branch names in commit nodes', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const branchMap = new Map<string, string[]>();
        branchMap.set('abc123', ['main', 'develop']);

        const result = generateCommitGraph(commits, branchMap);

        assert.deepStrictEqual(result[0].branches, ['main', 'develop']);
      });

      it('should include tag names in commit nodes', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const tagMap = new Map<string, string[]>();
        tagMap.set('abc123', ['v1.0.0', 'release']);

        const result = generateCommitGraph(commits, undefined, tagMap);

        assert.deepStrictEqual(result[0].tags, ['v1.0.0', 'release']);
      });

      it('should include both branches and tags', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const branchMap = new Map<string, string[]>();
        branchMap.set('abc123', ['main']);

        const tagMap = new Map<string, string[]>();
        tagMap.set('abc123', ['v1.0.0']);

        const result = generateCommitGraph(commits, branchMap, tagMap);

        assert.deepStrictEqual(result[0].branches, ['main']);
        assert.deepStrictEqual(result[0].tags, ['v1.0.0']);
      });

      it('should return empty arrays when no branches or tags', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const result = generateCommitGraph(commits);

        assert.deepStrictEqual(result[0].branches, []);
        assert.deepStrictEqual(result[0].tags, []);
      });
    });

    describe('Graph line colors', () => {
      it('should assign colors to graph lines', () => {
        const commits = [
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        // Lines should have colors assigned
        assert.ok(result[0].graphLines[0].color);
        assert.ok(result[0].graphLines[0].color.startsWith('#'));
      });
    });
  });

  describe('getMaxGraphColumn()', () => {
    it('should return -1 for empty array', () => {
      assert.strictEqual(getMaxGraphColumn([]), -1);
    });

    it('should return 0 for single commit in column 0', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('abc', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 0);
    });

    it('should return the maximum column from commit positions', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('b', []),
          graphColumn: 2,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('c', []),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 2);
    });

    it('should consider graph line columns', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [{ fromColumn: 0, toColumn: 3, color: '#000', type: 'merge' }],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 3);
    });
  });

  describe('isMergeCommit()', () => {
    it('should return false for root commit', () => {
      const commit = createMockCommit('abc', []);
      assert.strictEqual(isMergeCommit(commit), false);
    });

    it('should return false for single parent commit', () => {
      const commit = createMockCommit('abc', ['parent1']);
      assert.strictEqual(isMergeCommit(commit), false);
    });

    it('should return true for two parent commit', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2']);
      assert.strictEqual(isMergeCommit(commit), true);
    });

    it('should return true for three parent commit (octopus)', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2', 'parent3']);
      assert.strictEqual(isMergeCommit(commit), true);
    });
  });

  describe('isRootCommit()', () => {
    it('should return true for commit with no parents', () => {
      const commit = createMockCommit('abc', []);
      assert.strictEqual(isRootCommit(commit), true);
    });

    it('should return false for commit with one parent', () => {
      const commit = createMockCommit('abc', ['parent1']);
      assert.strictEqual(isRootCommit(commit), false);
    });

    it('should return false for merge commit', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2']);
      assert.strictEqual(isRootCommit(commit), false);
    });
  });

  describe('getActiveLaneCount()', () => {
    it('should return 0 for empty array', () => {
      assert.strictEqual(getActiveLaneCount([], 0), 0);
    });

    it('should return 0 for invalid index', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getActiveLaneCount(nodes, -1), 0);
      assert.strictEqual(getActiveLaneCount(nodes, 5), 0);
    });

    it('should count active lanes correctly', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [{ fromColumn: 0, toColumn: 1, color: '#000', type: 'merge' }],
          branches: [],
          tags: [],
        },
      ];

      // At index 0, we have lanes 0 and 1 active
      assert.strictEqual(getActiveLaneCount(nodes, 0), 2);
    });
  });

  describe('getColumnColor()', () => {
    it('should return a color string', () => {
      const color = getColumnColor(0);
      assert.ok(color.startsWith('#'));
    });

    it('should return different colors for different columns', () => {
      const color0 = getColumnColor(0);
      const color1 = getColumnColor(1);
      assert.notStrictEqual(color0, color1);
    });

    it('should cycle colors for large column numbers', () => {
      // Colors should cycle after the palette is exhausted
      const color0 = getColumnColor(0);
      const color10 = getColumnColor(10);
      assert.strictEqual(color0, color10); // Assuming 10 colors in palette
    });
  });
});

describe('Commit Graph - Complex Scenarios', () => {
  describe('Multiple parallel branches', () => {
    it('should handle multiple parallel branches', () => {
      // Simulating:
      // * merge-all
      // |\|\
      // | | * branch3
      // | * | branch2
      // * | | main
      // |/ /
      // * base
      const commits = [
        createMockCommit('merge-all', ['main', 'branch2', 'branch3'], 'Merge all'),
        createMockCommit('branch3', ['base'], 'Branch 3'),
        createMockCommit('branch2', ['base'], 'Branch 2'),
        createMockCommit('main', ['base'], 'Main'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 5);

      // Merge commit should have 3 lines
      assert.strictEqual(result[0].graphLines.length, 3);
    });
  });

  describe('Long linear history', () => {
    it('should handle long linear history efficiently', () => {
      const commits: ICommit[] = [];
      const count = 100;

      // Create a long linear history
      for (let i = 0; i < count; i++) {
        const parents = i < count - 1 ? [`commit${i + 1}`] : [];
        commits.push(createMockCommit(`commit${i}`, parents, `Commit ${i}`));
      }

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, count);

      // All commits should be in column 0
      for (const node of result) {
        assert.strictEqual(node.graphColumn, 0);
      }
    });
  });

  describe('Diamond merge pattern', () => {
    it('should handle diamond merge pattern', () => {
      // Diamond pattern:
      //   * merge
      //  /|
      // * | left
      // | * right
      // |/
      // * base
      const commits = [
        createMockCommit('merge', ['left', 'right'], 'Merge'),
        createMockCommit('left', ['base'], 'Left'),
        createMockCommit('right', ['base'], 'Right'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 4);

      // Merge should have 2 lines
      const mergeNode = result[0];
      assert.strictEqual(mergeNode.graphLines.length, 2);
    });
  });

  describe('Criss-cross merge', () => {
    it('should handle criss-cross merge pattern', () => {
      // Criss-cross:
      //   * merge2
      //  /|
      // * | merge1
      // |\|
      // | * b2
      // * | a2
      // | * b1
      // * | a1
      // |/
      // * base
      const commits = [
        createMockCommit('merge2', ['merge1', 'b2'], 'Merge 2'),
        createMockCommit('merge1', ['a2', 'b1'], 'Merge 1'),
        createMockCommit('b2', ['b1'], 'B2'),
        createMockCommit('a2', ['a1'], 'A2'),
        createMockCommit('b1', ['base'], 'B1'),
        createMockCommit('a1', ['base'], 'A1'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 7);

      // Both merge commits should have 2 lines each
      assert.strictEqual(result[0].graphLines.length, 2);
      assert.strictEqual(result[1].graphLines.length, 2);
    });
  });
});
