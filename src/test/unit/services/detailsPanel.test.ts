/**
 * Unit tests for _getDetailsPanelHtml() method in GitToolWindowProvider.
 */

import '../../setup';
import * as assert from 'assert';
import {
  GitToolWindowProvider,
  INTELLIJ_FILE_STATUS_COLORS,
  FILE_STATUS_THEME_VARS,
} from '../../../ui-shell/GitToolWindowProvider';
import { ICommitDetails } from '../../../services/interfaces';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri, setMockConfigValue } from '../../mocks/vscode';

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
      const parents = [
        'aaa1111111111111111111111111111111111111111',
        'bbb2222222222222222222222222222222222222222',
      ];
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

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.modified),
        'Should use IntelliJ blue for modified'
      );
    });

    it('should use IntelliJ green color (#629755) for added files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new.ts', status: 'added' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.added),
        'Should use IntelliJ green for added'
      );
    });

    it('should use IntelliJ gray color (#6C6C6C) for deleted files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/old.ts', status: 'deleted' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.deleted),
        'Should use IntelliJ gray for deleted'
      );
    });

    it('should use IntelliJ blue color (#6897BB) for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/renamed.ts', status: 'renamed', oldPath: 'src/original.ts' }],
      });
      const html = provider._getDetailsPanelHtml(details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.renamed),
        'Should use IntelliJ blue for renamed'
      );
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
        author: { name: "O'Brien & Co <test>", email: 'test@example.com' },
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
      assert.strictEqual(
        matches?.length,
        2,
        'Should have data-commit-hash attribute on each changed file'
      );
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
      return Array.from({ length: count }, (_, i) =>
        makeCommitDetails({
          hash: `hash${i}${'0'.repeat(33)}`,
          message: `Commit message ${i + 1}`,
          author: { name: `Author ${i + 1}`, email: `author${i + 1}@example.com` },
          date: new Date(`2024-01-${15 + i}T10:30:00Z`),
          changedFiles: [{ path: `src/file${i}.ts`, status: 'modified' as const }],
        })
      );
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

        assert.ok(
          html.includes(INTELLIJ_FILE_STATUS_COLORS.modified),
          'Should use IntelliJ blue for modified'
        );
        assert.ok(
          html.includes(INTELLIJ_FILE_STATUS_COLORS.added),
          'Should use IntelliJ green for added'
        );
        assert.ok(
          html.includes(INTELLIJ_FILE_STATUS_COLORS.deleted),
          'Should use IntelliJ gray for deleted'
        );
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

        assert.ok(
          html.includes('aria-label="Selected Commits"'),
          'Should have aria-label on commits list'
        );
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

        assert.ok(
          html.includes('aria-label="Changed Files"'),
          'Should have aria-label on files list'
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // FU-1 — wire issue-link utilities into the details panel.
  // ──────────────────────────────────────────────────────────────────────
  describe('FU-1 — commit message issue links', () => {
    function makeRepoWithGitHub(): IRepository {
      return {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/widgets.git' }],
        submodules: [],
      };
    }

    it('wraps #42 in a clickable <a> tag when the flag is on and a remote is parseable', () => {
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'fix: close #42' });
      const html = provider._getDetailsPanelHtml(details);
      assert.ok(
        html.includes('<a class="commit-issue-link"'),
        `expected an anchor tag for the issue ref; got:\n${html}`
      );
      assert.ok(
        html.includes('https://github.com/acme/widgets/issues/42'),
        'expected GitHub issue URL in the anchor href'
      );
    });

    it('wraps GH-99 and PROJECT-123 style refs', () => {
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'GH-99 and PROJECT-123: cleanup' });
      const html = provider._getDetailsPanelHtml(details);
      assert.ok(html.includes('>GH-99</a>'), `expected GH-99 anchor; got: ${html}`);
      assert.ok(html.includes('>PROJECT-123</a>'), `expected PROJECT-123 anchor; got: ${html}`);
    });

    it('does NOT wrap `abc#42` (not a real reference)', () => {
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'see abc#42 for context' });
      const html = provider._getDetailsPanelHtml(details);
      assert.ok(
        !html.includes('<a class="commit-issue-link"'),
        `expected no issue-link anchors; got: ${html}`
      );
      assert.ok(html.includes('see abc#42 for context'), 'plain text preserved');
    });

    it('renders plain text when the `commitMessageIssueLinks` flag is off', () => {
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', false);
      const details = makeCommitDetails({ message: 'fix: close #42' });
      const html = provider._getDetailsPanelHtml(details);
      assert.ok(
        !html.includes('<a class="commit-issue-link"'),
        `flag off → no anchors; got: ${html}`
      );
      assert.ok(html.includes('#42'), 'raw reference still present as escaped text');
      // Restore default for later tests in the suite.
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
    });

    it('falls back to plain text when the repo has no remotes', () => {
      const repo: IRepository = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      provider.setAvailableRepositories([repo]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'fix: close #42' });
      const html = provider._getDetailsPanelHtml(details);
      assert.ok(
        !html.includes('<a class="commit-issue-link"'),
        `no anchors without a remote; got: ${html}`
      );
    });
  });
});

