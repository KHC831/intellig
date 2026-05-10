// Feature: git-graph-context-menu, Property 4: Action dispatch correctness
/**
 * **Validates: Requirements 7.1**
 *
 * For any valid LogContextAction value and commit hash array, the CommitContextMenuCommands
 * handler should invoke exactly one handler method corresponding to that action, and that
 * method should receive the correct commit hashes.
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
import { EventEmitter, Uri } from '../mocks/vscode';
import { writableWindow } from '../typed/windowStub';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Actions that are currently implemented and dispatch to a handler.
 */
const IMPLEMENTED_ACTIONS: LogContextAction[] = [
  'copyHash',
  'cherryPick',
  'revert',
  'checkoutRevision',
  'resetToHere',
  'createPatch',
  'showRepoAtRevision',
  'compareWithLocal',
  'undoCommit',
  'dropCommit',
  'editCommitMessage',
  'mergeIntoCurrent',
  'interactiveRebase',
];

/**
 * Generate a valid LogContextAction.
 */
function arbitraryAction(): fc.Arbitrary<LogContextAction> {
  return fc.constantFrom(...IMPLEMENTED_ACTIONS);
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
  return fc.array(arbitraryCommitHash(), { minLength: 1, maxLength: 5 });
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Map from action to the handler method name that should be called.
 */
const ACTION_TO_HANDLER: Record<string, string> = {
  copyHash: '_handleCopyHash',
  cherryPick: '_handleCherryPick',
  revert: '_handleRevert',
  checkoutRevision: '_handleCheckoutRevision',
  resetToHere: '_handleResetToHere',
  createPatch: '_handleCreatePatch',
  showRepoAtRevision: '_handleShowRepoAtRevision',
  compareWithLocal: '_handleCompareWithLocal',
  undoCommit: '_handleUndoCommit',
  dropCommit: '_handleDropCommit',
  editCommitMessage: '_handleEditCommitMessage',
  mergeIntoCurrent: '_handleMergeIntoCurrent',
  interactiveRebase: '_handleInteractiveRebase',
};

interface HandlerCallRecord {
  method: string;
  commitHashes: string[];
}

/**
 * Create a mock IGitService that returns a repository.
 */
function createMockGitService(): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'abc123', ahead: 0, behind: 0 },
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
    getCommitDiff: async () => [
      { path: 'src/file.ts', status: 'modified', hunks: [], binary: false },
    ],
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

/**
 * Create a mock IRebaseService.
 */
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
 * Create a mock GitToolWindowProvider with a trackable refresh method.
 */
function createMockGitToolWindowProvider(): GitToolWindowProvider & { refreshCalled: boolean } {
  const provider = {
    onDidRequestLogContextAction: (_handler: unknown) => ({ dispose: () => {} }),
    refresh: function (this: { refreshCalled: boolean }) {
      this.refreshCalled = true;
    },
    refreshCalled: false,
  } as unknown as GitToolWindowProvider & { refreshCalled: boolean };
  return provider;
}

/**
 * Create a CommitContextMenuCommands instance with spy methods to track dispatch.
 */
function createSpiedCommands(commitHash?: string): {
  commands: CommitContextMenuCommands;
  calls: HandlerCallRecord[];
} {
  const gitService = createMockGitService();
  const rebaseService = createMockRebaseService(commitHash);
  const provider = createMockGitToolWindowProvider();

  // Create a mock GitCli that always succeeds
  const mockGitCli = {
    exec: async () => ({ exitCode: 0, stdout: 'src/file.ts\n', stderr: '', combined: '' }),
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
    onCommandExecuted: (() => ({ dispose: () => {} })) as any,
  } as any;

  const commands = new CommitContextMenuCommands(gitService, rebaseService, provider, mockGitCli);

  const calls: HandlerCallRecord[] = [];

  // Install spies on each handler method. Handlers are private on
  // `commands`; the spy replaces each by indexing through a keyed record.
  type HandlerFn = (commitHashes: string[]) => Promise<unknown>;
  const handlerBag = commands as unknown as Record<string, HandlerFn>;
  for (const [, methodName] of Object.entries(ACTION_TO_HANDLER)) {
    const original = handlerBag[methodName].bind(commands) as HandlerFn;
    handlerBag[methodName] = async (commitHashes: string[]): Promise<unknown> => {
      calls.push({ method: methodName, commitHashes });
      return original(commitHashes);
    };
  }

  // Mock showQuickPick to return a selection for resetToHere
  writableWindow().showQuickPick = (items: unknown[]): Promise<unknown | undefined> => {
    return Promise.resolve((items as unknown[])[0]); // Always pick the first option (Soft)
  };

  // Mock showInputBox to return a value for editCommitMessage
  writableWindow().showInputBox = (): Promise<string | undefined> => {
    return Promise.resolve('new commit message');
  };

  // Mock showSaveDialog to return a URI for createPatch
  writableWindow().showSaveDialog = (): Promise<import('vscode').Uri | undefined> => {
    return Promise.resolve(Uri.file('/tmp/test.patch'));
  };

  return { commands, calls };
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Action Dispatch Property Tests', () => {
  afterEach(() => {
    // Restore showQuickPick
    writableWindow().showQuickPick = (): Promise<unknown | undefined> => Promise.resolve(undefined);
  });

  // Feature: git-graph-context-menu, Property 4: Action dispatch correctness
  describe('Property 4: Action dispatch correctness', () => {
    /**
     * **Validates: Requirements 7.1**
     *
     * For any valid LogContextAction value and commit hash array, the
     * CommitContextMenuCommands handler should invoke exactly one handler
     * method corresponding to that action, and that method should receive
     * the correct commit hashes.
     */
    it('dispatches to exactly one correct handler for any action and commit hashes', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryAction(),
          arbitraryCommitHashes(),
          async (action, commitHashes) => {
            const { commands, calls } = createSpiedCommands(commitHashes[0]);
            calls.length = 0;

            await commands._handleAction(action, commitHashes);

            const expectedMethod = ACTION_TO_HANDLER[action];

            // Exactly one handler should have been called
            assert.strictEqual(
              calls.length,
              1,
              `Expected exactly 1 handler call for action "${action}", got ${calls.length}`
            );

            // The correct handler should have been called
            assert.strictEqual(
              calls[0].method,
              expectedMethod,
              `Expected handler "${expectedMethod}" for action "${action}", got "${calls[0].method}"`
            );

            // The handler should have received the correct commit hashes
            assert.deepStrictEqual(
              calls[0].commitHashes,
              commitHashes,
              `Handler received incorrect commit hashes for action "${action}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
