/**
 * Unit tests for CommitContextMenuCommands.
 * Tests all 13 action handlers for correct git service calls,
 * error handling, and conflict scenarios.
 */

/*
 * Stub factories synthesise IGitService / IRebaseService instances whose
 * member signatures are `Promise<T>`. Implementations that simply return a
 * literal (or just push to a call tracker) have no `await`; this is
 * intentional stub behaviour.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commits/CommitContextMenuCommands';
import { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import {
  IRebaseAction,
  IRebaseService,
  IRebaseSession,
} from '../../../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../../../ui-shell/GitToolWindowProvider';
import type { BranchComparisonView } from '../../../branches/BranchComparisonView';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { writableWindow, writableEnv, writableCommands } from '../../typed/windowStub';

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

interface CallTracker {
  method: string;
  args: unknown[];
}

function createMockRepo(headCommit?: string): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: headCommit, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function createMockGitService(
  repo: IRepository,
  overrides?: Partial<IGitService>
): IGitService & { calls: CallTracker[] } {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const calls: CallTracker[] = [];

  const service = {
    calls,
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [repo],
    getRepository: async () => repo,
    reloadRepository: async () => repo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async (...args: unknown[]) => {
      calls.push({ method: 'checkout', args });
    },
    deleteBranch: async () => {},
    renameBranch: async () => {},
    setBranchUpstream: async () => {},
    mergeBranch: async (...args: unknown[]) => {
      calls.push({ method: 'mergeBranch', args });
      return { success: true };
    },
    rebaseBranch: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
    stash: async (...args: unknown[]) => {
      calls.push({ method: 'stash', args });
    },
    stashList: async () => [],
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
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
    cherryPick: async (...args: unknown[]) => {
      calls.push({ method: 'cherryPick', args });
      return { success: true };
    },
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async (...args: unknown[]) => {
      calls.push({ method: 'revert', args });
      return { success: true };
    },
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
    ...overrides,
  } as unknown as IGitService & { calls: CallTracker[] };

  return service;
}

function createMockRebaseService(
  overrides?: Partial<IRebaseService>
): IRebaseService & { calls: CallTracker[] } {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  const calls: CallTracker[] = [];

  const defaultSession: IRebaseSession = {
    onto: 'abc123',
    originalBranch: 'main',
    commits: [
      { hash: 'abc12345678901234567890123456789abcdef01', message: 'test commit', action: 'pick' },
    ],
    currentStep: 0,
    status: 'planning',
  };

  return {
    calls,
    startInteractiveRebase: async (...args: unknown[]) => {
      calls.push({ method: 'startInteractiveRebase', args });
      return defaultSession;
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: (...args: unknown[]) => {
      calls.push({ method: 'updateRebasePlan', args });
    },
    executeRebase: async (...args: unknown[]) => {
      calls.push({ method: 'executeRebase', args });
      return { success: true, status: 'completed' as const };
    },
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async (...args: unknown[]) => {
      calls.push({ method: 'abortRebase', args });
    },
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    provideSquashMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
    ...overrides,
  } as unknown as IRebaseService & { calls: CallTracker[] };
}

function createMockProvider(): GitToolWindowProvider & { refreshCallCount: number } {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refreshCallCount: 0,
    refresh: function (this: { refreshCallCount: number }) {
      this.refreshCallCount++;
    },
  } as unknown as GitToolWindowProvider & { refreshCallCount: number };
}

/** Mock GitCli surface used by the test suite. */
type MockGitCli = import('../../../git-core/gitCli').GitCli & { calls: CallTracker[] };

function createMockGitCli(overrides?: Record<string, unknown>): MockGitCli {
  const calls: CallTracker[] = [];
  return {
    calls,
    exec: async (...args: unknown[]) => {
      calls.push({ method: 'exec', args });
      return { exitCode: 0, stdout: 'patch content', stderr: '', combined: '' };
    },
    execString: async () => '',
    isAvailable: async () => true,
    getVersion: async () => '2.40.0',
    isRepository: async () => true,
    getRepositoryRoot: async () => '/test-repo',
    dispose: () => {},
    get gitPath() {
      return 'git';
    },
    set gitPath(_v: string) {},
    onCommandExecuted: (() => ({
      dispose: () => {},
    })) as unknown as MockGitCli['onCommandExecuted'],
    ...overrides,
  } as unknown as MockGitCli;
}

