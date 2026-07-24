/**
 * Unit tests for — finished checkoutAndRebase / pullUsingRebase /
 * pullUsingMerge handlers, plus the generic `intellig.pull` dialog-outcome
 * handler (Bug G).
 *
 * Complements the existing property tests (which cover the fallback /
 * error paths) by exercising:
 *   - `_handleCheckoutAndRebase`: happy path (checkout → rebase → refresh),
 *     and conflict → `openResolveConflictsDialog` with `operation: 'rebase'`.
 *   - `_handlePullUsingRebase` / `_handlePullUsingMerge` (Bug G.1): the
 *     right-click entries chose the strategy via the menu, so they bypass
 *     the PullDialog entirely and pull directly via `gitService.pull` with
 *     `rebase: preset === 'rebase'`. A wired dialog accessor's `show` must
 *     NOT be called.
 *   - `handlePullDialogOutcome` (Bug G.2): the generic `intellig.pull`
 *     palette command still routes through PullDialog; a `cancelled`
 *     outcome emits a debug log naming the step and fires NO toast.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { SpawnFailedError, GitError } from '../../../src/git-core/errors';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { handlePullDialogOutcome } from '../../../src/extension';
import type { PullDialogOutcome } from '../../../src/sync/PullDialog';
import {
  IBasicRebaseResult,
  IBranch,
  ICreateBranchOptions,
  IFetchResult,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import {
  IConflictedFile,
  IConflictOpContext,
  IConflictResolutionService,
} from '../../../src/conflicts/interfaces/IConflictResolutionService';
import type { PullDialog } from '../../../src/sync/PullDialog';
import { EventEmitter, Uri, resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';
import {
  attachedRepo,
  createMockGitService as createSharedMockGitService,
  detachedRepo,
} from '../../mocks/mockGitService';
import { __resetLoggerForTest, initLogger } from '../../../src/utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../src/utils/outputChannel';
import { parseRecord } from '../../../src/utils/logger/render';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

interface Call<Args extends unknown[] = unknown[]> {
  args: Args;
}

interface MockGitService extends Pick<
  IGitService,
  | 'onDidChangeRepository'
  | 'getRepositories'
  | 'getRepository'
  | 'getBranches'
  | 'checkout'
  | 'rebaseBranch'
  | 'pull'
  | 'fetch'
  | 'onDidFetch'
> {
  _calls: {
    checkout: Call<[IRepository, string, unknown?]>[];
    rebaseBranch: Call<[IRepository, string]>[];
    pull: Call<[IRepository, unknown?]>[];
  };
  _rebaseResult: IBasicRebaseResult;
}

function createMockGitService(
  rebaseResult: IBasicRebaseResult = { success: true }
): MockGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
  const calls: MockGitService['_calls'] = {
    checkout: [],
    rebaseBranch: [],
    pull: [],
  };

  const base = {
    _calls: calls,
    _rebaseResult: rebaseResult,
    onDidChangeRepository: repoChangeEmitter.event,
    onDidFetch: fetchEmitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    getBranches: async () => [],
    checkout: (repo: IRepository, ref: string, options?: unknown) => {
      calls.checkout.push({ args: [repo, ref, options] });
      return okAsync(undefined);
    },
    rebaseBranch: async (repo: IRepository, onto: string): Promise<IBasicRebaseResult> => {
      calls.rebaseBranch.push({ args: [repo, onto] });
      return rebaseResult;
    },
    pull: (repo: IRepository, options?: unknown) => {
      calls.pull.push({ args: [repo, options] });
      return okAsync(undefined);
    },
    fetch: () =>
      okAsync({
        updatedRefs: [],
        ahead: 0,
        behind: 0,
        errors: [],
      }),
    reloadRepository: async (repo: IRepository) => repo,
  };
  return base as unknown as MockGitService;
}

interface MockConflictResolutionService extends Partial<IConflictResolutionService> {
  _calls: {
    openResolveConflictsDialog: Call<[IRepository, IConflictedFile[], IConflictOpContext]>[];
    getConflictedFiles: Call<[IRepository]>[];
  };
  _conflictedFiles: IConflictedFile[];
}

function createMockConflictResolutionService(
  conflictedFiles: IConflictedFile[] = []
): MockConflictResolutionService {
  const calls: MockConflictResolutionService['_calls'] = {
    openResolveConflictsDialog: [],
    getConflictedFiles: [],
  };
  return {
    _calls: calls,
    _conflictedFiles: conflictedFiles,
    getConflictedFiles: async (repo: IRepository) => {
      calls.getConflictedFiles.push({ args: [repo] });
      return conflictedFiles;
    },
    openResolveConflictsDialog: async (
      repo: IRepository,
      files: IConflictedFile[],
      opContext: IConflictOpContext
    ): Promise<void> => {
      calls.openResolveConflictsDialog.push({ args: [repo, files, opContext] });
    },
  } as unknown as MockConflictResolutionService;
}

interface MockPullDialog {
  show: (repo: IRepository, preset?: 'rebase' | 'merge', source?: unknown) => Promise<unknown>;
  _calls: Call<[IRepository, ('rebase' | 'merge')?, unknown?]>[];
}

function createMockPullDialog(): MockPullDialog {
  const calls: MockPullDialog['_calls'] = [];
  return {
    _calls: calls,
    show: async (repo, preset, source) => {
      calls.push({ args: [repo, preset, source] });
      return undefined;
    },
  };
}

function createMockRepo(currentBranch: string = 'main'): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: {
      name: `refs/heads/${currentBranch}`,
      commit: 'deadbeef',
      ahead: 0,
      behind: 0,
    },
    remotes: [],
    submodules: [],
  };
}

function createMockBranchTreeProvider(
  repo: IRepository | undefined
): BranchTreeProvider & { _refreshCalls: number } {
  let refreshCalls = 0;
  return {
    getRepository: () => repo,
    refresh: () => {
      refreshCalls += 1;
    },
    get _refreshCalls(): number {
      return refreshCalls;
    },
  } as unknown as BranchTreeProvider & { _refreshCalls: number };
}

function createLocalBranchTreeItem(name: string): BranchTreeItem {
  const branch: IBranch = {
    name,
    type: 'local',
    commit: 'abc1234',
    isHead: false,
  };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

function createRemoteBranchTreeItem(fullRef: string): BranchTreeItem {
  const branch: IBranch = {
    name: fullRef,
    type: 'remote',
    commit: 'abc1234',
    isHead: false,
  };
  return new BranchTreeItem(fullRef, 0, 'remote-branch', branch, undefined, false);
}

// ─── Tests: _handleCheckoutAndRebase ─────────────────────────────────────────

describe('BranchContextMenuCommands — checkoutAndRebase', () => {
  it('happy path: checkout then rebaseBranch with previous branch as onto', async () => {
    const gitService = createMockGitService({ success: true });
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createLocalBranchTreeItem('feature/x');
    await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

    assert.strictEqual(gitService._calls.checkout.length, 1);
    assert.strictEqual(gitService._calls.checkout[0].args[1], 'feature/x');
    assert.strictEqual(gitService._calls.rebaseBranch.length, 1);
    assert.strictEqual(
      gitService._calls.rebaseBranch[0].args[1],
      'main',
      'should rebase onto previously-current branch'
    );
    assert.strictEqual(provider._refreshCalls, 1);
  });

  it('conflict: routes through openResolveConflictsDialog with operation="rebase"', async () => {
    const gitService = createMockGitService({
      success: false,
      conflicts: ['src/a.ts', 'src/b.ts'],
      rebaseInProgress: true,
    });
    const crs = createMockConflictResolutionService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      crs as unknown as IConflictResolutionService
    );

    const item = createLocalBranchTreeItem('feature/x');
    await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

    assert.strictEqual(crs._calls.openResolveConflictsDialog.length, 1);
    const [repoArg, filesArg, ctxArg] = crs._calls.openResolveConflictsDialog[0].args;
    assert.strictEqual(repoArg, repo);
    assert.strictEqual(filesArg.length, 2);
    assert.strictEqual(filesArg[0].path, 'src/a.ts');
    assert.strictEqual(filesArg[0].resolved, false);
    assert.strictEqual(ctxArg.operation, 'rebase');
    assert.strictEqual(ctxArg.target, 'main');
    assert.strictEqual(ctxArg.canAbort, true);
    assert.strictEqual(ctxArg.canContinue, true);
    assert.strictEqual(provider._refreshCalls, 1, 'refresh still fires after conflict handoff');
  });

  it('autostash-pop conflict (rebaseInProgress:false): resolve dialog WITHOUT continue/abort', async () => {
    // The rebase completed but re-applying the autostash conflicted. There is
    // no live rebase, so the dialog must suppress continue/abort — they would
    // dead-end on "no rebase in progress".
    const gitService = createMockGitService({
      success: false,
      conflicts: ['src/a.ts'],
      rebaseInProgress: false,
    });
    const crs = createMockConflictResolutionService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      crs as unknown as IConflictResolutionService
    );

    const item = createLocalBranchTreeItem('feature/x');
    await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

    assert.strictEqual(crs._calls.openResolveConflictsDialog.length, 1);
    const [, filesArg, ctxArg] = crs._calls.openResolveConflictsDialog[0].args;
    assert.strictEqual(filesArg.length, 1);
    assert.strictEqual(ctxArg.operation, 'rebase');
    assert.strictEqual(ctxArg.canAbort, false, 'abort must be suppressed for a completed rebase');
    assert.strictEqual(
      ctxArg.canContinue,
      false,
      'continue must be suppressed — `git rebase --continue` would dead-end'
    );
  });

  it('returns early when repository is missing', async () => {
    const gitService = createMockGitService();
    const provider = createMockBranchTreeProvider(undefined);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);
    const item = createLocalBranchTreeItem('feature/x');
    await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

    assert.strictEqual(gitService._calls.checkout.length, 0);
    assert.strictEqual(gitService._calls.rebaseBranch.length, 0);
  });
});

// ─── Tests: pullUsingRebase / pullUsingMerge ─────────────────────────────────

describe('BranchContextMenuCommands — pullUsingRebase / pullUsingMerge', () => {
  it('pullUsingRebase: skips PullDialog and routes to direct pull with rebase=true', async () => {
    // Bug G.1: the right-click entry already chose the strategy, so the
    // handler must NOT open the PullDialog. A wired dialog accessor's
    // `show` must never be called; instead the direct-pull path runs with
    // `rebase: preset === 'rebase'` → true.
    const gitService = createMockGitService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const pullDialog = createMockPullDialog();
    const infoTracker = installInfoMessageTracker();
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        undefined,
        () => pullDialog as unknown as PullDialog
      );

      const item = createRemoteBranchTreeItem('origin/feature/x');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

      // Dialog is bypassed entirely.
      assert.strictEqual(pullDialog._calls.length, 0, 'PullDialog.show must NOT be called');
      // Direct pull invoked with the rebase strategy and prefilled source.
      assert.strictEqual(gitService._calls.pull.length, 1);
      const pullOptions = gitService._calls.pull[0].args[1] as {
        remote: string;
        branch: string;
        rebase: boolean;
      };
      assert.strictEqual(pullOptions.remote, 'origin');
      assert.strictEqual(pullOptions.branch, 'feature/x');
      assert.strictEqual(pullOptions.rebase, true, 'rebase preset → rebase=true');
      // Success toast fired.
      assert.ok(
        infoTracker.calls.some((c) => c.message.includes('using rebase')),
        `expected a success toast naming the rebase strategy, got: ${JSON.stringify(infoTracker.calls)}`
      );
    } finally {
      restoreMessageFunctions();
    }
  });

  it('pullUsingMerge: skips PullDialog and routes to direct pull with rebase=false', async () => {
    // Bug G.1: same as rebase but the merge preset maps to rebase=false.
    const gitService = createMockGitService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const pullDialog = createMockPullDialog();
    const infoTracker = installInfoMessageTracker();
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        undefined,
        () => pullDialog as unknown as PullDialog
      );

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingMerge', item);

      // Dialog is bypassed entirely.
      assert.strictEqual(pullDialog._calls.length, 0, 'PullDialog.show must NOT be called');
      // Direct pull invoked with merge semantics (rebase=false).
      assert.strictEqual(gitService._calls.pull.length, 1);
      const pullOptions = gitService._calls.pull[0].args[1] as {
        remote: string;
        branch: string;
        rebase: boolean;
      };
      assert.strictEqual(pullOptions.remote, 'origin');
      assert.strictEqual(pullOptions.branch, 'main');
      assert.strictEqual(pullOptions.rebase, false, 'merge preset → rebase=false');
      // Success toast fired.
      assert.ok(
        infoTracker.calls.some((c) => c.message.includes('using merge')),
        `expected a success toast naming the merge strategy, got: ${JSON.stringify(infoTracker.calls)}`
      );
    } finally {
      restoreMessageFunctions();
    }
  });

  it('pullDialog accessor returning undefined falls back to direct pull', async () => {
    const gitService = createMockGitService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      undefined,
      () => undefined // accessor present but returns no dialog
    );

    const item = createRemoteBranchTreeItem('origin/main');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

    assert.strictEqual(gitService._calls.pull.length, 1);
    const pullOptions = gitService._calls.pull[0].args[1] as {
      remote: string;
      branch: string;
      rebase: boolean;
    };
    assert.strictEqual(pullOptions.remote, 'origin');
    assert.strictEqual(pullOptions.branch, 'main');
    assert.strictEqual(pullOptions.rebase, true);
  });

  it('no accessor wired: falls back to direct pull (legacy behaviour)', async () => {
    const gitService = createMockGitService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider
      // no 3rd or 4th constructor arg → no dialog, no conflict service
    );

    const item = createRemoteBranchTreeItem('origin/main');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingMerge', item);

    assert.strictEqual(gitService._calls.pull.length, 1);
    const pullOptions = gitService._calls.pull[0].args[1] as { rebase: boolean };
    assert.strictEqual(pullOptions.rebase, false, 'merge preset → rebase=false');
  });

  it('returns early when repository is missing', async () => {
    const gitService = createMockGitService();
    const provider = createMockBranchTreeProvider(undefined);
    const pullDialog = createMockPullDialog();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      undefined,
      () => pullDialog as unknown as PullDialog
    );

    const item = createRemoteBranchTreeItem('origin/main');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

    assert.strictEqual(pullDialog._calls.length, 0);
    assert.strictEqual(gitService._calls.pull.length, 0);
  });

  it('remote branch name without "/" maps remote=fullName branch=fullName', async () => {
    // Defensive: BranchTreeItem names should always be "<remote>/<branch>",
    // but the parser handles the degenerate no-slash case by using the
    // whole string as both remote and branch. Bug G.1: the dialog is
    // bypassed, so this asserts the direct-pull call's options instead.
    const gitService = createMockGitService();
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const pullDialog = createMockPullDialog();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      undefined,
      () => pullDialog as unknown as PullDialog
    );

    const item = createRemoteBranchTreeItem('origin-only');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

    assert.strictEqual(pullDialog._calls.length, 0, 'PullDialog.show must NOT be called');
    assert.strictEqual(gitService._calls.pull.length, 1);
    const pullOptions = gitService._calls.pull[0].args[1] as {
      remote: string;
      branch: string;
    };
    assert.strictEqual(pullOptions.remote, 'origin-only');
    assert.strictEqual(pullOptions.branch, 'origin-only');
  });
});

// ─── Tests: generic intellig.pull dialog-outcome handling (Bug G.2) ──────────

/**
 * Bug G.2: the generic `intellig.pull` palette command still routes through
 * the PullDialog (where strategy IS the question). The dialog already shows
 * its own toasts for the `pulled` / `conflict` / `error` outcomes
 * (see `runPullDialog`), so the registration must NOT double-handle those.
 * On `cancelled` the dialog shows nothing — Esc / dismissing is a normal
 * user action — so the registration emits a single debug-level structured
 * log record naming the step the user cancelled at, with NO toast.
 *
 * The outcome-branching is extracted from the `intellig.pull` registration
 * into the exported, pure `handlePullDialogOutcome` helper so it is testable
 * without driving the registered command through the extension host. These
 * tests pin that helper's behaviour.
 */
