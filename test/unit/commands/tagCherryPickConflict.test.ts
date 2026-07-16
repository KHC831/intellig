/**
 * tag.cherryPick conflict arm — hand off to the Resolve Conflicts dialog.
 *
 * Every sibling cherry-pick path (branch-scoped picker, commit context menu)
 * routes `result.conflicts` into the dialog; the tag entry dead-ended in a
 * toast, leaving the sequencer mid-cherry-pick with no resolve/abort
 * affordance. git4idea reference: GitCherryPicker's conflict flow opens the
 * conflict resolver. Cherry-pick is a forward operation — no ours/theirs
 * reversal.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IGitService, IRepository, ITag } from '../../../src/git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../../../src/conflicts/interfaces/IConflictResolutionService';
import { Uri } from '../../mocks/vscode';
import { installWarningMessageTracker, restoreMessageFunctions } from '../../typed/windowStub';

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
    cherryPick: () => okAsync({ success: false, conflicts: ['src/a.ts', 'src/b.ts'] }),
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as IGitService;
}

function tagItem(name: string): BranchTreeItem {
  const tag: ITag = { name, commit: 'abc1234', isAnnotated: true };
  return new BranchTreeItem(name, 0, 'tag', undefined, tag, false);
}

describe('tag.cherryPick — conflict handoff', () => {
  afterEach(() => restoreMessageFunctions());

  it('opens the Resolve Conflicts dialog with operation cherryPick and the tag as target', async () => {
    const repo = makeRepo();
    installWarningMessageTracker();
    const dialogCalls: Array<{
      conflicts: unknown[];
      options: { operation: string; target?: string };
    }> = [];
    const conflictService = {
      openResolveConflictsDialog: async (
        _repo: IRepository,
        conflicts: unknown[],
        options: { operation: string; target?: string }
      ) => {
        dialogCalls.push({ conflicts, options });
      },
    } as unknown as IConflictResolutionService;
    const cmds = new BranchContextMenuCommands(makeService(), makeProvider(repo), conflictService);

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(dialogCalls.length, 1, 'conflicts must open the Resolve Conflicts dialog');
    assert.strictEqual(dialogCalls[0].options.operation, 'cherryPick');
    assert.strictEqual(dialogCalls[0].options.target, 'v1.0.0');
    assert.strictEqual(dialogCalls[0].conflicts.length, 2);
  });

  it('keeps the warning toast as the no-service fallback', async () => {
    const repo = makeRepo();
    const warn = installWarningMessageTracker();
    const cmds = new BranchContextMenuCommands(makeService(), makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(warn.calls.length, 1);
    assert.match(warn.calls[0].message, /conflict/i);
  });
});
