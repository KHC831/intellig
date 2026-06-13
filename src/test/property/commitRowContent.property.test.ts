/**
 * Property-based tests for commit row content display.
 *
 * Feature: git-graph-details-improvements
 * Property 3: Commit row displays title, author, and absolute date
 *
 * Uses fast-check to verify that the HTML output of _getGraphPanelHtml()
 * contains the commit message first line (or truncated version), the author
 * name, and the locale-aware absolute timestamp produced by formatCommitDate
 * — and does NOT contain relative date strings (e.g. "ago").
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../ui-shell/GitToolWindowProvider';
import { ICommitNode, IGraphLine } from '../../git-core/commitGraph';
import { ICommit, IAuthor } from '../../git-core/interfaces/IGitService';
import { formatCommitDate } from '../../utils/dateFormat';
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
 * Generate a non-empty author name using safe characters (alphanumeric + spaces only).
 * Avoids HTML-special characters to prevent escaping issues in assertions.
 */
function arbitraryAuthorName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '.split('')
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
 * Generate a commit message using safe characters (alphanumeric, spaces, basic punctuation).
 * Avoids HTML-special characters to prevent escaping issues in assertions.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test');
  return new GitToolWindowProvider(extensionUri);
}

/**
 * Compute the expected message summary for the row HTML.
 *
 * (E2-bonus): the row template no longer pre-truncates the
 * message — `.commit-title { overflow:hidden; text-overflow:ellipsis }`
 * does the responsive ellipsis, and the host emits the full first
 * line so screen readers and find-in-page see complete text. Property
 * 3 now asserts the FULL first line lands in the row HTML.
 */
function expectedMessageSummary(message: string): string {
  return message.split('\n')[0];
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-details-improvements - Commit Row Content Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 3: Commit row displays title, author, and absolute date', () => {
    /**
     *
     * For any commit with a non-empty message, author name, and author date,
     * the HTML output of _getGraphPanelHtml() SHALL contain:
     * - The first line of the commit message (or truncated version if > 60 chars)
     * - The author name
     * - The locale-aware absolute timestamp produced by formatCommitDate
     * - The output does NOT contain "ago" (which would indicate relative date format)
     */
    it('Feature: git-graph-details-improvements, Property 3: Commit row displays title, author, and absolute date — HTML contains message summary, author name, and absolute date', () => {
      fc.assert(
        fc.property(arbitraryCommitNode(), (node) => {
          const html = provider._getGraphPanelHtml([node]);
          const commit = node.commit;

          // 1. The output should contain the message summary (first line, possibly truncated)
          const messageSummary = expectedMessageSummary(commit.message);
          assert.ok(
            html.includes(messageSummary),
            `HTML output should contain the message summary "${messageSummary}" but got:\n${html.substring(0, 500)}`
          );

          // 2. The output should contain the author name
          assert.ok(
            html.includes(commit.author.name),
            `HTML output should contain the author name "${commit.author.name}"`
          );

          // 3. The output should contain the date label produced by
          //    `formatCommitDate` — a locale-aware absolute timestamp
          //    (date + time, no seconds). The label is HTML-escaped in
          //    the row; the "/" and ":" separators it produces are
          //    escape-safe, so a plain substring check holds.
          const { display: expectedDateLabel } = formatCommitDate(commit.authorDate);
          assert.ok(
            html.includes(expectedDateLabel),
            `HTML output should contain the date label "${expectedDateLabel}"`
          );

          // 4. The commit-date span content must EXACTLY equal the
          //    formatCommitDate label — the locale-aware absolute
          //    timestamp — never the legacy "YYYY-MM-DD H:MM AM/PM" or
          //    relative "3d"/"ago" forms.
          const dateSpanRegex = /<span class="commit-date"[^>]*>([^<]*)<\/span>/g;
          let match;
          while ((match = dateSpanRegex.exec(html)) !== null) {
            const dateContent = match[1];
            assert.ok(
              !dateContent.includes('ago'),
              `Commit date span should NOT contain relative "ago" suffix but found: "${dateContent}"`
            );
            assert.strictEqual(
              dateContent,
              expectedDateLabel,
              `Commit date span content must equal formatCommitDate label "${expectedDateLabel}"`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