describe('Bug G.2 — generic intellig.pull dialog-outcome handler', () => {
  /** Pin the Logger to `debug` BEFORE init so the debug record is admitted. */
  function setupDebugLogger(): { _lines: string[] } {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    resetMockConfiguration();
    setMockConfigValue('intellig', 'log.level', 'debug');
    const ctxSubs: { dispose(): void }[] = [];
    const ctx = { subscriptions: ctxSubs } as unknown as import('vscode').ExtensionContext;
    initOutputChannel(ctx);
    initLogger(ctx);
    return getOutputChannel() as unknown as { _lines: string[] };
  }

  it('cancelled at options step: emits a debug log, no toast', () => {
    const channel = setupDebugLogger();
    const infoTracker = installInfoMessageTracker();
    const warnTracker = installWarningMessageTracker();
    const errorTracker = installErrorMessageTracker();
    try {
      const outcome: PullDialogOutcome = { status: 'cancelled', step: 'options' };
      handlePullDialogOutcome(outcome);

      // No toast on user-cancel.
      assert.strictEqual(infoTracker.calls.length, 0, 'no info toast on cancel');
      assert.strictEqual(warnTracker.calls.length, 0, 'no warning toast on cancel');
      assert.strictEqual(errorTracker.calls.length, 0, 'no error toast on cancel');

      // At least one debug record mentioning the cancellation + step.
      const records = channel._lines.map((line) => parseRecord(line)).filter((r) => r !== null);
      const cancelRecord = records.find(
        (r) =>
          r.level === 'debug' &&
          r.component === 'extension' &&
          r.message.includes('pull dialog cancelled')
      );
      assert.ok(
        cancelRecord,
        `expected a debug 'pull dialog cancelled' record; saw lines: ${JSON.stringify(channel._lines)}`
      );
      const rendered = JSON.stringify(cancelRecord);
      assert.ok(
        rendered.includes('options'),
        `cancel record must name the 'options' step; got: ${rendered}`
      );
    } finally {
      restoreMessageFunctions();
      __resetLoggerForTest();
      __resetOutputChannelForTest();
      resetMockConfiguration();
    }
  });

  it('cancelled at source step: debug record names the source step', () => {
    const channel = setupDebugLogger();
    const infoTracker = installInfoMessageTracker();
    try {
      handlePullDialogOutcome({ status: 'cancelled', step: 'source' });

      assert.strictEqual(infoTracker.calls.length, 0, 'no toast on cancel');
      const records = channel._lines.map((line) => parseRecord(line)).filter((r) => r !== null);
      const cancelRecord = records.find(
        (r) =>
          r.level === 'debug' &&
          r.component === 'extension' &&
          r.message.includes('pull dialog cancelled')
      );
      assert.ok(cancelRecord, 'expected a debug cancel record for the source step');
      assert.ok(
        JSON.stringify(cancelRecord).includes('source'),
        'cancel record must name the source step'
      );
    } finally {
      restoreMessageFunctions();
      __resetLoggerForTest();
      __resetOutputChannelForTest();
      resetMockConfiguration();
    }
  });

  it('pulled / conflict / error: no extra toast and no cancel log (dialog handled it)', () => {
    const channel = setupDebugLogger();
    const infoTracker = installInfoMessageTracker();
    const warnTracker = installWarningMessageTracker();
    const errorTracker = installErrorMessageTracker();
    try {
      const opts = { remote: 'origin', branch: 'main' };
      handlePullDialogOutcome({ status: 'pulled', options: opts });
      handlePullDialogOutcome({ status: 'conflict', options: opts, message: 'CONFLICT' });
      handlePullDialogOutcome({ status: 'error', options: opts, message: 'boom' });

      // The registration must not double-handle: the dialog already
      // toasted internally for these outcomes.
      assert.strictEqual(infoTracker.calls.length, 0, 'no extra info toast');
      assert.strictEqual(warnTracker.calls.length, 0, 'no extra warning toast');
      assert.strictEqual(errorTracker.calls.length, 0, 'no extra error toast');

      // And no spurious "pull dialog cancelled" debug record for non-cancel
      // outcomes.
      const records = channel._lines.map((line) => parseRecord(line)).filter((r) => r !== null);
      const cancelRecord = records.find((r) => r.message.includes('pull dialog cancelled'));
      assert.strictEqual(
        cancelRecord,
        undefined,
        'no cancel log should fire for pulled/conflict/error outcomes'
      );
    } finally {
      restoreMessageFunctions();
      __resetLoggerForTest();
      __resetOutputChannelForTest();
      resetMockConfiguration();
    }
  });
});

