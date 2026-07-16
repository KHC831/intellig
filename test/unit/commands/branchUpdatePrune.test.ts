/**
 * Unit test for the Branches-tree → Update command path.
 *
 * `_handleUpdate` splits by checked-out state: the CURRENT branch is
 * INTEGRATED — fetch its upstream remote with `{ remote, prune: true }`, then
 * `pull` with the branch-default strategy + autostash (git4idea routes the
 * checked-out branch through GitUpdateExecutionProcess,
 * GitBranchActionsUtil.kt:51-63 — a fetch-and-toast is not an update) — while
 * a NON-current branch is updated via the align-local
 * `<remoteRef>:<localRef>` fast-forward refspec.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync, errAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  IBranch,
  IFetchOptions,
  IGitService,
  IPullOptions,
  IRepository,
  IUpstream,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import {
  installInfoMessageTracker,
  installErrorMessageTracker,
  restoreMessageFunctions,
} from '../../typed/windowStub';
import { IConflictResolutionService } from '../../../src/conflicts/interfaces/IConflictResolutionService';

interface RecordingGitService extends IGitService {
  _fetchCalls: Array<{ repo: IRepository; arg: IFetchOptions | string | undefined }>;
  _pullCalls: Array<IPullOptions | undefined>;
}

function createRecordingGitService(opts?: {
  incoming?: number;
  probeFails?: boolean;
  pullError?: Error;
}): RecordingGitService {
  const fetchCalls: RecordingGitService['_fetchCalls'] = [];
  const pullCalls: RecordingGitService['_pullCalls'] = [];
  const service = {
    _fetchCalls: fetchCalls,
    _pullCalls: pullCalls,
    fetch: (repo: IRepository, arg?: IFetchOptions | string) => {
      fetchCalls.push({ repo, arg });
      return okAsync({ updatedRefs: [], ahead: 0, behind: 0, errors: [] });
    },
    pull: (_repo: IRepository, options?: IPullOptions) => {
      pullCalls.push(options);
      if (opts?.pullError) {
        return errAsync(opts.pullError);
      }
      return okAsync(undefined);
    },
    getIncomingOutgoingForBranch: async (_repo: IRepository, branch: string) => {
      if (opts?.probeFails) {
        throw new Error('probe failed');
      }
      return {
        branch,
        upstream: 'origin/feature',
        incoming: opts?.incoming ?? 3,
        outgoing: 0,
        noUpstream: false,
      };
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as RecordingGitService;
  return service;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/feature', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function createMockBranchTreeProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

function createLocalBranchItem(
  branchName: string,
  upstream: IUpstream,
  isHead = false
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead,
    upstream,
  };
  return new BranchTreeItem(branchName, 0, 'local-branch', branch, undefined, false);
}

const UPSTREAM: IUpstream = { remote: 'origin', name: 'feature' };

describe('BranchContextMenuCommands._handleUpdate — current branch integrates', () => {
  afterEach(() => {
    restoreMessageFunctions();
    resetMockConfiguration();
  });

  it('fetches { remote, prune: true } then pulls with autostash for the CURRENT branch', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService({ incoming: 3 });
    const info = installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, createMockBranchTreeProvider(repo));

    await driveBranchMenuCommand(
      commands,
      'intellig.branch.update',
      createLocalBranchItem('feature', UPSTREAM, true)
    );

    assert.strictEqual(gitService._fetchCalls.length, 1, 'exactly one fetch');
    const arg = gitService._fetchCalls[0].arg;
    assert.ok(arg && typeof arg === 'object', 'fetch arg must be an IFetchOptions object');
    assert.strictEqual(arg.remote, UPSTREAM.remote);
    assert.strictEqual(arg.prune, true);

    assert.strictEqual(gitService._pullCalls.length, 1, 'the current branch must be INTEGRATED');
    const pull = gitService._pullCalls[0];
    assert.ok(pull, 'pull options present');
    assert.strictEqual(pull.autostash, true, 'local changes are saved around the update');
    assert.strictEqual(pull.rebase, undefined, 'pullRebase=false resolves to merge (no --rebase)');
    assert.ok(
      info.calls.some((c) => /updated/i.test(c.message)),
      `toast should report the update; got: ${info.calls.map((c) => c.message).join(' | ')}`
    );
  });

  it('honours intellig.pullRebase=true by pulling with --rebase', async () => {
    setMockConfigValue('intellig', 'pullRebase', true);
    const repo = createMockRepo();
    const gitService = createRecordingGitService({ incoming: 2 });
    installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, createMockBranchTreeProvider(repo));

    await driveBranchMenuCommand(
      commands,
      'intellig.branch.update',
      createLocalBranchItem('feature', UPSTREAM, true)
    );

    assert.strictEqual(gitService._pullCalls.length, 1);
    assert.strictEqual(gitService._pullCalls[0]?.rebase, true);
  });

  it('skips the pull and reports up to date when the probe says incoming === 0', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService({ incoming: 0 });
    const info = installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, createMockBranchTreeProvider(repo));

    await driveBranchMenuCommand(
      commands,
      'intellig.branch.update',
      createLocalBranchItem('feature', UPSTREAM, true)
    );

    assert.strictEqual(gitService._fetchCalls.length, 1);
    assert.strictEqual(gitService._pullCalls.length, 0, 'no pull when already up to date');
    assert.ok(
      info.calls.some((c) => /up to date/i.test(c.message)),
      `expected an up-to-date toast; got: ${info.calls.map((c) => c.message).join(' | ')}`
    );
  });

  it('pulls anyway when the divergence probe fails (never claims up to date unverified)', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService({ probeFails: true });
    const info = installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(gitService, createMockBranchTreeProvider(repo));

    await driveBranchMenuCommand(
      commands,
      'intellig.branch.update',
      createLocalBranchItem('feature', UPSTREAM, true)
    );

    assert.strictEqual(gitService._pullCalls.length, 1, 'probe failure must not skip the pull');
    const all = info.calls.map((c) => c.message).join(' | ');
    assert.ok(!/up to date/i.test(all), `must not claim up-to-date on a failed probe; got: ${all}`);
  });

  it('routes a conflicting pull into the Resolve Conflicts dialog with the strategy operation', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService({
      incoming: 1,
      pullError: new Error('CONFLICT (content): Merge conflict in src/a.ts'),
    });
    installErrorMessageTracker();
    const dialogCalls: Array<{ operation: string; target?: string }> = [];
    const conflictService = {
      getConflictedFiles: async () => [{ path: 'src/a.ts', resolved: false }],
      openResolveConflictsDialog: async (
        _repo: IRepository,
        _conflicts: unknown,
        options: { operation: string; target?: string }
      ) => {
        dialogCalls.push(options);
      },
    } as unknown as IConflictResolutionService;
    const commands = new BranchContextMenuCommands(
      gitService,
      createMockBranchTreeProvider(repo),
      conflictService
    );

    await driveBranchMenuCommand(
      commands,
      'intellig.branch.update',
      createLocalBranchItem('feature', UPSTREAM, true)
    );

    assert.strictEqual(dialogCalls.length, 1, 'conflicts must hand off to the dialog');
    assert.strictEqual(dialogCalls[0].operation, 'merge', 'merge strategy → merge operation');
  });
});
