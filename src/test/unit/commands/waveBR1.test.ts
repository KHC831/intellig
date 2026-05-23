/**
 * Wave B R1 — review-round fixes.
 *
 * Covers:
 *   1. HIGH    — Senior H-1 — B3 silently drops scrolled-out commits.
 *                Assert ALL hashes resolved against displayOrder, abort
 *                with the TL-M-4 toast otherwise.
 *   2. HIGH    — Senior H-2 — B3 initial-commit boundary failure.
 *                `<oldest>^..<newest>` fails when oldest is the initial
 *                commit. Detect and fall through to positional form.
 *   3. HIGH    — TLB-H-1 — replace inline contiguity check with the
 *                `isSelectionContiguous` helper from Wave A.
 *   4. HIGH    — TLB-H-2 — push displayOrder forward through the
 *                dispatch event. Handlers no longer call back into
 *                provider via `getExtendedLogState()`.
 *   5. HIGH    — TLB-H-3 — `getSelectedCommitsOldestFirst()` sibling
 *                method on the provider for chronological-replay
 *                consumers.
 *   6. MEDIUM  — TLB-M-1 — B4 compareVersions uses `git diff
 *                oldHash..newHash`, not cumulative `getMultiCommitDiff`.
 *   7. MEDIUM  — Senior M-2 — hash-format validation in B3 + B4.
 *   8. MEDIUM  — Senior M-3 — B3 toast clickable "Open Folder" affordance.
 *   9. MEDIUM  — Senior M-4 — B3 "Wait —" comment cleanup.
 *  10. LOW     — Senior L-1 — B4 fallback comment cross-reference.
 *  11. LOW     — Senior L-2 — property-test fixture cross-reference.
 *  12. LOW     — TLB-L-2 — delete unreachable swap-fallback.
 *  13. LOW     — TLB-M-3 — rule-of-three FU on the property mock.
 *  14. MEDIUM  — TLB-M-2 — ADR-009 §6 (display-order vs replay-order).
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commands/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../services/interfaces/IGitService';
import type { IRebaseService } from '../../../services/interfaces/IRebaseService';
import { Uri, EventEmitter } from '../../mocks/vscode';
import type { GitCli } from '../../../utils/gitCli';
import { writableEnv, writableWindow, writableCommands } from '../../typed/windowStub';

// ─── Test scaffolding (slim copy of waveB.test.ts shape) ─────────────────────

interface CallTracker {
  method: string;
  args: unknown[];
}

function createMockRepo(rootPath = '/test-repo'): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: { HEAD: { name: 'main', commit: 'abc1234567890', type: 0 as const } },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

function createMockGitService(
  repo: IRepository,
  overrides?: Partial<IGitService>
): IGitService & { calls: CallTracker[] } {
  const calls: CallTracker[] = [];
  return {
    calls,
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getCommits: async () => [],
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
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
    dispose: () => {},
    ...overrides,
  } as unknown as IGitService & { calls: CallTracker[] };
}

function createMockRebaseService(): IRebaseService {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
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
  } as unknown as IRebaseService;
}

/**
 * R1: provider mock no longer needs `getExtendedLogState` — handlers
 * receive `displayOrder` directly via the dispatch event (TLB-H-2).
 */
function createMockProvider(): GitToolWindowProvider & { refreshCallCount: number } {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refreshCallCount: 0,
    refresh: function (this: { refreshCallCount: number }) {
      this.refreshCallCount++;
    },
  } as unknown as GitToolWindowProvider & { refreshCallCount: number };
}

type MockGitCli = GitCli & { calls: CallTracker[] };

