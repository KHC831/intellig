/**
 * Branch-focus integration tests against the GitToolWindowProvider.
 *
 * Covers:
 *  - setFocusedBranch mutates _extendedLogState.focusedBranchName
 *  - setFocusedBranch posts an updateBranchFocus partial-update message
 *  - the rendered branch labels carry .branch-label-focused on the
 *    matching chip + a data-branch-name attribute escaped via _escapeHtml
 *  - updateLogState clears focus when the focused branch is no longer
 *    in the new branch list (mirrors the anchorHash lifecycle)
 *  - the webview message handler routes focusBranchOnGraph through to
 *    setFocusedBranch
 *  - getMergeBase result drives _focusedPathHashes; a stub that returns
 *    the merge-base hash is enough to verify on-path tagging
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
} from '../../../../ui-shell/GitToolWindowProvider';
import type { ICommitNode } from '../../../../git-core/commitGraph';
import { Uri } from '../../../mocks/vscode';

interface FocusInternals {
  _extendedLogState: IExtendedLogState;
  _focusedPathHashes: Set<string>;
  _attachedGitService?: unknown;
  _handleWebviewMessage(message: { type: string; branchName?: string | null }): void;
  _view?: { webview?: { postMessage: (msg: unknown) => Thenable<boolean> } };
  _getBranchLabelsHtml(node: ICommitNode): string;
  _availableRepositories: unknown[];
  _selectedRepositoryIndex: number;
}

function mkCommit(
  hash: string,
  parents: string[] = []
): {
  hash: string;
  shortHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authorDate: Date;
  commitDate: Date;
} {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

function stubWebview(provider: GitToolWindowProvider): {
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: Record<string, unknown>) => {
        messages.push(msg);
        return Promise.resolve(true);
      },
      cspSource: 'test:',
      asWebviewUri: (u: vscode.Uri) => u,
      html: '',
    },
    visible: true,
    show: () => {},
    title: 'test',
    description: '',
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  };
  return { messages };
}

describe('Wave D — Branch focus on graph (D2 + D3)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('setFocusedBranch mutates focusedBranchName to the resolved name', async () => {
    const internals = provider as unknown as FocusInternals;
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap.set('aaa', [{ name: 'feature', type: 'local' }]);
    branchMap.set('bbb', [{ name: 'main', type: 'local' }]);
    provider.updateLogState([mkCommit('aaa', ['bbb']), mkCommit('bbb')], branchMap);

    await provider.setFocusedBranch('feature');

    assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');
  });

  it('setFocusedBranch posts an updateBranchFocus message to the webview', async () => {
    const { messages } = stubWebview(provider);
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap.set('aaa', [{ name: 'feature', type: 'local' }]);
    branchMap.set('bbb', [{ name: 'main', type: 'local' }]);
    provider.updateLogState([mkCommit('aaa', ['bbb']), mkCommit('bbb')], branchMap);
    messages.length = 0;

    await provider.setFocusedBranch('feature');

    const focusUpdates = messages.filter((m) => m.type === 'updateBranchFocus');
    assert.strictEqual(focusUpdates.length, 1, 'expected exactly one updateBranchFocus message');
    const update = focusUpdates[0] as {
      type: string;
      focusedBranchName: string | null;
      focusedHash: string | null;
    };
    assert.strictEqual(update.focusedBranchName, 'feature');
    assert.strictEqual(update.focusedHash, 'aaa');
    // focusedPathHashes was dropped from the payload (path data flows
    // host-side only); make sure it's NOT present.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(update, 'focusedPathHashes'),
      false,
      'focusedPathHashes must NOT be on the wire (Senior M-3 dropped it)'
    );
  });

  it('_getBranchLabelsHtml emits .branch-label-focused on the focused chip only', async () => {
    const internals = provider as unknown as FocusInternals;
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap.set('aaa', [
      { name: 'feature', type: 'local' },
      { name: 'main', type: 'local' },
    ]);
    provider.updateLogState([mkCommit('aaa')], branchMap);

    await provider.setFocusedBranch('feature');
    const html = internals._getBranchLabelsHtml(internals._extendedLogState.commitNodes[0]);

    // The focused chip carries the focus class + data-branch-name attr.
    // After the chip-collapse tightening (UX request: only HEAD's
    // current branch and the focused branch stay inline), "main" is
    // NOT the current branch (no headBranchName set in this test) and
    // NOT the focused branch, so it collapses into the +N summary chip.
    // The focused chip still survives inline because it's privileged.
    assert.ok(
      html.includes('class="branch-label-local branch-label-focused" data-branch-name="feature"'),
      `expected focused chip span; got: ${html}`
    );
    assert.ok(
      !html.includes('data-branch-name="main"'),
      `non-focused, non-current "main" should collapse into +N summary, not render inline; got: ${html}`
    );
    assert.ok(
      html.includes('branch-label-collapsed') && html.includes('data-collapsed-branches="main"'),
      `"main" should appear inside the collapsed summary chip; got: ${html}`
    );
  });

  it('updateLogState clears focusedBranchName when the focused branch is gone', async () => {
    const internals = provider as unknown as FocusInternals;
    const branchMap1 = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap1.set('aaa', [{ name: 'feature', type: 'local' }]);
    branchMap1.set('bbb', [{ name: 'main', type: 'local' }]);
    provider.updateLogState([mkCommit('aaa', ['bbb']), mkCommit('bbb')], branchMap1);

    await provider.setFocusedBranch('feature');
    assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');

    // Refresh: the new branch list no longer contains "feature".
    const branchMap2 = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap2.set('bbb', [{ name: 'main', type: 'local' }]);
    provider.updateLogState([mkCommit('bbb')], branchMap2);

    assert.strictEqual(
      internals._extendedLogState.focusedBranchName,
      null,
      'focusedBranchName must be cleared when branch absent from new list'
    );
    assert.strictEqual(
      internals._focusedPathHashes.size,
      0,
      '_focusedPathHashes must be cleared too'
    );
  });

  it('webview focusBranchOnGraph message routes through to setFocusedBranch', () => {
    const internals = provider as unknown as FocusInternals;
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap.set('aaa', [{ name: 'feature', type: 'local' }]);
    provider.updateLogState([mkCommit('aaa')], branchMap);

    internals._handleWebviewMessage({
      type: 'focusBranchOnGraph',
      branchName: 'feature',
    });

    // setFocusedBranch is async (Promise), but the focused-branch-name
    // mutation happens synchronously after the resolveBranchTipHash
    // lookup; the async lookup is only the merge-base call which we
    // don't have a service for here. State should already be set.
    assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');
  });

  it('getMergeBase stub drives the focused path set (D3)', async () => {
    const internals = provider as unknown as FocusInternals;
    // Stub IGitService with just getMergeBase — the path the BFS walks.
    let mergeBaseCalls = 0;
    internals._attachedGitService = {
      getMergeBase: async (
        _repo: unknown,
        refA: string,
        refB: string
      ): Promise<string | undefined> => {
        mergeBaseCalls += 1;
        // We expect HEAD vs feature; the merge-base is "ccc".
        assert.strictEqual(refA, 'HEAD');
        assert.strictEqual(refB, 'feature');
        return 'ccc';
      },
    };
    // Stub repository so getSelectedRepository returns truthy.
    internals._availableRepositories = [{ rootUri: { fsPath: '/tmp/repo' } }];
    internals._selectedRepositoryIndex = 0;

    // Display order:
    //   * aaa  (feature tip)
    //   * bbb
    //   * ccc  (merge base — also HEAD's ancestor)
    //   * ddd
    const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
    branchMap.set('aaa', [{ name: 'feature', type: 'local' }]);
    provider.updateLogState(
      [
        mkCommit('aaa', ['bbb']),
        mkCommit('bbb', ['ccc']),
        mkCommit('ccc', ['ddd']),
        mkCommit('ddd'),
      ],
      branchMap
    );

    await provider.setFocusedBranch('feature');

    assert.strictEqual(mergeBaseCalls, 1, 'getMergeBase must be called once');
    const path = internals._focusedPathHashes;
    assert.ok(path.has('aaa'), 'aaa (tip) on path');
    assert.ok(path.has('bbb'), 'bbb on path');
    assert.ok(path.has('ccc'), 'ccc (merge base) on path');
    assert.ok(!path.has('ddd'), 'ddd is below merge base — not on path');

    // And the commit nodes are tagged accordingly.
    const tagged = internals._extendedLogState.commitNodes;
    const aaaNode = tagged.find((n) => n.commit.hash === 'aaa')!;
    const dddNode = tagged.find((n) => n.commit.hash === 'ddd')!;
    assert.strictEqual(aaaNode.onFocusedBranchPath, true);
    assert.strictEqual(dddNode.onFocusedBranchPath, false);
  });

  // ─── Chip-collapse rules (UX fix #35) ─────────────────────────
  // Only HEAD's current branch and the focused branch render inline.
  // Everything else collapses into the +N summary chip — a row tagged
  // by origin/foo + upstream/foo + fork/foo + main no longer eats the
  // whole commit row.
  describe('chip collapse: only HEAD-branch + focused branch stay inline', () => {
    it('keeps the current branch chip inline; collapses the rest', () => {
      const internals = provider as unknown as FocusInternals;
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('aaa', [
        { name: 'main', type: 'local' },
        { name: 'origin/main', type: 'remote' },
        { name: 'upstream/main', type: 'remote' },
      ]);
      provider.updateLogState([mkCommit('aaa')], branchMap, undefined, 'aaa', 'main');

      const html = internals._getBranchLabelsHtml(internals._extendedLogState.commitNodes[0]);

      // The current branch chip is inline.
      assert.ok(
        html.includes('data-branch-name="main"'),
        `current branch "main" should render inline; got: ${html}`
      );
      // The two remotes do NOT render inline.
      assert.ok(
        !html.includes('data-branch-name="origin/main"'),
        `non-current "origin/main" should not be an inline chip; got: ${html}`
      );
      assert.ok(
        !html.includes('data-branch-name="upstream/main"'),
        `non-current "upstream/main" should not be an inline chip; got: ${html}`
      );
      // They DO appear in the collapsed summary chip.
      assert.ok(
        html.includes('branch-label-collapsed'),
        `expected a collapsed summary chip when multiple non-privileged refs are present; got: ${html}`
      );
    });

    it('keeps both current and focused branch chips inline when they differ', async () => {
      const internals = provider as unknown as FocusInternals;
      // getMergeBase stub — required for setFocusedBranch's BFS.
      internals._attachedGitService = {
        getMergeBase: async (): Promise<string | undefined> => 'aaa',
      };
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('aaa', [
        { name: 'main', type: 'local' },
        { name: 'feature', type: 'local' },
        { name: 'origin/main', type: 'remote' },
      ]);
      provider.updateLogState([mkCommit('aaa')], branchMap, undefined, 'aaa', 'main');
      await provider.setFocusedBranch('feature');

      const html = internals._getBranchLabelsHtml(internals._extendedLogState.commitNodes[0]);

      assert.ok(html.includes('data-branch-name="main"'), 'current branch inline');
      assert.ok(
        html.includes('data-branch-name="feature"'),
        'focused branch inline (focus class also applied)'
      );
      assert.ok(
        !html.includes('data-branch-name="origin/main"'),
        'non-privileged remote collapses'
      );
      assert.ok(html.includes('branch-label-collapsed'), 'expected the collapsed summary chip');
    });

    it('falls back to top-2 inline when no privileged ref is known (e.g. detached HEAD with no focus)', () => {
      // Without headBranchName or focusedBranchName, the chip collapse
      // has no signal about which chips matter. The fallback preserves
      // the prior "top 2 inline, rest collapsed" cap rather than
      // collapsing every chip — otherwise rows with 1-2 refs would
      // shrink to a single +N chip with no visible branch name, which
      // would be a regression from the pre-tightening UX.
      const internals = provider as unknown as FocusInternals;
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('aaa', [
        { name: 'a', type: 'local' },
        { name: 'b', type: 'local' },
        { name: 'c', type: 'local' },
      ]);
      // No headBranchName arg → state.headBranchName is undefined.
      provider.updateLogState([mkCommit('aaa')], branchMap);

      const html = internals._getBranchLabelsHtml(internals._extendedLogState.commitNodes[0]);

      assert.ok(html.includes('data-branch-name="a"'), 'first 2 inline');
      assert.ok(html.includes('data-branch-name="b"'), 'first 2 inline');
      assert.ok(!html.includes('data-branch-name="c"'), 'third collapses');
      assert.ok(html.includes('branch-label-collapsed'), 'expected the collapsed summary chip');
    });
  });
});
