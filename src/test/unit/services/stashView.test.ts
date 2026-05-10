/**
 * Unit tests for the T2-09 StashView additions:
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

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createStashView } from '../../../services/StashView';
import { IGitService, IRepository, IStash } from '../../../services/interfaces/IGitService';
import { IConflictResolutionService } from '../../../services/interfaces/IConflictResolutionService';
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
    commit: async () => {},
    amend: async () => {},
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
    fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
    stash: async () => {},
    stashList: async (): Promise<IStash[]> => overrides.stashes,
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
    stashBranch: async (repo: IRepository, index: number, name: string): Promise<void> => {
      calls.push({ method: 'stashBranch', args: [repo, index, name] });
      if (overrides.stashBranchImpl) {
        await overrides.stashBranchImpl(repo, index, name);
      }
    },
    stashRename: async (repo: IRepository, index: number, msg: string): Promise<void> => {
      calls.push({ method: 'stashRename', args: [repo, index, msg] });
      if (overrides.stashRenameImpl) {
        await overrides.stashRenameImpl(repo, index, msg);
      }
    },
    createTag: async () => {},
    deleteTag: async () => {},
    pushTag: async () => {},
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
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  } as unknown as IGitService & { calls: CallLog[] };
  return svc;
}

interface ToastLog {
  info: string[];
  error: string[];
}

function installWindowStubs(
  inputBoxResponder: (opts: vscode.InputBoxOptions | undefined) => string | undefined
): { toasts: ToastLog; restore: () => void } {
  const toasts: ToastLog = { info: [], error: [] };
  const oInfo = vscode.window.showInformationMessage;
  const oErr = vscode.window.showErrorMessage;
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
  (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async (
    opts?: vscode.InputBoxOptions
  ): Promise<string | undefined> => {
    return inputBoxResponder(opts);
  };
  const restore = (): void => {
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      oInfo;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
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

describe('StashView T2-09 — branch from stash + rename', () => {
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
