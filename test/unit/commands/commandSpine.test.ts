/**
 * The command spine — one wrapper that carries the invariants every command
 * handler used to hand-roll (and occasionally forget):
 *
 *  - services guard with a toast, never a crash;
 *  - selection scope: VS Code's (clickedUri, selectedUris[]) contract, with
 *    active-editor fallback and repo-relative path derivation;
 *  - repo resolution through the shared resolveRepo chain;
 *  - unexpected failures surfaced as a sanitized toast, never swallowed;
 *  - opt-in tool-window refresh after a successful mutation.
 *
 * A handler on the spine CANNOT drop the selection array, silently return on
 * a missing argument, or leak a raw error — the spine does those parts.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  registerFileCommand,
  registerRepoCommand,
  registerSelectionCommand,
} from '../../../src/commands/registration/commandSpine';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

type Handler = (...args: unknown[]) => unknown;

const repo = {
  rootUri: Uri.file('/r'),
  state: 'idle',
  head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
  remotes: [],
  submodules: [],
} as unknown as IRepository;

describe('command spine', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  const win = vscode.window as unknown as Record<string, unknown>;
  const winSnapshot: Record<string, unknown> = {};
  let errors: string[];
  let refreshes: number;

  beforeEach(() => {
    errors = [];
    refreshes = 0;
    handlers.clear();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    for (const k of ['showErrorMessage', 'showInformationMessage', 'showQuickPick']) {
      winSnapshot[k] = win[k];
    }
    win.showErrorMessage = async (m: string): Promise<undefined> => {
      errors.push(m);
      return undefined;
    };
    win.showInformationMessage = async (): Promise<undefined> => undefined;
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    for (const k of Object.keys(winSnapshot)) {
      win[k] = winSnapshot[k];
    }
  });

  function makeCtx(servicesPresent = true): ICommandContext {
    return {
      services: servicesPresent
        ? {
            gitService: {
              getRepositories: () => [repo],
              getRepository: async () => repo,
            },
          }
        : undefined,
      gitToolWindowProvider: {
        refresh: (): void => {
          refreshes += 1;
        },
      },
      context: { subscriptions: [] },
    } as unknown as ICommandContext;
  }

  it('guards missing services with a toast on every scope; run never fires', async () => {
    const runs: string[] = [];
    const ctx = makeCtx(false);
    registerSelectionCommand(ctx, {
      id: 'spine.sel',
      failureTitle: 'Failed',
      run: async () => {
        runs.push('sel');
      },
    });
    registerRepoCommand(ctx, {
      id: 'spine.repo',
      failureTitle: 'Failed',
      run: async () => {
        runs.push('repo');
      },
    });
    registerFileCommand(ctx, {
      id: 'spine.file',
      failureTitle: 'Failed',
      run: async () => {
        runs.push('file');
      },
    });

    await handlers.get('spine.sel')!();
    await handlers.get('spine.repo')!();
    await handlers.get('spine.file')!();

    assert.deepStrictEqual(runs, []);
    assert.strictEqual(errors.length, 3);
    assert.ok(errors.every((m) => /services not initialized/i.test(m)));
  });

  it('selection scope: the whole (uri, uris[]) selection reaches run as repo-relative paths', async () => {
    let seen: { targets: number; paths: string[] } | undefined;
    registerSelectionCommand(makeCtx(), {
      id: 'spine.sel',
      failureTitle: 'Failed',
      run: async ({ targets, paths }) => {
        seen = { targets: targets.length, paths };
      },
    });

    const uris = [Uri.file('/r/a.ts'), Uri.file('/r/sub/b.ts')];
    await handlers.get('spine.sel')!(uris[0], uris);

    assert.deepStrictEqual(seen, { targets: 2, paths: ['a.ts', 'sub/b.ts'] });
  });

  it('selection scope: empty resolution toasts the noTargetMessage and skips run', async () => {
    let ran = false;
    registerSelectionCommand(makeCtx(), {
      id: 'spine.sel',
      failureTitle: 'Failed',
      noTargetMessage: 'No file selected to frob',
      run: async () => {
        ran = true;
      },
    });

    await handlers.get('spine.sel')!(); // no uri, no selection, no active editor

    assert.strictEqual(ran, false);
    assert.deepStrictEqual(errors, ['No file selected to frob']);
  });

  it('file scope: exactly one target (the clicked file), even under a multi-select', async () => {
    let seen: string | undefined;
    registerFileCommand(makeCtx(), {
      id: 'spine.file',
      failureTitle: 'Failed',
      run: async ({ path }) => {
        seen = path;
      },
    });

    const uris = [Uri.file('/r/a.ts'), Uri.file('/r/b.ts')];
    await handlers.get('spine.file')!(uris[0], uris);

    assert.strictEqual(seen, 'a.ts');
  });

  it('a throwing run surfaces the failureTitle toast and suppresses the refresh', async () => {
    registerSelectionCommand(makeCtx(), {
      id: 'spine.sel',
      failureTitle: 'Failed to frob file',
      refreshOnSuccess: true,
      run: async () => {
        throw new Error('boom from git');
      },
    });

    await handlers.get('spine.sel')!(Uri.file('/r/a.ts'));

    assert.strictEqual(errors.length, 1);
    assert.ok(
      errors[0].startsWith('Failed to frob file'),
      `toast leads with the failure title; got: "${errors[0]}"`
    );
    assert.ok(errors[0].includes('boom from git'));
    assert.strictEqual(refreshes, 0, 'no refresh after a failed run');
  });

  it('refreshOnSuccess refreshes the tool window after a clean run', async () => {
    registerSelectionCommand(makeCtx(), {
      id: 'spine.sel',
      failureTitle: 'Failed',
      refreshOnSuccess: true,
      run: async () => {},
    });

    await handlers.get('spine.sel')!(Uri.file('/r/a.ts'));

    assert.strictEqual(refreshes, 1);
  });

  it('repo scope: run receives the resolved repo; a cancelled resolution skips run silently', async () => {
    let seenRepo: IRepository | undefined;
    registerRepoCommand(makeCtx(), {
      id: 'spine.repo',
      failureTitle: 'Failed',
      run: async (args) => {
        seenRepo = args.repo;
      },
    });
    await handlers.get('spine.repo')!();
    assert.strictEqual(seenRepo, repo);

    // No repositories at all: resolveRepo owns the error toast; run skipped.
    let ran = false;
    const emptyCtx = {
      services: { gitService: { getRepositories: () => [], getRepository: async () => undefined } },
      gitToolWindowProvider: undefined,
      context: { subscriptions: [] },
    } as unknown as ICommandContext;
    registerRepoCommand(emptyCtx, {
      id: 'spine.repo2',
      failureTitle: 'Failed',
      run: async () => {
        ran = true;
      },
    });
    await handlers.get('spine.repo2')!();
    assert.strictEqual(ran, false);
    assert.ok(
      errors.some((m) => /no git repository/i.test(m)),
      `resolveRepo surfaces the no-repo error; got: ${errors.join(' | ')}`
    );
  });

  it('extra raw arguments are passed through to run untouched', async () => {
    let raw: unknown[] = [];
    registerRepoCommand(makeCtx(), {
      id: 'spine.repo',
      failureTitle: 'Failed',
      run: async (_args, ...rest) => {
        raw = rest;
      },
    });

    await handlers.get('spine.repo')!('abc123', { flag: true });

    assert.deepStrictEqual(raw, ['abc123', { flag: true }]);
  });
});
