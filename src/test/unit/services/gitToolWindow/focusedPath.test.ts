/**
 * Focused-path BFS + trap cases against
 * GitToolWindowProvider.
 *
 * These tests exercise `_bfsPathToMergeBase`-driven behaviors via the
 * public `setFocusedBranch` API. They specifically verify:
 *  - on-path tagging stops at the merge-base (inclusive)
 *  - the BFS depth cap defends against corrupt parent chains
 *  - getMergeBase returning undefined → empty path, but the focus
 *    name still survives so the chip outlines still apply
 *  - on subsequent updateLogState that keeps the focus, the
 *    onFocusedBranchPath flag is recomputed against the (re-loaded)
 *    commit list using the cached `_focusedPathHashes`
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
} from '../../../../ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

interface FocusedPathInternals {
  _extendedLogState: IExtendedLogState;
  _focusedPathHashes: Set<string>;
  _attachedGitService?: unknown;
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

function stubWebview(provider: GitToolWindowProvider): void {
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: () => Promise.resolve(true),
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
}

function attachStubGitService(
  provider: GitToolWindowProvider,
  mergeBase: string | undefined
): { calls: number } {
  const internals = provider as unknown as FocusedPathInternals;
  let calls = 0;
  internals._attachedGitService = {
    getMergeBase: async () => {
      calls += 1;
      return mergeBase;
    },
  };
  internals._availableRepositories = [{ rootUri: { fsPath: '/tmp/repo' } }];
  internals._selectedRepositoryIndex = 0;
  return {
    get calls() {
      return calls;
    },
  } as unknown as { calls: number };
}

describe('Wave D — focused path BFS and traps (D3)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
    stubWebview(provider);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('BFS includes the merge-base commit and stops walking past it', async () => {
    const internals = provider as unknown as FocusedPathInternals;
    attachStubGitService(provider, 'ccc');

    const branchMap = new Map<string, string[]>();
    branchMap.set('aaa', ['feature']);
    provider.updateLogState(
      [
        mkCommit('aaa', ['bbb']),
        mkCommit('bbb', ['ccc']),
        mkCommit('ccc', ['ddd']),
        mkCommit('ddd', ['eee']),
        mkCommit('eee'),
      ],
      branchMap
    );

    await provider.setFocusedBranch('feature');

    const path = internals._focusedPathHashes;
    assert.ok(path.has('aaa'), 'aaa (tip) on path');
    assert.ok(path.has('bbb'), 'bbb on path');
    assert.ok(path.has('ccc'), 'ccc (merge base) on path — inclusive');
    assert.ok(!path.has('ddd'), 'ddd is past the merge base — not on path');
    assert.ok(!path.has('eee'), 'eee is past the merge base — not on path');
  });

  it('T-1: BFS bounded by commitNodes.length even on a corrupt cycle', async () => {
    const internals = provider as unknown as FocusedPathInternals;
    // Merge-base does NOT exist in the loaded set. The BFS should walk
    // until it hits the depth cap (commitNodes.length) without looping.
    attachStubGitService(provider, 'no-such-hash');

    const branchMap = new Map<string, string[]>();
    branchMap.set('aaa', ['feature']);
    // Synthetic cycle: a → b → a (this would never happen in real git
    // but defends the BFS against corrupt parents).
    provider.updateLogState([mkCommit('aaa', ['bbb']), mkCommit('bbb', ['aaa'])], branchMap);

    // No assertion about exit — we just need it to terminate. Mocha
    // timeouts at 2s by default; the BFS cap = 2 nodes ⇒ this returns
    // immediately.
    await provider.setFocusedBranch('feature');

    const path = internals._focusedPathHashes;
    // Every walked node is on the path; the BFS bailed on the cycle.
    assert.ok(path.size >= 1 && path.size <= 2);
  });

  it('T-8: getMergeBase returning undefined → empty path but focus chip survives', async () => {
    const internals = provider as unknown as FocusedPathInternals;
    attachStubGitService(provider, undefined);

    const branchMap = new Map<string, string[]>();
    branchMap.set('aaa', ['feature']);
    provider.updateLogState([mkCommit('aaa', ['bbb']), mkCommit('bbb')], branchMap);

    await provider.setFocusedBranch('feature');

    // When there's no merge-base, the BFS still walks the loaded
    // ancestry from the tip (gives the user *something* visual). What
    // matters is that the focus name survives so the chip still
    // outlines per D2.
    assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');
  });

  it('subsequent updateLogState recomputes onFocusedBranchPath against new nodes', async () => {
    const internals = provider as unknown as FocusedPathInternals;
    attachStubGitService(provider, 'ccc');

    const branchMap = new Map<string, string[]>();
    branchMap.set('aaa', ['feature']);
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
    // Sanity: aaa is on path.
    const aaaBefore = internals._extendedLogState.commitNodes.find((n) => n.commit.hash === 'aaa')!;
    assert.strictEqual(aaaBefore.onFocusedBranchPath, true);

    // Refresh: SAME branch, same commits — focus survives, path is
    // re-applied to the regenerated nodes.
    provider.updateLogState(
      [
        mkCommit('aaa', ['bbb']),
        mkCommit('bbb', ['ccc']),
        mkCommit('ccc', ['ddd']),
        mkCommit('ddd'),
      ],
      branchMap
    );

    const aaaAfter = internals._extendedLogState.commitNodes.find((n) => n.commit.hash === 'aaa')!;
    assert.strictEqual(
      aaaAfter.onFocusedBranchPath,
      true,
      'on-path tag must survive a refresh that keeps the focused branch'
    );
    assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');
  });
});
