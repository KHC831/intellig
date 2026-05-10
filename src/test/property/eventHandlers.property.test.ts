/**
 * Property-based tests for commit event handlers.
 *
 * Feature: intellig-ui-fixes, Property 6: Commit rows have data-hash attribute for event delegation
 *
 * Uses fast-check to verify that:
 * - For any commit row rendered in the Graph Panel HTML, the row element has a data-hash
 *   attribute with the commit hash, enabling event delegation for click and context menu
 *   handlers.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { ICommitNode, IGraphLine } from '../../utils/commitGraph';
import { ICommit, IAuthor } from '../../services/interfaces/IGitService';
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
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split(
          ''
        )
      ),
      { minLength: 1, maxLength: 80 }
    )
    .filter((s) => s.trim().length > 0);
}

/**
 * Generate a Date within the last year.
 */
function arbitraryRecentDate(): fc.Arbitrary<Date> {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 3600 * 1000;
  return fc.integer({ min: 1000, max: oneYearMs }).map((ms) => new Date(now - ms));
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
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
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

/**
 * Generate a list of 1-5 commit nodes with unique hashes.
 */
function arbitraryCommitNodes(): fc.Arbitrary<ICommitNode[]> {
  return fc
    .array(arbitraryFullHash(), { minLength: 1, maxLength: 5 })
    .filter((hashes) => new Set(hashes).size === hashes.length)
    .chain((hashes) => {
      const nodeArbs = hashes.map((hash) => arbitraryCommitNode(hash));
      return fc
        .tuple(...(nodeArbs as [fc.Arbitrary<ICommitNode>, ...fc.Arbitrary<ICommitNode>[]]))
        .map((nodes) => nodes as unknown as ICommitNode[]);
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

  describe('Property 6: Commit rows have data-hash attribute for event delegation', () => {
    /**
     *
     * For any commit row rendered in the Graph Panel HTML, the row element shall
     * have a data-hash attribute with the commit hash, enabling event delegation
     * for click and context menu handlers.
     */
    it('Feature: intellig-ui-fixes, Property 6: Commit rows have click and context menu handlers — each commit row has correct data-hash attribute', () => {
      fc.assert(
        fc.property(arbitraryCommitNodes(), (commitNodes) => {
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
        }),
        { numRuns: 100 }
      );
    });
  });
});
