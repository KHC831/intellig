/**
 * Unit tests for the StashView additions:
 *  - branchFromStash(): prompts for branch name, delegates to
 *    GitService.stashBranch, refreshes the list on success, routes conflict
 *    errors to the Resolve Conflicts dialog.
 *  - renameStash(): prompts for new message (pre-filled with the current
 *    one), delegates to GitService.stashRename, refreshes the list.
 *  - Context menu ordering + Unicode ellipsis on prompt-opening labels.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { SpawnFailedError } from '../../../src/git-core/errors';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createStashView } from '../../../src/shelf/StashView';
import {
  IGitService,
  IRepository,
  IStash,
  IDiff,
} from '../../../src/git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../../../src/conflicts/interfaces/IConflictResolutionService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CallLog {
  method: string;
  args: unknown[];
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function makeStashes(): IStash[] {
  return [
    { index: 0, message: 'first', date: new Date('2026-01-01'), branch: 'main' },
    { index: 1, message: 'second', date: new Date('2026-01-02'), branch: 'main' },
    { index: 2, message: 'third', date: new Date('2026-01-03'), branch: 'feature' },
  ];
}

function makeGitService(overrides: {
  stashes: IStash[];
  stashBranchImpl?: (repo: IRepository, index: number, name: string) => Promise<void>;
  stashRenameImpl?: (repo: IRepository, index: number, msg: string) => Promise<void>;
}): IGitService & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  const svc = {
    calls,
    onDidChangeRepository: emitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: () => okAsync({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: () => okAsync(undefined),
    pull: () => okAsync(undefined),
    push: () => okAsync(undefined),
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
    stash: () => okAsync(undefined),
    stashList: async (): Promise<IStash[]> => overrides.stashes,
    stashApply: () => okAsync(undefined),
    stashPop: () => okAsync(undefined),
    stashDrop: () => okAsync(undefined),
    stashShow: async () => [],
    stashBranch: (repo: IRepository, index: number, name: string) => {
      calls.push({ method: 'stashBranch', args: [repo, index, name] });
      return ResultAsync.fromPromise(
        overrides.stashBranchImpl
          ? overrides.stashBranchImpl(repo, index, name)
          : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
    stashRename: (repo: IRepository, index: number, msg: string) => {
      calls.push({ method: 'stashRename', args: [repo, index, msg] });
      return ResultAsync.fromPromise(
        overrides.stashRenameImpl ? overrides.stashRenameImpl(repo, index, msg) : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
    createTag: () => okAsync(undefined),
    deleteTag: () => okAsync(undefined),
    pushTag: () => okAsync(undefined),
    getLog: async () => [],
    getCommit: async () => ({
      hash: '',
      shortHash: '',
      message: '',
      author: { name: '', email: '' },
      committer: { name: '', email: '' },
      parents: [],
      authorDate: new Date(),
      commitDate: new Date(),
    }),
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
    dispose: () => {},
  } as unknown as IGitService & { calls: CallLog[] };
  return svc;
}

interface ToastLog {
  info: string[];
  error: string[];
  warning: string[];
}

function installWindowStubs(
  inputBoxResponder: (opts: vscode.InputBoxOptions | undefined) => string | undefined
): { toasts: ToastLog; restore: () => void } {
  const toasts: ToastLog = { info: [], error: [], warning: [] };
  const oInfo = vscode.window.showInformationMessage;
  const oErr = vscode.window.showErrorMessage;
  const oWarn = vscode.window.showWarningMessage;
  const oInput = vscode.window.showInputBox;
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ): Promise<string | undefined> => {
    toasts.info.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    m: string
  ): Promise<string | undefined> => {
    toasts.error.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
    m: string
  ): Promise<string | undefined> => {
    toasts.warning.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async (
    opts?: vscode.InputBoxOptions
  ): Promise<string | undefined> => {
    return inputBoxResponder(opts);
  };
  const restore = (): void => {
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      oInfo;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = oWarn;
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox = oInput;
  };
  return { toasts, restore };
}

function makeMockConflictService(conflicts: string[]): IConflictResolutionService {
  const opens: unknown[] = [];
  const svc = {
    _opens: opens,
    getConflictedFiles: async (): Promise<string[]> => conflicts,
    openResolveConflictsDialog: async (
      repo: IRepository,
      conflictPaths: string[],
      opContext: unknown
    ): Promise<void> => {
      opens.push({ repo, conflictPaths, opContext });
    },
    // Minimal IConflictResolutionService surface; the real interface has more.
  } as unknown as IConflictResolutionService;
  return svc;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StashView — branch from stash + rename', () => {
  describe('branchFromStash()', () => {
    it('prompts for branch name and delegates to gitService.stashBranch', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);
      const { toasts, restore } = installWindowStubs(() => 'feature/wip');
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.branchFromStash(1);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.action, 'branch');

        const call = gitService.calls.find((c) => c.method === 'stashBranch');
        assert.ok(call);
        assert.strictEqual(call.args[1], 1);
        assert.strictEqual(call.args[2], 'feature/wip');

        assert.strictEqual(toasts.info.length, 1);
        assert.ok(toasts.info[0].includes('feature/wip'));
      } finally {
        restore();
        view.dispose();
      }
    });

    it('returns success:false when the user cancels the branch-name prompt', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);
      const { restore } = installWindowStubs(() => undefined);
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.branchFromStash(0);
        assert.strictEqual(result.success, false);
        const call = gitService.calls.find((c) => c.method === 'stashBranch');
        assert.strictEqual(call, undefined, 'stashBranch must not be invoked on cancel');
      } finally {
        restore();
        view.dispose();
      }
    });

    it('rejects invalid branch names via validateInput', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);
      const invalidSamples = ['', '   ', 'has space', 'bad~name'];
      const { restore } = installWindowStubs(() => 'feature/ok');
      try {
        // We can't easily capture the validateInput callback through the stub
        // abstraction above, so instead we grab it via another stub pass.
        let validator: ((v: string) => string | undefined) | undefined;
        const oInput = vscode.window.showInputBox;
        (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async (
          opts?: vscode.InputBoxOptions
        ): Promise<string | undefined> => {
          validator = opts?.validateInput as (v: string) => string | undefined;
          return 'feature/ok';
        };
        try {
          // Skip full `show()` — that would launch the real QuickPick UI which
          // isn't in the vscode mock. Prime the internal state via refresh()
          // after injecting the repository directly.
          (view as unknown as { _repository: IRepository })._repository = makeRepo();
          await view.refresh();
          await view.branchFromStash(0);
          assert.ok(validator, 'validateInput callback should have been captured');
          for (const bad of invalidSamples) {
            const msg = validator(bad);
            assert.ok(
              msg && msg.length > 0,
              `validator should reject "${bad}", got: ${String(msg)}`
            );
          }
          assert.strictEqual(validator('feature/new'), undefined);
          assert.strictEqual(validator('release.v1.2'), undefined);
        } finally {
          (vscode.window as unknown as { showInputBox: unknown }).showInputBox = oInput;
        }
      } finally {
        restore();
        view.dispose();
      }
    });

    it('routes conflict errors to the Resolve Conflicts dialog', async () => {
      const conflictService = makeMockConflictService(['a.txt', 'b.txt']);
      const gitService = makeGitService({
        stashes: makeStashes(),
        stashBranchImpl: async () => {
          throw new Error('CONFLICT (content): Merge conflict in a.txt');
        },
      });
      const view = createStashView(gitService, conflictService);
      const { toasts, restore } = installWindowStubs(() => 'wip/branch');
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.branchFromStash(0);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.action, 'branch');
        const opens = (conflictService as unknown as { _opens: unknown[] })._opens;
        assert.strictEqual(opens.length, 1, 'conflict dialog should have been opened');
        // No error toast — the dialog handles the UX.
        assert.strictEqual(toasts.error.length, 0);
      } finally {
        restore();
        view.dispose();
      }
    });

    it('shows an error toast for non-conflict failures', async () => {
      const gitService = makeGitService({
        stashes: makeStashes(),
        stashBranchImpl: async () => {
          throw new Error("fatal: A branch named 'feature/x' already exists.");
        },
      });
      const view = createStashView(gitService);
      const { toasts, restore } = installWindowStubs(() => 'feature/x');
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.branchFromStash(0);
        assert.strictEqual(result.success, false);
        assert.strictEqual(toasts.error.length, 1);
        assert.ok(toasts.error[0].includes('already exists'));
      } finally {
        restore();
        view.dispose();
      }
    });
  });

  describe('renameStash()', () => {
    it('prompts for new message and delegates to gitService.stashRename', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);
      const { toasts, restore } = installWindowStubs(() => 'renamed subject');
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.renameStash(1);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.action, 'rename');

        const call = gitService.calls.find((c) => c.method === 'stashRename');
        assert.ok(call);
        assert.strictEqual(call.args[1], 1);
        assert.strictEqual(call.args[2], 'renamed subject');

        assert.strictEqual(toasts.info.length, 1);
        assert.ok(toasts.info[0].includes('stash@{1}'));
      } finally {
        restore();
        view.dispose();
      }
    });

    it('pre-fills the input box with the current stash message', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);

      let capturedValue: string | undefined;
      const oInput = vscode.window.showInputBox;
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async (
        opts?: vscode.InputBoxOptions
      ): Promise<string | undefined> => {
        capturedValue = opts?.value;
        return undefined; // user cancels
      };
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        await view.renameStash(2);
        // stash@{2} has message "third"
        assert.strictEqual(capturedValue, 'third');
      } finally {
        (vscode.window as unknown as { showInputBox: unknown }).showInputBox = oInput;
        view.dispose();
      }
    });

    it('returns success:false when the user cancels the rename prompt', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);
      const { restore } = installWindowStubs(() => undefined);
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.renameStash(0);
        assert.strictEqual(result.success, false);
        const call = gitService.calls.find((c) => c.method === 'stashRename');
        assert.strictEqual(call, undefined, 'stashRename must not be invoked on cancel');
      } finally {
        restore();
        view.dispose();
      }
    });

    it('rejects empty / whitespace messages via validateInput', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);

      let validator: ((v: string) => string | undefined) | undefined;
      const oInput = vscode.window.showInputBox;
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async (
        opts?: vscode.InputBoxOptions
      ): Promise<string | undefined> => {
        validator = opts?.validateInput as (v: string) => string | undefined;
        return undefined;
      };
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        await view.renameStash(0);
        assert.ok(validator);
        assert.ok(validator(''));
        assert.ok(validator('   '));
        assert.strictEqual(validator('valid message'), undefined);
      } finally {
        (vscode.window as unknown as { showInputBox: unknown }).showInputBox = oInput;
        view.dispose();
      }
    });

    it('surfaces failures from gitService.stashRename as error toasts', async () => {
      const gitService = makeGitService({
        stashes: makeStashes(),
        stashRenameImpl: async () => {
          throw new Error('stash store failed');
        },
      });
      const view = createStashView(gitService);
      const { toasts, restore } = installWindowStubs(() => 'new name');
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        const result = await view.renameStash(0);
        assert.strictEqual(result.success, false);
        assert.strictEqual(toasts.error.length, 1);
        assert.ok(toasts.error[0].includes('stash store failed'));
      } finally {
        restore();
        view.dispose();
      }
    });
  });

  describe('context-menu wiring (showContextMenu)', () => {
    /**
     * We don't exercise the QuickPick UI; instead we grab the items array the
     * view would have passed to `showQuickPick` and assert the order + labels.
     */
    it('has 6 menu items in IntelliJ order with unicode ellipses on prompt-opening labels', async () => {
      const gitService = makeGitService({ stashes: makeStashes() });
      const view = createStashView(gitService);

      let capturedItems: readonly vscode.QuickPickItem[] = [];
      const oPick = vscode.window.showQuickPick;
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
        items: unknown
      ): Promise<unknown> => {
        capturedItems = (await Promise.resolve(items)) as readonly vscode.QuickPickItem[];
        return undefined; // user cancels → no action runs
      };
      try {
        // Skip full `show()` — that would launch the real QuickPick UI which
        // isn't in the vscode mock. Prime the internal state via refresh()
        // after injecting the repository directly.
        (view as unknown as { _repository: IRepository })._repository = makeRepo();
        await view.refresh();
        await view.showContextMenu(0);

        assert.strictEqual(capturedItems.length, 6, 'context menu must have 6 items');

        const labels = capturedItems.map((i) => i.label);
        assert.ok(labels[0].includes('Apply'), `item[0] is Apply, got: "${labels[0]}"`);
        assert.ok(labels[1].includes('Pop'), `item[1] is Pop, got: "${labels[1]}"`);
        assert.ok(labels[2].includes('Drop'), `item[2] is Drop, got: "${labels[2]}"`);
        assert.ok(labels[3].includes('View'), `item[3] is View, got: "${labels[3]}"`);
        assert.ok(labels[4].includes('Rename…'), `item[4] is Rename…, got: "${labels[4]}"`);
        assert.ok(
          labels[5].includes('Create Branch from Stash…'),
          `item[5] is Create Branch from Stash…, got: "${labels[5]}"`
        );

        // None of the labels uses ASCII "..."; prompt-opening ones use U+2026.
        for (const lbl of labels) {
          assert.ok(!lbl.includes('...'), `label "${lbl}" must use U+2026, not ASCII dots`);
        }
      } finally {
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oPick;
        view.dispose();
      }
    });
  });
});

