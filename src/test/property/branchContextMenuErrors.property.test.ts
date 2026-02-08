/**
 * Property-based tests for error notifications and conflict notifications.
 *
 * Feature: branch-context-menu, Property 8: Git errors produce error notifications
 * Feature: branch-context-menu, Property 9: Conflict results produce warning notifications
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BranchContextMenuCommands } from '../../commands/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../services/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IBasicRebaseResult,
} from '../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

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
      { minLength: 1, maxLength: 100 }
    )
    .filter(
      (s) =>
        !s.toUpperCase().includes('CONFLICT') &&
        !s.includes('would be overwritten') &&
        !s.includes('Please commit your changes')
    );
}

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 15 }
    )
    .filter((s) => !s.startsWith('-') && !s.startsWith('_'));
}

/**
 * Generate a valid branch name with optional path segments.
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((s) => s.length > 0 && !s.endsWith('/') && !s.includes('//'));
}

/**
 * Generate a valid remote name.
 */
function arbitraryRemoteName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 10 }
    )
    .filter((s) => s.length > 0 && !s.startsWith('-') && !s.startsWith('_'));
}

/**
 * Generate a random file path for conflict arrays.
 */
function arbitraryFilePath(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join('/'))
    .map((p) => `${p}.ts`);
}

/**
 * Generate a random array of conflict file paths (1-20 files).
 */
function arbitraryConflictArray(): fc.Arbitrary<string[]> {
  return fc.array(arbitraryFilePath(), { minLength: 1, maxLength: 20 });
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Tracking wrapper for vscode.window message functions.
 * Records all calls so we can assert on them.
 */
interface MessageTracker {
  calls: Array<{ message: string; items: string[] }>;
  reset(): void;
}

/**
 * Install a tracking stub on vscode.window.showErrorMessage.
 * Returns a tracker that records all calls.
 */
function installErrorMessageTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };

  (vscode.window as any).showErrorMessage = async (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return undefined;
  };

  return tracker;
}

/**
 * Install a tracking stub on vscode.window.showWarningMessage.
 * Returns a tracker that records all calls.
 */
function installWarningMessageTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };

  (vscode.window as any).showWarningMessage = async (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return undefined;
  };

  return tracker;
}

/**
 * Restore the original vscode.window message functions.
 */
function restoreMessageFunctions(): void {
  (vscode.window as any).showErrorMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    return undefined;
  };

  (vscode.window as any).showWarningMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    return undefined;
  };

  (vscode.window as any).showInformationMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    return undefined;
  };
}

/**
 * Create a mock IGitService where specific methods throw errors.
 */
function createErrorThrowingMockGitService(
  overrides: Partial<IGitService> = {}
): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();

  const service = {
    onDidChangeRepository: repoChangeEmitter.event,
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
    ...overrides,
  } as IGitService;

  return service;
}

/**
 * Create a mock BranchTreeProvider that returns a mock repository.
 */
function createMockBranchTreeProvider(
  gitService: IGitService,
  currentBranchName: string = 'main'
): BranchTreeProvider {
  const provider = new BranchTreeProvider(gitService);

  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: `refs/heads/${currentBranchName}`, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  provider.getRepository = () => mockRepo;
  return provider;
}

/**
 * Create a BranchTreeItem for a local branch with an upstream.
 */
function createLocalBranchTreeItem(
  branchName: string,
  upstream?: { remote: string; name: string }
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
    upstream,
  };

  return new BranchTreeItem(branchName, 0, 'local-branch', branch, undefined, false);
}

/**
 * Create a BranchTreeItem for a remote branch.
 */
