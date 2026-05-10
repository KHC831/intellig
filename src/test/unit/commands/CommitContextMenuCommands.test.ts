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

import '../../../test/setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commands/CommitContextMenuCommands';
import { IGitService, IRepository } from '../../../services/interfaces/IGitService';
import { IRebaseAction, IRebaseService, IRebaseSession } from '../../../services/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../../../services/GitToolWindowProvider';
import { EventEmitter, Uri } from '../../mocks/vscode';
import {
  writableWindow,
  writableEnv,
  writableCommands,
  writableWorkspace,
} from '../../typed/windowStub';

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
type MockGitCli = import('../../../utils/gitCli').GitCli & { calls: CallTracker[] };

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
    onCommandExecuted: (() => ({ dispose: () => {} })) as unknown as MockGitCli['onCommandExecuted'],
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

function createMessageTrackers(): { info: MessageRecord[]; error: MessageRecord[]; warning: MessageRecord[] } {
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
  w.showWarningMessage = (
    message: string,
    ...items: unknown[]
  ): Promise<string | undefined> => {
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
  w.showQuickPick = (): Promise<unknown | undefined> => Promise.resolve(undefined);
  w.showInputBox = (): Promise<string | undefined> => Promise.resolve(undefined);
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

  // ─── resetToHere ──────────────────────────────────────────────────────────

  describe('_handleResetToHere', () => {
    /**
     * After T1-11 landed, `resetToHere` opens a ResetDialog (webview)
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
    it('runs git format-patch and prompts save dialog', async () => {
      let savedContent: Buffer | undefined;
      writableWindow().showSaveDialog = (): Promise<vscode.Uri | undefined> =>
        Promise.resolve(Uri.file('/tmp/test.patch'));
      writableWorkspace().fs = {
        ...writableWorkspace().fs,
        writeFile: (_uri: vscode.Uri, content: Uint8Array): Promise<void> => {
          savedContent = Buffer.from(content);
          return Promise.resolve();
        },
      };
      const messages = createMessageTrackers();
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const rebaseService = createMockRebaseService();
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, gitCli);

      await commands._handleAction('createPatch', [testHash]);

      const call = gitCli.calls.find((c: CallTracker) => c.method === 'exec');
      assert.ok(call, 'gitCli.exec should have been called');
      const args = call!.args[0] as string[];
      assert.ok(args.includes('format-patch'));
      assert.ok(args.includes(testHash));
      assert.ok(savedContent);
      assert.strictEqual(messages.info.length, 1);
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

    // Regression for senior-R5 L-3 / task #82 (user-reported crash):
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
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown | undefined> =>
        Promise.resolve((items as unknown[])[0]);
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

    // Regression for senior-R5 L-3 / task #82 (see compareWithLocal note above).
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
      writableWindow().showQuickPick = (items: unknown[]): Promise<unknown | undefined> =>
        Promise.resolve((items as unknown[])[0]);
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
      const args = call!.args[0] as string[];
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
      const amendArgs = amendCall!.args[0] as string[];
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
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve('new message');
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
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve('amended msg');
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
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve('amended with conflicts');
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
      writableWindow().showInputBox = (): Promise<string | undefined> => Promise.resolve('clean edit');
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
});
