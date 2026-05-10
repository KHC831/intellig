/**
 * Property-based tests for Show Diff with Working Tree command handler.
 *
 * Feature: branch-context-menu, Property 5: Show Diff uses the correct branch
 * reference and opens one `vscode.diff` tab per user-selected file.
 *
 * History:
 *  - Pre-T2-01: handler opened a single whole-repo diff against a synthetic
 *    `git-branch://<ref>` URI. The old property tests asserted "exactly one
 *    vscode.diff call" and a URI path containing the branch ref.
 *  - Post-T2-01 (BUG-17): the handler lists changed files via
 *    `GitService.getChangedFilesAgainstWorkingTree`, shows a multi-select
 *    QuickPick, and for each pick opens a `vscode.diff` tab with
 *      left  = `intellig-git:<filePath>?<encodeURIComponent(branchRef)>`
 *      right = `vscode.Uri.file(<repoRoot>/<filePath>)`
 *      title = `<basename> (<branchRef> ↔ Working Tree)`
 *
 * The properties here assert the T2-01 contract. Three classes of invariant:
 *   (a) Single-file selection → exactly one vscode.diff call with the correct
 *       URI/title shape.
 *   (b) Multi-file selection → N vscode.diff calls, one per pick, each using
 *       the same branch ref.
 *   (c) URI construction uses the `intellig-git:` scheme (never the legacy
 *       `git-branch://`).
 *
 * NOTE: every `it()` now returns the result of `fc.assert(…)` so Mocha awaits
 * the asyncProperty. Without the `return`, property failures were silently
 * discarded (mocha saw a synchronous `undefined` return and passed). Flagged by
 * coder-T1-10 during T2-01.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
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
  IRefDiffFile,
} from '../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
      ),
      { minLength: 1, maxLength: 15 }
    )
    .filter((s) => !s.startsWith('-') && !s.startsWith('.') && !s.endsWith('.'));
}

/**
 * Generate a valid local branch name (e.g., "feature/my-branch", "main").
 */
function arbitraryLocalBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((s) => s.length > 0 && !s.endsWith('/') && !s.includes('//'));
}

/**
 * Generate a valid remote name (e.g., "origin", "upstream").
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
 * Generate a valid remote branch ref (e.g., "origin/main", "upstream/feature/branch").
 */
function arbitraryRemoteBranchRef(): fc.Arbitrary<string> {
  return fc
    .tuple(arbitraryRemoteName(), arbitraryLocalBranchName())
    .map(([remote, branch]) => `${remote}/${branch}`);
}

/**
 * Generate a valid repo-relative file path (single path segment or nested).
 */
function arbitraryFilePath(): fc.Arbitrary<string> {
  const segment = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
      ),
      { minLength: 1, maxLength: 10 }
    )
    .filter((s) => s.length > 0 && !s.startsWith('.') && !s.endsWith('.'));
  return fc
    .array(segment, { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((s) => s.length > 0 && !s.includes('//'));
}

/**
 * Generate a small non-empty list of distinct file paths (so multi-select
 * scenarios have something to pick).
 */
function arbitraryDistinctFileList(): fc.Arbitrary<IRefDiffFile[]> {
  return fc
    .uniqueArray(arbitraryFilePath(), { minLength: 1, maxLength: 5, selector: (p) => p })
    .map((paths) =>
      paths.map((p, i) => ({
        path: p,
        status: (['M', 'A', 'D'] as const)[i % 3],
      }))
    );
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a mock IGitService that returns the supplied changed-file list from
 * `getChangedFilesAgainstWorkingTree`. Other methods are no-op stubs.
 */
function createMockGitService(changedFiles: IRefDiffFile[]): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();

  return {
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
    getChangedFilesAgainstWorkingTree: async () => changedFiles,
    dispose: () => {},
  } as unknown as IGitService;
}

/**
 * Create a mock BranchTreeProvider that returns a fixed mock repository.
 */
function createMockBranchTreeProvider(gitService: IGitService): BranchTreeProvider {
  const provider = new BranchTreeProvider(gitService);

  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  provider.getRepository = () => mockRepo;
  return provider;
}

/**
 * Create a BranchTreeItem for the given branch name and type.
 */
function createBranchTreeItem(
  branchName: string,
  type: 'local' | 'remote' = 'local'
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type,
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };

  const itemType = type === 'local' ? 'local-branch' : 'remote-branch';

  return new BranchTreeItem(
    branchName,
    0, // TreeItemCollapsibleState.None
    itemType,
    branch,
    undefined,
    false
  );
}