// ─── Tests: pull-fallback conflict-service probe ────────────────────────

/**
 * Coverage: the pull-fallback path (no PullDialog accessor wired)
 * previously stringified a conflict count out of the error message via
 * `_parseConflictCount`. That helper was deleted once we confirmed
 * `_conflictResolutionService` is always wired in production
 * (`ExtensionServices.initialize` unconditionally constructs it). The
 * fallback now probes the working tree via `getConflictedFiles` when the
 * conflict service is wired, and auto-opens the Resolve Conflicts dialog
 * if the probe returns any unresolved files. When the probe finds no
 * conflicts (or the service isn't wired — test-only), the handler falls
 * through to the generic "Failed to pull …" error message.
 */
describe('TL-33 BranchContextMenuCommands — pull fallback probes conflict service', () => {
  function makePullThrowingGitService(err: Error): MockGitService {
    const gitService = createMockGitService();
    const calls = gitService._calls;
    // Override pull to throw; all other methods remain no-op stubs.
    (gitService as unknown as { pull: IGitService['pull'] }).pull = (
      repo: IRepository,
      options?: unknown
    ) => {
      calls.pull.push({ args: [repo, options] });
      return errAsync(new SpawnFailedError(err instanceof Error ? err.message : String(err)));
    };
    return gitService;
  }

  it('pull throws → conflict service reports files → opens resolve dialog', async () => {
    const gitService = makePullThrowingGitService(new Error('Automatic merge failed'));
    const crs = createMockConflictResolutionService([
      { path: 'src/a.ts', resolved: false },
      { path: 'src/b.ts', resolved: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      provider,
      crs as unknown as IConflictResolutionService,
      () => undefined // accessor present but no dialog → take fallback
    );

    const item = createRemoteBranchTreeItem('origin/feature');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

    assert.strictEqual(gitService._calls.pull.length, 1);
    assert.strictEqual(crs._calls.getConflictedFiles.length, 1);
    assert.strictEqual(crs._calls.openResolveConflictsDialog.length, 1);
    const [repoArg, filesArg, ctxArg] = crs._calls.openResolveConflictsDialog[0].args;
    assert.strictEqual(repoArg, repo);
    assert.strictEqual(filesArg.length, 2);
    assert.strictEqual(filesArg[0].path, 'src/a.ts');
    assert.strictEqual(filesArg[0].resolved, false);
    assert.strictEqual(ctxArg.operation, 'rebase');
    assert.strictEqual(ctxArg.target, 'origin/feature');
    assert.strictEqual(ctxArg.canAbort, true);
    assert.strictEqual(ctxArg.canContinue, true);
    assert.strictEqual(provider._refreshCalls, 1, 'refresh fires after conflict handoff');
  });

  it('pull throws → conflict service reports no files → shows generic error', async () => {
    const gitService = makePullThrowingGitService(new Error('Network error: connection reset'));
    const crs = createMockConflictResolutionService([]); // no conflicts in working tree
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    // Capture showErrorMessage calls for assertion.
    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        crs as unknown as IConflictResolutionService,
        () => undefined
      );

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingMerge', item);

      assert.strictEqual(gitService._calls.pull.length, 1);
      assert.strictEqual(crs._calls.getConflictedFiles.length, 1);
      assert.strictEqual(
        crs._calls.openResolveConflictsDialog.length,
        0,
        'no dialog when probe finds zero conflicts'
      );
      assert.ok(errorCalls.length > 0, 'generic error message should be shown');
      assert.ok(
        errorCalls[0].includes('Failed to pull using merge'),
        `error message should name the strategy, got: "${errorCalls[0]}"`
      );
      assert.ok(
        errorCalls[0].includes('Network error'),
        `error message should include original error text, got: "${errorCalls[0]}"`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
    }
  });

  it('pull throws → no conflict service wired → shows generic error (no probe)', async () => {
    const gitService = makePullThrowingGitService(new Error('unreachable host'));
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        undefined, // no conflict service — test-only shape
        () => undefined
      );

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

      assert.strictEqual(gitService._calls.pull.length, 1);
      assert.ok(errorCalls.length > 0, 'generic error message should be shown');
      assert.ok(
        errorCalls[0].includes('Failed to pull using rebase'),
        `error should name strategy, got: "${errorCalls[0]}"`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
    }
  });
});