/** GitCli mock that returns clean status (empty porcelain output). */
function createCleanGitCli(overrides?: Record<string, unknown>): MockGitCli {
  return createMockGitCli({
    exec: async (...args: unknown[]) => {
      const cmdArgs = args[0] as string[];
      if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    ...overrides,
  });
}

// ─── Message Trackers ─────────────────────────────────────────────────────────

interface MessageRecord {
  message: string;
  items: string[];
}

function createMessageTrackers(): {
  info: MessageRecord[];
  error: MessageRecord[];
  warning: MessageRecord[];
} {
  const info: MessageRecord[] = [];
  const error: MessageRecord[] = [];
  const warning: MessageRecord[] = [];

  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]): Promise<string | undefined> => {
    info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]): Promise<string | undefined> => {
    error.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showWarningMessage = (message: string, ...items: unknown[]): Promise<string | undefined> => {
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    warning.push({ message, items: stringItems });
    return Promise.resolve(undefined);
  };
  return { info, error, warning };
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showErrorMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showQuickPick = (): Promise<unknown> => Promise.resolve(undefined);
  // Default: accept whatever pre-filled value is offered (simulates pressing Enter).
  w.showInputBox = (opts?: import('vscode').InputBoxOptions): Promise<string | undefined> =>
    Promise.resolve(opts?.value);
  w.showSaveDialog = (): Promise<import('vscode').Uri | undefined> => Promise.resolve(undefined);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CommitContextMenuCommands - Unit Tests', () => {
  const testHash = 'abc12345678901234567890123456789abcdef01';

  afterEach(() => {
    restoreMocks();
  });

  // ─── copyHash ─────────────────────────────────────────────────────────────

  describe('_handleCopyHash', () => {
    it('copies the commit hash to clipboard', async () => {
      let copiedText = '';
      writableEnv().clipboard = {
        writeText: (text: string): Promise<void> => {
          copiedText = text;
          return Promise.resolve();
        },
        readText: (): Promise<string> => Promise.resolve(''),
      };
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('copyHash', [testHash]);

      assert.strictEqual(copiedText, testHash);
      assert.strictEqual(messages.info.length, 1);
      assert.ok(messages.info[0].message.includes(testHash));
    });

    it('does nothing with empty commit hashes', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('copyHash', []);

      assert.strictEqual(messages.info.length, 0);
    });
  });

  // ─── cherryPick ───────────────────────────────────────────────────────────

  describe('_handleCherryPick', () => {
    it('calls gitService.cherryPick with correct arguments', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('cherryPick', [testHash]);

      const call = gitService.calls.find((c) => c.method === 'cherryPick');
      assert.ok(call, 'cherryPick should have been called');
      assert.deepStrictEqual(call.args[1], [testHash]);
    });

    it('shows warning on conflicts', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        cherryPick: async () => ({ success: false, conflicts: ['file1.ts', 'file2.ts'] }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('cherryPick', [testHash]);

      assert.strictEqual(messages.warning.length, 1);
      assert.ok(messages.warning[0].message.includes('2 file(s)'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        cherryPick: async () => {
          throw new Error('cherry-pick failed');
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('cherryPick', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('cherry-pick failed'));
    });
  });

  // ─── revert ───────────────────────────────────────────────────────────────

  describe('_handleRevert', () => {
    it('calls gitService.revert with correct arguments', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('revert', [testHash]);

      const call = gitService.calls.find((c) => c.method === 'revert');
      assert.ok(call, 'revert should have been called');
      assert.deepStrictEqual(call.args[1], [testHash]);
    });

    it('shows warning on conflicts', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        revert: async () => ({ success: false, conflicts: ['file1.ts'] }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('revert', [testHash]);

      assert.strictEqual(messages.warning.length, 1);
      assert.ok(messages.warning[0].message.includes('1 file(s)'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        revert: async () => {
          throw new Error('revert failed');
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('revert', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('revert failed'));
    });
  });

  // ─── checkoutRevision ─────────────────────────────────────────────────────

  describe('_handleCheckoutRevision', () => {
    it('calls gitService.checkout with the hash', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('checkoutRevision', [testHash]);

      const call = gitService.calls.find((c) => c.method === 'checkout');
      assert.ok(call, 'checkout should have been called');
      assert.strictEqual(call.args[1], testHash);
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        checkout: async () => {
          throw new Error('checkout failed');
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('checkoutRevision', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('checkout'));
    });
  });

  // ─── undoCommit ─────────────────────────────────────────────────────────────

  describe('_handleUndoCommit (#9 preserve message)', () => {
    it('soft-resets HEAD and prefills the composer with the undone commit message', async () => {
      const repo = createMockRepo(testHash); // head.commit === testHash → HEAD guard passes
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: testHash,
          shortHash: 'abc1234',
          message: 'feat: original subject\n\noriginal body',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: ['parent'],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const prefilled: string[] = [];
      commands.setCommitComposer({ prefillComposerMessage: (m: string) => prefilled.push(m) });

      await commands._handleAction('undoCommit', [testHash]);

      const reset = gitCli.calls.find((c: CallTracker) => (c.args[0] as string[])?.[0] === 'reset');
      assert.ok(reset, 'a git reset was executed');
      assert.deepStrictEqual(reset.args[0], ['reset', '--soft', 'HEAD~1']);
      assert.deepStrictEqual(prefilled, ['feat: original subject\n\noriginal body']);
    });
  });

  // ─── resetToHere ──────────────────────────────────────────────────────────

  describe('_handleResetToHere', () => {
    /**
     * After landed, `resetToHere` opens a ResetDialog (webview)
     * instead of a QuickPick. The dialog requires `this._context` to be
     * set by `register()`. Tests below exercise the dispatcher-level
     * behaviour (invalid/missing commit, missing context); ResetDialog's
     * own logic has its dedicated test file at
     * `services/resetDialog.test.ts`.
     */

    it('no-ops when commitHashes is empty', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('resetToHere', []);

      assert.strictEqual(messages.error.length, 0);
      assert.strictEqual(messages.info.length, 0);
    });

    it('shows a clear error if invoked without register() having been called', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      // No register() call → _context is undefined → expect guarded error.
      await commands._handleAction('resetToHere', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.toLowerCase().includes('context not initialised') ||
          messages.error[0].message.toLowerCase().includes('context not initialized')
      );
    });
  });

  // ─── createPatch ──────────────────────────────────────────────────────────

  describe('_handleCreatePatch', () => {
    it('runs git format-patch, atomic-writes the result to the user-picked path', async () => {
      // The write side now goes through `atomicWriteFile` (Node
      // fs promises, not vscode.workspace.fs). Point the save dialog at
      // a real tmp path, let the real atomic helper run, and assert the
      // file lands with the expected content + no temp debris.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-createpatch-ok-'));
      const outPath = path.join(tmpDir, 'test.patch');
      writableWindow().showSaveDialog = (): Promise<vscode.Uri | undefined> =>
        Promise.resolve(Uri.file(outPath));
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      try {
        await commands._handleAction('createPatch', [testHash]);

        const call = gitCli.calls.find((c: CallTracker) => c.method === 'exec');
        assert.ok(call, 'gitCli.exec should have been called');
        const args = call.args[0] as string[];
        assert.ok(args.includes('format-patch'));
        assert.ok(args.includes(testHash));
        // The patch file lands at the picked path with the format-patch stdout.
        assert.strictEqual(fs.readFileSync(outPath, 'utf-8'), 'patch content');
        // And no sibling `.tmp-<pid>-*` debris remains in the directory.
        const debris = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
        assert.strictEqual(debris.length, 0, `unexpected tmp debris: ${debris.join(', ')}`);
        assert.strictEqual(messages.info.length, 1);
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('surfaces sanitised toast when atomic write fails; no success toast', async () => {
      // Fault injection: pick a non-existent sub-directory so
      // atomicWriteFile's sibling-tmp write rejects with ENOENT. Exercises
      // the inner try/catch added in _handleCreatePatch — write-only
      // failure must surface as "Failed to write patch:" and suppress
      // the success "Patch saved to …" toast.
      const missingDir = path.join(
        os.tmpdir(),
        `intellig-createpatch-missing-${process.pid}-${Date.now()}`,
        'test.patch'
      );
      writableWindow().showSaveDialog = (): Promise<vscode.Uri | undefined> =>
        Promise.resolve(Uri.file(missingDir));
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatch', [testHash]);

      assert.strictEqual(
        messages.error.length,
        1,
        `expected exactly one error toast, got ${messages.error.length}`
      );
      assert.ok(
        messages.error[0].message.startsWith('Failed to write patch:'),
        `expected "Failed to write patch:" prefix, got: "${messages.error[0].message}"`
      );
      // Success toast suppressed — no "Patch saved to …" fired.
      assert.strictEqual(
        messages.info.length,
        0,
        'success toast must not fire after write failure'
      );
    });

    it('does nothing when user cancels save dialog', async () => {
      writableWindow().showSaveDialog = (): Promise<vscode.Uri | undefined> =>
        Promise.resolve(undefined);
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatch', [testHash]);

      assert.strictEqual(messages.info.length, 0);
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async () => {
          throw new Error('format-patch failed');
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatch', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('format-patch failed'));
    });
  });

  // ─── compareWithLocal ─────────────────────────────────────────────────────

  describe('_handleCompareWithLocal', () => {
    it('calls getCommitDiff and opens vscode.diff for the first changed file', async () => {
      let executedCommand = '';
      let executedArgs: unknown[] = [];
      writableCommands().executeCommand = (cmd: string, ...args: unknown[]): Promise<unknown> => {
        executedCommand = cmd;
        executedArgs = args;
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommitDiff: async () => [
          { path: 'src/file.ts', status: 'modified', hunks: [], binary: false },
        ],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('compareWithLocal', [testHash]);

      assert.strictEqual(executedCommand, 'vscode.diff');
      assert.strictEqual(executedArgs.length, 3);
    });

    it('shows info message when no changes found', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommitDiff: async () => [],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('compareWithLocal', [testHash]);

      assert.strictEqual(messages.info.length, 1);
      assert.ok(messages.info[0].message.includes('No changes'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommitDiff: async () => {
          throw new Error('diff failed');
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('compareWithLocal', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('diff failed'));
    });

    // Regression for senior- / task #82 (user-reported crash):
    // Compare-with-Local constructed its left-hand URI with the unregistered
    // `git-show:` scheme and a JSON-encoded query. VS Code has no provider
    // for that scheme, so it threw `Unable to resolve resource git-show:...`
    // before the diff could open. The fix normalizes to the same shape the
    // rest of extension.ts uses:
    //   intellig-git:<path>?<encodeURIComponent(ref)>
    // which is the exact contract `registerGitContentProvider` parses.
    //
    // Note: `src/test/mocks/vscode.ts::Uri.parse` stores the whole raw
    // string in `path` with `scheme='file'` — same as other URI-shape
    // tests in this suite (see `branchShowDiff.test.ts:252`). We assert on
    // `toString()` content to get the meaningful invariant.
    it('builds the left-hand URI with the registered `intellig-git:` scheme and a URL-encoded ref', async () => {
      const diffCalls: Array<{ left: vscode.Uri; right: vscode.Uri; title: string }> = [];
      writableCommands().executeCommand = (cmd: string, ...args: unknown[]): Promise<unknown> => {
        if (cmd === 'vscode.diff') {
          diffCalls.push({
            left: args[0] as vscode.Uri,
            right: args[1] as vscode.Uri,
            title: args[2] as string,
          });
        }
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommitDiff: async () => [
          { path: 'docs/features/alert-system.md', status: 'modified', hunks: [], binary: false },
        ],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('compareWithLocal', [testHash]);

      assert.strictEqual(diffCalls.length, 1, 'expected exactly one vscode.diff call');
      const leftStr = diffCalls[0].left.toString();

      // Left side: the git-revision URI handled by the intellig-git provider.
      // Must be on the registered scheme — no `git-show:` drift.
      assert.ok(
        leftStr.includes('intellig-git:docs/features/alert-system.md'),
        `left URI should be an intellig-git path, got: "${leftStr}"`
      );
      assert.ok(
        !leftStr.includes('git-show:'),
        `left URI must not use the legacy "git-show:" scheme, got: "${leftStr}"`
      );
      // The provider in extension.ts reads `uri.query` as the raw,
      // URL-encoded git ref. No JSON blob, no `ref=` prefix — just the ref.
      assert.ok(
        leftStr.includes(`?${encodeURIComponent(testHash)}`) || leftStr.includes(`?${testHash}`),
        `left URI query must be the URL-encoded ref (no JSON envelope); got: "${leftStr}"`
      );
      assert.ok(
        !leftStr.includes('"ref"'),
        `left URI query must NOT be a JSON envelope; got: "${leftStr}"`
      );
    });
  });

  // ─── showRepoAtRevision ───────────────────────────────────────────────────

  describe('_handleShowRepoAtRevision', () => {
    it('calls git ls-tree and shows QuickPick with file list', async () => {
      let executedCommand = '';
      writableCommands().executeCommand = (cmd: string): Promise<unknown> => {
        executedCommand = cmd;
        return Promise.resolve(undefined);
      };
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve(items[0]);
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'ls-tree') {
            return {
              exitCode: 0,
              stdout: 'src/file1.ts\nsrc/file2.ts\n',
              stderr: '',
              combined: '',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('showRepoAtRevision', [testHash]);

      assert.strictEqual(executedCommand, 'vscode.open');
    });

    it('shows info message when no files found', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('showRepoAtRevision', [testHash]);

      assert.strictEqual(messages.info.length, 1);
      assert.ok(messages.info[0].message.includes('No files'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async () => {
          throw new Error('ls-tree failed');
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('showRepoAtRevision', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('ls-tree failed'));
    });

    // Regression for senior- / task #82 (see compareWithLocal note above).
    // Show-Repo-at-Revision's QuickPick path had the same URI-scheme drift;
    // picking a file would throw "Unable to resolve resource git-show:...".
    it('opens the selected file with an `intellig-git:` URI and URL-encoded ref', async () => {
      const openedUris: vscode.Uri[] = [];
      writableCommands().executeCommand = (cmd: string, ...args: unknown[]): Promise<unknown> => {
        if (cmd === 'vscode.open') {
          openedUris.push(args[0] as vscode.Uri);
        }
        return Promise.resolve(undefined);
      };
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve(items[0]);
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'ls-tree') {
            return {
              exitCode: 0,
              stdout: 'docs/features/alert-system.md\nsrc/file2.ts\n',
              stderr: '',
              combined: '',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('showRepoAtRevision', [testHash]);

      assert.strictEqual(openedUris.length, 1, 'expected exactly one vscode.open call');
      const uriStr = openedUris[0].toString();
      assert.ok(
        uriStr.includes('intellig-git:docs/features/alert-system.md'),
        `URI should be on the registered intellig-git: scheme, got: "${uriStr}"`
      );
      assert.ok(
        !uriStr.includes('git-show:'),
        `URI must not use the legacy "git-show:" scheme, got: "${uriStr}"`
      );
      assert.ok(
        uriStr.includes(`?${encodeURIComponent(testHash)}`) || uriStr.includes(`?${testHash}`),
        `URI query must be the URL-encoded ref (no JSON envelope); got: "${uriStr}"`
      );
      assert.ok(
        !uriStr.includes('"ref"'),
        `URI query must NOT be a JSON envelope; got: "${uriStr}"`
      );
    });
  });

  // ─── undoCommit ───────────────────────────────────────────────────────────

  describe('_handleUndoCommit', () => {
    it('runs git reset --soft HEAD~1 when commit is HEAD', async () => {
      createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [testHash]);

      const call = gitCli.calls.find((c: CallTracker) => c.method === 'exec');
      assert.ok(call, 'gitCli.exec should have been called');
      const args = call.args[0] as string[];
      assert.deepStrictEqual(args, ['reset', '--soft', 'HEAD~1']);
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('shows error when commit is not HEAD', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo('different_hash');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('HEAD commit'));
      assert.strictEqual(gitCli.calls.length, 0);
    });

    it('shows error when HEAD has no commit', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo(undefined);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('HEAD commit'));
    });

    it('shows error on git reset failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async () => {
          throw new Error('reset failed');
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('reset failed'));
    });
  });

  // ─── dropCommit ───────────────────────────────────────────────────────────

  describe('_handleDropCommit', () => {
    it('starts interactive rebase with hash~1, sets drop action, and executes', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('dropCommit', [testHash]);

      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'startInteractiveRebase should have been called');
      assert.strictEqual(startCall.args[1], `${testHash}~1`);

      const updateCall = rebaseService.calls.find((c) => c.method === 'updateRebasePlan');
      assert.ok(updateCall, 'updateRebasePlan should have been called');
      const plan = updateCall.args[1] as IRebaseAction[];
      // The plan should contain all commits from the session, with the target set to 'drop'
      assert.strictEqual(plan.length, 1); // mock session has 1 commit
      const targetEntry = plan.find((p) => p.hash === testHash);
      assert.ok(targetEntry, 'Plan should contain the target commit');
      assert.strictEqual(targetEntry.action, 'drop');

      const execCall = rebaseService.calls.find((c) => c.method === 'executeRebase');
      assert.ok(execCall, 'executeRebase should have been called');
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('shows warning on rebase conflicts', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({
          success: false,
          status: 'conflict' as const,
          conflictedFiles: ['file1.ts', 'file2.ts'],
          rebaseInProgress: true,
        }),
      });
      const provider = createMockProvider();
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('dropCommit', [testHash]);

      assert.strictEqual(messages.warning.length, 1);
      assert.ok(messages.warning[0].message.includes('2 file(s)'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => {
          throw new Error('rebase failed');
        },
      });
      const provider = createMockProvider();
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('dropCommit', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('rebase failed'));
    });

    it('stashes dirty state before dropping and pops after', async () => {
      const execCalls: string[][] = [];
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          execCalls.push(cmdArgs);
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: ' M src/dirty.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('dropCommit', [testHash]);

      const stashPush = execCalls.find((c) => c[0] === 'stash' && c[1] === 'push');
      assert.ok(stashPush, 'should stash before drop');
      const stashPop = execCalls.find((c) => c[0] === 'stash' && c[1] === 'pop');
      assert.ok(stashPop, 'should pop stash after drop');
    });

    it('blocks drop when there are unmerged files', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: 'UU src/conflict.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('dropCommit', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('unmerged'));
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'rebase should NOT have been started with unmerged files');
    });
  });

  // ─── editCommitMessage ────────────────────────────────────────────────────

  describe('_handleEditCommitMessage', () => {
    it('uses git commit --amend for HEAD commit', async () => {
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('updated message');
      createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old message\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      // Should use amend, not rebase
      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(amendCall, 'git commit --amend should have been called');
      const amendArgs = amendCall.args[0] as string[];
      assert.ok(amendArgs.includes('--allow-empty'));
      assert.ok(amendArgs.includes('--only'));
      assert.ok(amendArgs.includes('updated message'));

      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'startInteractiveRebase should NOT have been called for HEAD commit');
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('uses rebase reword for non-HEAD commit, stashing changes first', async () => {
      let inputBoxValue = '';
      writableWindow().showInputBox = (opts?: unknown): Promise<string | undefined> => {
        const v = (opts as { value?: unknown } | undefined)?.value;
        inputBoxValue = typeof v === 'string' ? v : '';
        return Promise.resolve('new commit message');
      };
      createMessageTrackers();
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return {
              exitCode: 0,
              stdout: 'test commit\n\nFull body of the commit message.\n',
              stderr: '',
              combined: '',
            };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: ' M src/file.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      // Verify the input box was pre-filled with the full commit message
      assert.ok(
        inputBoxValue.includes('Full body of the commit message'),
        'Input box should show the full commit message'
      );

      // Should have stashed changes
      const stashCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'stash' && a[1] === 'push';
      });
      assert.ok(stashCall, 'git stash push should have been called');

      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'startInteractiveRebase should have been called');
      assert.strictEqual(startCall.args[1], `${testHash}~1`);

      const updateCall = rebaseService.calls.find((c) => c.method === 'updateRebasePlan');
      assert.ok(updateCall, 'updateRebasePlan should have been called');
      const plan = updateCall.args[1] as IRebaseAction[];
      const targetEntry = plan.find((p) => p.hash === testHash);
      assert.ok(targetEntry, 'Plan should contain the target commit');
      assert.strictEqual(targetEntry.action, 'reword');
      assert.strictEqual(targetEntry.newMessage, 'new commit message');

      // Should have popped stash after
      const popCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'stash' && a[1] === 'pop';
      });
      assert.ok(popCall, 'git stash pop should have been called');
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('warns before rewording an already-pushed non-HEAD commit and aborts when the user declines', async () => {
      // IntelliJ's GitSingleCommitEditingAction.lastCheckCommitsEditingAvailability
      // blocks reword on a commit pushed to a protected branch. We have no
      // protected-branch config, so the parity-flavoured guard is a
      // confirmation: rewording a commit that already exists on a remote
      // rewrites published history. Declining the confirm must NOT start a
      // rebase.
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('rewritten message');
      // createMessageTrackers installs a showWarningMessage that records the
      // call and returns undefined — i.e. the user dismissed the modal
      // (declined). The decline path must abort the reword.
      const messages = createMessageTrackers();
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old message\n', stderr: '', combined: '' };
          }
          // The commit IS on a remote-tracking branch — already pushed.
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: '  origin/main\n', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      // A history-rewrite warning was surfaced.
      assert.strictEqual(
        messages.warning.length,
        1,
        `expected exactly one warning, got ${messages.warning.length}`
      );
      assert.ok(
        /push/i.test(messages.warning[0].message),
        `warning should mention the commit was pushed, got: "${messages.warning[0].message}"`
      );

      // Declining must NOT rewrite history.
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(
        !startCall,
        'startInteractiveRebase must NOT run when the user declines the pushed-commit warning'
      );
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a cancelled reword');
    });

    it('proceeds with reword of an already-pushed commit when the user confirms', async () => {
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('rewritten message');
      createMessageTrackers();
      // User confirms the history-rewrite warning. Record invocations so we
      // can assert the warning was actually surfaced before proceeding.
      let warningCount = 0;
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => {
        warningCount++;
        return Promise.resolve('Reword Anyway');
      };
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old message\n', stderr: '', combined: '' };
          }
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: '  origin/main\n', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      // Warning shown but confirmed → the rebase proceeds.
      assert.strictEqual(warningCount, 1, 'the warning is still shown before confirming');
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'startInteractiveRebase should run after the user confirms');
    });

    it('_isCommitPushed returns false for a non-hex hash without invoking git', async () => {
      // The hash is passed positionally to `git branch --contains <hash>`, which
      // has no `--end-of-options`. A flag-like value must be rejected before exec.
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      const result = await (
        commands as unknown as {
          _isCommitPushed(cwd: string, hash: string): Promise<boolean>;
        }
      )._isCommitPushed('/test-repo', '--upload-pack=evil');

      assert.strictEqual(result, false, 'a non-hex hash must be treated as not pushed');
      const execCalls = gitCli.calls.filter((c) => c.method === 'exec');
      assert.strictEqual(execCalls.length, 0, 'no git exec should run for a non-hex hash');
    });

    it('warns before rewording an already-pushed HEAD commit and aborts the amend when declined', async () => {
      // IntelliJ's GitCommitEditingActionBase.checkCommitsCanBeEdited gates
      // reword on the commit's containing branches regardless of whether it is
      // the topmost commit — amending a pushed HEAD commit also rewrites
      // published history and needs a force-push. The parity-flavoured guard
      // must therefore fire on the HEAD (git commit --amend) path too, not
      // only on the non-HEAD rebase path. Declining must NOT amend.
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('rewritten message');
      const messages = createMessageTrackers();
      const repo = createMockRepo(testHash); // HEAD === selected commit
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old message\n', stderr: '', combined: '' };
          }
          // The HEAD commit IS on a remote-tracking branch — already pushed.
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: '  origin/main\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      assert.strictEqual(
        messages.warning.length,
        1,
        `expected exactly one warning, got ${messages.warning.length}`
      );
      assert.ok(
        /push/i.test(messages.warning[0].message),
        `warning should mention the commit was pushed, got: "${messages.warning[0].message}"`
      );
      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(!amendCall, 'git commit --amend must NOT run when the user declines the warning');
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a cancelled reword');
    });

    it('routes through provideRewordMessage when executeRebase pauses (regression: was leaving HEAD detached)', async () => {
      // Bug: editing a non-HEAD commit message dropped the local
      // branch onto a detached HEAD. Root cause: `git rebase -i` paused
      // at the reword step waiting for $GIT_EDITOR to provide the new
      // message, but only GIT_SEQUENCE_EDITOR was set. The rebase
      // metadata stayed in `.git/rebase-merge/` and HEAD detached at
      // the parent of the reword target.
      //
      // Fix: when executeRebase returns `{status:'paused'}`, route
      // through `provideRewordMessage` (which uses `git commit --amend
      // -m <msg>` followed by `git rebase --continue`) so the rebase
      // actually finishes and the branch ref updates.
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('updated message');
      createMessageTrackers();
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);

      let rewordCallCount = 0;
      let rewordMessageReceived: string | undefined;
      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({ success: true, status: 'paused' as const }),
        provideRewordMessage: async (_repo: IRepository, message: string) => {
          rewordCallCount++;
          rewordMessageReceived = message;
          return { success: true, status: 'completed' as const };
        },
      });
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return {
              exitCode: 0,
              stdout: 'old message\n',
              stderr: '',
              combined: '',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      assert.strictEqual(
        rewordCallCount,
        1,
        'provideRewordMessage MUST be called once when executeRebase pauses'
      );
      assert.strictEqual(
        rewordMessageReceived,
        'updated message',
        'provideRewordMessage MUST receive the new message the user typed'
      );
      const abortCall = rebaseService.calls.find((c) => c.method === 'abortRebase');
      assert.ok(
        !abortCall,
        'abortRebase MUST NOT be called on the happy paused-then-resolved path (would re-create the detached-HEAD bug)'
      );
    });

    it('aborts the rebase when provideRewordMessage hits a conflict', async () => {
      // Defensive companion to the paused-path test above. If the
      // post-paused continue produces conflicts, abort cleanly so
      // the user never sees a half-finished rebase with a detached
      // HEAD.
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('updated message');
      createMessageTrackers();
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);

      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({ success: true, status: 'paused' as const }),
        provideRewordMessage: async () => ({
          success: false,
          status: 'conflict' as const,
          conflictedFiles: ['src/foo.ts'],
          rebaseInProgress: true,
        }),
      });
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      const abortCall = rebaseService.calls.find((c) => c.method === 'abortRebase');
      assert.ok(
        abortCall,
        'abortRebase MUST be called when provideRewordMessage surfaces a conflict'
      );
    });

    it('does NOT claim "Updated commit message" when the reword self-cleared a stale session', async () => {
      // Transitive edge: provideRewordMessage delegates to continueRebase,
      // which can self-clear a phantom rebase session and return
      // {status:'cleared-stale'} — a no-op where no message was rewritten.
      // Surfacing the unconditional "Updated commit message for…" toast for
      // that case is the same misleading-success class the cleared-stale
      // status was introduced to kill. The consumer must report it honestly.
      const messages = createMessageTrackers();
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('updated message');
      const repo = createMockRepo('different_head_hash');
      const gitService = createMockGitService(repo);

      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({ success: true, status: 'paused' as const }),
        provideRewordMessage: async () => ({ success: true, status: 'cleared-stale' as const }),
      });
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old message\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      const updatedToast = messages.info.find((m) =>
        m.message.startsWith('Updated commit message')
      );
      assert.ok(
        !updatedToast,
        'MUST NOT show "Updated commit message for…" when the reword self-cleared a stale session'
      );
      const honestToast = messages.info.find((m) => /stale session/i.test(m.message));
      assert.ok(
        honestToast,
        'SHOULD surface an honest "cleared a stale session" message instead of a false success'
      );
    });

    it('does nothing when user cancels input', async () => {
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve(undefined);
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'startInteractiveRebase should NOT have been called when user cancels');
      assert.strictEqual(provider.refreshCallCount, 0);
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('new message');
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => {
          throw new Error('rebase failed');
        },
      });
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('rebase failed'));
    });

    it('HEAD: amends successfully even with dirty working tree (no stash needed)', async () => {
      const execCalls: string[][] = [];
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('amended msg');
      const messages = createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          execCalls.push(cmdArgs);
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old msg\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      // Should NOT call status or stash — HEAD amend skips all that
      const statusCall = execCalls.find((c) => c[0] === 'status');
      assert.ok(!statusCall, 'should not check status for HEAD amend');
      const stashCall = execCalls.find((c) => c[0] === 'stash');
      assert.ok(!stashCall, 'should not stash for HEAD amend');

      // Should amend
      const amendCall = execCalls.find((c) => c[0] === 'commit' && c.includes('--amend'));
      assert.ok(amendCall, 'should call git commit --amend');
      assert.ok(amendCall.includes('amended msg'));
      assert.strictEqual(messages.info.length, 1);
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('HEAD: amends successfully even with unmerged files', async () => {
      const execCalls: string[][] = [];
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('amended with conflicts');
      const messages = createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          execCalls.push(cmdArgs);
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      const amendCall = execCalls.find((c) => c[0] === 'commit' && c.includes('--amend'));
      assert.ok(amendCall, 'should amend even with unmerged files');
      assert.strictEqual(messages.info.length, 1);
    });

    it('non-HEAD: blocks when there are unmerged files', async () => {
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve('new msg');
      const messages = createMessageTrackers();
      const repo = createMockRepo('different_head');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old\n', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: 'UU src/conflict.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('unmerged'));
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'rebase should NOT start with unmerged files');
    });

    it('non-HEAD: skips stash when working tree is clean', async () => {
      const execCalls: string[][] = [];
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('clean edit');
      createMessageTrackers();
      const repo = createMockRepo('different_head');
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          execCalls.push(cmdArgs);
          if (cmdArgs[0] === 'log' && cmdArgs.includes('--format=%B')) {
            return { exitCode: 0, stdout: 'old\n', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('editCommitMessage', [testHash]);

      const stashCall = execCalls.find((c) => c[0] === 'stash');
      assert.ok(!stashCall, 'should not stash when working tree is clean');
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'rebase should proceed');
    });
  });

  describe('_handleMergeIntoCurrent', () => {
    it('calls gitService.mergeBranch with the hash', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('mergeIntoCurrent', [testHash]);

      const call = gitService.calls.find((c) => c.method === 'mergeBranch');
      assert.ok(call, 'mergeBranch should have been called');
      assert.strictEqual(call.args[1], testHash);
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('shows warning on merge conflicts', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        mergeBranch: async () => ({
          success: false,
          conflicts: ['file1.ts', 'file2.ts', 'file3.ts'],
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('mergeIntoCurrent', [testHash]);

      assert.strictEqual(messages.warning.length, 1);
      assert.ok(messages.warning[0].message.includes('3 file(s)'));
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        mergeBranch: async () => {
          throw new Error('merge failed');
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('mergeIntoCurrent', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('merge failed'));
    });
  });

  // ─── interactiveRebase ────────────────────────────────────────────────────

  describe('_handleInteractiveRebase', () => {
    it('calls rebaseService.startInteractiveRebase with the hash', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('interactiveRebase', [testHash]);

      const call = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(call, 'startInteractiveRebase should have been called');
      assert.strictEqual(call.args[1], testHash);
      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => {
          throw new Error('rebase failed');
        },
      });
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('interactiveRebase', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('rebase failed'));
    });
  });

  // ─── Unknown action ───────────────────────────────────────────────────────

  describe('unknown action', () => {
    it('does nothing for unknown actions', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      // Deliberately passing an invalid action string to exercise the default
      // branch of the dispatch switch — we cast through `unknown` so the test
      // can assert runtime behaviour without inventing a new union member.
      await commands._handleAction('unknownAction' as unknown as LogContextAction, [testHash]);

      assert.strictEqual(messages.info.length, 0);
      assert.strictEqual(messages.error.length, 0);
      assert.strictEqual(messages.warning.length, 0);
      assert.strictEqual(provider.refreshCallCount, 0);
    });
  });

  // Every CommitContextMenuCommands action-path catch
  // block must run the raw git stderr through `sanitizeGitError`. This
  // file has 12 such sites (cherryPick / revert / undo / drop / edit
  // commit message / etc.) — instead of a per-site spec we pin the bug
  // class on a representative call (`_handleCherryPick` reaches the
  // ${errorMessage} template at line 408). The other 11 sites share
  // the identical pattern.
  describe('TL-72 — error toast sanitization (representative)', () => {
    it('_handleCherryPick sanitizes credentialed URL + home path in error toast', async () => {
      const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        cherryPick: async () => {
          throw new Error(RAW);
        },
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('cherryPick', [testHash]);

      assert.strictEqual(messages.error.length, 1, 'expected one error toast');
      assert.strictEqual(messages.error[0].message, `Failed to cherry-pick: ${EXPECTED}`);
      assert.ok(
        !messages.error[0].message.includes('alice:secret'),
        'toast must not leak credentials'
      );
      assert.ok(
        !messages.error[0].message.includes('/Users/alice'),
        'toast must not leak home path'
      );
    });
  });

  // ─── Squash with Previous + Fixup with Previous ───────────

  describe('_handleSquashWithPrevious (Wave K WK-1)', () => {
    const childHash = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const parentHash = 'bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    it('squashWithPrev-1: rejects root commit (parents.length === 0)', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: childHash,
          shortHash: childHash.substring(0, 7),
          message: 'root',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('squashWithPrevious' as LogContextAction, [childHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.toLowerCase().includes('root commit'),
        `expected root-commit error; got: ${messages.error[0].message}`
      );
      // No rebase started.
      assert.strictEqual(
        rebaseService.calls.filter((c) => c.method === 'startInteractiveRebase').length,
        0
      );
    });

    it('squashWithPrev-2: rejects merge commit (parents.length >= 2)', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: childHash,
          shortHash: childHash.substring(0, 7),
          message: 'merge',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [parentHash, 'ccc1234567890cccccccccccccccccccccccccccc'],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('squashWithPrevious' as LogContextAction, [childHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.toLowerCase().includes('merge commit'),
        `expected merge-commit error; got: ${messages.error[0].message}`
      );
      assert.strictEqual(
        rebaseService.calls.filter((c) => c.method === 'startInteractiveRebase').length,
        0
      );
    });

    it('squashWithPrev-3: happy path delegates to _handleSquashCommits with [hash, parentHash]', async () => {
      // Force the squash-message editor to fall back to showInputBox by
      // making `openTextDocument` reject — `_promptForSquashMessage` then
      // routes to `_squashMessageInputBoxFallback` which uses showInputBox.
      const ws = (await import('../../mocks/vscode')).workspace as unknown as Record<
        string,
        unknown
      >;
      const origOpenTextDoc = ws.openTextDocument;
      ws.openTextDocument = (): Promise<unknown> => Promise.reject(new Error('forced fallback'));
      writableWindow().showInputBox = (): Promise<string | undefined> =>
        Promise.resolve('combined message');
      const messages = createMessageTrackers();
      const repo = createMockRepo(childHash);
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: childHash,
          shortHash: childHash.substring(0, 7),
          message: 'child msg',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [parentHash],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async (...args: unknown[]) => {
          rebaseService.calls.push({ method: 'startInteractiveRebase', args });
          return {
            onto: 'parent',
            originalBranch: 'main',
            commits: [
              { hash: parentHash, message: 'parent', action: 'pick' as const },
              { hash: childHash, message: 'child msg', action: 'pick' as const },
            ],
            currentStep: 0,
            status: 'planning' as const,
          };
        },
      });
      const provider = createMockProvider();
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      try {
        await commands._handleAction('squashWithPrevious' as LogContextAction, [childHash]);

        // Expect a rebase to have been started — proves the synthesised
        // 2-commit selection routed through `_handleSquashCommits`.
        assert.strictEqual(
          rebaseService.calls.filter((c) => c.method === 'startInteractiveRebase').length,
          1,
          `expected startInteractiveRebase to fire once; rebase calls: ${JSON.stringify(rebaseService.calls.map((c) => c.method))}`
        );
        // No error toast.
        assert.strictEqual(
          messages.error.length,
          0,
          `expected no error; got: ${messages.error.map((e) => e.message).join('; ')}`
        );
      } finally {
        ws.openTextDocument = origOpenTextDoc;
      }
    });
  });

  describe('_handleFixupWithPrevious (Wave K WK-1)', () => {
    const childHash = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const parentHash = 'bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    it('fixupWithPrev-1: rejects root commit (parents.length === 0)', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: childHash,
          shortHash: childHash.substring(0, 7),
          message: 'root',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('fixupWithPrevious' as LogContextAction, [childHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.toLowerCase().includes('root commit'),
        `expected root-commit error; got: ${messages.error[0].message}`
      );
    });

    it('fixupWithPrev-2: rejects merge commit', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: childHash,
          shortHash: childHash.substring(0, 7),
          message: 'merge',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [parentHash, 'ccc1234567890cccccccccccccccccccccccccccc'],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('fixupWithPrevious' as LogContextAction, [childHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.toLowerCase().includes('merge commit'),
        `expected merge-commit error; got: ${messages.error[0].message}`
      );
    });

    it('fixupWithPrev-3: happy path skips message editor and reuses parent message', async () => {
      // Stub showInputBox to a sentinel — fixup MUST NOT call it. If it
      // does, the rebase will receive 'editor-was-called' as the squash
      // message, which we'd see in provideSquashMessage call args.
      let inputBoxCalled = false;
      writableWindow().showInputBox = (): Promise<string | undefined> => {
        inputBoxCalled = true;
        return Promise.resolve('editor-was-called');
      };
      const messages = createMessageTrackers();
      const repo = createMockRepo(childHash);
      const gitService = createMockGitService(repo, {
        getCommit: async (_repo: IRepository, h: string) => {
          if (h === childHash) {
            return {
              hash: childHash,
              shortHash: childHash.substring(0, 7),
              message: 'child msg',
              author: { name: '', email: '' },
              committer: { name: '', email: '' },
              parents: [parentHash],
              authorDate: new Date(),
              commitDate: new Date(),
            };
          }
          return {
            hash: parentHash,
            shortHash: parentHash.substring(0, 7),
            message: 'parent msg',
            author: { name: '', email: '' },
            committer: { name: '', email: '' },
            parents: [],
            authorDate: new Date(),
            commitDate: new Date(),
          };
        },
      });
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async (...args: unknown[]) => {
          rebaseService.calls.push({ method: 'startInteractiveRebase', args });
          return {
            onto: 'parent',
            originalBranch: 'main',
            commits: [
              { hash: parentHash, message: 'parent msg', action: 'pick' as const },
              { hash: childHash, message: 'child msg', action: 'pick' as const },
            ],
            currentStep: 0,
            status: 'planning' as const,
          };
        },
      });
      const provider = createMockProvider();
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('fixupWithPrevious' as LogContextAction, [childHash]);

      assert.strictEqual(inputBoxCalled, false, 'fixup must NOT prompt for a message');
      // Rebase started (proves the path executed).
      assert.strictEqual(
        rebaseService.calls.filter((c) => c.method === 'startInteractiveRebase').length,
        1
      );
      assert.strictEqual(
        messages.error.length,
        0,
        `unexpected error: ${messages.error.map((e) => e.message).join('; ')}`
      );
    });
  });

  // ─── Compare with Branch ──────────────────────────────────

  describe('_handleCompareWithBranch (Wave K WK-2)', () => {
    const hash = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    function createMockBranchComparisonView(): {
      show: (...args: unknown[]) => Promise<{ compared: boolean }>;
      calls: CallTracker[];
    } {
      const calls: CallTracker[] = [];
      return {
        calls,
        show: async (...args: unknown[]): Promise<{ compared: boolean }> => {
          calls.push({ method: 'show', args });
          return { compared: true };
        },
      };
    }

    it('compareWithBranch-1: picker shows local + remote branches + tags grouped by Separator', async () => {
      const seenItems: vscode.QuickPickItem[] = [];
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> => {
        const arr = Array.isArray(items) ? (items as vscode.QuickPickItem[]) : [];
        for (const it of arr) {
          seenItems.push(it);
        }
        return Promise.resolve(undefined); // user cancels
      };
      createMessageTrackers();
      const repo = createMockRepo(hash);
      const gitService = createMockGitService(repo, {
        getBranches: async () => [
          { name: 'main', type: 'local', commit: 'aaa', isHead: true },
          { name: 'origin/main', type: 'remote', commit: 'aaa', isHead: false },
        ],
        getTags: async () => [
          {
            name: 'v1.0',
            commit: 'aaa',
            isAnnotated: true,
          },
        ],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      const view = createMockBranchComparisonView();
      commands.setBranchComparisonView(view as unknown as BranchComparisonView);

      await commands._handleAction('compareWithBranch' as LogContextAction, [hash]);

      // Three separators: Local / Remote / Tags.
      const separatorCount = seenItems.filter(
        (i) => i.kind === (1 as unknown as vscode.QuickPickItemKind) // Separator value
      ).length;
      // Use the actual enum value (Separator = -1 in vscode.d.ts).
      // Just count items whose label is one of the headers.
      const headerLabels = seenItems
        .map((i) => i.label)
        .filter((l) => l === 'Local' || l === 'Remote' || l === 'Tags');
      assert.deepStrictEqual(headerLabels, ['Local', 'Remote', 'Tags']);
      // The non-separator items include all three refs.
      const refLabels = seenItems.map((i) => i.label);
      // Both local and remote refs use the same git-branch icon now
      // (per UX request to drop the cloud-vs-branch distinction).
      assert.ok(refLabels.some((l) => l.includes('main') && l.includes('git-branch')));
      assert.ok(refLabels.some((l) => l.includes('origin/main') && l.includes('git-branch')));
      assert.ok(refLabels.some((l) => l.includes('v1.0') && l.includes('tag')));
      // Suppress unused-var lint on separatorCount
      void separatorCount;
    });

    it('compareWithBranch-2: selection routes to BranchComparisonView.show with the picked ref', async () => {
      const view = createMockBranchComparisonView();
      writableWindow().showQuickPick = (): Promise<unknown> =>
        Promise.resolve({ ref: 'origin/main', label: '$(git-branch) origin/main' });
      createMessageTrackers();
      const repo = createMockRepo(hash);
      const gitService = createMockGitService(repo, {
        getBranches: async () => [
          { name: 'origin/main', type: 'remote', commit: 'aaa', isHead: false },
        ],
        getTags: async () => [],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      commands.setBranchComparisonView(view as unknown as BranchComparisonView);

      await commands._handleAction('compareWithBranch' as LogContextAction, [hash]);

      assert.strictEqual(view.calls.length, 1, 'BranchComparisonView.show must be called');
      const args = view.calls[0].args;
      // Signature: show(repo, branch1, branch2)
      assert.strictEqual(args[1], hash);
      assert.strictEqual(args[2], 'origin/main');
    });

    it('compareWithBranch-empty-1: empty refs list shows informational toast and skips picker', async () => {
      let pickerCalled = false;
      writableWindow().showQuickPick = (): Promise<unknown> => {
        pickerCalled = true;
        return Promise.resolve(undefined);
      };
      const messages = createMessageTrackers();
      const repo = createMockRepo(hash);
      const gitService = createMockGitService(repo, {
        getBranches: async () => [],
        getTags: async () => [],
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      const view = createMockBranchComparisonView();
      commands.setBranchComparisonView(view as unknown as BranchComparisonView);

      await commands._handleAction('compareWithBranch' as LogContextAction, [hash]);

      assert.strictEqual(pickerCalled, false, 'picker must not show with no refs available');
      assert.strictEqual(messages.info.length, 1);
      assert.ok(messages.info[0].message.toLowerCase().includes('no branches'));
    });
  });

  // Regression suite for the repo-inference fix. Edit Commit Message
  // / Squash Commits / etc. must NOT pop a "Choose Repository"
  // QuickPick when the user is staring at a specific repo's log in
  // the Git tool window. The dropdown selection is the source of
  // truth.
  describe('_getRepository — uses GitToolWindowProvider.getSelectedRepository (Bug 6.1)', () => {
    it('routes through getSelectedRepository when the provider exposes it', async () => {
      const dropdownRepo = createMockRepo('dropdown_head_hash');
      const fallbackRepo = createMockRepo('fallback_head_hash');
      // Make the active-editor fallback resolve to a DIFFERENT repo so
      // we can prove the dropdown wins over the fallback chain.
      const gitService = createMockGitService(fallbackRepo);
      const rebaseService = createMockRebaseService();
      const provider = {
        ...createMockProvider(),
        getSelectedRepository: () => dropdownRepo,
      } as unknown as GitToolWindowProvider & { refreshCallCount: number };
      const gitCli = createMockGitCli({
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      // Drive a handler that calls _getRepository under the hood.
      // copyHash is the cheapest path that hits _getRepository.
      writableEnv().clipboard = {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(''),
      };
      createMessageTrackers();
      await commands._handleAction('copyHash', [testHash]);

      // No QuickPick should have fired (we're in a single-repo mock
      // anyway, but the assertion is structural: the dropdown must
      // have been consulted first). Reach in and verify the dropdown
      // path was taken by injecting a sentinel-only spy:
      let dropdownConsulted = false;
      const spyProvider = {
        ...createMockProvider(),
        getSelectedRepository: () => {
          dropdownConsulted = true;
          return dropdownRepo;
        },
      } as unknown as GitToolWindowProvider & { refreshCallCount: number };
      const spyCommands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        spyProvider,
        gitCli
      );
      const internals = spyCommands as unknown as {
        _getRepository: () => Promise<IRepository | undefined>;
      };
      const resolved = await internals._getRepository();
      assert.strictEqual(
        dropdownConsulted,
        true,
        'getSelectedRepository must be consulted before any fallback'
      );
      assert.strictEqual(
        resolved,
        dropdownRepo,
        'when dropdown returns a repo, _getRepository must return it'
      );
    });

    it('falls back to resolveRepo when getSelectedRepository returns undefined', async () => {
      // The dropdown returns undefined (no repo currently selected, or
      // single-window stub). The handler must fall through to
      // resolveRepo so palette / scripted callers without a tool-window
      // provider still work.
      const fallbackRepo = createMockRepo('fallback_head_hash');
      const gitService = createMockGitService(fallbackRepo);
      const rebaseService = createMockRebaseService();
      const provider = {
        ...createMockProvider(),
        getSelectedRepository: () => undefined,
      } as unknown as GitToolWindowProvider & { refreshCallCount: number };
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      const internals = commands as unknown as {
        _getRepository: () => Promise<IRepository | undefined>;
      };
      const resolved = await internals._getRepository();
      assert.strictEqual(
        resolved,
        fallbackRepo,
        'when dropdown returns undefined, resolveRepo fallback must run'
      );
    });

    it('falls back to resolveRepo when the provider does not expose getSelectedRepository (legacy stubs)', async () => {
      // Some test harnesses construct partial provider stubs that omit
      // getSelectedRepository. Those callers must keep working without
      // throwing.
      const fallbackRepo = createMockRepo('fallback_head_hash');
      const gitService = createMockGitService(fallbackRepo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider(); // no getSelectedRepository on the stub
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      const internals = commands as unknown as {
        _getRepository: () => Promise<IRepository | undefined>;
      };
      const resolved = await internals._getRepository();
      assert.strictEqual(
        resolved,
        fallbackRepo,
        'partial provider stubs must not break _getRepository'
      );
    });
  });
});