// refresh() canonical-channel contract.
//
// Before StashView used the `_state.error` sideband:
// refresh() resolved to `void`, errors were stashed into `_state.error`, and
// _showShelfList read the latent value back. That mirrored the
// (now-removed) ShelfView pattern. Per ADR-006 the rule is now that
// QuickPick views surface refresh failures through the refresh() return
// value, never through a sideband on view state. These specs pin the new
// contract:
//   (a) successful refresh resolves to `{}` — no error key present
//   (b) failing refresh resolves to `{ error: <sanitized> }`
//   (c) getState() carries no `error` field after either path
//   (d) sanitized credentialed URLs / home paths in the returned error
describe('StashView TL-68 — refresh() returns { error? } (no _state.error sideband)', () => {
  it('resolves with {} when stashList succeeds', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    const view = createStashView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const result = await view.refresh();
      assert.deepStrictEqual(
        result,
        {},
        'successful refresh must resolve with an empty object — no error key'
      );
    } finally {
      view.dispose();
    }
  });

  it('resolves with { error } when stashList throws', async () => {
    const gitService = makeGitService({ stashes: [] });
    // Replace stashList with a thrower.
    (gitService as unknown as { stashList: unknown }).stashList = (): Promise<never> => {
      return Promise.reject(new Error('git stash list failed'));
    };
    const view = createStashView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must resolve with an error key when stashList throws');
      assert.ok(
        result.error.includes('git stash list failed'),
        `unexpected error text: ${result.error}`
      );
    } finally {
      view.dispose();
    }
  });

  it('getState() does not expose an error field — refresh() is the sole error channel', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    const view = createStashView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();

      // After a successful refresh
      await view.refresh();
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a successful refresh'
      );

      // And after a failed refresh — the canonical channel is still the
      // refresh() return; the state object stays clean.
      (gitService as unknown as { stashList: unknown }).stashList = (): Promise<never> => {
        return Promise.reject(new Error('git stash list failed'));
      };
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must surface the error on its return value');
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a failed refresh — refresh() return is canonical'
      );
    } finally {
      view.dispose();
    }
  });

  it('sanitizes credentialed URLs and home paths in the returned error', async () => {
    const RAW = 'list failed: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'list failed: https://<redacted>@example.com/repo.git\n~/project';
    const gitService = makeGitService({ stashes: [] });
    (gitService as unknown as { stashList: unknown }).stashList = (): Promise<never> => {
      return Promise.reject(new Error(RAW));
    };
    const view = createStashView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const result = await view.refresh();
      assert.strictEqual(result.error, EXPECTED);
      assert.ok(
        !result.error?.includes('alice:secret'),
        'returned error must not leak credentials'
      );
      assert.ok(!result.error?.includes('/Users/alice'), 'returned error must not leak home path');
    } finally {
      view.dispose();
    }
  });

  it('resolves with {} when no repository is bound (no-op)', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    const view = createStashView(gitService);
    try {
      // Do NOT prime _repository — refresh() should be a no-op resolve.
      const result = await view.refresh();
      assert.deepStrictEqual(result, {});
    } finally {
      view.dispose();
    }
  });
});

