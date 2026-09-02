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
import * as fsModule from 'fs';
import * as pathModule from 'path';
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
import { literalPathspec } from '../../../src/git-core/gitCli';
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
  continueCalls: number;
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
    continueCalls: 0,
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
    continueRebase: async () => {
      tracker.continueCalls++;
      return { success: true, status: 'completed' as const };
    },
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

interface HarnessOpts {
  /**
   * Served to the runner's merge-flattening pre-flight (`rev-list --count`
   * over `<onto>..HEAD`): total commits and non-merge commits in the range.
   * Omitted → the probe returns empty output and fails, which the gate
   * treats as fail-open (proceed) — existing cases stay on that path.
   */
  rangeCounts?: { total: number; nonMerges: number };
  /**
   * Served to the protected-branch pre-flight (`branch --remotes
   * --contains`): the remote branches containing the probed commit, one per
   * line. Omitted → empty output (contained nowhere) — existing cases stay
   * ungated.
   */
  remoteContains?: string;
  /**
   * Repository root for the harness repo. The in-progress pre-flight reads
   * REAL on-disk markers under `<root>/.git`; cases exercising it point this
   * at a tmp fixture. Omitted → the non-existent '/test-repo' (no markers —
   * probe finds nothing, existing cases stay ungated).
   */
  repoRoot?: string;
  /**
   * 'dropme.ts's status in `getCommitDiff`. Omitted → 'modified', the
   * existing cases' path (checkout HEAD^ restores it). 'added' rides the
   * drop-selected paused-drive's OTHER branch (`git rm -f`, no parent
   * revision to restore from).
   */
  dropmeStatus?: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
}

