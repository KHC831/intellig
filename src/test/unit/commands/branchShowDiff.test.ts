/**
 * Unit tests for BranchContextMenuCommands._handleShowDiffWithWorkingTree.
 *
 * Covers the T2-01 / BUG-17 fix:
 *   - Empty change set → showInformationMessage, no vscode.diff calls.
 *   - Single changed file selected → exactly 1 vscode.diff tab with the correct
 *     URI shape (`intellig-git:<path>?<ref>` on the left, on-disk working-tree
 *     file on the right).
 *   - Multi-file select → 1 vscode.diff tab per selection.
 *   - User cancels the QuickPick (returns `undefined`) → no diff, no toast.
 *   - User accepts with empty selection → same no-op path.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BranchContextMenuCommands } from '../../../commands/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../services/BranchTreeProvider';
import {
  IBranch,
  IGitService,
  IRefDiffFile,
  IRepository,
} from '../../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface DiffCall {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  title: string;
}

interface TestHarness {
  commands: BranchContextMenuCommands;
  item: BranchTreeItem;
  diffCalls: DiffCall[];
  infoMessages: string[];
  errorMessages: string[];
  quickPickInvocations: number;
  restore: () => void;
}

function makeMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

/**
 * Create a minimal IGitService with just the bits `_handleShowDiffWithWorkingTree`
 * uses: `onDidChangeRepository` (consumed by BranchTreeProvider) and
 * `getChangedFilesAgainstWorkingTree`.
 */
function makeGitService(changedFiles: IRefDiffFile[]): IGitService {
  const repoEmitter = new EventEmitter<IRepository>();
  const svc = {
    onDidChangeRepository: repoEmitter.event,
    getRepositories: () => [],
    getRepository: async (): Promise<IRepository | undefined> => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    getChangedFilesAgainstWorkingTree: async (
      _repo: IRepository,
      _ref: string
    ): Promise<IRefDiffFile[]> => changedFiles,
    dispose: () => {},
  } as unknown as IGitService;
  return svc;
}

function makeBranchItem(branchName = 'main', type: 'local' | 'remote' = 'local'): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type,
    commit: 'abc1234567890',
    isHead: false,
  };
  return new BranchTreeItem(
    branchName,
    0 /* TreeItemCollapsibleState.None */,
    type === 'local' ? 'local-branch' : 'remote-branch',
    branch,
    undefined,
    false
  );
}

/**
 * Build a harness that stubs all window/commands surfaces the handler touches.
 * Pass a `quickPickResponder` that decides what `showQuickPick` returns when
 * called — this simulates user interaction.
 */