/**
 * Captured `vscode.diff` call.
 */
interface DiffCall {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  title: string;
}

/**
 * Install stubs for `vscode.commands.executeCommand` and
 * `vscode.window.showQuickPick`. Returns a list of captured diff calls and a
 * restore function. `quickPickResponder` decides what the QuickPick resolves
 * to (simulating user interaction).
 */
function installStubs(
  quickPickResponder: (items: readonly (vscode.QuickPickItem & { file: IRefDiffFile })[]) => unknown
): { diffCalls: DiffCall[]; restore: () => void } {
  const diffCalls: DiffCall[] = [];
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalInfo = vscode.window.showInformationMessage;
  const originalError = vscode.window.showErrorMessage;

  (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
    command: string,
    ...args: unknown[]
  ): Promise<undefined> => {
    if (command === 'vscode.diff') {
      diffCalls.push({
        leftUri: args[0] as vscode.Uri,
        rightUri: args[1] as vscode.Uri,
        title: args[2] as string,
      });
    }
    return undefined;
  };

  (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
    items: unknown
  ): Promise<unknown> => {
    const resolved = (await Promise.resolve(items)) as readonly (vscode.QuickPickItem & {
      file: IRefDiffFile;
    })[];
    return quickPickResponder(resolved);
  };

  // Swallow info / error toasts so property-test output stays clean.
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
    async (): Promise<string | undefined> => undefined;
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (): Promise<
    string | undefined
  > => undefined;

  const restore = (): void => {
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      originalExecuteCommand;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      originalInfo;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = originalError;
  };

  return { diffCalls, restore };
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Show Diff Property Tests (T2-01 per-file flow)', () => {
  describe('Property 5: Show Diff uses correct branch reference (single-file select)', () => {
    /**
     * For any branch ref, when Show Diff is invoked and the user picks a
     * single changed file, exactly one `vscode.diff` tab opens. The left URI
     * must use the `intellig-git:` scheme and embed the branch ref (URL-encoded).
     * The title must include both the file's basename and the raw branch ref.
     */
    it('opens exactly one vscode.diff tab for a single-file selection (local branch)', () => {
      return fc.assert(
        fc.asyncProperty(
          arbitraryLocalBranchName(),
          arbitraryFilePath(),
          async (branchName, filePath) => {
            const changedFiles: IRefDiffFile[] = [{ path: filePath, status: 'M' }];
            const { diffCalls, restore } = installStubs((items) => [items[0]]);
            try {
              const gitService = createMockGitService(changedFiles);
              const provider = createMockBranchTreeProvider(gitService);
              const commands = new BranchContextMenuCommands(gitService, provider);
              const item = createBranchTreeItem(branchName, 'local');

              await (
                commands as unknown as {
                  _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
                }
              )._handleShowDiffWithWorkingTree(item);

              assert.strictEqual(
                diffCalls.length,
                1,
                `Expected exactly 1 vscode.diff call, got ${diffCalls.length}`
              );

              const call = diffCalls[0];

              // Left URI embeds the intellig-git scheme + file path + branch ref.
              const leftAsString = call.leftUri.toString();
              assert.ok(
                leftAsString.includes(`intellig-git:${filePath}`),
                `Left URI should embed the intellig-git path, got: "${leftAsString}"`
              );
              // Ref is URL-encoded, so we accept either the raw or encoded form.
              const encoded = encodeURIComponent(branchName);
              assert.ok(
                leftAsString.includes(encoded) || leftAsString.includes(branchName),
                `Left URI should embed the branch ref (raw or encoded), got: "${leftAsString}"`
              );

              // Right URI points at the working-tree copy of the same file.
              assert.ok(
                call.rightUri.fsPath.endsWith(filePath),
                `Right URI should point at the working-tree file path, got: "${call.rightUri.fsPath}"`
              );

              // Title contains basename + raw branch ref.
              const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
              assert.ok(
                call.title.includes(basename),
                `Title should include the file basename "${basename}", got: "${call.title}"`
              );
              assert.ok(
                call.title.includes(branchName),
                `Title should include the raw branch ref "${branchName}", got: "${call.title}"`
              );
            } finally {
              restore();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('opens exactly one vscode.diff tab for a single-file selection (remote branch)', () => {
      return fc.assert(
        fc.asyncProperty(
          arbitraryRemoteBranchRef(),
          arbitraryFilePath(),
          async (branchRef, filePath) => {
            const changedFiles: IRefDiffFile[] = [{ path: filePath, status: 'A' }];
            const { diffCalls, restore } = installStubs((items) => [items[0]]);
            try {
              const gitService = createMockGitService(changedFiles);
              const provider = createMockBranchTreeProvider(gitService);
              const commands = new BranchContextMenuCommands(gitService, provider);
              const item = createBranchTreeItem(branchRef, 'remote');

              await (
                commands as unknown as {
                  _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
                }
              )._handleShowDiffWithWorkingTree(item);

              assert.strictEqual(
                diffCalls.length,
                1,
                `Expected exactly 1 vscode.diff call, got ${diffCalls.length}`
              );

              const leftAsString = diffCalls[0].leftUri.toString();
              // Remote refs have `/` which must be URL-encoded in the query.
              const encoded = encodeURIComponent(branchRef);
              assert.ok(
                leftAsString.includes(encoded) || leftAsString.includes(branchRef),
                `Left URI should embed the remote ref (raw or encoded), got: "${leftAsString}"`
              );
              // Title keeps the raw ref (human readable).
              assert.ok(
                diffCalls[0].title.includes(branchRef),
                `Title should include the raw remote ref "${branchRef}", got: "${diffCalls[0].title}"`
              );
            } finally {
              restore();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5b: N vscode.diff calls for N-file selection', () => {
    /**
     * For any non-empty list of distinct changed files, when the user picks
     * all of them in the multi-select QuickPick, exactly N `vscode.diff`
     * tabs open (one per pick) and every tab embeds the SAME branch ref.
     *
     * (Pre-T2-01 this test asserted "exactly one call". That invariant no
     * longer holds because the QuickPick is multi-select.)
     */
    it('opens one vscode.diff tab per selected file, all using the same branch ref', () => {
      return fc.assert(
        fc.asyncProperty(
          arbitraryLocalBranchName(),
          arbitraryDistinctFileList(),
          async (branchName, changedFiles) => {
            // User picks every item.
            const { diffCalls, restore } = installStubs((items) => [...items]);
            try {
              const gitService = createMockGitService(changedFiles);
              const provider = createMockBranchTreeProvider(gitService);
              const commands = new BranchContextMenuCommands(gitService, provider);
              const item = createBranchTreeItem(branchName, 'local');

              await (
                commands as unknown as {
                  _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
                }
              )._handleShowDiffWithWorkingTree(item);

              assert.strictEqual(
                diffCalls.length,
                changedFiles.length,
                `Expected ${changedFiles.length} vscode.diff call(s), got ${diffCalls.length}`
              );

              const expectedPaths = new Set(changedFiles.map((f) => f.path));
              const actualPaths = new Set<string>();

              for (const call of diffCalls) {
                // Every tab must embed the branch ref on the left side.
                const leftAsString = call.leftUri.toString();
                const encoded = encodeURIComponent(branchName);
                assert.ok(
                  leftAsString.includes(encoded) || leftAsString.includes(branchName),
                  `Every tab's left URI must embed the branch ref, got: "${leftAsString}"`
                );

                // Every tab's title must include the raw branch ref.
                assert.ok(
                  call.title.includes(branchName),
                  `Every tab title must include the branch ref, got: "${call.title}"`
                );

                // Collect the path from the right URI for coverage assertion.
                // Use exact relative-path match rather than endsWith() — otherwise
                // paths like ["V", "aV", "a"] produce non-deterministic matches
                // because "/test-repo/aV".endsWith("V") is true (surfaces only
                // under the 10x stress runner; fast-check shrinks to this shape).
                const rel = call.rightUri.fsPath.replace(/^\/test-repo[\\/]/, '');
                if (expectedPaths.has(rel)) {
                  actualPaths.add(rel);
                }
              }

              // We should have opened a diff for every file in the input.
              assert.strictEqual(
                actualPaths.size,
                expectedPaths.size,
                'every selected file should have an opened diff tab'
              );
            } finally {
              restore();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * Pinned regression: surfaced by the 10x property stress runner.
     * Input ["a", [{path:"V"}, {path:"aV"}, {path:"a"}]] caused the original
     * endsWith() matching loop to skip "aV" because "/test-repo/aV".endsWith("V")
     * is true and the inner for-loop broke on first hit. Fixed by matching on
     * the exact repo-relative path instead.
     */
    it('pinned: paths where one is a suffix of another are all counted', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant('a'),
          fc.constant<IRefDiffFile[]>([
            { path: 'V', status: 'M' },
            { path: 'aV', status: 'A' },
            { path: 'a', status: 'D' },
          ]),
          async (branchName, changedFiles) => {
            const { diffCalls, restore } = installStubs((items) => [...items]);
            try {
              const gitService = createMockGitService(changedFiles);
              const provider = createMockBranchTreeProvider(gitService);
              const commands = new BranchContextMenuCommands(gitService, provider);
              const item = createBranchTreeItem(branchName, 'local');
              await (
                commands as unknown as {
                  _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
                }
              )._handleShowDiffWithWorkingTree(item);
              assert.strictEqual(diffCalls.length, changedFiles.length);
              const expectedPaths = new Set(changedFiles.map((f) => f.path));
              const actualPaths = new Set<string>();
              for (const call of diffCalls) {
                const rel = call.rightUri.fsPath.replace(/^\/test-repo[\\/]/, '');
                if (expectedPaths.has(rel)) {
                  actualPaths.add(rel);
                }
              }
              assert.strictEqual(actualPaths.size, expectedPaths.size);
            } finally {
              restore();
            }
          }
        ),
        { numRuns: 1 }
      );
    });
  });

  describe('Property 5c: URI construction uses intellig-git scheme (never legacy git-branch://)', () => {
    /**
     * Guard against regression to the pre-T2-01 URI scheme. For any branch
     * ref and single-file selection, the left URI string must contain
     * `intellig-git:` and MUST NOT contain `git-branch://`.
     */
    it('left URI uses intellig-git: scheme, never git-branch://', () => {
      return fc.assert(
        fc.asyncProperty(
          arbitraryLocalBranchName(),
          arbitraryFilePath(),
          async (branchName, filePath) => {
            const changedFiles: IRefDiffFile[] = [{ path: filePath, status: 'M' }];
            const { diffCalls, restore } = installStubs((items) => [items[0]]);
            try {
              const gitService = createMockGitService(changedFiles);
              const provider = createMockBranchTreeProvider(gitService);
              const commands = new BranchContextMenuCommands(gitService, provider);
              const item = createBranchTreeItem(branchName, 'local');

              await (
                commands as unknown as {
                  _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
                }
              )._handleShowDiffWithWorkingTree(item);

              assert.strictEqual(diffCalls.length, 1);

              const leftAsString = diffCalls[0].leftUri.toString();
              assert.ok(
                leftAsString.includes('intellig-git:'),
                `Left URI should use the "intellig-git:" scheme, got: "${leftAsString}"`
              );
              assert.ok(
                !leftAsString.includes('git-branch://'),
                `Left URI must NOT use the legacy "git-branch://" scheme, got: "${leftAsString}"`
              );
            } finally {
              restore();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
