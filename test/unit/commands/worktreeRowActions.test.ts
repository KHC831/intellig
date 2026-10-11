/**
 * The actions on a Worktrees row and on the Worktrees category. The context
 * value that gated a row's menu was computed when the tree rendered, so every
 * row action first finds its worktree again in a fresh listing and checks the
 * same capability there ({@link withCurrentWorktree}).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import {
  confirmAndRemoveWorktree,
  handleLockWorktree,
  handleOpenWorktree,
  handlePruneWorktrees,
  handleRemoveWorktree,
  handleUnlockWorktree,
  openWorktreeFolder,
  withCurrentWorktree,
  type IBranchWorktreeContext,
} from '../../../src/branches/branchWorktreeActions';
import type { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import type { WorktreeCapability } from '../../../src/branches/worktreeTreeItems';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { CommandFailedError, GitError } from '../../../src/git-core/errors';
import type {
  IWorktreeCapableService,
  IWorktreeEntry,
  WorktreeRemoveForce,
} from '../../../src/git-core/ops/WorktreeOps';
import { Uri } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableCommands,
  writableWindow,
  writableWorkspace,
} from '../../typed/windowStub';

const REPO = { rootUri: Uri.file('/repo/main') } as unknown as IRepository;

/** A folder that exists, so the listing does not read the worktree as missing. */
function folder(name: string): string {
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, `${name}-`));
}

function entry(over: Partial<IWorktreeEntry>): IWorktreeEntry {
  return {
    path: '/repo/wt',
    head: 'a'.repeat(40),
    branch: 'refs/heads/feature',
    isMain: false,
    isDetached: false,
    isBare: false,
    isLocked: false,
    isPrunable: false,
    ...over,
  };
}

const MAIN = entry({ path: '/repo/main', branch: 'refs/heads/main', isMain: true });

interface Calls {
  lock: Array<{ path: string; reason?: string }>;
  unlock: string[];
  remove: Array<{ path: string; force?: WorktreeRemoveForce }>;
  prune: number;
  refresh: number;
}

function harness(over: Partial<IWorktreeCapableService> = {}): {
  ctx: { -readonly [K in keyof IBranchWorktreeContext]: IBranchWorktreeContext[K] };
  calls: Calls;
} {
  const calls: Calls = { lock: [], unlock: [], remove: [], prune: 0, refresh: 0 };
  const ok = (): ResultAsync<void, GitError> => okAsync(undefined);
  const worktrees: IWorktreeCapableService = {
    listWorktrees: () => okAsync([MAIN]),
    addWorktree: ok,
    lockWorktree: (_r, p, reason) => {
      calls.lock.push({ path: p, reason });
      return okAsync(undefined);
    },
    unlockWorktree: (_r, p) => {
      calls.unlock.push(p);
      return okAsync(undefined);
    },
    removeWorktree: (_r, p, force) => {
      calls.remove.push({ path: p, force });
      return okAsync(undefined);
    },
    pruneWorktrees: () => {
      calls.prune += 1;
      return okAsync(undefined);
    },
    hasUncommittedChanges: () => okAsync(false),
    ...over,
  };
  return {
    calls,
    ctx: {
      worktrees,
      branchTreeProvider: {
        refresh: () => {
          calls.refresh += 1;
        },
      } as unknown as BranchTreeProvider,
      resolveRepository: () => REPO,
    },
  };
}

