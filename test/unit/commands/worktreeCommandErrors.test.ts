/**
 * BranchContextMenuCommands worktree handlers — Result Err-arm coverage.
 *
 * After the maximalist Result conversion, `listWorktrees` / `addWorktree`
 * return `ResultAsync<T, GitError>`. These specs prove the CALLER does not
 * swallow a failure: the Err arm surfaces a SANITIZED error toast (the
 * effort's thesis), rather than silently rendering "no worktrees" or eating
 * the failure.
 */

import { GitService } from '../../../src/git-core/GitService';
import '../../setup';
import * as assert from 'assert';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  handleOpenWorktree,
  handleRemoveWorktree,
  type IBranchWorktreeContext,
} from '../../../src/branches/branchWorktreeActions';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitError, SpawnFailedError, CommandFailedError } from '../../../src/git-core/errors';
import {
  IWorktreeEntry,
  IAddWorktreeOptions,
  WorktreeRemoveForce,
} from '../../../src/git-core/ops/WorktreeOps';
import { Uri } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';

function makeRepo(): IRepository {
  return { rootUri: Uri.file('/test-repo') } as unknown as IRepository;
}

function makeProvider(repo: IRepository | undefined): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

/** GitService stub exposing only the worktree capability the handlers use. */
function makeGitService(over: {
  listWorktrees?: () => ResultAsync<IWorktreeEntry[], GitError>;
  addWorktree?: (repo: IRepository, options: IAddWorktreeOptions) => ResultAsync<void, GitError>;
  removeWorktree?: (
    repo: IRepository,
    path: string,
    force?: WorktreeRemoveForce
  ) => ResultAsync<void, GitError>;
  pruneWorktrees?: (repo: IRepository) => ResultAsync<void, GitError>;
}): IGitService {
  // Shaped like the real façade: the worktree ops hang off the `worktrees`
  // accessor, so a double that answers these calls directly would pass while
  // production code reads through the accessor.
  return {
    getRepositories: () => [makeRepo()],
    worktrees: {
      listWorktrees:
        over.listWorktrees ?? ((): ResultAsync<IWorktreeEntry[], GitError> => okAsync([])),
      addWorktree: over.addWorktree ?? ((): ResultAsync<void, GitError> => okAsync(undefined)),
      removeWorktree:
        over.removeWorktree ?? ((): ResultAsync<void, GitError> => okAsync(undefined)),
      pruneWorktrees:
        over.pruneWorktrees ?? ((): ResultAsync<void, GitError> => okAsync(undefined)),
      lockWorktree: (): ResultAsync<void, GitError> => okAsync(undefined),
      unlockWorktree: (): ResultAsync<void, GitError> => okAsync(undefined),
      hasUncommittedChanges: (): ResultAsync<boolean, GitError> => okAsync(false),
    },
  } as unknown as IGitService;
}

/** The worktree deps the dispatcher hands its worktree commands. */
function worktreeContextOf(commands: BranchContextMenuCommands): IBranchWorktreeContext {
  return (commands as unknown as { _worktreeContext(): IBranchWorktreeContext })._worktreeContext();
}

describe('worktree seam', () => {
  it('the real GitService exposes the accessor the handlers and this double rely on', () => {
    // The double below hangs the ops off `worktrees` by hand. This ties that
    // key to the real class, so renaming the accessor fails here instead of
    // leaving the double green while every worktree command throws.
    const accessor = Object.getOwnPropertyDescriptor(GitService.prototype, 'worktrees');
    assert.strictEqual(typeof accessor?.get, 'function');
  });
});

