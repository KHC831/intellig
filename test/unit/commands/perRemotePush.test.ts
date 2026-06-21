/**
 * Per-remote push (D-6) — choosing the target remote.
 *
 * IntelliJ's push dialog (git4idea GitPushTargetPanel / GitPushTarget
 * `getRemoteToPush`) lets the user pick which remote to push to when a repo
 * has several, defaulting to the branch's tracked remote, then origin, then
 * the first remote (GitUtil.getDefaultOrFirstRemote).
 *
 * These tests pin the branch-push fallback path and the tag-push path in
 * BranchContextMenuCommands:
 *   - >1 remote → a QuickPick of remotes is shown and the chosen remote is
 *     routed verbatim into gitService.push / pushTag.
 *   - exactly 1 remote → no prompt (single-remote fast path, unchanged).
 */

import '../../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  IBranch,
  IGitService,
  IRemote,
  IRepository,
  ITag,
  IUpstream,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';

interface PushCall {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  refspec?: string;
}

interface MockGitService {
  _push: PushCall[];
  _pushTag: Array<{ name: string; remote?: string }>;
  getRemotes: (repo: IRepository) => Promise<IRemote[]>;
  push: (repo: IRepository, options?: PushCall) => Promise<void>;
  pushTag: (repo: IRepository, name: string, remote?: string) => Promise<void>;
  reloadRepository: (repo: IRepository) => Promise<IRepository>;
}

function createMockGitService(remotes: string[]): MockGitService {
  const svc: MockGitService = {
    _push: [],
    _pushTag: [],
    getRemotes: async () => remotes.map((name) => ({ name })),
    push: async (_repo: IRepository, options?: PushCall) => {
      svc._push.push(options ?? {});
    },
    pushTag: async (_repo: IRepository, name: string, remote?: string) => {
      svc._pushTag.push({ name, remote });
    },
    reloadRepository: async (repo: IRepository) => repo,
  };
  return svc;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function createMockProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

function localBranchItem(name: string, upstream?: IUpstream): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'abc1234', isHead: false, upstream };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

function tagItem(name: string): BranchTreeItem {
  const tag: ITag = { name, commit: 'abc1234', isAnnotated: false };
  return new BranchTreeItem(name, 0, 'tag', undefined, tag, false);
}

type WithPrivate = {
  _handlePush(item: BranchTreeItem): Promise<void>;
  _handleTagPush(item: BranchTreeItem): Promise<void>;
};