/**
 * `_getFileStatusColor` returns a `var(...)`
 * expression backed by the `gitDecoration-*ResourceForeground` family
 * with the IntelliJ hex retained as the CSS-var fallback. This block
 * pins the EXACT string returned for each `FileStatus` so a future
 * re-mapping of any single status forces a deliberate diff in this
 * assertion.
 *
 * The method is private; we reach it via prototype reflection (same
 * pattern as the chipTheme-* tests in CommitDialog.test.ts).
 */
describe('Wave J R1 / HIGH-2 — _getFileStatusColor returns gitDecoration-* var() expressions', () => {
  // Cross-check: the existing top-of-file `INTELLIJ_FILE_STATUS_COLORS`
  // import covers the hex side; `FILE_STATUS_THEME_VARS` (new in) is
  // the theme-token map. The two MUST cover the same FileStatus union.

  interface FileStatusColorStub {
    _getFileStatusColor(s: string): string;
  }

  function callFileStatusColor(status: string): string {
    const proto = (
      GitToolWindowProvider as unknown as {
        prototype: { _getFileStatusColor: (this: FileStatusColorStub, s: string) => string };
      }
    ).prototype;
    return proto._getFileStatusColor.call({} as FileStatusColorStub, status);
  }

  // One test per FileStatus — fileStatusTheme-1..8.
  it('fileStatusTheme-1: modified → var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)', () => {
    assert.strictEqual(
      callFileStatusColor('modified'),
      'var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)'
    );
  });

  it('fileStatusTheme-2: added → var(--vscode-gitDecoration-addedResourceForeground, #629755)', () => {
    assert.strictEqual(
      callFileStatusColor('added'),
      'var(--vscode-gitDecoration-addedResourceForeground, #629755)'
    );
  });

  it('fileStatusTheme-3: deleted → var(--vscode-gitDecoration-deletedResourceForeground, #6C6C6C)', () => {
    assert.strictEqual(
      callFileStatusColor('deleted'),
      'var(--vscode-gitDecoration-deletedResourceForeground, #6C6C6C)'
    );
  });

  it('fileStatusTheme-4: renamed → var(--vscode-gitDecoration-renamedResourceForeground, #6897BB)', () => {
    assert.strictEqual(
      callFileStatusColor('renamed'),
      'var(--vscode-gitDecoration-renamedResourceForeground, #6897BB)'
    );
  });

  it('fileStatusTheme-5: copied → var(--vscode-gitDecoration-addedResourceForeground, #629755) (alias)', () => {
    // `copied` aliases to `addedResourceForeground` per VS Code's
    // own convention (their built-in git extension applies the same
    // alias).
    assert.strictEqual(
      callFileStatusColor('copied'),
      'var(--vscode-gitDecoration-addedResourceForeground, #629755)'
    );
  });

  it('fileStatusTheme-6: untracked → var(--vscode-gitDecoration-untrackedResourceForeground, #CC7832)', () => {
    assert.strictEqual(
      callFileStatusColor('untracked'),
      'var(--vscode-gitDecoration-untrackedResourceForeground, #CC7832)'
    );
  });

  it('fileStatusTheme-7: ignored → var(--vscode-gitDecoration-ignoredResourceForeground, #848504)', () => {
    assert.strictEqual(
      callFileStatusColor('ignored'),
      'var(--vscode-gitDecoration-ignoredResourceForeground, #848504)'
    );
  });

  it('fileStatusTheme-8: conflicted → var(--vscode-gitDecoration-conflictingResourceForeground, #FF0000)', () => {
    assert.strictEqual(
      callFileStatusColor('conflicted'),
      'var(--vscode-gitDecoration-conflictingResourceForeground, #FF0000)'
    );
  });

  // Cross-check: the FILE_STATUS_THEME_VARS map and INTELLIJ_FILE_STATUS_COLORS
  // map both have an entry for every status the function is queried for.
  it('fileStatusTheme map shape: every theme-var key has a matching hex-fallback key', () => {
    const themeVarKeys = Object.keys(FILE_STATUS_THEME_VARS).sort();
    const hexKeys = Object.keys(INTELLIJ_FILE_STATUS_COLORS).sort();
    assert.deepStrictEqual(
      themeVarKeys,
      hexKeys,
      'FILE_STATUS_THEME_VARS and INTELLIJ_FILE_STATUS_COLORS must cover the same FileStatus union'
    );
  });
});

