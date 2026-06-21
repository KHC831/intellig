/**
 * Tests for the File History "commit details" pane and the mini commit-graph
 * column added to the revision list.
 *
 * North-star: IntelliJ's file-history details pane is built by
 * `CommitPresentationUtil.formatCommitHashAndAuthor` /
 * `getAuthorAndCommitterText` (platform/vcs-log/impl ...
 * ui/frame/CommitPresentationUtil.java) — it shows the full message, short
 * hash, author name+email, authored/committed dates, and (only when the
 * committer differs from the author) a separate committer line. The mini graph
 * reuses `generateCommitGraph` from `commitGraph.ts`.
 *
 * `buildHistoryDetails` is a pure model builder; `renderHistoryDetails` is a
 * pure render over the tab state. Neither touches the `vscode` runtime import,
 * so the tests construct literals directly.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildHistoryDetails,
  type IHistoryTabState,
} from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import {
  renderHistoryDetails,
  renderHistoryTabBody,
} from '../../../src/git-core/gitToolWindow/html/historyHtml';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

function makeCommit(over: Partial<ICommit> = {}): ICommit {
  return {
    hash: 'abc1234567890abcdef1234567890abcdef12345',
    shortHash: 'abc1234',
    message: 'Fix the thing\n\nLong body explaining the fix.',
    body: 'Long body explaining the fix.',
    author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
    parents: ['parent111111111111111111111111111111111111'],
    authorDate: new Date('2026-01-02T03:04:05Z'),
    commitDate: new Date('2026-01-02T03:04:05Z'),
    ...over,
  };
}

const BASE_STATE: IHistoryTabState = {
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

describe('buildHistoryDetails — model builder', () => {
  it('maps a commit to its full message, hashes, author, dates and parents', () => {
    const d = buildHistoryDetails(makeCommit());
    assert.strictEqual(d!.fullHash, 'abc1234567890abcdef1234567890abcdef12345');
    assert.strictEqual(d!.shortHash, 'abc1234');
    assert.strictEqual(d!.message, 'Fix the thing\n\nLong body explaining the fix.');
    assert.strictEqual(d!.authorName, 'Ada Lovelace');
    assert.strictEqual(d!.authorEmail, 'ada@example.com');
    assert.deepStrictEqual(d!.parents, ['parent111111111111111111111111111111111111']);
  });

  it('omits the committer line when committer is the same person as author', () => {
    const d = buildHistoryDetails(makeCommit());
    assert.strictEqual(d!.committer, undefined, 'no committer line for the same person');
  });

  it('includes a committer line when the committer differs from the author', () => {
    const d = buildHistoryDetails(
      makeCommit({ committer: { name: 'Grace Hopper', email: 'grace@example.com' } })
    );
    const committer = d!.committer;
    assert.ok(committer, 'committer line present when committer differs');
    assert.strictEqual(committer.name, 'Grace Hopper');
    assert.strictEqual(committer.email, 'grace@example.com');
  });

  it('returns undefined when there is no commit to describe', () => {
    assert.strictEqual(buildHistoryDetails(undefined), undefined);
  });
});

describe('renderHistoryDetails — details pane', () => {
  it('renders an empty hint when no revision is selected', () => {
    const html = renderHistoryDetails({ ...BASE_STATE, commits: [], selectedCommit: undefined });
    assert.ok(/select a (revision|commit)/i.test(html), 'empty pane prompts a selection');
  });

  it('renders message, author, full hash and parent for the selected revision', () => {
    const commit = makeCommit();
    const html = renderHistoryDetails({
      ...BASE_STATE,
      commits: [commit],
      selectedCommit: commit.hash,
    });
    assert.ok(html.includes('Fix the thing'), 'message subject must render');
    assert.ok(html.includes('Ada Lovelace'), 'author name must render');
    assert.ok(html.includes('ada@example.com'), 'author email must render');
    assert.ok(html.includes(commit.hash), 'full hash must render');
    assert.ok(
      html.includes('parent111111111111111111111111111111111111'),
      'parent hash must render'
    );
  });

  it('escapes HTML metacharacters in the commit message', () => {
    const commit = makeCommit({ message: 'Pwn <script>alert(1)</script>' });
    const html = renderHistoryDetails({
      ...BASE_STATE,
      commits: [commit],
      selectedCommit: commit.hash,
    });
    assert.ok(!html.includes('<script>'), 'raw markup must not leak into the details pane');
    assert.ok(html.includes('&lt;script&gt;'), 'metacharacters must be escaped');
  });

  it('escapes HTML metacharacters in the author name', () => {
    const commit = makeCommit({ author: { name: '<b>evil</b>', email: 'e@x.com' } });
    const html = renderHistoryDetails({
      ...BASE_STATE,
      commits: [commit],
      selectedCommit: commit.hash,
    });
    assert.ok(!html.includes('<b>evil</b>'), 'raw author markup must not leak');
  });

  it('exposes a copy affordance carrying the full hash', () => {
    const commit = makeCommit();
    const html = renderHistoryDetails({
      ...BASE_STATE,
      commits: [commit],
      selectedCommit: commit.hash,
    });
    assert.ok(
      html.includes(`data-copy-hash="${commit.hash}"`),
      'copy control must carry the full hash as a data attribute'
    );
  });
});

describe('mini commit-graph column', () => {
  it('renders a graph cell with an SVG lane drawing for each revision row', () => {
    const a = makeCommit({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', parents: ['b'.repeat(40)] });
    const b = makeCommit({ hash: 'b'.repeat(40), shortHash: 'bbbbbbb', parents: [] });
    const state: IHistoryTabState = { ...BASE_STATE, commits: [a, b], selectedCommit: a.hash };
    const html = renderHistoryTabBody(state);
    assert.ok(html.includes('history-commit-graph'), 'a graph cell must render in the list');
    const svgCount = (html.match(/<svg/g) ?? []).length;
    assert.strictEqual(svgCount, 2, 'one mini-graph SVG per revision row');
  });

  it('draws an edge line down to the parent for a non-root commit', () => {
    const a = makeCommit({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', parents: ['b'.repeat(40)] });
    const b = makeCommit({ hash: 'b'.repeat(40), shortHash: 'bbbbbbb', parents: [] });
    const state: IHistoryTabState = { ...BASE_STATE, commits: [a, b], selectedCommit: a.hash };
    const html = renderHistoryTabBody(state);
    assert.ok(/<line\b/.test(html), 'the parent edge must render as an SVG line');
  });
});
