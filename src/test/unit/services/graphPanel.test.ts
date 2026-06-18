/**
 * Unit tests for _getGraphPanelHtml() method in GitToolWindowProvider.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import * as gitToolWindowProvider from '../../../ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../../git-core/commitGraph';
import { ICommit } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * The locale-aware absolute timestamp the commit row is expected to
 * render, mirroring `formatCommitDate`'s `Intl.DateTimeFormat` config
 * (date + time, no seconds). Computed from a reference formatter rather
 * than hardcoded so the assertions stay robust across runner
 * locale/timezone.
 */
const COMMIT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function expectedCommitDate(date: Date): string {
  return COMMIT_DATE_FORMATTER.format(date);
}

/**
 * Helper to create a minimal ICommit for testing.
 */
function makeCommit(overrides: Partial<ICommit> = {}): ICommit {
  return {
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    shortHash: 'abc1234',
    message: 'Fix bug in authentication module',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: ['def5678901234567890abcdef1234567890abcdef'],
    authorDate: new Date(Date.now() - 3600 * 1000), // 1 hour ago
    commitDate: new Date(Date.now() - 3600 * 1000),
    ...overrides,
  };
}

/**
 * Helper to create a minimal ICommitNode for testing.
 */
function makeCommitNode(
  overrides: Partial<ICommitNode> = {},
  commitOverrides: Partial<ICommit> = {}
): ICommitNode {
  return {
    commit: makeCommit(commitOverrides),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
    ...overrides,
  };
}

