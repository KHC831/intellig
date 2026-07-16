/**
 * `intellig.pushAllTags` — the pushed remote must be explicit and the toast
 * must name that same remote. Running bare `git push --tags` lets git resolve
 * its own default remote while the toast named `remotes[0]` from `git remote`
 * ordering — in a multi-remote repo the two could disagree.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { registerCommitRepoCoreCommands } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IGitService,
  IPushOptions,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

const ROOT = '/work/repo';

function makeRepo(remotes: string[], upstream?: { remote: string; name: string }): IRepository {
  return {
    rootUri: Uri.file(ROOT),
    state: 'idle',
    head: { name: 'main', commit: 'cafe', ahead: 0, behind: 0, upstream },
    remotes: remotes.map((name) => ({ name, fetchUrl: '', pushUrl: '' })),
    submodules: [],
  } as unknown as IRepository;
}

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

function patchRegisterCommand(): { handlers: CapturedHandler[]; restore: () => void } {
  const cmds = vscode.commands as unknown as {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { dispose: () => void };
  };
  const original = cmds.registerCommand;
  const handlers: CapturedHandler[] = [];
  cmds.registerCommand = (id, cb) => {
    handlers.push({ id, cb });
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      cmds.registerCommand = original;
    },
  };
}

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

interface Harness {
  run: () => Promise<unknown>;
  pushes: Array<{ options?: IPushOptions }>;
  infos: string[];
  errors: string[];
  quickPicks: number;
}

function setup(repo: IRepository, pickRemote?: string): Harness {
  const pushes: Array<{ options?: IPushOptions }> = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const harness: Harness = { run: async () => undefined, pushes, infos, errors, quickPicks: 0 };
  const gitService = createMockGitService(repo, {
    getRepositories: () => [repo],
    getRemotes: () => okAsync(repo.remotes),
    push: (_r: IRepository, options?: IPushOptions) => {
      pushes.push({ options });
      return okAsync(undefined);
    },
  });
  writableWindow().showInformationMessage = (message: string) => {
    infos.push(message);
    return Promise.resolve(undefined);
  };
  writableWindow().showErrorMessage = (message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  };
  writableWindow().showQuickPick = ((items: Array<{ label: string }>) => {
    harness.quickPicks += 1;
    return Promise.resolve(
      pickRemote === undefined ? undefined : items.find((i) => i.label === pickRemote)
    );
  }) as never;
  (
    vscode.window as unknown as { withProgress: (opts: unknown, task: () => unknown) => unknown }
  ).withProgress = (_opts, task) => task();

  const patch = patchRegisterCommand();
  let handler: CapturedHandler | undefined;
  try {
    registerCommitRepoCoreCommands(makeContext(gitService));
    handler = patch.handlers.find((h) => h.id === 'intellig.pushAllTags');
  } finally {
    patch.restore();
  }
  assert.ok(handler, 'intellig.pushAllTags should be registered');
  harness.run = () => Promise.resolve(handler.cb());
  return harness;
}

describe('pushAllTags pushes to an explicit remote the toast agrees with', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('multi-remote repo with a tracked upstream: pushes tags to the upstream remote', async () => {
    // `git remote` ordering would put 'origin' first, but the current
    // branch tracks 'fork' — git's own default resolution would pick fork,
    // so the push must be explicit and the toast must match.
    const h = setup(makeRepo(['origin', 'fork'], { remote: 'fork', name: 'main' }));
    await h.run();

    assert.strictEqual(h.pushes.length, 1);
    assert.strictEqual(h.pushes[0].options?.tags, true);
    assert.strictEqual(h.pushes[0].options?.remote, 'fork', 'push carries the explicit remote');
    assert.ok(
      h.infos.some((m) => m.includes('fork')),
      `toast must name the pushed remote; got ${JSON.stringify(h.infos)}`
    );
  });

  it('single remote, no upstream: pushes tags to that remote', async () => {
    const h = setup(makeRepo(['origin']));
    await h.run();

    assert.strictEqual(h.pushes.length, 1);
    assert.strictEqual(h.pushes[0].options?.remote, 'origin');
    assert.ok(h.infos.some((m) => m.includes('origin')));
  });

  it('multiple remotes, no upstream: asks which remote to push to', async () => {
    const h = setup(makeRepo(['origin', 'upstream']), 'upstream');
    await h.run();

    assert.strictEqual(h.quickPicks, 1, 'remote choice is prompted');
    assert.strictEqual(h.pushes.length, 1);
    assert.strictEqual(h.pushes[0].options?.remote, 'upstream');
    assert.ok(h.infos.some((m) => m.includes('upstream')));
  });

  it('multiple remotes, prompt dismissed: pushes nothing', async () => {
    const h = setup(makeRepo(['origin', 'upstream']), undefined);
    await h.run();

    assert.strictEqual(h.pushes.length, 0);
  });

  it('no remotes configured: errors without pushing', async () => {
    const h = setup(makeRepo([]));
    await h.run();

    assert.strictEqual(h.pushes.length, 0);
    assert.strictEqual(h.errors.length, 1);
    assert.ok(/no remotes/i.test(h.errors[0]), h.errors[0]);
  });
});
