/**
 * Property-based tests for no commit hash displayed in graph rows.
 *
 * Feature: git-graph-details-improvements
 * Property 2: No commit hash displayed in graph rows
 *
 * Uses fast-check to verify that the HTML output of _getGraphPanelHtml()
 * does NOT contain any element with class `commit-hash`, while still
 * retaining the `data-hash` attribute for functionality.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../ui-shell/GitToolWindowProvider';
import { ICommitNode, IGraphLine } from '../../git-core/commitGraph';
import { ICommit, IAuthor } from '../../git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 40,
    maxLength: 40,
  });
}

/**
 * Generate a short commit hash (7 hex characters).
 */
function arbitraryShortHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 7,
    maxLength: 7,
  });
}

/**
 * Generate a non-empty author name using safe characters.
 */
function arbitraryAuthorName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => s.trim().length > 0);
}

/**
 * Generate a valid email address.
 */
function arbitraryEmail(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.constantFrom('com', 'org', 'net', 'io')
    )
    .map(([user, domain, tld]) => `${user}@${domain}.${tld}`);
}

/**
 * Generate an IAuthor with valid name and email.
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
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()'.split('')
      ),
      { minLength: 1, maxLength: 80 }
    )
    .filter((s) => s.trim().length > 0);
}

/**
 * Generate a Date within a reasonable range.
 */
function arbitraryDate(): fc.Arbitrary<Date> {
  return fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') });
}

/**
 * Generate a valid ICommit object.
 */
function arbitraryCommit(): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: arbitraryFullHash(),
    shortHash: arbitraryShortHash(),
    message: arbitraryCommitMessage(),
    author: arbitraryAuthor(),
    committer: arbitraryAuthor(),
    parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
    authorDate: arbitraryDate(),
    commitDate: arbitraryDate(),
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
 * Generate a valid ICommitNode.
 */
function arbitraryCommitNode(): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.array(
      fc
        .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-_/'.split('')), {
          minLength: 1,
          maxLength: 15,
        })
        .map((name) => ({ name, type: name.includes('/') ? 'remote' : 'local' }) as const),
      { minLength: 0, maxLength: 2 }
    ),
    tags: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
      { minLength: 0, maxLength: 2 }
    ),
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-details-improvements - No Hash in Graph Rows Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 2: No commit hash displayed in graph rows', () => {
    /**
     *
     * For any set of commit nodes, the HTML output of _getGraphPanelHtml()
     * SHALL NOT contain any element with class `commit-hash`.
     * The `data-hash` attribute SHALL still be present for functionality.
     */
    it('Feature: git-graph-details-improvements, Property 2: No commit hash displayed in graph rows — HTML does not contain commit-hash class but retains data-hash attribute', () => {
      fc.assert(
        fc.property(fc.array(arbitraryCommitNode(), { minLength: 1, maxLength: 10 }), (nodes) => {
          const html = provider._getGraphPanelHtml(nodes);

          // The commit-hash CSS class should NOT appear in the output
          assert.ok(
            !html.includes('commit-hash'),
            'HTML output should NOT contain the "commit-hash" class — hash should be hidden from graph rows'
          );

          // The data-hash attribute SHOULD still be present for each commit node
          for (const node of nodes) {
            assert.ok(
              html.includes(`data-hash="${node.commit.hash}"`),
              `HTML output should contain data-hash="${node.commit.hash}" for functionality`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
