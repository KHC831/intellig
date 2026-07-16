/**
 * Outcome contract of the shared history-rewrite runner
 * (`_runHistoryRewrite`), parametrized over the bodies that ride it.
 *
 * The invariants under test (one place, all four flows):
 *   I1 — a conflicted extension-driven rebase is left PAUSED: `abortRebase`
 *        never runs from the conflict arm, and no manual stash bracket runs
 *        (git owns save/restore via `rebase --autostash`).
 *   I2 — dialog affordances are truthful: `rebaseInProgress` is passed
 *        VERBATIM to the resolve dialog (continue/abort render iff a rebase
 *        is actually in progress).
 *   I5 — arms that may have moved HEAD reload the repo + refresh the log.
 *   stale — a stale/not-found plan clears the planning session and never
 *        aborts (no git rebase has started).
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
import { AUTOSTASH_PARKED_WARNING } from '../../../src/git-core/rebaseAutostash';

// ─── Scaffolding ─────────────────────────────────────────────────────────────

const HASH_NEWEST = '1111111111111111111111111111111111111111';
const HASH_MID = '2222222222222222222222222222222222222222';
const HASH_OLDEST = '3333333333333333333333333333333333333333';
const NODES: readonly IMenuStateNode[] = [
  { hash: HASH_NEWEST, parentCount: 1, parents: [HASH_MID] },
  { hash: HASH_MID, parentCount: 1, parents: [HASH_OLDEST] },
  { hash: HASH_OLDEST, parentCount: 1, parents: [] },
];

interface RebaseTracker {
  startedOnto: string | undefined;
  lastPlan: IRebaseAction[] | undefined;
  executeCalls: number;
  abortCalls: number;
  clearSessionCalls: number;
  sessionCommits: { hash: string; message: string; action: 'pick' }[];
  executeResult: IRebaseResult;
  provideRewordResult: IRebaseResult;
}

function blankTracker(): RebaseTracker {
  return {
    startedOnto: undefined,
    lastPlan: undefined,
    executeCalls: 0,
    abortCalls: 0,
    clearSessionCalls: 0,
    sessionCommits: [
      { hash: HASH_OLDEST, message: 'oldest', action: 'pick' },
      { hash: HASH_MID, message: 'mid', action: 'pick' },
      { hash: HASH_NEWEST, message: 'newest', action: 'pick' },
    ],
    executeResult: { success: true, status: 'completed' },
    provideRewordResult: { success: true, status: 'completed' },
  };
}

function makeRebaseService(tracker: RebaseTracker): IRebaseService {
  const emitter = new EventEmitter<undefined>();
  return {
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
    isManagingRebase: () => false,
    updateRebasePlan: (_repo: IRepository, plan: IRebaseAction[]) => {
      tracker.lastPlan = plan.map((a) => ({ ...a }));
    },
    clearSession: () => {
      tracker.clearSessionCalls++;
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
    provideRewordMessage: async () => tracker.provideRewordResult,
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: emitter.event,
    dispose: () => {},
  } as unknown as IRebaseService;
}

interface Harness {
  cmds: CommitContextMenuCommands;
  tracker: RebaseTracker;
  gitCliCalls: string[][];
  dialogCalls: Array<{
    conflicts: { path: string; resolved: boolean }[];
    options: { operation: string; target?: string; canAbort?: boolean; canContinue?: boolean };
  }>;
  reloadCalls: number;
  refreshCalls: () => number;
  messages: { info: string[]; warning: string[]; error: string[] };
}

function makeHarness(tracker: RebaseTracker): Harness {
  const repo = {
    rootUri: Uri.file('/test-repo'),
    state: { HEAD: { name: 'main', commit: HASH_NEWEST, type: 0 as const } },
    head: { name: 'main', commit: HASH_NEWEST },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;

  const harness = {
    reloadCalls: 0,
  } as unknown as Harness;

  const gitService = {
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getRepository: async () => repo,
    getCommit: async (_r: IRepository, hash: string) => ({
      hash,
      shortHash: hash.substring(0, 7),
      message: `subject for ${hash.substring(0, 8)}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [HASH_OLDEST],
      authorDate: new Date(0),
      commitDate: new Date(0),
    }),
    getMergeBase: async (_r: IRepository, a: string) => a,
    getStatus: async () => [],
    reloadRepository: async () => {
      harness.reloadCalls++;
    },
    dispose: () => {},
  } as unknown as IGitService;

  let refreshCount = 0;
  const provider = {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refresh: () => {
      refreshCount++;
    },
  } as unknown as GitToolWindowProvider;

  const gitCliCalls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      gitCliCalls.push([...args]);
      if (args[0] === 'log') {
        return { exitCode: 0, stdout: 'subject\n', stderr: '', combined: 'subject\n' };
      }
      // `status --porcelain -z` (the pre-flight) reports a clean tree.
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    execString: async () => '',
    isAvailable: async () => true,
    getVersion: () => okAsync('2.40.0'),
    isRepository: () => okAsync(true),
    getRepositoryRoot: () => okAsync('/test-repo'),
    dispose: () => {},
    onCommandExecuted: () => ({ dispose: () => {} }),
  } as unknown as GitCli;

  const dialogCalls: Harness['dialogCalls'] = [];
  const conflictSvc = {
    openResolveConflictsDialog: async (
      _repo: IRepository,
      conflicts: { path: string; resolved: boolean }[],
      options: { operation: string; target?: string; canAbort?: boolean; canContinue?: boolean }
    ) => {
      dialogCalls.push({ conflicts, options });
    },
  } as unknown as IConflictResolutionService;

  const messages: Harness['messages'] = { info: [], warning: [], error: [] };
  const w = writableWindow();
  w.showInformationMessage = ((message: string) => {
    messages.info.push(message);
    return Promise.resolve(undefined);
  }) as typeof w.showInformationMessage;
  w.showErrorMessage = ((message: string) => {
    messages.error.push(message);
    return Promise.resolve(undefined);
  }) as typeof w.showErrorMessage;
  w.showWarningMessage = ((message: string, ...items: unknown[]) => {
    messages.warning.push(message);
    // Accept whichever single action item the destructive confirm offers
    // ('Drop', 'Reword Anyway', …); toasts without items resolve undefined.
    const first = items.find((i) => typeof i === 'string');
    return Promise.resolve(first);
  }) as typeof w.showWarningMessage;

  harness.cmds = new CommitContextMenuCommands(
    gitService,
    makeRebaseService(tracker),
    provider,
    gitCli,
    conflictSvc
  );
  harness.tracker = tracker;
  harness.gitCliCalls = gitCliCalls;
  harness.dialogCalls = dialogCalls;
  harness.refreshCalls = () => refreshCount;
  harness.messages = messages;
  return harness;
}

function restoreWindow(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showWarningMessage = () => Promise.resolve(undefined);
  w.showInputBox = (opts?: import('vscode').InputBoxOptions) => Promise.resolve(opts?.value);
}

interface CommandsInternal {
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
  /** Fixup mode has no dispatcher arm; the suite drives the body directly. */
  _handleSquashCommits(
    hashes: string[],
    commitNodes: readonly IMenuStateNode[],
    options?: { mode?: 'squash' | 'fixup' }
  ): Promise<void>;
}