// (senior re-review HIGH) — every post-action caller in
// StashView must surface refresh failures as a warning toast prefixed
// with `Stash list refresh failed:`. This mirrors ShelfView's
// policy (see `Shelf list refresh failed:` specs in shelfView.test.ts):
// the action itself succeeded, so a refresh failure is a *secondary*
// signal — `showWarningMessage`, not `showErrorMessage`.
//
// Pre-fix code path: 5 of 6 callers (`showCreateDialog`, `popStash`,
// `branchFromStash`, `renameStash`, `dropStash`) called
// `await this.refresh();` and discarded the result, so a refresh
// failure was silent until the next list-open. This describe block
// pins the new contract per caller.
//
// Helper: prime the view with one successful refresh (so the entry the
// action targets is reachable), then flip `stashList` to throw on the
// post-action refresh. Assert exactly one warning toast prefixed
// `Stash list refresh failed:` fired.
describe('StashView post-action refresh — warning toast on refresh failure', () => {
  /**
   * Build a gitService whose `stashList` succeeds the first N invocations
   * (returning the seed stashes) and throws thereafter. Used to seed
   * the view's internal state via the first refresh, then exercise a
   * post-action refresh that hits the failure branch.
   */
  function makeFlakyGitService(
    seed: IStash[],
    successesBeforeFailure: number,
    overrides?: {
      stashBranchImpl?: (repo: IRepository, index: number, name: string) => Promise<void>;
      stashRenameImpl?: (repo: IRepository, index: number, msg: string) => Promise<void>;
    }
  ): IGitService & { calls: CallLog[] } {
    let count = 0;
    const svc = makeGitService({
      stashes: seed,
      stashBranchImpl: overrides?.stashBranchImpl,
      stashRenameImpl: overrides?.stashRenameImpl,
    });
    (svc as unknown as { stashList: unknown }).stashList = (): Promise<IStash[]> => {
      count += 1;
      if (count <= successesBeforeFailure) {
        return Promise.resolve(seed);
      }
      return Promise.reject(new Error('stash list IO error'));
    };
    return svc;
  }

  it('showCreateDialog emits a warning toast when the post-stash refresh fails', async () => {
    // showCreateDialog's path: showInputBox → showQuickPick options →
    // gitService.stash → refresh. Stash itself succeeds; refresh fails.
    // The seed is empty since the action creates the entry.
    const gitService = makeFlakyGitService([], 0); // every refresh fails
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'wip-changes');

    // showCreateDialog also calls _showStashOptionsDialog which uses
    // showQuickPick — stub it to pick the default options array.
    const oQuickPick = vscode.window.showQuickPick;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
      items: unknown
    ): Promise<unknown> => {
      const arr = (await Promise.resolve(items)) as readonly vscode.QuickPickItem[];
      // Return the default-picked one (Stash Changes), not multi-pick.
      return arr.filter((i) => i.picked);
    };

    try {
      const result = await view.showCreateDialog(makeRepo());
      assert.strictEqual(result.created, true, 'stash itself must have succeeded');
      assert.ok(
        toasts.warning.some((m) => m.startsWith('Stash list refresh failed:')),
        `expected warning toast prefixed 'Stash list refresh failed:', got: ${JSON.stringify(toasts.warning)}`
      );
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oQuickPick;
      restore();
      view.dispose();
    }
  });

  it('popStash emits a warning toast when the post-pop refresh fails', async () => {
    // First refresh seeds the list (so popStash finds index 0); the
    // post-pop refresh fails. successesBeforeFailure=1 covers the seed
    // refresh inside `_showStashList` if it ran, but here we drive
    // refresh() directly.
    const gitService = makeFlakyGitService(makeStashes(), 1);
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => undefined);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      // Seed
      await view.refresh();

      const result = await view.popStash(0);
      assert.strictEqual(result.success, true, 'pop itself must have succeeded');
      assert.ok(
        toasts.warning.some((m) => m.startsWith('Stash list refresh failed:')),
        `expected warning toast, got: ${JSON.stringify(toasts.warning)}`
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('branchFromStash emits a warning toast when the post-branch refresh fails', async () => {
    const gitService = makeFlakyGitService(makeStashes(), 1, {
      stashBranchImpl: async () => {}, // success
    });
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'feature/wip');
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh(); // seed

      const result = await view.branchFromStash(0);
      assert.strictEqual(result.success, true, 'branch itself must have succeeded');
      assert.ok(
        toasts.warning.some((m) => m.startsWith('Stash list refresh failed:')),
        `expected warning toast, got: ${JSON.stringify(toasts.warning)}`
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('renameStash emits a warning toast when the post-rename refresh fails', async () => {
    const gitService = makeFlakyGitService(makeStashes(), 1, {
      stashRenameImpl: async () => {}, // success
    });
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'renamed subject');
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh(); // seed

      const result = await view.renameStash(1);
      assert.strictEqual(result.success, true, 'rename itself must have succeeded');
      assert.ok(
        toasts.warning.some((m) => m.startsWith('Stash list refresh failed:')),
        `expected warning toast, got: ${JSON.stringify(toasts.warning)}`
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('dropStash emits a warning toast when the post-drop refresh fails', async () => {
    const gitService = makeFlakyGitService(makeStashes(), 1);
    const view = createStashView(gitService);
    // installWindowStubs returns toasts.info+error+warning, but
    // dropStash also gates on `showWarningMessage` returning 'Drop'
    // for the modal confirmation. We need to hijack only the modal
    // call — return 'Drop' there, push other warnings into toasts.warning.
    const { toasts, restore } = installWindowStubs(() => undefined);

    // Override showWarningMessage with a smarter responder: if the
    // call is the modal-confirm (carries `{ modal: true }`), return
    // 'Drop' so the action proceeds; otherwise it's the
    // refresh-failed toast we want to capture.
    const oWarn = vscode.window.showWarningMessage;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
      m: string,
      ...rest: unknown[]
    ): Promise<string | undefined> => {
      const isModal =
        rest.length >= 1 &&
        typeof rest[0] === 'object' &&
        rest[0] !== null &&
        (rest[0] as { modal?: boolean }).modal === true;
      if (isModal) {
        return 'Drop';
      }
      toasts.warning.push(m);
      return undefined;
    };

    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh(); // seed

      const result = await view.dropStash(0);
      assert.strictEqual(result.success, true, 'drop itself must have succeeded');
      assert.ok(
        toasts.warning.some((m) => m.startsWith('Stash list refresh failed:')),
        `expected warning toast prefixed 'Stash list refresh failed:', got: ${JSON.stringify(toasts.warning)}`
      );
    } finally {
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = oWarn;
      restore();
      view.dispose();
    }
  });
});

// Every StashView action-path catch block must route the
// raw git stderr through `sanitizeGitError` before pushing it into the
// `showErrorMessage` toast. Pre-fix, six of these sites concatenated
// `error.message` directly into the toast template, so a credentialed
// remote URL or absolute home path in stderr leaked into the user's
// notification history (and any user-shared bug-report screenshots).
//
// One spec per action site asserts both halves of the sanitiser
// (credentialed URL → `<redacted>@`, POSIX home → `~/`) plus the
// negative pair (toast does NOT include `alice:secret`, toast does NOT
// include `/Users/alice`). A future regression that drops the
// sanitizer call on any one site will fail the corresponding spec,
// not silently leak credentials again.
describe('StashView TL-72 — action-path toasts route through sanitizeGitError', () => {
  const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
  const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

  function assertSanitized(actual: string | undefined, prefix: string): void {
    assert.ok(actual, 'expected an error toast');
    assert.strictEqual(actual, `${prefix}: ${EXPECTED}`);
    assert.ok(!actual.includes('alice:secret'), 'toast must not leak credentials');
    assert.ok(!actual.includes('/Users/alice'), 'toast must not leak home path');
  }

  it('showCreateDialog (createStash) sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    (gitService as unknown as { stash: unknown }).stash = () => errAsync(new SpawnFailedError(RAW));
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'wip');

    const oQuickPick = vscode.window.showQuickPick;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
      items: unknown
    ): Promise<unknown> => {
      const arr = (await Promise.resolve(items)) as readonly vscode.QuickPickItem[];
      return arr.filter((i) => i.picked);
    };

    try {
      const result = await view.showCreateDialog(makeRepo());
      assert.strictEqual(result.created, false);
      assertSanitized(toasts.error[0], 'Failed to create stash');
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oQuickPick;
      restore();
      view.dispose();
    }
  });

  it('applyStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    (gitService as unknown as { stashApply: unknown }).stashApply = () =>
      errAsync(new SpawnFailedError(RAW));
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => undefined);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const result = await view.applyStash(0);
      assert.strictEqual(result.success, false);
      assertSanitized(toasts.error[0], 'Failed to apply stash');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('popStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    (gitService as unknown as { stashPop: unknown }).stashPop = () =>
      errAsync(new SpawnFailedError(RAW));
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => undefined);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const result = await view.popStash(0);
      assert.strictEqual(result.success, false);
      assertSanitized(toasts.error[0], 'Failed to pop stash');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('branchFromStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({
      stashes: makeStashes(),
      stashBranchImpl: () => Promise.reject(new Error(RAW)),
    });
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'feature/x');
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const result = await view.branchFromStash(0);
      assert.strictEqual(result.success, false);
      assertSanitized(toasts.error[0], 'Failed to create branch from stash');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('renameStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({
      stashes: makeStashes(),
      stashRenameImpl: () => Promise.reject(new Error(RAW)),
    });
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => 'new name');
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const result = await view.renameStash(0);
      assert.strictEqual(result.success, false);
      assertSanitized(toasts.error[0], 'Failed to rename stash');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('dropStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    (gitService as unknown as { stashDrop: unknown }).stashDrop = () =>
      errAsync(new SpawnFailedError(RAW));
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => undefined);

    // dropStash gates on a modal confirm → return 'Drop' so the action proceeds.
    const oWarn = vscode.window.showWarningMessage;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
      m: string,
      ...rest: unknown[]
    ): Promise<string | undefined> => {
      const isModal =
        rest.length >= 1 &&
        typeof rest[0] === 'object' &&
        rest[0] !== null &&
        (rest[0] as { modal?: boolean }).modal === true;
      if (isModal) {
        return 'Drop';
      }
      toasts.warning.push(m);
      return undefined;
    };

    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const result = await view.dropStash(0);
      assert.strictEqual(result.success, false);
      assertSanitized(toasts.error[0], 'Failed to drop stash');
    } finally {
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = oWarn;
      restore();
      view.dispose();
    }
  });

  it('viewStash sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    (gitService as unknown as { stashShow: unknown }).stashShow = (): Promise<never> =>
      Promise.reject(new Error(RAW));
    const view = createStashView(gitService);
    const { toasts, restore } = installWindowStubs(() => undefined);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      const diffs = await view.viewStash(0);
      assert.deepStrictEqual(diffs, []);
      assertSanitized(toasts.error[0], 'Failed to view stash');
    } finally {
      restore();
      view.dispose();
    }
  });
});

