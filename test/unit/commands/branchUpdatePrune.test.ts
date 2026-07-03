/**
 * Unit test for the Branches-tree → Update command path.
 *
 * `_handleUpdate` splits by checked-out state: the CURRENT branch fetches its
 * upstream remote with `{ remote, prune: true }` (stale remote-tracking refs
 * cleaned; a checked-out ref cannot be fetched into), while a NON-current
 * branch is genuinely updated via the align-local `<remoteRef>:<localRef>`
 * fast-forward refspec.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  IBranch,
  IFetchOptions,
  IGitService,
  IRepository,
  IUpstream,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface RecordingGitService extends IGitService {
  _fetchCalls: Array<{ repo: IRepository; arg: IFetchOptions | string | undefined }>;
}

function createRecordingGitService(): RecordingGitService {
  const calls: RecordingGitService['_fetchCalls'] = [];
  const service = {
    _fetchCalls: calls,
    fetch: (repo: IRepository, arg?: IFetchOptions | string) => {
      calls.push({ repo, arg });
      return okAsync({ updatedRefs: [], ahead: 0, behind: 0, errors: [] });
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

describe('BranchContextMenuCommands._handleUpdate — fetch --prune', () => {
  it('passes { remote, prune: true } to gitService.fetch for the CURRENT branch (no string-form)', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService();
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService, provider);

    const upstream: IUpstream = { remote: 'origin', name: 'feature' };
    const item = createLocalBranchItem('feature', upstream, true);

    await driveBranchMenuCommand(commands, 'intellig.branch.update', item);

    assert.strictEqual(
      gitService._fetchCalls.length,
      1,
      `expected one fetch call, got ${gitService._fetchCalls.length}`
    );
    const arg = gitService._fetchCalls[0].arg;
    assert.strictEqual(
      typeof arg,
      'object',
      `expected the fetch arg to be an IFetchOptions object, got typeof === ${typeof arg}`
    );
    assert.ok(arg && typeof arg === 'object', 'fetch arg must be an object');
    assert.strictEqual(arg.remote, upstream.remote);
    assert.strictEqual(arg.prune, true);
  });
});