async function flushMacroTasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Squash and reword open an editor; run handler + save-simulator together. */
async function runWithEditor(
  action: () => Promise<void>,
  simulate: (t: MessageEditorTracker) => void
): Promise<void> {
  const editorTracker = installMessageEditorStubs();
  const handler = action();
  await flushMacroTasks();
  simulate(editorTracker);
  await handler;
}

/**
 * One entry per body riding the shared runner. `run` drives the flow through
 * the public dispatch surface, answering whatever op-specific dialog the body
 * opens before the rebase starts.
 */
interface BodyCase {
  name: string;
  target: 'drop' | 'squash' | 'reword';
  /** Substring of the success toast on a completed rebase. */
  successFragment: RegExp;
  run: (harness: Harness) => Promise<void>;
  /** Hash the stale-plan case should remove from the session window. */
  staleRun?: (harness: Harness) => Promise<void>;
}

const dropSingle: BodyCase = {
  name: 'single drop (_handleDropCommit)',
  target: 'drop',
  successFragment: /Dropped commit/,
  run: async (h) => {
    await (h.cmds as unknown as CommandsInternal)._handleAction('dropCommit', [HASH_MID], NODES);
  },
  staleRun: async (h) => {
    // The target hash is absent from the rebase session window → stale.
    h.tracker.sessionCommits = [{ hash: HASH_NEWEST, message: 'newest', action: 'pick' }];
    await (h.cmds as unknown as CommandsInternal)._handleAction('dropCommit', [HASH_MID], NODES);
  },
};

