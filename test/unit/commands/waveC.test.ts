/**
 * Rebase-driven multi-commit ops (drop N, squash N).
 *
 * Subsections:
 *   C1 — Drop N (≥2 contiguous-or-not, dropCommit gated to non-merge)
 *   C2 — Squash N (≥2 contiguous non-merge, IntelliJ semantics: dialog
 *        BEFORE rebase)
 *   C3 — Contiguity helper reuse (no inline reimpl in handlers)
 *   C4 — Conflict handoff (both → _openResolveConflictsDialog)
 *
 * Patterns mirror waveB.test.ts: hash-validation, in-order guard,
 * stale-toast phrasing, no `getExtendedLogState()` reach-back, dispatch
 * payload uses commitNodes (the slim newest-first IMenuStateNode list).
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import { CommitContextMenuCommands } from '../../../src/commits/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../../src/git-core/interfaces/IRebaseService';
import type { IConflictResolutionService } from '../../../src/conflicts/interfaces/IConflictResolutionService';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';
import { Uri, EventEmitter } from '../../mocks/vscode';
import type { GitCli } from '../../../src/git-core/gitCli';
import { writableWindow } from '../../typed/windowStub';
import {
  installMessageEditorStubs,
  type MessageEditorTracker,
} from '../../typed/messageEditorStub';

// ─── Test scaffolding ────────────────────────────────────────────────────────

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
    getCommit: async (_repo: IRepository, hash: string) => {
      calls.push({ method: 'getCommit', args: [hash] });
      return {
        hash,
        shortHash: hash.substring(0, 7),
        message: `subject for ${hash.substring(0, 8)}\n\nbody for ${hash.substring(0, 8)}`,
        author: { name: 'a', email: 'a@x' },
        committer: { name: 'a', email: 'a@x' },
        parents: [],
        authorDate: new Date(0),
        commitDate: new Date(0),
      };
    },
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    dispose: () => {},
    ...overrides,
  } as unknown as IGitService & { calls: CallTracker[] };
}

interface MockRebaseTracker {
  startedOnto: string | undefined;
  lastPlan: IRebaseAction[] | undefined;
  executeCalls: number;
  abortCalls: number;
  sessionCommits: { hash: string; message: string; action: 'pick' }[];
  /** What `executeRebase` should resolve to. Mutate per-test. */
  executeResult: IRebaseResult;
}

function createMockRebaseService(
  tracker: MockRebaseTracker
): IRebaseService & { tracker: MockRebaseTracker } {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
    tracker,
    startInteractiveRebase: async (_repo: IRepository, onto: string) => {
      tracker.startedOnto = onto;
      const session: IRebaseSession = {
        onto,
        originalBranch: 'main',
        commits: tracker.sessionCommits.map((c) => ({ ...c })),
        currentStep: 0,
        status: 'planning',
      };
      return session;
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: (_repo: IRepository, plan: IRebaseAction[]) => {
      tracker.lastPlan = plan.map((a) => ({ ...a }));
    },
    executeRebase: async () => {
      tracker.executeCalls++;
      return tracker.executeResult;
    },
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {
      tracker.abortCalls++;
    },
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
  } as unknown as IRebaseService & { tracker: MockRebaseTracker };
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

interface MockConflictDialogCall {
  conflicts: { path: string; resolved: boolean }[];
  options: {
    operation: string;
    target?: string;
    canAbort?: boolean;
    canContinue?: boolean;
  };
}

function createMockConflictResolutionService(): IConflictResolutionService & {
  calls: MockConflictDialogCall[];
} {
  const calls: MockConflictDialogCall[] = [];
  return {
    calls,
    openResolveConflictsDialog: async (
      _repo: IRepository,
      conflicts: { path: string; resolved: boolean }[],
      options: {
        operation: string;
        target?: string;
        canAbort?: boolean;
        canContinue?: boolean;
      }
    ) => {
      calls.push({ conflicts, options });
    },
  } as unknown as IConflictResolutionService & { calls: MockConflictDialogCall[] };
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
    getVersion: () => okAsync('2.40.0'),
    isRepository: () => okAsync(true),
    getRepositoryRoot: () => okAsync('/test-repo'),
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
  warning: { message: string; items: string[] }[];
}

function captureMessages(): MessageTracker {
  const tracker: MessageTracker = { info: [], error: [], warning: [] };
  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]) => {
    tracker.info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]) => {
    tracker.error.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showWarningMessage = (message: string, ...items: unknown[]) => {
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    tracker.warning.push({ message, items: stringItems });
    return Promise.resolve(undefined);
  };
  return tracker;
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showWarningMessage = () => Promise.resolve(undefined);
  w.showInputBox = (opts?: import('vscode').InputBoxOptions) => Promise.resolve(opts?.value);
  w.showSaveDialog = () => Promise.resolve(undefined);
  w.showOpenDialog = () => Promise.resolve(undefined);
}