describe('Worktrees row actions', () => {
  let opened: Array<{ uri: string; forceNewWindow: boolean }>;
  let originalExecute: unknown;

  beforeEach(() => {
    opened = [];
    originalExecute = vscode.commands.executeCommand;
    writableCommands().executeCommand = async (id: string, ...args: unknown[]) => {
      if (id === 'vscode.openFolder') {
        opened.push({
          uri: (args[0] as vscode.Uri).fsPath,
          forceNewWindow: (args[1] as { forceNewWindow: boolean }).forceNewWindow,
        });
      }
      return undefined;
    };
  });

  afterEach(() => {
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = originalExecute;
    writableWorkspace().workspaceFolders = undefined;
    restoreMessageFunctions();
  });

  describe('withCurrentWorktree', () => {
    async function attempt(
      clicked: IWorktreeEntry,
      listed: IWorktreeEntry[],
      capability: WorktreeCapability
    ): Promise<{ acted: IWorktreeEntry[]; calls: Calls }> {
      const { ctx, calls } = harness({ listWorktrees: () => okAsync(listed) });
      const acted: IWorktreeEntry[] = [];
      await withCurrentWorktree(ctx, REPO, clicked, capability, async (wt) => {
        acted.push(wt);
      });
      return { acted, calls };
    }

    it('acts on the worktree as git lists it now, not as the row rendered it', async () => {
      const dir = folder('wt-now');
      const { acted } = await attempt(
        entry({ path: dir }),
        [MAIN, entry({ path: dir, isLocked: true, lockReason: 'since then' })],
        'canUnlock'
      );
      assert.strictEqual(acted.length, 1);
      assert.strictEqual(acted[0].lockReason, 'since then');
    });

    it('refuses, says why and refreshes when the capability is gone', async () => {
      const dir = folder('wt-locked-since');
      const warning = installWarningMessageTracker();
      const { acted, calls } = await attempt(
        entry({ path: dir }),
        [MAIN, entry({ path: dir, isLocked: true })],
        'canLock'
      );
      assert.deepStrictEqual(acted, []);
      assert.match(warning.calls[0].message, /already locked/);
      assert.strictEqual(calls.refresh, 1);
    });

    it('refuses to remove or lock the main worktree', async () => {
      const warning = installWarningMessageTracker();
      assert.deepStrictEqual((await attempt(MAIN, [MAIN], 'canRemove')).acted, []);
      assert.deepStrictEqual((await attempt(MAIN, [MAIN], 'canLock')).acted, []);
      assert.match(warning.calls[0].message, /main worktree cannot be removed/);
      assert.match(warning.calls[1].message, /main worktree cannot be locked/);
    });

    it('refuses to remove a worktree that is a folder of this workspace', async () => {
      const dir = folder('wt-workspace');
      writableWorkspace().workspaceFolders = [{ uri: Uri.file(dir), name: 'wt', index: 1 }];
      const warning = installWarningMessageTracker();
      const { acted } = await attempt(
        entry({ path: dir }),
        [MAIN, entry({ path: dir })],
        'canRemove'
      );
      assert.deepStrictEqual(acted, []);
      assert.match(warning.calls[0].message, /This window has .* open/);
    });

    it('removes a worktree nested in the workspace that is not itself a workspace folder', async () => {
      const dir = folder('wt-nested');
      writableWorkspace().workspaceFolders = [
        { uri: Uri.file('/repo/main'), name: 'main', index: 0 },
      ];
      const { acted } = await attempt(
        entry({ path: dir }),
        [MAIN, entry({ path: dir })],
        'canRemove'
      );
      assert.strictEqual(acted.length, 1);
    });

    it('does not open a worktree whose folder has gone', async () => {
      const warning = installWarningMessageTracker();
      const gone = entry({ path: '/no/such/worktree' });
      const { acted } = await attempt(gone, [MAIN, gone], 'canOpen');
      assert.deepStrictEqual(acted, []);
      assert.match(warning.calls[0].message, /no longer exists/);
    });

    it('says so, and refreshes, when the worktree is no longer listed', async () => {
      const info = installInfoMessageTracker();
      const { acted, calls } = await attempt(entry({ path: '/repo/wt' }), [MAIN], 'canRemove');
      assert.deepStrictEqual(acted, []);
      assert.match(info.calls[0].message, /no longer a worktree/);
      assert.strictEqual(calls.refresh, 1);
    });

    it('surfaces a failed listing as a sanitized toast and does not act', async () => {
      const { ctx } = harness({
        listWorktrees: () => errAsync(new CommandFailedError(128, 'fatal: not a git repository')),
      });
      const error = installErrorMessageTracker();
      let acted = false;
      await withCurrentWorktree(ctx, REPO, MAIN, 'canOpen', async () => {
        acted = true;
      });
      assert.strictEqual(acted, false);
      assert.match(error.calls[0].message, /Failed to list worktrees/);
    });
  });

  it('opens the worktree folder in a new or the current window', async () => {
    await openWorktreeFolder(entry({ path: '/repo/wt' }), true);
    await openWorktreeFolder(entry({ path: '/repo/wt' }), false);
    assert.deepStrictEqual(opened, [
      { uri: '/repo/wt', forceNewWindow: true },
      { uri: '/repo/wt', forceNewWindow: false },
    ]);
  });

  describe('Lock', () => {
    it('locks with the reason the user typed, and refreshes', async () => {
      const { ctx, calls } = harness();
      writableWindow().showInputBox = async () => 'on a USB disk';
      await handleLockWorktree(ctx, REPO, entry({}));
      assert.deepStrictEqual(calls.lock, [{ path: '/repo/wt', reason: 'on a USB disk' }]);
      assert.strictEqual(calls.refresh, 1);
    });

    it('locks without a reason when the box is left empty', async () => {
      const { ctx, calls } = harness();
      writableWindow().showInputBox = async () => '';
      await handleLockWorktree(ctx, REPO, entry({}));
      assert.deepStrictEqual(calls.lock, [{ path: '/repo/wt', reason: undefined }]);
    });

    it('does nothing when the reason box is dismissed', async () => {
      const { ctx, calls } = harness();
      writableWindow().showInputBox = async () => undefined;
      await handleLockWorktree(ctx, REPO, entry({}));
      assert.deepStrictEqual(calls.lock, []);
    });

    it('surfaces git refusing the lock as a sanitized toast', async () => {
      const { ctx } = harness({
        lockWorktree: () =>
          errAsync(new CommandFailedError(128, "fatal: '/repo/wt' is already locked")),
      });
      writableWindow().showInputBox = async () => '';
      const error = installErrorMessageTracker();
      await handleLockWorktree(ctx, REPO, entry({}));
      assert.match(error.calls[0].message, /Failed to lock worktree/);
    });
  });

  describe('Unlock', () => {
    it('unlocks and refreshes', async () => {
      const { ctx, calls } = harness();
      await handleUnlockWorktree(ctx, REPO, entry({ isLocked: true }));
      assert.deepStrictEqual(calls.unlock, ['/repo/wt']);
      assert.strictEqual(calls.refresh, 1);
    });

    it('surfaces git refusing the unlock as a sanitized toast', async () => {
      const { ctx } = harness({
        unlockWorktree: () =>
          errAsync(new CommandFailedError(128, "fatal: '/repo/wt' is not locked")),
      });
      const error = installErrorMessageTracker();
      await handleUnlockWorktree(ctx, REPO, entry({ isLocked: true }));
      assert.match(error.calls[0].message, /Failed to unlock worktree/);
    });
  });

  describe('Remove', () => {
    it('removes after one confirm, past the lock when the worktree is locked', async () => {
      const { ctx, calls } = harness();
      installWarningMessageTracker('Remove');
      installInfoMessageTracker();
      await confirmAndRemoveWorktree(ctx, REPO, entry({ isLocked: true }));
      assert.deepStrictEqual(calls.remove, [{ path: '/repo/wt', force: 'overrideLock' }]);
    });

    it('warns in the one confirm that a locked worktree loses its uncommitted changes', async () => {
      const { ctx, calls } = harness({ hasUncommittedChanges: () => okAsync(true) });
      const warning = installWarningMessageTracker(undefined);
      await confirmAndRemoveWorktree(ctx, REPO, entry({ isLocked: true }));
      assert.match(warning.calls[0].message, /uncommitted changes/);
      assert.deepStrictEqual(calls.remove, [], 'dismissing the confirm removes nothing');
    });

    it('does not mention changes a locked worktree does not have', async () => {
      const { ctx } = harness({ hasUncommittedChanges: () => okAsync(false) });
      const warning = installWarningMessageTracker(undefined);
      await confirmAndRemoveWorktree(ctx, REPO, entry({ isLocked: true }));
      assert.doesNotMatch(warning.calls[0].message, /uncommitted/);
    });
  });

  describe('the branch-menu pickers', () => {
    it('list the worktrees of the repository the clicked branch belongs to', async () => {
      const other = { rootUri: Uri.file('/other/repo') } as unknown as IRepository;
      const listed: string[] = [];
      const { ctx } = harness({
        listWorktrees: (repo) => {
          listed.push(repo.rootUri.fsPath);
          return okAsync([]);
        },
      });
      ctx.resolveRepository = (item) => (item ? other : REPO);
      installInfoMessageTracker();
      writableWindow().showQuickPick = async () => undefined;
      const clicked = { repository: other } as unknown as BranchTreeItem;

      await handleOpenWorktree(ctx, clicked);
      await handleRemoveWorktree(ctx, clicked);

      assert.deepStrictEqual(listed, ['/other/repo', '/other/repo']);
    });
  });

  describe('Prune', () => {
    it('names the missing worktrees in the confirm, prunes, and refreshes', async () => {
      const kept = folder('wt-ok');
      const { ctx, calls } = harness({
        listWorktrees: () =>
          okAsync([
            MAIN,
            entry({ path: '/repo/wt-gone', isPrunable: true }),
            entry({ path: kept }),
          ]),
      });
      const warning = installWarningMessageTracker('Prune Worktrees');
      installInfoMessageTracker();
      await handlePruneWorktrees(ctx, REPO);
      assert.match(warning.calls[0].message, /wt-gone/);
      assert.ok(!warning.calls[0].message.includes(path.basename(kept)));
      assert.strictEqual(calls.prune, 1);
      assert.strictEqual(calls.refresh, 1);
    });

    it('prunes a missing folder git did not flag (git before 2.31)', async () => {
      const { ctx, calls } = harness({
        listWorktrees: () => okAsync([MAIN, entry({ path: '/repo/wt-vanished' })]),
      });
      const warning = installWarningMessageTracker('Prune Worktrees');
      installInfoMessageTracker();
      await handlePruneWorktrees(ctx, REPO);
      assert.match(warning.calls[0].message, /wt-vanished/);
      assert.strictEqual(calls.prune, 1);
    });

    it('says there is nothing to prune instead of running git', async () => {
      const { ctx, calls } = harness();
      const info = installInfoMessageTracker();
      await handlePruneWorktrees(ctx, REPO);
      assert.strictEqual(calls.prune, 0);
      assert.match(info.calls[0].message, /no missing worktrees/i);
    });

    it('does not prune when the confirm is dismissed', async () => {
      const { ctx, calls } = harness({
        listWorktrees: () => okAsync([MAIN, entry({ isPrunable: true })]),
      });
      installWarningMessageTracker(undefined);
      await handlePruneWorktrees(ctx, REPO);
      assert.strictEqual(calls.prune, 0);
    });
  });
});