// ─── Tests: probe swallows pull error ──────────────────────────────────────

/**
 * Coverage for the pull-fallback path's `getConflictedFiles` probe, which
 * lives inside the outer `catch(error)` block. If the probe itself throws
 * (git process crash, transient fs/access issue, conflict-service bug), an
 * inner try/catch logs-and-falls-through to the generic
 * `showErrorMessage('Failed to pull using …')` so the original pull failure
 * still surfaces rather than being silently swallowed. This suite locks that
 * in: when the probe throws, the outer error toast still fires, the resolve
 * dialog is NOT opened, and the probe error is captured via the structured
 * Logger for debugging.
 */
describe('Wave-3-R2 BranchContextMenuCommands — probe failure preserves pull error', () => {
  function makePullThrowingGitService(err: Error): MockGitService {
    const gitService = createMockGitService();
    const calls = gitService._calls;
    (gitService as unknown as { pull: IGitService['pull'] }).pull = (
      repo: IRepository,
      options?: unknown
    ) => {
      calls.pull.push({ args: [repo, options] });
      return errAsync(new SpawnFailedError(err instanceof Error ? err.message : String(err)));
    };
    return gitService;
  }

  /**
   * Conflict-service mock whose `getConflictedFiles` rejects with the given
   * error. Exercises the exact failure mode the fix guards against.
   */
  function createProbeThrowingConflictService(probeError: Error): MockConflictResolutionService {
    const calls: MockConflictResolutionService['_calls'] = {
      openResolveConflictsDialog: [],
      getConflictedFiles: [],
    };
    return {
      _calls: calls,
      _conflictedFiles: [],
      getConflictedFiles: async (repo: IRepository) => {
        calls.getConflictedFiles.push({ args: [repo] });
        throw probeError;
      },
      openResolveConflictsDialog: async (
        repo: IRepository,
        files: IConflictedFile[],
        opContext: IConflictOpContext
      ): Promise<void> => {
        calls.openResolveConflictsDialog.push({ args: [repo, files, opContext] });
      },
    } as unknown as MockConflictResolutionService;
  }

  it('pull throws → probe throws → generic pull error still surfaced, no dialog, probe error logged', async () => {
    const pullError = new Error('fatal: unable to access origin: connection refused');
    const probeError = new Error('git status crashed during conflict probe');
    const gitService = makePullThrowingGitService(pullError);
    const crs = createProbeThrowingConflictService(probeError);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };

    // Wire up the structured Logger so we can verify the probe failure
    // is captured for debugging through the OutputChannel sink (the
    // production successor to the legacy `console.error` path).
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    const ctxSubs: { dispose(): void }[] = [];
    const ctx = { subscriptions: ctxSubs } as unknown as import('vscode').ExtensionContext;
    initOutputChannel(ctx);
    initLogger(ctx);
    const channel = getOutputChannel() as unknown as { _lines: string[] };

    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        crs as unknown as IConflictResolutionService,
        () => undefined // fallback path (no PullDialog)
      );

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingMerge', item);

      // Pull attempted; probe attempted (and rejected).
      assert.strictEqual(gitService._calls.pull.length, 1);
      assert.strictEqual(crs._calls.getConflictedFiles.length, 1);

      // Resolve-conflicts dialog must NOT be opened — the probe failed
      // before determining whether conflicts were present.
      assert.strictEqual(
        crs._calls.openResolveConflictsDialog.length,
        0,
        'resolve dialog must not open when probe fails'
      );

      // Outer generic error message MUST still be shown with the original
      // pull-failure context. This is the regression we guard against.
      assert.strictEqual(
        errorCalls.length,
        1,
        `expected exactly one showErrorMessage call, got ${errorCalls.length}: ${errorCalls.join(' | ')}`
      );
      assert.ok(
        errorCalls[0].includes('Failed to pull using merge'),
        `error must name the strategy, got: "${errorCalls[0]}"`
      );
      assert.ok(
        errorCalls[0].includes('connection refused'),
        `error must include original pull failure context, got: "${errorCalls[0]}"`
      );

      // Probe error captured via the structured Logger for debugging
      // (routed through the BranchContextMenuCommands child logger).
      // Walk the rendered OutputChannel lines for the probe-error message.
      const records = channel._lines.map((line) => parseRecord(line)).filter((r) => r !== null);
      const probeRecord = records.find(
        (r) =>
          r !== null &&
          r.component === 'BranchContextMenuCommands' &&
          r.level === 'warn' &&
          r.message.includes('pull conflict probe failed')
      );
      assert.ok(
        probeRecord,
        `probe failure must be captured by the BranchContextMenuCommands logger; saw lines: ${JSON.stringify(channel._lines)}`
      );
      const renderedProbeError = JSON.stringify(probeRecord);
      assert.ok(
        renderedProbeError.includes(probeError.message),
        `probe error message must appear in the rendered record; got: ${renderedProbeError}`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
      __resetLoggerForTest();
      __resetOutputChannelForTest();
    }
  });

  it('pullUsingRebase: probe throws → rebase strategy surfaced in outer error, no dialog', async () => {
    const pullError = new Error('fatal: rebase failed mid-flight');
    const probeError = new Error('ENOENT: .git/index disappeared');
    const gitService = makePullThrowingGitService(pullError);
    const crs = createProbeThrowingConflictService(probeError);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };
    // Silence the probe-error log for this spec (the structured Logger
    // routes the probe failure through the OutputChannel sink; we don't
    // assert on it here but we set up the channel so emissions don't
    // hit a no-op pre-init path that could surface a side effect).
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    const ctxSubs: { dispose(): void }[] = [];
    const ctx = { subscriptions: ctxSubs } as unknown as import('vscode').ExtensionContext;
    initOutputChannel(ctx);
    initLogger(ctx);
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider,
        crs as unknown as IConflictResolutionService,
        () => undefined
      );

      const item = createRemoteBranchTreeItem('origin/feature');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

      assert.strictEqual(crs._calls.openResolveConflictsDialog.length, 0);
      assert.strictEqual(errorCalls.length, 1);
      assert.ok(
        errorCalls[0].includes('Failed to pull using rebase'),
        `rebase preset must name the rebase strategy, got: "${errorCalls[0]}"`
      );
      assert.ok(
        errorCalls[0].includes('rebase failed mid-flight'),
        `original pull error text must survive, got: "${errorCalls[0]}"`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
      __resetLoggerForTest();
      __resetOutputChannelForTest();
    }
  });
});

