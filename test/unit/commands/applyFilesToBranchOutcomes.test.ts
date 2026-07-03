/**
 * Unit tests for the "Apply Files to Branch" outcome contract.
 *
 * The flow stashes any dirty state, checks out the target branch, and
 * cherry-picks (`-n`, file subset) onto it. The outcome contract:
 *
 *  - CONFLICT: the user stays on the target branch to resolve — the cleanup
 *    must NOT switch back over the unmerged index, and must NOT pop the
 *    auto-stash onto the conflicted tree (the stash is announced instead).
 *  - SUCCESS: staged changes cannot be "left on" a branch you switch away
 *    from, so the flow prompts for a commit message and commits on the
 *    target before returning to the original branch and popping the stash.
 *  - CANCELLED COMMIT PROMPT: the user stays on the target with the changes
 *    staged (announced via a warning); no switch-back, no pop.
 *  - The auto-stash pop is PINNED to the entry the flow created (by sha),
 *    so an entry pushed in between never causes a wrong-stash pop.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { registerCommitMenuCommands } from '../../../src/commands/registration/commitMenuCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IBranch,
  IGitService,
  IRepository,
  IStash,
} from '../../../src/git-core/interfaces/IGitService';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
  type MessageTracker,
} from '../../typed/windowStub';

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

function patchRegisterCommand(): { handlers: CapturedHandler[]; restore: () => void } {
  const handlers: CapturedHandler[] = [];
  const cmds = vscode.commands as unknown as {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { dispose: () => void };
  };
  const original = cmds.registerCommand;
  cmds.registerCommand = (id, cb) => {
    handlers.push({ id, cb });
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      cmds.registerCommand = original;
    },
  };
}

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: {
      gitService,
      conflictResolutionService: undefined,
    },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

function localBranch(name: string, commit = 'a'.repeat(40)): IBranch {
  return { name, type: 'local', commit, isHead: false };
}

function stashEntry(index: number, hash: string): IStash {
  return { index, message: 'auto', date: new Date(), hash };
}

const DIRTY_STATUS = [
  { path: 'dirty.ts', indexStatus: ' ', workTreeStatus: 'M' },
] as unknown as Awaited<ReturnType<IGitService['getStatus']>>;

describe('Apply Files to Branch — outcome contract', () => {
  let patch: ReturnType<typeof patchRegisterCommand>;
  let errorTracker: MessageTracker;
  let infoTracker: MessageTracker;
  let warningTracker: MessageTracker;
  const originalQuickPick = writableWindow().showQuickPick;
  const originalInputBox = writableWindow().showInputBox;

  afterEach(() => {
    restoreMessageFunctions();
    writableWindow().showQuickPick = originalQuickPick;
    writableWindow().showInputBox = originalInputBox;
    if (patch) {
      patch.restore();
    }
  });

  /** Register the commands and return the apply-files handler. */
  function applyFilesHandler(gitService: IGitService): (...args: unknown[]) => unknown {
    patch = patchRegisterCommand();
    registerCommitMenuCommands(makeContext(gitService));
    const found = patch.handlers.find((h) => h.id === 'intellig.commit.applyFilesToBranch');
    assert.ok(found, 'apply-files-to-branch command should be registered');
    return found.cb;
  }

  /** First QuickPick = target branch; second = file subset (select all). */
  function stubPickers(): void {
    let call = 0;
    writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> => {
      call += 1;
      return Promise.resolve(call === 1 ? { label: 'feature' } : items);
    };
  }

  function installTrackers(): void {
    errorTracker = installErrorMessageTracker();
    infoTracker = installInfoMessageTracker();
    warningTracker = installWarningMessageTracker();
  }

  it('conflict: stays on the target branch and does not pop the auto-stash', async () => {
    const repo: IRepository = attachedRepo('main');
    const checkoutCalls: string[] = [];
    const popCalls: number[] = [];
    const gitService = createMockGitService(repo, {
      getRepositories: () => [repo],
      getBranches: async () => [localBranch('main'), localBranch('feature')],
      getStatus: async () => DIRTY_STATUS,
      stashList: async () => [stashEntry(0, 'S1')],
      getCommitDiff: async () => [
        { path: 'src/a.ts', status: 'modified', hunks: [], binary: false },
      ],
      checkout: (_repo: IRepository, ref: string) => {
        checkoutCalls.push(ref);
        return okAsync(undefined);
      },
      cherryPick: () => okAsync({ success: false, conflicts: ['src/a.ts'] }),
      stashPop: (_repo: IRepository, index: number) => {
        popCalls.push(index);
        return okAsync(undefined);
      },
    });

    stubPickers();
    installTrackers();

    const handler = applyFilesHandler(gitService);
    await handler({ hash: 'b'.repeat(40) });

    assert.deepStrictEqual(
      checkoutCalls,
      ['feature'],
      'must not switch back over the unmerged index'
    );
    assert.deepStrictEqual(popCalls, [], 'must not pop the stash onto a conflicted tree');
    assert.ok(
      warningTracker.calls.some((c) => /stash/i.test(c.message)),
      'should tell the user their original changes remain stashed'
    );
    assert.strictEqual(errorTracker.calls.length, 0, 'a routed conflict is not an error toast');
  });

  it('success: commits on the target with the prompted message, then returns and pops the PINNED stash', async () => {
    const repo: IRepository = attachedRepo('main');
    const checkoutCalls: string[] = [];
    const popCalls: number[] = [];
    const commitCalls: string[] = [];
    // First stashList (right after the push) reports our entry at the head;
    // by pop time ANOTHER entry has appeared, renumbering ours to index 1.
    let stashListCall = 0;
    const gitService = createMockGitService(repo, {
      getRepositories: () => [repo],
      getBranches: async () => [localBranch('main'), localBranch('feature')],
      getStatus: async () => DIRTY_STATUS,
      stashList: async () => {
        stashListCall += 1;
        return stashListCall === 1
          ? [stashEntry(0, 'S1')]
          : [stashEntry(0, 'OTHER'), stashEntry(1, 'S1')];
      },
      getCommitDiff: async () => [
        { path: 'src/a.ts', status: 'modified', hunks: [], binary: false },
      ],
      checkout: (_repo: IRepository, ref: string) => {
        checkoutCalls.push(ref);
        return okAsync(undefined);
      },
      cherryPick: () => okAsync({ success: true }),
      commit: (_repo: IRepository, message: string) => {
        commitCalls.push(message);
        return okAsync(undefined);
      },
      stashPop: (_repo: IRepository, index: number) => {
        popCalls.push(index);
        return okAsync(undefined);
      },
    });

    stubPickers();
    writableWindow().showInputBox = async () => 'apply src/a.ts from b';
    installTrackers();

    const handler = applyFilesHandler(gitService);
    await handler({ hash: 'b'.repeat(40) });

    assert.deepStrictEqual(
      commitCalls,
      ['apply src/a.ts from b'],
      'should commit the applied changes on the target with the prompted message'
    );
    assert.deepStrictEqual(
      checkoutCalls,
      ['feature', 'main'],
      'should return to the original branch after committing'
    );
    assert.deepStrictEqual(popCalls, [1], 'must pop the CREATED entry (renumbered), not stash@{0}');
    assert.strictEqual(errorTracker.calls.length, 0);
    assert.ok(
      infoTracker.calls.some((c) => /committed/i.test(c.message)),
      'success toast should say the changes were committed'
    );
  });

  it('cancelled commit prompt: stays on the target with the changes staged; no pop', async () => {
    const repo: IRepository = attachedRepo('main');
    const checkoutCalls: string[] = [];
    const popCalls: number[] = [];
    const gitService = createMockGitService(repo, {
      getRepositories: () => [repo],
      getBranches: async () => [localBranch('main'), localBranch('feature')],
      getStatus: async () => DIRTY_STATUS,
      stashList: async () => [stashEntry(0, 'S1')],
      getCommitDiff: async () => [
        { path: 'src/a.ts', status: 'modified', hunks: [], binary: false },
      ],
      checkout: (_repo: IRepository, ref: string) => {
        checkoutCalls.push(ref);
        return okAsync(undefined);
      },
      cherryPick: () => okAsync({ success: true }),
      stashPop: (_repo: IRepository, index: number) => {
        popCalls.push(index);
        return okAsync(undefined);
      },
    });

    stubPickers();
    writableWindow().showInputBox = async () => undefined; // user cancels
    installTrackers();

    const handler = applyFilesHandler(gitService);
    await handler({ hash: 'b'.repeat(40) });

    assert.deepStrictEqual(
      checkoutCalls,
      ['feature'],
      'a cancelled commit prompt must not drag the staged changes back to the original branch'
    );
    assert.deepStrictEqual(popCalls, [], 'must not pop the original-branch stash onto the target');
    assert.ok(
      warningTracker.calls.some((c) => /staged/i.test(c.message)),
      'should explain the changes are staged (uncommitted) on the target'
    );
  });
});