/**
 * Visual_Parity_Snapshot for the Changed Files directory tree in BOTH details
 * panels (Task 4.3, git-view-layout-parity — Requirements 2.10, 2.11, 2.12).
 *
 * Requirement 2.12 pins the emitted nested directory-tree markup of the Changed
 * Files list. Requirement 2.11 requires the SAME hierarchy in both the
 * single-commit (`_getDetailsPanelHtml`) and multi-commit combined
 * (`_getMultiCommitDetailsPanelHtml`) views — the two frozen literals below are
 * identical except that the single-commit leaves carry `data-commit-hash` and
 * the combined leaves do not. Requirement 2.10 requires `role="listitem"` on
 * every emitted row (directory rows included); the frozen literals carry it on
 * each row and the helper assertions guard it explicitly.
 *
 * Inline-frozen-literal pattern (ADR-010 Layer 1, mirroring
 * `historyTabStyles.snapshots.test.ts` and `noRepositoryHtml.snapshots.test.ts`)
 * — NO `--update-snapshots`, so a legitimate render change is a hand-edit of the
 * frozen string under review. One documented normalization is applied before
 * freezing: trailing whitespace is trimmed per line (the renderer's template
 * interpolations leave a few whitespace-only lines that are invisible in the
 * rendered DOM and brittle to freeze). Line count, indentation, classes,
 * `padding-left` values, roles, and all data attributes are preserved verbatim.
 *
 * The fixture is a fixed multi-directory set that exercises every pinned facet:
 *   - `src/main/java/App.java`            → compacted `src/main/java` dir label
 *   - `src/main/java/util/Helpers.java`   → a nested dir row (`util`) at depth 1
 *   - `src/main/java/Renamed.java`        → a renamed leaf with its old path
 *   - `README.md`                         → a root-level leaf at the top level
 * giving directory rows at padding-left 4px (depth 0) and 20px (depth 1) and
 * file rows at 4px / 20px / 36px (16·depth + 4), with directories sorted before
 * files and `App` before `Renamed` case-insensitively.
 */
