/**
 * L1 — `intellig.conflict.*` command toasts must scrub credentials.
 *
 * completeMerge / completeRebase / abortMerge / abortRebase surface
 * `ConflictResolutionService` `result.error` strings (raw git stderr) directly
 * in their failure toasts. git stderr can embed `user:token@host` remote URLs
 * and absolute home paths; every user-visible surface must run through
 * `sanitizeGitError` first (sanitize-before-toast discipline).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerRebaseConflictCommands } from '../../../commands/registration/rebaseConflictCommands';
import type { ICommandContext } from '../../../commands/registration/CommandContext';
import type { IRepository } from '../../../git-core/interfaces/IGitService';

// A raw git failure carrying BOTH a credentialed remote URL and a POSIX home
// path — the two things sanitizeGitError redacts.
const RAW =
  "fatal: unable to access 'https://x-access-token:ghp_SECRET123@github.com/owner/repo.git/': 403\n" +
  '/Users/alice/project/conflict.ts';

/** Capture every command handler `registerLoggedCommand` registers, by id. */
function captureHandlers(): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  restore: () => void;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const orig = vscode.commands.registerCommand;
  (
    vscode.commands as unknown as {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { dispose(): void };
    }
  ).registerCommand = (id, cb): { dispose(): void } => {
    handlers.set(id, cb);
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      (vscode.commands as unknown as { registerCommand: typeof orig }).registerCommand = orig;
    },
  };
}

/** Capture error toasts. */
function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const orig = vscode.window.showErrorMessage;
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
    m: string
  ): Promise<string | undefined> => {
    errors.push(m);
    return Promise.resolve(undefined);
  };
  return {
    errors,
    restore: (): void => {
      (vscode.window as unknown as { showErrorMessage: typeof orig }).showErrorMessage = orig;
    },
  };
}

function makeRepo(): IRepository {
  return {
    rootUri: vscode.Uri.file('/repo'),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/**
 * Build a minimal ICommandContext whose conflictResolutionService returns the
 * given failure shape for every complete/abort op, and a single-repo
 * gitService so resolveRepo returns without prompting.
 */
function makeCtx(repo: IRepository): ICommandContext {
  const conflictResolutionService = {
    canCompleteOperation: async (): Promise<boolean> => true,
    getConflictedFiles: async (): Promise<string[]> => [],
    completeMerge: async (): Promise<{ success: boolean; error?: string }> => ({
      success: false,
      error: RAW,
    }),
    completeRebase: async (): Promise<{
      success: boolean;
      error?: string;
      remainingConflicts?: string[];
    }> => ({ success: false, error: RAW }),
    abortMerge: async (): Promise<{ success: boolean; error?: string }> => ({
      success: false,
      error: RAW,
    }),
    abortRebase: async (): Promise<{ success: boolean; error?: string }> => ({
      success: false,
      error: RAW,
    }),
  };
  const gitService = {
    getRepositories: (): IRepository[] => [repo],
  };
  return {
    services: { conflictResolutionService, gitService },
  } as unknown as ICommandContext;
}

/** Stub the modal abort confirm so it returns the affirmative choice. */
function stubAbortConfirm(): () => void {
  const orig = vscode.window.showWarningMessage;
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
    _msg: string,
    _opts: unknown,
    affirmative: string
  ): Promise<string | undefined> => Promise.resolve(affirmative);
  return (): void => {
    (vscode.window as unknown as { showWarningMessage: typeof orig }).showWarningMessage = orig;
  };
}

describe('L1 — intellig.conflict.* failure toasts sanitize git stderr', () => {
  const cases: Array<{ id: string }> = [
    { id: 'intellig.conflict.completeMerge' },
    { id: 'intellig.conflict.completeRebase' },
    { id: 'intellig.conflict.abortMerge' },
    { id: 'intellig.conflict.abortRebase' },
  ];

  cases.forEach(({ id }) => {
    it(`${id} scrubs the credentialed URL + home path from result.error`, async () => {
      const cap = captureHandlers();
      let disposables: vscode.Disposable[] = [];
      try {
        disposables = registerRebaseConflictCommands(makeCtx(makeRepo()));
      } finally {
        cap.restore();
      }

      const handler = cap.handlers.get(id);
      if (!handler) {
        assert.fail(`handler for ${id} must be registered`);
        return;
      }

      const restoreConfirm = stubAbortConfirm();
      const errs = captureErrors();
      try {
        await handler();
      } finally {
        errs.restore();
        restoreConfirm();
        disposables.forEach((d) => {
          d.dispose();
        });
      }

      assert.strictEqual(errs.errors.length, 1, `${id} should surface exactly one error toast`);
      const toast = errs.errors[0];
      assert.ok(!toast.includes('ghp_SECRET123'), `token must be redacted; got: ${toast}`);
      assert.ok(
        !toast.includes('x-access-token:ghp_'),
        `user:token must be redacted; got: ${toast}`
      );
      assert.ok(!toast.includes('/Users/alice'), `home path must be redacted; got: ${toast}`);
      assert.ok(toast.includes('<redacted>@github.com'), `host should survive; got: ${toast}`);
    });
  });
});
