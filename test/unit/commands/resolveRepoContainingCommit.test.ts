/**
 * Tests for `resolveRepoContainingCommit` — the NON-interactive, containment-
 * validated repo resolver for commit-scoped commands (showDiff / compareWith /
 * applySelectedChanges / cherry-pick / open-on-host).
 *
 * The bug this guards: the `intellig.commit.*` commands resolved the repo via
 * `pickRepositoryForCommit`, which pops a blind "Choose Repository" QuickPick in
 * a multi-repo workspace and never verifies the pick holds the commit — so a
 * wrong pick ran the op against a repo without the commit and opened a BLANK
 * diff / empty result. This resolver never prompts: single-repo is auto-picked,
 * multi-repo returns the repo whose `getCommit(hash)` succeeds, and it errors
 * (not a blank view) when no open repo contains the commit.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveRepoContainingCommit } from '../../../src/commands/registration/commitHelpers';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';

function mockRepository(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/** The two `vscode.window` functions this resolver may touch. */
interface IWritableWindow {
  showQuickPick: (...args: unknown[]) => unknown;
  showErrorMessage: (...args: unknown[]) => unknown;
}

function makeCtx(
  repos: IRepository[],
  holder: IRepository | undefined,
  hash: string
): ICommandContext {
  return {
    services: {
      gitService: {
        getRepositories: (): IRepository[] => repos,
        getCommit: async (repo: IRepository, h: string) => {
          if (repo === holder && h === hash) {
            return { hash } as unknown;
          }
          throw new Error('unknown revision');
        },
      },
    },
  } as unknown as ICommandContext;
}

describe('resolveRepoContainingCommit — non-interactive, containment-validated', () => {
  let quickPickCalls: number;
  let errorMessages: string[];
  const win = vscode.window as unknown as IWritableWindow;
  let origQuickPick: IWritableWindow['showQuickPick'];
  let origError: IWritableWindow['showErrorMessage'];

  beforeEach(() => {
    quickPickCalls = 0;
    errorMessages = [];
    origQuickPick = win.showQuickPick;
    origError = win.showErrorMessage;
    win.showQuickPick = (): undefined => {
      quickPickCalls++;
      return undefined;
    };
    win.showErrorMessage = (msg: unknown): undefined => {
      errorMessages.push(String(msg));
      return undefined;
    };
  });

  afterEach(() => {
    win.showQuickPick = origQuickPick;
    win.showErrorMessage = origError;
  });

  it('multi-repo: returns the repo that CONTAINS the commit, never prompting', async () => {
    const alpha = mockRepository('/work/alpha');
    const beta = mockRepository('/work/beta');
    const ctx = makeCtx([alpha, beta], beta, 'bbbbbbb');

    const resolved = await resolveRepoContainingCommit(ctx, 'bbbbbbb');

    assert.strictEqual(resolved, beta, 'must resolve the repo holding the commit (beta)');
    assert.strictEqual(quickPickCalls, 0, 'must never show a repository QuickPick');
    assert.strictEqual(errorMessages.length, 0, 'no error when a repo holds the commit');
  });

  it('single-repo: auto-selects the only repo without prompting', async () => {
    const only = mockRepository('/work/only');
    const ctx = makeCtx([only], only, 'aaaaaaa');

    const resolved = await resolveRepoContainingCommit(ctx, 'aaaaaaa');

    assert.strictEqual(resolved, only);
    assert.strictEqual(quickPickCalls, 0);
  });

  it('multi-repo, no repo contains the commit: returns undefined + errors (not a blank diff)', async () => {
    const alpha = mockRepository('/work/alpha');
    const beta = mockRepository('/work/beta');
    const ctx = makeCtx([alpha, beta], beta, 'bbbbbbb');

    const resolved = await resolveRepoContainingCommit(ctx, 'deadbeef');

    assert.strictEqual(resolved, undefined, 'no repo holds the commit → undefined');
    assert.strictEqual(quickPickCalls, 0, 'must not fall back to a blind QuickPick');
    assert.strictEqual(errorMessages.length, 1, 'surfaces an informative error');
    assert.ok(
      /could not find the repository containing commit/i.test(errorMessages[0]),
      `expected a "could not find repo" error; got: ${errorMessages[0]}`
    );
  });
});
