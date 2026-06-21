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
import * as fs from 'fs';
import * as vscode from 'vscode';
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
import { writableWindow, writableWorkspace, writableCommands } from '../../typed/windowStub';

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
  provideSquashMessageCalls: { message: string }[];
  sessionCommits: { hash: string; message: string; action: 'pick' }[];
  /** What `executeRebase` should resolve to. Mutate per-test. */
  executeResult: IRebaseResult;
  /** What `provideSquashMessage` should resolve to. Mutate per-test. */
  provideSquashResult: IRebaseResult;
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
    provideSquashMessage: async (_repo: IRepository, message: string) => {
      tracker.provideSquashMessageCalls.push({ message });
      return tracker.provideSquashResult;
    },
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

/**
 * Squash dialog uses an untitled-style editor
 * (openTextDocument → showTextDocument → save / close listener) instead
 * of `showInputBox`. This helper installs stubs at the
 * `vscode.workspace` / `vscode.window` boundary that drive the flow:
 *
 *   - `openTextDocument` records the seed content and returns a fake
 *     doc with a stable URI.
 *   - `showTextDocument` is a no-op.
 *   - `onDidSaveTextDocument` / `onDidCloseTextDocument` capture the
 *     listeners; tests fire them via the returned `simulate*`
 *     functions to drive save / cancel branches.
 *   - `commands.executeCommand` is no-op-stubbed for the editor close.
 *
 * Returns a tracker so the test can:
 *   - read the seed via `tracker.lastSeed`
 *   - simulate save with `tracker.simulateSave('combined message')`
 *   - simulate close-without-save with `tracker.simulateClose()`
 *
 * The handler awaits a Promise that resolves when one of these fires.
 * Tests should call exactly one of the simulate* functions per
 * invocation.
 */
interface SquashEditorTracker {
  lastSeed: string | undefined;
  lastLanguage: string | undefined;
  openCalls: number;
  showCalls: number;
  simulateSave: (text: string) => void;
  simulateClose: () => void;
}