describe('GitToolWindowProvider - _getGraphPanelHtml()', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Commit rows with required fields', () => {
    it('renders the no-commits empty state when no commits and no active filter', () => {
      const html = provider._getGraphPanelHtml([]);

      assert.ok(
        html.includes('No commits yet'),
        `Should show the no-commits empty state; got: ${html}`
      );
      assert.ok(html.includes('graph-panel'), 'Should have graph-panel container');
      assert.ok(html.includes('graph-empty-state'), 'Should use the empty-state container');
      // The no-commits state offers no "Clear filter" action.
      assert.ok(
        !html.includes('clearLogFilter'),
        'no-commits state must NOT offer a Clear filter button'
      );
    });

    it('renders the filtered-empty state (with Clear filter action) when a filter is active and matches nothing', () => {
      // Activate a filter, then render an empty result.
      provider.setLogFilter({ searchText: 'nonexistent-needle' });
      const html = provider._getGraphPanelHtml([]);

      assert.ok(
        html.includes('No commits match the current filter'),
        `Should show the filtered-empty state; got: ${html}`
      );
      assert.ok(
        html.includes('data-action="clearLogFilter"'),
        'filtered-empty state must offer a Clear filter button'
      );
      assert.ok(html.includes('graph-empty-state'), 'Should use the empty-state container');
    });

    it('should render a commit row with short hash in data-hash attribute', () => {
      const node = makeCommitNode({}, { shortHash: 'abc1234' });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('data-hash='), 'Should have data-hash attribute');
      assert.ok(
        !html.includes('commit-hash'),
        'Should NOT have commit-hash class (hash hidden in graph view)'
      );
    });

    it('should render a commit row with message summary', () => {
      const node = makeCommitNode({}, { message: 'Fix bug in authentication module' });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('Fix bug in authentication module'), 'Should contain the message');
      assert.ok(html.includes('commit-title'), 'Should have commit-title class');
    });

    it('emits the FULL first line of long messages and lets CSS handle ellipsis (Wave E E2-bonus)', () => {
      // This test asserted the row HTML included literal "..."
      // (JS hard-truncated to 60 chars). The truncation was a bug at
      // wide panel widths — the message was capped even when there was
      // plenty of room. Removes the JS truncation and relies on
      // CSS `.commit-title { overflow:hidden; text-overflow:ellipsis;
      // white-space:nowrap }` to truncate responsively.
      const longMessage =
        'This is a very long commit message that exceeds sixty characters and should be truncated with ellipsis';
      const node = makeCommitNode({}, { message: longMessage });
      const html = provider._getGraphPanelHtml([node]);

      // The FULL first line lands in the row HTML — CSS clips visually
      // based on actual flex-allocated width, but the text content is
      // complete (so screen readers, "find in page", and the responsive
      // ellipsis all work correctly).
      const titleMatch = html.match(/class="commit-title"[^>]*>([^<]*)</);
      assert.ok(titleMatch, 'Should find commit-title element');
      assert.strictEqual(
        titleMatch[1],
        longMessage,
        'commit-title text content should be the full first line, not JS-truncated with "..."'
      );
      // Tooltip carries the full message too (unchanged from).
      assert.ok(
        html.includes(`title="${longMessage}"`),
        'Should still carry the full message in the title= tooltip attribute'
      );
    });

    it('should only use the first line of a multi-line message', () => {
      const multiLineMessage = 'First line summary\n\nDetailed body paragraph\nMore details';
      const node = makeCommitNode({}, { message: multiLineMessage });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('First line summary'), 'Should contain first line');
      // The body should not appear in the commit-title div content (only in title attribute)
      const messageMatch = html.match(/class="commit-title"[^>]*>([^<]*)</);
      assert.ok(messageMatch, 'Should find commit-title element');
      assert.ok(
        !messageMatch[1].includes('Detailed body'),
        'Should not contain body text in title div'
      );
    });

    it('should render author name', () => {
      const node = makeCommitNode(
        {},
        {
          author: { name: 'Bob Smith', email: 'bob@example.com' },
        }
      );
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('Bob Smith'), 'Should contain author name');
      assert.ok(html.includes('commit-author'), 'Should have commit-author class');
    });

    it('uses a resizable 120px-default right-aligned author column with ellipsis (closes the author/date dead band)', () => {
      // Reach into the inline-style block for the .commit-author rule.
      // The column went through 140px -> max-width:140px -> 100px -> 120px
      // for width, and left-align -> RIGHT-align to close the dead band:
      // a short name now butts against the date column instead of
      // leaving a gap inside its 120px box. See KNOWN-ISSUES.md
      // author/date dead-band entry.
      //
      // The width is now driven by the --col-author-width custom property so
      // the column is drag-resizable; the 120px fallback preserves the
      // original default render, so the dead-band fix holds out of the box.
      const styles = (provider as unknown as { _getInlineStyles: () => string })._getInlineStyles();

      const authorRuleMatch = styles.match(/\.commit-author\s*\{([^}]+)\}/);
      assert.ok(authorRuleMatch, '.commit-author CSS rule must exist');
      const authorRule = authorRuleMatch[1];

      assert.ok(
        /width:\s*var\(--col-author-width,\s*120px\)/.test(authorRule),
        `.commit-author should declare a var-driven width defaulting to 120px, got: "${authorRule.trim()}"`
      );
      assert.ok(
        authorRule.includes('text-align: right'),
        '.commit-author must be right-aligned so the name abuts the date column (no dead band)'
      );
      assert.ok(
        !/text-align:\s*left/.test(authorRule),
        '.commit-author must NOT be left-aligned (re-introduces the dead band)'
      );
      assert.ok(
        authorRule.includes('text-overflow: ellipsis'),
        '.commit-author must declare text-overflow: ellipsis for the truncation indicator'
      );
      assert.ok(
        authorRule.includes('overflow: hidden'),
        '.commit-author must declare overflow: hidden so the ellipsis can apply'
      );
      assert.ok(
        authorRule.includes('white-space: nowrap'),
        '.commit-author must declare white-space: nowrap so the name fits one line'
      );
    });

    it('renders the commit date via formatCommitDate (locale-aware absolute timestamp)', () => {
      // formatCommitDate always emits a locale-aware absolute timestamp
      // (date + time, no seconds) — never a relative "2h"/"yesterday".
      const authorDate = new Date(2024, 0, 15, 14, 30, 0);
      const node = makeCommitNode({}, { authorDate });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('commit-date'), 'Should have commit-date class');
      assert.ok(
        html.includes(expectedCommitDate(authorDate)),
        `Should show the locale-aware absolute timestamp; got: ${html}`
      );
      // The legacy "YYYY-MM-DD H:MM AM/PM" form must be gone.
      assert.ok(
        !html.includes('2024-01-15 2:30 PM'),
        'Legacy absolute date format must no longer appear'
      );
      // The legacy relative-or-"MMM dd yyyy" form must be gone too.
      assert.ok(
        !html.includes('Jan 15 2024'),
        'Legacy "MMM dd yyyy" absolute form must no longer appear'
      );
    });

    it('should render the full hash in the data-hash attribute', () => {
      const fullHash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash: fullHash });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        html.includes(`data-hash="${fullHash}"`),
        'Should have full hash in data attribute'
      );
    });

    it('should render the full hash in the data-hash attribute (not as visible text)', () => {
      const fullHash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash: fullHash, shortHash: 'abc1234' });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        html.includes(`data-hash="${fullHash}"`),
        'Should have full hash in data-hash attribute'
      );
      assert.ok(
        !html.includes('commit-hash'),
        'Should NOT have commit-hash span (hash hidden in graph view)'
      );
    });
  });

  describe('SVG graph visualization', () => {
    it('should render SVG graph for each commit row', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('<svg'), 'Should contain SVG element');
      assert.ok(html.includes('commit-graph'), 'Should have commit-graph container');
    });

    it('should render SVG for multiple commit rows', () => {
      const node1 = makeCommitNode(
        {},
        {
          hash: 'aaa1111111111111111111111111111111111111111',
          shortHash: 'aaa1111',
          parents: ['bbb2222222222222222222222222222222222222222'],
        }
      );
      const node2 = makeCommitNode(
        {},
        {
          hash: 'bbb2222222222222222222222222222222222222222',
          shortHash: 'bbb2222',
          parents: [],
        }
      );
      node2.graphLines = [];

      const html = provider._getGraphPanelHtml([node1, node2]);

      const svgCount = (html.match(/<svg/g) || []).length;
      assert.strictEqual(svgCount, 2, 'Should have 2 SVG elements for 2 commits');
    });

    it('should render circle elements in the SVG for commit nodes', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(html.includes('<circle'), 'Should contain circle element for commit node');
    });
  });

  describe('Multiple commits rendering', () => {
    it('should render all commits in order', () => {
      const nodes = [
        makeCommitNode(
          {},
          {
            shortHash: 'first11',
            hash: 'first1100000000000000000000000000000000000000',
            message: 'First commit',
          }
        ),
        makeCommitNode(
          {},
          {
            shortHash: 'second2',
            hash: 'second2200000000000000000000000000000000000000',
            message: 'Second commit',
          }
        ),
        makeCommitNode(
          {},
          {
            shortHash: 'third33',
            hash: 'third3300000000000000000000000000000000000000',
            message: 'Third commit',
          }
        ),
      ];

      const html = provider._getGraphPanelHtml(nodes);

      assert.ok(html.includes('First commit'), 'Should contain first commit message');
      assert.ok(html.includes('Second commit'), 'Should contain second commit message');
      assert.ok(html.includes('Third commit'), 'Should contain third commit message');

      // Verify order: first should appear before second, second before third
      const firstIdx = html.indexOf('First commit');
      const secondIdx = html.indexOf('Second commit');
      const thirdIdx = html.indexOf('Third commit');
      assert.ok(firstIdx < secondIdx, 'First commit should appear before second');
      assert.ok(secondIdx < thirdIdx, 'Second commit should appear before third');
    });
  });

  describe('Selected commits', () => {
    it('should mark selected commits with selected class', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash });
      const selected = new Set([hash]);

      const html = provider._getGraphPanelHtml([node], selected);

      assert.ok(html.includes('selected'), 'Should have selected class');
      assert.ok(html.includes('aria-selected="true"'), 'Should have aria-selected true');
    });

    it('should not mark unselected commits', () => {
      const node = makeCommitNode({}, { hash: 'abc1234567890abcdef1234567890abcdef123456' });
      const selected = new Set(['different_hash']);

      const html = provider._getGraphPanelHtml([node], selected);

      // The commit-row should not have the selected class
      const rowMatch = html.match(/class="commit-row\s*"/);
      assert.ok(rowMatch, 'Should have commit-row without selected class');
      assert.ok(html.includes('aria-selected="false"'), 'Should have aria-selected false');
    });
  });

  describe('HTML escaping', () => {
    it('should escape special characters in commit messages', () => {
      const node = makeCommitNode({}, { message: 'Fix <script>alert("xss")</script> bug' });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(!html.includes('<script>'), 'Should escape script tags');
      assert.ok(html.includes('&lt;script&gt;'), 'Should contain escaped script tag');
    });

    it('should escape special characters in author names', () => {
      const node = makeCommitNode(
        {},
        {
          author: { name: "O'Brien & Co <test>", email: 'test@example.com' },
        }
      );
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(!html.includes('<test>'), 'Should escape angle brackets in author name');
    });
  });

  describe('Accessibility', () => {
    it('should have role="listbox" on the container', () => {
      const html = provider._getGraphPanelHtml([]);
      assert.ok(html.includes('role="listbox"'), 'Should have listbox role');
    });

    it('should have role="option" on each commit row', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);
      assert.ok(html.includes('role="option"'), 'Should have option role on rows');
    });

    it('should have aria-label on the container', () => {
      const html = provider._getGraphPanelHtml([]);
      assert.ok(html.includes('aria-label="Commit Graph"'), 'Should have aria-label');
    });

    it('should have tabindex on commit rows', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);
      assert.ok(html.includes('tabindex="0"'), 'Should have tabindex for keyboard navigation');
    });
  });

  describe('Absolute date formatting in graph view', () => {
    // The row renders dates via formatCommitDate, which always emits a
    // locale-aware absolute timestamp (date + time, no seconds) — never
    // a relative "2h"/"yesterday" label, and never the legacy
    // "MMM dd yyyy" / "YYYY-MM-DD H:MM AM/PM" forms.
    it('should show the locale-aware absolute timestamp for a 2024 commit', () => {
      const recentDate = new Date(2024, 5, 15, 10, 5, 0); // June 15, 2024
      const node = makeCommitNode({}, { authorDate: recentDate });
      const html = provider._getGraphPanelHtml([node]);
      assert.ok(
        html.includes(expectedCommitDate(recentDate)),
        `Should show the locale-aware absolute timestamp; got: ${html}`
      );
      assert.ok(!html.includes('2024-06-15'), 'Legacy YYYY-MM-DD format must no longer appear');
      assert.ok(!html.includes('Jun 15 2024'), 'Legacy "MMM dd yyyy" form must no longer appear');
    });

    it('should include the time component (the new form is date + time)', () => {
      const afternoonDate = new Date(2024, 0, 1, 14, 30, 0); // Jan 1, 2024
      const node = makeCommitNode({}, { authorDate: afternoonDate });
      const html = provider._getGraphPanelHtml([node]);
      assert.ok(
        html.includes(expectedCommitDate(afternoonDate)),
        `Should show the locale-aware absolute timestamp; got: ${html}`
      );
      assert.ok(!html.includes('Jan 01 2024'), 'Legacy "MMM dd yyyy" form must no longer appear');
    });

    it('should show the locale-aware absolute timestamp for old commits', () => {
      const oldDate = new Date(2020, 11, 25, 9, 5, 0); // Dec 25, 2020
      const node = makeCommitNode({}, { authorDate: oldDate });
      const html = provider._getGraphPanelHtml([node]);
      assert.ok(
        html.includes(expectedCommitDate(oldDate)),
        `Should show the locale-aware absolute timestamp; got: ${html}`
      );
      assert.ok(!html.includes('Dec 25 2020'), 'Legacy "MMM dd yyyy" form must no longer appear');
    });
  });

  describe('Commit click selection (single and Ctrl/Cmd multi-select)', () => {
    it('should include data-hash attribute on commit rows for event delegation', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        html.includes(`data-hash="${hash}"`),
        'Should have data-hash attribute with the commit hash for event delegation'
      );
    });

    it('should include data-hash attribute for every commit row', () => {
      const nodes = [
        makeCommitNode(
          {},
          { hash: 'aaa1111111111111111111111111111111111111111', shortHash: 'aaa1111' }
        ),
        makeCommitNode(
          {},
          { hash: 'bbb2222222222222222222222222222222222222222', shortHash: 'bbb2222' }
        ),
        makeCommitNode(
          {},
          { hash: 'ccc3333333333333333333333333333333333333333', shortHash: 'ccc3333' }
        ),
      ];
      const html = provider._getGraphPanelHtml(nodes);

      assert.ok(
        html.includes('data-hash="aaa1111111111111111111111111111111111111111"'),
        'First commit should have data-hash attribute'
      );
      assert.ok(
        html.includes('data-hash="bbb2222222222222222222222222222222222222222"'),
        'Second commit should have data-hash attribute'
      );
      assert.ok(
        html.includes('data-hash="ccc3333333333333333333333333333333333333333"'),
        'Third commit should have data-hash attribute'
      );
    });

    it('should have data-hash attribute on commit rows for modifier key detection via event delegation', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);

      // The data-hash attribute is used by event delegation to identify the commit
      assert.ok(
        html.includes('data-hash="'),
        'Should have data-hash attribute for event delegation click handling'
      );
    });

    it('should mark selected commits with selected class and aria-selected true', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash });
      const selected = new Set([hash]);

      const html = provider._getGraphPanelHtml([node], selected);

      assert.ok(html.includes('class="commit-row selected"'), 'Should have selected class');
      assert.ok(html.includes('aria-selected="true"'), 'Should have aria-selected true');
    });

    it('should not mark unselected commits as selected', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash });
      const selected = new Set<string>(); // empty selection

      const html = provider._getGraphPanelHtml([node], selected);

      const rowMatch = html.match(/class="commit-row\s*"/);
      assert.ok(rowMatch, 'Should have commit-row without selected class');
      assert.ok(html.includes('aria-selected="false"'), 'Should have aria-selected false');
    });

    it('should support multi-select by marking multiple commits as selected', () => {
      const hash1 = 'aaa1111111111111111111111111111111111111111';
      const hash2 = 'bbb2222222222222222222222222222222222222222';
      const node1 = makeCommitNode({}, { hash: hash1, shortHash: 'aaa1111' });
      const node2 = makeCommitNode({}, { hash: hash2, shortHash: 'bbb2222' });
      const selected = new Set([hash1, hash2]);

      const html = provider._getGraphPanelHtml([node1, node2], selected);

      // Both rows should be selected
      const selectedCount = (html.match(/class="commit-row selected"/g) || []).length;
      assert.strictEqual(selectedCount, 2, 'Both commit rows should have selected class');

      const ariaSelectedTrueCount = (html.match(/aria-selected="true"/g) || []).length;
      assert.strictEqual(
        ariaSelectedTrueCount,
        2,
        'Both commit rows should have aria-selected true'
      );
    });

    it('should only mark the selected commit when one of many is selected', () => {
      const hash1 = 'aaa1111111111111111111111111111111111111111';
      const hash2 = 'bbb2222222222222222222222222222222222222222';
      const hash3 = 'ccc3333333333333333333333333333333333333333';
      const node1 = makeCommitNode({}, { hash: hash1, shortHash: 'aaa1111' });
      const node2 = makeCommitNode({}, { hash: hash2, shortHash: 'bbb2222' });
      const node3 = makeCommitNode({}, { hash: hash3, shortHash: 'ccc3333' });
      const selected = new Set([hash2]); // only middle one selected

      const html = provider._getGraphPanelHtml([node1, node2, node3], selected);

      const selectedCount = (html.match(/class="commit-row selected"/g) || []).length;
      assert.strictEqual(selectedCount, 1, 'Only one commit row should have selected class');

      // Verify the correct one is selected
      const ariaSelectedTrueCount = (html.match(/aria-selected="true"/g) || []).length;
      assert.strictEqual(
        ariaSelectedTrueCount,
        1,
        'Only one commit should have aria-selected true'
      );

      const ariaSelectedFalseCount = (html.match(/aria-selected="false"/g) || []).length;
      assert.strictEqual(ariaSelectedFalseCount, 2, 'Two commits should have aria-selected false');
    });
  });

  describe('Commit context menu with all required options', () => {
    it('should contain Copy Revision Number option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('Copy Revision Number'),
        'Should contain Copy Revision Number option'
      );
    });

    it('should contain Create Patch option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Create Patch'), 'Should contain Create Patch option');
    });

    it('should contain Cherry-Pick option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Cherry-Pick'), 'Should contain Cherry-Pick option');
    });

    it('should contain Checkout Revision option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Checkout Revision'), 'Should contain Checkout Revision option');
    });

    it('should contain Show Repository at Revision option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('Show Repository at Revision'),
        'Should contain Show Repository at Revision option'
      );
    });

    it('should contain Compare with Local option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Compare with Local'), 'Should contain Compare with Local option');
    });

    it('should contain Reset Current Branch to Here option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('Reset Current Branch to Here'),
        'Should contain Reset Current Branch to Here option'
      );
    });

    it('should contain Revert Commit option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Revert Commit'), 'Should contain Revert Commit option');
    });

    it('should contain Undo Commit option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Undo Commit'), 'Should contain Undo Commit option');
    });

    it('should contain Drop Commit option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Drop Commit'), 'Should contain Drop Commit option');
    });

    it('should contain Edit Commit Message option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Edit Commit Message'), 'Should contain Edit Commit Message option');
    });

    it('labels the Edit Commit Message item with a trailing ellipsis (it opens a reword input)', () => {
      const html = provider._getCommitContextMenuHtml();
      const match = html.match(/data-action="editCommitMessage"[^>]*>([^<]*)</);
      assert.ok(match, 'Should find the editCommitMessage menu item');
      const label = match[1];
      assert.ok(
        label.endsWith('…'),
        `Reword menu item label must end with a unicode ellipsis (got "${label}")`
      );
      assert.strictEqual(label, 'Edit Commit Message…');
    });

    it('should contain Merge into Current Branch option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('Merge into Current Branch'),
        'Should contain Merge into Current Branch option'
      );
    });

    it('should contain Interactively Rebase from Here option', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('Interactively Rebase from Here'),
        'Should contain Interactively Rebase from Here option'
      );
    });

    it('should contain all 15 required context menu options', () => {
      const html = provider._getCommitContextMenuHtml();
      const requiredOptions = [
        'Copy Revision Number',
        'Create Patch',
        'Cherry-Pick',
        'Checkout Revision',
        'Show Repository at Revision',
        'Compare with Local',
        'Reset Current Branch to Here',
        'Revert Commit',
        'Undo Commit',
        'Drop Commit',
        'Edit Commit Message',
        'Merge into Current Branch',
        'Interactively Rebase from Here',
        'New Branch',
        'New Tag',
      ];
      for (const option of requiredOptions) {
        assert.ok(html.includes(option), `Should contain "${option}" option`);
      }
    });

    it('should have correct data-action attributes for all menu items', () => {
      const html = provider._getCommitContextMenuHtml();
      const requiredActions = [
        'copyHash',
        'createPatch',
        'cherryPick',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'resetToHere',
        'revert',
        'undoCommit',
        'dropCommit',
        'editCommitMessage',
        'mergeIntoCurrent',
        'interactiveRebase',
        'newBranch',
        'newTag',
      ];
      for (const action of requiredActions) {
        assert.ok(html.includes(`data-action="${action}"`), `Should have data-action="${action}"`);
      }
    });

    it('exposes New Branch… (Git.CreateNewBranch.FromCommit) as a single-only item', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = html.indexOf('data-action="newBranch"');
      assert.ok(idx !== -1, 'Should expose the newBranch action');
      const item = html.substring(idx, idx + 140);
      assert.ok(item.includes('data-multi-action="single-only"'), 'newBranch is single-only');
      assert.ok(item.includes('New Branch…'), 'New Branch label uses the unicode ellipsis');
    });

    it('exposes New Tag… (Git.CreateNewTag) as a single-only item', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = html.indexOf('data-action="newTag"');
      assert.ok(idx !== -1, 'Should expose the newTag action');
      const item = html.substring(idx, idx + 140);
      assert.ok(item.includes('data-multi-action="single-only"'), 'newTag is single-only');
      assert.ok(item.includes('New Tag…'), 'New Tag label uses the unicode ellipsis');
    });

    it('groups New Branch… / New Tag… with the branch-operations cluster', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = (action: string) => html.indexOf(`data-action="${action}"`);
      // git4idea Git.Log.ContextMenu places CreateNewBranch.FromCommit +
      // CreateNewTag immediately after the BranchOperationGroup (Compare with
      // Branch / Merge into Current).
      assert.ok(idx('mergeIntoCurrent') < idx('newBranch'), 'Merge before New Branch');
      assert.ok(idx('newBranch') < idx('newTag'), 'New Branch before New Tag');
    });

    it('exposes Fixup… (Git.Fixup.To.Commit) as a single-only item', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = html.indexOf('data-action="fixup"');
      assert.ok(idx !== -1, 'Should expose the fixup action');
      const item = html.substring(idx, idx + 140);
      assert.ok(item.includes('data-multi-action="single-only"'), 'fixup is single-only');
      assert.ok(item.includes('Fixup…'), 'Fixup label uses the unicode ellipsis');
    });

    it('exposes Squash Into… (Git.Squash.Into.Commit) as a single-only item', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = html.indexOf('data-action="squashInto"');
      assert.ok(idx !== -1, 'Should expose the squashInto action');
      const item = html.substring(idx, idx + 140);
      assert.ok(item.includes('data-multi-action="single-only"'), 'squashInto is single-only');
      assert.ok(item.includes('Squash Into…'), 'Squash Into label uses the unicode ellipsis');
    });

    it('orders Reword → Fixup… → Squash Into… per git4idea Git.Log.ContextMenu', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = (action: string) => html.indexOf(`data-action="${action}"`);
      // git4idea places Fixup / Squash Into immediately after Reword
      // (editCommitMessage), and before the existing with-previous rewrites.
      assert.ok(idx('editCommitMessage') < idx('fixup'), 'Reword before Fixup');
      assert.ok(idx('fixup') < idx('squashInto'), 'Fixup before Squash Into');
      assert.ok(
        idx('squashInto') < idx('fixupWithPrevious'),
        'Squash Into before Fixup with Previous'
      );
    });

    it('should render the commit context menu as hidden by default', () => {
      const html = provider._getCommitContextMenuHtml();
      const menuStart = html.indexOf('id="commit-context-menu"');
      assert.ok(menuStart !== -1, 'Should have commit-context-menu element');
      const menuSection = html.substring(menuStart - 50, menuStart + 100);
      assert.ok(menuSection.includes('hidden'), 'Should be hidden by default');
    });

    it('should have role="menu" for accessibility', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('role="menu"'), 'Should have role="menu" for accessibility');
    });

    it('should have role="menuitem" on each menu item', () => {
      const html = provider._getCommitContextMenuHtml();
      const menuItemCount = (html.match(/role="menuitem"/g) || []).length;
      // Added two multi-select-only items: squashCommits + compareVersions.
      // Added three single-only items: squashWithPrevious
      // fixupWithPrevious and compareWithBranch. 15 + 3 = 18.
      // Plus Copy Commit Message (#P3 Vcs.Log.CopySubjectText) = 19.
      // Plus pushUpToCommit (Gap B IntelliJ Git.PushUpToHere parity) = 20.
      // G9: goToParent + goToChild = 22.
      // Git.CreateNewBranch.FromCommit + Git.CreateNewTag = 24.
      // Git.Fixup.To.Commit + Git.Squash.Into.Commit = 26.
      assert.strictEqual(menuItemCount, 26, 'Should have 26 menu items with role="menuitem"');
    });

    it('should have aria-label on the menu', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('aria-label="Commit actions"'), 'Should have aria-label');
    });

    it('includes Copy Commit Message (#P3 Vcs.Log.CopySubjectText)', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('data-action="copyCommitMessage"'),
        'Should expose the copyCommitMessage action'
      );
      assert.ok(html.includes('>Copy Commit Message<'), 'Should label it');
    });

    it('should mark Reset Current Branch to Here as a danger action', () => {
      const html = provider._getCommitContextMenuHtml();
      const resetIdx = html.indexOf('data-action="resetToHere"');
      assert.ok(resetIdx !== -1, 'Should have resetToHere action');
      const resetSection = html.substring(Math.max(0, resetIdx - 100), resetIdx);
      assert.ok(
        resetSection.includes('context-menu-danger'),
        'Reset Current Branch to Here should have danger class'
      );
    });

    it('should mark Drop Commit as a danger action', () => {
      const html = provider._getCommitContextMenuHtml();
      const dropIdx = html.indexOf('data-action="dropCommit"');
      assert.ok(dropIdx !== -1, 'Should have dropCommit action');
      const dropSection = html.substring(Math.max(0, dropIdx - 100), dropIdx);
      assert.ok(
        dropSection.includes('context-menu-danger'),
        'Drop Commit should have danger class'
      );
    });

    it('orders the history block to match git4idea Git.Log.ContextMenu (Reset at the head)', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = (action: string) => html.indexOf(`data-action="${action}"`);
      // The destructive/undo trio leads the history block, mirroring
      // git4idea's Reset → Revert → Uncommit ordering.
      assert.ok(idx('resetToHere') < idx('revert'), 'Reset before Revert');
      assert.ok(idx('revert') < idx('undoCommit'), 'Revert before Undo');
      // Reset is no longer buried beneath the history-rewrite actions.
      assert.ok(idx('resetToHere') < idx('editCommitMessage'), 'Reset before Edit Commit Message');
      assert.ok(idx('resetToHere') < idx('dropCommit'), 'Reset before Drop Commit');
      assert.ok(idx('resetToHere') < idx('mergeIntoCurrent'), 'Reset before Merge into Current');
      // Branch-integration actions still follow the history-rewrite block.
      assert.ok(idx('dropCommit') < idx('mergeIntoCurrent'), 'history rewrite before integration');
    });

    it('should have data-head-hash attribute on the menu root element', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('data-head-hash='), 'Should have data-head-hash attribute');
    });

    it('should not contain any context-menu-icon elements', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        !html.includes('context-menu-icon'),
        'Should not contain any context-menu-icon elements'
      );
    });

    it('should have five context-menu-separator dividers between six sections', () => {
      const html = provider._getCommitContextMenuHtml();
      const separatorCount = (html.match(/context-menu-separator/g) || []).length;
      // Added two new sections.
      //   Section 4 (was: just rebase ops): squashWithPrevious +
      // fixupWithPrevious.
      //   Section 5 (new): compareWithBranch + mergeIntoCurrent +
      //     interactiveRebase. Pre-K's section 4 (merge + rebase) absorbed
      //     compareWithBranch as the first entry — IntelliJ groups
      //     "Compare with Branch" near the rebase/merge actions.
      // Net: 3 separators → 4, 4 sections → 5.
      // Gap B: pushUpToCommit added in its own section 6. 4 → 5 separators.
      // G9: goToParent + goToChild added in section 7. 5 → 6 separators.
      assert.strictEqual(separatorCount, 6, 'Should have 6 separators between 7 sections');
    });
  });

  describe('Commit rows have data-hash attribute for context menu event delegation', () => {
    it('should include data-hash attribute on commit rows for context menu event delegation', () => {
      const hash = 'abc1234567890abcdef1234567890abcdef123456';
      const node = makeCommitNode({}, { hash });
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        html.includes(`data-hash="${hash}"`),
        'Should have data-hash attribute for context menu event delegation'
      );
    });

    it('should include data-hash attribute for every commit row for context menu handling', () => {
      const nodes = [
        makeCommitNode(
          {},
          { hash: 'aaa1111111111111111111111111111111111111111', shortHash: 'aaa1111' }
        ),
        makeCommitNode(
          {},
          { hash: 'bbb2222222222222222222222222222222222222222', shortHash: 'bbb2222' }
        ),
      ];
      const html = provider._getGraphPanelHtml(nodes);

      assert.ok(
        html.includes('data-hash="aaa1111111111111111111111111111111111111111"'),
        'First commit should have data-hash attribute for context menu'
      );
      assert.ok(
        html.includes('data-hash="bbb2222222222222222222222222222222222222222"'),
        'Second commit should have data-hash attribute for context menu'
      );
    });

    it('should not include the commit context menu HTML in the graph panel output (moved to top-level layout)', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        !html.includes('id="commit-context-menu"'),
        'Graph panel should NOT include the commit context menu overlay (it is at the top-level layout)'
      );
    });

    it('should not include the commit context menu HTML in graph panel even when no commits are provided (moved to top-level layout)', () => {
      const html = provider._getGraphPanelHtml([]);

      assert.ok(
        !html.includes('id="commit-context-menu"'),
        'Graph panel should NOT include the commit context menu overlay even with no commits (it is at the top-level layout)'
      );
    });
  });

  describe('Extension host: selectCommit clears previous selection', () => {
    // `getSelectedCommits` now projects through `commitNodes`
    // (display-order contract for consumers). These tests need a
    // populated commit list so the selection actually has somewhere to be
    // visible from the projection.
    beforeEach(() => {
      provider.updateLogState([
        makeCommit({ hash: 'aaa1111111111111111111111111111111111111111', parents: [] }),
        makeCommit({
          hash: 'bbb2222222222222222222222222222222222222222',
          parents: ['aaa1111111111111111111111111111111111111111'],
        }),
        makeCommit({
          hash: 'ccc3333333333333333333333333333333333333333',
          parents: ['bbb2222222222222222222222222222222222222222'],
        }),
      ]);
    });

    it('selectCommit should clear previous selection and select only the new commit', () => {
      // Simulate selecting two commits via toggle, then single-select a new one
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');
      provider.toggleCommitSelection('bbb2222222222222222222222222222222222222222');

      // Now single-select a different commit
      provider.selectCommit('ccc3333333333333333333333333333333333333333');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 1, 'Should have exactly one selected commit');
      assert.strictEqual(
        selected[0],
        'ccc3333333333333333333333333333333333333333',
        'Should be the newly selected commit'
      );
    });

    it('selectCommit should replace existing single selection', () => {
      provider.selectCommit('aaa1111111111111111111111111111111111111111');
      provider.selectCommit('bbb2222222222222222222222222222222222222222');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 1, 'Should have exactly one selected commit');
      assert.strictEqual(
        selected[0],
        'bbb2222222222222222222222222222222222222222',
        'Should be the last selected commit'
      );
    });
  });

  describe('Extension host: toggleCommitSelection adds/removes from multi-select set', () => {
    // Same fixture as above.
    beforeEach(() => {
      provider.updateLogState([
        makeCommit({ hash: 'aaa1111111111111111111111111111111111111111', parents: [] }),
        makeCommit({
          hash: 'bbb2222222222222222222222222222222222222222',
          parents: ['aaa1111111111111111111111111111111111111111'],
        }),
        makeCommit({
          hash: 'ccc3333333333333333333333333333333333333333',
          parents: ['bbb2222222222222222222222222222222222222222'],
        }),
      ]);
    });

    it('toggleCommitSelection should add a commit to the selection set', () => {
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 1, 'Should have one selected commit');
      assert.ok(
        selected.includes('aaa1111111111111111111111111111111111111111'),
        'Should contain the toggled commit'
      );
    });

    it('toggleCommitSelection should remove a commit if already selected', () => {
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(
        selected.length,
        0,
        'Should have no selected commits after toggling twice'
      );
    });

    it('toggleCommitSelection should build up a multi-select set', () => {
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');
      provider.toggleCommitSelection('bbb2222222222222222222222222222222222222222');
      provider.toggleCommitSelection('ccc3333333333333333333333333333333333333333');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 3, 'Should have three selected commits');
    });

    it('toggleCommitSelection should remove only the toggled commit from multi-select', () => {
      provider.toggleCommitSelection('aaa1111111111111111111111111111111111111111');
      provider.toggleCommitSelection('bbb2222222222222222222222222222222222222222');
      provider.toggleCommitSelection('ccc3333333333333333333333333333333333333333');

      // Remove the middle one
      provider.toggleCommitSelection('bbb2222222222222222222222222222222222222222');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 2, 'Should have two selected commits');
      assert.ok(
        !selected.includes('bbb2222222222222222222222222222222222222222'),
        'Should not contain the removed commit'
      );
      assert.ok(
        selected.includes('aaa1111111111111111111111111111111111111111'),
        'Should still contain first commit'
      );
      assert.ok(
        selected.includes('ccc3333333333333333333333333333333333333333'),
        'Should still contain third commit'
      );
    });
  });

  describe('Incremental commit loading', () => {
    it('should include data-loaded-count and data-total-available attributes when provided', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 200, 500);

      assert.ok(
        html.includes('data-loaded-count="200"'),
        'Should have data-loaded-count attribute'
      );
      assert.ok(
        html.includes('data-total-available="500"'),
        'Should have data-total-available attribute'
      );
    });

    it('should show loading indicator when more commits are available', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 200, 500);

      assert.ok(html.includes('graph-loading-indicator'), 'Should have loading indicator');
      assert.ok(html.includes('Loading more commits...'), 'Should have loading text');
      assert.ok(html.includes('200 of 500'), 'Should show loaded/total counts');
    });

    it('should not show loading indicator when all commits are loaded', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 500, 500);

      assert.ok(
        !html.includes('graph-loading-indicator'),
        'Should not have loading indicator when all loaded'
      );
      assert.ok(
        !html.includes('Loading more commits...'),
        'Should not have loading text when all loaded'
      );
    });

    it('should not show loading indicator when loadedCount and totalAvailable are not provided', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node]);

      assert.ok(
        !html.includes('graph-loading-indicator'),
        'Should not have loading indicator by default'
      );
    });

    it('should default data attributes to commitNodes length when not provided', () => {
      const nodes = [
        makeCommitNode(
          {},
          { hash: 'aaa1111111111111111111111111111111111111111', shortHash: 'aaa1111' }
        ),
        makeCommitNode(
          {},
          { hash: 'bbb2222222222222222222222222222222222222222', shortHash: 'bbb2222' }
        ),
      ];
      const html = provider._getGraphPanelHtml(nodes);

      assert.ok(
        html.includes('data-loaded-count="2"'),
        'Should default loaded count to nodes length'
      );
      assert.ok(
        html.includes('data-total-available="2"'),
        'Should default total available to nodes length'
      );
    });

    it('should show loading indicator with correct counts for incremental batches', () => {
      const nodes = Array.from({ length: 3 }, (_, i) =>
        makeCommitNode(
          {},
          {
            hash: `hash${i}${'0'.repeat(36)}`,
            shortHash: `hash${i}`,
            message: `Commit ${i}`,
          }
        )
      );
      const html = provider._getGraphPanelHtml(nodes, undefined, 300, 1000);

      assert.ok(html.includes('data-loaded-count="300"'), 'Should have updated loaded count');
      assert.ok(html.includes('data-total-available="1000"'), 'Should have total available');
      assert.ok(html.includes('300 of 1000'), 'Should show correct counts in loading text');
    });

    it('should still render commit rows correctly with incremental loading params', () => {
      const node = makeCommitNode(
        {},
        {
          hash: 'abc1234567890abcdef1234567890abcdef123456',
          shortHash: 'abc1234',
          message: 'Test commit',
        }
      );
      const html = provider._getGraphPanelHtml([node], undefined, 200, 500);

      assert.ok(html.includes('abc1234'), 'Should still render commit short hash');
      assert.ok(html.includes('Test commit'), 'Should still render commit message');
      assert.ok(html.includes('commit-row'), 'Should still have commit rows');
    });

    it('should not show loading indicator when loadedCount equals totalAvailable', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 100, 100);

      assert.ok(!html.includes('graph-loading-indicator'), 'Should not show loading indicator');
    });

    it('should show loading indicator when loadedCount is less than totalAvailable', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 99, 100);

      assert.ok(html.includes('graph-loading-indicator'), 'Should show loading indicator');
    });

    it('should include loading spinner element in the loading indicator', () => {
      const node = makeCommitNode();
      const html = provider._getGraphPanelHtml([node], undefined, 200, 500);

      assert.ok(html.includes('loading-spinner'), 'Should have loading spinner');
    });
  });

  describe('Extension host: _handleLoadMoreCommits fires event', () => {
    it('should fire onDidRequestLoadMoreCommits event when loadMoreCommits message is received', (done) => {
      provider.onDidRequestLoadMoreCommits(() => {
        done();
      });

      // Simulate the message handling by calling the internal handler
      (provider as unknown as { _handleLoadMoreCommits: () => void })._handleLoadMoreCommits();
    });
  });

  describe('Constants: INITIAL_COMMIT_LOAD_COUNT and INCREMENTAL_COMMIT_LOAD_COUNT', () => {
    it('should export INITIAL_COMMIT_LOAD_COUNT as 200', () => {
      // Import the constants via a typed static import so the re-exported
      // literals remain checkable instead of landing as `any`.
      const { INITIAL_COMMIT_LOAD_COUNT } = gitToolWindowProvider;
      assert.strictEqual(INITIAL_COMMIT_LOAD_COUNT, 200, 'Initial load count should be 200');
    });

    it('should export INCREMENTAL_COMMIT_LOAD_COUNT as 100', () => {
      const { INCREMENTAL_COMMIT_LOAD_COUNT } = gitToolWindowProvider;
      assert.strictEqual(
        INCREMENTAL_COMMIT_LOAD_COUNT,
        100,
        'Incremental load count should be 100'
      );
    });
  });
});