const dropMulti: BodyCase = {
  name: 'multi drop (_handleDropCommitMulti)',
  target: 'drop',
  successFragment: /Dropped 2 commits/,
  run: async (h) => {
    await (h.cmds as unknown as CommandsInternal)._handleAction(
      'dropCommit',
      [HASH_NEWEST, HASH_MID],
      NODES
    );
  },
  staleRun: async (h) => {
    // Session window misses one selected hash → plan-coverage guard → stale.
    h.tracker.sessionCommits = [{ hash: HASH_NEWEST, message: 'newest', action: 'pick' }];
    await (h.cmds as unknown as CommandsInternal)._handleAction(
      'dropCommit',
      [HASH_NEWEST, HASH_MID],
      NODES
    );
  },
};

const squash: BodyCase = {
  name: 'squash (_handleSquashCommits)',
  target: 'squash',
  successFragment: /Squashed 2 commits/,
  run: async (h) => {
    await runWithEditor(
      () =>
        (h.cmds as unknown as CommandsInternal)._handleAction(
          'squashCommits',
          [HASH_NEWEST, HASH_MID],
          NODES
        ),
      (e) => e.simulateSave('combined message')
    );
  },
};

const fixup: BodyCase = {
  name: "fixup (_handleSquashCommits mode:'fixup')",
  target: 'squash',
  successFragment: /Fixup'd 2 commits/,
  run: async (h) => {
    await (h.cmds as unknown as CommandsInternal)._handleSquashCommits(
      [HASH_NEWEST, HASH_MID],
      NODES,
      { mode: 'fixup' }
    );
  },
};

const reword: BodyCase = {
  name: 'reword non-HEAD (_handleEditCommitMessage)',
  target: 'reword',
  successFragment: /Updated commit message/,
  run: async (h) => {
    await runWithEditor(
      () =>
        (h.cmds as unknown as CommandsInternal)._handleAction(
          'editCommitMessage',
          [HASH_MID],
          NODES
        ),
      (e) => e.simulateSave('new message')
    );
  },
  staleRun: async (h) => {
    h.tracker.sessionCommits = [{ hash: HASH_NEWEST, message: 'newest', action: 'pick' }];
    await runWithEditor(
      () =>
        (h.cmds as unknown as CommandsInternal)._handleAction(
          'editCommitMessage',
          [HASH_MID],
          NODES
        ),
      (e) => e.simulateSave('new message')
    );
  },
};

