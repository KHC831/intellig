/**
 * Property-based tests for branch label rendering and classification.
 *
 * Feature: git-graph-visual-improvements
 *
 * Uses fast-check to verify universal correctness properties of the
 * branch label rendering and classification across randomly generated inputs.
 *
 * Properties tested:
 * - Property 5: Branch labels rendered for all branch references
 * - Property 6: Branch label local/remote classification
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { Uri } from '../mocks/vscode';
import { ICommitNode, classifyBranchName } from '../../utils/commitGraph';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid local branch name (no '/' character).
 * Uses alphanumeric characters, hyphens, underscores, and dots.
 */
function arbitraryLocalBranchName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  );
}

/**
 * Generate a valid remote branch name (contains '/' character).
 * Format: "remoteName/branchName" where remoteName has no '/' and branchName is any valid name.
 */
function arbitraryRemoteBranchName(): fc.Arbitrary<string> {
  const remoteNameArb = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 15 }
  );
  const branchPartArb = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 20 }
  );
  return fc.tuple(remoteNameArb, branchPartArb).map(([remote, branch]) => `${remote}/${branch}`);
}

/**
 * Generate an arbitrary branch name that is either local or remote.
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc.oneof(arbitraryLocalBranchName(), arbitraryRemoteBranchName());
}

/**
 * Generate a non-empty array of unique branch names (mix of local and remote).
 */
function arbitraryBranchNameArray(minLength: number, maxLength: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(arbitraryBranchName(), { minLength, maxLength });
}

/**
 * Generate a minimal ICommitNode with the given branch names.
 */
function makeCommitNode(branches: string[]): ICommitNode {
  return {
    commit: {
      hash: 'a'.repeat(40),
      shortHash: 'a'.repeat(7),
      message: 'Test commit',
      author: { name: 'Test', email: 'test@test.com' },
      committer: { name: 'Test', email: 'test@test.com' },
      parents: [],
      authorDate: new Date(),
      commitDate: new Date(),
    },
    graphColumn: 0,
    graphLines: [],
    branches,
    tags: [],
  };
}

/**
 * Generate an arbitrary ICommitNode with random branch names.
 */
