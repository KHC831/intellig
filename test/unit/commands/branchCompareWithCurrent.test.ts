/**
 * branch.compareWithCurrent — route to the Branch Comparison View.
 *
 * git4idea parity: GitCompareWithBranchAction opens GitCompareBranchesUi (a
 * comparison surface), not a notification. BranchComparisonView already
 * exists and serves the commit context menu's "Compare with Branch…"; the
 * branch-menu entry must route there too, with the info-toast summary kept
 * only as the no-view fallback.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import type { BranchComparisonView } from '../../../src/branches/BranchComparisonView';
import { IBranch, IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { installInfoMessageTracker, restoreMessageFunctions } from '../../typed/windowStub';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function makeProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

function makeService(): IGitService {
  return {
    compareBranches: async () => ({ aheadCount: 1, behindCount: 2, changedFiles: [] }),
  } as unknown as IGitService;
}

function localItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

describe('branch.compareWithCurrent — comparison view routing', () => {
  afterEach(() => restoreMessageFunctions());

  it('routes to BranchComparisonView.show(current, clicked) when wired', async () => {
    const repo = makeRepo();
    const info = installInfoMessageTracker();
    const showCalls: Array<{ branch1?: string; branch2?: string }> = [];
    const view = {
      show: async (_repo: IRepository, branch1?: string, branch2?: string) => {
        showCalls.push({ branch1, branch2 });
        return { compared: true };
      },
    } as unknown as BranchComparisonView;
    const cmds = new BranchContextMenuCommands(makeService(), makeProvider(repo));
    cmds.setBranchComparisonView(view);

    await driveBranchMenuCommand(cmds, 'intellig.branch.compareWithCurrent', localItem('feature'));

    assert.deepStrictEqual(showCalls, [{ branch1: 'main', branch2: 'feature' }]);
    assert.strictEqual(info.calls.length, 0, 'no summary toast when the view opens');
  });

  it('falls back to the summary toast when no view is wired', async () => {
    const repo = makeRepo();
    const info = installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(makeService(), makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.compareWithCurrent', localItem('feature'));

    assert.strictEqual(info.calls.length, 1, 'legacy toast remains the no-view fallback');
    assert.match(info.calls[0].message, /ahead/);
  });
});
