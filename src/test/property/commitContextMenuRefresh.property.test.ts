// Feature: git-graph-context-menu, Property 6: Successful operations refresh graph
/**
 * **Validates: Requirements 7.4**
 *
 * For any action that modifies repository state (all actions except copyHash and
 * showRepoAtRevision), when the operation completes successfully, the handler
 * should call refresh() on the GitToolWindowProvider.
 */

/*
 * Stub factories synthesise IGitService / IRebaseService implementations
 * whose member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { CommitContextMenuCommands } from '../../commands/CommitContextMenuCommands';
import { IGitService, IRepository } from '../../services/interfaces/IGitService';
import { IRebaseService } from '../../services/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../../services/GitToolWindowProvider';
import type { GitCli } from '../../utils/gitCli';
import { EventEmitter, Uri } from '../mocks/vscode';
import { writableWindow } from '../typed/windowStub';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Actions that modify repository state and should trigger a refresh.
 * Excludes copyHash and showRepoAtRevision per the property definition.
 * Only includes currently implemented actions.
 *
 * `resetToHere` is intentionally excluded: since T1-11 it routes through
 * the webview-based ResetDialog, which fires `onResetComplete` (and thus
 * the downstream refresh) only after the dialog's own reset flow runs.
 * That flow is covered by the dedicated ResetDialog suites.
 */
const STATE_MODIFYING_ACTIONS: LogContextAction[] = [
  'cherryPick',
  'revert',
  'checkoutRevision',
  'undoCommit',
  'dropCommit',
  'editCommitMessage',
  'mergeIntoCurrent',
  'interactiveRebase',
];

/**
 * Generate a state-modifying action.
 */
function arbitraryStateModifyingAction(): fc.Arbitrary<LogContextAction> {
  return fc.constantFrom(...STATE_MODIFYING_ACTIONS);
}

/**
 * Generate a valid hex commit hash (40 hex chars).
 */
function arbitraryCommitHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 40,
    maxLength: 40,
  });
}

/**
 * Generate a non-empty array of commit hashes.
 */
function arbitraryCommitHashes(): fc.Arbitrary<string[]> {
  return fc.array(arbitraryCommitHash(), { minLength: 1, maxLength: 3 });
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

function restoreMessageFunctions(): void {
  const w = writableWindow();
  w.showErrorMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showInformationMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showQuickPick = (): Promise<unknown> => Promise.resolve(undefined);
}

/**
 * Create a mock IGitService where all operations succeed.
 */
function createSuccessGitService(headCommitHash?: string): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: headCommitHash, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  return {
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [mockRepo],
    getRepository: async () => mockRepo,
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
    fetch: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
    stash: async () => {},
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
    getDiff: async () => ({
      path: '',
      status: 'modified' as const,
      hunks: [],
      binary: false,
    }),
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
  } as unknown as IGitService;
}

function createMockRebaseService(commitHash?: string): IRebaseService {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async () => ({
      onto: '',
      originalBranch: '',
      commits: commitHash ? [{ hash: commitHash, message: 'test commit', action: 'pick' }] : [],
      currentStep: 0,
      status: 'planning' as const,
    }),
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => ({ success: true, status: 'completed' as const }),
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
  } as IRebaseService;
}

/**
 * Create a mock GitToolWindowProvider that tracks refresh calls.
 */
function createTrackingGitToolWindowProvider(): GitToolWindowProvider & {
  refreshCallCount: number;
} {
  const provider = {
    onDidRequestLogContextAction: (_handler: unknown) => ({ dispose: () => {} }),
    refreshCallCount: 0,
    refresh: function () {
      (this as { refreshCallCount: number }).refreshCallCount++;
    },
  } as unknown as GitToolWindowProvider & { refreshCallCount: number };
  return provider;
}

/**
 * Create a mock GitCli that always succeeds.
 */
function createSuccessGitCli(): GitCli {
  return {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
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
    onCommandExecuted: (() => ({ dispose: () => {} })) as unknown as GitCli['onCommandExecuted'],
  } as unknown as GitCli;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Refresh Graph Property Tests', () => {
  beforeEach(() => {
    // Mock showQuickPick to always return a selection (for resetToHere)
    writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> => {
      return Promise.resolve(items[0]); // Always pick Soft
    };
    // Mock showInputBox to return a value (for editCommitMessage)
    writableWindow().showInputBox = (): Promise<string | undefined> =>
      Promise.resolve('new message');
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  // Feature: git-graph-context-menu, Property 6: Successful operations refresh graph
  describe('Property 6: Successful operations refresh graph', () => {
    /**
     * **Validates: Requirements 7.4**
     *
     * For any action that modifies repository state (all actions except copyHash
     * and showRepoAtRevision), when the operation completes successfully, the
     * handler should call refresh() on the GitToolWindowProvider.
     */
    it('calls refresh on the provider after any successful state-modifying action', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStateModifyingAction(),
          arbitraryCommitHashes(),
          async (action, commitHashes) => {
            const headHash = commitHashes[0];
            const gitService = createSuccessGitService(headHash);
            const rebaseService = createMockRebaseService(headHash);
            const provider = createTrackingGitToolWindowProvider();
            const gitCli = createSuccessGitCli();

            const commands = new CommitContextMenuCommands(
              gitService,
              rebaseService,
              provider,
              gitCli
            );

            provider.refreshCallCount = 0;

            await commands._handleAction(action, commitHashes);

            assert.ok(
              provider.refreshCallCount > 0,
              `refresh() should have been called for successful action "${action}", but was called ${provider.refreshCallCount} times`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('does NOT call refresh for copyHash action', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryCommitHashes(), async (commitHashes) => {
          const gitService = createSuccessGitService(commitHashes[0]);
          const rebaseService = createMockRebaseService();
          const provider = createTrackingGitToolWindowProvider();
          const gitCli = createSuccessGitCli();

          const commands = new CommitContextMenuCommands(
            gitService,
            rebaseService,
            provider,
            gitCli
          );

          provider.refreshCallCount = 0;

          await commands._handleAction('copyHash', commitHashes);

          assert.strictEqual(
            provider.refreshCallCount,
            0,
            `refresh() should NOT have been called for copyHash action, but was called ${provider.refreshCallCount} times`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