describe('StashView — diff picker basename collision', () => {
  it('opens the file the user picked, not a basename twin', async () => {
    const gitService = makeGitService({ stashes: makeStashes() });
    const view = createStashView(gitService);
    const diffA = {
      path: 'src/a/config.ts',
      status: 'modified',
      hunks: [{}],
      binary: false,
    } as unknown as IDiff;
    const diffB = {
      path: 'src/b/config.ts',
      status: 'modified',
      hunks: [{}],
      binary: false,
    } as unknown as IDiff;

    let captured: IDiff | undefined;
    (
      view as unknown as { _showDiffContent: (s: IStash, d: IDiff) => Promise<void> }
    )._showDiffContent = async (_s, d) => {
      captured = d;
    };

    const oPick = vscode.window.showQuickPick;
    // User picks the SECOND item — same basename (config.ts) as the first.
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
      items: vscode.QuickPickItem[]
    ) => items[1];

    const stash: IStash = { index: 0, message: 'wip', date: new Date() };
    try {
      await (
        view as unknown as {
          _showStashDiffPicker: (s: IStash, d: IDiff[]) => Promise<void>;
        }
      )._showStashDiffPicker(stash, [diffA, diffB]);
      assert.strictEqual(
        captured?.path,
        'src/b/config.ts',
        'must open the picked file, not its basename twin'
      );
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oPick;
      view.dispose();
    }
  });
});

