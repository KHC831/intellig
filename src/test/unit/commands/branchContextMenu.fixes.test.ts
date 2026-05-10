/**
 * Unit tests for T2-02 — finished checkoutAndRebase / pullUsingRebase /
 * pullUsingMerge handlers.
 *
 * Complements the existing property tests (which cover the fallback /
 * error paths) by exercising the *wired* path:
 *   - `_handleCheckoutAndRebase`: happy path (checkout → rebase → refresh),
 *     and conflict → `openResolveConflictsDialog` with `operation: 'rebase'`.
 *   - `_handlePullUsingRebase` / `_handlePullUsingMerge`: when a PullDialog
 *     accessor is wired, the handlers route through `PullDialog.show(repo,
 *     preset, { remote, branch })`. When the accessor is absent, the
 *     fallback direct-pull path is used (preserving the behaviour covered
 *     by the property suite).
 */

import '../../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../commands/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../services/BranchTreeProvider';
import {
  IBasicRebaseResult,
  IBranch,
  IFetchResult,
  IGitService,
  IRepository,
} from '../../../services/interfaces/IGitService';
import {
  IConflictedFile,
  IConflictOpContext,
  IConflictResolutionService,
} from '../../../services/interfaces/IConflictResolutionService';
import type { PullDialog } from '../../../services/PullDialog';
import { EventEmitter, Uri } from '../../mocks/vscode';

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
    checkout: async (repo: IRepository, ref: string, options?: unknown) => {
      calls.checkout.push({ args: [repo, ref, options] });
    },
    rebaseBranch: async (repo: IRepository, onto: string): Promise<IBasicRebaseResult> => {
      calls.rebaseBranch.push({ args: [repo, onto] });
      return rebaseResult;
    },
    pull: async (repo: IRepository, options?: unknown) => {
      calls.pull.push({ args: [repo, options] });
    },
    fetch: async (): Promise<IFetchResult> => ({
      updatedRefs: [],
      ahead: 0,
      behind: 0,
      errors: [],
    }),
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

describe('T2-02 BranchContextMenuCommands — checkoutAndRebase', () => {
  it('happy path: checkout then rebaseBranch with previous branch as onto', async () => {
    const gitService = createMockGitService({ success: true });
    const repo = createMockRepo('main');
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);

    const item = createLocalBranchTreeItem('feature/x');
    await (
      commands as unknown as {
        _handleCheckoutAndRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handleCheckoutAndRebase(item);

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
    await (
      commands as unknown as {
        _handleCheckoutAndRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handleCheckoutAndRebase(item);

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

  it('returns early when repository is missing', async () => {
    const gitService = createMockGitService();
    const provider = createMockBranchTreeProvider(undefined);
    const commands = new BranchContextMenuCommands(gitService as unknown as IGitService, provider);
    const item = createLocalBranchTreeItem('feature/x');
    await (
      commands as unknown as {
        _handleCheckoutAndRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handleCheckoutAndRebase(item);

    assert.strictEqual(gitService._calls.checkout.length, 0);
    assert.strictEqual(gitService._calls.rebaseBranch.length, 0);
  });
});

// ─── Tests: pullUsingRebase / pullUsingMerge ─────────────────────────────────

describe('T2-02 BranchContextMenuCommands — pullUsingRebase / pullUsingMerge', () => {
  it('pullUsingRebase: routes through PullDialog with preset="rebase" + remote/branch prefilled', async () => {
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

    const item = createRemoteBranchTreeItem('origin/feature/x');
    await (
      commands as unknown as {
        _handlePullUsingRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingRebase(item);

    assert.strictEqual(pullDialog._calls.length, 1);
    const [repoArg, preset, source] = pullDialog._calls[0].args;
    assert.strictEqual(repoArg, repo);
    assert.strictEqual(preset, 'rebase');
    assert.deepStrictEqual(source, { remote: 'origin', branch: 'feature/x' });
    // Direct pull NOT invoked because the dialog accessor handled it.
    assert.strictEqual(gitService._calls.pull.length, 0);
  });

  it('pullUsingMerge: routes through PullDialog with preset="merge"', async () => {
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

    const item = createRemoteBranchTreeItem('origin/develop');
    await (
      commands as unknown as {
        _handlePullUsingMerge(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingMerge(item);

    assert.strictEqual(pullDialog._calls.length, 1);
    const [, preset, source] = pullDialog._calls[0].args;
    assert.strictEqual(preset, 'merge');
    assert.deepStrictEqual(source, { remote: 'origin', branch: 'develop' });
    assert.strictEqual(gitService._calls.pull.length, 0);
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
    await (
      commands as unknown as {
        _handlePullUsingRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingRebase(item);

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
    await (
      commands as unknown as {
        _handlePullUsingMerge(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingMerge(item);

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
    await (
      commands as unknown as {
        _handlePullUsingRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingRebase(item);

    assert.strictEqual(pullDialog._calls.length, 0);
    assert.strictEqual(gitService._calls.pull.length, 0);
  });

  it('remote branch name without "/" maps remote=fullName branch=fullName', async () => {
    // Defensive: BranchTreeItem names should always be "<remote>/<branch>",
    // but the parser handles the degenerate no-slash case by using the
    // whole string as both remote and branch. Lock that behaviour in.
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
    await (
      commands as unknown as {
        _handlePullUsingRebase(i: BranchTreeItem): Promise<void>;
      }
    )._handlePullUsingRebase(item);

    assert.strictEqual(pullDialog._calls.length, 1);
    const [, , source] = pullDialog._calls[0].args;
    assert.deepStrictEqual(source, { remote: 'origin-only', branch: 'origin-only' });
  });
});
