/**
 * Unit tests for commit graph generation utilities.
 *
 * Tests cover:
 * - generateCommitGraph() for creating graph visualization data
 * - Handling of linear commit history
 * - Handling of merge commits with multiple parents
 * - Lane (column) assignment for branches
 * - Graph line generation
 */

import * as assert from 'assert';
import {
  generateCommitGraph,
  getMaxGraphColumn,
  isMergeCommit,
  isRootCommit,
  getActiveLaneCount,
  getColumnColor,
  computeTerminalNodes,
  computeChildCountMap,
  isBranchSplit,
  classifyBranchName,
  ICommitNode,
} from '../../../git-core/commitGraph';
import { ICommit } from '../../../git-core/interfaces/IGitService';

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
  describe('computeTerminalNodes()', () => {
    it('should return empty set for empty input', () => {
      const result = computeTerminalNodes([]);
      assert.strictEqual(result.size, 0);
    });

    it('should return the single commit as terminal for a single root commit', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('abc123', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('abc123'));
    });

    it('should return only the tip commit in a linear history', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('commit3', ['commit2']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('commit2', ['commit1']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('commit1', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('commit3'));
      assert.ok(!result.has('commit2'));
      assert.ok(!result.has('commit1'));
    });

    it('should return multiple terminal nodes for branching history', () => {
      // Two branches diverging from a common base
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('branch-a', ['base']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('branch-b', ['base']),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('base', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 2);
      assert.ok(result.has('branch-a'));
      assert.ok(result.has('branch-b'));
      assert.ok(!result.has('base'));
    });

    it('should not include merge commit parents as terminal nodes', () => {
      // merge -> left, right -> base
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('merge', ['left', 'right']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('left', ['base']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('right', ['base']),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('base', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('merge'));
    });

    it('should handle commits with parents not in the graph', () => {
      // commit2 references a parent not in the node list
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('commit2', ['external-parent']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      // commit2 is terminal because no other commit lists it as a parent
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('commit2'));
    });
  });
});

describe('computeChildCountMap()', () => {
  it('should return empty map for empty input', () => {
    const result = computeChildCountMap([]);
    assert.strictEqual(result.size, 0);
  });

  it('should return empty map for a single root commit (no parents)', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('abc123', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.size, 0);
  });

  it('should count 1 child for a parent in a linear history', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('commit2', ['commit1']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('commit1', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('commit1'), 1);
  });

  it('should count 2 children for a branch split point', () => {
    // Two branches diverging from 'base'
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('branch-a', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('branch-b', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('base'), 2);
  });

  it('should count children from merge commits correctly', () => {
    // merge -> left, right -> base
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('merge', ['left', 'right']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('left', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('right', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    // 'left' and 'right' each have 1 child (the merge commit)
    assert.strictEqual(result.get('left'), 1);
    assert.strictEqual(result.get('right'), 1);
    // 'base' has 2 children (left and right)
    assert.strictEqual(result.get('base'), 2);
  });

  it('should count parents not in the graph', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('commit1', ['external-parent']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('external-parent'), 1);
  });
});

describe('isBranchSplit()', () => {
  it('should return false for a commit not in the child count map', () => {
    const childCountMap = new Map<string, number>();
    assert.strictEqual(isBranchSplit('unknown', childCountMap), false);
  });

  it('should return false for a commit with 1 child', () => {
    const childCountMap = new Map<string, number>([['commit1', 1]]);
    assert.strictEqual(isBranchSplit('commit1', childCountMap), false);
  });

  it('should return true for a commit with 2 children', () => {
    const childCountMap = new Map<string, number>([['base', 2]]);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
  });

  it('should return true for a commit with 3 children', () => {
    const childCountMap = new Map<string, number>([['base', 3]]);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
  });

  it('should return false for a commit with 0 children', () => {
    const childCountMap = new Map<string, number>([['tip', 0]]);
    assert.strictEqual(isBranchSplit('tip', childCountMap), false);
  });

  it('should work correctly with a real graph topology', () => {
    // Build a graph with a branch split at 'base'
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('branch-a', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('branch-b', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', ['root']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('root', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const childCountMap = computeChildCountMap(nodes);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
    assert.strictEqual(isBranchSplit('root', childCountMap), false);
    assert.strictEqual(isBranchSplit('branch-a', childCountMap), false);
    assert.strictEqual(isBranchSplit('branch-b', childCountMap), false);
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

describe('classifyBranchName()', () => {
  describe('local branches', () => {
    it('should classify "main" as local', () => {
      assert.strictEqual(classifyBranchName('main'), 'local');
    });

    it('should classify "develop" as local', () => {
      assert.strictEqual(classifyBranchName('develop'), 'local');
    });

    it('should classify "feature-branch" as local', () => {
      assert.strictEqual(classifyBranchName('feature-branch'), 'local');
    });

    it('should classify a single word branch name as local', () => {
      assert.strictEqual(classifyBranchName('hotfix'), 'local');
    });

    it('should classify an empty string as local', () => {
      assert.strictEqual(classifyBranchName(''), 'local');
    });
  });

  describe('remote branches', () => {
    it('should classify "origin/main" as remote', () => {
      assert.strictEqual(classifyBranchName('origin/main'), 'remote');
    });

    it('should classify "origin/develop" as remote', () => {
      assert.strictEqual(classifyBranchName('origin/develop'), 'remote');
    });

    it('should classify "upstream/feature-branch" as remote', () => {
      assert.strictEqual(classifyBranchName('upstream/feature-branch'), 'remote');
    });

    it('should classify "origin/feature/nested-name" as remote', () => {
      assert.strictEqual(classifyBranchName('origin/feature/nested-name'), 'remote');
    });

    it('should classify any "remoteName/" pattern as remote', () => {
      assert.strictEqual(classifyBranchName('my-remote/branch'), 'remote');
    });
  });
});

/**
 * Lane algorithm: divergent branch correctness.
 *
 * The pre-rewrite single-pass algorithm collapses divergent branches that
 * share an unseen parent: the SECOND child of a parent inherits the first
 * child's lane because parent-lane assignment was unconditional. The
 * children-map two-pass algorithm in the rewrite must give each divergent
 * branch its own lane.
 *
 * These tests are the RED capture for the rewrite.
 */
describe('Wave D — divergent branch lane correctness (D1)', () => {
  it('two children of unseen parent get distinct lanes', () => {
    // Display order (newest-first): tipA at lane 0, tipB diverges → must NOT
    // collapse onto lane 0. The shared parent `base` is unseen at the time
    // tipA is processed.
    //
    //   * tipA       (lane 0)
    //   |  * tipB    (lane 1, diverges)
    //   | /
    //   * base       (lane 0 — first-child-wins)
    const commits = [
      createMockCommit('tipA', ['base'], 'Tip A'),
      createMockCommit('tipB', ['base'], 'Tip B'),
      createMockCommit('base', [], 'Shared root'),
    ];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].graphColumn, 0, 'tipA in lane 0');
    assert.strictEqual(result[1].graphColumn, 1, 'tipB MUST be in a distinct lane');
    assert.strictEqual(result[2].graphColumn, 0, 'base settles on first-child lane');

    // tipB's line connects from lane 1 → lane 0 (base).
    assert.strictEqual(result[1].graphLines.length, 1);
    assert.strictEqual(result[1].graphLines[0].fromColumn, 1);
    assert.strictEqual(result[1].graphLines[0].toColumn, 0);
  });

  it('three-way fork at root yields three distinct lanes', () => {
    //   * tipA   (lane 0)
    //   | * tipB (lane 1)
    //   | | * tipC (lane 2)
    //   |/ /
    //   * base
    const commits = [
      createMockCommit('tipA', ['base']),
      createMockCommit('tipB', ['base']),
      createMockCommit('tipC', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    const lanes = new Set([result[0].graphColumn, result[1].graphColumn, result[2].graphColumn]);
    assert.strictEqual(lanes.size, 3, 'three distinct lanes for three branch tips');
    assert.strictEqual(result[3].graphColumn, 0, 'base on first-child lane');
  });

  it('fork-then-merge-back keeps divergence and converges at merge', () => {
    //   * merge   (parents: feat, main2)        — main lane
    //   |\
    //   | * feat                                 — diverged lane
    //   * | main2                                — main lane
    //   |/
    //   * base
    const commits = [
      createMockCommit('merge', ['main2', 'feat']),
      createMockCommit('feat', ['base']),
      createMockCommit('main2', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].graphColumn, 0, 'merge on lane 0');
    assert.strictEqual(result[0].graphLines.length, 2, 'merge has two outgoing lines');
    // feat (display index 1) and main2 (display index 2) — feat is the
    // SECOND parent of merge so it claims a new lane; main2 inherits
    // merge's lane (i=0 first parent).
    assert.notStrictEqual(
      result[1].graphColumn,
      result[2].graphColumn,
      'feat and main2 in distinct lanes'
    );
    // `base` is shared by feat (display index 1) and main2 (display
    // index 2). The first-seen-child-wins rule puts base on feat's
    // lane; main2's parent edge curves over to it. Whichever lane base
    // claims, it must coincide with feat's lane.
    assert.strictEqual(result[3].graphColumn, result[1].graphColumn, 'base on feat lane');
  });

  it('fork-fork-merge nested keeps every branch on its own lane', () => {
    //   * mergeAll (main2, featTip)
    //   |\
    //   | * featTip
    //   | * featMid
    //   * | main2
    //   * | main1
    //   |/
    //   * base
    const commits = [
      createMockCommit('mergeAll', ['main2', 'featTip']),
      createMockCommit('featTip', ['featMid']),
      createMockCommit('featMid', ['base']),
      createMockCommit('main2', ['main1']),
      createMockCommit('main1', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    // featTip and featMid stay together on the feat lane.
    assert.strictEqual(
      result[1].graphColumn,
      result[2].graphColumn,
      'feat lane is straight (featTip → featMid)'
    );
    // main2 and main1 stay together on the main lane.
    assert.strictEqual(
      result[3].graphColumn,
      result[4].graphColumn,
      'main lane is straight (main2 → main1)'
    );
    // The two lanes must be distinct.
    assert.notStrictEqual(
      result[1].graphColumn,
      result[3].graphColumn,
      'feat and main lanes are distinct'
    );
  });

  it('large random N=20 graph stays within K + 5 lane bound', () => {
    // 4 distinct branch tips (terminals), each 4 commits long, all rooted
    // at a shared base. 4 terminals + 1 root = 17, plus a couple of merges
    // bring the count up.
    const commits: ICommit[] = [];
    const tips = ['A', 'B', 'C', 'D'];
    for (const t of tips) {
      commits.push(createMockCommit(`${t}3`, [`${t}2`]));
      commits.push(createMockCommit(`${t}2`, [`${t}1`]));
      commits.push(createMockCommit(`${t}1`, [`${t}0`]));
      commits.push(createMockCommit(`${t}0`, ['base']));
    }
    commits.push(createMockCommit('base', []));

    const result = generateCommitGraph(commits);
    const maxCol = getMaxGraphColumn(result);
    assert.ok(
      maxCol <= tips.length + 4,
      `maxCol=${maxCol} must be ≤ ${tips.length + 4} (terminals + 5 buffer)`
    );
    // And every tip must claim a distinct lane.
    const tipLanes = new Set(
      tips.map((t) => result.find((n) => n.commit.hash === `${t}3`)!.graphColumn)
    );
    assert.strictEqual(tipLanes.size, tips.length, 'every terminal claims a distinct lane');
  });

  it('single-branch regression: linear history still in lane 0', () => {
    // The rewrite must NOT regress the single-branch baseline.
    const commits = [
      createMockCommit('c5', ['c4']),
      createMockCommit('c4', ['c3']),
      createMockCommit('c3', ['c2']),
      createMockCommit('c2', ['c1']),
      createMockCommit('c1', []),
    ];

    const result = generateCommitGraph(commits);
    for (const node of result) {
      assert.strictEqual(node.graphColumn, 0, `${node.commit.hash} in lane 0`);
    }
  });
});

describe('Wave D — focused branch path (D3)', () => {
  it('marks on-path commits when focusedPathHashes is provided', () => {
    const commits = [
      createMockCommit('tip', ['mid']),
      createMockCommit('mid', ['base']),
      createMockCommit('base', []),
    ];
    const onPath = new Set(['tip', 'mid']);

    const result = generateCommitGraph(commits, undefined, undefined, onPath);

    assert.strictEqual(result[0].onFocusedBranchPath, true);
    assert.strictEqual(result[1].onFocusedBranchPath, true);
    assert.strictEqual(result[2].onFocusedBranchPath, false);
  });

  it('all commits get false when focusedPathHashes is undefined', () => {
    const commits = [createMockCommit('tip', ['base']), createMockCommit('base', [])];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].onFocusedBranchPath, false);
    assert.strictEqual(result[1].onFocusedBranchPath, false);
  });

  it('all commits get false when focusedPathHashes is empty', () => {
    const commits = [createMockCommit('tip', ['base']), createMockCommit('base', [])];

    const result = generateCommitGraph(commits, undefined, undefined, new Set<string>());

    assert.strictEqual(result[0].onFocusedBranchPath, false);
    assert.strictEqual(result[1].onFocusedBranchPath, false);
  });
});
