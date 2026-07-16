/**
 * Branch/tag cherry-pick entry points honour intellig.addCherryPickedFromSuffix
 * (F-F8 addendum) — IntelliJ applies `-x` when the setting is on AND the commit
 * is published (CherryPickProcess.kt shouldAddSuffix); unpublished commits are
 * never annotated. Mirrors the commit-context-menu wiring.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import {
  IBranch,
  ICherryPickOptions,
  IGitService,
  IRepository,
  ITag,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import {
  installInfoMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';

const HASH = 'abc1234def5678abc1234def5678abc1234def56';

interface Recording {
  cherryCalls: Array<{ hashes: string[]; options?: ICherryPickOptions }>;
  probeCalls: string[][];
}

function makeService(opts: { published: boolean; withCli?: boolean }): IGitService & Recording {
  const cherryCalls: Recording['cherryCalls'] = [];
  const probeCalls: Recording['probeCalls'] = [];
  const service = {
    cherryCalls,
    probeCalls,
    getLog: async () => [
      {
        hash: HASH,
        shortHash: HASH.substring(0, 7),
        message: 'subject',
        author: { name: 'A', email: 'a@a' },
        committer: { name: 'A', email: 'a@a' },
        parents: [],
        authorDate: new Date(0),
        commitDate: new Date(0),
      },
    ],
    cherryPick: (_repo: IRepository, hashes: string[], options?: ICherryPickOptions) => {
      cherryCalls.push({ hashes, options });
      return okAsync({ success: true });
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as IGitService & Recording;
  if (opts.withCli !== false) {
    (service as unknown as { gitCli: unknown }).gitCli = {
      exec: async (args: string[]) => {
        probeCalls.push(args);
        return {
          exitCode: 0,
          stdout: opts.published ? '  origin/main\n' : '',
          stderr: '',
          combined: '',
        };
      },
    };
  }
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

function tagItem(name: string): BranchTreeItem {
  const tag: ITag = { name, commit: HASH, isAnnotated: false };
  return new BranchTreeItem(name, 0, 'tag', undefined, tag, false);
}

function remoteBranchItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'remote', commit: HASH, isHead: false };
  return new BranchTreeItem(name, 0, 'remote-branch', branch, undefined, false);
}

function stubQuickPickSelectAll(): () => void {
  const w = writableWindow();
  const original = w.showQuickPick;
  w.showQuickPick = (items: unknown): Promise<unknown> =>
    Promise.resolve(Array.isArray(items) ? items : undefined);
  return () => {
    w.showQuickPick = original;
  };
}

describe('branch/tag cherry-pick — addCherryPickedFromSuffix wiring (F-F8)', () => {
  afterEach(() => {
    restoreMessageFunctions();
    resetMockConfiguration();
  });

  it('tag.cherryPick annotates a PUBLISHED commit when the setting is on (default)', async () => {
    const repo = makeRepo();
    const service = makeService({ published: true });
    installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(service.cherryCalls.length, 1);
    assert.strictEqual(
      service.cherryCalls[0].options?.addCherryPickedFrom,
      true,
      'published + setting on → -x'
    );
  });

  it('tag.cherryPick never annotates an UNPUBLISHED commit', async () => {
    const repo = makeRepo();
    const service = makeService({ published: false });
    installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(service.cherryCalls.length, 1);
    assert.notStrictEqual(service.cherryCalls[0].options?.addCherryPickedFrom, true);
  });

  it('remoteBranch.cherryPickCommits annotates published picks', async () => {
    const repo = makeRepo();
    const service = makeService({ published: true });
    installInfoMessageTracker();
    const restore = stubQuickPickSelectAll();
    try {
      const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

      await driveBranchMenuCommand(
        cmds,
        'intellig.remoteBranch.cherryPickCommits',
        remoteBranchItem('origin/feature')
      );

      assert.strictEqual(service.cherryCalls.length, 1);
      assert.strictEqual(service.cherryCalls[0].options?.addCherryPickedFrom, true);
    } finally {
      restore();
    }
  });

  it('setting OFF: no probe runs and no annotation is requested', async () => {
    setMockConfigValue('intellig', 'addCherryPickedFromSuffix', false);
    const repo = makeRepo();
    const service = makeService({ published: true });
    installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(service.probeCalls.length, 0, 'no publish probe when the setting is off');
    assert.notStrictEqual(service.cherryCalls[0].options?.addCherryPickedFrom, true);
  });

  it('degrades to no annotation when the service exposes no gitCli (legacy stubs)', async () => {
    const repo = makeRepo();
    const service = makeService({ published: true, withCli: false });
    installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.tag.cherryPick', tagItem('v1.0.0'));

    assert.strictEqual(service.cherryCalls.length, 1, 'the cherry-pick itself still runs');
    assert.notStrictEqual(service.cherryCalls[0].options?.addCherryPickedFrom, true);
  });
});
