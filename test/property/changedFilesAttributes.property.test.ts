import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommitDetails, IChangedFile } from '../../src/services/interfaces';
import { Uri } from '../mocks/vscode';
import { renderDetailsPanelHtml } from '../helpers/detailsPanelDom';
import { FileStatus } from '../../src/git-core/interfaces/IGitService';

/**
 * Property-based tests for Changed Files Count and Data Attributes.
 * Feature: git-graph-details-improvements, Property 5: Changed files count and data attributes are correct
 *
 *
 * Property Description:
 * For any commit details with N changed files (N >= 0), the HTML output of
 * _getDetailsPanelHtml() SHALL contain the text `Changed Files (N)` with the
 * correct count, and each changed file item SHALL have both a `data-commit-hash`
 * attribute matching the commit hash and a `data-path` attribute matching the file path.
 */
describe('Changed Files Count and Attributes Property Tests', () => {
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
   * Arbitrary generator for safe file path segments (alphanumeric + - + _ + .).
   */
  const filePathSegmentArb: fc.Arbitrary<string> = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 1,
      maxLength: 15,
    })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for unique file paths using safe characters.
   * Generates paths like "src/foo/bar.ts" with no HTML-special characters.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.array(filePathSegmentArb, { minLength: 1, maxLength: 3 }),
      filePathSegmentArb,
      fc.constantFrom('.ts', '.js', '.py', '.md', '.txt')
    )
    .map(([dirs, name, ext]) => dirs.join('/') + '/' + name + ext);

  /**
   * Arbitrary generator for changed files.
   */
  const changedFileArb: fc.Arbitrary<IChangedFile> = fc.record({
    path: filePathArb,
    status: fileStatusArb,
  });

  /**
   * Arbitrary generator for arrays of changed files with unique paths.
   */
  const uniqueChangedFilesArb = (minLen: number, maxLen: number): fc.Arbitrary<IChangedFile[]> =>
    fc
      .array(changedFileArb, { minLength: maxLen + 5, maxLength: maxLen + 10 })
      .map((files) => {
        const seen = new Set<string>();
        const unique: IChangedFile[] = [];
        for (const f of files) {
          if (!seen.has(f.path)) {
            seen.add(f.path);
            unique.push(f);
          }
          if (unique.length >= maxLen) {
            break;
          }
        }
        return unique;
      })
      .filter((files) => files.length >= minLen);

  /**
   * Arbitrary generator for ICommitDetails with N changed files (0 to 10).
   */
  const commitDetailsWithFilesArb: fc.Arbitrary<ICommitDetails> = fc
    .tuple(
      commitHashArb,
      safeStringArb(1, 80),
      fc.option(safeStringArb(1, 200), { nil: undefined }),
      safeStringArb(1, 30),
      safeStringArb(5, 30),
      fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }),
      fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
      uniqueChangedFilesArb(0, 10)
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

  describe('Property 5: Changed files count and data attributes are correct', () => {
    /**
     * Property: The HTML output contains "Changed Files (N)" with the correct count N,
     * and each changed file has data-commit-hash and data-path attributes matching
     * the commit hash and file path respectively.
     */
    it('Property: changed files count text and data attributes match commit details', () => {
      fc.assert(
        fc.property(commitDetailsWithFilesArb, (commitDetails) => {
          const html = renderDetailsPanelHtml(provider._getDetailsPanelModel(commitDetails));
          const n = commitDetails.changedFiles.length;

          // Assert: HTML contains "Changed Files (N)" with the correct count
          const expectedCountText = `Changed Files (${n})`;
          assert.ok(
            html.includes(expectedCountText),
            `HTML should contain "${expectedCountText}" but it was not found`
          );

          // Assert: For each changed file, the HTML contains the correct data attributes
          for (const file of commitDetails.changedFiles) {
            const expectedDataCommitHash = `data-commit-hash="${commitDetails.hash}"`;
            assert.ok(
              html.includes(expectedDataCommitHash),
              `HTML should contain data-commit-hash="${commitDetails.hash}" for file "${file.path}"`
            );

            const expectedDataPath = `data-path="${file.path}"`;
            assert.ok(
              html.includes(expectedDataPath),
              `HTML should contain data-path="${file.path}" for file "${file.path}"`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