describe('worktree command handlers — Result Err arm', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('Open Worktree… surfaces a SANITIZED error toast when listWorktrees fails (no silent "no worktrees")', async () => {
    const tracker = installErrorMessageTracker();
    // A spawn fault whose message embeds a credential URL — proves the toast
    // is both shown (not swallowed) AND scrubbed via the Err arm.
    const leaky =
      "fatal: unable to access 'https://x-access-token:ghp_SECRETTOKEN123456@github.com/o/r.git/'";
    const gitService = makeGitService({
      listWorktrees: () => errAsync(new SpawnFailedError(leaky)),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleOpenWorktree(worktreeContextOf(commands));

    assert.strictEqual(tracker.calls.length, 1, 'exactly one error toast on failure');
    const shown = tracker.calls[0].message;
    assert.match(shown, /Failed to list worktrees/);
    assert.ok(!shown.includes('ghp_SECRETTOKEN123456'), 'token must be redacted from the toast');
    assert.ok(shown.includes('<redacted>'), 'sanitized placeholder present');
  });

  it('Open Worktree… shows the toast for a command-failed listing too', async () => {
    const tracker = installErrorMessageTracker();
    const gitService = makeGitService({
      listWorktrees: () => errAsync(new CommandFailedError(128, 'fatal: not a git repository')),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleOpenWorktree(worktreeContextOf(commands));

    assert.strictEqual(tracker.calls.length, 1);
    assert.match(tracker.calls[0].message, /Failed to list worktrees/);
  });
});

/** QuickPick stub: selects the first item whose label matches `pick`. */
function installQuickPickChooser(pick: RegExp | undefined): { seenLabels: string[][] } {
  const seen: { seenLabels: string[][] } = { seenLabels: [] };
  writableWindow().showQuickPick = async (items: unknown[]) => {
    const resolved = items as Array<{ label: string }>;
    seen.seenLabels.push(resolved.map((i) => i.label));
    if (!pick) {
      return undefined;
    }
    return resolved.find((i) => pick.test(i.label));
  };
  return seen;
}

const MAIN_WT: IWorktreeEntry = {
  path: '/test-repo',
  head: 'a'.repeat(40),
  branch: 'refs/heads/main',
  isMain: true,
  isDetached: false,
  isBare: false,
  isLocked: false,
  isPrunable: false,
};
const LINKED_WT: IWorktreeEntry = {
  path: '/elsewhere/wt-feature',
  head: 'b'.repeat(40),
  branch: 'refs/heads/feature/x',
  isMain: false,
  isDetached: false,
  isBare: false,
  isLocked: false,
  isPrunable: false,
};

describe('Remove Worktree…', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('offers only non-main, non-current worktrees plus a prune item', async () => {
    const seen = installQuickPickChooser(undefined);
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.strictEqual(seen.seenLabels.length, 1);
    const labels = seen.seenLabels[0].join(' | ');
    assert.ok(labels.includes('feature/x'), `linked worktree offered: ${labels}`);
    assert.ok(!labels.includes('main'), `main worktree must not be offered: ${labels}`);
    assert.ok(/prune/i.test(labels), `prune item offered: ${labels}`);
  });

  it('removes the picked worktree after one modal confirm and refreshes', async () => {
    installQuickPickChooser(/feature\/x/);
    const removeCalls: Array<{ path: string; force?: WorktreeRemoveForce }> = [];
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
      removeWorktree: (_r, p, force) => {
        removeCalls.push({ path: p, force });
        return okAsync(undefined);
      },
    });
    installWarningMessageTracker('Remove');
    const info = installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.deepStrictEqual(removeCalls, [{ path: '/elsewhere/wt-feature', force: 'none' }]);
    assert.ok(info.calls.some((c) => c.message.includes('Removed')));
  });

  it('does nothing when the confirm is dismissed', async () => {
    installQuickPickChooser(/feature\/x/);
    const removeCalls: string[] = [];
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
      removeWorktree: (_r, p) => {
        removeCalls.push(p);
        return okAsync(undefined);
      },
    });
    installWarningMessageTracker(undefined);
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.strictEqual(removeCalls.length, 0);
  });

  it('offers Force Remove when git refuses a dirty worktree, and retries with force', async () => {
    installQuickPickChooser(/feature\/x/);
    const removeCalls: Array<{ path: string; force?: WorktreeRemoveForce }> = [];
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
      removeWorktree: (_r, p, force) => {
        removeCalls.push({ path: p, force });
        if (force === 'none') {
          return errAsync(
            new CommandFailedError(
              128,
              "fatal: '/elsewhere/wt-feature' contains modified or untracked files, use --force to delete it"
            )
          );
        }
        return okAsync(undefined);
      },
    });
    // First modal = Remove confirm; second modal = Force Remove offer. The
    // tracker returns the SAME choice for both, so use a per-call dispatcher.
    const responses = ['Remove', 'Force Remove'];
    let call = 0;
    writableWindow().showWarningMessage = async () => {
      const r = responses[call];
      call += 1;
      return r;
    };
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.deepStrictEqual(removeCalls, [
      { path: '/elsewhere/wt-feature', force: 'none' },
      { path: '/elsewhere/wt-feature', force: 'discardChanges' },
    ]);
  });

  it('names the lock in the one confirm and removes a locked worktree past it', async () => {
    installQuickPickChooser(/feature\/x/);
    const removeCalls: Array<{ path: string; force?: WorktreeRemoveForce }> = [];
    const gitService = makeGitService({
      listWorktrees: () =>
        okAsync([MAIN_WT, { ...LINKED_WT, isLocked: true, lockReason: 'on a USB disk' }]),
      removeWorktree: (_r, p, force) => {
        removeCalls.push({ path: p, force });
        return okAsync(undefined);
      },
    });
    const warning = installWarningMessageTracker('Remove');
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.strictEqual(warning.calls.length, 1, 'one confirm, not a confirm then a retry');
    assert.match(warning.calls[0].message, /locked/i);
    assert.match(warning.calls[0].message, /on a USB disk/);
    assert.deepStrictEqual(removeCalls, [{ path: '/elsewhere/wt-feature', force: 'overrideLock' }]);
  });

  it('offers to override a lock git reports that the list did not show', async () => {
    installQuickPickChooser(/feature\/x/);
    const removeCalls: Array<{ path: string; force?: WorktreeRemoveForce }> = [];
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
      removeWorktree: (_r, p, force) => {
        removeCalls.push({ path: p, force });
        return force === 'overrideLock'
          ? okAsync(undefined)
          : errAsync(
              new CommandFailedError(
                128,
                "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
              )
            );
      },
    });
    const responses = ['Remove', 'Force Remove'];
    let call = 0;
    writableWindow().showWarningMessage = async () => responses[call++];
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.deepStrictEqual(removeCalls, [
      { path: '/elsewhere/wt-feature', force: 'none' },
      { path: '/elsewhere/wt-feature', force: 'overrideLock' },
    ]);
  });

  it('runs prune, after the confirm naming the missing worktree, when the prune item is picked', async () => {
    installQuickPickChooser(/[Pp]rune/);
    let pruned = 0;
    const gitService = makeGitService({
      listWorktrees: () =>
        okAsync([
          MAIN_WT,
          LINKED_WT,
          { ...LINKED_WT, path: '/elsewhere/wt-gone', isPrunable: true },
        ]),
      pruneWorktrees: () => {
        pruned += 1;
        return okAsync(undefined);
      },
    });
    const confirm = installWarningMessageTracker('Prune Worktrees');
    const info = installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.match(confirm.calls[0].message, /wt-gone/);
    assert.strictEqual(pruned, 1);
    assert.ok(info.calls.some((c) => /prune/i.test(c.message)));
  });

  it('surfaces a SANITIZED toast when the remove fails for a non-dirty reason', async () => {
    installQuickPickChooser(/feature\/x/);
    const tracker = installErrorMessageTracker();
    installWarningMessageTracker('Remove');
    const gitService = makeGitService({
      listWorktrees: () => okAsync([MAIN_WT, LINKED_WT]),
      removeWorktree: () =>
        errAsync(
          new SpawnFailedError(
            "fatal: unable to access 'https://x-access-token:ghp_SECRETTOKEN123456@github.com/o/r.git/'"
          )
        ),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await handleRemoveWorktree(worktreeContextOf(commands));

    assert.strictEqual(tracker.calls.length, 1);
    assert.match(tracker.calls[0].message, /Failed to remove worktree/);
    assert.ok(!tracker.calls[0].message.includes('ghp_SECRETTOKEN123456'));
  });
});