/**
 * Detached row dispatcher safety pins (regression class).
 *
 * The synthetic detached-head row presents the user with a parenthesized
 * label `(HEAD detached at <sha>)`., `_handleNewBranchFrom`
 * read `item.branch?.name || item.tag?.name` as the git start-point —
 * if a future refactor accidentally constructed a fake-IBranch with the
 * parenthesized label as `.name` (the original bug shape), git's
 * checkout-b would fail with `fatal: '(HEAD detached at <sha>)' is not
 * a commit`.
 *
 * 's type extension routes the SHA via `item.getDetachedHeadSha()`
 * — never the parenthesized label. These two pins assert the SHA flows
 * to gitService correctly AND that the parenthesized label never reaches
 * the gitService boundary.
 */
describe('detached row dispatcher safety (Wave F regression class)', () => {
  const FULL_SHA = 'abc1234567890abcdef1234567890abcdef12345';

  it('newBranchFrom-detached: gitService.createBranch receives the SHA, NOT the parenthesized label', async () => {
    const repo = detachedRepo(FULL_SHA);
    let createdStartPoint: string | undefined;
    const gitService = createSharedMockGitService(repo, {
      createBranch: (
        _repo: IRepository,
        _name: string,
        startPointOrOptions?: string | ICreateBranchOptions
      ) => {
        createdStartPoint =
          typeof startPointOrOptions === 'string' ? startPointOrOptions : undefined;
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = new BranchTreeProvider(gitService);
    branchTreeProvider.setRepository(repo);

    const savedShowInputBox = writableWindow().showInputBox;
    writableWindow().showInputBox = (async () =>
      'feature/from-detached') as typeof writableWindow extends () => infer W
      ? W extends { showInputBox: infer F }
        ? F
        : never
      : never;

    try {
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
      const rootChildren = await branchTreeProvider.getChildren();
      const localCategory = rootChildren.find((c) => c.label === 'Local');
      assert.ok(localCategory, 'Local category must exist');
      const items = await branchTreeProvider.getChildren(localCategory);
      const detachedRow = items.find((i) => i.itemType === 'detached-head');
      assert.ok(detachedRow, 'detached row must be present in fixture');

      await driveBranchMenuCommand(commands, 'intellig.branch.newBranchFrom', detachedRow);

      assert.strictEqual(createdStartPoint, FULL_SHA, 'createBranch must receive the 40-char SHA');
      assert.ok(
        createdStartPoint && !createdStartPoint.startsWith('('),
        `createBranch must NEVER receive a parenthesized label (Wave F regression class); got "${createdStartPoint}"`
      );
    } finally {
      writableWindow().showInputBox = savedShowInputBox;
    }
  });

  it('checkout-detached: gitService.checkout receives the SHA, NOT the parenthesized label', async () => {
    const repo = detachedRepo(FULL_SHA);
    let checkedOutRef: string | undefined;
    const gitService = createSharedMockGitService(repo, {
      checkout: (_repo: IRepository, ref: string) => {
        checkedOutRef = ref;
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = new BranchTreeProvider(gitService);
    branchTreeProvider.setRepository(repo);

    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
    const rootChildren = await branchTreeProvider.getChildren();
    const localCategory = rootChildren.find((c) => c.label === 'Local');
    assert.ok(localCategory, 'Local category must exist');
    const items = await branchTreeProvider.getChildren(localCategory);
    const detachedRow = items.find((i) => i.itemType === 'detached-head');
    assert.ok(detachedRow, 'detached row must be present in fixture');

    await driveBranchMenuCommand(commands, 'intellig.branch.checkout', detachedRow);

    assert.strictEqual(checkedOutRef, FULL_SHA, 'checkout must receive the 40-char SHA');
    assert.ok(
      checkedOutRef && !checkedOutRef.startsWith('('),
      `checkout must NEVER receive a parenthesized label (Wave F regression class); got "${checkedOutRef}"`
    );
  });
});

// ─── Track Remote Branch (single-entry smart-detect) ─────────

describe('Wave K WK-3 — _handleTrackRemote (smart-detect)', () => {
  interface TrackMockGit {
    _calls: {
      checkout: Call<[IRepository, string, unknown?]>[];
      setBranchUpstream: Call<[IRepository, string, string]>[];
      getBranches: Call<[IRepository]>[];
    };
    onDidChangeRepository: unknown;
    onDidFetch: unknown;
    getRepositories: () => IRepository[];
    getRepository: () => Promise<IRepository | undefined>;
    getBranches: (repo: IRepository) => Promise<IBranch[]>;
    checkout: (repo: IRepository, ref: string, options?: unknown) => Promise<void>;
    setBranchUpstream: (repo: IRepository, local: string, upstream: string) => Promise<void>;
    reloadRepository: (repo: IRepository) => Promise<IRepository>;
  }

  function createTrackMockGit(branches: IBranch[]): TrackMockGit {
    const repoChange = new EventEmitter<IRepository>();
    const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    const calls = {
      checkout: [] as Call<[IRepository, string, unknown?]>[],
      setBranchUpstream: [] as Call<[IRepository, string, string]>[],
      getBranches: [] as Call<[IRepository]>[],
    };
    return {
      _calls: calls,
      onDidChangeRepository: repoChange.event,
      onDidFetch: fetchEmitter.event,
      getRepositories: () => [],
      getRepository: async () => undefined,
      getBranches: async (repo: IRepository) => {
        calls.getBranches.push({ args: [repo] });
        return branches;
      },
      checkout: async (repo: IRepository, ref: string, options?: unknown) => {
        calls.checkout.push({ args: [repo, ref, options] });
      },
      setBranchUpstream: async (repo: IRepository, local: string, upstream: string) => {
        calls.setBranchUpstream.push({ args: [repo, local, upstream] });
      },
      reloadRepository: async (repo: IRepository) => repo,
    };
  }

  it('trackRemote-create-1: no local exists → checkout --track called with simple name + upstream', async () => {
    const gitService = createTrackMockGit([
      { name: 'origin/feature', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createRemoteBranchTreeItem('origin/feature');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

    assert.strictEqual(gitService._calls.checkout.length, 1, 'checkout must be called once');
    assert.strictEqual(gitService._calls.checkout[0].args[1], 'feature');
    const opts = gitService._calls.checkout[0].args[2] as {
      createBranch?: boolean;
      track?: string;
    };
    assert.strictEqual(opts.createBranch, true);
    assert.strictEqual(opts.track, 'origin/feature');
    // setBranchUpstream is NOT called in the create path.
    assert.strictEqual(gitService._calls.setBranchUpstream.length, 0);
  });

  it('trackRemote-existing-1: local exists with no upstream → setBranchUpstream called', async () => {
    const gitService = createTrackMockGit([
      { name: 'feature', type: 'local', commit: 'abc', isHead: false }, // no upstream
      { name: 'origin/feature', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createRemoteBranchTreeItem('origin/feature');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

    // No checkout — local already exists.
    assert.strictEqual(gitService._calls.checkout.length, 0);
    // setBranchUpstream called once with (repo, 'feature', 'origin/feature').
    assert.strictEqual(gitService._calls.setBranchUpstream.length, 1);
    assert.strictEqual(gitService._calls.setBranchUpstream[0].args[1], 'feature');
    assert.strictEqual(gitService._calls.setBranchUpstream[0].args[2], 'origin/feature');
  });

  it('trackRemote-cross-1: local exists with different upstream → confirm dialog → setBranchUpstream', async () => {
    const gitService = createTrackMockGit([
      {
        name: 'feature',
        type: 'local',
        commit: 'abc',
        isHead: false,
        upstream: { remote: 'upstream', name: 'feature' }, // tracks DIFFERENT remote
      },
      { name: 'origin/feature', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    // Stub showWarningMessage to return 'Re-track' so the smart-detect proceeds.
    const w = writableWindow();
    let warningSeen = '';
    w.showWarningMessage = (message: string, ..._items: unknown[]): Promise<string | undefined> => {
      warningSeen = message;
      return Promise.resolve('Re-track');
    };

    const item = createRemoteBranchTreeItem('origin/feature');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

    // Confirm dialog fired with both upstream refs visible.
    assert.ok(
      warningSeen.includes('upstream/feature'),
      `confirm should mention current upstream; got: ${warningSeen}`
    );
    assert.ok(
      warningSeen.includes('origin/feature'),
      `confirm should mention new upstream; got: ${warningSeen}`
    );
    // setBranchUpstream called after user confirmed.
    assert.strictEqual(gitService._calls.setBranchUpstream.length, 1);
    assert.strictEqual(gitService._calls.setBranchUpstream[0].args[2], 'origin/feature');
  });

  it('trackRemote-nested-1: nested branch name (origin/feature/foo) extracts simple name correctly', async () => {
    const gitService = createTrackMockGit([
      { name: 'origin/feature/foo', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createRemoteBranchTreeItem('origin/feature/foo');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

    assert.strictEqual(gitService._calls.checkout.length, 1);
    // Simple name = everything AFTER the first slash → 'feature/foo'.
    assert.strictEqual(gitService._calls.checkout[0].args[1], 'feature/foo');
    const opts = gitService._calls.checkout[0].args[2] as { track?: string };
    assert.strictEqual(opts.track, 'origin/feature/foo');
  });

  // SK-2 — defense-in-depth: simpleName sliced from a parsed
  // remote ref could theoretically begin with `-` or `.`, slipping past
  // the service-boundary validateBranchName guard for
  // checkout({ createBranch }). The handler must reject before we ever
  // reach the service.
  it('trackRemote-reject-leading-dash: simpleName starting with `-` shows error and skips checkout', async () => {
    const gitService = createTrackMockGit([
      { name: 'origin/-evil', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );

      const item = createRemoteBranchTreeItem('origin/-evil');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

      // Service must not be called — reject at the handler boundary.
      assert.strictEqual(
        gitService._calls.checkout.length,
        0,
        'checkout MUST NOT run when simpleName starts with `-`'
      );
      assert.strictEqual(
        gitService._calls.setBranchUpstream.length,
        0,
        'setBranchUpstream MUST NOT run when simpleName starts with `-`'
      );
      assert.strictEqual(errorCalls.length, 1, 'one error message must surface');
      assert.ok(
        errorCalls[0].includes('reserved name prefix'),
        `error message must mention reserved name prefix; got: ${errorCalls[0]}`
      );
      assert.ok(
        errorCalls[0].includes('-evil'),
        `error message should echo the offending simpleName; got: ${errorCalls[0]}`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
    }
  });

  it('trackRemote-reject-leading-dot: simpleName starting with `.` shows error and skips checkout', async () => {
    const gitService = createTrackMockGit([
      { name: 'origin/.hidden', type: 'remote', commit: 'abc', isHead: false },
    ]);
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);

    const errorCalls: string[] = [];
    const savedError = writableWindow().showErrorMessage;
    writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
      errorCalls.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );

      const item = createRemoteBranchTreeItem('origin/.hidden');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.trackBranch', item);

      assert.strictEqual(
        gitService._calls.checkout.length,
        0,
        'checkout MUST NOT run when simpleName starts with `.`'
      );
      assert.strictEqual(gitService._calls.setBranchUpstream.length, 0);
      assert.strictEqual(errorCalls.length, 1);
      assert.ok(
        errorCalls[0].includes('.hidden'),
        `error message should echo the offending simpleName; got: ${errorCalls[0]}`
      );
    } finally {
      writableWindow().showErrorMessage = savedError;
    }
  });
});

// ─── Tests: _handleCheckoutAsLocal (Bug F — reset stale local to remote tip) ──

/**
 * Bug F coverage: "Checkout" on a remote branch must land the user on the
 * remote tip even when a stale local of the same name exists. The handler
 * collapses the old `localExists ? plain-checkout : create-tracking`
 * branching into a single `checkout(repo, branch, { forceCreate: true,
 * track: '<remote>/<branch>' })` call (emits `git checkout -B <branch>
 * <remote>/<branch>`). Because `-B` rewrites the local's commit pointer, the
 * handler first probes the local IBranch's `ahead` count and, when it has
 * unique commits, shows a modal confirmation gating the reset.
 */
describe('Bug F BranchContextMenuCommands — checkout-as-local resets stale local', () => {
  interface CheckoutLocalMockGit {
    _calls: {
      checkout: Call<[IRepository, string, unknown?]>[];
      stash: Call<[IRepository, string?]>[];
      getBranches: Call<[IRepository]>[];
    };
    onDidChangeRepository: unknown;
    onDidFetch: unknown;
    getRepositories: () => IRepository[];
    getRepository: () => Promise<IRepository | undefined>;
    getBranches: (repo: IRepository) => Promise<IBranch[]>;
    checkout: (repo: IRepository, ref: string, options?: unknown) => Promise<void>;
    stash: (repo: IRepository, message?: string) => ResultAsync<void, GitError>;
    reloadRepository: (repo: IRepository) => Promise<IRepository>;
  }

  function createCheckoutLocalMockGit(branches: IBranch[]): CheckoutLocalMockGit {
    const repoChange = new EventEmitter<IRepository>();
    const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    const calls = {
      checkout: [] as Call<[IRepository, string, unknown?]>[],
      stash: [] as Call<[IRepository, string?]>[],
      getBranches: [] as Call<[IRepository]>[],
    };
    return {
      _calls: calls,
      onDidChangeRepository: repoChange.event,
      onDidFetch: fetchEmitter.event,
      getRepositories: () => [],
      getRepository: async () => undefined,
      getBranches: async (repo: IRepository) => {
        calls.getBranches.push({ args: [repo] });
        return branches;
      },
      checkout: async (repo: IRepository, ref: string, options?: unknown) => {
        calls.checkout.push({ args: [repo, ref, options] });
      },
      stash: (repo: IRepository, message?: string) => {
        calls.stash.push({ args: [repo, message] });
        return okAsync(undefined);
      },
      reloadRepository: async (repo: IRepository) => repo,
    };
  }

  it('checkout-as-local-1: existing local at ahead:0 → single forceCreate call, NOT a plain checkout', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'main', type: 'local', commit: 'aaa', isHead: false, ahead: 0, behind: 0 },
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createRemoteBranchTreeItem('origin/main');
    await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

    // Exactly one checkout call, with the forceCreate + track options.
    assert.strictEqual(gitService._calls.checkout.length, 1, 'checkout must be called once');
    assert.strictEqual(gitService._calls.checkout[0].args[1], 'main');
    const opts = gitService._calls.checkout[0].args[2] as {
      forceCreate?: boolean;
      track?: string;
    };
    assert.strictEqual(opts.forceCreate, true, 'must use forceCreate (-B), not a plain checkout');
    assert.strictEqual(opts.track, 'origin/main');
    // ahead:0 → no prompt.
    assert.strictEqual(gitService._calls.stash.length, 0, 'no stash when ahead === 0');
  });

  it('checkout-as-local-2a: local ahead:3 + Cancel → warning shown, checkout NOT called', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'main', type: 'local', commit: 'aaa', isHead: false, ahead: 3, behind: 0 },
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);

    let warningMsg = '';
    const savedWarning = writableWindow().showWarningMessage;
    writableWindow().showWarningMessage = (
      message: string,
      ..._items: unknown[]
    ): Promise<string | undefined> => {
      warningMsg = message;
      return Promise.resolve('Cancel');
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );
      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

      assert.ok(
        warningMsg.includes('3 commits not on remote'),
        `warning should mention the ahead count; got: "${warningMsg}"`
      );
      assert.strictEqual(
        gitService._calls.checkout.length,
        0,
        'checkout MUST NOT run when the user cancels'
      );
      assert.strictEqual(gitService._calls.stash.length, 0, 'no stash on cancel');
    } finally {
      writableWindow().showWarningMessage = savedWarning;
    }
  });

  it('checkout-as-local-2b: local ahead:3 + "Reset anyway" → forceCreate, no stash', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'main', type: 'local', commit: 'aaa', isHead: false, ahead: 3, behind: 0 },
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);

    const savedWarning = writableWindow().showWarningMessage;
    writableWindow().showWarningMessage = (): Promise<string | undefined> =>
      Promise.resolve('Reset anyway');
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );
      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

      assert.strictEqual(gitService._calls.stash.length, 0, 'Reset anyway must NOT stash');
      assert.strictEqual(gitService._calls.checkout.length, 1, 'checkout must run after confirm');
      const opts = gitService._calls.checkout[0].args[2] as {
        forceCreate?: boolean;
        track?: string;
      };
      assert.strictEqual(opts.forceCreate, true);
      assert.strictEqual(opts.track, 'origin/main');
    } finally {
      writableWindow().showWarningMessage = savedWarning;
    }
  });

  it('checkout-as-local-2c: local ahead:3 + "Stash and reset" → stash THEN forceCreate', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'main', type: 'local', commit: 'aaa', isHead: false, ahead: 3, behind: 0 },
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);

    // Record interleaving order of stash vs checkout.
    const order: string[] = [];
    const savedWarning = writableWindow().showWarningMessage;
    writableWindow().showWarningMessage = (): Promise<string | undefined> =>
      Promise.resolve('Stash and reset');
    gitService.stash = (repo2: IRepository, message?: string) => {
      order.push('stash');
      gitService._calls.stash.push({ args: [repo2, message] });
      return okAsync(undefined);
    };
    gitService.checkout = async (repo2: IRepository, ref: string, options?: unknown) => {
      order.push('checkout');
      gitService._calls.checkout.push({ args: [repo2, ref, options] });
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );
      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

      assert.strictEqual(gitService._calls.stash.length, 1, 'stash must run');
      assert.strictEqual(gitService._calls.checkout.length, 1, 'forceCreate must run');
      assert.deepStrictEqual(order, ['stash', 'checkout'], 'stash must precede the reset');
      const opts = gitService._calls.checkout[0].args[2] as {
        forceCreate?: boolean;
        track?: string;
      };
      assert.strictEqual(opts.forceCreate, true);
      assert.strictEqual(opts.track, 'origin/main');
    } finally {
      writableWindow().showWarningMessage = savedWarning;
    }
  });

  it('checkout-as-local-3: local ahead:0 → no prompt, checkout immediately', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'main', type: 'local', commit: 'aaa', isHead: false, ahead: 0, behind: 0 },
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);

    let warningCalled = false;
    const savedWarning = writableWindow().showWarningMessage;
    writableWindow().showWarningMessage = (): Promise<string | undefined> => {
      warningCalled = true;
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );
      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

      assert.strictEqual(warningCalled, false, 'no prompt when local is not ahead');
      assert.strictEqual(gitService._calls.checkout.length, 1, 'checkout runs immediately');
      const opts = gitService._calls.checkout[0].args[2] as {
        forceCreate?: boolean;
        track?: string;
      };
      assert.strictEqual(opts.forceCreate, true);
      assert.strictEqual(opts.track, 'origin/main');
    } finally {
      writableWindow().showWarningMessage = savedWarning;
    }
  });

  it('checkout-as-local-4: no local exists → no prompt, forceCreate creates tracking branch', async () => {
    const gitService = createCheckoutLocalMockGit([
      { name: 'origin/main', type: 'remote', commit: 'bbb', isHead: false },
    ]);
    const repo = createMockRepo('feature');
    const provider = createMockBranchTreeProvider(repo);

    let warningCalled = false;
    const savedWarning = writableWindow().showWarningMessage;
    writableWindow().showWarningMessage = (): Promise<string | undefined> => {
      warningCalled = true;
      return Promise.resolve(undefined);
    };
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        provider
      );
      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

      assert.strictEqual(warningCalled, false, 'no prompt when local does not exist');
      assert.strictEqual(gitService._calls.checkout.length, 1);
      const opts = gitService._calls.checkout[0].args[2] as {
        forceCreate?: boolean;
        track?: string;
      };
      assert.strictEqual(opts.forceCreate, true);
      assert.strictEqual(opts.track, 'origin/main');
    } finally {
      writableWindow().showWarningMessage = savedWarning;
    }
  });
});

