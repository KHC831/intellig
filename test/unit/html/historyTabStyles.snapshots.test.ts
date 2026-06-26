/**
 * Visual_Parity_Snapshot tests for the History tab commit-row layout
 * (Requirement 1 — efficient column spacing in the commit history rows).
 *
 * These freeze the emitted column markup so any change to the
 * `.history-commit-row` grid, the author/date single-line+ellipsis rule, or
 * the left-to-right cell order surfaces as a deliberate snapshot diff.
 *
 * NO new test framework and NO `--update-snapshots` opacity — same
 * inline-frozen-literal pattern used by
 * `test/unit/utils/commitGraphSnapshots.test.ts`: the expected literal
 * lives in the test, and a legitimate render change is a hand-edit of the
 * frozen string under review.
 *
 * _Requirements: 1.3, 1.8_
 */

import '../../setup';
import * as assert from 'assert';
import {
  historyTabStyles,
  renderCommitRow,
} from '../../../src/git-core/gitToolWindow/html/historyHtml';
import type { IHistoryTabState } from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

// A minimal, deterministic default state (mirrors
// `createInitialHistoryTabState()` without pulling the HistoryTab class's
// `vscode` runtime import into this pure-render snapshot).
const DEFAULT_STATE: IHistoryTabState = {
  filePath: 'src/app.ts',
  commits: [],
  selectedCommit: undefined,
  compareCommit: undefined,
  branchFilter: undefined,
  lineRange: undefined,
  followRenames: false,
  availableBranches: [],
  error: undefined,
  loading: false,
  affectedPaths: [],
  affectedPathsLoading: false,
  affectedPathsError: undefined,
};

describe('git-view-layout-parity / Req 1 — History row layout Visual_Parity_Snapshot', () => {
  // ─── snap: historyTabStyles() grid + ellipsis rule ─────────────────────
  it('snap-history-css: .history-commit-row grid pins the fixed/max column widths with no slack track', () => {
    const css = historyTabStyles();

    // Frozen literal — a leading `auto` track holds the mini commit-graph
    // gutter (sized to its SVG), the subject is the ONLY slack track
    // (`minmax(0, 1fr)`), and author/date are capped (`minmax(0, 14ch)` /
    // `minmax(0, 10ch)`) so no flexible track sits between them. `gap: 8px`
    // is the single uniform inter-column gap.
    const EXPECTED_ROW_RULE =
      '.history-commit-row { display: grid; grid-template-columns: auto 7ch minmax(0, 1fr) minmax(0, 14ch) minmax(0, 10ch); gap: 8px; padding: 2px 8px; cursor: pointer; align-items: center; }';
    assert.ok(
      css.includes(EXPECTED_ROW_RULE),
      `historyTabStyles() must emit the exact .history-commit-row grid rule.\nExpected to contain:\n${EXPECTED_ROW_RULE}\nGot:\n${css}`
    );

    // The grid must NOT use the bare-track form (slack between
    // author and date, no minmax on the subject).
    assert.ok(
      !css.includes('grid-template-columns: 7ch 1fr 14ch 10ch'),
      'historyTabStyles() must not emit the pre-fix `7ch 1fr 14ch 10ch` grid (re-introduces the wasted author/date gap)'
    );
  });

  it('snap-history-css: author/date cells are single-line with ellipsis', () => {
    const css = historyTabStyles();

    const EXPECTED_AUTHOR_DATE_RULE =
      '.history-commit-author, .history-commit-date { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }';
    assert.ok(
      css.includes(EXPECTED_AUTHOR_DATE_RULE),
      `historyTabStyles() must emit the exact author/date rule with nowrap + ellipsis.\nExpected to contain:\n${EXPECTED_AUTHOR_DATE_RULE}\nGot:\n${css}`
    );
  });

  // ─── snap: renderCommitRow() left-to-right cell order ──────────────────
  it('snap-history-row: renderCommitRow emits hash → subject → author → date in order', () => {
    const commit: ICommit = {
      hash: 'abcdef1234567890abcdef1234567890abcdef12',
      shortHash: 'abcdef1',
      message: 'Fix the thing',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      parents: ['0000000000000000000000000000000000000000'],
      authorDate: new Date('2024-01-15T12:00:00Z'),
      commitDate: new Date('2024-01-15T12:00:00Z'),
    };

    // `toLocaleDateString()` is locale/timezone-dependent, so the date cell is
    // computed the same way the renderer does and interpolated into the frozen
    // literal — keeping the snapshot deterministic across environments while
    // still freezing the structure, classes, and left-to-right cell order.
    const date = new Date(commit.authorDate).toLocaleDateString();

    // The graph cell is the empty placeholder span here: `renderCommitRow` is
    // called without a graph node (the node is supplied by `renderCommitList`,
    // which runs `generateCommitGraph` over the whole window). The placeholder
    // keeps the row's column count stable when no node is available.
    const expected = `
    <div class="history-commit-row" data-rev="abcdef1234567890abcdef1234567890abcdef12" role="listitem" title="Fix the thing">
      <span class="history-commit-graph" aria-hidden="true"></span>
      <span class="history-commit-hash">abcdef1</span>
      <span class="history-commit-subject">Fix the thing</span>
      <span class="history-commit-author">Ada Lovelace</span>
      <span class="history-commit-date">${date}</span>
    </div>
  `;

    assert.strictEqual(renderCommitRow(commit, DEFAULT_STATE), expected);
  });

  it('snap-history-row: a multi-line message keeps only the first line in the subject cell', () => {
    const commit: ICommit = {
      hash: 'abcdef1234567890abcdef1234567890abcdef12',
      shortHash: 'abcdef1',
      message: 'Fix the thing\n\nbody that must not leak into the subject cell',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      parents: [],
      authorDate: new Date('2024-01-15T12:00:00Z'),
      commitDate: new Date('2024-01-15T12:00:00Z'),
    };

    const html = renderCommitRow(commit, DEFAULT_STATE);
    assert.ok(
      html.includes('<span class="history-commit-subject">Fix the thing</span>'),
      'subject cell must carry only the first line of the message'
    );
    assert.ok(
      !html.includes('<span class="history-commit-subject">Fix the thing\n'),
      'multi-line body must not leak into the .history-commit-subject cell'
    );
  });

  it('snap-history-row: the four cells appear strictly left-to-right', () => {
    const commit: ICommit = {
      hash: 'abcdef1234567890abcdef1234567890abcdef12',
      shortHash: 'abcdef1',
      message: 'Fix the thing',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      parents: [],
      authorDate: new Date('2024-01-15T12:00:00Z'),
      commitDate: new Date('2024-01-15T12:00:00Z'),
    };

    const html = renderCommitRow(commit, DEFAULT_STATE);
    const hashIdx = html.indexOf('history-commit-hash');
    const subjectIdx = html.indexOf('history-commit-subject');
    const authorIdx = html.indexOf('history-commit-author');
    const dateIdx = html.indexOf('history-commit-date');

    assert.ok(hashIdx >= 0, 'row must contain .history-commit-hash');
    assert.ok(subjectIdx > hashIdx, '.history-commit-subject must follow .history-commit-hash');
    assert.ok(authorIdx > subjectIdx, '.history-commit-author must follow .history-commit-subject');
    assert.ok(dateIdx > authorIdx, '.history-commit-date must follow .history-commit-author');
  });
});