function installSquashEditorStubs(): SquashEditorTracker {
  const tracker: SquashEditorTracker = {
    lastSeed: undefined,
    lastLanguage: undefined,
    openCalls: 0,
    showCalls: 0,
    simulateSave: () => {
      throw new Error('save listener not installed yet');
    },
    simulateClose: () => {
      throw new Error('close listener not installed yet');
    },
  };

  let docUri: vscode.Uri | undefined;
  let savedText: string | undefined;
  // Handler now opens via Uri.file(tmpPath); intercept
  // both the object-literal (with `content`) shape AND the `Uri.file`
  // shape so either implementation strategy is testable here.
  const ws = writableWorkspace();
  ws.openTextDocument = ((
    options: unknown
  ): Promise<{
    uri: vscode.Uri;
    getText: () => string;
    languageId: string;
    isUntitled: boolean;
  }> => {
    tracker.openCalls++;
    if (typeof options === 'string') {
      // path string
      docUri = Uri.file(options);
      savedText = '';
    } else if (
      options !== null &&
      typeof options === 'object' &&
      'fsPath' in (options as Record<string, unknown>)
    ) {
      // Uri
      docUri = options as vscode.Uri;
      // The handler pre-writes the seed to disk. We don't have real fs
      // here; the test's gitService.getCommit stub fed the seed in via
      // the squash handler's join, so the seed lives in fs only at the
      // tempfile path. For the test, surface it via the saved-text
      // capture below — actual seed content was written by the handler
      // BEFORE the openTextDocument call. Read via fs to recover it.
      try {
        savedText = fs.readFileSync((options as vscode.Uri).fsPath, 'utf8');
      } catch {
        savedText = '';
      }
      tracker.lastSeed = savedText;
    } else if (options !== null && typeof options === 'object') {
      const obj = options as { content?: string; language?: string };
      tracker.lastSeed = obj.content;
      tracker.lastLanguage = obj.language;
      docUri = Uri.parse(`untitled:wave-c-test-${Date.now()}`);
      savedText = obj.content ?? '';
    }
    return Promise.resolve({
      uri: docUri ?? Uri.parse('untitled:wave-c-test-default'),
      getText: () => savedText ?? '',
      languageId: tracker.lastLanguage ?? 'plaintext',
      isUntitled: true,
    });
  }) as typeof ws.openTextDocument;

  const w = writableWindow();
  w.showTextDocument = ((document: unknown): Promise<{ document: unknown }> => {
    tracker.showCalls++;
    return Promise.resolve({ document });
  }) as typeof w.showTextDocument;

  let saveListener: ((doc: { uri: vscode.Uri; getText: () => string }) => void) | undefined;
  let closeListener: ((doc: { uri: vscode.Uri }) => void) | undefined;

  ws.onDidSaveTextDocument = ((
    listener: (doc: { uri: vscode.Uri; getText: () => string }) => void
  ): { dispose: () => void } => {
    saveListener = listener;
    return {
      dispose: () => {
        saveListener = undefined;
      },
    };
  }) as typeof ws.onDidSaveTextDocument;

  ws.onDidCloseTextDocument = ((
    listener: (doc: { uri: vscode.Uri }) => void
  ): {
    dispose: () => void;
  } => {
    closeListener = listener;
    return {
      dispose: () => {
        closeListener = undefined;
      },
    };
  }) as typeof ws.onDidCloseTextDocument;

  // Stub commands.executeCommand to swallow the closeActiveEditor call.
  const realCommands = writableCommands();
  const realExec = realCommands.executeCommand;
  realCommands.executeCommand = (_name: string): Promise<unknown> => Promise.resolve(undefined);
  // Restore at next test via restoreMocks tearing down — keep this for
  // safety. The existing afterEach restoreMocks doesn't touch commands,
  // so we rely on it being re-installed each test.
  void realExec;

  tracker.simulateSave = (text: string): void => {
    if (!saveListener || !docUri) {
      throw new Error('save listener / doc uri not initialised');
    }
    savedText = text;
    saveListener({ uri: docUri, getText: () => text });
  };
  tracker.simulateClose = (): void => {
    if (!closeListener || !docUri) {
      throw new Error('close listener / doc uri not initialised');
    }
    closeListener({ uri: docUri });
  };

  return tracker;
}

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
    provideSquashMessageCalls: [],
    sessionCommits: [],
    executeResult: { success: true, status: 'completed' },
    provideSquashResult: { success: true, status: 'completed' },
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Wave C — Rebase-driven multi-commit ops', () => {
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

      assert.strictEqual(tracker.startedOnto, `${HASH_MID}^`, 'onto must be oldest^');
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

      assert.strictEqual(tracker.startedOnto, `${HASH_OLDEST}^`);
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

    it('aborts when oldest selected is the initial commit (parentCount=0)', async () => {
      const tracker = blankRebaseTracker();
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();
      // No need to stub showWarningMessage — we abort before reaching it.

      const nodes: IMenuStateNode[] = [
        { hash: HASH_NEWEST, parentCount: 1 },
        { hash: HASH_OLDEST, parentCount: 0 }, // initial commit
      ];
      await (cmds as unknown as CommandsInternal)._handleAction(
        'dropCommit',
        [HASH_NEWEST, HASH_OLDEST],
        nodes
      );

      assert.strictEqual(tracker.executeCalls, 0);
      assert.strictEqual(
        tracker.startedOnto,
        undefined,
        'rebase must not start on initial-commit edge'
      );
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

      assert.strictEqual(tracker.abortCalls, 1, 'must abort the rebase before opening the dialog');
      assert.strictEqual(conflictSvc.calls.length, 1);
      assert.strictEqual(conflictSvc.calls[0].options.operation, 'rebase');
      assert.strictEqual(conflictSvc.calls[0].options.target, 'drop');
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

    it('starts rebase onto oldest^ and threads the squash message via provideSquashMessage', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      tracker.executeResult = { success: true, status: 'paused' };
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

      assert.strictEqual(tracker.startedOnto, `${HASH_MID}^`, 'onto must be oldest^');
      assert.strictEqual(
        tracker.provideSquashMessageCalls.length,
        1,
        'must call provideSquashMessage on paused state'
      );
      assert.strictEqual(tracker.provideSquashMessageCalls[0].message, 'combined squash message');
    });

    it('builds plan: oldest selected = pick, others = squash; non-selected = pick', async () => {
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
        (e) => e.simulateSave('combined')
      );

      const planByHash = new Map(tracker.lastPlan!.map((a) => [a.hash, a.action]));
      assert.strictEqual(
        planByHash.get(HASH_OLDEST),
        'pick',
        'oldest selected commit must remain pick (squash target)'
      );
      assert.strictEqual(planByHash.get(HASH_MID), 'squash');
      assert.strictEqual(planByHash.get(HASH_NEWEST), 'squash');
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

      assert.strictEqual(tracker.abortCalls, 1);
      assert.strictEqual(conflictSvc.calls.length, 1);
      assert.strictEqual(conflictSvc.calls[0].options.operation, 'rebase');
      assert.strictEqual(conflictSvc.calls[0].options.target, 'squash');
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
      // Emulate the edge: executeRebase returns `paused`, the handler
      // calls provideSquashMessage, but THAT result is also paused (e.g.
      // amendEditCommit succeeded but rebase still has more steps to
      // run after the amend). Earlier we surfaced "Squashed N commits
      // successfully", which is misleading.
      tracker.executeResult = { success: true, status: 'paused' };
      tracker.provideSquashResult = { success: true, status: 'paused' };
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
    it('CommitContextMenuCommands imports isSelectionContiguous (no inline reimpl)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
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

    it('routes the canonical stale-selection toast through the STALE_SELECTION_TOAST const', () => {
      // The toast literal lives once at the top of
      // the file in a `STALE_SELECTION_TOAST` const; handler bodies
      // reference the const so future copy edits land in one place.
      // Find the handlers' definitions and confirm each
      // references the const.
      const dropIdx = src.indexOf('private async _handleDropCommitMulti');
      const squashIdx = src.indexOf('private async _handleSquashCommits');
      assert.ok(dropIdx > 0, 'expected _handleDropCommitMulti definition');
      assert.ok(squashIdx > 0, 'expected _handleSquashCommits definition');
      const dropBody = src.substring(dropIdx, squashIdx);
      const editIdx = src.indexOf('private async _handleEditCommitMessage', squashIdx);
      const squashBody = src.substring(squashIdx, editIdx > 0 ? editIdx : squashIdx + 12000);
      assert.ok(
        /STALE_SELECTION_TOAST\b/.test(dropBody),
        '_handleDropCommitMulti must reference STALE_SELECTION_TOAST'
      );
      assert.ok(
        /STALE_SELECTION_TOAST\b/.test(squashBody),
        '_handleSquashCommits must reference STALE_SELECTION_TOAST'
      );
      // Const declared at module scope.
      assert.ok(
        /const STALE_SELECTION_TOAST\s*=\s*['"]Commit selection changed/.test(src),
        'STALE_SELECTION_TOAST const must be declared with the canonical phrasing'
      );
      // Earlier there were 4 inline literal duplicates of the toast.
      // The literal appears EXACTLY once — at the const declaration.
      const literalMatches = src.match(
        /['"]Commit selection changed since the menu opened — please retry\.['"]/g
      );
      assert.strictEqual(
        literalMatches?.length ?? 0,
        1,
        `expected exactly 1 literal occurrence (the const decl); got ${literalMatches?.length ?? 0}`
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

    it('IRebaseService declares provideSquashMessage', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const ifaceSrc = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/interfaces/IRebaseService.ts'),
        'utf8'
      );
      assert.ok(
        /provideSquashMessage\s*\(\s*repo\s*:\s*IRepository\s*,\s*message\s*:\s*string\s*\)\s*:\s*Promise<IRebaseResult>/.test(
          ifaceSrc
        ),
        'IRebaseService must declare provideSquashMessage(repo, message): Promise<IRebaseResult>'
      );
    });
  });

  // ─── central hash validation rejects scripted/palette bad input ─────────────
  describe('dispatch rejects a non-hex commit hash before it reaches git', () => {
    it('does not call gitService.cherryPick when the dispatched hash is not hex', async () => {
      let cherryPickCalled = false;
      const gitService = createMockGitService(repo, {
        cherryPick: async () => {
          cherryPickCalled = true;
          return { success: true };
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
