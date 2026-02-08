/**
 * Unit tests for optimized commit graph generation.
 *
 * Tests cover:
 * - Optimized graph generation for large histories
 * - Simplified graph mode
 * - Batch processing
 * - Graph statistics calculation
 */

import * as assert from 'assert';
import { ICommit } from '../../../services/interfaces/IGitService';
import {
  generateOptimizedCommitGraph,
  processCommitsInBatches,
  calculateGraphStats,
  shouldUseSimplifiedGraph,
} from '../../../utils/optimizedCommitGraph';

/**
 * Helper to create a mock commit.
 */
function createMockCommit(hash: string, parents: string[] = [], message = 'Test commit'): ICommit {
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

/**
 * Helper to create a linear commit history.
 */
function createLinearHistory(count: number): ICommit[] {
  const commits: ICommit[] = [];

  for (let i = 0; i < count; i++) {
    const hash = `commit${i.toString().padStart(4, '0')}`;
    const parents = i < count - 1 ? [`commit${(i + 1).toString().padStart(4, '0')}`] : [];
    commits.push(createMockCommit(hash, parents, `Commit ${i}`));
  }

  return commits;
}

/**
 * Helper to create a history with merge commits.
 */
function createMergeHistory(): ICommit[] {
  // Create a simple merge scenario:
  // commit0 (merge of commit1 and commit2)
  // commit1 (parent: commit3)
  // commit2 (parent: commit3)
  // commit3 (root)
  return [
    createMockCommit('commit0', ['commit1', 'commit2'], 'Merge commit'),
    createMockCommit('commit1', ['commit3'], 'Feature commit'),
    createMockCommit('commit2', ['commit3'], 'Another feature'),
    createMockCommit('commit3', [], 'Initial commit'),
  ];
}

describe('generateOptimizedCommitGraph', () => {
  describe('Basic Graph Generation', () => {
    it('should generate graph for empty commit list', () => {
      const result = generateOptimizedCommitGraph([]);
      assert.strictEqual(result.length, 0);
    });

    it('should generate graph for single commit', () => {
      const commits = [createMockCommit('abc123', [], 'Initial commit')];
      const result = generateOptimizedCommitGraph(commits);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].commit.hash, 'abc123');
      assert.strictEqual(result[0].graphColumn, 0);
      assert.strictEqual(result[0].graphLines.length, 0);
    });

    it('should generate graph for linear history', () => {
      const commits = createLinearHistory(5);
      const result = generateOptimizedCommitGraph(commits);

      assert.strictEqual(result.length, 5);

      // Each commit (except root) should have one line to parent
      for (let i = 0; i < result.length - 1; i++) {
        assert.strictEqual(result[i].graphLines.length, 1);
        assert.strictEqual(result[i].graphLines[0].type, 'commit');
      }

      // Root commit should have no lines
      assert.strictEqual(result[result.length - 1].graphLines.length, 0);
    });

    it('should generate graph for merge commits', () => {
      const commits = createMergeHistory();
      const result = generateOptimizedCommitGraph(commits);

      assert.strictEqual(result.length, 4);

      // First commit is a merge, should have 2 lines
      const mergeNode = result[0];
      assert.strictEqual(mergeNode.graphLines.length, 2);

      // One line should be 'commit' type, one should be 'merge' type
      const lineTypes = mergeNode.graphLines.map((l) => l.type);
      assert.ok(lineTypes.includes('commit'));
      assert.ok(lineTypes.includes('merge'));
    });

    it('should include branch labels', () => {
      const commits = [createMockCommit('abc123', [], 'Initial')];
      const branchMap = new Map([['abc123', ['main', 'develop']]]);

      const result = generateOptimizedCommitGraph(commits, branchMap);

      assert.deepStrictEqual(result[0].branches, ['main', 'develop']);
    });

    it('should include tag labels', () => {
      const commits = [createMockCommit('abc123', [], 'Initial')];
      const tagMap = new Map([['abc123', ['v1.0.0', 'release']]]);

      const result = generateOptimizedCommitGraph(commits, undefined, tagMap);

      assert.deepStrictEqual(result[0].tags, ['v1.0.0', 'release']);
    });
  });

  describe('Simplified Graph Mode', () => {
    it('should use simplified mode for large histories', () => {
      // Create a large history that exceeds the threshold
      const commits = createLinearHistory(6000);

      const result = generateOptimizedCommitGraph(commits, undefined, undefined, {
        simplifyLargeGraphs: true,
        simplificationThreshold: 5000,
      });

      assert.strictEqual(result.length, 6000);
    });

    it('should not use simplified mode when disabled', () => {
      const commits = createLinearHistory(100);

      const result = generateOptimizedCommitGraph(commits, undefined, undefined, {
        simplifyLargeGraphs: false,
      });

      assert.strictEqual(result.length, 100);
    });

    it('should not use simplified mode below threshold', () => {
      const commits = createLinearHistory(100);

      const result = generateOptimizedCommitGraph(commits, undefined, undefined, {
        simplifyLargeGraphs: true,
        simplificationThreshold: 5000,
      });

      assert.strictEqual(result.length, 100);
    });
  });

  describe('Lane Management', () => {
    it('should generate valid lane assignments', () => {
      // Create a history where lanes are assigned
      const commits = createLinearHistory(10);
      const result = generateOptimizedCommitGraph(commits);

      // All commits should have valid lane assignments (non-negative)
      for (const node of result) {
        assert.ok(node.graphColumn >= 0, 'Lane should be non-negative');
      }
    });

    it('should allocate multiple lanes for parallel branches', () => {
      // Create a history with parallel branches
      const commits = createMergeHistory();
      const result = generateOptimizedCommitGraph(commits);

      // The merge commit's parents should be in different lanes
      const mergeNode = result[0];
      const parentLanes = mergeNode.graphLines.map((l) => l.toColumn);

      // At least one parent should be in a different lane
      assert.ok(parentLanes.length >= 2);
    });
  });
});

