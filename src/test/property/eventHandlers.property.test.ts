/**
 * Property-based tests for branch and commit event handlers.
 *
 * Feature: intellig-ui-fixes, Property 5: Branch items have data attributes for event delegation
 * Feature: intellig-ui-fixes, Property 6: Commit rows have data-hash attribute for event delegation
 *
 * Uses fast-check to verify that:
 * - For any branch rendered in the Branch Panel HTML, the branch item element has
 *   a data-branch attribute with the branch name, and a data-type attribute indicating
 *   whether it is a local or remote branch, enabling event delegation for click and
 *   context menu handlers.
 * - For any commit row rendered in the Graph Panel HTML, the row element has a data-hash
 *   attribute with the commit hash, enabling event delegation for click and context menu
 *   handlers.
 *
 * **Validates: Requirements 2.1, 3.1, 4.1, 4.2, 4.4**
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { IBranchPanelData } from '../../services/interfaces';
import { IBranch } from '../../services/interfaces/IGitService';
import { ICommitNode, IGraphLine } from '../../utils/commitGraph';
import { ICommit, IAuthor } from '../../services/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );
}

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 15 }
  );
}

/**
 * Generate a valid branch name (1-2 segments joined by '/').
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc.array(arbitraryBranchSegment(), { minLength: 1, maxLength: 2 })
    .map(segments => segments.join('/'));
}

/**
 * Generate a valid remote name.
 */
function arbitraryRemoteName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 1, maxLength: 10 }
  );
}

/**
 * Generate a minimal IBranch for a local branch.
 */
function arbitraryLocalBranch(): fc.Arbitrary<IBranch> {
  return fc.record({
    name: arbitraryBranchName(),
    type: fc.constant('local' as const),
    commit: arbitraryFullHash(),
    isHead: fc.constant(false),
  });
}

/**
 * Generate a remote branch with name prefixed by remoteName/.
 */
function arbitraryRemoteBranch(remoteName: string): fc.Arbitrary<IBranch> {
  return fc.record({
    name: arbitraryBranchName().map(n => `${remoteName}/${n}`),
    type: fc.constant('remote' as const),
    commit: arbitraryFullHash(),
    isHead: fc.constant(false),
  });
}

/**
 * Generate a remote group with a remote name and 1-5 branches.
 */
function arbitraryRemoteGroup(): fc.Arbitrary<{ remoteName: string; branches: IBranch[] }> {
  return arbitraryRemoteName().chain(remoteName =>
    fc.array(arbitraryRemoteBranch(remoteName), { minLength: 1, maxLength: 5 })
      .map(branches => {
        const seen = new Set<string>();
        const unique = branches.filter(b => {
          const lower = b.name.toLowerCase();
          if (seen.has(lower)) { return false; }
          seen.add(lower);
          return true;
        });
        return { remoteName, branches: unique.length > 0 ? unique : [branches[0]] };
      })
  );
}

/**
 * Generate IBranchPanelData with random local and remote branches.
 * Ensures unique branch names within each category.
 */
function arbitraryBranchPanelData(): fc.Arbitrary<IBranchPanelData> {
  return fc.record({
    head: fc.record({
      name: arbitraryBranchName(),
      isDetached: fc.constant(false),
    }),
    local: fc.array(arbitraryLocalBranch(), { minLength: 1, maxLength: 8 })
      .map(branches => {
        const seen = new Set<string>();
        return branches.filter(b => {
          const lower = b.name.toLowerCase();
          if (seen.has(lower)) { return false; }
          seen.add(lower);
          return true;
        });
      })
      .filter(branches => branches.length > 0),
    remote: fc.array(arbitraryRemoteGroup(), { minLength: 1, maxLength: 3 })
      .map(groups => {
        const seen = new Set<string>();
        return groups.filter(g => {
          const lower = g.remoteName.toLowerCase();
          if (seen.has(lower)) { return false; }
          seen.add(lower);
          return true;
        });
      })
      .filter(groups => groups.length > 0),
  });
}

/**
 * Generate a non-empty author name using safe characters.
 */
function arbitraryAuthorName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  ).filter(s => s.trim().length > 0);
}

/**
 * Generate a valid email address.
 */
function arbitraryEmail(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 }),
    fc.constantFrom('com', 'org', 'net', 'io')
  ).map(([user, domain, tld]) => `${user}@${domain}.${tld}`);
}

/**
 * Generate an IAuthor.
 */
function arbitraryAuthor(): fc.Arbitrary<IAuthor> {
  return fc.record({
    name: arbitraryAuthorName(),
    email: arbitraryEmail(),
  });
}

/**
 * Generate a commit message using safe characters.
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split('')
    ),
    { minLength: 1, maxLength: 80 }
  ).filter(s => s.trim().length > 0);
}

/**
 * Generate a Date within the last year.
 */
function arbitraryRecentDate(): fc.Arbitrary<Date> {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 3600 * 1000;
  return fc.integer({ min: 1000, max: oneYearMs }).map(ms => new Date(now - ms));
}