describe('StashView — setRepository seam', () => {
  it('binds the repo with no UI side effect so a later refresh targets it', async () => {
    const repo = makeRepo();
    const git = makeGitService({ stashes: [] });
    let listedRepo: IRepository | undefined;
    (git as unknown as { stashList: (r: IRepository) => Promise<IStash[]> }).stashList = async (
      r: IRepository
    ): Promise<IStash[]> => {
      listedRepo = r;
      return [];
    };

    const view = createStashView(git);
    try {
      view.setRepository(repo);
      const res = await view.refresh();
      assert.strictEqual(res.error, undefined, 'refresh after setRepository succeeds');
      assert.strictEqual(listedRepo, repo, 'refresh targets the repo bound via setRepository');
    } finally {
      view.dispose();
    }
  });
});

describe('StashView — stale-index re-validation (wrong-stash data-loss guard)', () => {
  it('aborts drop and does NOT call stashDrop when the stash at the index drifted to a different sha', async () => {
    const seeded: IStash[] = [
      { index: 0, message: 'wip-A', date: new Date(), hash: 'a'.repeat(40) },
    ];
    const gitService = makeGitService({ stashes: seeded });
    const view = createStashView(gitService);
    const { restore } = installWindowStubs(() => undefined);
    let dropCalls = 0;
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh(); // seed _state with hash a…

      // The stack renumbered: stash@{0} now points at a DIFFERENT stash.
      (gitService as unknown as { stashList: () => Promise<IStash[]> }).stashList = async () => [
        { index: 0, message: 'wip-B', date: new Date(), hash: 'b'.repeat(40) },
      ];
      (gitService as unknown as { stashDrop: () => ReturnType<typeof okAsync> }).stashDrop = () => {
        dropCalls += 1;
        return okAsync(undefined);
      };

      const result = await view.dropStash(0);
      assert.strictEqual(result.success, false, 'drop must abort on index drift');
      assert.strictEqual(dropCalls, 0, 'the wrong stash must NOT be dropped');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('drops when the sha at the index still matches the selected stash', async () => {
    const sha = 'a'.repeat(40);
    const gitService = makeGitService({
      stashes: [{ index: 0, message: 'wip', date: new Date(), hash: sha }],
    });
    const view = createStashView(gitService);
    const { restore } = installWindowStubs(() => undefined);
    let dropCalls = 0;
    // The drop confirmation modal must be accepted.
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      async (): Promise<string | undefined> => 'Drop';
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.refresh();
      (gitService as unknown as { stashDrop: () => ReturnType<typeof okAsync> }).stashDrop = () => {
        dropCalls += 1;
        return okAsync(undefined);
      };

      const result = await view.dropStash(0);
      assert.strictEqual(result.success, true, 'a matching sha must allow the drop');
      assert.strictEqual(dropCalls, 1, 'the selected stash is dropped exactly once');
    } finally {
      restore();
      view.dispose();
    }
  });
});