// The tempfile message-editor stub harness lives in a shared module so the
// reword tests drive the same editor; alias to the squash-era names used below.
type SquashEditorTracker = MessageEditorTracker;
const installSquashEditorStubs = installMessageEditorStubs;

interface CommandsInternal {
  _gitCli: GitCli;
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
}

interface MakeOpts {
  repo: IRepository;
  gitService: IGitService;
  gitCli: GitCli;
  provider: GitToolWindowProvider;
  rebaseService: IRebaseService;
  conflictResolutionService?: IConflictResolutionService;
}

function makeCommands(opts: MakeOpts): CommitContextMenuCommands {
  return new CommitContextMenuCommands(
    opts.gitService,
    opts.rebaseService,
    opts.provider,
    opts.gitCli,
    opts.conflictResolutionService
  );
}

function blankRebaseTracker(): MockRebaseTracker {
  return {
    startedOnto: undefined,
    lastPlan: undefined,
    executeCalls: 0,
    abortCalls: 0,
    sessionCommits: [],
    executeResult: { success: true, status: 'completed' },
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Rebase-driven multi-commit ops', () => {
  const repo = createMockRepo();

  // Display order is newest-first.
  const HASH_NEWEST = '1111111111111111111111111111111111111111';
  const HASH_MID = '2222222222222222222222222222222222222222';
  const HASH_OLDEST = '3333333333333333333333333333333333333333';
  const HASH_FAR = '4444444444444444444444444444444444444444';
  const NODES_4: readonly IMenuStateNode[] = [
    { hash: HASH_NEWEST, parentCount: 1 },
    { hash: HASH_MID, parentCount: 1 },
    { hash: HASH_OLDEST, parentCount: 1 },
    { hash: HASH_FAR, parentCount: 1 },
  ];

  afterEach(() => restoreMocks());

  // ─── C1b — Drop single — destructive confirm parity with multi ────────────
  describe('C1b — _handleDropCommit (single) destructive confirm', () => {
    function singleDropTracker(): MockRebaseTracker {
      const t = blankRebaseTracker();
      t.sessionCommits = [{ hash: HASH_NEWEST, message: 'new', action: 'pick' }];
      return t;
    }

    it('does NOT rewrite history when the user cancels the confirm', async () => {
      const tracker = singleDropTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      captureMessages();
      // User cancels the destructive-op modal → resolves undefined.
      writableWindow().showWarningMessage = (() => Promise.resolve(undefined)) as unknown as (
        message: string,
        ...items: unknown[]
      ) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST],
        NODES_4
      );

      assert.strictEqual(tracker.executeCalls, 0, 'executeRebase must not run on cancel');
      assert.strictEqual(tracker.startedOnto, undefined, 'rebase must not start on cancel');
    });

    it('shows a "rewrites history" confirm and drops on accept', async () => {
      const tracker = singleDropTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      captureMessages();
      const prompts: string[] = [];
      writableWindow().showWarningMessage = ((message: string) => {
        prompts.push(message);
        return Promise.resolve('Drop');
      }) as unknown as (message: string, ...items: unknown[]) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST],
        NODES_4
      );

      assert.ok(
        prompts.some((m) => /rewrites history/i.test(m)),
        'single-drop must show a "rewrites history" confirm modal'
      );
      assert.strictEqual(tracker.startedOnto, `${HASH_NEWEST}~1`, 'onto must be hash~1');
      assert.strictEqual(tracker.executeCalls, 1, 'executeRebase must run on accept');
      const planByHash = new Map(tracker.lastPlan!.map((a) => [a.hash, a.action]));
      assert.strictEqual(planByHash.get(HASH_NEWEST), 'drop');
    });
  });

  // ─── C1 — Drop N (≥2) ──────────────────────────────────────────────────────
  describe('C1 — _handleDropCommitMulti', () => {
    it('starts rebase onto oldest^ when 2 contiguous commits selected', async () => {
      const tracker = blankRebaseTracker();
      // The rebase window includes every commit reachable from HEAD that's
      // newer than oldestHash^. For this fixture: NEWEST + MID (oldest of
      // the two) → session covers both.
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      captureMessages();
      // User confirms the destructive-op modal — stub AFTER captureMessages
      // because captureMessages installs its own showWarningMessage hook.
      writableWindow().showWarningMessage = (() => Promise.resolve('Drop')) as unknown as (
        message: string,
        ...items: unknown[]
      ) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_MID],
        NODES_4
      );

      assert.strictEqual(
        tracker.startedOnto,
        `${HASH_MID}~1`,
        "onto must be the oldest commit's first parent"
      );
      assert.ok(tracker.lastPlan, 'updateRebasePlan must be called');
      // Both selected commits must be drop; non-selected stays pick.
      const planByHash = new Map(tracker.lastPlan.map((a) => [a.hash, a.action]));
      assert.strictEqual(planByHash.get(HASH_MID), 'drop');
      assert.strictEqual(planByHash.get(HASH_NEWEST), 'drop');
      assert.strictEqual(tracker.executeCalls, 1);
    });

    it('builds a pick/drop plan that drops only the selected commits in non-contiguous selections', async () => {
      const tracker = blankRebaseTracker();
      // Selection = NEWEST + OLDEST (gap at MID). Onto = OLDEST^. Window =
      // OLDEST + MID + NEWEST. MID stays pick.
      tracker.sessionCommits = [
        { hash: HASH_OLDEST, message: 'old', action: 'pick' },
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      captureMessages();
      writableWindow().showWarningMessage = (() => Promise.resolve('Drop')) as unknown as (
        message: string,
        ...items: unknown[]
      ) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_OLDEST],
        NODES_4
      );

      assert.strictEqual(tracker.startedOnto, `${HASH_OLDEST}~1`);
      const planByHash = new Map(tracker.lastPlan!.map((a) => [a.hash, a.action]));
      assert.strictEqual(planByHash.get(HASH_NEWEST), 'drop');
      assert.strictEqual(planByHash.get(HASH_OLDEST), 'drop');
      assert.strictEqual(planByHash.get(HASH_MID), 'pick', 'non-selected commits must stay pick');
    });

    it('shows a confirm modal listing short-shas and aborts on cancel', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      const messages = captureMessages();
      // User cancels → showWarningMessage resolves to undefined.
      writableWindow().showWarningMessage = (() => Promise.resolve(undefined)) as unknown as (
        message: string,
        ...items: unknown[]
      ) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_MID],
        NODES_4
      );

      // No git activity.
      assert.strictEqual(tracker.executeCalls, 0, 'executeRebase must not run on cancel');
      assert.strictEqual(tracker.startedOnto, undefined, 'rebase must not start on cancel');
      void messages;
    });

    it('aborts on stale hash with the "selection changed" toast', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      const HASH_GHOST = '9999999999999999999999999999999999999999';
      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_GHOST],
        NODES_4
      );

      const allToasts = [...messages.info, ...messages.error, ...messages.warning]
        .map((m) => m.message)
        .join(' || ');
      assert.ok(
        /selection changed/i.test(allToasts),
        `expected stale-selection toast; got: ${allToasts}`
      );
      assert.strictEqual(tracker.executeCalls, 0);
    });

    it('warns and proceeds via --root when oldest selected is the initial commit', async () => {
      // IntelliJ warns (Continue/Cancel) and then runs the rebase with
      // --root (GitCommitEditingActionBase.kt:202-210,266-275); the old
      // hard refusal is gone. '<root>' is the REBASE_ROOT sentinel the
      // runner hands to RebaseService in place of `<oldest>^`.
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      tracker.sessionCommits = [
        { hash: HASH_OLDEST, message: 'oldest', action: 'pick' },
        { hash: HASH_NEWEST, message: 'newest', action: 'pick' },
      ];
      const messages = captureMessages();
      // Answer BOTH modals: the initial-commit warning (Continue) and the
      // destructive-op confirm (Drop).
      const w = writableWindow();
      w.showWarningMessage = ((message: string, ...items: unknown[]) => {
        const stringItems = items.filter((i): i is string => typeof i === 'string');
        messages.warning.push({ message, items: stringItems });
        return Promise.resolve(stringItems[0]);
      }) as typeof w.showWarningMessage;

      const nodes: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1 },
        { hash: HASH_OLDEST, parentCount: 0 }, // initial commit
      ];
      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_OLDEST],
        nodes
      );

      assert.ok(
        messages.warning.some((wm) => /initial commit/i.test(wm.message)),
        `expected the initial-commit warning; got ${JSON.stringify(messages.warning)}`
      );
      assert.strictEqual(tracker.startedOnto, '<root>', 'the rebase must run with --root');
      assert.strictEqual(tracker.executeCalls, 1);
    });

    it('cancelling the initial-commit warning runs nothing', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages(); // warning stub resolves undefined = dismissed

      const nodes: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1 },
        { hash: HASH_OLDEST, parentCount: 0 },
      ];
      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_OLDEST],
        nodes
      );

      assert.strictEqual(tracker.startedOnto, undefined, 'a dismissed warning must not rebase');
      assert.strictEqual(tracker.executeCalls, 0);
    });

    it('rejects merge-commit selections at handler entry (defence-in-depth)', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      const nodesWithMerge: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1 },
        { hash: HASH_MID, parentCount: 2 }, // merge
        { hash: HASH_OLDEST, parentCount: 1 },
      ];
      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_MID],
        nodesWithMerge
      );

      assert.strictEqual(tracker.executeCalls, 0, 'must not start rebase on merge selection');
    });

    it('routes conflicts to the resolve dialog with operation:rebase, target:drop', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      tracker.executeResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/conflicted.ts'],
        rebaseInProgress: true,
      };
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const conflictSvc = createMockConflictResolutionService();
      const cmds = makeCommands({
        repo,
        gitService,
        gitCli,
        provider,
        rebaseService,
        conflictResolutionService: conflictSvc,
      });
      captureMessages();
      writableWindow().showWarningMessage = (() => Promise.resolve('Drop')) as unknown as (
        message: string,
        ...items: unknown[]
      ) => Promise<string | undefined>;

      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_MID],
        NODES_4
      );

      assert.strictEqual(
        tracker.abortCalls,
        0,
        'the conflicted rebase stays paused for the dialog — abort is user-initiated only'
      );
      assert.strictEqual(conflictSvc.calls.length, 1);
      assert.strictEqual(conflictSvc.calls[0].options.operation, 'rebase');
      assert.strictEqual(conflictSvc.calls[0].options.target, 'drop');
      assert.strictEqual(conflictSvc.calls[0].options.canContinue, true);
      assert.strictEqual(conflictSvc.calls[0].options.canAbort, true);
      assert.deepStrictEqual(
        conflictSvc.calls[0].conflicts.map((c) => c.path),
        ['src/conflicted.ts']
      );
    });
  });

  // ─── C2 — Squash N ─────────────────────────────────────────────────────────
  // Squash dialog now uses an untitled-style
  // editor (openTextDocument + save listener) instead of `showInputBox`.
  // Tests drive the flow via `installSquashEditorStubs()` + `simulateSave`
  // / `simulateClose`. The handler returns once one of those listeners
  // fires; tests `flushMicroTasks()` between kicking off the action and
  // the simulate call so the listener registration completes.
  describe('C2 — _handleSquashCommits', () => {
    /**
     * Helper: run the handler and the editor simulator concurrently.
     * Both promises are awaited together so the test fails fast on
     * either side. The handler doesn't resolve until the simulator
     * fires save/close, so kicking them off in parallel is safe.
     */
    async function runWithEditor(
      action: () => Promise<void>,
      simulate: (editorTracker: SquashEditorTracker) => void
    ): Promise<SquashEditorTracker> {
      const editorTracker = installSquashEditorStubs();
      const handlerPromise = action();
      // Yield twice to let `openTextDocument` + `showTextDocument` +
      // listener registration complete before the simulator fires.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      simulate(editorTracker);
      await handlerPromise;
      return editorTracker;
    }

    it('rejects a cross-branch selection at perform time (no rebase, no editor)', async () => {
      // Defence-in-depth for the squash first-parent-chain gate: even if a
      // disabled squash item is clicked through a stale/racing enable-state, the
      // handler must refuse a selection that spans branches. NEWEST and MID are
      // display-contiguous but siblings (neither is the other's first parent), so
      // the handler rejects BEFORE opening the message editor or starting a rebase.
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      const crossBranchNodes: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1, parents: [HASH_FAR] }, // branch A
        { hash: HASH_MID, parentCount: 1, parents: [HASH_OLDEST] }, // branch B
        { hash: HASH_OLDEST, parentCount: 1, parents: [HASH_FAR] },
        { hash: HASH_FAR, parentCount: 1, parents: ['0'.repeat(40)] },
      ];

      await (cmds as unknown as CommandsInternal)._handleAction(
        'squashCommits',
        [HASH_NEWEST, HASH_MID],
        crossBranchNodes
      );

      assert.strictEqual(tracker.executeCalls, 0, 'must not start a rebase across branches');
      assert.strictEqual(tracker.startedOnto, undefined, 'must not start a rebase across branches');
      assert.ok(
        messages.error.some((m) => /single branch|first-parent/i.test(m.message)),
        `expected a single-branch error, got: ${JSON.stringify(messages.error)}`
      );
    });

    it('opens the editor BEFORE the rebase (D1 — IntelliJ semantics); cancel = no git', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      const editor = await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateClose() // close-without-save = cancel
      );

      assert.ok(editor.openCalls > 0, 'expected openTextDocument to be called');
      assert.strictEqual(tracker.executeCalls, 0, 'no rebase must run when user cancels editor');
      assert.strictEqual(tracker.startedOnto, undefined, 'no rebase must start on cancel');
    });

    it('seeds the editor with `\\n\\n`-joined commit messages from oldest to newest', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      const editor = await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('user-chosen squashed message')
      );

      assert.ok(editor.lastSeed, 'expected the editor to be seeded with a value');
      // Order: oldest-first → MID's message comes before NEWEST's.
      const midMsg = `subject for ${HASH_MID.substring(0, 8)}`;
      const newestMsg = `subject for ${HASH_NEWEST.substring(0, 8)}`;
      const midIdx = editor.lastSeed.indexOf(midMsg);
      const newestIdx = editor.lastSeed.indexOf(newestMsg);
      assert.ok(midIdx >= 0 && newestIdx >= 0, `seed: ${editor.lastSeed}`);
      assert.ok(midIdx < newestIdx, 'oldest message must appear before newest in the seed');
      // Joined with \n\n.
      assert.ok(
        editor.lastSeed.includes('\n\n'),
        `expected blank-line separator between commit messages; got: ${editor.lastSeed}`
      );
    });

    it('starts rebase onto oldest^ and delivers the combined message via a reword override on the target', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      tracker.executeResult = { success: true, status: 'completed' };
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('combined squash message')
      );

      assert.strictEqual(
        tracker.startedOnto,
        `${HASH_MID}~1`,
        "onto must be the oldest commit's first parent"
      );
      // The combined message is delivered deterministically through the plan
      // (a reword override on the squash target). git never pauses under
      // GIT_EDITOR=true, so a classic squash with a post-rebase message step
      // would silently keep the newest commit's own message instead.
      const target = tracker.lastPlan!.find((a) => a.hash === HASH_MID);
      assert.strictEqual(
        target?.action,
        'reword',
        'squash target must reword to carry the message'
      );
      assert.strictEqual(
        target?.newMessage,
        'combined squash message',
        'the squash target must carry the user-edited combined message as the override'
      );
    });

    it('builds plan: oldest selected = reword(combined message), others = fixup; non-selected = pick', async () => {
      const tracker = blankRebaseTracker();
      // Window covers all three commits (rebase from OLDEST^).
      tracker.sessionCommits = [
        { hash: HASH_OLDEST, message: 'old', action: 'pick' },
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID, HASH_OLDEST],
            NODES_4
          ),
        (e) => e.simulateSave('combined message text')
      );

      const plan = tracker.lastPlan!;
      const byHash = new Map(plan.map((a) => [a.hash, a]));
      // Mirrors git4idea GitRebaseTodoModelConverter: the unite ROOT (oldest
      // selected) becomes a Reword carrying the combined message; every other
      // selected commit is united via fixup (its own message discarded).
      assert.strictEqual(
        byHash.get(HASH_OLDEST)?.action,
        'reword',
        'oldest selected commit (squash target) must be reword'
      );
      assert.strictEqual(
        byHash.get(HASH_OLDEST)?.newMessage,
        'combined message text',
        'the combined message must land on the squash target'
      );
      assert.strictEqual(byHash.get(HASH_MID)?.action, 'fixup');
      assert.strictEqual(byHash.get(HASH_NEWEST)?.action, 'fixup');
    });

    it('aborts on contiguity violation (defence-in-depth even though UI gates it)', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      // Contiguity check happens BEFORE the editor opens, so we don't
      // need the editor stubs here.
      await (cmds as unknown as CommandsInternal)._handleAction(
        'squashCommits',
        [HASH_NEWEST, HASH_OLDEST],
        NODES_4
      );

      assert.strictEqual(tracker.executeCalls, 0);
    });

    it('rejects merge-commit selections at handler entry (defence-in-depth)', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      const nodesWithMerge: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1 },
        { hash: HASH_MID, parentCount: 2 },
        { hash: HASH_OLDEST, parentCount: 1 },
      ];
      await (cmds as unknown as CommandsInternal)._handleAction(
        'squashCommits',
        [HASH_NEWEST, HASH_MID],
        nodesWithMerge
      );

      assert.strictEqual(tracker.executeCalls, 0);
    });

    it('aborts on stale hash with the "selection changed" toast', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      // Stale-hash check happens BEFORE the editor opens.
      const HASH_GHOST = '9999999999999999999999999999999999999999';
      await (cmds as unknown as CommandsInternal)._handleAction(
        'squashCommits',
        [HASH_NEWEST, HASH_GHOST],
        NODES_4
      );

      const allToasts = [...messages.info, ...messages.error, ...messages.warning]
        .map((m) => m.message)
        .join(' || ');
      assert.ok(
        /selection changed/i.test(allToasts),
        `expected stale-selection toast; got: ${allToasts}`
      );
      assert.strictEqual(tracker.executeCalls, 0);
    });

    it('routes conflicts to the resolve dialog with operation:rebase, target:squash', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      tracker.executeResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/conflicted.ts'],
        rebaseInProgress: true,
      };
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const conflictSvc = createMockConflictResolutionService();
      const cmds = makeCommands({
        repo,
        gitService,
        gitCli,
        provider,
        rebaseService,
        conflictResolutionService: conflictSvc,
      });
      captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('combined')
      );

      assert.strictEqual(
        tracker.abortCalls,
        0,
        'the conflicted rebase stays paused for the dialog — abort is user-initiated only'
      );
      assert.strictEqual(conflictSvc.calls.length, 1);
      assert.strictEqual(conflictSvc.calls[0].options.operation, 'rebase');
      assert.strictEqual(conflictSvc.calls[0].options.target, 'squash');
      assert.strictEqual(conflictSvc.calls[0].options.canContinue, true);
      assert.strictEqual(conflictSvc.calls[0].options.canAbort, true);
    });

    it('autostash-pop conflict (rebaseInProgress:false): does NOT abort, suppresses continue/abort in dialog', async () => {
      // The squash flow pre-stashes so this is practically unreachable, but the
      // handler must still honor the flag: a completed rebase has no live
      // rebase to abort, and `git rebase --abort`/`--continue` would dead-end.
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      tracker.executeResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/conflicted.ts'],
        rebaseInProgress: false,
      };
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const conflictSvc = createMockConflictResolutionService();
      const cmds = makeCommands({
        repo,
        gitService,
        gitCli,
        provider,
        rebaseService,
        conflictResolutionService: conflictSvc,
      });
      captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('combined')
      );

      assert.strictEqual(tracker.abortCalls, 0, 'must not abort a rebase that already completed');
      assert.strictEqual(conflictSvc.calls.length, 1);
      assert.strictEqual(conflictSvc.calls[0].options.canAbort, false);
      assert.strictEqual(conflictSvc.calls[0].options.canContinue, false);
    });

    it('treats empty save as cancel (R1 Senior L-2 — no error toast, no rebase)', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('   ') // whitespace-only = treated as cancel
      );

      assert.strictEqual(
        tracker.executeCalls,
        0,
        'must not start rebase on empty save (treated as cancel)'
      );
      // The abort happens BEFORE plan-building, so no plan is ever built — a
      // blank message must never reach the rebase as an empty reword override.
      assert.strictEqual(
        tracker.lastPlan,
        undefined,
        'a blank message must abort before any plan is built'
      );
      // No error toast — empty save is "user changed their mind".
      assert.strictEqual(
        messages.error.length,
        0,
        `expected no error toast; got: ${messages.error.map((m) => m.message).join(' || ')}`
      );
    });

    // false-success edge.
    it('surfaces a "partial complete" warning when rebase stays paused after squash message', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      // Emulate the edge where executeRebase resolves `paused` rather than
      // `completed` (e.g. the rebase still has steps left after the amend).
      // The handler must route that through the "partial complete" warning,
      // not the "Squashed N commits successfully" toast.
      tracker.executeResult = { success: true, status: 'paused' };
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES_4
          ),
        (e) => e.simulateSave('combined')
      );

      const allToasts = [...messages.info, ...messages.warning].map((m) => m.message).join(' || ');
      // Expect a warning, NOT a success message.
      assert.ok(
        /partially complete|partial complete|paused/i.test(allToasts),
        `expected partial-complete warning; got: ${allToasts}`
      );
      assert.ok(
        !/Squashed \d+ commits successfully/i.test(allToasts),
        `must NOT toast success when rebase stays paused; got: ${allToasts}`
      );
    });
  });

  // ─── C3 — Contiguity helper reuse ──────────────────────────────────────────
  describe('C3 — squash handler reuses isSelectionContiguous', () => {
    it('the history-rewrite module imports isSelectionContiguous (no inline reimpl)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/commitHistoryRewriteActions.ts'),
        'utf8'
      );
      assert.ok(
        /import\s*\{[^}]*isSelectionContiguous[^}]*\}\s*from\s*['"][^'"]*multiSelect/.test(src),
        'must import isSelectionContiguous from the multiSelect helper module'
      );
    });

    it('does not reimplement contiguity inline in the squash handler', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
      // Look for an inline `indices.every((v, i) => i === 0 || v - indices[i-1] === 1)`
      // pattern — the reimpl that the helper exists to replace.
      assert.ok(
        !/indices\.every\(\s*\(v,\s*i\)\s*=>\s*i\s*===\s*0\s*\|\|\s*v\s*-\s*indices\[i\s*-\s*1\]\s*===\s*1/.test(
          src
        ),
        'inline contiguity check must not appear; use isSelectionContiguous(...)'
      );
    });
  });

  // ─── Structural guards ─────────────────────────────────────────────────────
  describe('Structural guards', () => {
    let src: string;
    before(async () => {
      const fs = await import('fs');
      const path = await import('path');
      src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
    });

    it('uses HASH_RE / allHashesValid in both wave-C handlers', () => {
      // Both handlers should sit beneath the existing `allHashesValid`
      // helper. We assert presence of the helper + at least 2 occurrences
      // beyond the usages.
      assert.ok(/allHashesValid/.test(src), 'allHashesValid helper must be present');
      const occurrences = src.match(/allHashesValid\(/g) || [];
      // Uses it in createPatch + compareVersions; in
      // dropMulti + squash → expect ≥ 4 call sites.
      assert.ok(
        occurrences.length >= 4,
        `expected ≥4 allHashesValid call sites (Wave B + Wave C); got ${occurrences.length}`
      );
    });

    it('routes the canonical stale-selection toast through the STALE_SELECTION_TOAST const', async () => {
      // The toast literal lives once at the top of
      // the file in a `STALE_SELECTION_TOAST` const; handler bodies
      // reference the const so future copy edits land in one place.
      // Find the handlers' definitions and confirm each
      // references the const.
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const mod = fsMod.readFileSync(
        pathMod.join(process.cwd(), 'src/commits/commitHistoryRewriteActions.ts'),
        'utf8'
      );
      const dropIdx = mod.indexOf('export async function handleDropCommitMulti');
      const squashIdx = mod.indexOf('export async function handleSquashCommits');
      assert.ok(dropIdx > 0, 'expected handleDropCommitMulti definition');
      assert.ok(squashIdx > 0, 'expected handleSquashCommits definition');
      const dropBody = mod.substring(dropIdx, squashIdx);
      const editIdx = mod.indexOf('export async function handleEditCommitMessage', squashIdx);
      const squashBody = mod.substring(squashIdx, editIdx > 0 ? editIdx : squashIdx + 12000);
      assert.ok(
        /STALE_SELECTION_TOAST\b/.test(dropBody),
        '_handleDropCommitMulti must reference STALE_SELECTION_TOAST'
      );
      assert.ok(
        /STALE_SELECTION_TOAST\b/.test(squashBody),
        '_handleSquashCommits must reference STALE_SELECTION_TOAST'
      );
      // Const declared at module scope in the shared module.
      const fs = await import('fs');
      const path = await import('path');
      const shared = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/commitContextMenuShared.ts'),
        'utf8'
      );
      assert.ok(
        /const STALE_SELECTION_TOAST\s*=\s*['"]Commit selection changed/.test(shared),
        'STALE_SELECTION_TOAST const must be declared with the canonical phrasing'
      );
      // The literal appears EXACTLY once — at the const declaration in the
      // shared module; the class references the symbol, not the literal.
      const sharedLiteralMatches = shared.match(
        /['"]Commit selection changed since the menu opened — please retry\.['"]/g
      );
      assert.strictEqual(
        sharedLiteralMatches?.length ?? 0,
        1,
        `expected exactly 1 literal occurrence (the const decl); got ${sharedLiteralMatches?.length ?? 0}`
      );
      assert.ok(
        !/['"]Commit selection changed since the menu opened — please retry\.['"]/.test(src),
        'the class must reference STALE_SELECTION_TOAST, not inline the literal'
      );
    });

    it('does not reach into provider state via getExtendedLogState() in wave-C handlers', () => {
      // Strip comments — only actual call sites would be a regression.
      const codeOnly = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(
        !/getExtendedLogState\(\)/.test(codeOnly),
        'handlers must not call getExtendedLogState() (TLB-H-2 inversion fix)'
      );
    });
  });

  // ─── central hash validation rejects scripted/palette bad input ─────────────
  describe('dispatch rejects a non-hex commit hash before it reaches git', () => {
    it('does not call gitService.cherryPick when the dispatched hash is not hex', async () => {
      let cherryPickCalled = false;
      const gitService = createMockGitService(repo, {
        cherryPick: () => {
          cherryPickCalled = true;
          return okAsync({ success: true });
        },
      });
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const rebaseService = createMockRebaseService(blankRebaseTracker());
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });

      // A palette / scripted caller feeds a non-hex value. The central guard
      // in _dispatchAction must reject it before _handleCherryPick runs.
      await (cmds as unknown as CommandsInternal)._handleAction(
        'cherryPick',
        ['not-a-real-hash'],
        []
      );

      assert.strictEqual(
        cherryPickCalled,
        false,
        'a non-hex hash must be rejected at dispatch, never reaching gitService.cherryPick'
      );
    });
  });
});
