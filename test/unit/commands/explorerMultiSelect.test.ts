/**
 * Explorer context commands and VS Code's multi-select contract.
 *
 * VS Code invokes explorer/context commands as `(clickedUri, selectedUris[])`.
 * The mutating commands (stage/unstage/add-to-VCS/revert/…) must operate on
 * the WHOLE selection — silently acting on just the right-clicked file while
 * toasting success is a data-shape lie (the user believes N files changed).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import {
  registerExplorerCommands,
  resolveExplorerSelection,
} from '../../../src/commands/registration/explorerCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

type Handler = (...args: unknown[]) => unknown;

describe('resolveExplorerSelection', () => {
  const clicked = Uri.file('/r/a.ts');
  const other = Uri.file('/r/b.ts');

  it('prefers the full selection array when present', () => {
    const out = resolveExplorerSelection(clicked as never, [clicked, other], undefined);
    assert.deepStrictEqual(
      out.map((u) => u.fsPath),
      ['/r/a.ts', '/r/b.ts']
    );
  });

  it('falls back to the clicked uri when no selection array arrives', () => {
    const out = resolveExplorerSelection(clicked as never, undefined, undefined);
    assert.deepStrictEqual(
      out.map((u) => u.fsPath),
      ['/r/a.ts']
    );
  });

  it('falls back to the active editor for palette invocations', () => {
    const out = resolveExplorerSelection(undefined, undefined, Uri.file('/r/c.ts') as never);
    assert.deepStrictEqual(
      out.map((u) => u.fsPath),
      ['/r/c.ts']
    );
  });

  it('drops non-uri junk from the selection array', () => {
    const out = resolveExplorerSelection(clicked as never, [clicked, 'junk', null], undefined);
    assert.deepStrictEqual(
      out.map((u) => u.fsPath),
      ['/r/a.ts']
    );
  });
});

describe('explorer commands — multi-select handling', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  const win = vscode.window as unknown as Record<string, unknown>;
  const winSnapshot: Record<string, unknown> = {};
  let infos: string[];
  let warnings: string[];

  const repo = {
    rootUri: Uri.file('/r'),
    state: 'idle',
    head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;

  beforeEach(() => {
    infos = [];
    warnings = [];
    handlers.clear();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    for (const k of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) {
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

  function makeCtx(overrides: Partial<Record<string, unknown>> = {}): {
    ctx: ICommandContext;
    stageCalls: string[][];
    unstageCalls: string[][];
    revertCalls: string[];
  } {
    const stageCalls: string[][] = [];
    const unstageCalls: string[][] = [];
    const revertCalls: string[] = [];
    const gitService = {
      getRepositories: () => [repo],
      getRepository: async () => repo,
      getStatus: async () => [
        { path: 'a.ts', indexStatus: ' ', workTreeStatus: 'M' },
        { path: 'b.ts', indexStatus: ' ', workTreeStatus: 'M' },
        { path: 'c.ts', indexStatus: ' ', workTreeStatus: 'M' },
      ],
      stage: (_r: IRepository, paths: string[]) => {
        stageCalls.push(paths);
        return okAsync(undefined);
      },
      unstage: (_r: IRepository, paths: string[]) => {
        unstageCalls.push(paths);
        return okAsync(undefined);
      },
      revertFile: (_r: IRepository, path: string) => {
        revertCalls.push(path);
        return okAsync(undefined);
      },
      ...overrides,
    } as unknown as IGitService;
    const ctx = {
      services: { gitService, patchService: {} },
      gitToolWindowProvider: { refresh: (): void => {} },
      context: { subscriptions: [] },
    } as unknown as ICommandContext;
    return { ctx, stageCalls, unstageCalls, revertCalls };
  }

  const uris = [Uri.file('/r/a.ts'), Uri.file('/r/b.ts'), Uri.file('/r/c.ts')];

  it('stage acts on the entire selection in one batched call', async () => {
    const { ctx, stageCalls } = makeCtx();
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.stage')!(uris[0], uris);

    assert.deepStrictEqual(stageCalls, [['a.ts', 'b.ts', 'c.ts']]);
    assert.ok(
      infos.some((m) => /3 file/.test(m)),
      `toast must reflect the whole selection; got: ${infos.join(' | ')}`
    );
  });

  it('unstage acts on the entire selection', async () => {
    const { ctx, unstageCalls } = makeCtx();
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.unstage')!(uris[0], uris);

    assert.deepStrictEqual(unstageCalls, [['a.ts', 'b.ts', 'c.ts']]);
  });

  it('add-to-VCS stages the entire selection', async () => {
    const { ctx, stageCalls } = makeCtx();
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.addToVcs')!(uris[0], uris);

    assert.deepStrictEqual(stageCalls, [['a.ts', 'b.ts', 'c.ts']]);
  });

  it('revert confirms with EVERY selected file named, then reverts them all', async () => {
    const { ctx, revertCalls } = makeCtx();
    let confirmMessage = '';
    win.showWarningMessage = async (m: string): Promise<string> => {
      warnings.push(m);
      confirmMessage = m;
      return 'Revert';
    };
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.revert')!(uris[0], uris);

    for (const f of ['a.ts', 'b.ts', 'c.ts']) {
      assert.ok(confirmMessage.includes(f), `confirm must name '${f}'; got: "${confirmMessage}"`);
    }
    assert.deepStrictEqual(revertCalls, ['a.ts', 'b.ts', 'c.ts']);
  });

  it('single-file invocation keeps the single-file wording', async () => {
    const { ctx, stageCalls } = makeCtx();
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.stage')!(uris[0], [uris[0]]);

    assert.deepStrictEqual(stageCalls, [['a.ts']]);
    assert.ok(
      infos.some((m) => m.includes('a.ts')),
      `single-file toast names the file; got: ${infos.join(' | ')}`
    );
  });

  it('reverts the selected file even when the status read comes back empty', async () => {
    // getStatus absorbs git faults to [] (the passive-view contract), so an
    // empty status is ambiguous: a genuinely clean tree OR a swallowed
    // status-read failure. The precheck must not read that ambiguity as
    // "nothing to revert" and silently drop the file the user explicitly chose
    // — revertFile is the source of truth (a clean file reverts as a no-op).
    const { ctx, revertCalls } = makeCtx({ getStatus: async () => [] });
    win.showWarningMessage = async (): Promise<string> => 'Revert';
    registerExplorerCommands(ctx);

    await handlers.get('intellig.explorer.revert')!(uris[0], [uris[0]]);

    assert.deepStrictEqual(
      revertCalls,
      ['a.ts'],
      'an empty/unreadable status must not silently skip the revert'
    );
  });
});

describe('explorer commands — multi-select (commit file dialog scope)', () => {
  it('Commit File… opens the commit dialog with every selected file preselected', async () => {
    const handlers = new Map<string, Handler>();
    const cmds = vscode.commands as unknown as {
      registerCommand: (id: string, cb: Handler) => { dispose: () => void };
      executeCommand: (id: string) => Promise<unknown>;
    };
    const originalRegister = cmds.registerCommand;
    const originalExecute = cmds.executeCommand;
    cmds.registerCommand = (id, cb) => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    cmds.executeCommand = async () => undefined;
    try {
      const stageCalls: string[][] = [];
      const shown: Array<string[] | undefined> = [];
      const repo = {
        rootUri: Uri.file('/r'),
        state: 'idle',
        head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      } as unknown as IRepository;
      const gitService = {
        getRepositories: () => [repo],
        getRepository: async () => repo,
        stage: (_r: IRepository, paths: string[]) => {
          stageCalls.push(paths);
          return okAsync(undefined);
        },
      } as unknown as IGitService;
      registerExplorerCommands({
        services: { gitService },
        gitToolWindowProvider: { refresh: (): void => {} },
        context: { subscriptions: [] },
        commitDialog: {
          show: async (
            _r: IRepository,
            options?: { preSelectedFiles?: string[] }
          ): Promise<unknown> => {
            shown.push(options?.preSelectedFiles);
            return { committed: false };
          },
        },
      } as unknown as ICommandContext);

      const uris = [Uri.file('/r/a.ts'), Uri.file('/r/b.ts')];
      await handlers.get('intellig.explorer.commitFile')!(uris[0], uris);

      assert.deepStrictEqual(shown, [['a.ts', 'b.ts']], 'the whole selection is preselected');
      assert.deepStrictEqual(stageCalls, [], 'nothing is staged before the dialog');
    } finally {
      cmds.registerCommand = originalRegister;
      cmds.executeCommand = originalExecute;
    }
  });
});
