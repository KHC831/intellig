/**
 * Ref-deletion cascade offers for branches — git4idea parity, mirroring the
 * tag cascades already in place.
 *
 * Local delete → the success notification offers "Delete Tracked Branch"
 * when the deleted branch's upstream has no other tracking local and is not
 * protected (GitDeleteBranchOperation.java:158-165). Remote delete → the
 * confirm offers deleting the tracking LOCAL branches too, current branch
 * excluded (GitDeleteRemoteBranchOperation.java:46-72).
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  IBranch,
  IGitService,
  IPushOptions,
  IRepository,
  IUpstream,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import {
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
  MessageTracker,
} from '../../typed/windowStub';

interface RecordingGitService extends IGitService {
  _pushCalls: IPushOptions[];
  _deletedBranches: Array<{ name: string; force: boolean | undefined }>;
}

/**
 * `branches` is the post-deletion branch list the cascade eligibility check
 * reads (the deleted branch itself must not be in it).
 */
function makeService(branches: IBranch[]): RecordingGitService {
  const service = {
    _pushCalls: [] as IPushOptions[],
    _deletedBranches: [] as Array<{ name: string; force: boolean | undefined }>,
    deleteBranch(this: RecordingGitService, _repo: IRepository, name: string, force?: boolean) {
      this._deletedBranches.push({ name, force });
      return okAsync(undefined);
    },
    push(this: RecordingGitService, _repo: IRepository, options: IPushOptions) {
      this._pushCalls.push(options);
      return okAsync(undefined);
    },
    getBranches: async () => branches,
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as RecordingGitService;
  return service;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function makeProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

function localBranch(name: string, upstream?: IUpstream, isHead = false): IBranch {
  return { name, type: 'local', commit: 'abc1234', isHead, upstream };
}

function localItem(name: string, upstream?: IUpstream): BranchTreeItem {
  return new BranchTreeItem(name, 0, 'local-branch', localBranch(name, upstream), undefined, false);
}

function remoteItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'remote', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'remote-branch', branch, undefined, false);
}

/** Info tracker that also resolves with a chosen action label. */
function installInfoTrackerWithChoice(returnChoice?: string): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  writableWindow().showInformationMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(returnChoice);
  };
  return tracker;
}

/** Flush the fire-and-forget offer chains before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const UPSTREAM: IUpstream = { remote: 'origin', name: 'feature' };

describe('branch.delete — Delete Tracked Branch cascade', () => {
  afterEach(() => {
    restoreMessageFunctions();
    resetMockConfiguration();
  });

  it('offers Delete Tracked Branch and deletes the upstream on accept', async () => {
    const repo = makeRepo();
    // Post-deletion list: only main remains; nothing else tracks origin/feature.
    const service = makeService([localBranch('main', { remote: 'origin', name: 'main' }, true)]);
    installWarningMessageTracker('Delete');
    const info = installInfoTrackerWithChoice('Delete Tracked Branch');
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.delete', localItem('feature', UPSTREAM));
    await settle();

    assert.ok(
      info.calls.some((c) => c.items?.includes('Delete Tracked Branch')),
      `success toast must offer the tracked-branch cascade; got: ${JSON.stringify(info.calls)}`
    );
    assert.strictEqual(service._pushCalls.length, 1, 'accepting deletes the remote ref');
    assert.strictEqual(service._pushCalls[0].remote, 'origin');
    assert.strictEqual(service._pushCalls[0].branch, ':feature');
  });

  it('does not offer the cascade when another local still tracks the upstream', async () => {
    const repo = makeRepo();
    const service = makeService([
      localBranch('main', { remote: 'origin', name: 'main' }, true),
      localBranch('feature-copy', UPSTREAM),
    ]);
    installWarningMessageTracker('Delete');
    const info = installInfoTrackerWithChoice('Delete Tracked Branch');
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.delete', localItem('feature', UPSTREAM));
    await settle();

    assert.ok(
      !info.calls.some((c) => c.items?.includes('Delete Tracked Branch')),
      'another tracker exists — no cascade offer'
    );
    assert.strictEqual(service._pushCalls.length, 0);
  });

  it('does not offer the cascade for a protected upstream', async () => {
    setMockConfigValue('intellig', 'protectedBranches', ['feature']);
    const repo = makeRepo();
    const service = makeService([localBranch('main', { remote: 'origin', name: 'main' }, true)]);
    installWarningMessageTracker('Delete');
    const info = installInfoTrackerWithChoice('Delete Tracked Branch');
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.delete', localItem('feature', UPSTREAM));
    await settle();

    assert.ok(
      !info.calls.some((c) => c.items?.includes('Delete Tracked Branch')),
      'protected upstream — no cascade offer'
    );
    assert.strictEqual(service._pushCalls.length, 0);
  });
});

describe('remoteBranch.deleteRemote — tracking-locals cascade', () => {
  afterEach(() => {
    restoreMessageFunctions();
    resetMockConfiguration();
  });

  it('offers deleting the tracking local branches (current excluded) and deletes them on accept', async () => {
    const repo = makeRepo();
    const service = makeService([
      localBranch('main', { remote: 'origin', name: 'main' }, true),
      localBranch('feature', UPSTREAM),
    ]);
    const warn = installWarningMessageTracker('Delete with Local Branches');
    installInfoTrackerWithChoice();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(
      cmds,
      'intellig.remoteBranch.deleteRemote',
      remoteItem('origin/feature')
    );
    await settle();

    assert.ok(
      warn.calls.some((c) => c.items?.includes('Delete with Local Branches')),
      `confirm must offer the tracking-locals cascade; got: ${JSON.stringify(warn.calls)}`
    );
    assert.strictEqual(service._pushCalls.length, 1, 'the remote ref is deleted');
    assert.strictEqual(service._pushCalls[0].branch, ':feature');
    assert.deepStrictEqual(
      service._deletedBranches.map((d) => d.name),
      ['feature'],
      'the tracking local is deleted too'
    );
  });

  it('excludes the CURRENT branch from the cascade offer', async () => {
    const repo = makeRepo();
    // The only tracker of origin/feature is the checked-out branch.
    const service = makeService([localBranch('feature', UPSTREAM, true)]);
    const warn = installWarningMessageTracker('Delete');
    installInfoTrackerWithChoice();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(
      cmds,
      'intellig.remoteBranch.deleteRemote',
      remoteItem('origin/feature')
    );
    await settle();

    assert.ok(
      !warn.calls.some((c) => c.items?.includes('Delete with Local Branches')),
      'current branch must never be proposed for deletion'
    );
    assert.strictEqual(service._pushCalls.length, 1, 'plain remote delete still works');
    assert.strictEqual(service._deletedBranches.length, 0);
  });
});
