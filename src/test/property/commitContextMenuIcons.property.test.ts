/**
 * Property-based tests for commit context menu icon removal.
 *
 * Feature: git-graph-context-menu
 *
 * Uses fast-check to verify that the commit context menu HTML output
 * never contains icon elements or emoji characters within menu items.
 *
 * Properties tested:
 *   1 — No icons in menu output
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
 * Generate a short commit hash (7 hex characters).
 */
function arbitraryShortHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 7,
    maxLength: 7,
  });
}

/**
 * Generate a non-empty author name.
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
 * Generate a commit message.
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?'.split('')
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
function arbitraryCommit(): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: arbitraryFullHash(),
    shortHash: arbitraryShortHash(),
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
 * Generate a valid ICommitNode.
 */
function arbitraryCommitNode(): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-_/'.split('')), {
        minLength: 1,
        maxLength: 15,
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

// ─── Emoji detection ──────────────────────────────────────────────────────────

/**
 * Regex that matches common emoji characters.
 * Covers emoji presentation sequences, modifier bases, and supplemental symbols.
 */
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/u;

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Commit Context Menu Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  // Feature: git-graph-context-menu, Property 1: No icons in menu output
  describe('Property 1: No icons in menu output', () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * For any call to _getCommitContextMenuHtml(), the returned HTML string
     * should contain zero elements with the class context-menu-icon and zero
     * emoji characters within menu item elements.
     */
    it('should never contain context-menu-icon elements or emoji characters in menu items', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryCommitNode(), { minLength: 0, maxLength: 10 }),
          (commitNodes) => {
            // Set up the provider with the generated commit nodes
            if (commitNodes.length > 0) {
              const commits = commitNodes.map((n) => n.commit);
              provider.updateLogState(commits);
            }

            const html = provider._getCommitContextMenuHtml();

            // 1. No context-menu-icon class should appear anywhere in the output
            assert.ok(
              !html.includes('context-menu-icon'),
              'Menu HTML should not contain any context-menu-icon class'
            );

            // 2. Extract text content of menu items and check for emoji characters
            const menuItemRegex = /class="context-menu-item[^"]*"[^>]*>([^<]+)</g;
            let match: RegExpExecArray | null;
            while ((match = menuItemRegex.exec(html)) !== null) {
              const itemText = match[1];
              assert.ok(
                !EMOJI_REGEX.test(itemText),
                `Menu item text "${itemText.trim()}" should not contain emoji characters`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
