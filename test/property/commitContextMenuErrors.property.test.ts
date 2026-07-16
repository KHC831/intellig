// Feature: git-graph-context-menu, Property 5: Error handling shows notification
/**
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
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { GitError, SpawnFailedError } from '../../src/git-core/errors';
import { CommitContextMenuCommands } from '../../src/commits/CommitContextMenuCommands';
import { IGitService, IRepository } from '../../src/git-core/interfaces/IGitService';
import { IRebaseService } from '../../src/git-core/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../../src/ui-shell/GitToolWindowProvider';
import type { GitCli } from '../../src/git-core/gitCli';
import { EventEmitter, Uri } from '../mocks/vscode';
import { writableWindow } from '../typed/windowStub';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Actions that call git service methods and can produce errors.
 * Excludes copyHash (clipboard API) and actions not yet implemented.
 *
 * `resetToHere` is intentionally excluded: it routes through
 * the webview-based ResetDialog (which requires a wired extension context)
 * before any git call, so the error surfaced here is a dialog-availability
 * message rather than the underlying git error. Its behaviour is covered
 * by the dedicated ResetDialog unit + property suites.
 */
const ERROR_TESTABLE_ACTIONS: LogContextAction[] = [
  'cherryPick',
  'revert',
  'checkoutRevision',
  'createPatch',
  'compareWithLocal',
  'showRepoAtRevision',
  'undoCommit',
  'dropCommit',
  'editCommitMessage',
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
  w.showQuickPick = (): Promise<unknown> => Promise.resolve(undefined);
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

  // Variadic signature lets this one function stand in for every IGitService
  // method regardless of its specific argument list — the whole object is
  // cast via `as unknown as IGitService` once assembled.
  const throwError = async (..._args: unknown[]): Promise<never> => {
    throw new Error(errorMsg);
  };
  // Result-channel equivalent for ops methods converted to ResultAsync — the
  // failure surfaces through the Err arm (which the caller funnels to a toast)
  // rather than a thrown promise rejection.
  const throwErrorResult = (..._args: unknown[]): ResultAsync<never, GitError> =>
    errAsync(new SpawnFailedError(errorMsg));

  return {
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [mockRepo],
    getRepository: async () => mockRepo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: throwError,
    amend: throwError,
    createBranch: throwErrorResult,
    checkout: throwErrorResult,
    deleteBranch: throwErrorResult,
    renameBranch: throwErrorResult,
    mergeBranch: throwError,
    rebaseBranch: throwError,
    compareBranches: throwError,
    fetch: throwError,
    pull: throwError,
    push: throwError,
    getRemotes: () => okAsync([]),
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
    getCommit: throwError,
    getFileHistory: async () => [],
    getDiff: throwError,
    getCommitDiff: throwError,
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: throwErrorResult,
    cherryPickAbort: throwErrorResult,
    cherryPickContinue: throwErrorResult,
    revert: throwErrorResult,
    revertAbort: throwErrorResult,
    revertContinue: throwErrorResult,
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
    isManagingRebase: () => false,
    clearSession: () => {},
    updateRebasePlan: () => {},
    executeRebase: async () => {
      throw new Error(errorMsg);
    },
    continueRebase: async () => {
      throw new Error(errorMsg);
    },
    abortRebase: async () => ({ autostashParked: false }),
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

/**
 * Handlers no longer call `getExtendedLogState`. Display order is
 * threaded through the dispatch event. Property 5 needs multi-commit
 * createPatch to reach the gitCli call (so the gitCli error gets
 * surfaced via showErrorMessage), so we now pass the test's random
 * hashes as the third arg of `_handleAction` directly, and the provider
 * mock no longer needs a state-read seam.
 *
 * Follow-up: rule of three — extract this mock to
 * `test/helpers/mockGitToolWindowProvider.ts` when a third test
 * file needs it. Currently 2 consumers (this + commitContextMenuDispatch).
 */
function createMockGitToolWindowProvider(): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: (_handler: unknown) => ({ dispose: () => {} }),
    refresh: () => {},
  } as unknown as GitToolWindowProvider;
}

/**
 * Create a mock GitCli that throws the given error.
 */
function createErrorThrowingGitCli(errorMsg: string): GitCli {
  return {
    exec: async () => {
      throw new Error(errorMsg);
    },
    execString: async () => {
      throw new Error(errorMsg);
    },
    isAvailable: async () => true,
    getVersion: () => okAsync('2.40.0'),
    isRepository: () => okAsync(true),
    getRepositoryRoot: () => okAsync('/test-repo'),
    dispose: () => {},
    get gitPath() {
      return 'git';
    },
    set gitPath(_v: string) {},
    onCommandExecuted: (() => ({ dispose: () => {} })) as unknown as GitCli['onCommandExecuted'],
  } as unknown as GitCli;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Error Handling Property Tests', () => {
  let errorTracker: MessageTracker;

  beforeEach(() => {
    errorTracker = installErrorMessageTracker();
    // Mock showQuickPick to always return a selection (for resetToHere)
    writableWindow().showQuickPick = (items: unknown[]): Promise<unknown> => {
      return Promise.resolve(items[0]); // Always pick Soft
    };
    // Mock showInputBox to return a value (for editCommitMessage)
    writableWindow().showInputBox = (): Promise<string | undefined> =>
      Promise.resolve('new message');
    // Mock showSaveDialog to return a URI (for createPatch single-commit path)
    writableWindow().showSaveDialog = (): Promise<import('vscode').Uri | undefined> =>
      Promise.resolve(Uri.file('/tmp/test.patch'));
    // Multi-commit createPatch asks for a directory. Returning a path
    // lets the flow proceed to the gitCli call; the gitCli mock then
    // throws the property's `errorMsg`, which our catch toasts.
    writableWindow().showOpenDialog = (): Promise<import('vscode').Uri[] | undefined> =>
      Promise.resolve([Uri.file('/tmp/patches')]);
    // Several actions gate behind a destructive-op / history-rewrite confirm
    // modal: _handleDropCommitMulti uses "Drop", and editCommitMessage warns
    // "Reword Anyway" when the target commit is already pushed (and the error
    // mocks make the pushed-check fail closed → pushed=true). Confirm the
    // matching token per message so the underlying git op runs and throws,
    // which is what this property asserts gets toasted.
    writableWindow().showWarningMessage = ((message: string): Promise<string | undefined> =>
      Promise.resolve(/reword/i.test(message) ? 'Reword Anyway' : 'Drop')) as unknown as (
      message: string,
      ...items: unknown[]
    ) => Promise<string | undefined>;
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  // Feature: git-graph-context-menu, Property 5: Error handling shows notification
  describe('Property 5: Error handling shows notification', () => {
    /**
     *
     * For any action where the underlying git operation throws an error,
     * the CommitContextMenuCommands handler should call
     * vscode.window.showErrorMessage with a message containing the error description.
     */
    it('shows error notification containing the error message for any failing action', async () => {
      await fc.assert(
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

            // Pass the test's random hashes as commitNodes (each with
            // parentCount=1) so the multi-commit createPatch path
            // proceeds past the stale-selection check; the gitCli mock
            // will throw and our catch surfaces the sanitised toast.
            // parentCount=1 makes the range-form branch run — a single
            // git invocation.
            const commitNodes = commitHashes.map((h) => ({ hash: h, parentCount: 1 }));
            await commands._handleAction(action, commitHashes, commitNodes);

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