const BODIES: BodyCase[] = [dropSingle, dropMulti, squash, fixup, reword];

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('history-rewrite outcome contract (shared runner invariants)', () => {
  afterEach(() => restoreWindow());

  for (const body of BODIES) {
    describe(body.name, () => {
      it('I1/I2: live replay conflict → rebase left PAUSED, dialog affordances truthful', async () => {
        const tracker = blankTracker();
        tracker.executeResult = {
          success: false,
          status: 'conflict',
          conflictedFiles: ['src/conflicted.ts'],
          rebaseInProgress: true,
        };
        // Reword consumes its own pauses; a conflict from the paused drive
        // must route through the same outcome switch.
        tracker.provideRewordResult = tracker.executeResult;
        const h = makeHarness(tracker);

        await body.run(h);

        assert.strictEqual(
          tracker.abortCalls,
          0,
          'a conflicted rebase must be left paused — abort is user-initiated only'
        );
        assert.ok(
          !h.gitCliCalls.some((c) => c[0] === 'stash'),
          `no manual stash bracket may run (git owns --autostash); calls: ${JSON.stringify(
            h.gitCliCalls
          )}`
        );
        assert.strictEqual(h.dialogCalls.length, 1, 'resolve dialog must open');
        assert.strictEqual(h.dialogCalls[0].options.operation, 'rebase');
        assert.strictEqual(h.dialogCalls[0].options.target, body.target);
        assert.strictEqual(h.dialogCalls[0].options.canContinue, true);
        assert.strictEqual(h.dialogCalls[0].options.canAbort, true);
        assert.deepStrictEqual(
          h.dialogCalls[0].conflicts.map((c) => c.path),
          ['src/conflicted.ts']
        );
        assert.ok(
          h.messages.warning.some((m) => /conflict/i.test(m) && /resolve/i.test(m)),
          `expected a resolve-to-continue warning; got: ${JSON.stringify(h.messages.warning)}`
        );
        assert.ok(
          !h.messages.warning.concat(h.messages.error).some((m) => /aborted/i.test(m)),
          `nothing may claim the operation was aborted; got: ${JSON.stringify([
            ...h.messages.warning,
            ...h.messages.error,
          ])}`
        );
        assert.ok(h.reloadCalls >= 1, 'HEAD moved to the replayed prefix — must reload');
        assert.ok(h.refreshCalls() >= 1, 'log must refresh');
      });

      it('I2: terminal conflict (no rebase in progress) → resolve-only dialog, no abort', async () => {
        const tracker = blankTracker();
        tracker.executeResult = {
          success: false,
          status: 'conflict',
          conflictedFiles: ['src/conflicted.ts'],
          rebaseInProgress: false,
        };
        tracker.provideRewordResult = tracker.executeResult;
        const h = makeHarness(tracker);

        await body.run(h);

        assert.strictEqual(tracker.abortCalls, 0, 'nothing to abort after a terminal conflict');
        assert.strictEqual(h.dialogCalls.length, 1);
        assert.strictEqual(h.dialogCalls[0].options.canContinue, false);
        assert.strictEqual(h.dialogCalls[0].options.canAbort, false);
      });

      it('completed → success toast, no dialog, no stash machinery', async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker);

        await body.run(h);

        assert.ok(
          h.messages.info.some((m) => body.successFragment.test(m)),
          `expected success toast ${body.successFragment}; got: ${JSON.stringify(h.messages.info)}`
        );
        assert.strictEqual(h.dialogCalls.length, 0, 'no dialog on success');
        assert.ok(
          !h.gitCliCalls.some((c) => c[0] === 'stash'),
          'no manual stash bracket on the success path'
        );
        assert.strictEqual(tracker.abortCalls, 0);
        assert.ok(h.reloadCalls >= 1, 'HEAD rewritten — must reload');
      });

      if (body.staleRun) {
        it('stale plan → clearSession, never abortRebase, no rebase executed', async () => {
          const tracker = blankTracker();
          const h = makeHarness(tracker);

          await body.staleRun!(h);

          assert.strictEqual(tracker.executeCalls, 0, 'a stale plan must never execute');
          assert.strictEqual(
            tracker.abortCalls,
            0,
            'no git rebase has started — abort would ride the phantom-clear'
          );
          assert.strictEqual(
            tracker.clearSessionCalls,
            1,
            'the planning session must be cleared truthfully'
          );
        });
      }
    });
  }

  describe('reword paused drive', () => {
    it('conflict surfaced INSIDE the paused-reword loop routes through the same switch (no abort)', async () => {
      const tracker = blankTracker();
      // The initial rebase pauses at the reword step; providing the message
      // then hits a replay conflict.
      tracker.executeResult = { success: true, status: 'paused' };
      tracker.provideRewordResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/conflicted.ts'],
        rebaseInProgress: true,
      };
      const h = makeHarness(tracker);

      await reword.run(h);

      assert.strictEqual(tracker.abortCalls, 0, 'the paused-drive conflict must not abort');
      assert.strictEqual(h.dialogCalls.length, 1, 'resolve dialog must open');
      assert.strictEqual(h.dialogCalls[0].options.target, 'reword');
      assert.strictEqual(h.dialogCalls[0].options.canContinue, true);
    });

    it("cleared-stale from the paused drive reports the no-op honestly (no 'updated' toast)", async () => {
      const tracker = blankTracker();
      tracker.executeResult = { success: true, status: 'paused' };
      tracker.provideRewordResult = { success: true, status: 'cleared-stale' };
      const h = makeHarness(tracker);

      await reword.run(h);

      assert.ok(
        h.messages.info.some((m) => /no rebase in progress/i.test(m)),
        `expected the cleared-stale toast; got: ${JSON.stringify(h.messages.info)}`
      );
      assert.ok(
        !h.messages.info.some((m) => /updated commit message/i.test(m)),
        'must not claim the message was rewritten'
      );
    });
  });

  describe('parked-autostash surfacing', () => {
    it('completed result with autostashParked surfaces the shared warning copy', async () => {
      const tracker = blankTracker();
      tracker.executeResult = { success: true, status: 'completed', autostashParked: true };
      const h = makeHarness(tracker);

      await dropSingle.run(h);

      assert.ok(
        h.messages.info.some((m) => /Dropped commit/.test(m)),
        'the success toast still fires'
      );
      assert.ok(
        h.messages.warning.some((m) => m === AUTOSTASH_PARKED_WARNING),
        `expected the parked-autostash warning; got: ${JSON.stringify(h.messages.warning)}`
      );
    });

    it('completed result without the flag stays silent about the stash', async () => {
      const tracker = blankTracker();
      const h = makeHarness(tracker);

      await dropSingle.run(h);

      assert.ok(
        !h.messages.warning.some((m) => m === AUTOSTASH_PARKED_WARNING),
        'no parked warning on a clean completion'
      );
    });
  });
});
