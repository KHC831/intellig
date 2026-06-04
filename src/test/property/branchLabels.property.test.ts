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
 * - Property 6: Branch label local/remote classification is driven by the
 *   branch ref's `type` (IBranch.type), NOT by a `name.includes('/')`
 *   heuristic. This is the Bug E regression guard: a LOCAL branch whose
 *   name contains a `/` (`feature/foo`) must render with the local icon.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../ui-shell/GitToolWindowProvider';
import { Uri } from '../mocks/vscode';
import { ICommitNode, IBranchRef } from '../../git-core/commitGraph';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid local-style branch name (no '/' character).
 * Uses alphanumeric characters, hyphens, underscores, and dots.
 */
function arbitrarySimpleName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  );
}

/**
 * Generate a name that contains a '/' (e.g. `feature/foo`, `origin/main`).
 * Format: "prefix/suffix". Used BOTH for local branches (the Bug E case —
 * `feature/foo` is local despite the slash) AND remote branches.
 */
function arbitrarySlashName(): fc.Arbitrary<string> {
  const prefixArb = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 15 }
  );
  const suffixArb = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 20 }
  );
  return fc.tuple(prefixArb, suffixArb).map(([prefix, suffix]) => `${prefix}/${suffix}`);
}

/**
 * Generate a LOCAL branch ref. Crucially, the name may or may not contain a
 * '/' — a local `feature/foo` is the heart of Bug E.
 */
function arbitraryLocalBranchRef(): fc.Arbitrary<IBranchRef> {
  return fc
    .oneof(arbitrarySimpleName(), arbitrarySlashName())
    .map((name) => ({ name, type: 'local' as const }));
}

/**
 * Generate a REMOTE branch ref (name always contains the remote/ prefix).
 */
function arbitraryRemoteBranchRef(): fc.Arbitrary<IBranchRef> {
  return arbitrarySlashName().map((name) => ({ name, type: 'remote' as const }));
}

/**
 * Generate an arbitrary branch ref that is either local or remote.
 */
function arbitraryBranchRef(): fc.Arbitrary<IBranchRef> {
  return fc.oneof(arbitraryLocalBranchRef(), arbitraryRemoteBranchRef());
}

/**
 * Generate a non-empty array of branch refs with unique names.
 */
function arbitraryBranchRefArray(minLength: number, maxLength: number): fc.Arbitrary<IBranchRef[]> {
  return fc.uniqueArray(arbitraryBranchRef(), {
    minLength,
    maxLength,
    selector: (ref) => ref.name,
  });
}

/**
 * Generate a minimal ICommitNode with the given branch refs.
 */
function makeCommitNode(branches: IBranchRef[]): ICommitNode {
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
 * Generate an arbitrary ICommitNode with random branch refs.
 */
function arbitraryCommitNodeWithBranches(): fc.Arbitrary<ICommitNode> {
  return arbitraryBranchRefArray(1, 8).map((branches) => makeCommitNode(branches));
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
     *
     * For any commit node with a non-empty branches array, the rendered commit
     * row HTML should contain a label element for each branch ref in the array.
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
          for (const branchRef of node.branches) {
            const escapedName = escapeHtml(branchRef.name);
            assert.ok(
              html.includes(escapedName),
              `HTML should contain escaped branch name "${escapedName}" (original: "${branchRef.name}"). HTML: "${html}"`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * For any commit node with an empty branches array, the rendered HTML
     * should be an empty string.
     */
    it('Feature: git-graph-visual-improvements, Property 5: Empty branches produce empty HTML', () => {
      const node = makeCommitNode([]);
      const html = provider._getBranchLabelsHtml(node);
      assert.strictEqual(html, '', 'HTML should be empty for node with no branches');
    });
  });

  describe('Property 6: Branch label local/remote classification is type-driven', () => {
    /**
     * Bug E regression guard. For any LOCAL branch ref — INCLUDING names that
     * contain a '/' like `feature/foo` — the rendered HTML must use the local
     * affordances (branch-label-local + codicon-git-branch + "Local branch:")
     * and must NOT use the remote ones. The old `name.includes('/')` heuristic
     * would have failed this for slash-containing local names.
     */
    it('Feature: git-graph-visual-improvements, Property 6: local branch refs render local affordances regardless of slashes', () => {
      fc.assert(
        fc.property(arbitraryLocalBranchRef(), (ref) => {
          const node = makeCommitNode([ref]);
          const html = provider._getBranchLabelsHtml(node);

          assert.ok(
            html.includes('branch-label-local'),
            `Local ref "${ref.name}" should render branch-label-local. HTML: "${html}"`
          );
          assert.ok(
            html.includes('codicon-git-branch'),
            `Local ref "${ref.name}" should render codicon-git-branch. HTML: "${html}"`
          );
          assert.ok(
            !html.includes('branch-label-remote'),
            `Local ref "${ref.name}" should NOT render branch-label-remote. HTML: "${html}"`
          );
          assert.ok(
            !html.includes('codicon-cloud'),
            `Local ref "${ref.name}" should NOT render codicon-cloud. HTML: "${html}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * For any REMOTE branch ref, the rendered HTML must use the remote
     * CSS class + "Remote branch:" aria-label, AND the same
     * codicon-git-branch icon as local chips (per UX request to drop
     * the cloud-vs-branch distinction; ref kind still discoverable via
     * the CSS class and aria-label).
     */
    it('Feature: git-graph-visual-improvements, Property 6: remote branch refs render remote affordances', () => {
      fc.assert(
        fc.property(arbitraryRemoteBranchRef(), (ref) => {
          const node = makeCommitNode([ref]);
          const html = provider._getBranchLabelsHtml(node);

          assert.ok(
            html.includes('branch-label-remote'),
            `Remote ref "${ref.name}" should render branch-label-remote. HTML: "${html}"`
          );
          assert.ok(
            html.includes('codicon-git-branch'),
            `Remote ref "${ref.name}" should render codicon-git-branch (unified with local). HTML: "${html}"`
          );
          assert.ok(
            !html.includes('codicon-cloud'),
            `Remote ref "${ref.name}" should NOT render codicon-cloud (icon was unified with local). HTML: "${html}"`
          );
          assert.ok(
            !html.includes('branch-label-local'),
            `Remote ref "${ref.name}" should NOT render branch-label-local. HTML: "${html}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     *
     * For any commit node with a mix of local and remote branch refs,
     * the rendered HTML should have the correct number of local and remote
     * labels — counted by the typed classification, not the name shape.
     */
    it('Feature: git-graph-visual-improvements, Property 6: Mixed branches get correct local/remote label counts', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.uniqueArray(arbitraryLocalBranchRef(), {
              minLength: 1,
              maxLength: 4,
              selector: (ref) => ref.name,
            }),
            fc.uniqueArray(arbitraryRemoteBranchRef(), {
              minLength: 1,
              maxLength: 4,
              selector: (ref) => ref.name,
            })
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
