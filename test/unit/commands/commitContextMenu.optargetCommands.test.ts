/**
 * H-1 (delegating-command half) — the `intellig.commit.newBranch`,
 * `intellig.commit.newTag`, and `intellig.pushUpToCommit` commands must honor
 * the repo-root hint threaded through from the merged "all roots" log commit
 * menu, targeting the CLICKED commit's OWN repo instead of re-prompting /
 * re-resolving by the active editor.
 *
 * The CommitContextMenuCommands half (see commitContextMenu.optarget.test.ts)
 * proves the root is PASSED; these specs prove the commands ACT on it — closing
 * the "threaded but ignored" gap.
 */

import '../../setup';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerCommitMenuCommands } from '../../../src/commands/registration/commitMenuCommands';
import { registerCommitRepoCoreCommands } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

const ROOT_A = '/work/alpha';
const ROOT_B = '/work/beta';
const FOREIGN_HASH = 'beebeebeebeebeebeebeebeebeebeebeebeebeeb';

function makeRepo(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'main', commit: 'cafe', ahead: 0, behind: 0, upstream: { remote: 'origin' } },
    remotes: [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
    submodules: [],
  } as unknown as IRepository;
}

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

/** Patch vscode.commands.registerCommand to capture (id, cb) pairs. */
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

/** Build a gitService whose `getRepository(uri)` dispatches by fsPath. */
function makeDispatchingGitService(
  byRoot: Map<string, IRepository>,
  overrides: Partial<IGitService> = {}
): IGitService {
  // mockGitService needs a default repo; getRepository is overridden below.
  const anyRepo = [...byRoot.values()][0];
  return createMockGitService(anyRepo, {
    getRepositories: () => [...byRoot.values()],
    getRepository: async (uri: { fsPath: string }) => byRoot.get(uri.fsPath),
    ...overrides,
  });
}

function makeContext(
  gitService: IGitService,
  extra: Partial<ICommandContext> = {}
): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
    ...extra,
  } as unknown as ICommandContext;
}

function findHandler(handlers: CapturedHandler[], id: string): CapturedHandler {
  const h = handlers.find((x) => x.id === id);
  assert.ok(h, `command ${id} should be registered`);
  return h;
}

describe('delegating commands honor the threaded clicked-commit repo root', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('newBranch opens the New Branch dialog against the repo identified by the root hint', async () => {
    const repoA = makeRepo(ROOT_A);
    const repoB = makeRepo(ROOT_B);
    const gitService = makeDispatchingGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );

    let dialogRepo: IRepository | undefined;
    const ctx = makeContext(gitService, {
      openNewBranchDialog: (preselect: { repo: IRepository }) => {
        dialogRepo = preselect.repo;
        return undefined;
      },
    } as unknown as Partial<ICommandContext>);

    const patch = patchRegisterCommand();
    try {
      registerCommitMenuCommands(ctx);
      const handler = findHandler(patch.handlers, 'intellig.commit.newBranch');
      await handler.cb(FOREIGN_HASH, ROOT_B);
    } finally {
      patch.restore();
    }

    assert.ok(dialogRepo, 'the New Branch dialog should have been opened');
    assert.strictEqual(dialogRepo.rootUri.fsPath, ROOT_B);
  });

  it('newTag creates the tag against the repo identified by the root hint', async () => {
    const repoA = makeRepo(ROOT_A);
    const repoB = makeRepo(ROOT_B);
    const tagCalls: IRepository[] = [];
    const gitService = makeDispatchingGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ]),
      {
        createTag: (repo: IRepository) => {
          tagCalls.push(repo);
          return okAsync(undefined);
        },
      }
    );
    // Tag name + annotation prompts: return a fixed non-empty value.
    writableWindow().showInputBox = () => Promise.resolve('v1.0.0');
    writableWindow().showInformationMessage = () => Promise.resolve(undefined);
    writableWindow().showErrorMessage = () => Promise.resolve(undefined);

    const ctx = makeContext(gitService);
    const patch = patchRegisterCommand();
    try {
      registerCommitRepoCoreCommands(ctx);
      const handler = findHandler(patch.handlers, 'intellig.commit.newTag');
      await handler.cb(FOREIGN_HASH, ROOT_B);
    } finally {
      patch.restore();
    }

    assert.strictEqual(tagCalls.length, 1, 'createTag should have run once');
    assert.strictEqual(tagCalls[0].rootUri.fsPath, ROOT_B);
  });

  it('pushUpToCommit opens the push dialog against the repo identified by the root hint', async () => {
    const repoA = makeRepo(ROOT_A);
    const repoB = makeRepo(ROOT_B);
    const gitService = makeDispatchingGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ]),
      {
        // The command resolves the branch containing the commit; report it
        // as on HEAD ('main') so the row seeds against the hinted repo.
        getContainingBranches: async () => ['main'],
      }
    );
    writableWindow().showInformationMessage = () => Promise.resolve(undefined);
    writableWindow().showErrorMessage = () => Promise.resolve(undefined);

    const dialogRepos: IRepository[] = [];
    const ctx = makeContext(gitService, {
      openPushDialog: (preselect?: { repo: IRepository }) => {
        if (preselect) {
          dialogRepos.push(preselect.repo);
        }
        return undefined;
      },
    } as unknown as Partial<ICommandContext>);
    const patch = patchRegisterCommand();
    try {
      registerCommitRepoCoreCommands(ctx);
      const handler = findHandler(patch.handlers, 'intellig.pushUpToCommit');
      await handler.cb(FOREIGN_HASH, ROOT_B);
    } finally {
      patch.restore();
    }

    assert.strictEqual(dialogRepos.length, 1, 'the push dialog should have opened once');
    assert.strictEqual(dialogRepos[0].rootUri.fsPath, ROOT_B);
  });
});
