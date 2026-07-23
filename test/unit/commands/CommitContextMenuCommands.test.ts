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
import { okAsync, errAsync } from 'neverthrow';
import { SpawnFailedError } from '../../../src/git-core/errors';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../src/commits/CommitContextMenuCommands';
import {
  findProtectedRemoteBranch,
  type ICommitGuardsContext,
} from '../../../src/commits/commitActionGuards';
import type { GitCli } from '../../../src/git-core/gitCli';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import {
  IRebaseAction,
  IRebaseService,
  IRebaseSession,
} from '../../../src/git-core/interfaces/IRebaseService';
import {
  GitToolWindowProvider,
  LogContextAction,
} from '../../../src/ui-shell/GitToolWindowProvider';
import type { BranchComparisonView } from '../../../src/branches/BranchComparisonView';
import { EventEmitter, Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import { writableWindow, writableEnv, writableCommands } from '../../typed/windowStub';
import {
  installMessageEditorStubs,
  type MessageEditorTracker,
} from '../../typed/messageEditorStub';
import { CommitMessageDialog } from '../../../src/commits/CommitMessageDialog';
import { CommitDialog } from '../../../src/commits/CommitDialog';
import { makeExtensionContext } from '../../helpers/mockWebviewContext';

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
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
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
    fetch: () => {
      return okAsync(undefined);
    },
    pull: () => okAsync(undefined),
    push: () => okAsync(undefined),
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
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
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
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
    clearSession: (...args: unknown[]) => {
      calls.push({ method: 'clearSession', args });
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
type MockGitCli = import('../../../src/git-core/gitCli').GitCli & { calls: CallTracker[] };

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
    getVersion: () => okAsync('2.40.0'),
    isRepository: () => okAsync(true),
    getRepositoryRoot: () => okAsync('/test-repo'),
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

/**
 * Scripted answers for the pinned-stash save/restore protocol
 * (preservedChanges): `rev-parse refs/stash` returns the created entry's sha
 * and `stash list --format=…` lists it at the top, so a bracket's restore
 * finds and pops exactly the entry it created.
 */
const PINNED_STASH_SHA = 'f'.repeat(40);
function pinnedStashResponse(
  cmdArgs: string[]
): { exitCode: number; stdout: string; stderr: string; combined: string } | undefined {
  if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'refs/stash') {
    return { exitCode: 0, stdout: `${PINNED_STASH_SHA}\n`, stderr: '', combined: '' };
  }
  if (cmdArgs[0] === 'stash' && cmdArgs[1] === 'list') {
    const out = `stash@{0}\x1f${PINNED_STASH_SHA}\n`;
    return { exitCode: 0, stdout: out, stderr: '', combined: out };
  }
  return undefined;
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

/**
 * Like {@link createMessageTrackers} but auto-accepts the destructive-op
 * confirm modal (the one offering a `Drop` action) so drop-handler tests can
 * drive past the confirm while still recording any subsequent warnings.
 */
function createMessageTrackersAcceptingDrop(): {
  info: MessageRecord[];
  error: MessageRecord[];
  warning: MessageRecord[];
} {
  const trackers = createMessageTrackers();
  writableWindow().showWarningMessage = (
    message: string,
    ...items: unknown[]
  ): Promise<string | undefined> => {
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    // Auto-accept (and swallow) the destructive-op confirm modal so it
    // doesn't count as a user-facing warning toast; record everything else.
    if (stringItems.includes('Drop')) {
      return Promise.resolve('Drop');
    }
    trackers.warning.push({ message, items: stringItems });
    return Promise.resolve(undefined);
  };
  return trackers;
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
        cherryPick: () => okAsync({ success: false, conflicts: ['file1.ts', 'file2.ts'] }),
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
        cherryPick: () => errAsync(new SpawnFailedError('cherry-pick failed')),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('cherryPick', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('cherry-pick failed'));
    });

    // ─── "(cherry picked from ...)" suffix (IntelliJ -x for published commits,
    //     CherryPickProcess.kt shouldAddSuffix: setting && isCommitPublished) ──

    /** GitCli whose remote-containment probe reports the given branches. */
    function makeContainmentGitCli(remoteBranches: string): MockGitCli {
      return createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: remoteBranches, stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
    }

    describe('cherry-picked-from suffix (published commits only, default on)', () => {
      afterEach(() => resetMockConfiguration());

      it('passes addCherryPickedFrom for a published commit (schema default on)', async () => {
        createMessageTrackers();
        const repo = createMockRepo();
        const gitService = createMockGitService(repo);
        const commands = new CommitContextMenuCommands(
          gitService,
          createMockRebaseService(),
          createMockProvider(),
          makeContainmentGitCli('  origin/feature\n')
        );

        await commands._handleAction('cherryPick', [testHash]);

        const call = gitService.calls.find((c) => c.method === 'cherryPick');
        assert.ok(call, 'cherryPick should have been called');
        const options = call.args[2] as { addCherryPickedFrom?: boolean } | undefined;
        assert.strictEqual(
          options?.addCherryPickedFrom,
          true,
          `a published commit must carry the -x suffix by default; got options ${JSON.stringify(options)}`
        );
      });

      it('omits the suffix for an unpublished commit', async () => {
        createMessageTrackers();
        const repo = createMockRepo();
        const gitService = createMockGitService(repo);
        const commands = new CommitContextMenuCommands(
          gitService,
          createMockRebaseService(),
          createMockProvider(),
          makeContainmentGitCli('')
        );

        await commands._handleAction('cherryPick', [testHash]);

        const call = gitService.calls.find((c) => c.method === 'cherryPick');
        assert.ok(call, 'cherryPick should have been called');
        const options = call.args[2] as { addCherryPickedFrom?: boolean } | undefined;
        assert.ok(
          !options?.addCherryPickedFrom,
          `an unpublished commit must not be annotated; got options ${JSON.stringify(options)}`
        );
      });

      it('omits the suffix when intellig.addCherryPickedFromSuffix is off', async () => {
        createMessageTrackers();
        setMockConfigValue('intellig', 'addCherryPickedFromSuffix', false);
        const repo = createMockRepo();
        const gitService = createMockGitService(repo);
        const commands = new CommitContextMenuCommands(
          gitService,
          createMockRebaseService(),
          createMockProvider(),
          makeContainmentGitCli('  origin/feature\n')
        );

        await commands._handleAction('cherryPick', [testHash]);

        const call = gitService.calls.find((c) => c.method === 'cherryPick');
        assert.ok(call, 'cherryPick should have been called');
        const options = call.args[2] as { addCherryPickedFrom?: boolean } | undefined;
        assert.ok(
          !options?.addCherryPickedFrom,
          `the setting must gate the suffix; got options ${JSON.stringify(options)}`
        );
      });
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
        revert: () => okAsync({ success: false, conflicts: ['file1.ts'] }),
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
        revert: () => errAsync(new SpawnFailedError('revert failed')),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('revert', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('revert failed'));
    });

    it('surfaces the staged-leftover note when the custom-message commit fails', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        revert: () =>
          okAsync({
            success: false,
            conflicts: [],
            stagedChangesRemain: true,
            failureReason: 'nothing to commit, working tree clean',
          }),
      });
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('revert', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        messages.error[0].message.includes('staged but not committed'),
        `error must warn about the staged-but-uncommitted revert; got: ${messages.error[0].message}`
      );
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
        checkout: () => errAsync(new SpawnFailedError('checkout failed')),
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

  // ─── createPatchToClipboard ───────────────────────────────────────────────

  describe('_handleCreatePatchToClipboard', () => {
    it('single commit — copies format-patch stdout to the clipboard, no save dialog', async () => {
      let copiedText = '';
      writableEnv().clipboard = {
        writeText: (text: string): Promise<void> => {
          copiedText = text;
          return Promise.resolve();
        },
        readText: (): Promise<string> => Promise.resolve(''),
      };
      let saveDialogCalls = 0;
      writableWindow().showSaveDialog = (): Promise<vscode.Uri | undefined> => {
        saveDialogCalls++;
        return Promise.resolve(undefined);
      };
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatchToClipboard', [testHash]);

      const call = gitCli.calls.find((c: CallTracker) => c.method === 'exec');
      assert.ok(call, 'gitCli.exec should have been called');
      const args = call.args[0] as string[];
      assert.ok(
        args.includes('format-patch'),
        `expected format-patch argv, got ${JSON.stringify(args)}`
      );
      assert.ok(args.includes('--stdout'));
      assert.ok(args.includes(testHash));
      assert.strictEqual(copiedText, 'patch content');
      assert.strictEqual(saveDialogCalls, 0, 'the silent clipboard variant never opens a dialog');
      assert.strictEqual(messages.info.length, 1);
      assert.ok(
        messages.info[0].message.toLowerCase().includes('clipboard'),
        `toast should mention the clipboard, got: "${messages.info[0].message}"`
      );
    });

    it('does nothing with empty commit hashes', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatchToClipboard', []);

      assert.strictEqual(messages.info.length, 0);
      assert.strictEqual(gitCli.calls.length, 0);
    });

    it('surfaces a sanitized error toast on git failure; clipboard untouched', async () => {
      let clipboardWrites = 0;
      writableEnv().clipboard = {
        writeText: (): Promise<void> => {
          clipboardWrites++;
          return Promise.resolve();
        },
        readText: (): Promise<string> => Promise.resolve(''),
      };
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

      await commands._handleAction('createPatchToClipboard', [testHash]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('format-patch failed'));
      assert.strictEqual(clipboardWrites, 0, 'no clipboard write after a git failure');
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
    // Note: `test/mocks/vscode.ts::Uri.parse` stores the whole raw
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

      // The protected-branch probe runs first; find the reset itself.
      const call = gitCli.calls.find(
        (c: CallTracker) => c.method === 'exec' && (c.args[0] as string[])[0] === 'reset'
      );
      assert.ok(call, 'git reset should have been called');
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

    it('refuses undoing a HEAD commit contained in a protected remote branch', async () => {
      // IntelliJ's GitUncommitAction rides the same base gates as the other
      // commit-editing actions — a commit on a protected remote branch
      // (findProtectedRemoteBranch) cannot be uncommitted. The refusal names
      // the branch and runs no reset.
      const messages = createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
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

      await commands._handleAction('undoCommit', [testHash]);

      assert.ok(
        messages.error.some((e) => e.message.includes('origin/main')),
        `expected a refusal naming the protected branch; got ${JSON.stringify(
          messages.error.map((e) => e.message)
        )}`
      );
      const resetCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'reset';
      });
      assert.ok(!resetCall, 'git reset must NOT run for a protected commit');
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a refused undo');
    });

    it('undoes a HEAD commit that is pushed only to an unprotected remote branch', async () => {
      createMessageTrackers();
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          gitCli.calls.push({ method: 'exec', args });
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: '  origin/feature\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [testHash]);

      const resetCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'reset';
      });
      assert.ok(resetCall, 'git reset --soft must run for an unprotected commit');
    });

    // ─── target-changelist chooser (IntelliJ GitUncommitAction.java:60-68:
    //     a ChangeListChooser with the commit subject as the suggested name
    //     picks where the uncommitted changes land) ────────────────────────
    describe('target-changelist chooser', () => {
      interface ChangelistCalls {
        created: string[];
        moved: { files: string[]; changelistId: string }[];
      }

      function makeChangelistService(calls: ChangelistCalls): unknown {
        return {
          getChangelists: () => [
            { id: 'default-id', name: 'Changes', isDefault: true, isActive: true, files: [] },
            { id: 'other-id', name: 'Other work', isDefault: false, isActive: false, files: [] },
          ],
          createChangelist: (_repo: IRepository, name: string) => {
            calls.created.push(name);
            return { id: `new-${name}`, name, isDefault: false, isActive: false, files: [] };
          },
          moveToChangelist: (_repo: IRepository, files: string[], changelistId: string) => {
            calls.moved.push({ files, changelistId });
          },
        };
      }

      function makeUndoHarness(picker: (items: unknown[]) => unknown): {
        commands: CommitContextMenuCommands;
        gitCli: MockGitCli;
        calls: ChangelistCalls;
      } {
        const repo = createMockRepo(testHash);
        const gitService = createMockGitService(repo, {
          getCommit: async () => ({
            hash: testHash,
            shortHash: testHash.substring(0, 7),
            message: 'Fix the widget\n\nlonger body',
            author: { name: 'a', email: 'a@x' },
            committer: { name: 'a', email: 'a@x' },
            parents: [],
            authorDate: new Date(0),
            commitDate: new Date(0),
          }),
          getCommitDiff: async () => [
            { path: 'w.ts', status: 'modified' as const, hunks: [], binary: false },
            { path: 'x.ts', status: 'added' as const, hunks: [], binary: false },
          ],
        });
        const gitCli = createMockGitCli();
        const commands = new CommitContextMenuCommands(
          gitService,
          createMockRebaseService(),
          createMockProvider(),
          gitCli
        );
        const calls: ChangelistCalls = { created: [], moved: [] };
        (commands as unknown as { setChangelistService(svc: unknown): void }).setChangelistService(
          makeChangelistService(calls)
        );
        writableWindow().showQuickPick = ((items: unknown[]) =>
          Promise.resolve(picker(items))) as never;
        return { commands, gitCli, calls };
      }

      it("offers a new changelist suggested from the commit subject; picking it creates + moves the commit's files", async () => {
        createMessageTrackers();
        const { commands, gitCli, calls } = makeUndoHarness((items) =>
          (items as { label: string }[]).find((i) => i.label.includes('Fix the widget'))
        );

        await commands._handleAction('undoCommit', [testHash]);

        const resetCall = gitCli.calls.find(
          (c: CallTracker) => c.method === 'exec' && (c.args[0] as string[])[0] === 'reset'
        );
        assert.ok(resetCall, 'the soft reset must run after the chooser');
        assert.deepStrictEqual(
          calls.created,
          ['Fix the widget'],
          'new changelist named after the subject'
        );
        assert.strictEqual(calls.moved.length, 1);
        assert.deepStrictEqual(calls.moved[0].files.sort(), ['w.ts', 'x.ts']);
        assert.strictEqual(calls.moved[0].changelistId, 'new-Fix the widget');
      });

      it('picking an existing changelist moves the files there without creating one', async () => {
        createMessageTrackers();
        const { commands, gitCli, calls } = makeUndoHarness((items) =>
          (items as { label: string }[]).find((i) => i.label.includes('Other work'))
        );

        await commands._handleAction('undoCommit', [testHash]);

        const resetCall = gitCli.calls.find(
          (c: CallTracker) => c.method === 'exec' && (c.args[0] as string[])[0] === 'reset'
        );
        assert.ok(resetCall, 'the soft reset must run');
        assert.deepStrictEqual(calls.created, [], 'no new changelist');
        assert.strictEqual(calls.moved.length, 1);
        assert.strictEqual(calls.moved[0].changelistId, 'other-id');
      });

      it('cancelling the chooser cancels the undo (no reset)', async () => {
        createMessageTrackers();
        const { commands, gitCli, calls } = makeUndoHarness(() => undefined);

        await commands._handleAction('undoCommit', [testHash]);

        const resetCall = gitCli.calls.find(
          (c: CallTracker) => c.method === 'exec' && (c.args[0] as string[])[0] === 'reset'
        );
        assert.ok(!resetCall, 'a cancelled chooser must not reset');
        assert.deepStrictEqual(calls.created, []);
        assert.deepStrictEqual(calls.moved, []);
      });
    });

    it('accepts an abbreviated hash that is a prefix of the full HEAD hash (prefix-match parity)', async () => {
      // Regression: the old exact-equality check `hash !== headHash` silently
      // rejected abbreviated 7-char hashes even when they matched HEAD.
      // The fix uses the same prefix-match as _handleEditCommitMessage so both
      // operations stay consistent.
      createMessageTrackers();
      // headHash is the full 40-char hash; abbrevHash is the first 7 chars
      const abbrevHash = testHash.slice(0, 7);
      const repo = createMockRepo(testHash); // HEAD = full hash
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('undoCommit', [abbrevHash]);

      const call = gitCli.calls.find(
        (c: CallTracker) => c.method === 'exec' && (c.args[0] as string[])[0] === 'reset'
      );
      assert.ok(call, 'git reset must be called when abbreviated hash matches HEAD via prefix');
      const args = call.args[0] as string[];
      assert.deepStrictEqual(args, ['reset', '--soft', 'HEAD~1']);
    });
  });

  // ─── dropCommit ───────────────────────────────────────────────────────────

  describe('_handleDropCommit', () => {
    it('starts interactive rebase with hash~1, sets drop action, and executes', async () => {
      createMessageTrackersAcceptingDrop();
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
      const messages = createMessageTrackersAcceptingDrop();
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
      const messages = createMessageTrackersAcceptingDrop();
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

    it('takes no manual stash on a dirty tree — the rebase runs with --autostash', async () => {
      // git owns save/restore of local changes via the autostash marker;
      // a manual bracket here would pop onto a mid-rebase tree if the
      // rebase pauses on conflict.
      const execCalls: string[][] = [];
      createMessageTrackersAcceptingDrop();
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

      assert.ok(
        !execCalls.some((c) => c[0] === 'stash'),
        `no manual stash may run; got: ${JSON.stringify(execCalls)}`
      );
      const execCall = rebaseService.calls.find((c) => c.method === 'executeRebase');
      assert.ok(execCall, 'the rebase must still run on a dirty (non-conflicted) tree');
    });

    it('blocks drop when there are unmerged files', async () => {
      const messages = createMessageTrackersAcceptingDrop();
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

  // ─── dropCommit: rebase result handling ──────────────────────────────────

  describe('_handleDropCommit — rebase result outcome branches', () => {
    it('shows no success toast and shows a paused warning when single-drop rebase is paused', async () => {
      // A paused rebase means history was NOT rewritten — showing "Dropped commit"
      // is misleading. The handler must show a warning to resume/abort manually.
      const messages = createMessageTrackersAcceptingDrop();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({ success: true, status: 'paused' as const }),
      });
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      await commands._handleAction('dropCommit', [testHash]);

      assert.strictEqual(messages.info.length, 0, 'no success toast when rebase is paused');
      assert.ok(
        messages.warning.some((w) => /resume|continue|abort/i.test(w.message)),
        `expected a "resume/continue/abort" warning, got: ${JSON.stringify(messages.warning)}`
      );
    });

    it('shows an error toast when single-drop rebase fails without conflicts', async () => {
      // Non-conflict rebase failure (e.g. bad permissions, git error) must surface
      // an error — not silently refresh as if the drop succeeded.
      const messages = createMessageTrackersAcceptingDrop();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService({
        executeRebase: async () => ({ success: false, status: 'in-progress' as const }),
      });
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      await commands._handleAction('dropCommit', [testHash]);

      assert.strictEqual(messages.info.length, 0, 'no success toast on failure');
      assert.ok(
        messages.error.some((e) => /drop|fail|rebase/i.test(e.message)),
        `expected an error toast, got: ${JSON.stringify(messages.error)}`
      );
    });

    it('shows no success toast and shows a paused warning when multi-drop rebase is paused', async () => {
      // Same contract as single-drop: a paused result must not show "Dropped N commits".
      const messages = createMessageTrackersAcceptingDrop();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const c1 = '1'.repeat(40);
      const c2 = '2'.repeat(40);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => ({
          onto: `${c2}^`,
          originalBranch: 'main',
          commits: [
            { hash: c1, message: 'newer', action: 'pick' as const },
            { hash: c2, message: 'older', action: 'pick' as const },
          ],
          currentStep: 0,
          status: 'planning' as const,
        }),
        executeRebase: async () => ({ success: true, status: 'paused' as const }),
      });
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      await commands._handleAction(
        'dropCommit',
        [c1, c2],
        [
          { hash: c1, parentCount: 1 },
          { hash: c2, parentCount: 1 },
        ]
      );

      assert.strictEqual(
        messages.info.length,
        0,
        'no success toast when multi-drop rebase is paused'
      );
      assert.ok(
        messages.warning.some((w) => /resume|continue|abort/i.test(w.message)),
        `expected a "resume/continue/abort" warning, got: ${JSON.stringify(messages.warning)}`
      );
    });

    it('shows an error toast when multi-drop rebase fails without conflicts', async () => {
      const messages = createMessageTrackersAcceptingDrop();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const c1 = '1'.repeat(40);
      const c2 = '2'.repeat(40);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => ({
          onto: `${c2}^`,
          originalBranch: 'main',
          commits: [
            { hash: c1, message: 'newer', action: 'pick' as const },
            { hash: c2, message: 'older', action: 'pick' as const },
          ],
          currentStep: 0,
          status: 'planning' as const,
        }),
        executeRebase: async () => ({ success: false, status: 'in-progress' as const }),
      });
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      await commands._handleAction(
        'dropCommit',
        [c1, c2],
        [
          { hash: c1, parentCount: 1 },
          { hash: c2, parentCount: 1 },
        ]
      );

      assert.strictEqual(messages.info.length, 0, 'no success toast on multi-drop failure');
      assert.ok(
        messages.error.some((e) => /drop|fail|rebase/i.test(e.message)),
        `expected an error toast, got: ${JSON.stringify(messages.error)}`
      );
    });
  });

  // ─── dropCommit: stale guard + dirty tree (R3-1) ────────────────────────

  describe('_handleDropMultipleCommits — stale guard unstash', () => {
    it('multi-drop stale guard fires before any stash or rebase, and clears the session', async () => {
      // The stale-selection guard (planDropCount < selectedSet.size) refuses
      // during plan-building — before executeRebase, so no autostash exists
      // and no manual stash is ever taken. Nothing to abort either: the
      // planning session is cleared truthfully.
      const stashCalls: string[] = [];
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            // Dirty (non-conflicted) tree.
            return { exitCode: 0, stdout: ' M file.ts', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'stash') {
            stashCalls.push(cmdArgs[1]);
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });

      const c1 = '1'.repeat(40);
      const c2 = '2'.repeat(40);
      // Session only contains c1 → planDropCount=1 < selectedSet.size=2 → stale guard fires.
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => ({
          onto: `${c2}^`,
          originalBranch: 'main',
          commits: [{ hash: c1, message: 'newer', action: 'pick' as const }],
          currentStep: 0,
          status: 'planning' as const,
        }),
      });

      createMessageTrackersAcceptingDrop();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      await commands._handleAction(
        'dropCommit',
        [c1, c2],
        [
          { hash: c1, parentCount: 1 },
          { hash: c2, parentCount: 1 },
        ]
      );

      assert.deepStrictEqual(
        stashCalls,
        [],
        'the stale guard fires before any stash exists — nothing may be pushed or popped'
      );
      assert.ok(
        !rebaseService.calls.find((c) => c.method === 'executeRebase'),
        'a stale plan must never execute'
      );
      assert.ok(
        !rebaseService.calls.find((c) => c.method === 'abortRebase'),
        'no rebase has started — nothing to abort'
      );
      assert.ok(
        rebaseService.calls.find((c) => c.method === 'clearSession'),
        'the planning session must be cleared'
      );
    });
  });

  // ─── editCommitMessage ────────────────────────────────────────────────────

  describe('_handleEditCommitMessage', () => {
    // Reword now opens the multi-line tempfile editor (no extension context in
    // these unit constructions, so it takes the editor fallback rather than the
    // webview dialog). Drive it via the shared editor-stub harness: kick off the
    // handler, wait for the editor to open, then simulate save/close.
    async function runReword(
      commands: CommitContextMenuCommands,
      hash: string,
      simulate: (e: MessageEditorTracker) => void
    ): Promise<MessageEditorTracker> {
      const editor = installMessageEditorStubs();
      let handlerDone = false;
      const handlerPromise = (
        commands as unknown as { _handleAction(a: string, h: string[]): Promise<void> }
      )
        ._handleAction('editCommitMessage', [hash])
        .finally(() => {
          handlerDone = true;
        });
      const deadline = Date.now() + 2000;
      while (!handlerDone && editor.openCalls === 0 && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
      }
      try {
        simulate(editor);
      } catch {
        // A pre-dialog gate refused the reword — the editor never opened, so
        // there is nothing to save. Refusal cases assert the refusal toast.
      }
      await handlerPromise;
      return editor;
    }

    // The PRIMARY production reword path: with an extension context, reword opens
    // the CommitMessageDialog webview (not the tempfile fallback). Stub the
    // dialog's prompt() so the test drives that branch without a real webview.
    async function runRewordViaDialog(
      commands: CommitContextMenuCommands,
      hash: string,
      resolved: string | undefined
    ): Promise<void> {
      (commands as unknown as { _context: unknown })._context = makeExtensionContext();
      const orig = CommitMessageDialog.prototype.prompt;
      CommitMessageDialog.prototype.prompt = function (): Promise<string | undefined> {
        // Single-shot resolve; dispose so the stubbed panel doesn't leak.
        (this as unknown as { dispose(): void }).dispose();
        return Promise.resolve(resolved);
      };
      try {
        await (
          commands as unknown as { _handleAction(a: string, h: string[]): Promise<void> }
        )._handleAction('editCommitMessage', [hash]);
      } finally {
        CommitMessageDialog.prototype.prompt = orig;
      }
    }

    it('uses the CommitMessageDialog webview when an extension context is present', async () => {
      createMessageTrackers();
      const repo = createMockRepo(testHash); // HEAD → amend path
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

      await runRewordViaDialog(commands, testHash, 'dialog-edited message');

      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(amendCall, 'git commit --amend should run with the dialog message');
      assert.ok((amendCall.args[0] as string[]).includes('dialog-edited message'));
    });

    it('aborts (no amend, no refresh) when the dialog is cancelled', async () => {
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

      await runRewordViaDialog(commands, testHash, undefined);

      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(!amendCall, 'a cancelled dialog must not amend');
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a cancelled reword');
    });

    it('uses git commit --amend for HEAD commit', async () => {
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

      await runReword(commands, testHash, (e) => e.simulateSave('updated message'));

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

    it('uses rebase reword for non-HEAD commit with no manual stash (--autostash owns the tree)', async () => {
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
          const pinned = pinnedStashResponse(cmdArgs);
          if (pinned) {
            return pinned;
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      const editor = await runReword(commands, testHash, (e) =>
        e.simulateSave('new commit message')
      );

      // Verify the editor was pre-filled with the full commit message
      assert.ok(
        (editor.lastSeed ?? '').includes('Full body of the commit message'),
        'Editor should be seeded with the full commit message'
      );

      // The dirty (non-conflicted) tree is git's to save: executeRebase
      // passes --autostash, so no manual stash may run.
      const stashCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'stash';
      });
      assert.ok(!stashCall, 'no manual stash may run — the rebase owns the tree via --autostash');

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

      assert.strictEqual(provider.refreshCallCount, 1);
    });

    it('refuses rewording a non-HEAD commit contained in a protected remote branch', async () => {
      // IntelliJ's GitCommitEditingActionBase.lastCheckCommitsEditingAvailability
      // blocks reword outright when the commit is contained in a protected
      // remote branch (findProtectedRemoteBranch). intellig.protectedBranches
      // defaults to ['main', 'master']; a commit on origin/main is refused —
      // no confirm, no dialog, no rebase.
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

      await runReword(commands, testHash, (e) => e.simulateSave('rewritten message'));

      // The refusal is an error toast NAMING the branch — not a confirm.
      assert.strictEqual(
        messages.warning.length,
        0,
        `no confirm may be offered for a protected commit; got ${JSON.stringify(
          messages.warning.map((w) => w.message)
        )}`
      );
      assert.ok(
        messages.error.some((e) => e.message.includes('origin/main')),
        `expected a refusal naming the protected branch; got ${JSON.stringify(
          messages.error.map((e) => e.message)
        )}`
      );
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'startInteractiveRebase must NOT run for a protected commit');
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a refused reword');
    });

    it('proceeds without any confirm when the pushed commit is NOT on a protected branch', async () => {
      // The old guard confirmed on pushed-ANYWHERE (stricter trigger, weaker
      // response). Reference-correct is the protected list: a commit only on
      // origin/feature rewords straight through.
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
          if (
            cmdArgs[0] === 'branch' &&
            cmdArgs.includes('--remotes') &&
            cmdArgs.includes('--contains')
          ) {
            return { exitCode: 0, stdout: '  origin/feature\n', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status' && cmdArgs.includes('--porcelain')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await runReword(commands, testHash, (e) => e.simulateSave('rewritten message'));

      assert.strictEqual(
        messages.warning.length,
        0,
        `unprotected published history rewords without a confirm; got ${JSON.stringify(
          messages.warning.map((w) => w.message)
        )}`
      );
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'startInteractiveRebase should run without any prompt');
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

    it('_isCommitPushed queries git for a 64-hex SHA-256 hash (guard must not fail open)', async () => {
      // A 40-hex cap silently returned "not pushed" for SHA-256 repos,
      // skipping the already-pushed warning before a history rewrite — the
      // OPPOSITE failure direction of the conservative exec-failure path.
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
      )._isCommitPushed('/test-repo', 'a'.repeat(64));

      const execCalls = gitCli.calls.filter((c) => c.method === 'exec');
      assert.strictEqual(execCalls.length, 1, 'a 64-hex object id must be probed via git');
      assert.strictEqual(typeof result, 'boolean');
    });

    // Characterization pins for guard-spine arms the handler-level tests
    // don't reach: the protected-branch symref-line parse, both fail-open
    // arms, and the probe-failure polarity. They lock behaviour across the
    // extraction of these guards into commitActionGuards.
    it('findProtectedRemoteBranch keeps the left name of an `origin/HEAD -> origin/main` symref line', async () => {
      // `git branch --remotes --contains` emits a symref line like
      // `origin/HEAD -> origin/main`; splitting on whitespace and keeping the
      // left token means the symref never false-matches and never shadows the
      // real `origin/main` line that follows.
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const gitCli = createMockGitCli({
        exec: async () => ({
          exitCode: 0,
          stdout: '  origin/HEAD -> origin/main\n  origin/main\n',
          stderr: '',
          combined: '',
        }),
      });
      const ctx: ICommitGuardsContext = {
        gitService,
        gitCli,
        readProtectedBranches: () => ['main', 'master'],
      };

      const result = await findProtectedRemoteBranch(ctx, '/test-repo', 'a'.repeat(40));

      assert.strictEqual(
        result,
        'origin/main',
        'the real protected branch matches; the symref line must not shadow it or false-match'
      );
    });

    it('findProtectedRemoteBranch degrades OPEN (undefined) when the probe exits non-zero', async () => {
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const gitCli = createMockGitCli({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fatal', combined: 'fatal' }),
      });
      const ctx: ICommitGuardsContext = {
        gitService,
        gitCli,
        readProtectedBranches: () => ['main', 'master'],
      };

      const result = await findProtectedRemoteBranch(ctx, '/test-repo', 'a'.repeat(40));

      assert.strictEqual(result, undefined, 'a broken probe must not block every rewrite');
    });

    it('findProtectedRemoteBranch degrades OPEN (undefined) when the probe throws', async () => {
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const gitCli = createMockGitCli({
        exec: async () => {
          throw new Error('spawn ENOENT');
        },
      });
      const ctx: ICommitGuardsContext = {
        gitService,
        gitCli,
        readProtectedBranches: () => ['main', 'master'],
      };

      const result = await findProtectedRemoteBranch(ctx, '/test-repo', 'a'.repeat(40));

      assert.strictEqual(result, undefined, 'a thrown probe must degrade open, not reject');
    });

    it('_isCommitPushed probe-failure polarity: default blocks (true), `-x` path reads not-pushed (false)', async () => {
      // isCommitPublished resolves a probe failure to probeFailureMeansPushed:
      // rewrite guards pass the default (true → conservative, assume pushed),
      // the cherry-pick `-x` suffix passes false (annotate only KNOWN-published).
      const repo = createMockRepo(testHash);
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fatal', combined: 'fatal' }),
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const cast = commands as unknown as {
        _isCommitPushed(
          cwd: string,
          hash: string,
          probeFailureMeansPushed?: boolean
        ): Promise<boolean>;
      };

      assert.strictEqual(
        await cast._isCommitPushed('/test-repo', 'a'.repeat(40)),
        true,
        'default true: a failed probe blocks the rewrite (assume pushed)'
      );
      assert.strictEqual(
        await cast._isCommitPushed('/test-repo', 'a'.repeat(40), false),
        false,
        'explicit false (-x provenance): a failed probe reads as not-pushed'
      );
    });

    it('refuses amending a HEAD commit contained in a protected remote branch', async () => {
      // IntelliJ's GitCommitEditingActionBase.checkCommitsCanBeEdited gates
      // reword on the commit's containing branches regardless of whether it is
      // the topmost commit — amending a protected HEAD commit also rewrites
      // published protected history. The gate must therefore fire on the HEAD
      // (git commit --amend) path too, not only on the non-HEAD rebase path.
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

      await runReword(commands, testHash, (e) => e.simulateSave('rewritten message'));

      assert.strictEqual(
        messages.warning.length,
        0,
        `no confirm may be offered for a protected commit; got ${JSON.stringify(
          messages.warning.map((w) => w.message)
        )}`
      );
      assert.ok(
        messages.error.some((e) => e.message.includes('origin/main')),
        `expected a refusal naming the protected branch; got ${JSON.stringify(
          messages.error.map((e) => e.message)
        )}`
      );
      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(!amendCall, 'git commit --amend must NOT run for a protected commit');
      assert.strictEqual(provider.refreshCallCount, 0, 'no refresh on a refused reword');
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

      await runReword(commands, testHash, (e) => e.simulateSave('updated message'));

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

    it('leaves the rebase paused when provideRewordMessage hits a conflict', async () => {
      // Companion to the paused-path test above. If the post-paused
      // continue produces conflicts, the rebase stays paused for the
      // resolve dialog — abort is user-initiated only (git4idea
      // GitRebaseProcess parity).
      const messages = createMessageTrackers();
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

      await runReword(commands, testHash, (e) => e.simulateSave('updated message'));

      const abortCall = rebaseService.calls.find((c) => c.method === 'abortRebase');
      assert.ok(
        !abortCall,
        'the conflicted rebase must stay paused — abort is user-initiated only'
      );
      assert.ok(
        messages.warning.some((w) => /conflict/i.test(w.message) && /resolve/i.test(w.message)),
        `expected the resolve-to-continue warning; got: ${JSON.stringify(messages.warning)}`
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

      await runReword(commands, testHash, (e) => e.simulateSave('updated message'));

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
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await runReword(commands, testHash, (e) => e.simulateClose());

      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'startInteractiveRebase should NOT have been called when user cancels');
      assert.strictEqual(provider.refreshCallCount, 0);
    });

    it('preserves a multi-line subject + body (does not collapse to a single subject)', async () => {
      // Regression: the single-line input box stored a whole subject+body
      // message as one subject line. The multi-line editor must carry the
      // newlines through to `git commit --amend -m <message>` verbatim.
      createMessageTrackers();
      const repo = createMockRepo(testHash); // HEAD commit → amend path
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

      const multiLine = 'New subject\n\nBody paragraph one.\nBody paragraph two.';
      await runReword(commands, testHash, (e) => e.simulateSave(multiLine));

      const amendCall = gitCli.calls.find((c: CallTracker) => {
        const a = c.args[0] as string[];
        return a[0] === 'commit' && a.includes('--amend');
      });
      assert.ok(amendCall, 'git commit --amend should have been called');
      const amendArgs = amendCall.args[0] as string[];
      assert.ok(
        amendArgs.includes(multiLine),
        'the full multi-line message (subject + blank line + body) must reach -m verbatim'
      );
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

      await runReword(commands, testHash, (e) => e.simulateSave('new message'));

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('rebase failed'));
    });

    it('HEAD: amends successfully even with dirty working tree (no stash needed)', async () => {
      const execCalls: string[][] = [];
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

      await runReword(commands, testHash, (e) => e.simulateSave('amended msg'));

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

      await runReword(commands, testHash, (e) => e.simulateSave('amended with conflicts'));

      const amendCall = execCalls.find((c) => c[0] === 'commit' && c.includes('--amend'));
      assert.ok(amendCall, 'should amend even with unmerged files');
      assert.strictEqual(messages.info.length, 1);
    });

    it('non-HEAD: blocks when there are unmerged files', async () => {
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

      await runReword(commands, testHash, (e) => e.simulateSave('new msg'));

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('unmerged'));
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(!startCall, 'rebase should NOT start with unmerged files');
    });

    it('non-HEAD: skips stash when working tree is clean', async () => {
      const execCalls: string[][] = [];
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

      await runReword(commands, testHash, (e) => e.simulateSave('clean edit'));

      const stashCall = execCalls.find((c) => c[0] === 'stash');
      assert.ok(!stashCall, 'should not stash when working tree is clean');
      const startCall = rebaseService.calls.find((c) => c.method === 'startInteractiveRebase');
      assert.ok(startCall, 'rebase should proceed');
    });
  });

  // ─── interactiveRebase ────────────────────────────────────────────────────

  describe('_handleInteractiveRebase', () => {
    const parentHash = 'f'.repeat(40);
    const clickedRow = { hash: testHash, parentCount: 1, parents: [parentHash] };

    it("opens the rebase EDITOR onto the clicked commit's parent (commit included in the plan)", async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      const opened: Array<{ repo: unknown; onto: string }> = [];
      commands.setRebaseEditorOpener(async (openRepo, onto) => {
        opened.push({ repo: openRepo, onto });
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(opened.length, 1, 'the editor must open');
      assert.strictEqual(
        opened[0].onto,
        parentHash,
        "the plan rebases onto the clicked commit's FIRST PARENT so the commit itself is in the todo"
      );
      assert.ok(
        !rebaseService.calls.some((c) => c.method === 'startInteractiveRebase'),
        'the handler must not start a headless planning session of its own'
      );
      assert.ok(
        !messages.info.some((m) => m.message.includes('Interactive rebase started')),
        'the editor IS the feedback — no dead-end toast'
      );
      assert.strictEqual(provider.refreshCallCount, 1, 'refresh after an executed rebase');
    });

    it('does not refresh when the editor is cancelled without executing', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      commands.setRebaseEditorOpener(async () => ({ executed: false }));

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(provider.refreshCallCount, 0);
    });

    it('refuses a root commit (nothing to rebase onto)', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction(
        'interactiveRebase',
        [testHash],
        [{ hash: testHash, parentCount: 0, parents: [] }]
      );

      assert.strictEqual(opened.length, 0, 'no editor for a parentless commit');
      assert.strictEqual(messages.warning.length, 1);
      assert.ok(messages.warning[0].message.includes('root commit'));
    });

    it('resolves the parent via git when the dispatch carries no row data', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = {
        exec: async (args: string[]) => {
          if (args[0] === 'rev-parse') {
            return { exitCode: 0, stdout: `${parentHash}\n`, stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      } as unknown as GitCli;
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash]);

      assert.deepStrictEqual(opened, [parentHash]);
    });

    it('shows error on failure', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);
      commands.setRebaseEditorOpener(async () => {
        throw new Error('rebase failed');
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(messages.error[0].message.includes('rebase failed'));
    });

    // ─── merge-flattening pre-flight refusal ────────────────────────────────
    //
    // A commit graph draws a merged branch's commits right beneath the merge,
    // so a base that LOOKS a few rows below HEAD can span weeks of mainline.
    // When `<onto>..HEAD` contains merges, the handler must REFUSE before
    // opening the editor (IntelliJ GitCommitEditingActionBase
    // checkHeadLinearHistory errors out; there is no proceed affordance),
    // pointing at the Rebase dialog's --rebase-merges option. A merge-free
    // range stays silent.

    /** GitCli whose exec serves the range-analysis probes from a fixture. */
    function createAnalysisGitCli(fixture: {
      total: number;
      nonMerges: number;
      firstParentSteps: number;
      /** Whether the CLICKED commit sits on HEAD's first-parent chain. */
      clickedOnMainline: boolean;
    }): GitCli {
      return {
        exec: async (args: string[]) => {
          const ok = (stdout: string): Record<string, unknown> => ({
            exitCode: 0,
            stdout,
            stderr: '',
            combined: stdout,
          });
          if (args[0] === 'rev-list' && args.includes('--no-merges')) {
            return ok(`${fixture.nonMerges}\n`);
          }
          if (args[0] === 'rev-list' && args.includes('--first-parent')) {
            return ok(`${fixture.firstParentSteps}\n`);
          }
          if (args[0] === 'rev-list') {
            return ok(`${fixture.total}\n`);
          }
          if (args[0] === 'rev-parse' && args.some((a) => a.startsWith('HEAD~'))) {
            // Where the first-parent walk from HEAD lands: the clicked commit
            // itself when it is on the mainline, an unrelated sha otherwise.
            return ok(fixture.clickedOnMainline ? `${testHash}\n` : `${'9'.repeat(40)}\n`);
          }
          if (args[0] === 'rev-parse') {
            // Resolving the clicked commit to its full sha.
            return ok(`${testHash}\n`);
          }
          return ok('');
        },
      } as unknown as GitCli;
    }

    it('refuses a merge-flattening rebase before opening the editor', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createAnalysisGitCli({
        total: 280,
        nonMerges: 200,
        firstParentSteps: 3,
        clickedOnMainline: false,
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(opened.length, 0, 'the editor must not open over a merge-bearing range');
      assert.strictEqual(messages.error.length, 1, 'exactly one refusal toast');
      assert.ok(messages.error[0].message.includes('80'), 'names the flattened-merge count');
      assert.ok(
        messages.error[0].message.includes('--rebase-merges'),
        'points at the Rebase dialog escape hatch'
      );
      assert.strictEqual(
        messages.warning.length,
        0,
        'no warn-and-proceed affordance may remain (the reference refuses outright)'
      );
    });

    it('mentions the merged-branch hint when the base is off the mainline', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createAnalysisGitCli({
        total: 280,
        nonMerges: 200,
        firstParentSteps: 3,
        clickedOnMainline: false,
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      commands.setRebaseEditorOpener(async () => ({ executed: true }));

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(messages.error.length, 1);
      assert.ok(
        /merged branch/i.test(messages.error[0].message),
        'off-mainline base gets the merged-branch hint in the refusal copy'
      );
    });

    it('offers no proceed affordance even when a confirm would be answered', async () => {
      // Regression guard on the removed warn-then-allow arm: a stub that
      // answers ANY confirm affirmatively still must not reach the editor.
      createMessageTrackers();
      writableWindow().showWarningMessage = (): Promise<string | undefined> =>
        Promise.resolve('Rebase Anyway');
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createAnalysisGitCli({
        total: 280,
        nonMerges: 200,
        firstParentSteps: 3,
        clickedOnMainline: false,
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(opened.length, 0, 'refusal must be unconditional');
    });

    it('refuses to open the editor while a rebase is already in progress', async () => {
      // IntelliJ GitInteractiveRebaseAction is Prohibited during rebase. A
      // real on-disk rebase-merge/ marker must refuse before the editor opens.
      const tmpBase = path.join(process.cwd(), 'workspace-notes', 'tmp');
      fs.mkdirSync(tmpBase, { recursive: true });
      const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'irebase-inprogress-'));
      fs.mkdirSync(path.join(tmpRoot, '.git', 'rebase-merge'), { recursive: true });
      try {
        const messages = createMessageTrackers();
        const repo = {
          rootUri: Uri.file(tmpRoot),
          state: 'rebasing',
          head: { name: 'refs/heads/main', commit: undefined, ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        } as unknown as IRepository;
        const gitService = createMockGitService(repo);
        const rebaseService = createMockRebaseService();
        const provider = createMockProvider();
        const gitCli = createMockGitCli();
        const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
        const opened: string[] = [];
        commands.setRebaseEditorOpener(async (_r, onto) => {
          opened.push(onto);
          return { executed: true };
        });

        await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

        assert.strictEqual(opened.length, 0, 'the editor must not open mid-rebase');
        assert.ok(
          messages.error.some((e) => /rebase is in progress/i.test(e.message)),
          `expected an in-progress refusal; got ${JSON.stringify(
            messages.error.map((e) => e.message)
          )}`
        );
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('stays silent for a merge-free range', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createAnalysisGitCli({
        total: 4,
        nonMerges: 4,
        firstParentSteps: 4,
        clickedOnMainline: true,
      });
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(messages.warning.length, 0, 'no warning on linear history');
      assert.deepStrictEqual(opened, [parentHash]);
    });

    it('proceeds without a warning when the analysis probes fail', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = {
        exec: async () => {
          throw new Error('spawn failure');
        },
      } as unknown as GitCli;
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);
      const opened: string[] = [];
      commands.setRebaseEditorOpener(async (_r, onto) => {
        opened.push(onto);
        return { executed: true };
      });

      await commands._handleAction('interactiveRebase', [testHash], [clickedRow]);

      assert.strictEqual(messages.warning.length, 0, 'analysis failure degrades to no warning');
      assert.deepStrictEqual(opened, [parentHash], 'the rebase itself is not blocked');
    });
  });

  // ─── newBranch / newTag (IntelliJ Git.CreateNewBranch.FromCommit /
  //     Git.CreateNewTag, surfaced in the webview commit context menu) ─────────

  describe('_handleAction newBranch', () => {
    it('delegates to intellig.commit.newBranch with the first selected hash', async () => {
      let executedCommand = '';
      let executedArgs: unknown[] = [];
      writableCommands().executeCommand = (cmd: string, ...args: unknown[]): Promise<unknown> => {
        executedCommand = cmd;
        executedArgs = args;
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('newBranch', [testHash, 'deadbeef']);

      assert.strictEqual(executedCommand, 'intellig.commit.newBranch');
      // The clicked commit's resolved repo root is threaded as the second arg
      // so the New Branch dialog targets that repo (merged "all roots" log fix).
      // The mock provider records no source root, so resolution falls through
      // to the single open repo's root.
      assert.deepStrictEqual(executedArgs, [testHash, '/test-repo']);
    });

    it('does nothing when no commit is selected', async () => {
      let executedCommand = '';
      writableCommands().executeCommand = (cmd: string): Promise<unknown> => {
        executedCommand = cmd;
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('newBranch', []);

      assert.strictEqual(executedCommand, '');
    });
  });

  describe('_handleAction newTag', () => {
    it('delegates to intellig.commit.newTag with the first selected hash', async () => {
      let executedCommand = '';
      let executedArgs: unknown[] = [];
      writableCommands().executeCommand = (cmd: string, ...args: unknown[]): Promise<unknown> => {
        executedCommand = cmd;
        executedArgs = args;
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('newTag', [testHash, 'deadbeef']);

      assert.strictEqual(executedCommand, 'intellig.commit.newTag');
      // Second arg = the clicked commit's resolved repo root (merged "all
      // roots" log fix); falls through to the single open repo's root here.
      assert.deepStrictEqual(executedArgs, [testHash, '/test-repo']);
    });

    it('does nothing when no commit is selected', async () => {
      let executedCommand = '';
      writableCommands().executeCommand = (cmd: string): Promise<unknown> => {
        executedCommand = cmd;
        return Promise.resolve(undefined);
      };
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider);

      await commands._handleAction('newTag', []);

      assert.strictEqual(executedCommand, '');
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
  describe('error toast sanitization (representative)', () => {
    it('_handleCherryPick sanitizes credentialed URL + home path in error toast', async () => {
      const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo, {
        cherryPick: () => errAsync(new SpawnFailedError(RAW)),
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

  // ─── fixup / squashInto (Git.Fixup.To.Commit / Git.Squash.Into.Commit) ──────

  // ─── fixup / squashInto via the seeded Commit dialog (IntelliJ
  //     GitAutoSquashCommitAction.kt:29-61: opens the COMMIT DIALOG seeded
  //     `fixup!/squash! <subject>` and offers a commit-and-rebase executor;
  //     adapted: dialog first, then a 'Rebase Now' toast affordance) ────────
  describe('fixup / squashInto — seeded commit dialog + Rebase Now', () => {
    const targetHash = 'f'.repeat(40);
    const createdHash = 'e'.repeat(40);

    interface FixupHarness {
      commands: CommitContextMenuCommands;
      tracker: {
        startedOnto: string | undefined;
        lastPlan: IRebaseAction[] | undefined;
        executeCalls: number;
      };
      shownOptions: Array<{ initialMessage?: string } | undefined>;
      restoreDialog: () => void;
      messages: ReturnType<typeof createMessageTrackers>;
    }

    function makeFixupHarness(opts: {
      dialogResult: { committed: boolean; message?: string };
      infoAnswer?: string;
    }): FixupHarness {
      const messages = createMessageTrackers();
      writableWindow().showInformationMessage = ((message: string, ...items: string[]) => {
        messages.info.push({ message, items });
        return Promise.resolve(items.includes(opts.infoAnswer ?? '') ? opts.infoAnswer : undefined);
      }) as never;

      const repo = createMockRepo('head_hash');
      const gitService = createMockGitService(repo, {
        getCommit: async (_r: IRepository, hash: string) => ({
          hash: hash === 'HEAD' ? createdHash : hash,
          shortHash: hash.substring(0, 7),
          message:
            hash === 'HEAD'
              ? 'squash! Fix the widget\n\nextra detail'
              : 'Fix the widget\n\ntarget body',
          author: { name: 'a', email: 'a@x' },
          committer: { name: 'a', email: 'a@x' },
          parents: ['0'.repeat(40)],
          authorDate: new Date(0),
          commitDate: new Date(0),
        }),
        getMergeBase: async (_r: IRepository, a: string) => a,
      } as unknown as Partial<IGitService>);

      const tracker: FixupHarness['tracker'] = {
        startedOnto: undefined,
        lastPlan: undefined,
        executeCalls: 0,
      };
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async (_r: IRepository, onto: string) => {
          tracker.startedOnto = onto;
          return {
            onto,
            originalBranch: 'main',
            commits: [
              { hash: '9'.repeat(40), message: 'older', action: 'pick' as const },
              { hash: targetHash, message: 'Fix the widget', action: 'pick' as const },
              { hash: '8'.repeat(40), message: 'later', action: 'pick' as const },
              { hash: createdHash, message: 'squash! Fix the widget', action: 'pick' as const },
            ],
            currentStep: 0,
            status: 'planning' as const,
          };
        },
        updateRebasePlan: (_r: IRepository, plan: IRebaseAction[]) => {
          tracker.lastPlan = plan.map((a) => ({ ...a }));
        },
        executeRebase: async () => {
          tracker.executeCalls++;
          return { success: true, status: 'completed' as const };
        },
      });
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        createMockGitCli()
      );
      (commands as unknown as { _context: unknown })._context = makeExtensionContext();

      const shownOptions: FixupHarness['shownOptions'] = [];
      const origShow = CommitDialog.prototype.show;
      CommitDialog.prototype.show = function (
        this: CommitDialog,
        _repo: IRepository,
        options?: { initialMessage?: string }
      ): Promise<{ committed: boolean; message?: string }> {
        shownOptions.push(options);
        (this as unknown as { dispose(): void }).dispose();
        return Promise.resolve(opts.dialogResult);
      } as typeof CommitDialog.prototype.show;

      return {
        commands,
        tracker,
        shownOptions,
        restoreDialog: () => {
          CommitDialog.prototype.show = origShow;
        },
        messages,
      };
    }

    it('fixup opens the commit dialog seeded "fixup! <subject>"', async () => {
      const h = makeFixupHarness({ dialogResult: { committed: true } });
      try {
        await h.commands._handleAction('fixup', [targetHash]);
      } finally {
        h.restoreDialog();
      }

      assert.strictEqual(h.shownOptions.length, 1, 'the commit dialog must open');
      assert.strictEqual(h.shownOptions[0]?.initialMessage, 'fixup! Fix the widget');
    });

    it('a committed dialog offers a Rebase Now toast; declining runs no rebase', async () => {
      const h = makeFixupHarness({ dialogResult: { committed: true } });
      try {
        await h.commands._handleAction('fixup', [targetHash]);
      } finally {
        h.restoreDialog();
      }

      assert.ok(
        h.messages.info.some((m) => m.items.includes('Rebase Now')),
        `expected a Rebase Now affordance; got ${JSON.stringify(h.messages.info)}`
      );
      assert.strictEqual(h.tracker.executeCalls, 0, 'declining must not rebase');
    });

    it('Rebase Now folds the fixup! commit into the target via the shared runner', async () => {
      const h = makeFixupHarness({ dialogResult: { committed: true }, infoAnswer: 'Rebase Now' });
      try {
        await h.commands._handleAction('fixup', [targetHash]);
      } finally {
        h.restoreDialog();
      }

      assert.strictEqual(h.tracker.startedOnto, `${targetHash}~1`);
      assert.strictEqual(h.tracker.executeCalls, 1);
      const plan = h.tracker.lastPlan;
      assert.ok(plan, 'a plan must be applied');
      const targetIdx = plan.findIndex((p) => p.hash === targetHash);
      const createdIdx = plan.findIndex((p) => p.hash === createdHash);
      assert.strictEqual(
        createdIdx,
        targetIdx + 1,
        `the fixup! commit must move right after the target; plan ${JSON.stringify(plan)}`
      );
      assert.strictEqual(plan[createdIdx].action, 'fixup', 'folded without touching the message');
      assert.strictEqual(plan[targetIdx].action, 'pick', 'fixup keeps the target message');
    });

    it("squashInto seeds 'squash!' and Rebase Now combines the messages via a reword override", async () => {
      const h = makeFixupHarness({
        dialogResult: { committed: true, message: 'squash! Fix the widget\n\nextra detail' },
        infoAnswer: 'Rebase Now',
      });
      try {
        await h.commands._handleAction('squashInto', [targetHash]);
      } finally {
        h.restoreDialog();
      }

      assert.strictEqual(h.shownOptions[0]?.initialMessage, 'squash! Fix the widget');
      const plan = h.tracker.lastPlan;
      assert.ok(plan, 'a plan must be applied');
      const target = plan.find((p) => p.hash === targetHash);
      assert.strictEqual(target?.action, 'reword', 'squash combines messages on the target');
      assert.ok(
        target?.newMessage?.includes('target body') && target.newMessage.includes('extra detail'),
        `combined message must carry both bodies; got ${JSON.stringify(target?.newMessage)}`
      );
      assert.ok(
        !target?.newMessage?.includes('squash!'),
        `the squash! marker line must not leak into the message; got ${JSON.stringify(
          target?.newMessage
        )}`
      );
      const created = plan.find((p) => p.hash === createdHash);
      assert.strictEqual(created?.action, 'fixup', 'the squash! commit folds in');
    });

    it('a cancelled dialog commits nothing and offers no rebase', async () => {
      const h = makeFixupHarness({ dialogResult: { committed: false } });
      try {
        await h.commands._handleAction('fixup', [targetHash]);
      } finally {
        h.restoreDialog();
      }

      assert.strictEqual(h.tracker.executeCalls, 0);
      assert.ok(
        !h.messages.info.some((m) => m.items.includes('Rebase Now')),
        'no Rebase Now affordance on cancel'
      );
    });
  });

  describe('_handleAction fixup / squashInto', () => {
    function makeServiceWithFixup(
      fixupResult: { success: boolean; reason?: string } = { success: true }
    ): IGitService & { calls: CallTracker[] } {
      const repo = createMockRepo('head_hash');
      return createMockGitService(repo, {
        commitFixup: () => okAsync(fixupResult),
      } as unknown as Partial<IGitService>);
    }

    it('fixup dispatches commitFixup with the selected hash and mode "fixup"', async () => {
      const repo = createMockRepo('head_hash');
      const calls: CallTracker[] = [];
      const gitService = createMockGitService(repo, {
        commitFixup: (...args: unknown[]) => {
          calls.push({ method: 'commitFixup', args });
          return okAsync({ success: true });
        },
      } as unknown as Partial<IGitService>);
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        createMockGitCli()
      );

      await commands._handleAction('fixup', [testHash]);

      assert.strictEqual(calls.length, 1, 'commitFixup called once');
      assert.strictEqual(calls[0].args[1], testHash, 'target hash forwarded');
      assert.strictEqual(calls[0].args[2], 'fixup', 'mode is fixup');
    });

    it('squashInto dispatches commitFixup with the selected hash and mode "squash"', async () => {
      const repo = createMockRepo('head_hash');
      const calls: CallTracker[] = [];
      const gitService = createMockGitService(repo, {
        commitFixup: (...args: unknown[]) => {
          calls.push({ method: 'commitFixup', args });
          return okAsync({ success: true });
        },
      } as unknown as Partial<IGitService>);
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        createMockGitCli()
      );

      await commands._handleAction('squashInto', [testHash]);

      assert.strictEqual(calls.length, 1, 'commitFixup called once');
      assert.strictEqual(calls[0].args[1], testHash, 'target hash forwarded');
      assert.strictEqual(calls[0].args[2], 'squash', 'mode is squash');
    });

    it('fixup no-ops on empty selection (no commitFixup call)', async () => {
      const repo = createMockRepo('head_hash');
      const calls: CallTracker[] = [];
      const gitService = createMockGitService(repo, {
        commitFixup: (...args: unknown[]) => {
          calls.push({ method: 'commitFixup', args });
          return okAsync({ success: true });
        },
      } as unknown as Partial<IGitService>);
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        createMockGitCli()
      );

      await commands._handleAction('fixup', []);

      assert.strictEqual(calls.length, 0, 'no commitFixup call for an empty selection');
    });

    it('surfaces an info toast on success', async () => {
      const messages = createMessageTrackers();
      const commands = new CommitContextMenuCommands(
        makeServiceWithFixup({ success: true }),
        createMockRebaseService(),
        createMockProvider(),
        createMockGitCli()
      );

      await commands._handleAction('fixup', [testHash]);

      assert.strictEqual(messages.info.length, 1, 'one info toast on success');
      assert.strictEqual(messages.error.length, 0, 'no error toast on success');
    });

    it('surfaces a nothing-to-commit error toast when the index is empty', async () => {
      const messages = createMessageTrackers();
      const commands = new CommitContextMenuCommands(
        makeServiceWithFixup({ success: false, reason: 'nothing-to-commit' }),
        createMockRebaseService(),
        createMockProvider(),
        createMockGitCli()
      );

      await commands._handleAction('squashInto', [testHash]);

      assert.strictEqual(messages.error.length, 1, 'one error toast on nothing-to-commit');
      assert.ok(
        /nothing to commit/i.test(messages.error[0].message),
        'toast explains there is nothing to commit'
      );
    });
  });

  describe('_handleSquashCommits — conflict handoff opens the dialog resolve-only', () => {
    it('squash conflict leaves the rebase paused and passes rebaseInProgress verbatim', async () => {
      createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const c1 = '1'.repeat(40);
      const c2 = '2'.repeat(40);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => ({
          onto: `${c2}^`,
          originalBranch: 'main',
          commits: [
            { hash: c1, message: 'a', action: 'pick' as const },
            { hash: c2, message: 'b', action: 'pick' as const },
          ],
          currentStep: 0,
          status: 'planning' as const,
        }),
        executeRebase: async () => ({
          success: false,
          status: 'conflict' as const,
          conflictedFiles: ['x.ts'],
          rebaseInProgress: true,
        }),
      });
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        provider,
        createCleanGitCli()
      );

      let captured: { rebaseInProgress?: boolean } | undefined;
      (
        commands as unknown as {
          _openResolveConflictsDialog: (
            repo: unknown,
            files: unknown,
            opContext: { rebaseInProgress?: boolean }
          ) => Promise<void>;
        }
      )._openResolveConflictsDialog = async (_repo, _files, opContext): Promise<void> => {
        captured = opContext;
      };

      // fixup mode skips the squash-message dialog.
      await (
        commands as unknown as {
          _handleSquashCommits: (
            hashes: string[],
            nodes: { hash: string; parentCount: number }[],
            options: { mode: 'squash' | 'fixup' }
          ) => Promise<void>;
        }
      )._handleSquashCommits(
        [c1, c2],
        [
          { hash: c1, parentCount: 1 },
          { hash: c2, parentCount: 1 },
        ],
        { mode: 'fixup' }
      );

      assert.ok(captured, 'the Resolve Conflicts dialog must be opened on a squash conflict');
      assert.strictEqual(
        captured.rebaseInProgress,
        true,
        'a live conflict is continuable — the dialog affordances must reflect it verbatim'
      );
      assert.ok(
        !rebaseService.calls.find((c) => c.method === 'abortRebase'),
        'the conflicted rebase must stay paused — abort is user-initiated only'
      );
    });
  });

  describe('_handleSquashCommits — non-conflict failure toast', () => {
    it('shows an error toast when squash rebase fails without conflicts', async () => {
      // Squash already guards against 'paused' (result.status === 'completed' check),
      // but a non-conflict failure with any other status fell through silently.
      // An error must be surfaced so the user knows the squash did not complete.
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const c1 = '1'.repeat(40);
      const c2 = '2'.repeat(40);
      const rebaseService = createMockRebaseService({
        startInteractiveRebase: async () => ({
          onto: `${c2}^`,
          originalBranch: 'main',
          commits: [
            { hash: c1, message: 'newer', action: 'pick' as const },
            { hash: c2, message: 'older', action: 'pick' as const },
          ],
          currentStep: 0,
          status: 'planning' as const,
        }),
        executeRebase: async () => ({ success: false, status: 'in-progress' as const }),
      });
      const gitCli = createCleanGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        rebaseService,
        createMockProvider(),
        gitCli
      );

      // fixup mode skips the squash-message dialog so the test runs without a UI prompt.
      await (
        commands as unknown as {
          _handleSquashCommits(
            hashes: string[],
            nodes: { hash: string; parentCount: number }[],
            options: { mode: 'squash' | 'fixup' }
          ): Promise<void>;
        }
      )._handleSquashCommits(
        [c1, c2],
        [
          { hash: c1, parentCount: 1 },
          { hash: c2, parentCount: 1 },
        ],
        { mode: 'fixup' }
      );

      assert.strictEqual(messages.info.length, 0, 'no success toast on squash failure');
      assert.ok(
        messages.error.some((e) => /squash|fixup|fail|rebase/i.test(e.message)),
        `expected an error toast, got: ${JSON.stringify(messages.error)}`
      );
    });
  });

  // ─── dropSelectedChangesFromCommit — newly-added file toast (R3-4) ──────

  describe('dropSelectedChangesFromCommit — toast when newly-added files remain on disk', () => {
    const dscHash = 'a'.repeat(40);

    function makeDscGitCli(overrides?: Record<string, unknown>): MockGitCli {
      return createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            // Not pushed.
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
        ...overrides,
      });
    }

    function makeDscGitService(
      repo: IRepository,
      diffs: { path: string; status: 'added' | 'modified' | 'deleted' }[]
    ): IGitService & { calls: CallTracker[] } {
      return createMockGitService(repo, {
        getCommit: async () => ({
          hash: dscHash,
          shortHash: dscHash.substring(0, 8),
          message: 'test',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
        getCommitDiff: async () => diffs.map((d) => ({ ...d, hunks: [], binary: false })),
      });
    }

    it('clarifies in the toast that newly-added dropped files remain on disk as untracked', async () => {
      // git rm --cached removes an added file from the index but leaves it on
      // disk. A plain "Dropped N file(s)" toast implies the content is gone.
      // The fix adds a note so the user knows to check their working tree.
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const diffs = [
        { path: 'new-file.ts', status: 'added' as const },
        { path: 'kept.ts', status: 'modified' as const },
      ];
      const gitService = makeDscGitService(repo, diffs);
      const gitCli = makeDscGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo // repoResolver: always return the mock repo
      );

      // User selects only the newly-added file to drop.
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([
          (items as { label: string; path: string }[]).find((i) => i.path === 'new-file.ts'),
        ]);
      // Auto-accept the confirm modal.
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.strictEqual(messages.info.length, 1, 'expected exactly one success toast');
      assert.ok(
        /untracked|remain.*disk|on disk/i.test(messages.info[0].message),
        `toast must mention that the file remains on disk as untracked; got: "${messages.info[0].message}"`
      );
      assert.ok(
        messages.info[0].message.includes('new-file.ts'),
        `toast must name the untracked file; got: "${messages.info[0].message}"`
      );
    });

    it('refuses while a rebase is in progress (Prohibit policy parity)', async () => {
      // IntelliJ GitDropSelectedChangesAction is Prohibited during rebase; a
      // soft-reset mid-rebase would corrupt the detached-HEAD rebase state.
      const tmpBase = path.join(process.cwd(), 'workspace-notes', 'tmp');
      fs.mkdirSync(tmpBase, { recursive: true });
      const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'dsc-inprogress-'));
      fs.mkdirSync(path.join(tmpRoot, '.git', 'rebase-merge'), { recursive: true });
      try {
        const messages = createMessageTrackers();
        const repo = {
          rootUri: Uri.file(tmpRoot),
          state: 'rebasing',
          head: { name: 'refs/heads/main', commit: dscHash, ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        } as unknown as IRepository;
        const gitService = makeDscGitService(repo, [{ path: 'f.ts', status: 'modified' as const }]);
        const commands = new CommitContextMenuCommands(
          gitService,
          createMockRebaseService(),
          createMockProvider(),
          makeDscGitCli(),
          undefined,
          async () => repo
        );

        await commands.dropSelectedChangesFromCommit(dscHash);

        assert.ok(
          messages.error.some((e) => /rebase is in progress/i.test(e.message)),
          `expected an in-progress refusal; got ${JSON.stringify(
            messages.error.map((e) => e.message)
          )}`
        );
        assert.strictEqual(messages.info.length, 0, 'no success toast may fire');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('refuses when the commit is contained in a protected remote branch (naming it)', async () => {
      // IntelliJ's GitDropSelectedChangesAction rides the shared commit-editing
      // gates: a commit on a protected remote branch is blocked
      // (findProtectedRemoteBranch). Ours previously refused on pushed-ANYWHERE;
      // reference-correct is the protected list.
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const gitService = makeDscGitService(repo, [{ path: 'f.ts', status: 'modified' as const }]);
      const gitCli = makeDscGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            return { exitCode: 0, stdout: '  origin/main\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo
      );

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.ok(
        messages.error.some((e) => e.message.includes('origin/main')),
        `expected a refusal naming the protected branch; got ${JSON.stringify(
          messages.error.map((e) => e.message)
        )}`
      );
      assert.strictEqual(messages.info.length, 0, 'no success toast on a refusal');
    });

    it('proceeds when the commit is pushed only to an unprotected remote branch', async () => {
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const gitService = makeDscGitService(repo, [
        { path: 'f.ts', status: 'modified' as const },
        { path: 'kept.ts', status: 'modified' as const },
      ]);
      const gitCli = makeDscGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            return { exitCode: 0, stdout: '  origin/feature\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo
      );

      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([
          (items as { label: string; path: string }[]).find((i) => i.path === 'f.ts'),
        ]);
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.strictEqual(
        messages.error.length,
        0,
        `unprotected published history is editable; got ${JSON.stringify(
          messages.error.map((e) => e.message)
        )}`
      );
      assert.strictEqual(messages.info.length, 1, 'the drop completes with a success toast');
    });

    it('does NOT add the untracked note when no newly-added files were dropped', async () => {
      // Only modified files were dropped — checkout HEAD restores them from the
      // parent, so no untracked files remain. Toast must stay simple.
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const diffs = [
        { path: 'modified.ts', status: 'modified' as const },
        { path: 'kept.ts', status: 'modified' as const },
      ];
      const gitService = makeDscGitService(repo, diffs);
      const gitCli = makeDscGitCli();
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo
      );

      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([
          (items as { label: string; path: string }[]).find((i) => i.path === 'modified.ts'),
        ]);
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.strictEqual(messages.info.length, 1, 'expected exactly one success toast');
      assert.ok(
        !/untracked|remain.*disk/i.test(messages.info[0].message),
        `toast must NOT mention untracked files when only modified files were dropped; got: "${messages.info[0].message}"`
      );
    });
  });

  // ─── dropSelectedChangesFromCommit — dirty-tree save bracket (K1) ───────

  describe('dropSelectedChangesFromCommit — saves local changes around the rewrite', () => {
    const dscHash = 'c'.repeat(40);

    function makeHarness(
      statusOut: string,
      diffs?: Array<{
        path: string;
        oldPath?: string;
        status: 'modified' | 'added' | 'renamed' | 'copied' | 'deleted';
      }>,
      dropPath = 'dropped.ts'
    ): {
      calls: string[][];
      commands: CommitContextMenuCommands;
      messages: ReturnType<typeof createMessageTrackers>;
    } {
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: dscHash,
          shortHash: dscHash.substring(0, 8),
          message: 'test',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
        getCommitDiff: async () =>
          (
            diffs ?? [
              { path: 'dropped.ts', status: 'modified' as const },
              { path: 'kept.ts', status: 'modified' as const },
            ]
          ).map((d) => ({ ...d, hunks: [], binary: false })),
      });
      const calls: string[][] = [];
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          calls.push([...cmdArgs]);
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'status') {
            return { exitCode: 0, stdout: statusOut, stderr: '', combined: statusOut };
          }
          const pinned = pinnedStashResponse(cmdArgs);
          if (pinned) {
            return pinned;
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo
      );
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([
          (items as { label: string; path: string }[]).find((i) => i.path === dropPath),
        ]);
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');
      return { calls, commands, messages };
    }

    it('stashes a dirty tree BEFORE the soft reset and pops it after the rewrite', async () => {
      // Without the bracket, `reset --soft HEAD^` merges the user's STAGED
      // work into the index and `commit -C <hash>` silently absorbs it into
      // the rewritten commit; `checkout HEAD -- <dropped>` also clobbers any
      // uncommitted edits to a dropped file. The sibling drop/squash flows
      // already pre-stash — this entry point must too.
      const { calls, commands } = makeHarness('M  unrelated-staged.ts\0');

      await commands.dropSelectedChangesFromCommit(dscHash);

      const verbs = calls.map((c) => `${c[0]}${c[1] ? ' ' + c[1] : ''}`);
      const stashPush = verbs.indexOf('stash push');
      const softReset = verbs.findIndex((v) => v === 'reset --soft');
      const stashPop = verbs.indexOf('stash pop');
      assert.ok(stashPush !== -1, `must stash the dirty tree (verbs: ${verbs.join(', ')})`);
      assert.ok(softReset !== -1, 'the rewrite must still run');
      assert.ok(stashPush < softReset, 'stash must happen BEFORE the soft reset');
      assert.ok(stashPop > softReset, 'the stash must be popped after the rewrite');
    });

    it('refuses outright when unmerged files are present', async () => {
      const { calls, commands, messages } = makeHarness('UU conflicted.ts\0');

      await commands.dropSelectedChangesFromCommit(dscHash);

      const verbs = calls.map((c) => `${c[0]}${c[1] ? ' ' + c[1] : ''}`);
      assert.ok(!verbs.includes('reset --soft'), 'the rewrite must not run over a conflict');
      assert.strictEqual(messages.error.length, 1, 'expected a refusal toast');
      assert.ok(/unmerged|conflict/i.test(messages.error[0].message));
    });

    it('drops a RENAMED file by unindexing the new path and restoring the old path', async () => {
      // The inline partition sent renamed/copied files to
      // `checkout HEAD -- <newPath>` — the parent has no such path, git
      // fatals, and the inner rollback undoes the whole drop ("Failed to
      // drop changes: pathspec…"). The shared restore-to-HEAD writer knows
      // the rename shape: unindex the new path, restore the old one.
      const { calls, commands, messages } = makeHarness(
        '',
        [
          { path: 'renamed-new.ts', oldPath: 'renamed-old.ts', status: 'renamed' },
          { path: 'kept.ts', status: 'modified' },
        ],
        'renamed-new.ts'
      );

      await commands.dropSelectedChangesFromCommit(dscHash);

      const checkoutHead = calls.filter((c) => c[0] === 'checkout' && c[1] === 'HEAD');
      const checkoutTargets = checkoutHead.flatMap((c) => c.slice(c.indexOf('--') + 1));
      assert.ok(
        !checkoutTargets.includes('renamed-new.ts'),
        'the rename DESTINATION must never be checked out from the parent (it does not exist there)'
      );
      assert.ok(
        checkoutTargets.includes('renamed-old.ts'),
        `the rename SOURCE must be restored from the parent; checkouts: ${JSON.stringify(checkoutTargets)}`
      );
      const rm = calls.find((c) => c[0] === 'rm' && c.includes('--cached'));
      assert.ok(rm, 'the new path must be unindexed');
      assert.ok(rm.slice(rm.indexOf('--') + 1).includes('renamed-new.ts'));
      assert.strictEqual(
        messages.error.length,
        0,
        `no error toast: ${JSON.stringify(messages.error)}`
      );
      const commit = calls.find((c) => c[0] === 'commit');
      assert.ok(commit, 'the kept file must be re-committed');
    });

    it('does not stash when the tree is clean', async () => {
      const { calls, commands } = makeHarness('');

      await commands.dropSelectedChangesFromCommit(dscHash);

      const verbs = calls.map((c) => c[0]);
      assert.ok(!verbs.includes('stash'), 'clean tree needs no stash');
      assert.ok(verbs.includes('reset'), 'the rewrite must run');
    });
  });

  // ─── dropSelectedChangesFromCommit — rollback error toast (R3-5) ────────

  describe('dropSelectedChangesFromCommit — honest rollback error toast', () => {
    const dscHash = 'b'.repeat(40);

    it('mentions that the original commit was restored and to check git status when a mid-operation failure triggers rollback', async () => {
      // After git reset --soft HEAD^ un-commits HEAD, a partial failure (e.g.
      // rm --cached throws) triggers git reset --soft <hash> to restore the
      // commit pointer. But the index/worktree may still reflect partial
      // side-effects. The error toast must be honest about this.
      const messages = createMessageTrackers();
      const repo = createMockRepo(dscHash);
      const gitService = createMockGitService(repo, {
        getCommit: async () => ({
          hash: dscHash,
          shortHash: dscHash.substring(0, 8),
          message: 'test',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
        getCommitDiff: async () => [
          { path: 'new-file.ts', status: 'added' as const, hunks: [], binary: false },
          // A kept file keeps the selection partial — all-files is refused.
          { path: 'kept.ts', status: 'modified' as const, hunks: [], binary: false },
        ],
      });
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'reset' && cmdArgs[1] === '--soft' && cmdArgs[2] === 'HEAD^') {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'rm' && cmdArgs.includes('--cached')) {
            throw new Error('index lock failure');
          }
          // rollback reset --soft <hash>
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        createMockProvider(),
        gitCli,
        undefined,
        async () => repo
      );

      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([(items as { label: string; path: string }[])[0]]);
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.strictEqual(messages.error.length, 1, 'expected one error toast');
      const msg = messages.error[0].message;
      assert.ok(
        /restored|git status|check/i.test(msg),
        `error toast must tell the user the commit was restored and to check git status; got: "${msg}"`
      );
    });

    it('reloads the repository after rollback so the tool window reflects restored state', async () => {
      // The rollback git reset --soft <hash> moves HEAD back, so the view must
      // be refreshed — otherwise the panel shows the pre-error (uncommitted) state.
      const repo = createMockRepo(dscHash);
      const reloadCalls: string[] = [];
      const gitService = createMockGitService(repo, {
        reloadRepository: async () => {
          reloadCalls.push('reload');
          return repo;
        },
        getCommit: async () => ({
          hash: dscHash,
          shortHash: dscHash.substring(0, 8),
          message: 'test',
          author: { name: '', email: '' },
          committer: { name: '', email: '' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        }),
        getCommitDiff: async () => [
          { path: 'new-file.ts', status: 'added' as const, hunks: [], binary: false },
          // A kept file keeps the selection partial — all-files is refused.
          { path: 'kept.ts', status: 'modified' as const, hunks: [], binary: false },
        ],
      });
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const cmdArgs = args[0] as string[];
          if (cmdArgs[0] === 'rev-parse' && cmdArgs[1] === 'HEAD') {
            return { exitCode: 0, stdout: dscHash, stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'branch' && cmdArgs.includes('--remotes')) {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'reset' && cmdArgs[1] === '--soft' && cmdArgs[2] === 'HEAD^') {
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          }
          if (cmdArgs[0] === 'rm' && cmdArgs.includes('--cached')) {
            throw new Error('index lock failure');
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const provider = createMockProvider();
      const commands = new CommitContextMenuCommands(
        gitService,
        createMockRebaseService(),
        provider,
        gitCli,
        undefined,
        async () => repo
      );

      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> =>
        Promise.resolve([(items as { label: string; path: string }[])[0]]);
      writableWindow().showWarningMessage = (
        _message: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Drop');

      await commands.dropSelectedChangesFromCommit(dscHash);

      assert.strictEqual(
        reloadCalls.length,
        1,
        'reloadRepository must be called after rollback so the panel reflects restored state'
      );
      assert.strictEqual(
        provider.refreshCallCount,
        1,
        'refresh must be called after rollback reload'
      );
    });
  });
});