/**
 * New Branch dialog-arm pins.
 *
 * Both create entries prefer the New Branch Dialog when an opener is wired and
 * only fall back to the `showInputBox` path when it is absent (test fixtures).
 * The opener carries the start point: the clicked ref for "New Branch from
 * here", the checked-out branch for the popup-header "New Branch". Nothing else
 * asserts the wired-opener arm — the detached-row pins above deliberately
 * construct the dispatcher WITHOUT an opener — so a create handler that lost
 * its opener would silently degrade to the input box and stay green.
 */
describe('New Branch dialog arm', () => {
  interface Preselect {
    repo: IRepository;
    startPoint?: string;
    defaultName?: string;
  }

  /** Dispatcher with a recording New Branch dialog opener wired in. */
  function wireOpener(repo: IRepository, overrides: Partial<IGitService> = {}) {
    const seen: Preselect[] = [];
    const gitService = createSharedMockGitService(repo, overrides);
    const branchTreeProvider = new BranchTreeProvider(gitService);
    branchTreeProvider.setRepository(repo);
    const commands = new BranchContextMenuCommands(
      gitService,
      branchTreeProvider,
      undefined, // conflictResolutionService
      undefined, // pullDialogAccessor
      undefined, // pushDialogOpener
      undefined, // mergeDialogOpener
      (preselect: Preselect) => {
        seen.push(preselect);
        return undefined;
      }
    );
    return { commands, seen };
  }

  let inputBoxCalls = 0;
  let savedShowInputBox: typeof writableWindow extends () => infer W
    ? W extends { showInputBox: infer F }
      ? F
      : never
    : never;

  beforeEach(() => {
    inputBoxCalls = 0;
    savedShowInputBox = writableWindow().showInputBox;
    writableWindow().showInputBox = (async () => {
      inputBoxCalls++;
      return undefined;
    }) as typeof savedShowInputBox;
  });

  afterEach(() => {
    writableWindow().showInputBox = savedShowInputBox;
  });

  it('newBranchFrom opens the dialog with the clicked branch as the start point', async () => {
    let createBranchCalls = 0;
    const { commands, seen } = wireOpener(attachedRepo('main'), {
      createBranch: () => {
        createBranchCalls++;
        return okAsync(undefined);
      },
    });
    const branch: IBranch = {
      name: 'feature/x',
      type: 'local',
      commit: 'abc1234',
      isHead: false,
    };
    const item = new BranchTreeItem('feature/x', 0, 'local-branch', branch, undefined, false);

    await driveBranchMenuCommand(commands, 'intellig.branch.newBranchFrom', item);

    assert.strictEqual(seen.length, 1, 'the New Branch dialog opener must be consulted');
    assert.strictEqual(
      seen[0].startPoint,
      'feature/x',
      'the clicked branch is the start point the dialog preselects'
    );
    assert.strictEqual(inputBoxCalls, 0, 'a wired opener must bypass the showInputBox fallback');
    assert.strictEqual(
      createBranchCalls,
      0,
      'the dialog owns creation; the handler must not create'
    );
  });

  it('the popup-header New Branch starts from the checked-out branch', async () => {
    const { commands, seen } = wireOpener(attachedRepo('main'));

    await driveBranchMenuCommand(commands, 'intellig.branch.new');

    assert.strictEqual(seen.length, 1, 'the New Branch dialog opener must be consulted');
    assert.strictEqual(
      seen[0].startPoint,
      'main',
      'HEAD is the start point, with refs/heads/ stripped'
    );
    assert.strictEqual(inputBoxCalls, 0, 'a wired opener must bypass the showInputBox fallback');
  });
});
