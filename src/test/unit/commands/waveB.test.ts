/**
 * Wave B — Multi-commit safe ops (revert, cherry-pick, patch, copy).
 *
 * Subsections:
 *   B1 — Cherry-pick N (oldest-first)
 *   B2 — Revert N (newest-first)
 *   B3 — Create Patch from N
 *   B4 — Copy Hashes (N>=2 newline-joined) + Compare Versions (N=2 diff)
 *
 * Tests live alongside the existing `CommitContextMenuCommands.test.ts` so
 * the file-scoped `restoreMocks()` + `writableEnv()` shape stays consistent.
 *
 * The webview hands `commitHashes` to the host in NEWEST-FIRST display
 * order (the `commitContextMenuHashes` array is built from
 * `Array.from(querySelectorAll('.commit-row.selected'))`, which is DOM
 * order). The Wave A R4-3 chronological-direction WARNING applies to
 * any consumer that replays commits onto a branch — cherry-pick MUST
 * `.reverse()` before invoking git, revert MUST NOT.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commands/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../services/interfaces/IGitService';
import type { IRebaseService } from '../../../services/interfaces/IRebaseService';
import type { IMenuStateNode } from '../../../services/gitToolWindow/multiSelect';
import { Uri } from '../../mocks/vscode';
import { EventEmitter } from '../../mocks/vscode';
import type { GitCli } from '../../../utils/gitCli';
import { writableEnv, writableWindow, writableCommands } from '../../typed/windowStub';

// ─── Test scaffolding ────────────────────────────────────────────────────────

interface CallTracker {
  method: string;
  args: unknown[];
}

function createMockRepo(rootPath = '/test-repo'): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: {
      HEAD: {
        name: 'main',
        commit: 'abc1234567890abcdef',
        type: 0 as const /* Local */,
        upstream: undefined,
        ahead: 0,
        behind: 0,
      },
      refs: [],
      remotes: [],
      submodules: [],
      rebaseCommit: null,
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
    },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