function arbitraryCommitNodeWithBranches(): fc.Arbitrary<ICommitNode> {
  return arbitraryBranchNameArray(1, 8).map((branches) => makeCommitNode(branches));
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

/**
 * Escape HTML special characters the same way the provider does,
 * so we can check for escaped branch names in the output.
 */
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-visual-improvements - Branch Labels Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 5: Branch labels rendered for all branch references', () => {
    /**
     * **Validates: Requirements 2.3, 2.5**
     *
     * For any commit node with a non-empty branches array, the rendered commit
     * row HTML should contain a label element for each branch name in the array.
     */
    it('Feature: git-graph-visual-improvements, Property 5: Branch labels rendered for all branch references', () => {
      fc.assert(
        fc.property(arbitraryCommitNodeWithBranches(), (node) => {
          const html = provider._getBranchLabelsHtml(node);

          // HTML should not be empty since branches array is non-empty
          assert.ok(
            html.length > 0,
            `HTML should not be empty for node with ${node.branches.length} branches`
          );

          // Count the number of <span> elements — should match branch count
          const spanCount = (html.match(/<span\s/g) || []).length;
          assert.strictEqual(
            spanCount,
            node.branches.length,
            `Should have ${node.branches.length} <span> elements, got ${spanCount}`
          );

          // Each branch name (HTML-escaped) should appear in the output
          for (const branchName of node.branches) {
            const escapedName = escapeHtml(branchName);
            assert.ok(
              html.includes(escapedName),
              `HTML should contain escaped branch name "${escapedName}" (original: "${branchName}"). HTML: "${html}"`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 2.3, 2.5**
     *
     * For any commit node with an empty branches array, the rendered HTML
     * should be an empty string.
     */
    it('Feature: git-graph-visual-improvements, Property 5: Empty branches produce empty HTML', () => {
      const node = makeCommitNode([]);
      const html = provider._getBranchLabelsHtml(node);
      assert.strictEqual(
        html,
        '',
        'HTML should be empty for node with no branches'
      );
    });
  });

  describe('Property 6: Branch label local/remote classification', () => {
    /**
     * **Validates: Requirements 2.4**
     *
     * For any branch name string, if the name contains a '/' (remote prefix pattern),
     * classifyBranchName should return 'remote'; otherwise it should return 'local'.
     */
    it('Feature: git-graph-visual-improvements, Property 6: classifyBranchName correctly classifies local branches', () => {
      fc.assert(
        fc.property(arbitraryLocalBranchName(), (branchName) => {
          // Local branch names have no '/' character
          const classification = classifyBranchName(branchName);
          assert.strictEqual(
            classification,
            'local',
            `Branch name "${branchName}" without '/' should be classified as local, got "${classification}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 2.4**
     *
     * For any branch name string that starts with a remote prefix (contains '/'),
     * classifyBranchName should return 'remote'.
     */
    it('Feature: git-graph-visual-improvements, Property 6: classifyBranchName correctly classifies remote branches', () => {
      fc.assert(
        fc.property(arbitraryRemoteBranchName(), (branchName) => {
          // Remote branch names contain '/' character
          const classification = classifyBranchName(branchName);
          assert.strictEqual(
            classification,
            'remote',
            `Branch name "${branchName}" with '/' should be classified as remote, got "${classification}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 2.4**
     *
     * For any branch name string, _getBranchLabelsHtml should apply the correct
     * CSS class: 'branch-label-remote' for remote branches and 'branch-label-local'
     * for local branches.
     */
    it('Feature: git-graph-visual-improvements, Property 6: _getBranchLabelsHtml applies correct CSS class based on classification', () => {
      fc.assert(
        fc.property(arbitraryBranchName(), (branchName) => {
          const node = makeCommitNode([branchName]);
          const html = provider._getBranchLabelsHtml(node);

          const isRemote = branchName.includes('/');
          const expectedClass = isRemote ? 'branch-label-remote' : 'branch-label-local';
          const unexpectedClass = isRemote ? 'branch-label-local' : 'branch-label-remote';

          assert.ok(
            html.includes(expectedClass),
            `HTML should contain CSS class "${expectedClass}" for branch "${branchName}". HTML: "${html}"`
          );
          assert.ok(
            !html.includes(unexpectedClass),
            `HTML should NOT contain CSS class "${unexpectedClass}" for branch "${branchName}". HTML: "${html}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 2.4**
     *
     * For any commit node with a mix of local and remote branches,
     * the rendered HTML should have the correct number of local and remote labels.
     */
    it('Feature: git-graph-visual-improvements, Property 6: Mixed branches get correct local/remote label counts', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.uniqueArray(arbitraryLocalBranchName(), { minLength: 1, maxLength: 4 }),
            fc.uniqueArray(arbitraryRemoteBranchName(), { minLength: 1, maxLength: 4 })
          ),
          ([localBranches, remoteBranches]) => {
            const allBranches = [...localBranches, ...remoteBranches];
            const node = makeCommitNode(allBranches);
            const html = provider._getBranchLabelsHtml(node);

            const localCount = (html.match(/branch-label-local/g) || []).length;
            const remoteCount = (html.match(/branch-label-remote/g) || []).length;

            assert.strictEqual(
              localCount,
              localBranches.length,
              `Should have ${localBranches.length} local labels, got ${localCount}. ` +
              `Local branches: ${JSON.stringify(localBranches)}`
            );
            assert.strictEqual(
              remoteCount,
              remoteBranches.length,
              `Should have ${remoteBranches.length} remote labels, got ${remoteCount}. ` +
              `Remote branches: ${JSON.stringify(remoteBranches)}`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
