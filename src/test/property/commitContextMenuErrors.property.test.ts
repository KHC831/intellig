// Feature: git-graph-context-menu, Property 5: Error handling shows notification
/**
 * **Validates: Requirements 7.3**
 *
 * For any action where the underlying git operation throws an error, the
 * CommitContextMenuCommands handler should call vscode.window.showErrorMessage
 * with a message containing the error description.
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
import { writableWindow } from '../helpers/windowStub';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Actions that call git service methods and can produce errors.
 * Excludes copyHash (clipboard API) and actions not yet implemented.
 */
const ERROR_TESTABLE_ACTIONS: LogContextAction[] = [
  'cherryPick',
  'revert',
  'checkoutRevision',
  'resetToHere',
  'createPatch',
  'compareWithLocal',
  'showRepoAtRevision',
  'undoCommit',
  'dropCommit',
  'editCommitMessage',
  'mergeIntoCurrent',
  'interactiveRebase',
];

/**
 * Generate a valid error-testable action.
 */
function arbitraryErrorAction(): fc.Arbitrary<LogContextAction> {
  return fc.constantFrom(...ERROR_TESTABLE_ACTIONS);
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

/**
 * Generate a random error message string.
 * Avoids generating messages that contain "CONFLICT" (case-insensitive),
 * "would be overwritten", or "Please commit your changes" since those
 * trigger special handling paths rather than the generic error path.
 */
function arbitraryErrorMessage(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?:;-_()[]{}@#$%^&*+=~`<>/'.split(
          ''
        )
      ),
      { minLength: 1, maxLength: 80 }
    )
    .filter(
      (s) =>
        !s.toUpperCase().includes('CONFLICT') &&
        !s.includes('would be overwritten') &&
        !s.includes('Please commit your changes')
    );
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

interface MessageTracker {
  calls: Array<{ message: string; items: string[] }>;
  reset(): void;
}

function installErrorMessageTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };

  writableWindow().showErrorMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(undefined);
  };

  return tracker;
}

function restoreMessageFunctions(): void {
  const w = writableWindow();
  w.showErrorMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showInformationMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showQuickPick = (): Promise<unknown | undefined> => Promise.resolve(undefined);
}

/**
 * Create a mock IGitService where all operations throw the given error.
 */
function createErrorThrowingGitService(errorMsg: string, headCommitHash?: string): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: headCommitHash, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  const throwError = async () => {
    throw new Error(errorMsg);
  };

  return {
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [mockRepo],
    getRepository: async () => mockRepo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: throwError,
    amend: throwError,
    createBranch: throwError,
    checkout: throwError,
    deleteBranch: throwError,
    renameBranch: throwError,
    mergeBranch: throwError as any,
    rebaseBranch: throwError as any,
    compareBranches: throwError as any,
    fetch: throwError,
    pull: throwError,
    push: throwError,
    getRemotes: async () => [],
    addRemote: throwError,
    removeRemote: throwError,
    stash: throwError,
    stashList: async () => [],
    stashApply: throwError,
    stashPop: throwError,
    stashDrop: throwError,
    stashShow: async () => [],
    createTag: throwError,
    deleteTag: throwError,
    pushTag: throwError,
    getLog: async () => [],
    getCommit: throwError as any,
    getFileHistory: async () => [],
    getDiff: throwError as any,
    getCommitDiff: throwError as any,
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: throwError as any,
    cherryPickAbort: throwError,
    cherryPickContinue: throwError as any,
    revert: throwError as any,
    revertAbort: throwError,
    revertContinue: throwError as any,
    getStatus: async () => [],
    stage: throwError,
    unstage: throwError,
    stageHunk: throwError,
    stageLines: throwError,
    unstageHunk: throwError,
    revertFile: throwError,
    dispose: () => {},
  } as unknown as IGitService;
}

function createErrorThrowingRebaseService(errorMsg: string): IRebaseService {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async () => {
      throw new Error(errorMsg);
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => {
      throw new Error(errorMsg);
    },
    continueRebase: async () => {
      throw new Error(errorMsg);
    },
    abortRebase: async () => {},
    skipCommit: async () => {
      throw new Error(errorMsg);
    },
    provideRewordMessage: async () => {
      throw new Error(errorMsg);
    },
    amendEditCommit: async () => {
      throw new Error(errorMsg);
    },
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
  } as IRebaseService;
}

function createMockGitToolWindowProvider(): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: (_handler: unknown) => ({ dispose: () => {} }),
    refresh: () => {},
  } as unknown as GitToolWindowProvider;
}

/**
 * Create a mock GitCli that throws the given error.
 */
function createErrorThrowingGitCli(errorMsg: string): any {
  return {
    exec: async () => {
      throw new Error(errorMsg);
    },
    execString: async () => {
      throw new Error(errorMsg);
    },
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
  };
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Error Handling Property Tests', () => {
  let errorTracker: MessageTracker;

  beforeEach(() => {
    errorTracker = installErrorMessageTracker();
    // Mock showQuickPick to always return a selection (for resetToHere)
    writableWindow().showQuickPick = (items: unknown[]): Promise<unknown | undefined> => {
      return Promise.resolve((items as unknown[])[0]); // Always pick Soft
    };
    // Mock showInputBox to return a value (for editCommitMessage)
    writableWindow().showInputBox = (): Promise<string | undefined> =>
      Promise.resolve('new message');
    // Mock showSaveDialog to return a URI (for createPatch)
    writableWindow().showSaveDialog = (): Promise<import('vscode').Uri | undefined> =>
      Promise.resolve(Uri.file('/tmp/test.patch'));
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  // Feature: git-graph-context-menu, Property 5: Error handling shows notification
  describe('Property 5: Error handling shows notification', () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * For any action where the underlying git operation throws an error,
     * the CommitContextMenuCommands handler should call
     * vscode.window.showErrorMessage with a message containing the error description.
     */
    it('shows error notification containing the error message for any failing action', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryErrorAction(),
          arbitraryCommitHashes(),
          arbitraryErrorMessage(),
          async (action, commitHashes, errorMsg) => {
            errorTracker.reset();

            const headHash = commitHashes[0];
            const gitService = createErrorThrowingGitService(errorMsg, headHash);
            const rebaseService = createErrorThrowingRebaseService(errorMsg);
            const provider = createMockGitToolWindowProvider();
            const gitCli = createErrorThrowingGitCli(errorMsg);

            const commands = new CommitContextMenuCommands(
              gitService,
              rebaseService,
              provider,
              gitCli
            );

            await commands._handleAction(action, commitHashes);

            assert.ok(
              errorTracker.calls.length > 0,
              `showErrorMessage should have been called for action "${action}" with error "${errorMsg}"`
            );

            const calledMessage = errorTracker.calls[0].message;
            assert.ok(
              calledMessage.includes(errorMsg),
              `Error notification "${calledMessage}" should contain the error message "${errorMsg}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
