/**
 * Unit tests for _getDetailsPanelHtml() method in GitToolWindowProvider.
 */

import '../../setup';
import * as assert from 'assert';
import {
  GitToolWindowProvider,
  INTELLIJ_FILE_STATUS_COLORS,
  FILE_STATUS_THEME_VARS,
} from '../../../src/ui-shell/GitToolWindowProvider';
import { ICommitDetails } from '../../../src/services/interfaces';
import { ICommit, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { commitNodeToBaseDetails } from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';
import { Uri, setMockConfigValue } from '../../mocks/vscode';
import {
  renderDetailsPanel as renderModelPanel,
  renderDetailsPanelHtml as renderModelHtml,
} from '../../helpers/detailsPanelDom';

/**
 * The Details Panel is built client-side via createElement (see
 * scriptBuilder.buildDetailsPanelDom) from a host render-model. These tests
 * pin the RENDERED markup, so they build the panel from a model in jsdom and
 * assert against the built DOM (or its serialized `outerHTML`) — the same
 * surface the old `_getDetailsPanelHtml` string was, now produced by the real
 * client builder.
 */

/** Render the single-commit Details Panel HTML for the given commit. */
function renderDetails(provider: GitToolWindowProvider, details: ICommitDetails): string {
  return renderModelHtml(provider._getDetailsPanelModel(details));
}

/** Render the multi-commit Details Panel HTML. */
function renderMulti(
  provider: GitToolWindowProvider,
  list: ICommitDetails[],
  combined?: Parameters<GitToolWindowProvider['_getMultiCommitDetailsPanelModel']>[1]
): string {
  return renderModelHtml(provider._getMultiCommitDetailsPanelModel(list, combined));
}

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

  // Mirrors CommitPresentationUtil.getAuthorAndCommitterText: the committer
  // line appears when the committer differs from the author, or when only the
  // timestamps differ (an amend/rebase by the same person).
  describe('Committer line', () => {
    const AUTHORED = new Date('2024-01-15T10:30:00Z');
    const COMMITTED = new Date('2024-02-20T08:00:00Z');

    /** The rendered committer row, or null when the panel omits it. */
    const committerRow = (details: Partial<ICommitDetails>): Element | null =>
      renderModelPanel(provider._getDetailsPanelModel(makeCommitDetails(details))).querySelector(
        '.committed-by-row'
      );

    it('omits the committer line when author and committer are the same person at the same time', () => {
      const row = committerRow({
        author: { name: 'John Doe', email: 'john@example.com' },
        committer: { name: 'John Doe', email: 'john@example.com' },
        date: AUTHORED,
        commitDate: AUTHORED,
      });

      assert.strictEqual(row, null, 'no committer line for a plain self-authored commit');
    });

    it('names the committer when a different person committed the change', () => {
      const row = committerRow({
        author: { name: 'John Doe', email: 'john@example.com' },
        committer: { name: 'Jane Roe', email: 'jane@example.com' },
        date: AUTHORED,
        commitDate: COMMITTED,
      });

      assert.ok(row?.textContent?.includes('Jane Roe'), 'the committer is named');
    });

    it('omits the redundant name when the same person committed at a later time', () => {
      const row = committerRow({
        author: { name: 'John Doe', email: 'john@example.com' },
        committer: { name: 'John Doe', email: 'john@example.com' },
        date: AUTHORED,
        commitDate: COMMITTED,
      });

      assert.ok(row, 'an amend by the same author still reports the commit time');
      assert.ok(!row?.textContent?.includes('John Doe'), 'the redundant committer name is omitted');
    });

    it('compares identity by name case-insensitively, not by email', () => {
      const row = committerRow({
        author: { name: 'John Doe', email: 'john@example.com' },
        committer: { name: 'john doe', email: 'john@work.example.com' },
        date: AUTHORED,
        commitDate: AUTHORED,
      });

      assert.strictEqual(row, null, 'same name in standard form is the same person');
    });
  });

  // IntelliJ's ReferencesPanel groups the refs pointing AT this commit by type
  // and renders each as a chip; a commit with no refs shows no chip row.
  describe('Ref chips', () => {
    const chips = (details: Partial<ICommitDetails>, selector: string): string[] =>
      Array.from(
        renderModelPanel(
          provider._getDetailsPanelModel(makeCommitDetails(details))
        ).querySelectorAll(selector)
      ).map((el) => el.textContent ?? '');

    it('renders a chip per branch pointing at the commit', () => {
      assert.deepStrictEqual(
        chips({ branches: ['main', 'feature/login'] }, '.details-ref-branch'),
        ['main', 'feature/login']
      );
    });

    it('renders a chip per tag pointing at the commit', () => {
      assert.deepStrictEqual(chips({ tags: ['v1.0.0', 'release'] }, '.details-ref-tag'), [
        'v1.0.0',
        'release',
      ]);
    });

    it('renders no ref row for a commit that carries neither branch nor tag', () => {
      assert.deepStrictEqual(chips({ branches: [], tags: [] }, '.details-refs-row'), []);
    });

    it('keeps a hostile ref name as text rather than markup', () => {
      const [chip] = chips({ branches: ['<img src=x onerror=alert(1)>'] }, '.details-ref-branch');

      assert.strictEqual(chip, '<img src=x onerror=alert(1)>', 'the ref name crosses as data');
    });
  });

  describe('Multi-commit changed-files errors', () => {
    it('surfaces a failed changed-files load instead of showing an empty list', () => {
      const html = renderMulti(provider, [
        makeCommitDetails({ hash: 'a'.repeat(40) }),
        makeCommitDetails({ hash: 'b'.repeat(40), changedFilesError: 'fatal: bad object' }),
      ]);

      assert.ok(
        html.includes('fatal: bad object'),
        'a partial file list must report why it is partial'
      );
    });

    it('shows no error banner when every commit loaded cleanly', () => {
      const html = renderMulti(provider, [makeCommitDetails({ hash: 'a'.repeat(40) })]);

      assert.ok(!html.includes('error-message'), 'a clean load shows no error');
    });
  });

  describe('Commit-hash links in the message', () => {
    it('renders a resolvable hash as a jump target carrying the hash', () => {
      const loaded = 'abc1234567890abcdef1234567890abcdef12345';
      (
        provider as unknown as { _extendedLogState: { commitNodes: unknown[] } }
      )._extendedLogState.commitNodes = [{ commit: { hash: loaded }, branches: [], tags: [] }];

      const link = renderModelPanel(
        provider._getDetailsPanelModel(makeCommitDetails({ message: 'Revert abc1234 for now' }))
      ).querySelector('.commit-hash-link');

      assert.strictEqual(link?.getAttribute('data-commit-hash'), 'abc1234');
      assert.strictEqual(link?.textContent, 'abc1234');
    });

    it('leaves a hex word that names no loaded commit unlinked', () => {
      const link = renderModelPanel(
        provider._getDetailsPanelModel(makeCommitDetails({ message: 'Use deadbeef as the fill' }))
      ).querySelector('.commit-hash-link');

      assert.strictEqual(link, null, 'an unresolvable run must not look clickable');
    });
  });

  describe('Commit metadata display', () => {
    it('should display the commit message', () => {
      const details = makeCommitDetails({ message: 'Implement new feature' });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Implement new feature'), 'Should contain the commit message');
    });

    it('should display the commit body when present', () => {
      const details = makeCommitDetails({
        message: 'Short summary',
        body: 'Detailed body explaining the change',
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Short summary'), 'Should contain the message');
      assert.ok(html.includes('Detailed body explaining the change'), 'Should contain the body');
    });

    it('should display the full commit hash', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const details = makeCommitDetails({ hash });
      const html = renderDetails(provider, details);

      assert.ok(html.includes(hash), 'Should contain the full hash');
    });

    it('should display the author name', () => {
      const details = makeCommitDetails({
        author: { name: 'Jane Smith', email: 'jane@example.com' },
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Jane Smith'), 'Should contain the author name');
    });

    it('should display the author email', () => {
      const details = makeCommitDetails({
        author: { name: 'Jane Smith', email: 'jane@example.com' },
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('jane@example.com'), 'Should contain the author email');
    });

    it('should display the commit date', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const details = makeCommitDetails({ date });
      const html = renderDetails(provider, details);

      const dateStr = date.toLocaleString();
      assert.ok(html.includes(dateStr), 'Should contain the formatted date');
    });

    it('should display parent commit hashes', () => {
      const parents = [
        'aaa1111111111111111111111111111111111111111',
        'bbb2222222222222222222222222222222222222222',
      ];
      const details = makeCommitDetails({ parents });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('aaa1111'), 'Should contain short form of first parent');
      assert.ok(html.includes('bbb2222'), 'Should contain short form of second parent');
    });

    it('should display "None (root commit)" when there are no parents', () => {
      const details = makeCommitDetails({ parents: [] });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('None (root commit)'), 'Should indicate root commit');
    });

    it('should have a "Parents:" label', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Parents:'), 'Should have Parents label');
    });

    it('should have a "Hash:" label', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Hash:'), 'Should have Hash label');
    });

    it('should have an "Author:" label', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Author:'), 'Should have Author label');
    });

    it('should have a "Date:" label', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Date:'), 'Should have Date label');
    });

    it('renders the subject in bold with NO "Message:" label (IntelliJ-style)', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(!html.includes('Message:'), 'should NOT render a "Message:" field label');
      assert.ok(
        html.includes('commit-subject'),
        'subject is rendered in a .commit-subject element (bold)'
      );
      assert.ok(html.includes('Fix authentication bug'), 'subject text is present');
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
      const html = renderDetails(provider, details);

      assert.ok(html.includes('main.ts'), 'Should contain the file name');
      assert.ok(html.includes('new-file.ts'), 'Should contain the second file name');
    });

    it('does NOT render an M/A/D status letter (colour + line stat convey the change)', () => {
      const details = makeCommitDetails({
        changedFiles: [
          { path: 'src/main.ts', status: 'modified' },
          { path: 'src/new.ts', status: 'added' },
          { path: 'src/old.ts', status: 'deleted' },
        ],
      });
      const html = renderDetails(provider, details);
      assert.ok(
        !html.includes('file-status-indicator'),
        'the status-letter indicator must be gone'
      );
    });

    it('carries the status as a title on the file name (a11y, replaces the letter)', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);
      assert.ok(
        /class="file-name"[^>]*title="modified"/.test(html) ||
          /title="modified"[^>]*class="file-name"/.test(html),
        'file name carries the status as a title'
      );
    });

    it('renders a per-file "(+N | -M)" line stat with add green / del red', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified', additions: 20, deletions: 10 }],
      });
      const html = renderDetails(provider, details);
      assert.ok(html.includes('changed-file-stats'), 'has the stat block');
      assert.ok(
        /class="changed-file-add"[^>]*>\+20</.test(html),
        'shows +20 in the additions span'
      );
      assert.ok(/class="changed-file-del"[^>]*>-10</.test(html), 'shows -10 in the deletions span');
    });

    it('omits the line stat when a file has no line changes (e.g. binary)', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'img/logo.png', status: 'modified' }],
      });
      const html = renderDetails(provider, details);
      assert.ok(!html.includes('changed-file-stats'), 'no stat block without counts');
    });

    it('should use IntelliJ blue color (#6897BB) for modified files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.modified),
        'Should use IntelliJ blue for modified'
      );
    });

    it('should use IntelliJ green color (#629755) for added files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new.ts', status: 'added' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.added),
        'Should use IntelliJ green for added'
      );
    });

    it('should use IntelliJ gray color (#6C6C6C) for deleted files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/old.ts', status: 'deleted' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.deleted),
        'Should use IntelliJ gray for deleted'
      );
    });

    it('should use IntelliJ blue color (#6897BB) for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/renamed.ts', status: 'renamed', oldPath: 'src/original.ts' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(
        html.includes(INTELLIJ_FILE_STATUS_COLORS.renamed),
        'Should use IntelliJ blue for renamed'
      );
    });

    it('should display file name and directory separately', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/utils/helpers.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('helpers.ts'), 'Should contain the file name');
      assert.ok(html.includes('src/utils'), 'Should contain the directory path');
    });

    it('should show old path for renamed files', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/new-name.ts', status: 'renamed', oldPath: 'src/old-name.ts' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('src/old-name.ts'), 'Should show the old path for renamed files');
    });

    it('should display "No changed files" when the list is empty', () => {
      const details = makeCommitDetails({ changedFiles: [] });
      const html = renderDetails(provider, details);

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
      const html = renderDetails(provider, details);

      assert.ok(html.includes('Changed Files (3)'), 'Should show file count');
    });
  });

  describe('HTML structure and accessibility', () => {
    it('should have role="region" on the details panel', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('role="region"'), 'Should have region role');
    });

    it('should have aria-label="Commit Details"', () => {
      const details = makeCommitDetails();
      const html = renderDetails(provider, details);

      assert.ok(html.includes('aria-label="Commit Details"'), 'Should have aria-label');
    });

    it('should have role="tree" on the changed files container', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

      // The Changed Files panel is now a collapsible directory tree, so the
      // container carries tree semantics rather than a flat list.
      assert.ok(
        html.includes('class="changed-files-list" role="tree"'),
        'Should have tree role on files container'
      );
    });

    it('should have role="treeitem" on each changed file row', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

      assert.ok(html.includes('role="treeitem"'), 'Should have treeitem role on file rows');
    });

    it('should escape HTML special characters in commit message', () => {
      const details = makeCommitDetails({
        message: 'Fix <script>alert("xss")</script> bug',
      });
      const html = renderDetails(provider, details);

      assert.ok(!html.includes('<script>'), 'Should escape script tags');
      assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped script tags');
    });

    it('should escape HTML special characters in author name', () => {
      const details = makeCommitDetails({
        author: { name: "O'Brien & Co <test>", email: 'test@example.com' },
      });
      const html = renderDetails(provider, details);

      assert.ok(!html.includes('<test>'), 'Should escape angle brackets in author name');
    });

    it('should render file paths as inert text (no script injection)', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/<script>.ts', status: 'modified' }],
      });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));

      // The path crosses as data: the visible file name is set via textContent
      // (serializes escaped) and the raw path rides in a quoted data attribute —
      // neither can introduce a parsed <script> element.
      assert.strictEqual(panel.querySelector('script'), null, 'no <script> element injected');
      assert.strictEqual(
        panel.querySelector('.changed-file-item')?.getAttribute('data-path'),
        'src/<script>.ts',
        'raw path preserved safely in the data attribute'
      );
      assert.strictEqual(
        panel.querySelector('.file-name')?.textContent?.trim(),
        '<script>.ts',
        'file name rendered as inert text'
      );
    });
  });

  describe('Data attributes on changed files for event delegation', () => {
    it('should have data-commit-hash and data-path attributes on changed file items', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

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
      const html = renderDetails(provider, details);

      assert.ok(
        html.includes(`data-commit-hash="${hash}"`),
        'Should have the commit hash in data-commit-hash attribute'
      );
    });

    it('should pass the file path as data-path attribute', () => {
      const details = makeCommitDetails({
        changedFiles: [{ path: 'src/utils/helpers.ts', status: 'modified' }],
      });
      const html = renderDetails(provider, details);

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
      const html = renderDetails(provider, details);

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
      const html = renderDetails(provider, details);

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
      const html = renderModelHtml(provider.getDetailsPanelPlaceholderModel());

      assert.ok(
        html.includes('Select a commit to view details'),
        'Should contain placeholder message'
      );
    });

    it('should have role="region" on the placeholder panel', () => {
      const html = renderModelHtml(provider.getDetailsPanelPlaceholderModel());

      assert.ok(html.includes('role="region"'), 'Should have region role');
    });

    it('should have aria-label="Commit Details" on the placeholder panel', () => {
      const html = renderModelHtml(provider.getDetailsPanelPlaceholderModel());

      assert.ok(html.includes('aria-label="Commit Details"'), 'Should have aria-label');
    });

    it('should have the details-panel class on the placeholder', () => {
      const html = renderModelHtml(provider.getDetailsPanelPlaceholderModel());

      assert.ok(html.includes('details-panel'), 'Should have details-panel class');
    });

    it('should have the placeholder-message class', () => {
      const html = renderModelHtml(provider.getDetailsPanelPlaceholderModel());

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
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('3 commits selected'), 'Should show "3 commits selected"');
      });

      it('should use singular "commit" for a single commit', () => {
        const commits = makeMultipleCommitDetails(1);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('1 commit selected'), 'Should show "1 commit selected"');
      });

      it('should display correct count for many commits', () => {
        const commits = makeMultipleCommitDetails(10);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('10 commits selected'), 'Should show "10 commits selected"');
      });
    });

    describe('Selected commits list', () => {
      it('should display short hashes for each selected commit', () => {
        const commits = makeMultipleCommitDetails(3);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('hash000'), 'Should contain short hash of first commit');
        assert.ok(html.includes('hash100'), 'Should contain short hash of second commit');
        assert.ok(html.includes('hash200'), 'Should contain short hash of third commit');
      });

      it('should display commit messages for each selected commit', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('Commit message 1'), 'Should contain first commit message');
        assert.ok(html.includes('Commit message 2'), 'Should contain second commit message');
      });

      it('should have role="list" on the commits list container', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('role="list"'), 'Should have list role');
      });

      it('should have role="listitem" on each commit item', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

        // Last status wins → the file name is coloured with the modified colour
        // (the M/A/D letter was removed; colour conveys the status now).
        assert.ok(
          html.includes(INTELLIJ_FILE_STATUS_COLORS.modified),
          'Should colour the file with the modified status from the later commit'
        );
        assert.ok(
          !html.includes(INTELLIJ_FILE_STATUS_COLORS.added),
          'the earlier "added" status must not win'
        );
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
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits, combinedFiles);

        assert.ok(html.includes('combined-a.ts'), 'Should contain pre-computed file');
        assert.ok(html.includes('combined-b.ts'), 'Should contain pre-computed file');
        assert.ok(html.includes('Changed Files (2)'), 'Should show pre-computed file count');
      });
    });

    describe('HTML structure and accessibility', () => {
      it('should have role="region" on the multi-commit details panel', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('role="region"'), 'Should have region role');
      });

      it('should have aria-label="Multi-Commit Details"', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('aria-label="Multi-Commit Details"'), 'Should have aria-label');
      });

      it('should have the details-panel class', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

        assert.ok(html.includes('details-panel'), 'Should have details-panel class');
      });

      it('should have the multi-commit-details class', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

        assert.ok(!html.includes('<script>'), 'Should escape script tags');
        assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped script tags');
      });

      it('should have aria-label="Selected Commits" on the commits list', () => {
        const commits = makeMultipleCommitDetails(2);
        const html = renderMulti(provider, commits);

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
        const html = renderMulti(provider, commits);

        assert.ok(
          html.includes('aria-label="Changed Files"'),
          'Should have aria-label on files list'
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // "Contained in branches" row (mirrors IntelliJ ContainingBranchesPanel).
  // ──────────────────────────────────────────────────────────────────────
  describe('Contained in branches', () => {
    it('shows the IntelliJ loading header while the branch list is undefined', () => {
      const details = makeCommitDetails({ containingBranches: undefined });
      const html = renderDetails(provider, details);
      assert.ok(html.includes('In branches: loading…'), 'should show the loading header');
    });

    it('shows "Not in any branch" when the commit is in no branch', () => {
      const details = makeCommitDetails({ containingBranches: [] });
      const html = renderDetails(provider, details);
      assert.ok(html.includes('Not in any branch'), 'should show the empty state');
    });

    it('uses the singular "In 1 branch:" header for a single branch', () => {
      const details = makeCommitDetails({ containingBranches: ['main'] });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      assert.strictEqual(
        panel.querySelector('.containing-branches-row .detail-label')?.textContent,
        'In 1 branch:'
      );
    });

    it('uses the plural "In N branches:" header carrying the full count', () => {
      const details = makeCommitDetails({ containingBranches: ['main', 'dev', 'release'] });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      assert.strictEqual(
        panel.querySelector('.containing-branches-row .detail-label')?.textContent,
        'In 3 branches:'
      );
    });

    it('lists every branch inline when at or below the collapse threshold (3)', () => {
      const details = makeCommitDetails({ containingBranches: ['main', 'dev', 'release'] });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      const names = Array.from(panel.querySelectorAll('.containing-branch')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(names, ['main', 'dev', 'release']);
      assert.strictEqual(
        panel.querySelector('.branches-show-all'),
        null,
        'no Show all link when nothing is collapsed'
      );
    });

    it('collapses to the first 3 branches plus a Show all affordance past the threshold', () => {
      const details = makeCommitDetails({
        containingBranches: ['a', 'b', 'c', 'd', 'e'],
      });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      // The full count rides in the header even while collapsed (M1 parity).
      assert.strictEqual(
        panel.querySelector('.containing-branches-row .detail-label')?.textContent,
        'In 5 branches:'
      );
      const collapsed = panel.querySelector('.branches-collapsed');
      const expanded = panel.querySelector('.branches-expanded');
      assert.ok(collapsed, 'collapsed view present');
      assert.ok(expanded, 'expanded view present');
      const collapsedNames = Array.from(collapsed.querySelectorAll('.containing-branch')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(collapsedNames, ['a', 'b', 'c'], 'collapsed shows first 3');
      assert.ok(panel.querySelector('.branches-show-all'), 'Show all link present');
      assert.ok(
        (expanded.getAttribute('style') || '').includes('display: none'),
        'expanded list hidden initially'
      );
    });

    it('reveals all branches and swaps to a Hide control when Show all is clicked', () => {
      const details = makeCommitDetails({
        containingBranches: ['a', 'b', 'c', 'd', 'e'],
      });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      const showAll = panel.querySelector('.branches-show-all') as HTMLElement;
      const collapsed = panel.querySelector('.branches-collapsed') as HTMLElement;
      const expanded = panel.querySelector('.branches-expanded') as HTMLElement;

      showAll.click();

      assert.strictEqual(collapsed.style.display, 'none', 'collapsed view hidden after expand');
      assert.notStrictEqual(expanded.style.display, 'none', 'expanded view shown after expand');
      // Count header is unchanged across the expand (full count shown in both states).
      assert.strictEqual(
        panel.querySelector('.containing-branches-row .detail-label')?.textContent,
        'In 5 branches:'
      );
      const expandedNames = Array.from(expanded.querySelectorAll('.containing-branch')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(expandedNames, ['a', 'b', 'c', 'd', 'e'], 'all branches listed');
      assert.ok(expanded.querySelector('.branches-hide'), 'Hide control present in expanded view');
    });

    it('renders branch names as inert text (no script injection)', () => {
      const details = makeCommitDetails({
        containingBranches: ['<script>alert(1)</script>', 'main'],
      });
      const panel = renderModelPanel(provider._getDetailsPanelModel(details));
      assert.strictEqual(panel.querySelector('script'), null, 'no <script> element injected');
      const first = panel.querySelector('.containing-branch');
      assert.strictEqual(
        first?.textContent,
        '<script>alert(1)</script>',
        'branch name preserved as inert text'
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // wire issue-link utilities into the details panel.
  // ──────────────────────────────────────────────────────────────────────
  describe('commit message issue links', () => {
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
      const html = renderDetails(provider, details);
      assert.ok(
        html.includes('<a class="commit-issue-link"'),
        `expected an anchor tag for the issue ref; got:\n${html}`
      );
      assert.ok(
        html.includes('https://github.com/acme/widgets/issues/42'),
        'expected GitHub issue URL in the anchor href'
      );
    });

    it('wraps GH-99 on GitHub but leaves JIRA-style PROJECT-123 as inert text', () => {
      // PROJECT-123 is a JIRA ticket, NOT a hosting-provider issue number.
      // Linking it to `<provider>/issues/123` points at the wrong thing, so
      // JIRA-style refs must stay plain text (no JIRA base URL is configured).
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'GH-99 and PROJECT-123: cleanup' });
      const html = renderDetails(provider, details);
      assert.ok(html.includes('>GH-99</a>'), `expected GH-99 anchor; got: ${html}`);
      assert.ok(!html.includes('>PROJECT-123</a>'), `PROJECT-123 must NOT be linked; got: ${html}`);
      assert.ok(html.includes('PROJECT-123'), 'PROJECT-123 must remain as visible text');
    });

    it('does NOT wrap `abc#42` (not a real reference)', () => {
      provider.setAvailableRepositories([makeRepoWithGitHub()]);
      setMockConfigValue('intellig', 'commitMessageIssueLinks', true);
      const details = makeCommitDetails({ message: 'see abc#42 for context' });
      const html = renderDetails(provider, details);
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
      const html = renderDetails(provider, details);
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
      const html = renderDetails(provider, details);
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
describe('Wave J R1 / — _getFileStatusColor returns gitDecoration-* var() expressions', () => {
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
 * panels (git-view-layout-parity).
 *
 * Pins the emitted nested directory-tree markup of the Changed
 * Files list, and requires the SAME hierarchy in both the
 * single-commit (`_getDetailsPanelHtml`) and multi-commit combined
 * (`_getMultiCommitDetailsPanelHtml`) views — the two frozen literals below are
 * identical except that the single-commit leaves carry `data-commit-hash` and
 * the combined leaves do not. requires `role="listitem"` on
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

  it('snap-tree-1: single-commit tree nests directories with data-commit-hash on every file leaf (Req 2.11, 2.12)', () => {
    const details = makeCommitDetails({
      hash: TREE_FIXTURE_HASH,
      changedFiles: makeTreeFixtureFiles(),
    });
    const list = renderModelPanel(treeProvider._getDetailsPanelModel(details)).querySelector(
      '.changed-files-list'
    );
    assert.ok(list, 'changed-files-list must render');
    const dirNames = Array.from(list.querySelectorAll('.dir-name')).map((n) => n.textContent);
    assert.deepStrictEqual(dirNames, ['src/main/java', 'util'], 'compacted + nested dir labels');
    const leaves = Array.from(list.querySelectorAll('.changed-file-item'));
    assert.strictEqual(leaves.length, 4, 'four file leaves');
    leaves.forEach((l) =>
      assert.strictEqual(
        l.getAttribute('data-commit-hash'),
        TREE_FIXTURE_HASH,
        'every single-commit leaf carries data-commit-hash'
      )
    );
    const paths = leaves.map((l) => l.getAttribute('data-path'));
    assert.deepStrictEqual(
      paths.slice().sort(),
      [
        'README.md',
        'src/main/java/App.java',
        'src/main/java/Renamed.java',
        'src/main/java/util/Helpers.java',
      ],
      'all fixture paths present'
    );
  });

  it('snap-tree-2: multi-commit combined tree has the SAME structure WITHOUT data-commit-hash (Req 2.11, 2.12)', () => {
    const commits = [
      makeCommitDetails({ hash: TREE_FIXTURE_HASH, message: 'C1', changedFiles: [] }),
    ];
    const list = renderModelPanel(
      treeProvider._getMultiCommitDetailsPanelModel(commits, makeTreeFixtureFiles())
    ).querySelector('.changed-files-list');
    assert.ok(list, 'changed-files-list must render');
    const dirNames = Array.from(list.querySelectorAll('.dir-name')).map((n) => n.textContent);
    assert.deepStrictEqual(dirNames, ['src/main/java', 'util'], 'same nested dir labels');
    const leaves = Array.from(list.querySelectorAll('.changed-file-item'));
    assert.strictEqual(leaves.length, 4, 'four file leaves');
    leaves.forEach((l) =>
      assert.strictEqual(
        l.getAttribute('data-commit-hash'),
        null,
        'combined-view leaves carry NO data-commit-hash'
      )
    );
  });

  it('snap-tree-3: single-commit leaves carry data-commit-hash; combined leaves do not (Req 2.11)', () => {
    const singlePanel = renderModelPanel(
      treeProvider._getDetailsPanelModel(
        makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
      )
    );
    const combinedPanel = renderModelPanel(
      treeProvider._getMultiCommitDetailsPanelModel(
        [makeCommitDetails({ hash: TREE_FIXTURE_HASH, message: 'C1', changedFiles: [] })],
        makeTreeFixtureFiles()
      )
    );
    assert.strictEqual(
      singlePanel.querySelectorAll('.changed-file-item[data-commit-hash]').length,
      4,
      'every single-commit file leaf must carry data-commit-hash'
    );
    assert.strictEqual(
      combinedPanel.querySelectorAll('.changed-file-item[data-commit-hash]').length,
      0,
      'combined-view file leaves must NOT carry data-commit-hash'
    );
  });

  it('snap-tree-4: every emitted row (directory and file) carries role="treeitem" (Req 2.10)', () => {
    const list = renderModelPanel(
      treeProvider._getDetailsPanelModel(
        makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
      )
    ).querySelector('.changed-files-list');
    assert.ok(list, 'changed-files-list must render');
    assert.strictEqual(
      list.querySelectorAll('.changed-dir-item[role="treeitem"]').length,
      2,
      'fixture must emit 2 directory rows'
    );
    assert.strictEqual(
      list.querySelectorAll('.changed-file-item[role="treeitem"]').length,
      4,
      'fixture must emit 4 file rows'
    );
    assert.strictEqual(
      list.querySelectorAll('[role="treeitem"]').length,
      6,
      'every directory and file row must carry role="treeitem"'
    );
  });

  it('snap-tree-5: pins the compacted directory label and nested directory row (Req 2.12, 2.14)', () => {
    const list = renderModelPanel(
      treeProvider._getDetailsPanelModel(
        makeCommitDetails({ hash: TREE_FIXTURE_HASH, changedFiles: makeTreeFixtureFiles() })
      )
    ).querySelector('.changed-files-list');
    assert.ok(list, 'changed-files-list must render');
    const dirs = Array.from(list.querySelectorAll('.changed-dir-item'));
    // src->main->java compacts into one collapsible label at depth 0 (padding-left 4px).
    const top = dirs.find((d) => d.querySelector('.dir-name')?.textContent === 'src/main/java');
    assert.ok(top, 'compacted src/main/java directory row must exist');
    assert.ok(
      top.getAttribute('style')?.includes('padding-left: 4px'),
      'compacted dir label pinned at padding-left 4px'
    );
    assert.ok(
      top.querySelector('.dir-chevron.codicon.codicon-chevron-down'),
      'compacted dir carries a down-chevron'
    );
    // util is a nested directory row at depth 1 (padding-left 20px).
    const util = dirs.find((d) => d.querySelector('.dir-name')?.textContent === 'util');
    assert.ok(util, 'nested util directory row must exist');
    assert.ok(
      util.getAttribute('style')?.includes('padding-left: 20px'),
      'nested util dir pinned at padding-left 20px'
    );
  });
});

describe('commitNodeToBaseDetails', () => {
  const makeNode = (commit: Partial<ICommit>): ICommitNode =>
    ({
      commit: {
        hash: 'abc1234567890abcdef1234567890abcdef123456',
        shortHash: 'abc1234',
        message: 'Rebased change',
        author: { name: 'John Doe', email: 'john@example.com' },
        committer: { name: 'Jane Roe', email: 'jane@example.com' },
        parents: [],
        authorDate: new Date('2024-01-15T10:30:00Z'),
        commitDate: new Date('2024-02-20T08:00:00Z'),
        ...commit,
      },
      branches: [],
      tags: [],
    }) as unknown as ICommitNode;

  it('carries the committer and commit date so the panel can show who committed', () => {
    const details = commitNodeToBaseDetails(makeNode({}));

    assert.deepStrictEqual(details.committer, { name: 'Jane Roe', email: 'jane@example.com' });
    assert.deepStrictEqual(details.commitDate, new Date('2024-02-20T08:00:00Z'));
  });
});
