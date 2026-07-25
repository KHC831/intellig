/**
 * branch.mergeIntoCurrent — deleteOnMerge PROPOSE eligibility.
 *
 * The branch entry computes PROPOSE for a non-protected LOCAL branch
 * (GitBranchPopupActions.java:287-291) and threads it to the Merge Dialog;
 * the no-opener fallback path posts the same "Delete <branch>" offer on its
 * own success toast.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IBranch, IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

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

function localItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

interface Recording {
  deleted: string[];
}

function makeService(): IGitService & Recording {
  const deleted: string[] = [];
  return {
    deleted,
    mergeBranch: async () => ({ success: true, mergeCommit: 'abc123' }),
    deleteBranch: (_repo: IRepository, name: string) => {
      deleted.push(name);
      return okAsync(undefined);
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as IGitService & Recording;
}

function installChoosingInfoTracker(choice?: string): Array<{ message: string; items: string[] }> {
  const calls: Array<{ message: string; items: string[] }> = [];
  writableWindow().showInformationMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    calls.push({ message, items });
    return Promise.resolve(choice && items.includes(choice) ? choice : undefined);
  };
  return calls;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('branch.mergeIntoCurrent — deleteOnMerge PROPOSE', () => {
  afterEach(() => {
    restoreMessageFunctions();
    resetMockConfiguration();
  });

  it('fallback path: merge success offers Delete <branch> and deletes on accept', async () => {
    const repo = makeRepo();
    const service = makeService();
    const info = installChoosingInfoTracker('Delete feature');
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.mergeIntoCurrent', localItem('feature'));
    await settle();

    assert.ok(
      info.some((c) => c.items.includes('Delete feature')),
      `merge success must PROPOSE deleting the merged branch; got: ${JSON.stringify(info)}`
    );
    assert.deepStrictEqual(service.deleted, ['feature']);
  });

  it('fallback path: no PROPOSE for a protected branch', async () => {
    setMockConfigValue('intellig', 'protectedBranches', ['release']);
    const repo = makeRepo();
    const service = makeService();
    const info = installChoosingInfoTracker('Delete release');
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.mergeIntoCurrent', localItem('release'));
    await settle();

    assert.ok(
      !info.some((c) => c.items.includes('Delete release')),
      'protected branch must not be proposed for deletion'
    );
    assert.deepStrictEqual(service.deleted, []);
  });

  it('dialog path: threads proposeDeleteOnMerge=true for a non-protected local branch', async () => {
    const repo = makeRepo();
    const service = makeService();
    installChoosingInfoTracker();
    const openerCalls: Array<{ sourceBranch: string; proposeDeleteOnMerge?: boolean }> = [];
    const cmds = new BranchContextMenuCommands(
      service,
      makeProvider(repo),
      undefined,
      undefined,
      (p) => {
        openerCalls.push({
          sourceBranch: p.sourceBranch,
          proposeDeleteOnMerge: p.proposeDeleteOnMerge,
        });
        return undefined;
      }
    );

    await driveBranchMenuCommand(cmds, 'intellig.branch.mergeIntoCurrent', localItem('feature'));

    assert.strictEqual(openerCalls.length, 1);
    assert.strictEqual(openerCalls[0].proposeDeleteOnMerge, true);
  });

  it('dialog path: threads proposeDeleteOnMerge=false for a protected branch', async () => {
    setMockConfigValue('intellig', 'protectedBranches', ['release']);
    const repo = makeRepo();
    const service = makeService();
    installChoosingInfoTracker();
    const openerCalls: Array<{ proposeDeleteOnMerge?: boolean }> = [];
    const cmds = new BranchContextMenuCommands(
      service,
      makeProvider(repo),
      undefined,
      undefined,
      (p) => {
        openerCalls.push({ proposeDeleteOnMerge: p.proposeDeleteOnMerge });
        return undefined;
      }
    );

    await driveBranchMenuCommand(cmds, 'intellig.branch.mergeIntoCurrent', localItem('release'));

    assert.strictEqual(openerCalls.length, 1);
    assert.strictEqual(openerCalls[0].proposeDeleteOnMerge, false);
  });
});
