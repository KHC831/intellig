/**
 * Unit test: branch click uses the partial-update path and preserves scroll.
 *
 * Feature: git-graph-branch-click-scroll,
 *
 * D1 of the design replaces the full re-render that `_handleBranchClick`
 * previously performed (`_updateWebview()`, which reassigns the webview HTML
 * and resets `.graph-panel` scrollTop to the top) with the partial-update
 * path: `selectCommit(hash)` (posts `selectGraphRow` + `updateDetailsPanel` +
 * `updateMenuEnableState`) followed by `_scrollWebviewToCommit(hash)` (posts
 * `{ type: 'scrollToCommit', commitHash }`). Avoiding the full re-render keeps
 * the panel's scroll position intact so the now visibility-aware inline
 * `scrollToCommit` can measure the user's real scroll position.
 *
 * This test seeds a branch -> commit mapping, taps the webview `postMessage`
 * calls and any assignment to `view.webview.html` (a full re-render assigns
 * html via `_render`), then calls the private `_handleBranchClick` and asserts:
 *   - a `{ type: 'scrollToCommit', commitHash: tipHash }` message is posted,
 *   - a `{ type: 'selectGraphRow', commitHash: tipHash }` message is posted,
 *   - the branch-click path does NOT reassign the full webview HTML (the
 *     `html` setter is never invoked) and posts ONLY partial-update message
 *     types (no full-refresh message),
 *   - selection state matches the resolved tip
 *     (`expandedCommit === tipHash`, `selectedCommits.has(tipHash)`).
 *
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import { invokePrivateHandler } from '../typed/privateHandler';

/** A recorded webview postMessage payload. */
interface IPostedMessage {
  type?: string;
  commitHash?: string;
  [key: string]: unknown;
}

/**
 * The set of message types the partial-update branch-click path is allowed to
 * post. Anything outside this set (or a webview HTML reassignment) would
 * indicate a full re-render leaked back in.
 *
 *   - selectGraphRow / updateDetailsPanel / updateMenuEnableState — posted by
 *     `selectCommit` (the latter via `_postMenuStateUpdate`).
 *   - scrollToCommit — posted by `_scrollWebviewToCommit`.
 */
const ALLOWED_PARTIAL_MESSAGE_TYPES = new Set<string>([
  'selectGraphRow',
  'updateDetailsPanel',
  'updateMenuEnableState',
  'scrollToCommit',
]);

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

/** Build a minimal ICommit for the given hash. */
function mkCommit(hash: string, message: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

describe('Feature: git-graph-branch-click-scroll - branch click uses the partial path and preserves scroll', () => {
  let provider: GitToolWindowProvider;
  let posted: IPostedMessage[];
  let htmlSetCount: number;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    posted = [];
    htmlSetCount = 0;
  });

  afterEach(() => {
    provider.dispose();
  });

  it('posts scrollToCommit + selectGraphRow, performs no full HTML re-render, and selects the tip', () => {
    const tipHash = '1111111111111111111111111111111111111111';
    const branchName = 'feature/x';

    // Seed the log state BEFORE wiring up the view so the `_updateWebview()`
    // inside `updateLogState` no-ops (`_render` early-returns without a view)
    // and does not contaminate the html-set / postMessage taps.
    const commits: ICommit[] = [mkCommit(tipHash, 'tip commit')];
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>([
      [tipHash, [{ name: branchName, type: 'local' }]],
    ]);
    const tagMap = new Map<string, string[]>();
    provider.updateLogState(commits, branchMap, tagMap);

    // Wire up a mock view whose webview records postMessage payloads and any
    // assignment to `html`. A full re-render (`_render`) assigns
    // `view.webview.html`; a getter/setter lets us detect that robustly.
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const internals = provider as any;
    let htmlBacking = '';
    internals._view = {
      webview: {
        get html(): string {
          return htmlBacking;
        },
        set html(v: string) {
          htmlSetCount += 1;
          htmlBacking = v;
        },
        options: {},
        cspSource: 'test:',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (message: IPostedMessage) => {
          posted.push(message);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: unknown) => u,
      },
      visible: true,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

    // Act: click the branch.
    void invokePrivateHandler(provider, '_handleBranchClick', branchName);

    // A scrollToCommit message must be posted with the resolved tip hash.
    const scrollMsg = posted.find((m) => m.type === 'scrollToCommit');
    assert.ok(scrollMsg, 'a { type: "scrollToCommit" } message must be posted on branch click');
    assert.strictEqual(
      scrollMsg?.commitHash,
      tipHash,
      'scrollToCommit must target the resolved branch tip hash'
    );

    // A selectGraphRow message must be posted with the resolved tip hash.
    const selectMsg = posted.find((m) => m.type === 'selectGraphRow');
    assert.ok(selectMsg, 'a { type: "selectGraphRow" } message must be posted on branch click');
    assert.strictEqual(
      selectMsg?.commitHash,
      tipHash,
      'selectGraphRow must target the resolved branch tip hash'
    );

    // No full re-render: the webview HTML must never be reassigned by the
    // branch-click path (that is what would reset the scroll position).
    assert.strictEqual(
      htmlSetCount,
      0,
      'branch click must NOT reassign view.webview.html (no full re-render)'
    );

    // Robustness: every posted message must be a partial-update type. The
    // presence of any other type would imply a full-refresh path leaked in.
    for (const m of posted) {
      assert.ok(
        m.type !== undefined && ALLOWED_PARTIAL_MESSAGE_TYPES.has(m.type),
        `branch click posted an unexpected (non-partial) message type: "${String(m.type)}"`
      );
    }

    // Selection state matches the resolved tip.
    const state = provider.getExtendedLogState();
    assert.strictEqual(
      state.expandedCommit,
      tipHash,
      'expandedCommit must be the resolved branch tip after the click'
    );
    assert.ok(
      state.selectedCommits.has(tipHash),
      'selectedCommits must contain the resolved branch tip after the click'
    );
  });
});