describe('BranchContextMenuCommands — per-remote push (D-6)', () => {
  afterEach(() => {
    restoreMessageFunctions();
    // Reset the QuickPick stub between cases.
    writableWindow().showQuickPick = async () => undefined;
  });

  it('branch push with >1 remote prompts and routes to the chosen remote', async () => {
    const gitService = createMockGitService(['origin', 'backup']);
    const repo = createMockRepo();
    let quickPickShown = 0;
    let offered: string[] = [];
    writableWindow().showQuickPick = async (items: unknown[]) => {
      quickPickShown += 1;
      offered = (items as Array<{ label: string }>).map((i) => i.label);
      return { label: 'backup' };
    };
    const info = installInfoMessageTracker();
    try {
      // No upstream → default is origin-or-first; user overrides to "backup".
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        createMockProvider(repo)
      );
      await (commands as unknown as WithPrivate)._handlePush(localBranchItem('feature/x'));

      assert.strictEqual(quickPickShown, 1, 'QuickPick must be shown with >1 remote');
      assert.deepStrictEqual(offered, ['origin', 'backup'], 'both remotes offered, default first');
      assert.strictEqual(gitService._push.length, 1, 'exactly one push');
      assert.strictEqual(gitService._push[0].remote, 'backup', 'pushes to the chosen remote');
      assert.strictEqual(gitService._push[0].branch, 'feature/x');
      assert.strictEqual(
        gitService._push[0].setUpstream,
        true,
        'no prior upstream → sets upstream to the chosen remote'
      );
      assert.ok(info.calls.some((c) => c.message.includes('backup')));
    } finally {
      restoreMessageFunctions();
    }
  });

  it('branch push defaults the QuickPick to the tracked remote', async () => {
    const gitService = createMockGitService(['origin', 'backup']);
    const repo = createMockRepo();
    let offered: string[] = [];
    writableWindow().showQuickPick = async (items: unknown[]) => {
      offered = (items as Array<{ label: string }>).map((i) => i.label);
      return { label: 'backup' };
    };
    installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      createMockProvider(repo)
    );
    // Tracked remote = "backup" → it must be offered first (the default).
    await (commands as unknown as WithPrivate)._handlePush(
      localBranchItem('feature/x', { remote: 'backup', name: 'feature/x' })
    );
    assert.deepStrictEqual(offered, ['backup', 'origin'], 'tracked remote is the default (first)');
  });

  it('branch push with exactly 1 remote does NOT prompt (fast path)', async () => {
    const gitService = createMockGitService(['origin']);
    const repo = createMockRepo();
    let quickPickShown = 0;
    writableWindow().showQuickPick = async () => {
      quickPickShown += 1;
      return undefined;
    };
    installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      createMockProvider(repo)
    );
    await (commands as unknown as WithPrivate)._handlePush(
      localBranchItem('feature/x', { remote: 'origin', name: 'feature/x' })
    );
    assert.strictEqual(quickPickShown, 0, 'single remote → no prompt');
    assert.strictEqual(gitService._push.length, 1);
    assert.strictEqual(gitService._push[0].remote, 'origin');
  });

  it('branch push aborts when the user cancels the remote QuickPick', async () => {
    const gitService = createMockGitService(['origin', 'backup']);
    const repo = createMockRepo();
    writableWindow().showQuickPick = async () => undefined; // cancelled
    installInfoMessageTracker();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      createMockProvider(repo)
    );
    await (commands as unknown as WithPrivate)._handlePush(localBranchItem('feature/x'));
    assert.strictEqual(gitService._push.length, 0, 'cancel → no push');
  });

  it('tag push with >1 remote prompts and routes the chosen remote into pushTag', async () => {
    const gitService = createMockGitService(['origin', 'backup']);
    const repo = createMockRepo();
    let quickPickShown = 0;
    writableWindow().showQuickPick = async () => {
      quickPickShown += 1;
      return { label: 'backup' };
    };
    const info = installInfoMessageTracker();
    try {
      const commands = new BranchContextMenuCommands(
        gitService as unknown as IGitService,
        createMockProvider(repo)
      );
      await (commands as unknown as WithPrivate)._handleTagPush(tagItem('v1.0.0'));
      assert.strictEqual(quickPickShown, 1);
      assert.strictEqual(gitService._pushTag.length, 1);
      assert.strictEqual(gitService._pushTag[0].name, 'v1.0.0');
      assert.strictEqual(gitService._pushTag[0].remote, 'backup');
      assert.ok(info.calls.some((c) => c.message.includes('backup')));
    } finally {
      restoreMessageFunctions();
    }
  });

  it('tag push with exactly 1 remote does NOT prompt (fast path)', async () => {
    const gitService = createMockGitService(['origin']);
    const repo = createMockRepo();
    let quickPickShown = 0;
    writableWindow().showQuickPick = async () => {
      quickPickShown += 1;
      return undefined;
    };
    installInfoMessageTracker();
    installErrorMessageTracker();
    const commands = new BranchContextMenuCommands(
      gitService as unknown as IGitService,
      createMockProvider(repo)
    );
    await (commands as unknown as WithPrivate)._handleTagPush(tagItem('v1.0.0'));
    assert.strictEqual(quickPickShown, 0, 'single remote → no prompt');
    assert.strictEqual(gitService._pushTag.length, 1);
    assert.strictEqual(gitService._pushTag[0].remote, 'origin');
  });
});