function makeHarness(opts: {
  changedFiles: IRefDiffFile[];
  /** Return value for showQuickPick — undefined = user cancelled. */
  quickPickResponder: (
    items: readonly (vscode.QuickPickItem & { file: IRefDiffFile })[]
  ) => unknown;
  branchName?: string;
  branchType?: 'local' | 'remote';
}): TestHarness {
  const repo = makeMockRepo();
  const gitService = makeGitService(opts.changedFiles);
  const provider = new BranchTreeProvider(gitService);
  provider.getRepository = (): IRepository => repo;

  const commands = new BranchContextMenuCommands(gitService, provider);
  const item = makeBranchItem(opts.branchName ?? 'main', opts.branchType ?? 'local');

  // Stub vscode.commands.executeCommand and record vscode.diff invocations.
  const diffCalls: DiffCall[] = [];
  const originalExecuteCommand = vscode.commands.executeCommand;
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

  // Stub window message APIs to capture calls.
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const originalInfo = vscode.window.showInformationMessage;
  const originalError = vscode.window.showErrorMessage;
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ): Promise<string | undefined> => {
    infoMessages.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    m: string
  ): Promise<string | undefined> => {
    errorMessages.push(m);
    return undefined;
  };

  // Stub showQuickPick — delegate to the provided responder.
  let quickPickInvocations = 0;
  const originalQuickPick = vscode.window.showQuickPick;
  (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
    items: unknown
  ): Promise<unknown> => {
    quickPickInvocations++;
    const resolvedItems = (await Promise.resolve(items)) as readonly (vscode.QuickPickItem & {
      file: IRefDiffFile;
    })[];
    return opts.quickPickResponder(resolvedItems);
  };

  const restore = (): void => {
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      originalExecuteCommand;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      originalInfo;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = originalError;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
  };

  return {
    commands,
    item,
    diffCalls,
    infoMessages,
    errorMessages,
    // wrap the counter in a getter-like closure via a tiny proxy object for convenience
    get quickPickInvocations(): number {
      return quickPickInvocations;
    },
    restore,
  } as TestHarness;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BranchContextMenuCommands._handleShowDiffWithWorkingTree (T2-01 / BUG-17)', () => {
  describe('empty change set', () => {
    it('shows an information message and issues no vscode.diff calls', async () => {
      const harness = makeHarness({
        changedFiles: [],
        quickPickResponder: () => undefined,
        branchName: 'feature/x',
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(
          harness.diffCalls.length,
          0,
          'vscode.diff must not be called when there are no changed files'
        );
        assert.strictEqual(harness.quickPickInvocations, 0, 'QuickPick must not be shown');
        assert.strictEqual(harness.infoMessages.length, 1, 'one info toast expected');
        assert.ok(
          harness.infoMessages[0].includes('feature/x'),
          `info toast should mention the branch ref, got: "${harness.infoMessages[0]}"`
        );
        assert.ok(
          harness.infoMessages[0].toLowerCase().includes('no changes'),
          `info toast should say "no changes", got: "${harness.infoMessages[0]}"`
        );
        assert.strictEqual(harness.errorMessages.length, 0, 'no error toast');
      } finally {
        harness.restore();
      }
    });
  });

  describe('single-file selection', () => {
    it('opens exactly one vscode.diff tab with the correct URIs and title', async () => {
      const changed: IRefDiffFile[] = [{ path: 'src/foo.ts', status: 'M' }];
      const harness = makeHarness({
        changedFiles: changed,
        // Simulate user picking the single item (canPickMany: true → array return).
        quickPickResponder: (items) => [items[0]],
        branchName: 'main',
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(harness.quickPickInvocations, 1, 'QuickPick shown exactly once');
        assert.strictEqual(harness.diffCalls.length, 1, 'vscode.diff called exactly once');

        const call = harness.diffCalls[0];

        // Left URI: intellig-git:<path>?<ref>  (query-encoded ref so branch names
        // with `/` or `#` don't break parsing).
        assert.strictEqual(
          call.leftUri.scheme,
          'file', // our mock Uri.parse stores everything under `file:`; we assert on toString instead
          'mock Uri.parse returns `file` scheme; the meaningful check is toString()'
        );
        const leftAsString = call.leftUri.toString();
        assert.ok(
          leftAsString.includes('intellig-git:src/foo.ts'),
          `left URI should be the intellig-git path, got: "${leftAsString}"`
        );
        assert.ok(
          leftAsString.includes('main'),
          `left URI should embed the branch ref, got: "${leftAsString}"`
        );

        // Right URI: on-disk path to the file under the repo root.
        assert.ok(
          call.rightUri.fsPath.includes('/test-repo'),
          `right URI should live under the repo root, got: "${call.rightUri.fsPath}"`
        );
        assert.ok(
          call.rightUri.fsPath.endsWith('src/foo.ts'),
          `right URI should point at the working-tree file path, got: "${call.rightUri.fsPath}"`
        );

        // Title: <basename> (<ref> ↔ Working Tree)
        assert.ok(
          call.title.includes('foo.ts'),
          `title should include the file basename, got: "${call.title}"`
        );
        assert.ok(
          call.title.includes('main'),
          `title should include the branch ref, got: "${call.title}"`
        );
        assert.ok(
          call.title.includes('Working Tree'),
          `title should mention "Working Tree", got: "${call.title}"`
        );

        assert.strictEqual(harness.infoMessages.length, 0);
        assert.strictEqual(harness.errorMessages.length, 0);
      } finally {
        harness.restore();
      }
    });
  });

  describe('multi-file selection', () => {
    it('opens one vscode.diff tab per selected file', async () => {
      const changed: IRefDiffFile[] = [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'A' },
        { path: 'src/c.ts', status: 'D' },
      ];
      const harness = makeHarness({
        changedFiles: changed,
        // User picks the first two (a.ts and b.ts); skips c.ts.
        quickPickResponder: (items) => [items[0], items[1]],
        branchName: 'develop',
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(harness.diffCalls.length, 2, 'one vscode.diff call per selected file');

        const paths = harness.diffCalls.map((c) => c.rightUri.fsPath);
        assert.ok(
          paths.some((p) => p.endsWith('src/a.ts')),
          'a.ts expected in diff calls'
        );
        assert.ok(
          paths.some((p) => p.endsWith('src/b.ts')),
          'b.ts expected in diff calls'
        );
        assert.ok(
          !paths.some((p) => p.endsWith('src/c.ts')),
          'c.ts should NOT have been diffed (not selected)'
        );

        // Each title should include the branch ref.
        for (const call of harness.diffCalls) {
          assert.ok(
            call.title.includes('develop'),
            `every diff tab title should include the branch ref, got: "${call.title}"`
          );
        }

        assert.strictEqual(harness.infoMessages.length, 0);
        assert.strictEqual(harness.errorMessages.length, 0);
      } finally {
        harness.restore();
      }
    });
  });

  describe('user cancels the QuickPick', () => {
    it('issues no vscode.diff call and no toast when user presses Esc (undefined)', async () => {
      const changed: IRefDiffFile[] = [{ path: 'src/a.ts', status: 'M' }];
      const harness = makeHarness({
        changedFiles: changed,
        quickPickResponder: () => undefined,
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(harness.quickPickInvocations, 1, 'QuickPick must still have been shown');
        assert.strictEqual(harness.diffCalls.length, 0, 'no diff tabs on cancel');
        assert.strictEqual(harness.infoMessages.length, 0, 'no info toast on cancel');
        assert.strictEqual(harness.errorMessages.length, 0, 'no error toast on cancel');
      } finally {
        harness.restore();
      }
    });

    it('issues no vscode.diff call when user confirms an empty selection (empty array)', async () => {
      const changed: IRefDiffFile[] = [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'A' },
      ];
      const harness = makeHarness({
        changedFiles: changed,
        quickPickResponder: () => [],
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(harness.diffCalls.length, 0);
        assert.strictEqual(harness.infoMessages.length, 0);
        assert.strictEqual(harness.errorMessages.length, 0);
      } finally {
        harness.restore();
      }
    });
  });

  describe('remote branch ref', () => {
    it('works with a remote-qualified ref like `origin/main`', async () => {
      const changed: IRefDiffFile[] = [{ path: 'README.md', status: 'M' }];
      const harness = makeHarness({
        changedFiles: changed,
        quickPickResponder: (items) => [items[0]],
        branchName: 'origin/main',
        branchType: 'remote',
      });
      try {
        await (
          harness.commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(harness.item);

        assert.strictEqual(harness.diffCalls.length, 1);
        const call = harness.diffCalls[0];
        // The ref is query-encoded (`origin%2Fmain`) — verify the decoded form matches.
        const leftAsString = call.leftUri.toString();
        assert.ok(
          leftAsString.includes('origin%2Fmain') || leftAsString.includes('origin/main'),
          `left URI should embed the remote-qualified ref, got: "${leftAsString}"`
        );
        assert.ok(
          call.title.includes('origin/main'),
          `title should include the raw ref, got: "${call.title}"`
        );
      } finally {
        harness.restore();
      }
    });
  });

  describe('getChangedFilesAgainstWorkingTree throws', () => {
    it('surfaces the error via showErrorMessage and opens no diff tabs', async () => {
      const repo = makeMockRepo();
      const repoEmitter = new EventEmitter<IRepository>();
      const gitService = {
        onDidChangeRepository: repoEmitter.event,
        getRepositories: () => [],
        getRepository: async () => undefined,
        getBranches: async () => [],
        getTags: async () => [],
        getChangedFilesAgainstWorkingTree: async (): Promise<IRefDiffFile[]> => {
          throw new Error('git exec failed');
        },
        dispose: () => {},
      } as unknown as IGitService;
      const provider = new BranchTreeProvider(gitService);
      provider.getRepository = (): IRepository => repo;
      const commands = new BranchContextMenuCommands(gitService, provider);
      const item = makeBranchItem('main', 'local');

      const diffCalls: DiffCall[] = [];
      const originalExecuteCommand = vscode.commands.executeCommand;
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
      const errorMessages: string[] = [];
      const originalError = vscode.window.showErrorMessage;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
        m: string
      ): Promise<string | undefined> => {
        errorMessages.push(m);
        return undefined;
      };

      try {
        await (
          commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(item);

        assert.strictEqual(diffCalls.length, 0, 'no diff tabs on failure');
        assert.strictEqual(errorMessages.length, 1, 'one error toast');
        assert.ok(
          errorMessages[0].toLowerCase().includes('failed to list changed files'),
          `error toast should say "failed to list changed files", got: "${errorMessages[0]}"`
        );
        assert.ok(
          errorMessages[0].includes('git exec failed'),
          `error toast should include the underlying message, got: "${errorMessages[0]}"`
        );
      } finally {
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
          originalExecuteCommand;
        (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
          originalError;
      }
    });
  });

  describe('GitService without the capability', () => {
    it('shows an error if `getChangedFilesAgainstWorkingTree` is not implemented', async () => {
      const repo = makeMockRepo();
      const repoEmitter = new EventEmitter<IRepository>();
      const gitService = {
        onDidChangeRepository: repoEmitter.event,
        getRepositories: () => [],
        getRepository: async () => undefined,
        getBranches: async () => [],
        getTags: async () => [],
        dispose: () => {},
        // getChangedFilesAgainstWorkingTree intentionally omitted.
      } as unknown as IGitService;
      const provider = new BranchTreeProvider(gitService);
      provider.getRepository = (): IRepository => repo;
      const commands = new BranchContextMenuCommands(gitService, provider);
      const item = makeBranchItem('main', 'local');

      const errorMessages: string[] = [];
      const originalError = vscode.window.showErrorMessage;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
        m: string
      ): Promise<string | undefined> => {
        errorMessages.push(m);
        return undefined;
      };

      try {
        await (
          commands as unknown as {
            _handleShowDiffWithWorkingTree: (i: BranchTreeItem) => Promise<void>;
          }
        )._handleShowDiffWithWorkingTree(item);

        assert.strictEqual(errorMessages.length, 1);
        assert.ok(
          errorMessages[0].toLowerCase().includes('does not support'),
          `error should mention capability gap, got: "${errorMessages[0]}"`
        );
      } finally {
        (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
          originalError;
      }
    });
  });
});
