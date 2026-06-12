/**
 * Unit test for the right-click "Pull Using Rebase" / "Pull Using Merge"
 * paths that bypass the PullDialog.
 *
 * Verifies that `_runPullFromBranchMenu` (via `_handlePullUsingRebase` and
 * `_handlePullUsingMerge`) calls `gitService.pull` with `prune: true` so
 * stale remote-tracking refs are cleaned on this menu-driven pull path.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../branches/BranchTreeProvider';
import {
  IBranch,
  IGitService,
  IPullOptions,
  IRepository,
} from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { invokePrivateHandler } from '../../typed/privateHandler';

interface RecordingGitService extends IGitService {
  _pullCalls: Array<{ repo: IRepository; options: IPullOptions | undefined }>;
}

function createRecordingGitService(): RecordingGitService {
  const calls: RecordingGitService['_pullCalls'] = [];
  const service = {
    _pullCalls: calls,
    pull: async (repo: IRepository, options?: IPullOptions): Promise<void> => {
      calls.push({ repo, options });
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as RecordingGitService;
  return service;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
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

function createRemoteBranchItem(fullRef: string): BranchTreeItem {
  const branch: IBranch = {
    name: fullRef,
    type: 'remote',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };
  return new BranchTreeItem(fullRef, 0, 'remote-branch', branch, undefined, false);
}

describe('BranchContextMenuCommands._runPullFromBranchMenu — pull --prune', () => {
  it('pullUsingRebase passes prune: true to gitService.pull', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService();
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService, provider);

    const item = createRemoteBranchItem('origin/main');
    await invokePrivateHandler(commands, '_handlePullUsingRebase', item);

    assert.strictEqual(gitService._pullCalls.length, 1);
    const options = gitService._pullCalls[0].options;
    assert.ok(options, 'pull must be called with options');
    assert.strictEqual(options.rebase, true);
    assert.strictEqual(options.prune, true);
  });

  it('pullUsingMerge passes prune: true to gitService.pull', async () => {
    const repo = createMockRepo();
    const gitService = createRecordingGitService();
    const provider = createMockBranchTreeProvider(repo);
    const commands = new BranchContextMenuCommands(gitService, provider);

    const item = createRemoteBranchItem('origin/main');
    await invokePrivateHandler(commands, '_handlePullUsingMerge', item);

    assert.strictEqual(gitService._pullCalls.length, 1);
    const options = gitService._pullCalls[0].options;
    assert.ok(options, 'pull must be called with options');
    assert.strictEqual(options.rebase, false);
    assert.strictEqual(options.prune, true);
  });
});
