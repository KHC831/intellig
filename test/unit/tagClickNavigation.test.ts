/**
 * Clicking a TAG in the branches tree must jump the graph to the tagged
 * commit, exactly like clicking a branch jumps to its tip (live-repro bug:
 * tag clicks did nothing — the selection listener only handled `.branch`).
 *
 * Two layers under test:
 *   - `graphTargetForTreeSelection` — the pure routing decision the
 *     selection listener applies (branch → by-name, tag → by-commit,
 *     structural rows → nothing).
 *   - `GitToolWindowProvider.navigateToCommit` — the partial-update jump
 *     (selectGraphRow + scrollToCommit posts, no full HTML re-render),
 *     mirroring `_handleBranchClick`'s contract.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { BranchTreeItem, graphTargetForTreeSelection } from '../../src/branches/BranchTreeProvider';
import { ICommit, IAuthor, IBranch, ITag } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import * as vscode from 'vscode';

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };
const TAG_COMMIT = '2222222222222222222222222222222222222222';

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

function branchItem(): BranchTreeItem {
  const branch: IBranch = { name: 'feature/x', type: 'local' } as IBranch;
  return new BranchTreeItem(
    'feature/x',
    vscode.TreeItemCollapsibleState.None,
    'local-branch',
    branch
  );
}

function tagItem(): BranchTreeItem {
  const tag: ITag = { name: 'v1.0.0', commit: TAG_COMMIT, isAnnotated: true };
  return new BranchTreeItem('v1.0.0', vscode.TreeItemCollapsibleState.None, 'tag', undefined, tag);
}

function categoryItem(): BranchTreeItem {
  return new BranchTreeItem('Local', vscode.TreeItemCollapsibleState.Expanded, 'category');
}

describe('graphTargetForTreeSelection', () => {
  it('routes a branch row to by-name navigation', () => {
    assert.deepStrictEqual(graphTargetForTreeSelection(branchItem()), {
      kind: 'branch',
      name: 'feature/x',
    });
  });

  it('routes a tag row to by-commit navigation', () => {
    assert.deepStrictEqual(graphTargetForTreeSelection(tagItem()), {
      kind: 'commit',
      hash: TAG_COMMIT,
    });
  });

  it('routes structural rows nowhere', () => {
    assert.strictEqual(graphTargetForTreeSelection(categoryItem()), undefined);
  });
});

describe('GitToolWindowProvider.navigateToCommit', () => {
  it('posts selectGraphRow + scrollToCommit for the hash without a full re-render', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    const posted: Array<{ type?: string; commitHash?: string }> = [];
    let htmlSetCount = 0;

    provider.updateLogState([mkCommit(TAG_COMMIT, 'tagged commit')], new Map(), new Map());

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
        postMessage: (message: { type?: string; commitHash?: string }) => {
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

    provider.navigateToCommit(TAG_COMMIT);

    const scrollMsg = posted.find((m) => m.type === 'scrollToCommit');
    assert.ok(scrollMsg, 'scrollToCommit must be posted');
    assert.strictEqual(scrollMsg?.commitHash, TAG_COMMIT);
    const selectMsg = posted.find((m) => m.type === 'selectGraphRow');
    assert.ok(selectMsg, 'selectGraphRow must be posted');
    assert.strictEqual(selectMsg?.commitHash, TAG_COMMIT);
    assert.strictEqual(htmlSetCount, 0, 'no full HTML re-render on a tag jump');

    provider.dispose();
  });
});
