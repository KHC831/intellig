/**
 * Property-based tests for Details Panel rendering.
 *
 * Feature: intellig-layout
 *
 * Uses fast-check to verify universal correctness properties of the
 * Details Panel HTML generation in GitToolWindowProvider._getDetailsPanelHtml().
 *
 * Properties tested:
 *   9 — Details panel contains commit metadata and changed files
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { ICommitDetails, IChangedFile } from '../../services/interfaces';
import { FileStatus } from '../../services/interfaces/IGitService';
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
 * Generate a non-empty author name using safe characters (no HTML special chars).
 * The name must be non-empty after trimming.
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
 * Generate a valid email address using safe characters.
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
 * Generate a commit message using safe characters (no HTML special chars).
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split(
          ''
        )
      ),
      { minLength: 1, maxLength: 100 }
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
 * Generate a FileStatus value from the set of valid statuses.
 */
function arbitraryFileStatus(): fc.Arbitrary<FileStatus> {
  return fc.constantFrom<FileStatus>(
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'untracked',
    'ignored',
    'conflicted'
  );
}

/**
 * Generate a file path using safe characters (no HTML special chars).
 * Paths have 1-3 directory segments and a filename with extension.
 */
function arbitraryFilePath(): fc.Arbitrary<string> {
  const segment = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 1, maxLength: 12 }
  );
  const extension = fc.constantFrom('.ts', '.js', '.json', '.md', '.css', '.html');

  return fc
    .tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), segment, extension)
    .map(([dirs, name, ext]) => dirs.join('/') + '/' + name + ext);
}

/**
 * Generate a single IChangedFile with valid data.
 */
function arbitraryChangedFile(): fc.Arbitrary<IChangedFile> {
  return fc.record({
    path: arbitraryFilePath(),
    status: arbitraryFileStatus(),
  });
}

/**
 * Generate a non-empty list of changed files with unique paths.
 */
function arbitraryChangedFiles(): fc.Arbitrary<IChangedFile[]> {
  return fc
    .array(arbitraryChangedFile(), { minLength: 1, maxLength: 15 })
    .map((files) => {
      // Deduplicate by path
      const seen = new Set<string>();
      return files.filter((f) => {
        if (seen.has(f.path)) {
          return false;
        }
        seen.add(f.path);
        return true;
      });
    })
    .filter((files) => files.length > 0);
}

/**
 * Generate a valid ICommitDetails with a non-empty list of changed files.
 */
function arbitraryCommitDetails(): fc.Arbitrary<ICommitDetails> {
  return fc.record({
    hash: arbitraryFullHash(),
    message: arbitraryCommitMessage(),
    author: fc.record({
      name: arbitraryAuthorName(),
      email: arbitraryEmail(),
    }),
    date: arbitraryRecentDate(),
    parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
    branches: fc.constant([] as string[]),
    tags: fc.constant([] as string[]),
    changedFiles: arbitraryChangedFiles(),
  });
}

// ─── Status indicator mapping (mirrors GitToolWindowProvider._getFileStatusChar) ──

const STATUS_CHAR_MAP: Record<FileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  ignored: 'I',
  conflicted: '!',
};

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellig-layout - Details Panel Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 9: Details panel contains commit metadata and changed files', () => {
    /**
     *
     * For any commit with a non-empty list of changed files, the Details Panel
     * HTML SHALL contain the full commit hash, author name, author email,
     * commit date, commit message, and every changed file path with its status
     * indicator.
     */
    it('Feature: intellig-layout, Property 9: Details panel contains commit metadata and changed files — HTML contains full hash, author name, email, date, message, and all file paths with status indicators', () => {
      fc.assert(
        fc.property(arbitraryCommitDetails(), (commitDetails) => {
          const html = provider._getDetailsPanelHtml(commitDetails);

          // 1. Full commit hash must be present
          assert.ok(
            html.includes(commitDetails.hash),
            `HTML should contain the full commit hash "${commitDetails.hash}"`
          );

          // 2. Author name must be present
          assert.ok(
            html.includes(commitDetails.author.name),
            `HTML should contain the author name "${commitDetails.author.name}"`
          );

          // 3. Author email must be present
          assert.ok(
            html.includes(commitDetails.author.email),
            `HTML should contain the author email "${commitDetails.author.email}"`
          );

          // 4. Commit date must be present (formatted via toLocaleString)
          const dateStr = commitDetails.date.toLocaleString();
          assert.ok(html.includes(dateStr), `HTML should contain the commit date "${dateStr}"`);

          // 5. Commit message must be present
          assert.ok(
            html.includes(commitDetails.message),
            `HTML should contain the commit message "${commitDetails.message}"`
          );

          // 6. Every changed file path must be present with its status indicator
          for (const file of commitDetails.changedFiles) {
            // The file path should appear in the HTML (in data-path attribute or display)
            assert.ok(
              html.includes(file.path),
              `HTML should contain the changed file path "${file.path}"`
            );

            // The status indicator character should be present
            const expectedStatusChar = STATUS_CHAR_MAP[file.status];
            // Look for the status indicator pattern: class="file-status-indicator" ... >statusChar<
            const statusPattern = new RegExp(
              `class="file-status-indicator"[^>]*>[\\s]*${expectedStatusChar.replace(/[!]/g, '\\$&')}[\\s]*</`
            );
            assert.ok(
              statusPattern.test(html),
              `HTML should contain status indicator "${expectedStatusChar}" for file "${file.path}" with status "${file.status}"`
            );
          }
        }),
        { numRuns: 150 }
      );
    });
  });
});
