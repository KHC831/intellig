import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { ICommitDetails } from '../../services/interfaces';
import { Uri } from '../mocks/vscode';

/**
 * Property-based tests for Full Message Display in the Details Panel.
 * Feature: git-graph-details-improvements, Property 4: Details panel shows full commit message with body
 *
 * Property Description:
 * For any commit details with a non-empty message and body, the HTML output of
 * _getDetailsPanelHtml() SHALL contain both the message text and the body text
 * within the commit-full-message pre element.
 */
describe('Full Message Display Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Arbitrary generator for safe strings (alphanumeric + spaces + basic punctuation).
   * Avoids angle brackets and ampersands since _getDetailsPanelHtml HTML-escapes them.
   */
  const safeStringArb = (minLen: number, maxLen: number): fc.Arbitrary<string> =>
    fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()'.split('')
      ),
      { minLength: minLen, maxLength: maxLen }
    ).filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for 40-character hex commit hashes.
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for ICommitDetails with both a non-empty message AND a non-empty body.
   */
  const commitDetailsWithBodyArb: fc.Arbitrary<ICommitDetails> = fc
    .tuple(
      commitHashArb,
      safeStringArb(1, 80),
      safeStringArb(1, 200),
      safeStringArb(1, 30),
      safeStringArb(5, 30),
      fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }),
      fc.array(commitHashArb, { minLength: 0, maxLength: 2 })
    )
    .map(([hash, message, body, authorName, authorEmail, date, parents]) => ({
      hash,
      message,
      body,
      author: { name: authorName, email: authorEmail + '@test.com' },
      date,
      parents,
      branches: [],
      tags: [],
      changedFiles: [],
    }));

  describe('Property 4: Details panel shows full commit message with body', () => {
    /**
     * Property: For any commit details with a non-empty message and body,
     * the HTML output contains both the message and body text within the
     * commit-full-message pre element.
     */
    it('Property: HTML contains both message and body in commit-full-message element', () => {
      fc.assert(
        fc.property(commitDetailsWithBodyArb, (commitDetails) => {
          const html = provider._getDetailsPanelHtml(commitDetails);

          // The HTML should contain the message text
          assert.ok(
            html.includes(commitDetails.message),
            `HTML should contain the message text: "${commitDetails.message}"`
          );

          // The HTML should contain the body text
          assert.ok(
            html.includes(commitDetails.body!),
            `HTML should contain the body text: "${commitDetails.body}"`
          );

          // Both should appear within the commit-full-message pre element
          const preMatch = html.match(/<pre[^>]*class="[^"]*commit-full-message[^"]*"[^>]*>([\s\S]*?)<\/pre>/);
          assert.ok(
            preMatch !== null,
            'HTML should contain a pre element with class commit-full-message'
          );

          const preContent = preMatch![1];

          assert.ok(
            preContent.includes(commitDetails.message),
            `commit-full-message pre element should contain the message: "${commitDetails.message}"`
          );

          assert.ok(
            preContent.includes(commitDetails.body!),
            `commit-full-message pre element should contain the body: "${commitDetails.body}"`
          );

          // The body should appear after the message, separated by two newlines
          const messageIndex = preContent.indexOf(commitDetails.message);
          // Search for the body starting after the message to handle cases where
          // the body is a substring of the message (e.g., body="u", message="ua")
          const bodyIndex = preContent.indexOf(commitDetails.body!, messageIndex + commitDetails.message.length);
          assert.ok(
            bodyIndex > messageIndex,
            `Body (index ${bodyIndex}) should appear after message (index ${messageIndex}) in the pre element`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
