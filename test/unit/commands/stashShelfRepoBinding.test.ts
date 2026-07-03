/**
 * Repo binding for the silent shelf/stash palette commands.
 *
 * - "Unshelve Silently" / "Import Patches" must bind the shelf view to the
 *   repo WITHOUT UI (setRepository), not via show() — which pops the whole
 *   "Shelved Changes" QuickPick as a side effect of a supposedly silent
 *   command.
 * - "Rename Stash…" / "Create Branch from Stash…" must resolve the target
 *   repo through the shared resolver (picker in multi-root), not blindly
 *   take repositories[0].
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerStashShelfCommands } from '../../../src/commands/registration/stashShelfCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

type Handler = (...args: unknown[]) => unknown;

function repoAt(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface ViewRecorder {
  showCalls: IRepository[];
  boundRepos: IRepository[];
}

function makeShelfView(rec: ViewRecorder): unknown {
  return {
    show: async (repo: IRepository) => {
      rec.showCalls.push(repo);
    },
    setRepository: (repo: IRepository) => {
      rec.boundRepos.push(repo);
    },
    refresh: async () => ({}),
    unshelveSilent: async () => ({ success: true }),
    importPatches: async () => {},
  };
}

function makeStashView(rec: ViewRecorder): unknown {
  return {
    show: async (repo: IRepository) => {
      rec.showCalls.push(repo);
    },
    setRepository: (repo: IRepository) => {
      rec.boundRepos.push(repo);
    },
    refresh: async () => ({}),
    getState: () => ({ stashes: [] }),
    renameStash: async () => {},
    branchFromStash: async () => {},
  };
}

describe('stash/shelf palette commands — repo binding', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  const win = vscode.window as unknown as Record<string, unknown>;
  const winSnapshot: Record<string, unknown> = {};
  let infos: string[];

  beforeEach(() => {
    infos = [];
    handlers.clear();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    for (const k of ['showInformationMessage', 'showErrorMessage', 'showQuickPick']) {
      winSnapshot[k] = win[k];
    }
    win.showInformationMessage = async (m: string): Promise<undefined> => {
      infos.push(m);
      return undefined;
    };
    win.showErrorMessage = async (): Promise<undefined> => undefined;
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    for (const k of Object.keys(winSnapshot)) {
      win[k] = winSnapshot[k];
    }
  });

  function makeCtx(
    repos: IRepository[],
    shelfRec: ViewRecorder,
    stashRec: ViewRecorder
  ): ICommandContext {
    return {
      services: {
        gitService: {
          getRepositories: () => repos,
          getRepository: async () => repos[0],
        },
        shelfService: { getShelfItems: () => [] },
        conflictResolutionService: {},
        changelistService: {},
      },
      shelfView: makeShelfView(shelfRec),
      stashView: makeStashView(stashRec),
      context: { subscriptions: [], workspaceState: { get: <T>(_k: string, d?: T) => d } },
    } as unknown as ICommandContext;
  }

  it('unshelve.silent binds the shelf view without opening the shelf list UI', async () => {
    const shelfRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    const stashRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    const repo = repoAt('/r1');
    registerStashShelfCommands(makeCtx([repo], shelfRec, stashRec));

    await handlers.get('intellig.unshelve.silent')!();

    assert.deepStrictEqual(shelfRec.showCalls, [], 'a silent command must not open the shelf UI');
    assert.deepStrictEqual(shelfRec.boundRepos, [repo], 'the view is bound via setRepository');
    assert.ok(
      infos.some((m) => /no shelf entries/i.test(m)),
      `empty shelf reports informatively; got: ${infos.join(' | ')}`
    );
  });

  it('shelve.importPatches binds without opening the shelf list UI', async () => {
    const shelfRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    const stashRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    registerStashShelfCommands(makeCtx([repoAt('/r1')], shelfRec, stashRec));

    await handlers.get('intellig.shelve.importPatches')!();

    assert.deepStrictEqual(shelfRec.showCalls, [], 'import patches must not pop the shelf list');
    assert.strictEqual(shelfRec.boundRepos.length, 1);
  });

  it('stash.rename resolves the repo via the shared resolver (multi-root picker), not repositories[0]', async () => {
    const shelfRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    const stashRec: ViewRecorder = { showCalls: [], boundRepos: [] };
    const repo1 = repoAt('/r1');
    const repo2 = repoAt('/r2');
    registerStashShelfCommands(makeCtx([repo1, repo2], shelfRec, stashRec));

    // Multi-root: the resolver shows a repo QuickPick — pick the SECOND repo.
    win.showQuickPick = async (items: Array<{ repo?: IRepository }>): Promise<unknown> => items[1];

    await handlers.get('intellig.stash.rename')!();

    const bound = [...stashRec.boundRepos, ...stashRec.showCalls];
    assert.strictEqual(bound.length > 0, true, 'the stash view must be bound to a repo');
    assert.strictEqual(
      bound[0],
      repo2,
      'the PICKED repo must be targeted, not blindly repositories[0]'
    );
    assert.deepStrictEqual(stashRec.showCalls, [], 'binding must not open the stash list UI');
  });
});