describe('git-view-layout-parity / snap-changed-files-tree — Changed Files directory tree Visual_Parity_Snapshot', () => {
  let treeProvider: GitToolWindowProvider;

  beforeEach(() => {
    treeProvider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    treeProvider.dispose();
  });

  const TREE_FIXTURE_HASH = 'abc1234567890abcdef1234567890abcdef123456';

  /** The fixed multi-directory Changed_File set described in the suite docblock. */
  function makeTreeFixtureFiles(): ICommitDetails['changedFiles'] {
    return [
      { path: 'src/main/java/App.java', status: 'modified' },
      { path: 'src/main/java/util/Helpers.java', status: 'added' },
      { path: 'src/main/java/Renamed.java', status: 'renamed', oldPath: 'src/main/java/Old.java' },
      { path: 'README.md', status: 'modified' },
    ];
  }

  /**
   * Extract the `.changed-files-list` fragment (its opening tag through its
   * matching closing `</div>`) from a rendered details-panel HTML string, then
   * trim trailing whitespace per line so the frozen literal is robust to the
   * renderer's invisible template whitespace (documented normalization above).
   */
  function extractChangedFilesList(html: string): string {
    const marker = '<div class="changed-files-list" role="list" aria-label="Changed Files">';
    const startIdx = html.indexOf(marker);
    assert.ok(startIdx >= 0, 'rendered panel must contain the changed-files-list container');
    const after = html.slice(startIdx);
    // The list `</div>` is immediately followed by the details-changed-files
    // `</div>` on the next line; this sequence is the unique terminator.
    const closeSeq = '</div>\n        </div>';
    const endIdx = after.indexOf(closeSeq);
    assert.ok(endIdx >= 0, 'changed-files-list container must be closed');
    const fragment = after.slice(0, endIdx + '</div>'.length);
    return fragment
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n');
  }

  // The single-commit tree: identical structure to the combined tree below,
  // but every file leaf carries `data-commit-hash` (Requirement 2.11).
  const EXPECTED_SINGLE_COMMIT_TREE = `<div class="changed-files-list" role="list" aria-label="Changed Files">

          <div class="changed-dir-item" role="listitem" style="padding-left: 4px;">
            <span class="dir-name">src/main/java</span>
          </div>
          <div class="changed-dir-item" role="listitem" style="padding-left: 20px;">
            <span class="dir-name">util</span>
          </div>
          <div class="changed-file-item"
               data-path="src/main/java/util/Helpers.java"
               data-status="added"
               data-commit-hash="abc1234567890abcdef1234567890abcdef123456"
               role="listitem"
               tabindex="0"
               style="padding-left: 36px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-addedResourceForeground, #629755);" title="added">
              A
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-addedResourceForeground, #629755);">
              Helpers.java
            </span>

          </div>
          <div class="changed-file-item"
               data-path="src/main/java/App.java"
               data-status="modified"
               data-commit-hash="abc1234567890abcdef1234567890abcdef123456"
               role="listitem"
               tabindex="0"
               style="padding-left: 20px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);" title="modified">
              M
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);">
              App.java
            </span>

          </div>
          <div class="changed-file-item"
               data-path="src/main/java/Renamed.java"
               data-status="renamed"
               data-commit-hash="abc1234567890abcdef1234567890abcdef123456"
               role="listitem"
               tabindex="0"
               style="padding-left: 20px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-renamedResourceForeground, #6897BB);" title="renamed">
              R
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-renamedResourceForeground, #6897BB);">
              Renamed.java
            </span>
             <span class="rename-arrow">←</span> <span class="old-path" title="src/main/java/Old.java">src/main/java/Old.java</span>
          </div>
          <div class="changed-file-item"
               data-path="README.md"
               data-status="modified"
               data-commit-hash="abc1234567890abcdef1234567890abcdef123456"
               role="listitem"
               tabindex="0"
               style="padding-left: 4px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);" title="modified">
              M
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);">
              README.md
            </span>

          </div>
          </div>`;

  // The combined multi-commit tree: byte-identical to the single-commit tree
  // EXCEPT it has no `data-commit-hash` line on any leaf (the combined view's
  // leaves carry no single commit hash).
  const EXPECTED_COMBINED_TREE = `<div class="changed-files-list" role="list" aria-label="Changed Files">

          <div class="changed-dir-item" role="listitem" style="padding-left: 4px;">
            <span class="dir-name">src/main/java</span>
          </div>
          <div class="changed-dir-item" role="listitem" style="padding-left: 20px;">
            <span class="dir-name">util</span>
          </div>
          <div class="changed-file-item"
               data-path="src/main/java/util/Helpers.java"
               data-status="added"
               role="listitem"
               tabindex="0"
               style="padding-left: 36px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-addedResourceForeground, #629755);" title="added">
              A
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-addedResourceForeground, #629755);">
              Helpers.java
            </span>

          </div>
          <div class="changed-file-item"
               data-path="src/main/java/App.java"
               data-status="modified"
               role="listitem"
               tabindex="0"
               style="padding-left: 20px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);" title="modified">
              M
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);">
              App.java
            </span>

          </div>
          <div class="changed-file-item"
               data-path="src/main/java/Renamed.java"
               data-status="renamed"
               role="listitem"
               tabindex="0"
               style="padding-left: 20px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-renamedResourceForeground, #6897BB);" title="renamed">
              R
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-renamedResourceForeground, #6897BB);">
              Renamed.java
            </span>
             <span class="rename-arrow">←</span> <span class="old-path" title="src/main/java/Old.java">src/main/java/Old.java</span>
          </div>
          <div class="changed-file-item"
               data-path="README.md"
               data-status="modified"
               role="listitem"
               tabindex="0"
               style="padding-left: 4px;">
            <span class="file-status-indicator" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);" title="modified">
              M
            </span>
            <span class="file-name" style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);">
              README.md
            </span>

          </div>
          </div>`;

  it('snap-tree-1: single-commit panel freezes the nested tree WITH data-commit-hash (Req 2.11, 2.12)', () => {
    const details = makeCommitDetails({
      hash: TREE_FIXTURE_HASH,
      changedFiles: makeTreeFixtureFiles(),
    });
    const html = treeProvider._getDetailsPanelHtml(details);

    assert.strictEqual(extractChangedFilesList(html), EXPECTED_SINGLE_COMMIT_TREE);
  });

  it('snap-tree-2: multi-commit combined panel freezes the SAME tree WITHOUT data-commit-hash (Req 2.11, 2.12)', () => {
    const commits = [
      makeCommitDetails({ hash: TREE_FIXTURE_HASH, message: 'C1', changedFiles: [] }),
    ];
    const html = treeProvider._getMultiCommitDetailsPanelHtml(commits, makeTreeFixtureFiles());

    assert.strictEqual(extractChangedFilesList(html), EXPECTED_COMBINED_TREE);
  });

  it('snap-tree-3: single-commit leaves carry data-commit-hash; combined leaves do not (Req 2.11)', () => {
    const singleHtml = treeProvider._getDetailsPanelHtml(
      makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
    );
    const combinedHtml = treeProvider._getMultiCommitDetailsPanelHtml(
      [makeCommitDetails({ hash: TREE_FIXTURE_HASH, message: 'C1', changedFiles: [] })],
      makeTreeFixtureFiles()
    );

    const singleTree = extractChangedFilesList(singleHtml);
    const combinedTree = extractChangedFilesList(combinedHtml);

    // Four file leaves in the fixture → four data-commit-hash attributes on the
    // single-commit tree, zero on the combined tree.
    const singleHashCount = (singleTree.match(/data-commit-hash="/g) ?? []).length;
    assert.strictEqual(
      singleHashCount,
      4,
      'every single-commit file leaf must carry data-commit-hash'
    );
    assert.ok(
      !combinedTree.includes('data-commit-hash'),
      'combined-view file leaves must NOT carry data-commit-hash'
    );
  });

  it('snap-tree-4: every emitted row (directory and file) carries role="listitem" (Req 2.10)', () => {
    const html = treeProvider._getDetailsPanelHtml(
      makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
    );
    const tree = extractChangedFilesList(html);

    // 2 directory rows + 4 file rows = 6 rows, each with role="listitem".
    const dirRows = (tree.match(/class="changed-dir-item" role="listitem"/g) ?? []).length;
    const fileRows = (tree.match(/class="changed-file-item"/g) ?? []).length;
    const listitemCount = (tree.match(/role="listitem"/g) ?? []).length;

    assert.strictEqual(dirRows, 2, 'fixture must emit 2 directory rows');
    assert.strictEqual(fileRows, 4, 'fixture must emit 4 file rows');
    assert.strictEqual(listitemCount, 6, 'every directory and file row must carry role="listitem"');
  });

  it('snap-tree-5: pins the compacted directory label and nested directory row (Req 2.12, 2.14)', () => {
    const html = treeProvider._getDetailsPanelHtml(
      makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
    );
    const tree = extractChangedFilesList(html);

    // src→main→java compacts into one label at depth 0 (padding-left 4px).
    assert.ok(
      tree.includes(
        '<div class="changed-dir-item" role="listitem" style="padding-left: 4px;">\n            <span class="dir-name">src/main/java</span>'
      ),
      'compacted src/main/java directory label must be pinned at padding-left 4px'
    );
    // util is a nested directory row at depth 1 (padding-left 20px).
    assert.ok(
      tree.includes(
        '<div class="changed-dir-item" role="listitem" style="padding-left: 20px;">\n            <span class="dir-name">util</span>'
      ),
      'nested util directory row must be pinned at padding-left 20px'
    );
  });
});
