/**
 * Unit test for the "Apply Files to Branch" worktree-conflict path.
 *
 * "Apply Files to Branch" checks out an EXISTING target branch by name
 * before cherry-picking the selected files onto it. That checkout can hit
 * git's "branch is already used by another worktree" refusal — the same
 * dead-end the branch-tree checkout sites already translate. This test
 * pins that the command surfaces the actionable worktree message (where to
 * find the other worktree) instead of the raw `fatal:` dump, and that the
 * finally-cleanup (return to the original branch, pop any stash) stays a
 * safe no-op when the checkout never moved HEAD.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerCommitMenuCommands } from '../../../src/commands/registration/commitMenuCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IBranch,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  restoreMessageFunctions,
  writableWindow,
  type MessageTracker,
} from '../../typed/windowStub';

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

/** Patch vscode.commands.registerCommand to capture (id, cb) pairs. */
function patchRegisterCommand(): { handlers: CapturedHandler[]; restore: () => void } {
  const handlers: CapturedHandler[] = [];
  const cmds = vscode.commands as unknown as {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { dispose: () => void };
  };
  const original = cmds.registerCommand;
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

/**
 * Build a minimal ICommandContext whose services expose the supplied
 * gitService. Only the fields the apply-files flow reads are populated.
 */
function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: {
      gitService,
      conflictResolutionService: undefined,
    },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

function localBranch(name: string, commit = 'a'.repeat(40)): IBranch {
  return { name, type: 'local', commit, isHead: false };
}

describe('Apply Files to Branch — worktree-conflict checkout', () => {
  let patch: ReturnType<typeof patchRegisterCommand>;
  let errorTracker: MessageTracker;
  let infoTracker: MessageTracker;
  const originalQuickPick = writableWindow().showQuickPick;

  afterEach(() => {
    restoreMessageFunctions();
    writableWindow().showQuickPick = originalQuickPick;
    if (patch) {
      patch.restore();
    }
  });

  /** Register the commit-menu commands and return the apply-files handler. */
  function applyFilesHandler(gitService: IGitService): (...args: unknown[]) => unknown {
    patch = patchRegisterCommand();
    registerCommitMenuCommands(makeContext(gitService));
    const found = patch.handlers.find((h) => h.id === 'intellig.commit.applyFilesToBranch');
    assert.ok(found, 'apply-files-to-branch command should be registered');
    return found.cb;
  }

  it('surfaces the actionable worktree message (not the raw fatal) when the target checkout is worktree-blocked', async () => {
    const repo: IRepository = attachedRepo('main');
    const checkoutCalls: string[] = [];
    const gitService = createMockGitService(repo, {
      getRepositories: () => [repo],
      getBranches: async () => [localBranch('main'), localBranch('feature')],
      getStatus: async () => [],
      getCommitDiff: async () => [
        { path: 'src/a.ts', status: 'modified', hunks: [], binary: false },
      ],
      checkout: async (_repo: IRepository, ref: string) => {
        checkoutCalls.push(ref);
        // The first checkout targets the chosen branch and is refused
        // because that branch lives in another worktree. The cleanup
        // checkout back to 'main' (the branch we never left) succeeds.
        if (ref === 'feature') {
          throw new Error("fatal: 'feature' is already used by worktree at '/repos/proj-feature'");
        }
      },
    });

    // First QuickPick = branch pick (target 'feature'); second = file subset.
    let quickPickCall = 0;
    writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> => {
      quickPickCall += 1;
      if (quickPickCall === 1) {
        return Promise.resolve({ label: 'feature' });
      }
      return Promise.resolve(items); // select all offered files
    };

    errorTracker = installErrorMessageTracker();
    infoTracker = installInfoMessageTracker();

    const handler = applyFilesHandler(gitService);
    await handler({ hash: 'b'.repeat(40) });

    assert.strictEqual(errorTracker.calls.length, 1, 'should surface exactly one error toast');
    const shown = errorTracker.calls[0].message;
    assert.ok(!shown.includes('fatal:'), `must not surface the raw fatal; got: "${shown}"`);
    assert.ok(
      !shown.startsWith('Apply Files to Branch failed:'),
      `must not surface the generic raw-error toast; got: "${shown}"`
    );
    assert.ok(/another worktree/i.test(shown), `should mention another worktree; got: "${shown}"`);
    assert.ok(
      shown.includes('/repos/proj-feature'),
      `should name the conflicting worktree path; got: "${shown}"`
    );
    // The cleanup must have returned us to the original branch — a safe
    // no-op since HEAD never moved — without an extra error toast.
    assert.ok(
      checkoutCalls.includes('main'),
      'finally should attempt to return to the original branch'
    );
    assert.strictEqual(infoTracker.calls.length, 0, 'no success toast on a failed apply');
  });
});