function createMockGitService(
  _repo: IRepository,
  overrides?: Partial<IGitService>
): IGitService & { calls: CallTracker[] } {
  const calls: CallTracker[] = [];
  const service = {
    calls,
    getRepositories: () => [_repo],
    getActiveRepository: () => _repo,
    getCommits: async () => [],
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

function createMockRebaseService(): IRebaseService & { calls: CallTracker[] } {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  const calls: CallTracker[] = [];
  return {
    calls,
    startInteractiveRebase: async () => ({
      onto: '',
      originalBranch: '',
      commits: [],
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
  } as unknown as IRebaseService & { calls: CallTracker[] };
}

interface MockProvider extends GitToolWindowProvider {
  refreshCallCount: number;
  /**
   * Wave B R1 (TLB-H-2) + R2 (TLBR1-L-1): handlers no longer call
   * `getExtendedLogState`. The test sets the rendered order via
   * `setCommitOrder([...])` and the helper materialises a
   * `IMenuStateNode[]` (with parentCount=1 by default) for the third
   * arg of `_handleAction(action, hashes, commitNodes)`. Tests that
   * need parent-count = 0 (Senior H-2 initial-commit) construct the
   * commitNodes array inline.
   */
  setCommitOrder(hashes: string[]): void;
  /** Returns the IMenuStateNode list — newest-first, parentCount = 1 for every entry. */
  getCommitNodes(): IMenuStateNode[];
}

function createMockProvider(): MockProvider {
  let order: string[] = [];
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refreshCallCount: 0,
    refresh: function (this: MockProvider) {
      this.refreshCallCount++;
    },
    setCommitOrder(this: MockProvider, hashes: string[]) {
      order = hashes;
    },
    getCommitNodes(this: MockProvider): IMenuStateNode[] {
      return order.map((h) => ({ hash: h, parentCount: 1 }));
    },
  } as unknown as MockProvider;
}

type MockGitCli = GitCli & { calls: CallTracker[] };

function createMockGitCli(overrides?: {
  exec?: (...args: unknown[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    combined: string;
  }>;
}): MockGitCli {
  const calls: CallTracker[] = [];
  // Wrap the overridable exec so the call log is populated regardless
  // of which exec implementation is in use. Without this wrapper an
  // overrides.exec that doesn't push to `calls` would make assertions
  // like `gitCli.calls.find(c => c.method === 'exec' && ...)` empty.
  const exec = async (...args: unknown[]) => {
    calls.push({ method: 'exec', args });
    if (overrides?.exec) {
      return overrides.exec(...args);
    }
    return { exitCode: 0, stdout: 'patch content', stderr: '', combined: '' };
  };
  return {
    calls,
    exec,
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
  } as unknown as MockGitCli;
}

interface MessageRecord {
  message: string;
  items: string[];
}

function captureMessages(): { info: MessageRecord[]; error: MessageRecord[] } {
  const info: MessageRecord[] = [];
  const error: MessageRecord[] = [];
  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]) => {
    info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]) => {
    error.push({ message, items });
    return Promise.resolve(undefined);
  };
  return { info, error };
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showSaveDialog = () => Promise.resolve(undefined);
}

interface CommandsInternal {
  _gitCli: GitCli;
  /**
   * Wave B R1 (TLB-H-2) + R2 (TLBR1-L-1): commitNodes (the slim
   * `IMenuStateNode[]` newest-first projection) is threaded through
   * the dispatch event. Tests pass it as the third positional;
   * defaults to `[]` on the production signature so legacy single-
   * commit tests don't have to construct it.
   */
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
}

function makeCommands(opts: {
  repo: IRepository;
  gitService: IGitService;
  gitCli: GitCli;
  provider: GitToolWindowProvider;
}): CommitContextMenuCommands {
  const cmds = new CommitContextMenuCommands(
    opts.gitService,
    createMockRebaseService(),
    opts.provider
  );
  // Inject the gitCli by overriding the protected/private field. The
  // existing ContextMenu test does the same.
  (cmds as unknown as CommandsInternal)._gitCli = opts.gitCli;
  return cmds;
}

describe('Wave B — Multi-commit safe ops', () => {
  const repo = createMockRepo();
  const HASH_OLDEST = 'aaaa111111111111111111111111111111111111';
  const HASH_MIDDLE = 'bbbb222222222222222222222222222222222222';
  const HASH_NEWEST = 'cccc333333333333333333333333333333333333';
  const HASH_FAR = 'dddd444444444444444444444444444444444444';

  afterEach(() => {
    restoreMocks();
  });

  // ─── B1 — Cherry-pick N (oldest-first) ────────────────────────────────────
  describe('B1 — _handleCherryPick (N>=2 reverses to oldest-first)', () => {
    it('reverses newest-first input to oldest-first when calling gitService.cherryPick', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // Webview supplies hashes in newest-first DOM order:
      //   [NEWEST, MIDDLE, OLDEST]
      await (commands as unknown as CommandsInternal)._handleAction('cherryPick', [
        HASH_NEWEST,
        HASH_MIDDLE,
        HASH_OLDEST,
      ]);

      const call = gitService.calls.find((c) => c.method === 'cherryPick');
      assert.ok(call, 'expected gitService.cherryPick to be called');
      // gitService.cherryPick(repo, commits, options?) — args[1] is the array.
      const passed = call.args[1] as string[];
      assert.deepStrictEqual(
        passed,
        [HASH_OLDEST, HASH_MIDDLE, HASH_NEWEST],
        'cherry-pick must replay oldest-first'
      );
    });

    it('keeps single-commit cherry-pick unchanged (no reverse on N=1)', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('cherryPick', [HASH_NEWEST]);

      const call = gitService.calls.find((c) => c.method === 'cherryPick');
      assert.ok(call);
      const passed = call.args[1] as string[];
      assert.deepStrictEqual(passed, [HASH_NEWEST]);
    });

    it('reports N-of-M progress on success for multi-commit cherry-pick', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('cherryPick', [
        HASH_NEWEST,
        HASH_MIDDLE,
        HASH_OLDEST,
      ]);

      const info = messages.info.map((m) => m.message).join(' || ');
      assert.ok(/3/.test(info), `expected message to mention "3" commits; got: ${info}`);
    });
  });

  // ─── B2 — Revert N (newest-first) ─────────────────────────────────────────
  describe('B2 — _handleRevert (N>=2 keeps newest-first)', () => {
    it('passes hashes through in newest-first order', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('revert', [
        HASH_NEWEST,
        HASH_MIDDLE,
        HASH_OLDEST,
      ]);

      const call = gitService.calls.find((c) => c.method === 'revert');
      assert.ok(call, 'expected gitService.revert to be called');
      const passed = call.args[1] as string[];
      assert.deepStrictEqual(
        passed,
        [HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST],
        'revert must undo newest-first so the latest change is reverted first'
      );
    });
  });

  // ─── B3 — Create Patch from N ─────────────────────────────────────────────
  describe('B3 — _handleCreatePatch (N>=2)', () => {
    /**
     * The B3 contract:
     *   - User picks a directory once (vscode.window.showOpenDialog with
     *     canSelectFolders=true).
     *   - For contiguous selections, shell out to
     *     `git format-patch <oldest>^..<newest> -o <dir>`. This yields N
     *     numbered .patch files inside <dir>.
     *   - For non-contiguous selections, fall back to
     *     `git format-patch -o <dir> <h1> <h2> ...` (each hash → one patch).
     *
     * Single-commit behaviour is unchanged (legacy showSaveDialog flow).
     */

    it('uses oldest^..newest range when commit selection is contiguous', async () => {
      const provider = createMockProvider();
      // Display order (newest-first): NEWEST → MIDDLE → OLDEST → FAR
      provider.setCommitOrder([HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST, HASH_FAR]);
      const gitService = createMockGitService(repo);

      // Stub the directory picker.
      const w = writableWindow();
      w.showOpenDialog = () =>
        Promise.resolve([Uri.file('/tmp/patches')]) as unknown as Promise<vscode.Uri[]>;

      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          // Mock git format-patch: emit one filename per commit on stdout.
          return {
            exitCode: 0,
            stdout:
              '/tmp/patches/0001-foo.patch\n/tmp/patches/0002-bar.patch\n/tmp/patches/0003-baz.patch\n',
            stderr: '',
            combined: '',
          };
          void args;
        },
      });
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // Pick NEWEST + MIDDLE + OLDEST → contiguous (indices 0, 1, 2).
      // Wave B R1 (TLB-H-2) + R2 (TLBR1-L-1): commitNodes threaded
      // through the dispatch event, not read from the provider. The
      // helper materialises parentCount=1 for every entry so the range
      // form (`<oldest>^..<newest>`) is taken (Senior H-2 only switches
      // to positional when oldest has parentCount=0).
      await (commands as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST],
        provider.getCommitNodes()
      );

      const call = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.ok(call, 'expected git format-patch invocation');
      const argv = call.args[0] as string[];
      // Range form: oldest^..newest
      assert.ok(
        argv.some((a) => a === `${HASH_OLDEST}^..${HASH_NEWEST}`),
        `expected '${HASH_OLDEST}^..${HASH_NEWEST}' in argv; got ${JSON.stringify(argv)}`
      );
      // Output dir flag.
      const oIdx = argv.indexOf('-o');
      assert.ok(oIdx >= 0 && argv[oIdx + 1] === '/tmp/patches');
    });

    it('falls back to per-commit args when selection is non-contiguous', async () => {
      const provider = createMockProvider();
      // Display: NEWEST → MIDDLE → OLDEST → FAR
      provider.setCommitOrder([HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST, HASH_FAR]);
      const gitService = createMockGitService(repo);

      const w = writableWindow();
      w.showOpenDialog = () =>
        Promise.resolve([Uri.file('/tmp/patches')]) as unknown as Promise<vscode.Uri[]>;

      const gitCli = createMockGitCli({
        exec: async () => ({
          exitCode: 0,
          stdout: '/tmp/patches/0001-x.patch\n',
          stderr: '',
          combined: '',
        }),
      });
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // Pick NEWEST + OLDEST → gap at MIDDLE → non-contiguous.
      await (commands as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_OLDEST],
        provider.getCommitNodes()
      );

      const call = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.ok(call);
      const argv = call.args[0] as string[];
      // Should contain both hashes as positional args (in oldest-first order),
      // and NOT the range form.
      assert.ok(
        !argv.some((a) => /\^\.\./.test(a)),
        `expected no range form; got ${JSON.stringify(argv)}`
      );
      // Both hashes present; oldest-first.
      const oldestIdx = argv.indexOf(HASH_OLDEST);
      const newestIdx = argv.indexOf(HASH_NEWEST);
      assert.ok(oldestIdx >= 0 && newestIdx >= 0);
      assert.ok(oldestIdx < newestIdx, 'oldest-first ordering required for non-contiguous');
    });

    it('aborts silently when the user cancels the directory picker', async () => {
      const provider = createMockProvider();
      provider.setCommitOrder([HASH_NEWEST, HASH_MIDDLE]);
      const gitService = createMockGitService(repo);
      const w = writableWindow();
      w.showOpenDialog = () => Promise.resolve(undefined);
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_MIDDLE],
        provider.getCommitNodes()
      );

      const call = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.strictEqual(call, undefined, 'no git invocation when user cancels');
    });

    it('preserves single-commit behaviour (showSaveDialog + format-patch -1)', async () => {
      const provider = createMockProvider();
      provider.setCommitOrder([HASH_NEWEST]);
      const gitService = createMockGitService(repo);
      const w = writableWindow();
      let saveDialogShown = false;
      w.showSaveDialog = () => {
        saveDialogShown = true;
        return Promise.resolve(Uri.file('/tmp/single.patch'));
      };
      const gitCli = createMockGitCli({
        exec: async () => ({ exitCode: 0, stdout: 'patch content', stderr: '', combined: '' }),
      });
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('createPatch', [HASH_NEWEST]);

      assert.strictEqual(saveDialogShown, true, 'single-commit path uses showSaveDialog');
      const call = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.ok(call);
      const argv = call.args[0] as string[];
      assert.ok(argv.includes('-1'), 'single-commit format-patch must use -1 flag');
    });
  });

  // ─── B4 — Copy Hashes + Compare Versions ──────────────────────────────────
  describe('B4 — _handleCopyHash multi-commit + _handleCompareVersions', () => {
    it('copyHash on N>=2 joins hashes with newlines', async () => {
      let copied = '';
      writableEnv().clipboard = {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
        readText: () => Promise.resolve(''),
      };
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('copyHash', [
        HASH_NEWEST,
        HASH_MIDDLE,
        HASH_OLDEST,
      ]);

      assert.strictEqual(
        copied,
        [HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST].join('\n'),
        'multi-commit copyHash must produce a newline-joined string'
      );
    });

    it('copyHash on N=1 keeps the legacy single-hash behaviour', async () => {
      let copied = '';
      writableEnv().clipboard = {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
        readText: () => Promise.resolve(''),
      };
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      await (commands as unknown as CommandsInternal)._handleAction('copyHash', [HASH_NEWEST]);

      assert.strictEqual(
        copied,
        HASH_NEWEST,
        'single-commit copyHash is the bare hash, no newline'
      );
    });

    it('compareVersions opens the existing intellig-git diff machinery for a 2-commit pair', async () => {
      let lastCmd: { name: string; args: unknown[] } | undefined;
      const realExec = writableCommands().executeCommand;
      writableCommands().executeCommand = (name: string, ...args: unknown[]) => {
        lastCmd = { name, args };
        return Promise.resolve(undefined);
      };
      try {
        // Wave B R1 (TLB-M-1): compareVersions now uses
        // `git diff --name-only oldHash..newHash` directly, not
        // `getCommitDiff`/`getMultiCommitDiff`. Mock the gitCli so the
        // diff call returns a path on stdout.
        const gitService = createMockGitService(repo);
        const provider = createMockProvider();
        // Display: NEWEST → OLDEST. The 2-commit pair is in newest-first order.
        provider.setCommitOrder([HASH_NEWEST, HASH_OLDEST]);
        const gitCli = createMockGitCli({
          exec: async (...args: unknown[]) => {
            const argv = args[0] as string[];
            if (argv[0] === 'diff') {
              return { exitCode: 0, stdout: 'src/foo.ts\n', stderr: '', combined: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '', combined: '' };
          },
        });
        const commands = makeCommands({ repo, gitService, gitCli, provider });
        captureMessages();

        await (commands as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_NEWEST, HASH_OLDEST],
          provider.getCommitNodes()
        );

        assert.ok(lastCmd, 'expected vscode.commands.executeCommand to be called');
        assert.strictEqual(lastCmd.name, 'vscode.diff', 'must use vscode.diff for the comparison');
        // First two args are the LHS / RHS URIs. The mock's `Uri.parse`
        // stores everything under `file:` scheme — the meaningful
        // assertion is on the path (which holds the original
        // `intellig-git:<file>?<encodedHash>` string we pass in). See
        // `branchShowDiff.test.ts` for the same workaround.
        const lhs = lastCmd.args[0] as vscode.Uri;
        const rhs = lastCmd.args[1] as vscode.Uri;
        assert.ok(
          lhs.path.startsWith('intellig-git:') && lhs.path.includes(HASH_OLDEST),
          `LHS should reference intellig-git: scheme + oldest hash; got "${lhs.path}"`
        );
        assert.ok(
          rhs.path.startsWith('intellig-git:') && rhs.path.includes(HASH_NEWEST),
          `RHS should reference intellig-git: scheme + newest hash; got "${rhs.path}"`
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }
    });

    it('compareVersions is a no-op when commitHashes.length !== 2', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const commands = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();

      // N=1 — must not crash; N=3 — must not crash. Either path may surface
      // a toast; we just assert no exception escapes.
      await (commands as unknown as CommandsInternal)._handleAction('compareVersions', [
        HASH_NEWEST,
      ]);
      await (commands as unknown as CommandsInternal)._handleAction('compareVersions', [
        HASH_NEWEST,
        HASH_MIDDLE,
        HASH_OLDEST,
      ]);

      void messages;
    });
  });
});