/**
 * Generate a valid ICommit object.
 */
function arbitraryCommit(hash: string): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: fc.constant(hash),
    shortHash: fc.constant(hash.substring(0, 7)),
    message: arbitraryCommitMessage(),
    author: arbitraryAuthor(),
    committer: arbitraryAuthor(),
    parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
    authorDate: arbitraryRecentDate(),
    commitDate: arbitraryRecentDate(),
  });
}

/**
 * Generate a valid IGraphLine.
 */
function arbitraryGraphLine(): fc.Arbitrary<IGraphLine> {
  return fc.record({
    fromColumn: fc.integer({ min: 0, max: 5 }),
    toColumn: fc.integer({ min: 0, max: 5 }),
    color: fc.constantFrom('#4CAF50', '#2196F3', '#FF9800', '#9C27B0'),
    type: fc.constantFrom('commit' as const, 'merge' as const, 'branch' as const),
  });
}

/**
 * Generate a valid ICommitNode for a given commit hash.
 */
function arbitraryCommitNode(hash: string): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(hash),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 1, maxLength: 10 }),
      { minLength: 0, maxLength: 2 }
    ),
    tags: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), { minLength: 1, maxLength: 10 }),
      { minLength: 0, maxLength: 2 }
    ),
  });
}

/**
 * Generate a list of 1-5 commit nodes with unique hashes.
 */
function arbitraryCommitNodes(): fc.Arbitrary<ICommitNode[]> {
  return fc.array(arbitraryFullHash(), { minLength: 1, maxLength: 5 })
    .filter(hashes => new Set(hashes).size === hashes.length)
    .chain(hashes => {
      const nodeArbs = hashes.map(hash => arbitraryCommitNode(hash));
      return fc.tuple(...nodeArbs as [fc.Arbitrary<ICommitNode>, ...fc.Arbitrary<ICommitNode>[]])
        .map(nodes => nodes as unknown as ICommitNode[]);
    });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellig-ui-fixes - Event Handlers Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 5: Branch items have data attributes for event delegation', () => {
    /**
     * **Validates: Requirements 2.1, 4.1, 4.2**
     *
     * For any branch rendered in the Branch Panel HTML, the branch item element
     * shall have a data-branch attribute with the branch name, and a data-type
     * attribute indicating whether it is a local or remote branch, enabling
     * event delegation for click and context menu handlers.
     */
    it('Feature: intellig-ui-fixes, Property 5: Branch items have click and context menu handlers — local and remote branches have correct data-branch and data-type attributes', () => {
      fc.assert(
        fc.property(
          arbitraryBranchPanelData(),
          (branchData) => {
            const html = provider._getBranchPanelHtml(branchData);

            // Verify each local branch has data-branch and data-type="local" attributes
            for (const branch of branchData.local) {
              const expectedDataBranch = `data-branch="${branch.name}"`;
              assert.ok(
                html.includes(expectedDataBranch),
                `Local branch "${branch.name}" should have data-branch="${branch.name}"`
              );

              // Verify the branch item has data-type="local"
              // We check that a branch-item with this data-branch also has data-type="local"
              const branchItemPattern = `data-branch="${branch.name}" data-type="local"`;
              assert.ok(
                html.includes(branchItemPattern),
                `Local branch "${branch.name}" should have data-type="local" attribute`
              );
            }

            // Verify each remote branch has data-branch and data-type="remote" attributes
            for (const group of branchData.remote) {
              for (const branch of group.branches) {
                const expectedDataBranch = `data-branch="${branch.name}"`;
                assert.ok(
                  html.includes(expectedDataBranch),
                  `Remote branch "${branch.name}" should have data-branch="${branch.name}"`
                );

                const branchItemPattern = `data-branch="${branch.name}" data-type="remote"`;
                assert.ok(
                  html.includes(branchItemPattern),
                  `Remote branch "${branch.name}" should have data-type="remote" attribute`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 6: Commit rows have data-hash attribute for event delegation', () => {
    /**
     * **Validates: Requirements 3.1, 4.4**
     *
     * For any commit row rendered in the Graph Panel HTML, the row element shall
     * have a data-hash attribute with the commit hash, enabling event delegation
     * for click and context menu handlers.
     */
    it('Feature: intellig-ui-fixes, Property 6: Commit rows have click and context menu handlers — each commit row has correct data-hash attribute', () => {
      fc.assert(
        fc.property(
          arbitraryCommitNodes(),
          (commitNodes) => {
            const html = provider._getGraphPanelHtml(commitNodes);

            // Verify each commit row has data-hash attribute
            for (const node of commitNodes) {
              const hash = node.commit.hash;

              const expectedDataHash = `data-hash="${hash}"`;
              assert.ok(
                html.includes(expectedDataHash),
                `Commit row with hash "${hash}" should have data-hash="${hash}" attribute`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
