import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommitDetails, IChangedFile } from '../../src/services/interfaces';
import { Uri } from '../mocks/vscode';
import { FileStatus } from '../../src/git-core/interfaces/IGitService';

/**
 * Property-based tests for Details Panel Section Ordering.
 * Feature: git-graph-details-improvements, Property 6: Changed files section appears before metadata
 *
 * Property Description:
 * For any commit details, in the HTML output of _getDetailsPanelHtml(),
 * the `details-changed-files` section SHALL appear before the `details-metadata`
 * section (i.e., its position index in the HTML string is lower).
 */
describe('Details Panel Section Ordering Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Arbitrary generator for safe strings (alphanumeric + basic punctuation).
   */
  const safeStringArb = (minLen: number, maxLen: number): fc.Arbitrary<string> =>
    fc
      .stringOf(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'.split('')
        ),
        { minLength: minLen, maxLength: maxLen }
      )
      .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for 40-character hex commit hashes.
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for file statuses.
   */
  const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
    'modified' as FileStatus,
    'added' as FileStatus,
    'deleted' as FileStatus,
    'renamed' as FileStatus
  );

  /**
   * Arbitrary generator for file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_/'.split('')), {
      minLength: 3,
      maxLength: 30,
    })
    .filter(
      (s) => !s.startsWith('/') && !s.endsWith('/') && !s.includes('//') && s.trim().length > 0
    )
    .map((s) => (s.includes('/') ? s : 'src/' + s) + '.ts');

  /**
   * Arbitrary generator for changed files.
   */
  const changedFileArb: fc.Arbitrary<IChangedFile> = fc.record({
    path: filePathArb,
    status: fileStatusArb,
  });

  /**
   * Arbitrary generator for ICommitDetails with varying numbers of changed files.
   */
  const commitDetailsArb: fc.Arbitrary<ICommitDetails> = fc
    .tuple(
      commitHashArb,
      safeStringArb(1, 80),
      fc.option(safeStringArb(1, 200), { nil: undefined }),
      safeStringArb(1, 30),
      safeStringArb(5, 30),
      fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }),
      fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
      fc.array(changedFileArb, { minLength: 0, maxLength: 10 })
    )
    .map(([hash, message, body, authorName, authorEmail, date, parents, changedFiles]) => ({
      hash,
      message,
      body,
      author: { name: authorName, email: authorEmail + '@test.com' },
      date,
      parents,
      branches: [],
      tags: [],
      changedFiles,
    }));

  describe('Property 6: Changed files section appears before metadata', () => {
    /**
     * Property: The details-changed-files section appears before the details-metadata
     * section in the HTML output for any commit details.
     */
    it('Property: details-changed-files section appears before details-metadata section', () => {
      fc.assert(
        fc.property(commitDetailsArb, (commitDetails) => {
          const html = provider._getDetailsPanelHtml(commitDetails);

          const changedFilesIndex = html.indexOf('details-changed-files');
          const metadataIndex = html.indexOf('details-metadata');

          // Both sections must be present
          assert.ok(
            changedFilesIndex !== -1,
            'details-changed-files section should be present in the HTML'
          );
          assert.ok(metadataIndex !== -1, 'details-metadata section should be present in the HTML');

          // Changed files section must appear before metadata section
          assert.ok(
            changedFilesIndex < metadataIndex,
            `details-changed-files (index ${changedFilesIndex}) should appear before details-metadata (index ${metadataIndex})`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