function createMockGitCli(opts?: {
  exec?: (...args: unknown[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    combined: string;
  }>;
}): MockGitCli {
  const calls: CallTracker[] = [];
  const exec = async (...args: unknown[]) => {
    calls.push({ method: 'exec', args });
    if (opts?.exec) {
      return opts.exec(...args);
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
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

interface MessageTracker {
  info: { message: string; items: string[] }[];
  error: { message: string; items: string[] }[];
}

function captureMessages(): MessageTracker {
  const tracker: MessageTracker = { info: [], error: [] };
  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]) => {
    tracker.info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]) => {
    tracker.error.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showSaveDialog = () => Promise.resolve(undefined);
  w.showOpenDialog = () => Promise.resolve(undefined);
}

interface CommandsInternal {
  _gitCli: GitCli;
  /**
   * R1 (TLB-H-2) + R2 (TLBR1-L-1): commitNodes (slim
   * `IMenuStateNode[]`, newest-first) threaded through the dispatch
   * event. Single positional, defaults to `[]` on the production
   * signature so legacy single-commit tests don't have to construct
   * it.
   */
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly { hash: string; parentCount: number }[]
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
    opts.provider,
    opts.gitCli
  );
  return cmds;
}

describe('Wave B R1 — review fixes', () => {
  const repo = createMockRepo();
  const HASH_OLDEST = 'aaaa111111111111111111111111111111111111';
  const HASH_MIDDLE = 'bbbb222222222222222222222222222222222222';
  const HASH_NEWEST = 'cccc333333333333333333333333333333333333';
  const HASH_FAR = 'dddd444444444444444444444444444444444444';
  // Display order is newest-first.
  const DISPLAY_ORDER: readonly string[] = [HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST, HASH_FAR];
  // R2 (TLBR1-L-1): commitNodes shape — newest-first, parentCount=1.
  const COMMIT_NODES: readonly { hash: string; parentCount: number }[] = DISPLAY_ORDER.map((h) => ({
    hash: h,
    parentCount: 1,
  }));

  afterEach(() => restoreMocks());

  // ─── R1-3 (TLB-H-1) — uses isSelectionContiguous helper ──────────────────
  describe('R1-3 (TLB-H-1) — _handleCreatePatchMulti uses the multiSelect helper', () => {
    it('CommitContextMenuCommands.ts imports isSelectionContiguous from multiSelect', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      assert.ok(
        /import\s*\{[^}]*isSelectionContiguous[^}]*\}\s*from\s*['"][^'"]*multiSelect/.test(src),
        'CommitContextMenuCommands must import isSelectionContiguous from the multiSelect helper module'
      );
    });

    it('does not contain a fresh inline `indices.every(...)` consecutive-index check', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      // The pre-R1 _handleCreatePatchMulti contained:
      //   indices.every((v, i) => i === 0 || v - indices[i - 1] === 1)
      // After TLB-H-1 the contiguity check delegates to the helper.
      assert.ok(
        !/indices\.every\(\s*\(v,\s*i\)\s*=>\s*i\s*===\s*0\s*\|\|\s*v\s*-\s*indices\[i\s*-\s*1\]\s*===\s*1/.test(
          src
        ),
        'inline indices.every consecutive-index check must be replaced with isSelectionContiguous(...)'
      );
    });
  });

  // ─── R1-5 (TLB-H-3) — getSelectedCommitsOldestFirst sibling ──────────────
  describe('R1-5 (TLB-H-3) — getSelectedCommitsOldestFirst()', () => {
    it('GitToolWindowProvider exposes getSelectedCommitsOldestFirst as a public method', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/services/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      assert.ok(
        /public\s+getSelectedCommitsOldestFirst\s*\(\s*\)\s*:/.test(src),
        'expected public getSelectedCommitsOldestFirst() method'
      );
    });

    it('returns the reverse of getSelectedCommits (oldest-first replay order)', () => {
      const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
      try {
        provider.updateLogState([
          {
            hash: HASH_OLDEST,
            shortHash: HASH_OLDEST.slice(0, 7),
            message: 'old',
            author: { name: 'a', email: 'a@x' },
            committer: { name: 'a', email: 'a@x' },
            parents: [],
            authorDate: new Date(0),
            commitDate: new Date(0),
          },
          {
            hash: HASH_MIDDLE,
            shortHash: HASH_MIDDLE.slice(0, 7),
            message: 'mid',
            author: { name: 'a', email: 'a@x' },
            committer: { name: 'a', email: 'a@x' },
            parents: [HASH_OLDEST],
            authorDate: new Date(0),
            commitDate: new Date(0),
          },
          {
            hash: HASH_NEWEST,
            shortHash: HASH_NEWEST.slice(0, 7),
            message: 'new',
            author: { name: 'a', email: 'a@x' },
            committer: { name: 'a', email: 'a@x' },
            parents: [HASH_MIDDLE],
            authorDate: new Date(0),
            commitDate: new Date(0),
          },
        ]);
        provider.toggleCommitSelection(HASH_NEWEST);
        provider.toggleCommitSelection(HASH_MIDDLE);
        provider.toggleCommitSelection(HASH_OLDEST);

        const newestFirst = provider.getSelectedCommits();
        const oldestFirst = (
          provider as unknown as { getSelectedCommitsOldestFirst(): readonly string[] }
        ).getSelectedCommitsOldestFirst();

        assert.deepStrictEqual(
          [...oldestFirst],
          [...newestFirst].reverse(),
          'getSelectedCommitsOldestFirst must be the reverse of getSelectedCommits'
        );
        // Specifically: oldest-first is the chronological replay order.
        assert.deepStrictEqual([...oldestFirst], [HASH_OLDEST, HASH_MIDDLE, HASH_NEWEST]);
      } finally {
        provider.dispose();
      }
    });

    it('returns [] when selection is empty', () => {
      const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
      try {
        const oldestFirst = (
          provider as unknown as { getSelectedCommitsOldestFirst(): readonly string[] }
        ).getSelectedCommitsOldestFirst();
        assert.deepStrictEqual([...oldestFirst], []);
      } finally {
        provider.dispose();
      }
    });
  });

  // ─── R1-4 (TLB-H-2) — displayOrder threaded through dispatch ─────────────
  describe('R1-4 (TLB-H-2) — handlers receive displayOrder via dispatch event', () => {
    it('onDidRequestLogContextAction event payload includes commitNodes (R2 collapsed shape)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/services/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      // R2 (TLBR1-L-1): the EventEmitter declaration carries
      // `commitNodes` instead of the prior parallel `displayOrder` +
      // `parentCounts` records.
      assert.ok(
        /_onDidRequestLogContextAction\s*=\s*new\s+vscode\.EventEmitter<\{[\s\S]{0,3000}commitNodes/.test(
          src
        ),
        'event payload type must include commitNodes (R2 collapsed shape)'
      );
    });

    it('CommitContextMenuCommands._handleAction takes commitNodes as a third positional', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      assert.ok(
        /_handleAction\s*\(\s*action:\s*LogContextAction,\s*commitHashes:\s*string\[\],\s*commitNodes/.test(
          src
        ),
        '_handleAction must declare commitNodes as a third positional (R2 collapsed)'
      );
    });

    it('handlers no longer call getExtendedLogState() in CommitContextMenuCommands.ts', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      // ADR-009 inversion fix: command handlers don't reach into the
      // provider's state. displayOrder comes from the dispatch event.
      // Strip comments first — references in JSDoc / inline rationale
      // about "no longer calls getExtendedLogState" are fine; only an
      // actual call site is the regression we're guarding against.
      const codeOnly = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(
        !/getExtendedLogState\(\)/.test(codeOnly),
        'command handlers must not call getExtendedLogState() (TLB-H-2 inversion fix)'
      );
    });
  });

  // ─── R1-1 (Senior H-1) — B3 silently drops scrolled-out commits ─────────
  describe('R1-1 (Senior H-1) — B3 aborts on stale hashes', () => {
    it('toasts the TL-M-4 phrasing and aborts when a hash is not in displayOrder', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();

      // commitNodes includes only [NEWEST, MIDDLE, OLDEST]; the
      // commitHashes argument includes a hex-but-unknown hash not in
      // the list. Hex-only so the M-2 regex passes and the H-1 stale
      // check is exercised.
      const HASH_GHOST = 'eeee555555555555555555555555555555555555';
      await (cmds as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_GHOST],
        [
          { hash: HASH_NEWEST, parentCount: 1 },
          { hash: HASH_MIDDLE, parentCount: 1 },
          { hash: HASH_OLDEST, parentCount: 1 },
        ]
      );

      // No git invocation.
      const formatPatchCall = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.strictEqual(
        formatPatchCall,
        undefined,
        'must not invoke git when stale hashes detected'
      );

      // The toast text mirrors GitToolWindowProvider._handleCommitContextMenu.
      const allToasts = [...messages.info, ...messages.error].map((m) => m.message).join(' || ');
      assert.ok(
        /selection changed/i.test(allToasts),
        `expected the "selection changed" TL-M-4 toast; got: ${allToasts}`
      );
    });
  });

  // ─── R1-2 (Senior H-2) — B3 initial-commit boundary ─────────────────────
  // R2 (Senior L-3): if a future regression re-introduces a
  // `getExtendedLogState()` call inside the multi handler, this test
  // would surface a generic `TypeError` because the mock provider
  // doesn't supply that method. The R1-4 "end-to-end smoke" block
  // below is the dedicated guard against that inversion regression —
  // it asserts the handler chain doesn't reach into provider state at
  // all. No code change in this block; senior just wanted a pointer.
  describe('R1-2 (Senior H-2) — B3 falls through when oldest is the initial commit', () => {
    /**
     * When the oldest selected commit is the initial commit (parents=[]),
     * `<oldest>^..<newest>` makes git fail because `<oldest>^` doesn't
     * exist. We need to detect this and fall through to the positional
     * argv form.
     */
    it('detects parents-less oldest and uses positional argv (no `^..`)', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const w = writableWindow();
      w.showOpenDialog = () => Promise.resolve([Uri.file('/tmp/patches')]);

      let receivedArgv: string[] | undefined;
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          receivedArgv = args[0] as string[];
          return {
            exitCode: 0,
            stdout: '/tmp/patches/0001-x.patch\n',
            stderr: '',
            combined: '',
          };
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // displayOrder includes 4 commits; we pick all 3 oldest (contiguous
      // by index) but the oldest IS the initial commit. The displayOrder
      // also encodes "oldest has no parents" via the new event payload —
      // implementations may either accept parent-count info on the event
      // OR look up via gitCli rev-parse / a parents map. We assert
      // structurally that no `^..` appears in the argv.
      await (cmds as unknown as CommandsInternal)._handleAction(
        'createPatch',
        // Selection: 3 contiguous oldest commits (NEWEST, MIDDLE, OLDEST in display order).
        [HASH_NEWEST, HASH_MIDDLE, HASH_OLDEST],
        // R2 (TLBR1-L-1): commitNodes carries {hash, parentCount}. OLDEST
        // has no parents → "initial commit" branch. Senior H-2: handler
        // must detect parentCount=0 on oldest and use positional argv
        // instead of `<oldest>^..` (which would fail because OLDEST^
        // doesn't resolve).
        [
          { hash: HASH_NEWEST, parentCount: 1 },
          { hash: HASH_MIDDLE, parentCount: 1 },
          { hash: HASH_OLDEST, parentCount: 0 },
        ]
      );

      assert.ok(receivedArgv, 'expected git format-patch invocation');
      assert.ok(
        !receivedArgv.some((a) => /\^\.\./.test(a)),
        `expected positional fallback (no ^..); got argv: ${JSON.stringify(receivedArgv)}`
      );
      // Hashes should be present positional, oldest-first.
      const oldestPos = receivedArgv.indexOf(HASH_OLDEST);
      const newestPos = receivedArgv.indexOf(HASH_NEWEST);
      assert.ok(oldestPos >= 0 && newestPos >= 0);
      assert.ok(oldestPos < newestPos, 'positional fallback must list hashes oldest-first');
    });
  });

  // ─── R1-7 (Senior M-2) — hash-format validation ─────────────────────────
  describe('R1-7 (Senior M-2) — hash-format validation in B3 + B4', () => {
    it('createPatch rejects malformed hashes silently (defense in depth)', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const w = writableWindow();
      w.showOpenDialog = () => Promise.resolve([Uri.file('/tmp/patches')]);
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // 'rm -rf /' is obviously not a hash.
      await (cmds as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, 'rm -rf /'],
        [
          { hash: HASH_NEWEST, parentCount: 1 },
          { hash: HASH_MIDDLE, parentCount: 1 },
          { hash: HASH_OLDEST, parentCount: 1 },
        ]
      );

      const formatPatchCall = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.strictEqual(
        formatPatchCall,
        undefined,
        'must reject any malformed hash before invoking git'
      );
    });

    it('compareVersions rejects malformed hashes silently', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const realExec = writableCommands().executeCommand;
      let diffCalled = false;
      writableCommands().executeCommand = (name: string) => {
        if (name === 'vscode.diff') {
          diffCalled = true;
        }
        return Promise.resolve(undefined);
      };
      try {
        captureMessages();
        await (cmds as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_NEWEST, 'rm -rf /'],
          [
            { hash: HASH_NEWEST, parentCount: 1 },
            { hash: HASH_OLDEST, parentCount: 1 },
          ]
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }
      assert.strictEqual(diffCalled, false, 'must reject malformed hashes before opening diff');
    });
  });

  // ─── R1-6 (TLB-M-1) — compareVersions uses git diff oldHash..newHash ───
  describe('R1-6 (TLB-M-1) — compareVersions uses two-dot diff, not cumulative getMultiCommitDiff', () => {
    it('shells out to `git diff --name-only oldHash..newHash` for the file list', async () => {
      const gitService = createMockGitService(repo, {
        // If compareVersions still calls this, our test rejects.
        getMultiCommitDiff: async () => {
          throw new Error('compareVersions must not call getMultiCommitDiff (R1 TLB-M-1)');
        },
      });
      const provider = createMockProvider();
      let diffArgv: string[] | undefined;
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const argv = args[0] as string[];
          if (argv[0] === 'diff') {
            diffArgv = argv;
            return { exitCode: 0, stdout: 'src/foo.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const realExec = writableCommands().executeCommand;
      writableCommands().executeCommand = () => Promise.resolve(undefined);
      try {
        captureMessages();
        await (cmds as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_NEWEST, HASH_OLDEST],
          [
            { hash: HASH_NEWEST, parentCount: 1 },
            { hash: HASH_OLDEST, parentCount: 1 },
          ]
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }

      assert.ok(diffArgv, 'expected git diff invocation');
      assert.ok(
        diffArgv.includes('--name-only'),
        `expected --name-only flag; got ${JSON.stringify(diffArgv)}`
      );
      // Two-dot range: oldHash..newHash, not three-dot.
      const range = diffArgv.find((a) => a.includes('..') && !a.includes('...'));
      assert.ok(
        range && range === `${HASH_OLDEST}..${HASH_NEWEST}`,
        `expected oldHash..newHash range; got ${JSON.stringify(diffArgv)}`
      );
    });

    it('toasts a sanitised error when the diff call fails', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const argv = args[0] as string[];
          if (argv[0] === 'diff') {
            return {
              exitCode: 128,
              stdout: '',
              stderr: 'fatal: bad revision',
              combined: 'fatal: bad revision',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();
      const realExec = writableCommands().executeCommand;
      writableCommands().executeCommand = () => Promise.resolve(undefined);
      try {
        await (cmds as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_NEWEST, HASH_OLDEST],
          [
            { hash: HASH_NEWEST, parentCount: 1 },
            { hash: HASH_OLDEST, parentCount: 1 },
          ]
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }
      assert.ok(
        messages.error.length > 0 || messages.info.length > 0,
        'expected a toast on diff failure'
      );
      const all = [...messages.info, ...messages.error].map((m) => m.message).join(' || ');
      assert.ok(/compare|diff|Failed/i.test(all), `expected error toast; got: ${all}`);
    });
  });

  // ─── R1-12 (TLB-L-2) — unreachable swap-fallback gone ───────────────────
  describe('R1-12 (TLB-L-2) — unreachable swap-fallback deleted', () => {
    it('CommitContextMenuCommands.ts has no "Fallback: if one of the hashes isn\'t in commitNodes" comment', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      assert.ok(
        !/Fallback:\s*if one of the hashes isn'?t in commitNodes/.test(src),
        'unreachable swap-fallback comment must be removed (TL-M-4 already aborts upstream)'
      );
    });
  });

  // ─── R1-9 (Senior M-4) — comment cleanup ────────────────────────────────
  describe('R1-9 (Senior M-4) — "Wait —" inline comment block rewritten', () => {
    it('CommitContextMenuCommands.ts has no "Wait —" comment in the patch builder', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commands/CommitContextMenuCommands.ts'),
        'utf8'
      );
      assert.ok(
        !/Wait\s+—/.test(src),
        '"Wait —" comment block must be replaced with the declarative summary'
      );
    });
  });

  // ─── R1-13 (TLB-M-3) — rule-of-three FU on property mock ────────────────
  describe('R1-13 (TLB-M-3) — rule-of-three FU on property mocks', () => {
    it('commitContextMenuDispatch.property.test.ts has the rule-of-three FU comment', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/test/property/commitContextMenuDispatch.property.test.ts'),
        'utf8'
      );
      assert.ok(
        /rule of three|rule-of-three/i.test(src),
        'expected the rule-of-three FU comment on the dispatch property mock'
      );
    });

    it('commitContextMenuErrors.property.test.ts has the rule-of-three FU comment', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/test/property/commitContextMenuErrors.property.test.ts'),
        'utf8'
      );
      assert.ok(
        /rule of three|rule-of-three/i.test(src),
        'expected the rule-of-three FU comment on the errors property mock'
      );
    });
  });

  // ─── R1-14 (TLB-M-2) — ADR-009 §6 ────────────────────────────────────────
  describe('R1-14 (TLB-M-2) — ADR-009 §6 display-order vs replay-order', () => {
    it('ADR-009 has a §6 section about display-order vs replay-order', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adr = fs.readFileSync(
        path.join(process.cwd(), 'docs/adr/ADR-009-webview-state-ownership.md'),
        'utf8'
      );
      assert.ok(
        /###?\s*6\.[\s\S]{0,200}(display[- ]order|replay[- ]order)/i.test(adr),
        'expected ADR-009 §6 section about display-order / replay-order'
      );
      assert.ok(
        /getSelectedCommitsOldestFirst/.test(adr),
        '§6 must cross-link to the new oldest-first sibling helper'
      );
    });
  });

  // ─── R1-8 (Senior M-3) — B3 toast Open Folder affordance ────────────────
  describe('R1-8 (Senior M-3) — B3 success toast offers "Open Folder"', () => {
    it('multi-commit success toast includes the "Open Folder" action', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const w = writableWindow();
      w.showOpenDialog = () => Promise.resolve([Uri.file('/tmp/patches')]);
      const gitCli = createMockGitCli({
        exec: async () => ({
          exitCode: 0,
          stdout: '/tmp/patches/0001.patch\n/tmp/patches/0002.patch\n',
          stderr: '',
          combined: '',
        }),
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();

      await (cmds as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_MIDDLE],
        COMMIT_NODES
      );

      const succ = messages.info[messages.info.length - 1];
      assert.ok(succ, 'expected an info toast on success');
      assert.ok(
        succ.items.some((it) => /open\s*folder/i.test(it)),
        `expected "Open Folder" action item; got: ${JSON.stringify(succ.items)}`
      );
    });
  });

  // ─── Smoke for R1-4 wiring: dispatch event carries displayOrder end-to-end
  describe('R1-4 (TLB-H-2) — end-to-end smoke', () => {
    it('handlers receive displayOrder from the dispatch payload (no provider call)', async () => {
      // Provider mock has NO getExtendedLogState. If anything in the
      // handler chain still calls it, this throws.
      const provider = createMockProvider();
      const gitService = createMockGitService(repo);
      const w = writableWindow();
      w.showOpenDialog = () => Promise.resolve([Uri.file('/tmp/p')]);
      const gitCli = createMockGitCli({
        exec: async () => ({
          exitCode: 0,
          stdout: '/tmp/p/0001.patch\n',
          stderr: '',
          combined: '',
        }),
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();

      // Should not throw — displayOrder from the third arg suffices.
      await (cmds as unknown as CommandsInternal)._handleAction(
        'createPatch',
        [HASH_NEWEST, HASH_MIDDLE],
        COMMIT_NODES
      );
      // gitCli was called → handler reached the gitCli, didn't crash on
      // missing getExtendedLogState.
      assert.ok(
        gitCli.calls.some(
          (c) =>
            c.method === 'exec' &&
            Array.isArray(c.args[0]) &&
            (c.args[0] as string[])[0] === 'format-patch'
        )
      );
    });
  });

  // Avoid unused-import warning when test grep doesn't pick all blocks.
  void writableEnv;
  void vscode;
});