describe('processCommitsInBatches', () => {
  it('should process commits in batches', async () => {
    const commits = createLinearHistory(100);
    const batches: { nodes: number; isComplete: boolean }[] = [];

    const result = await processCommitsInBatches(commits, 30, (nodes, isComplete) => {
      batches.push({ nodes: nodes.length, isComplete });
    });

    assert.strictEqual(result.length, 100);

    // Should have 4 batches: 30, 30, 30, 10
    assert.strictEqual(batches.length, 4);
    assert.strictEqual(batches[0].nodes, 30);
    assert.strictEqual(batches[0].isComplete, false);
    assert.strictEqual(batches[3].nodes, 10);
    assert.strictEqual(batches[3].isComplete, true);
  });

  it('should handle empty commit list', async () => {
    const batches: { nodes: number; isComplete: boolean }[] = [];

    const result = await processCommitsInBatches([], 30, (nodes, isComplete) => {
      batches.push({ nodes: nodes.length, isComplete });
    });

    assert.strictEqual(result.length, 0);
    assert.strictEqual(batches.length, 0);
  });

  it('should handle batch size larger than commit count', async () => {
    const commits = createLinearHistory(10);
    const batches: { nodes: number; isComplete: boolean }[] = [];

    const result = await processCommitsInBatches(commits, 100, (nodes, isComplete) => {
      batches.push({ nodes: nodes.length, isComplete });
    });

    assert.strictEqual(result.length, 10);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].nodes, 10);
    assert.strictEqual(batches[0].isComplete, true);
  });

  it('should include branch and tag maps', async () => {
    const commits = [createMockCommit('abc123', [], 'Initial')];
    const branchMap = new Map([['abc123', ['main']]]);
    const tagMap = new Map([['abc123', ['v1.0.0']]]);

    const result = await processCommitsInBatches(commits, 10, () => {}, branchMap, tagMap);

    assert.deepStrictEqual(result[0].branches, ['main']);
    assert.deepStrictEqual(result[0].tags, ['v1.0.0']);
  });
});

describe('calculateGraphStats', () => {
  it('should calculate stats for empty history', () => {
    const stats = calculateGraphStats([]);

    assert.strictEqual(stats.totalCommits, 0);
    assert.strictEqual(stats.mergeCommits, 0);
    assert.strictEqual(stats.rootCommits, 0);
    assert.strictEqual(stats.avgParents, 0);
  });

  it('should calculate stats for linear history', () => {
    const commits = createLinearHistory(10);
    const stats = calculateGraphStats(commits);

    assert.strictEqual(stats.totalCommits, 10);
    assert.strictEqual(stats.mergeCommits, 0);
    assert.strictEqual(stats.rootCommits, 1);
    // 9 commits with 1 parent + 1 root with 0 parents = 9 total parents
    assert.strictEqual(stats.avgParents, 0.9);
  });

  it('should calculate stats for history with merges', () => {
    const commits = createMergeHistory();
    const stats = calculateGraphStats(commits);

    assert.strictEqual(stats.totalCommits, 4);
    assert.strictEqual(stats.mergeCommits, 1);
    assert.strictEqual(stats.rootCommits, 1);
    // 1 merge (2 parents) + 2 normal (1 parent each) + 1 root (0 parents) = 4 parents
    assert.strictEqual(stats.avgParents, 1);
  });

  it('should count multiple root commits', () => {
    const commits = [
      createMockCommit('commit1', [], 'Root 1'),
      createMockCommit('commit2', [], 'Root 2'),
      createMockCommit('commit3', [], 'Root 3'),
    ];

    const stats = calculateGraphStats(commits);

    assert.strictEqual(stats.rootCommits, 3);
  });
});

describe('shouldUseSimplifiedGraph', () => {
  it('should return true for large histories', () => {
    const commits = createLinearHistory(6000);
    assert.strictEqual(shouldUseSimplifiedGraph(commits, 5000), true);
  });

  it('should return false for small histories', () => {
    const commits = createLinearHistory(100);
    assert.strictEqual(shouldUseSimplifiedGraph(commits, 5000), false);
  });

  it('should return false at exact threshold', () => {
    const commits = createLinearHistory(5000);
    assert.strictEqual(shouldUseSimplifiedGraph(commits, 5000), false);
  });

  it('should use default threshold', () => {
    const commits = createLinearHistory(6000);
    assert.strictEqual(shouldUseSimplifiedGraph(commits), true);
  });
});
