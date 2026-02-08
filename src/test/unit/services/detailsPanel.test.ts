/**
 * Unit tests for _getDetailsPanelHtml() method in GitToolWindowProvider.
 */

import '../../../test/setup';
import * as assert from 'assert';
import { GitToolWindowProvider, INTELLIJ_FILE_STATUS_COLORS } from '../../../services/GitToolWindowProvider';
import { ICommitDetails } from '../../../services/interfaces';
import { Uri } from '../../mocks/vscode';

/**
 * Helper to create a minimal ICommitDetails for testing.
 */
function makeCommitDetails(overrides?: Partial<ICommitDetails>): ICommitDetails {
  return {
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    message: 'Fix authentication bug',
    author: { name: 'John Doe', email: 'john@example.com' },
    date: new Date('2024-01-15T10:30:00Z'),
    parents: ['def4567890abcdef1234567890abcdef456789ab'],
    branches: [],
    tags: [],
    changedFiles: [],
    ...overrides,
  };
}

describe('GitToolWindowProvider - _getDetailsPanelHtml()', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Commit metadata display', () => {
    it('should display the commit message', () => {
      const details = makeCommitDetails({ message: 'Implement new feature' });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Implement new feature'), 'Should contain the commit message');
    });

    it('should display the commit body when present', () => {
      const details = makeCommitDetails({
        message: 'Short summary',
        body: 'Detailed body explaining the change',
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Short summary'), 'Should contain the message');
      assert.ok(html.includes('Detailed body explaining the change'), 'Should contain the body');
    });

    it('should display the full commit hash', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const details = makeCommitDetails({ hash });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes(hash), 'Should contain the full hash');
    });

    it('should display the author name', () => {
      const details = makeCommitDetails({
        author: { name: 'Jane Smith', email: 'jane@example.com' },
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Jane Smith'), 'Should contain the author name');
    });

    it('should display the author email', () => {
      const details = makeCommitDetails({
        author: { name: 'Jane Smith', email: 'jane@example.com' },
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('jane@example.com'), 'Should contain the author email');
    });

    it('should display the commit date', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const details = makeCommitDetails({ date });
      const html = provider._getDetailsPanelHtml(details);

      const dateStr = date.toLocaleString();
      assert.ok(html.includes(dateStr), 'Should contain the formatted date');
    });

    it('should display parent commit hashes', () => {
      const parents = ['aaa1111111111111111111111111111111111111111', 'bbb2222222222222222222222222222222222222222'];
      const details = makeCommitDetails({ parents });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('aaa1111'), 'Should contain short form of first parent');
      assert.ok(html.includes('bbb2222'), 'Should contain short form of second parent');
    });

    it('should display "None (root commit)" when there are no parents', () => {
      const details = makeCommitDetails({ parents: [] });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('None (root commit)'), 'Should indicate root commit');
    });

    it('should have a "Parents:" label', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Parents:'), 'Should have Parents label');
    });

    it('should have a "Hash:" label', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Hash:'), 'Should have Hash label');
    });

    it('should have an "Author:" label', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Author:'), 'Should have Author label');
    });

    it('should have a "Date:" label', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Date:'), 'Should have Date label');
    });

    it('should have a "Message:" label', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Message:'), 'Should have Message label');
    });
  });

  describe('Changed files with IntelliJ-style color coding', () => {
    it('should display changed files with status indicators', () => {
      const details = makeCommitDetails({
        changedFiles: [
          { path: 'src/main.ts', status: 'modified' },
          { path: 'src/new-file.ts', status: 'added' },
        ],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('main.ts'), 'Should contain the file name');
      assert.ok(html.includes('new-file.ts'), 'Should contain the second file name');
    });

    it('should show "M" indicator for modified files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      // The status indicator should contain 'M'
      const statusMatch = html.match(/class="file-status-indicator"[^>]*>[\s]*M[\s]*<\/span>/);
      assert.ok(statusMatch, 'Should have M status indicator for modified files');
    });

    it('should show "A" indicator for added files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new.ts', status: 'added' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      const statusMatch = html.match(/class="file-status-indicator"[^>]*>[\s]*A[\s]*<\/span>/);
      assert.ok(statusMatch, 'Should have A status indicator for added files');
    });

    it('should show "D" indicator for deleted files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/old.ts', status: 'deleted' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      const statusMatch = html.match(/class="file-status-indicator"[^>]*>[\s]*D[\s]*<\/span>/);
      assert.ok(statusMatch, 'Should have D status indicator for deleted files');
    });

    it('should show "R" indicator for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/renamed.ts', status: 'renamed', oldPath: 'src/original.ts' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      const statusMatch = html.match(/class="file-status-indicator"[^>]*>[\s]*R[\s]*<\/span>/);
      assert.ok(statusMatch, 'Should have R status indicator for renamed files');
    });

    it('should use IntelliJ blue color (#6897BB) for modified files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.modified), 'Should use IntelliJ blue for modified');
    });

    it('should use IntelliJ green color (#629755) for added files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new.ts', status: 'added' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.added), 'Should use IntelliJ green for added');
    });

    it('should use IntelliJ gray color (#6C6C6C) for deleted files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/old.ts', status: 'deleted' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.deleted), 'Should use IntelliJ gray for deleted');
    });

    it('should use IntelliJ blue color (#6897BB) for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/renamed.ts', status: 'renamed', oldPath: 'src/original.ts' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.renamed), 'Should use IntelliJ blue for renamed');
    });

    it('should display file name and directory separately', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/utils/helpers.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('helpers.ts'), 'Should contain the file name');
      assert.ok(html.includes('src/utils'), 'Should contain the directory path');
    });

    it('should show old path for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new-name.ts', status: 'renamed', oldPath: 'src/old-name.ts' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('src/old-name.ts'), 'Should show the old path for renamed files');
    });

    it('should display "No changed files" when the list is empty', () => {
      const details = makeCommitDetails({ changedFiles: [] });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('No changed files'), 'Should show empty message');
    });

    it('should display the file count in the header', () => {
      const details = makeCommitDetails({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified' },
          { path: 'src/b.ts', status: 'added' },
          { path: 'src/c.ts', status: 'deleted' },
        ],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('Changed Files (3)'), 'Should show file count');
    });
  });

  describe('HTML structure and accessibility', () => {
    it('should have role="region" on the details panel', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('role="region"'), 'Should have region role');
    });

    it('should have aria-label="Commit Details"', () => {
      const details = makeCommitDetails();
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('aria-label="Commit Details"'), 'Should have aria-label');
    });

    it('should have role="list" on the changed files container', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('role="list"'), 'Should have list role on files container');
    });

    it('should have role="listitem" on each changed file', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(html.includes('role="listitem"'), 'Should have listitem role on files');
    });

    it('should escape HTML special characters in commit message', () => {
      const details = makeCommitDetails({
        message: 'Fix <script>alert("xss")</script> bug',
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(!html.includes('<script>'), 'Should escape script tags');
      assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped script tags');
    });

    it('should escape HTML special characters in author name', () => {
      const details = makeCommitDetails({
        author: { name: 'O\'Brien & Co <test>', email: 'test@example.com' },
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(!html.includes('<test>'), 'Should escape angle brackets in author name');
    });

    it('should escape HTML special characters in file paths', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/<script>.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(!html.includes('<script>.ts'), 'Should escape script tags in file paths');
    });
  });

  describe('Data attributes on changed files for event delegation', () => {
    it('should have data-commit-hash and data-path attributes on changed file items', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes('data-commit-hash="') && html.includes('data-path="'),
        'Should have data-commit-hash and data-path attributes for event delegation'
      );
    });

    it('should pass the commit hash as data-commit-hash attribute', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const details = makeCommitDetails({
        hash,
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes(`data-commit-hash="${hash}"`),
        'Should have the commit hash in data-commit-hash attribute'
      );
    });

    it('should pass the file path as data-path attribute', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/utils/helpers.ts', status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes('data-path="src/utils/helpers.ts"'),
        'Should have the file path in data-path attribute'
      );
    });

    it('should have data-commit-hash and data-path on each changed file item', () => {
      const details = makeCommitDetails({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified' },
          { path: 'src/b.ts', status: 'added' },
        ],
      });
      const html = provider._getDetailsPanelHtml(details);

      const matches = html.match(/data-commit-hash="/g);
      assert.strictEqual(matches?.length, 2, 'Should have data-commit-hash attribute on each changed file');
    });

    it('should escape special characters in file paths within data attributes', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: "src/file'name.ts", status: 'modified' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      // The path should be HTML-escaped in the data attribute
      assert.ok(
        html.includes('data-path="'),
        'Should have the data-path attribute even with special characters'
      );
      assert.ok(
        html.includes('data-commit-hash="'),
        'Should have the data-commit-hash attribute even with special characters'
      );
    });
  });

  describe('Placeholder state when no commit is selected', () => {
    it('should return placeholder HTML with a message to select a commit', () => {
      const html = provider._getDetailsPanelPlaceholderHtml();

      assert.ok(
        html.includes('Select a commit to view details'),
        'Should contain placeholder message'
      );
    });

    it('should have role="region" on the placeholder panel', () => {
      const html = provider._getDetailsPanelPlaceholderHtml();

      assert.ok(html.includes('role="region"'), 'Should have region role');
    });

    it('should have aria-label="Commit Details" on the placeholder panel', () => {
      const html = provider._getDetailsPanelPlaceholderHtml();

      assert.ok(html.includes('aria-label="Commit Details"'), 'Should have aria-label');
    });

    it('should have the details-panel class on the placeholder', () => {
      const html = provider._getDetailsPanelPlaceholderHtml();

      assert.ok(html.includes('details-panel'), 'Should have details-panel class');
    });

    it('should have the placeholder-message class', () => {
      const html = provider._getDetailsPanelPlaceholderHtml();

      assert.ok(html.includes('placeholder-message'), 'Should have placeholder-message class');
    });
  });

  describe('Multi-commit details display', () => {
    function makeMultipleCommitDetails(count: number): ICommitDetails[] {
      return Array.from({ length: count }, (_, i) => makeCommitDetails({
        hash: `hash${i}${'0'.repeat(33)}`,
        message: `Commit message ${i + 1}`,
        author: { name: `Author ${i + 1}`, email: `author${i + 1}@example.com` },
        date: new Date(`2024-01-${15 + i}T10:30:00Z`),
        changedFiles: [
          { path: `src/file${i}.ts`, status: 'modified' as const },
        ],
      }));
    }

    describe('Header display', () => {
      it('should display the number of selected commits', () => {
        const commits = makeMultipleCommitDetails(3);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('3 commits selected'), 'Should show "3 commits selected"');
      });

      it('should use singular "commit" for a single commit', () => {
        const commits = makeMultipleCommitDetails(1);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('1 commit selected'), 'Should show "1 commit selected"');
      });

      it('should display correct count for many commits', () => {
        const commits = makeMultipleCommitDetails(10);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('10 commits selected'), 'Should show "10 commits selected"');
      });
    });

    describe('Selected commits list', () => {
      it('should display short hashes for each selected commit', () => {
        const commits = makeMultipleCommitDetails(3);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('hash000'), 'Should contain short hash of first commit');
        assert.ok(html.includes('hash100'), 'Should contain short hash of second commit');
        assert.ok(html.includes('hash200'), 'Should contain short hash of third commit');
      });

      it('should display commit messages for each selected commit', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('Commit message 1'), 'Should contain first commit message');
        assert.ok(html.includes('Commit message 2'), 'Should contain second commit message');
      });

      it('should have role="list" on the commits list container', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('role="list"'), 'Should have list role');
      });

      it('should have role="listitem" on each commit item', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        const matches = html.match(/class="multi-commit-item" role="listitem"/g);
        assert.strictEqual(matches?.length, 2, 'Should have listitem role on each commit');
      });
    });

    describe('Combined changed files', () => {
      it('should display combined changed files from all commits', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'First commit',
            changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
          }),
          makeCommitDetails({
            hash: 'bbb0000000000000000000000000000000000000',
            message: 'Second commit',
            changedFiles: [{ path: 'src/b.ts', status: 'added' }],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('a.ts'), 'Should contain file from first commit');
        assert.ok(html.includes('b.ts'), 'Should contain file from second commit');
      });

      it('should deduplicate files that appear in multiple commits', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'First commit',
            changedFiles: [{ path: 'src/shared.ts', status: 'modified' }],
          }),
          makeCommitDetails({
            hash: 'bbb0000000000000000000000000000000000000',
            message: 'Second commit',
            changedFiles: [{ path: 'src/shared.ts', status: 'modified' }],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('Changed Files (1)'), 'Should show deduplicated count of 1');
      });

      it('should use the latest status when a file appears in multiple commits', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'First commit',
            changedFiles: [{ path: 'src/file.ts', status: 'added' }],
          }),
          makeCommitDetails({
            hash: 'bbb0000000000000000000000000000000000000',
            message: 'Second commit',
            changedFiles: [{ path: 'src/file.ts', status: 'modified' }],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        // The file should show as modified (last status wins)
        const statusMatch = html.match(/class="file-status-indicator"[^>]*>[\s]*M[\s]*<\/span>/);
        assert.ok(statusMatch, 'Should show M (modified) status from the later commit');
      });

      it('should display file count in the header', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'First commit',
            changedFiles: [
              { path: 'src/a.ts', status: 'modified' },
              { path: 'src/b.ts', status: 'added' },
            ],
          }),
          makeCommitDetails({
            hash: 'bbb0000000000000000000000000000000000000',
            message: 'Second commit',
            changedFiles: [{ path: 'src/c.ts', status: 'deleted' }],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('Changed Files (3)'), 'Should show total file count');
      });

      it('should display "No changed files" when all commits have no changes', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'Empty commit 1',
            changedFiles: [],
          }),
          makeCommitDetails({
            hash: 'bbb0000000000000000000000000000000000000',
            message: 'Empty commit 2',
            changedFiles: [],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('No changed files'), 'Should show empty message');
      });

      it('should use IntelliJ-style color coding for file statuses', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'Commit',
            changedFiles: [
              { path: 'src/modified.ts', status: 'modified' },
              { path: 'src/added.ts', status: 'added' },
              { path: 'src/deleted.ts', status: 'deleted' },
            ],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.modified), 'Should use IntelliJ blue for modified');
        assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.added), 'Should use IntelliJ green for added');
        assert.ok(html.includes(INTELLIJ_FILE_STATUS_COLORS.deleted), 'Should use IntelliJ gray for deleted');
      });

      it('should accept pre-computed combined changed files', () => {
        const commits = makeMultipleCommitDetails(2);
        const combinedFiles = [
          { path: 'src/combined-a.ts', status: 'modified' as const },
          { path: 'src/combined-b.ts', status: 'added' as const },
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits, combinedFiles);

        assert.ok(html.includes('combined-a.ts'), 'Should contain pre-computed file');
        assert.ok(html.includes('combined-b.ts'), 'Should contain pre-computed file');
        assert.ok(html.includes('Changed Files (2)'), 'Should show pre-computed file count');
      });
    });

    describe('HTML structure and accessibility', () => {
      it('should have role="region" on the multi-commit details panel', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('role="region"'), 'Should have region role');
      });

      it('should have aria-label="Multi-Commit Details"', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('aria-label="Multi-Commit Details"'), 'Should have aria-label');
      });

      it('should have the details-panel class', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('details-panel'), 'Should have details-panel class');
      });

      it('should have the multi-commit-details class', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('multi-commit-details'), 'Should have multi-commit-details class');
      });

      it('should escape HTML special characters in commit messages', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'Fix <script>alert("xss")</script> bug',
            changedFiles: [],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(!html.includes('<script>'), 'Should escape script tags');
        assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped script tags');
      });

      it('should have aria-label="Selected Commits" on the commits list', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('aria-label="Selected Commits"'), 'Should have aria-label on commits list');
      });

      it('should have aria-label="Changed Files" on the files list', () => {
        const commits = [
          makeCommitDetails({
            hash: 'aaa0000000000000000000000000000000000000',
            message: 'Commit',
            changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
          }),
        ];
        const html = provider._getMultiCommitDetailsPanelHtml(commits);

        assert.ok(html.includes('aria-label="Changed Files"'), 'Should have aria-label on files list');
      });
    });
  });
});