function createRemoteBranchTreeItem(fullRef: string): BranchTreeItem {
  const branch: IBranch = {
    name: fullRef,
    type: 'remote',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };

  return new BranchTreeItem(fullRef, 0, 'remote-branch', branch, undefined, false);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Error and Conflict Notification Property Tests', () => {
  let errorTracker: MessageTracker;
  let warningTracker: MessageTracker;

  beforeEach(() => {
    errorTracker = installErrorMessageTracker();
    warningTracker = installWarningMessageTracker();
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  // ─── Property 8: Git errors produce error notifications ───────────────────

  describe('Property 8: Git errors produce error notifications', () => {
    /**
     *
     * For any command handler, when the underlying git service throws an error,
     * the handler SHALL display an error notification containing the error message text.
     */

    it('_handleUpdate shows error notification when fetch throws', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryRemoteName(),
          arbitraryErrorMessage(),
          async (branchName, remoteName, errorMsg) => {
            errorTracker.reset();

            const gitService = createErrorThrowingMockGitService({
              fetch: async () => {
                throw new Error(errorMsg);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const item = createLocalBranchTreeItem(branchName, {
              remote: remoteName,
              name: branchName,
            });

            await (commands as any)._handleUpdate(item);

            assert.ok(
              errorTracker.calls.length > 0,
              'showErrorMessage should have been called'
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

    it('_handlePush shows error notification when push throws', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryRemoteName(),
          arbitraryErrorMessage(),
          async (branchName, remoteName, errorMsg) => {
            errorTracker.reset();

            const gitService = createErrorThrowingMockGitService({
              push: async () => {
                throw new Error(errorMsg);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const item = createLocalBranchTreeItem(branchName, {
              remote: remoteName,
              name: branchName,
            });

            await (commands as any)._handlePush(item);

            assert.ok(
              errorTracker.calls.length > 0,
              'showErrorMessage should have been called'
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

    it('_handlePullUsingRebase shows error notification when pull throws', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryRemoteName(),
          arbitraryBranchName(),
          arbitraryErrorMessage(),
          async (remoteName, branchName, errorMsg) => {
            errorTracker.reset();

            const gitService = createErrorThrowingMockGitService({
              pull: async () => {
                throw new Error(errorMsg);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const fullRef = `${remoteName}/${branchName}`;
            const item = createRemoteBranchTreeItem(fullRef);

            await (commands as any)._handlePullUsingRebase(item);

            assert.ok(
              errorTracker.calls.length > 0,
              'showErrorMessage should have been called'
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

    it('_handlePullUsingMerge shows error notification when pull throws', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryRemoteName(),
          arbitraryBranchName(),
          arbitraryErrorMessage(),
          async (remoteName, branchName, errorMsg) => {
            errorTracker.reset();

            const gitService = createErrorThrowingMockGitService({
              pull: async () => {
                throw new Error(errorMsg);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const fullRef = `${remoteName}/${branchName}`;
            const item = createRemoteBranchTreeItem(fullRef);

            await (commands as any)._handlePullUsingMerge(item);

            assert.ok(
              errorTracker.calls.length > 0,
              'showErrorMessage should have been called'
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

  // ─── Property 9: Conflict results produce warning notifications ─────────────

  describe('Property 9: Conflict results produce warning notifications', () => {
    /**
     *
     * For any merge or rebase result that contains a non-empty conflicts array,
     * the handler SHALL display a warning notification that includes the count
     * of conflicted files.
     */

    it('_handleCheckoutAndRebase shows warning with conflict count when rebaseBranch returns conflicts', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryBranchName(),
          arbitraryConflictArray(),
          async (targetBranch, currentBranch, conflictFiles) => {
            warningTracker.reset();
            errorTracker.reset();

            const gitService = createErrorThrowingMockGitService({
              checkout: async () => {},
              rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
                success: false,
                conflicts: conflictFiles,
              }),
            });
            const branchTreeProvider = createMockBranchTreeProvider(
              gitService,
              currentBranch
            );
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const item = createLocalBranchTreeItem(targetBranch);

            await (commands as any)._handleCheckoutAndRebase(item);

            assert.ok(
              warningTracker.calls.length > 0,
              'showWarningMessage should have been called for conflicts'
            );
            const calledMessage = warningTracker.calls[0].message;
            assert.ok(
              calledMessage.includes(String(conflictFiles.length)),
              `Warning notification "${calledMessage}" should contain the conflict count "${conflictFiles.length}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('_handlePullUsingRebase shows warning with conflict count when pull throws with CONFLICT markers', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryRemoteName(),
          arbitraryBranchName(),
          arbitraryConflictArray(),
          async (remoteName, branchName, conflictFiles) => {
            warningTracker.reset();
            errorTracker.reset();

            // Build an error message with CONFLICT markers, one per file
            const conflictMessage = conflictFiles
              .map((file) => `CONFLICT (content): Merge conflict in ${file}`)
              .join('\n');

            const gitService = createErrorThrowingMockGitService({
              pull: async () => {
                throw new Error(conflictMessage);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const fullRef = `${remoteName}/${branchName}`;
            const item = createRemoteBranchTreeItem(fullRef);

            await (commands as any)._handlePullUsingRebase(item);

            assert.ok(
              warningTracker.calls.length > 0,
              'showWarningMessage should have been called for conflicts'
            );
            const calledMessage = warningTracker.calls[0].message;
            assert.ok(
              calledMessage.includes(String(conflictFiles.length)),
              `Warning notification "${calledMessage}" should contain the conflict count "${conflictFiles.length}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('_handlePullUsingMerge shows warning with conflict count when pull throws with CONFLICT markers', () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryRemoteName(),
          arbitraryBranchName(),
          arbitraryConflictArray(),
          async (remoteName, branchName, conflictFiles) => {
            warningTracker.reset();
            errorTracker.reset();

            // Build an error message with CONFLICT markers, one per file
            const conflictMessage = conflictFiles
              .map((file) => `CONFLICT (content): Merge conflict in ${file}`)
              .join('\n');

            const gitService = createErrorThrowingMockGitService({
              pull: async () => {
                throw new Error(conflictMessage);
              },
            });
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            const fullRef = `${remoteName}/${branchName}`;
            const item = createRemoteBranchTreeItem(fullRef);

            await (commands as any)._handlePullUsingMerge(item);

            assert.ok(
              warningTracker.calls.length > 0,
              'showWarningMessage should have been called for conflicts'
            );
            const calledMessage = warningTracker.calls[0].message;
            assert.ok(
              calledMessage.includes(String(conflictFiles.length)),
              `Warning notification "${calledMessage}" should contain the conflict count "${conflictFiles.length}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