function makeHarness(tracker: RebaseTracker, opts: HarnessOpts = {}): Harness {
  const repo = {
    rootUri: Uri.file(opts.repoRoot ?? '/test-repo'),
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
    getCommitDiff: async () => [
      { path: 'dropme.ts', status: opts.dropmeStatus ?? 'modified', hunks: [], binary: false },
      { path: 'kept.ts', status: 'modified', hunks: [], binary: false },
    ],
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
      if (args[0] === 'rev-list' && args.includes('--count') && opts.rangeCounts) {
        const n = args.includes('--no-merges')
          ? opts.rangeCounts.nonMerges
          : opts.rangeCounts.total;
        return { exitCode: 0, stdout: `${n}\n`, stderr: '', combined: `${n}\n` };
      }
      if (
        args[0] === 'branch' &&
        args.includes('--remotes') &&
        args.includes('--contains') &&
        opts.remoteContains !== undefined
      ) {
        return {
          exitCode: 0,
          stdout: opts.remoteContains,
          stderr: '',
          combined: opts.remoteContains,
        };
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
  w.showQuickPick = (() => Promise.resolve(undefined)) as typeof w.showQuickPick;
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
  try {
    simulate(editorTracker);
  } catch {
    // A flow refused by a pre-dialog gate never opens the editor — nothing
    // to save. Cases that REQUIRE the editor assert its downstream effects
    // (plan contents, toasts), so a masked save failure still fails there.
  }
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

const dropSelected: BodyCase = {
  name: 'drop selected changes, non-HEAD (handleDropSelectedChanges)',
  target: 'drop',
  successFragment: /Dropped 1 file/,
  run: async (h) => {
    // HASH_MID is not the harness HEAD (HASH_NEWEST), so the flow must ride
    // the shared runner. Pick the first file ('dropme.ts'); the confirm
    // modal is auto-accepted by the harness warning stub.
    const w = writableWindow();
    w.showQuickPick = ((items: unknown) =>
      Promise.resolve(Array.isArray(items) ? [items[0]] : undefined)) as typeof w.showQuickPick;
    await (
      h.cmds as unknown as { dropSelectedChangesFromCommit(hash: string): Promise<void> }
    ).dropSelectedChangesFromCommit(HASH_MID);
  },
  staleRun: async (h) => {
    h.tracker.sessionCommits = [{ hash: HASH_NEWEST, message: 'newest', action: 'pick' }];
    const w = writableWindow();
    w.showQuickPick = ((items: unknown) =>
      Promise.resolve(Array.isArray(items) ? [items[0]] : undefined)) as typeof w.showQuickPick;
    await (
      h.cmds as unknown as { dropSelectedChangesFromCommit(hash: string): Promise<void> }
    ).dropSelectedChangesFromCommit(HASH_MID);
  },
};

const BODIES: BodyCase[] = [dropSingle, dropMulti, squash, fixup, reword, dropSelected];

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

  describe('merge-flattening gate (refuse when <onto>..HEAD contains merges)', () => {
    // IntelliJ refuses every commit-editing action when no merge-free path
    // exists between HEAD and the oldest selected commit
    // (GitCommitEditingActionBase.kt checkHeadLinearHistory) — a plain
    // `rebase -i` would flatten every merge in the range. The runner's
    // pre-flight probe mirrors that refusal for all bodies riding it.
    for (const body of BODIES) {
      it(`${body.name}: merge in range → refused before any rebase starts`, async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker, { rangeCounts: { total: 3, nonMerges: 2 } });

        await body.run(h);

        assert.strictEqual(
          tracker.startedOnto,
          undefined,
          'no planning session may start once the range is known to contain merges'
        );
        assert.strictEqual(tracker.executeCalls, 0, 'no rebase may execute');
        assert.strictEqual(h.dialogCalls.length, 0, 'no resolve dialog');
        assert.ok(
          h.messages.error.some((m) => /merge/i.test(m) && /--rebase-merges/.test(m)),
          `expected a refusal naming the flatten hazard + --rebase-merges; got ${JSON.stringify(
            h.messages.error
          )}`
        );
        assert.ok(
          !h.messages.info.some((m) => body.successFragment.test(m)),
          'must not claim success'
        );
      });

      it(`${body.name}: merge-free range proceeds`, async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker, { rangeCounts: { total: 2, nonMerges: 2 } });

        await body.run(h);

        assert.strictEqual(tracker.executeCalls, 1, 'a linear range must not be blocked');
        assert.ok(
          h.messages.info.some((m) => body.successFragment.test(m)),
          `expected the success toast; got ${JSON.stringify(h.messages.info)}`
        );
      });
    }

    it('probe failure fails OPEN (proceeds), matching the pre-gate contract', async () => {
      // rangeCounts omitted → the probe returns unparseable output and the
      // analysis degrades to undefined; the gate must not block a rebase the
      // user could run before it existed (the rebase itself surfaces real
      // errors).
      const tracker = blankTracker();
      const h = makeHarness(tracker);

      await dropSingle.run(h);

      assert.strictEqual(tracker.executeCalls, 1);
    });
  });

  describe('protected-branch gate (refuse when the oldest commit is on a protected remote branch)', () => {
    // IntelliJ blocks every commit-editing action when the commit is
    // contained in a protected remote branch
    // (GitCommitEditingActionBase.kt checkCommitsCanBeEdited /
    // lastCheckCommitsEditingAvailability, findProtectedRemoteBranch).
    // Checking the OLDEST rewritten commit suffices: if any rewritten commit
    // is published to a protected branch, so are its ancestors. The unit
    // config mock serves the schema default intellig.protectedBranches =
    // ['main', 'master'].
    for (const body of BODIES) {
      it(`${body.name}: oldest commit on origin/main → refused before any rebase`, async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker, { remoteContains: '  origin/main\n' });

        await body.run(h);

        assert.strictEqual(tracker.startedOnto, undefined, 'no planning session may start');
        assert.strictEqual(tracker.executeCalls, 0, 'no rebase may execute');
        assert.ok(
          h.messages.error.some((m) => m.includes('origin/main')),
          `expected a refusal NAMING the protected branch; got ${JSON.stringify(h.messages.error)}`
        );
        assert.ok(
          !h.messages.info.some((m) => body.successFragment.test(m)),
          'must not claim success'
        );
      });

      it(`${body.name}: commit on a NON-protected remote branch proceeds without a confirm`, async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker, { remoteContains: '  origin/feature\n' });

        await body.run(h);

        assert.strictEqual(
          tracker.executeCalls,
          1,
          'published-but-unprotected history is editable (protected list, not pushed-anywhere)'
        );
        assert.ok(
          h.messages.info.some((m) => body.successFragment.test(m)),
          `expected the success toast; got ${JSON.stringify(h.messages.info)}`
        );
      });
    }
  });

  describe('in-progress pre-flight (refuse while a rebase/sequencer is live)', () => {
    // With a rebase paused at an `edit` step (clean tree — the unmerged-files
    // probe passes), `git rebase -i` fails ("rebase-merge already exists")
    // but handleRebaseResult sees the PRE-EXISTING pause and the runner
    // toasted "<Op> partially complete — resume via 'git rebase --continue'"
    // — untrue (nothing started) and dangerous ('continue' drives the OTHER
    // rebase). IntelliJ prohibits commit editing during an unfinished
    // operation (GitRewordAction.kt:14-16, GitInteractiveRebaseAction
    // prohibit policies). The runner must refuse up front, on FRESH on-disk
    // markers.
    function makeMarkerRepo(marker: 'rebase-merge' | 'CHERRY_PICK_HEAD'): string {
      const tmpBase = pathModule.join(process.cwd(), 'workspace-notes', 'tmp');
      fsModule.mkdirSync(tmpBase, { recursive: true });
      const root = fsModule.mkdtempSync(pathModule.join(tmpBase, 'inprogress-'));
      const gitDir = pathModule.join(root, '.git');
      fsModule.mkdirSync(gitDir, { recursive: true });
      if (marker === 'rebase-merge') {
        fsModule.mkdirSync(pathModule.join(gitDir, 'rebase-merge'));
      } else {
        fsModule.writeFileSync(pathModule.join(gitDir, marker), 'a'.repeat(40) + '\n');
      }
      cleanupRoots.push(root);
      return root;
    }
    const cleanupRoots: string[] = [];
    after(() => {
      for (const root of cleanupRoots) {
        fsModule.rmSync(root, { recursive: true, force: true });
      }
    });

    for (const body of BODIES) {
      it(`${body.name}: live rebase-merge marker → refused, no rebase started`, async () => {
        const tracker = blankTracker();
        const h = makeHarness(tracker, { repoRoot: makeMarkerRepo('rebase-merge') });

        await body.run(h);

        assert.strictEqual(tracker.startedOnto, undefined, 'no planning session may start');
        assert.strictEqual(tracker.executeCalls, 0, 'no rebase may execute');
        assert.ok(
          h.messages.error.some((m) => /rebase is in progress/i.test(m)),
          `expected an in-progress refusal; got ${JSON.stringify(h.messages.error)}`
        );
        assert.ok(
          !h.messages.warning.some((m) => /partially complete/i.test(m)),
          `the false partially-complete toast must be dead; got ${JSON.stringify(
            h.messages.warning
          )}`
        );
      });
    }

    it('a live cherry-pick sequencer marker refuses too, naming the operation', async () => {
      const tracker = blankTracker();
      const h = makeHarness(tracker, { repoRoot: makeMarkerRepo('CHERRY_PICK_HEAD') });

      await dropSingle.run(h);

      assert.strictEqual(tracker.executeCalls, 0);
      assert.ok(
        h.messages.error.some((m) => /cherry-pick is in progress/i.test(m)),
        `expected the refusal to name the cherry-pick; got ${JSON.stringify(h.messages.error)}`
      );
    });
  });

  describe('drop selected changes — non-HEAD edit-pause surgery', () => {
    it('plans the target as `edit`; the paused drive restores the file from the parent, amends, continues', async () => {
      const tracker = blankTracker();
      // The rebase pauses at the target's edit step.
      tracker.executeResult = { success: true, status: 'paused' };
      const h = makeHarness(tracker);

      await dropSelected.run(h);

      // The plan keeps everything `pick` except the target, which pauses.
      const planned = tracker.lastPlan?.find((p) => p.hash === HASH_MID);
      assert.strictEqual(planned?.action, 'edit', 'the target commit must pause at an edit step');
      // At the pause: dropped path restored from the parent, then amend
      // preserving message + author, then continue.
      assert.ok(
        h.gitCliCalls.some(
          (c) =>
            c[0] === 'checkout' && c.includes('HEAD^') && c.includes(literalPathspec('dropme.ts'))
        ),
        `the dropped file must restore from the commit's parent; calls: ${JSON.stringify(
          h.gitCliCalls
        )}`
      );
      assert.ok(
        h.gitCliCalls.some((c) => c[0] === 'commit' && c.includes('--amend') && c.includes('-C')),
        `the rewritten commit must amend with its own metadata; calls: ${JSON.stringify(
          h.gitCliCalls
        )}`
      );
      assert.strictEqual(tracker.continueCalls, 1, 'the rebase must continue after the amend');
      assert.ok(
        h.messages.info.some((m) => /Dropped 1 file/.test(m)),
        `expected the success toast; got ${JSON.stringify(h.messages.info)}`
      );
      assert.strictEqual(tracker.abortCalls, 0);
    });

    it('an added dropped file is removed with `git rm -f --`, path wrapped literal', async () => {
      // Same pause, but the target added dropme.ts — no parent revision to
      // restore from, so the paused drive removes it instead of checking it
      // out. This site (commitDropActions.ts) had no test at all: stripping
      // its literalPathspec() wrap left `rm -f -- 'dropme.ts'`, indistinguishable
      // from this assertion's shape, EXCEPT that a real pathspec-magic name
      // (`a[1].ts`) would also delete a same-shaped neighbour with no error
      // and nothing to undo.
      const tracker = blankTracker();
      tracker.executeResult = { success: true, status: 'paused' };
      const h = makeHarness(tracker, { dropmeStatus: 'added' });

      await dropSelected.run(h);

      assert.ok(
        h.gitCliCalls.some(
          (c) => c[0] === 'rm' && c.includes('-f') && c.includes(literalPathspec('dropme.ts'))
        ),
        `an added dropped file must be removed via literal-wrapped rm -f; calls: ${JSON.stringify(
          h.gitCliCalls
        )}`
      );
      assert.ok(
        !h.gitCliCalls.some((c) => c[0] === 'checkout' && c.includes('HEAD^')),
        `an added file has no parent revision to restore from; calls: ${JSON.stringify(
          h.gitCliCalls
        )}`
      );
    });

    it('refuses when EVERY file is selected (use Drop Commit instead)', async () => {
      const tracker = blankTracker();
      const h = makeHarness(tracker);
      const w = writableWindow();
      w.showQuickPick = ((items: unknown) =>
        Promise.resolve(Array.isArray(items) ? [...(items as unknown[])] : undefined)) as never;

      await (
        h.cmds as unknown as { dropSelectedChangesFromCommit(hash: string): Promise<void> }
      ).dropSelectedChangesFromCommit(HASH_MID);

      assert.strictEqual(tracker.executeCalls, 0, 'no rebase may run');
      assert.ok(
        h.messages.error.some((m) => /Drop Commit/i.test(m)),
        `an all-files selection must redirect to Drop Commit; got ${JSON.stringify(
          h.messages.error
        )}`
      );
    });
  });

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
