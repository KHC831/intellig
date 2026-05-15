/**
 * Unit tests for the T1-02 Pull Dialog.
 *
 * Covers:
 *  - Pure flag-mutex resolution (`resolveFlagMutex`, `applyFlagSelection`).
 *  - Source picker item construction (`buildSourceItems`).
 *  - Flag picker item construction (`buildFlagItems`).
 *  - Default flag seeding (`defaultPullFlags`) including preset handling.
 *  - Conflict-error detection (`isConflictError`).
 *  - End-to-end flow via `runPullDialog` with injected prompt helpers:
 *      * flag → CLI arg mapping for each flag
 *      * preset "rebase" pre-fills --rebase
 *      * preset "merge" clears --rebase even when pullRebase config is true
 *      * mutex: turning on --rebase clears --ff-only / --no-ff
 *      * success → info toast, no warnings
 *      * CONFLICT on stderr → warning fallback (T1-08(b) TODO stays)
 *      * generic failure → error toast
 *      * cancel at source step → no pull
 *      * cancel at flags step → no pull
 *      * flags step submitted without ▶ Pull confirmation → no pull
 *  - CLI arg order in `GitService.pull` via a mocked gitCli-shaped stub.
 */

/*
 * Stub factories synthesise IGitService / gitCli implementations whose
 * member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ALL_PULL_FLAGS,
  applyFlagSelection,
  buildFlagItems,
  buildSourceItems,
  defaultPullFlags,
  IPullFlagItem,
  IRunPullDialogDeps,
  isConflictError,
  PullFlagKey,
  resolveFlagMutex,
  runPullDialog,
} from '../../../services/PullDialog';
import {
  IBranch,
  IGitService,
  IPullOptions,
  IRepository,
} from '../../../services/interfaces/IGitService';
import { IConflictResolutionService } from '../../../services/interfaces/IConflictResolutionService';
import { Uri } from '../../mocks/vscode';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: {
      name: 'refs/heads/main',
      commit: 'deadbeef',
      upstream: { remote: 'origin', name: 'main' },
      ahead: 0,
      behind: 0,
    },
    remotes: [{ name: 'origin' }, { name: 'upstream' }],
    submodules: [],
  };
}

function createRemoteBranches(): IBranch[] {
  return [
    { name: 'origin/main', type: 'remote', commit: 'a'.repeat(40), isHead: false },
    { name: 'origin/develop', type: 'remote', commit: 'b'.repeat(40), isHead: false },
    { name: 'upstream/main', type: 'remote', commit: 'c'.repeat(40), isHead: false },
  ];
}

interface HarnessOptions {
  branches?: IBranch[];
  pullError?: Error;
  /** Items to "click" in the source picker (by label). */
  sourcePick?: string | null;
  /** Flag labels to "check" in the options picker, plus '$(play) Pull' to confirm. */
  flagPicks?: string[];
  /** Override the flags picker return with undefined (simulates Esc). */
  flagPickerCancelled?: boolean;
  /** Override the source picker return with undefined (simulates Esc). */
  sourcePickerCancelled?: boolean;
  defaultRebase?: boolean;
  preset?: 'rebase' | 'merge';
  prefilledSource?: { remote: string; branch: string };
}

interface HarnessState {
  repo: IRepository;
  deps: IRunPullDialogDeps;
  pullCalls: Array<{ repo: IRepository; options?: IPullOptions }>;
  infoMessages: string[];
  warningMessages: string[];
  errorMessages: string[];
  singleCalls: Array<{ items: vscode.QuickPickItem[]; options: vscode.QuickPickOptions }>;
  multiCalls: Array<{ items: vscode.QuickPickItem[]; options: vscode.QuickPickOptions }>;
  openResolveConflictsDialogCalls: Array<{
    repo: IRepository;
    conflicts: ReadonlyArray<{ path: string; resolved: boolean }>;
    opContext: {
      operation: string;
      target?: string;
      canAbort: boolean;
      canContinue: boolean;
    };
  }>;
}

interface HarnessOptionsWithConflict extends HarnessOptions {
  conflictedFiles?: ReadonlyArray<{ path: string; resolved: boolean }>;
  openResolveConflictsDialogError?: Error;
}

function createHarness(options: HarnessOptionsWithConflict = {}): HarnessState {
  const repo = createRepo();
  const branches = options.branches ?? createRemoteBranches();
  const pullCalls: HarnessState['pullCalls'] = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];
  const errorMessages: string[] = [];
  const singleCalls: HarnessState['singleCalls'] = [];
  const multiCalls: HarnessState['multiCalls'] = [];
  const openResolveConflictsDialogCalls: HarnessState['openResolveConflictsDialogCalls'] = [];

  const gitService = {
    getBranches: async () => branches,
    pull: async (r: IRepository, opts?: IPullOptions) => {
      pullCalls.push({ repo: r, options: opts });
      if (options.pullError) {
        throw options.pullError;
      }
    },
  } as unknown as IGitService;

  const conflictResolutionService = {
    getConflictedFiles: async () => options.conflictedFiles ?? [],
    hasUnresolvedConflicts: async () => (options.conflictedFiles ?? []).length > 0,
    openResolveConflictsDialog: async (
      r: IRepository,
      conflicts: ReadonlyArray<{ path: string; resolved: boolean }>,
      opContext: {
        operation: string;
        target?: string;
        canAbort: boolean;
        canContinue: boolean;
      }
    ) => {
      openResolveConflictsDialogCalls.push({ repo: r, conflicts, opContext });
      if (options.openResolveConflictsDialogError) {
        throw options.openResolveConflictsDialogError;
      }
    },
  } as unknown as IConflictResolutionService;

  const deps: IRunPullDialogDeps = {
    repo,
    gitService,
    conflictResolutionService,
    defaultRebase: options.defaultRebase ?? false,
    preset: options.preset,
    prefilledSource: options.prefilledSource,
    showQuickPickSingle: async <T extends vscode.QuickPickItem>(
      items: ReadonlyArray<T>,
      pickOptions: vscode.QuickPickOptions
    ): Promise<T | undefined> => {
      singleCalls.push({
        items: items as unknown as vscode.QuickPickItem[],
        options: pickOptions,
      });
      if (options.sourcePickerCancelled) {
        return undefined;
      }
      const targetLabel = options.sourcePick ?? '$(cloud) main';
      return items.find((i) => i.label === targetLabel);
    },
    showQuickPickMulti: async <T extends vscode.QuickPickItem>(
      items: ReadonlyArray<T>,
      pickOptions: vscode.QuickPickOptions & { canPickMany: true }
    ): Promise<ReadonlyArray<T> | undefined> => {
      multiCalls.push({
        items: items as unknown as vscode.QuickPickItem[],
        options: pickOptions,
      });
      if (options.flagPickerCancelled) {
        return undefined;
      }
      const picks = options.flagPicks ?? ['$(play) Pull'];
      return items.filter((i) => picks.includes(i.label));
    },
    showInformationMessage: async (msg: string) => {
      infoMessages.push(msg);
      return undefined;
    },
    showWarningMessage: async (msg: string) => {
      warningMessages.push(msg);
      return undefined;
    },
    showErrorMessage: async (msg: string) => {
      errorMessages.push(msg);
      return undefined;
    },
  };

  return {
    repo,
    deps,
    pullCalls,
    infoMessages,
    warningMessages,
    errorMessages,
    singleCalls,
    multiCalls,
    openResolveConflictsDialogCalls,
  };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('T1-02 PullDialog — pure helpers', () => {
  describe('resolveFlagMutex', () => {
    const zero: Record<PullFlagKey, boolean> = {
      rebase: false,
      ffOnly: false,
      noFf: false,
      squash: false,
      noCommit: false,
      noVerify: false,
    };

    it('leaves flags untouched when no strategy flag is set', () => {
      const out = resolveFlagMutex({ ...zero, squash: true, noCommit: true });
      assert.deepStrictEqual(out, { ...zero, squash: true, noCommit: true });
    });

    it('clears ffOnly and noFf when rebase is the freshly-toggled flag', () => {
      const out = resolveFlagMutex({ ...zero, rebase: true, ffOnly: true, noFf: true }, 'rebase');
      assert.strictEqual(out.rebase, true);
      assert.strictEqual(out.ffOnly, false);
      assert.strictEqual(out.noFf, false);
    });

    it('clears rebase and noFf when ffOnly is the freshly-toggled flag', () => {
      const out = resolveFlagMutex({ ...zero, rebase: true, ffOnly: true, noFf: true }, 'ffOnly');
      assert.strictEqual(out.rebase, false);
      assert.strictEqual(out.ffOnly, true);
      assert.strictEqual(out.noFf, false);
    });

    it('clears rebase and ffOnly when noFf is the freshly-toggled flag', () => {
      const out = resolveFlagMutex({ ...zero, rebase: true, ffOnly: true, noFf: true }, 'noFf');
      assert.strictEqual(out.rebase, false);
      assert.strictEqual(out.ffOnly, false);
      assert.strictEqual(out.noFf, true);
    });

    it('when no lastToggled provided, keeps the first enabled strategy flag', () => {
      const out = resolveFlagMutex({ ...zero, rebase: true, ffOnly: true, noFf: true });
      assert.strictEqual(out.rebase, true);
      assert.strictEqual(out.ffOnly, false);
      assert.strictEqual(out.noFf, false);
    });

    it('preserves modifier flags while resolving strategy mutex', () => {
      const out = resolveFlagMutex(
        { ...zero, rebase: true, ffOnly: true, squash: true, noVerify: true },
        'rebase'
      );
      assert.strictEqual(out.rebase, true);
      assert.strictEqual(out.ffOnly, false);
      assert.strictEqual(out.squash, true);
      assert.strictEqual(out.noVerify, true);
    });
  });

  describe('defaultPullFlags', () => {
    it('seeds rebase from config when no preset is supplied', () => {
      assert.strictEqual(defaultPullFlags(true).rebase, true);
      assert.strictEqual(defaultPullFlags(false).rebase, false);
    });

    it('preset "rebase" pre-fills --rebase regardless of config', () => {
      assert.strictEqual(defaultPullFlags(false, 'rebase').rebase, true);
    });

    it('preset "merge" clears --rebase even when config default is true', () => {
      assert.strictEqual(defaultPullFlags(true, 'merge').rebase, false);
    });

    it('all non-rebase flags default to false', () => {
      const flags = defaultPullFlags(true, 'rebase');
      assert.strictEqual(flags.ffOnly, false);
      assert.strictEqual(flags.noFf, false);
      assert.strictEqual(flags.squash, false);
      assert.strictEqual(flags.noCommit, false);
      assert.strictEqual(flags.noVerify, false);
    });
  });

  describe('buildSourceItems', () => {
    it('groups remote branches by remote with a separator per remote', () => {
      const items = buildSourceItems(createRemoteBranches());
      const separators = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator);
      assert.strictEqual(
        separators.length,
        2,
        'expected one separator per remote (origin + upstream)'
      );
    });

    it('puts the tracked upstream remote first', () => {
      const branches: IBranch[] = [
        { name: 'upstream/main', type: 'remote', commit: 'a'.repeat(40), isHead: false },
        { name: 'origin/main', type: 'remote', commit: 'b'.repeat(40), isHead: false },
      ];
      const items = buildSourceItems(branches, { remote: 'origin', name: 'main' });
      const firstSeparator = items.find((i) => i.kind === vscode.QuickPickItemKind.Separator);
      assert.ok(firstSeparator);
      assert.strictEqual(firstSeparator.label, 'Remote: origin');
    });

    it('marks the tracked upstream entry with an "upstream" description', () => {
      const items = buildSourceItems(createRemoteBranches(), {
        remote: 'origin',
        name: 'main',
      });
      const upstreamItem = items.find(
        (i) => i.label === '$(cloud) main' && i.description === 'upstream'
      );
      assert.ok(upstreamItem, 'expected upstream row to have description "upstream"');
    });

    it('ignores non-remote branches', () => {
      const branches: IBranch[] = [
        { name: 'origin/main', type: 'remote', commit: 'a'.repeat(40), isHead: false },
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'v1.0.0', type: 'tag', commit: 'c'.repeat(40), isHead: false },
      ];
      const items = buildSourceItems(branches);
      // one separator + one branch
      assert.strictEqual(items.length, 2);
    });
  });

  describe('buildFlagItems', () => {
    it('emits one toggle per flag plus the terminal ▶ Pull item', () => {
      const items = buildFlagItems(defaultPullFlags(false));
      assert.strictEqual(items.length, ALL_PULL_FLAGS.length + 1);
      assert.strictEqual(items[items.length - 1].label, '$(play) Pull');
      assert.strictEqual(items[items.length - 1].confirm, true);
    });

    it('reflects current flag state via `picked`', () => {
      const items = buildFlagItems(defaultPullFlags(true, 'rebase'));
      const rebaseItem = items.find((i) => i.flagKey === 'rebase');
      const ffOnlyItem = items.find((i) => i.flagKey === 'ffOnly');
      assert.strictEqual(rebaseItem?.picked, true);
      assert.strictEqual(ffOnlyItem?.picked, false);
    });
  });

  describe('applyFlagSelection', () => {
    it('resolves mutex when user enables rebase in addition to ff-only', () => {
      const prev = defaultPullFlags(false);
      prev.ffOnly = true;
      const selection: IPullFlagItem[] = [
        { label: '--rebase', flagKey: 'rebase' },
        { label: '--ff-only', flagKey: 'ffOnly' },
        { label: '$(play) Pull', confirm: true },
      ];
      const out = applyFlagSelection(prev, selection);
      assert.strictEqual(out.rebase, true, 'rebase should win (newly toggled)');
      assert.strictEqual(out.ffOnly, false, 'ffOnly should be cleared by mutex');
    });

    it('empty selection clears all flags', () => {
      const prev = defaultPullFlags(true, 'rebase');
      const out = applyFlagSelection(prev, []);
      assert.deepStrictEqual(
        out,
        defaultPullFlags(false),
        'empty selection means every flag is off'
      );
    });
  });

  describe('isConflictError', () => {
    it('matches messages containing CONFLICT marker', () => {
      assert.strictEqual(isConflictError('Automatic merge failed; CONFLICT (content)'), true);
      assert.strictEqual(isConflictError('conflict in foo.ts'), true);
    });

    it('does not match other git failures', () => {
      assert.strictEqual(isConflictError('fatal: refusing to merge unrelated histories'), false);
    });
  });
});

// ─── End-to-end flow ─────────────────────────────────────────────────────────

describe('T1-02 PullDialog — runPullDialog', () => {
  it('happy path: picks source, confirms flags, calls pull, shows info toast', async () => {
    const h = createHarness({ sourcePick: '$(cloud) main' });
    const outcome = await runPullDialog(h.deps);

    assert.strictEqual(outcome.status, 'pulled');
    assert.strictEqual(h.pullCalls.length, 1);
    assert.strictEqual(h.pullCalls[0].options?.remote, 'origin');
    assert.strictEqual(h.pullCalls[0].options?.branch, 'main');
    assert.strictEqual(h.pullCalls[0].options?.rebase, undefined);
    assert.strictEqual(h.pullCalls[0].options?.ffOnly, undefined);
    assert.strictEqual(h.infoMessages.length, 1);
    assert.ok(h.infoMessages[0].includes('origin/main'));
    assert.deepStrictEqual(h.warningMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
  });

  it('preset "rebase" pre-selects --rebase in the flag picker', async () => {
    const h = createHarness({
      preset: 'rebase',
      sourcePick: '$(cloud) main',
      flagPicks: ['--rebase', '$(play) Pull'],
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'pulled');
    assert.strictEqual(h.pullCalls[0].options?.rebase, true);

    // The flag item for --rebase should have come in with picked: true
    const flagItems = h.multiCalls[0].items as IPullFlagItem[];
    const rebaseItem = flagItems.find((i) => i.flagKey === 'rebase');
    assert.strictEqual(rebaseItem?.picked, true);
  });

  it('preset "merge" overrides a rebase config default', async () => {
    const h = createHarness({
      preset: 'merge',
      defaultRebase: true,
      sourcePick: '$(cloud) main',
      flagPicks: ['$(play) Pull'],
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'pulled');
    assert.strictEqual(h.pullCalls[0].options?.rebase, undefined);

    const flagItems = h.multiCalls[0].items as IPullFlagItem[];
    const rebaseItem = flagItems.find((i) => i.flagKey === 'rebase');
    assert.strictEqual(rebaseItem?.picked, false);
  });

  it('mutex: picking --rebase alongside --ff-only clears --ff-only', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      flagPicks: ['--rebase', '--ff-only', '$(play) Pull'],
    });
    await runPullDialog(h.deps);
    assert.strictEqual(h.pullCalls[0].options?.rebase, true);
    assert.strictEqual(h.pullCalls[0].options?.ffOnly, undefined);
  });

  it('maps each flag onto the IPullOptions record', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      flagPicks: ['--no-ff', '--squash', '--no-commit', '--no-verify', '$(play) Pull'],
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'pulled');
    const opts = h.pullCalls[0].options;
    assert.strictEqual(opts?.noFf, true);
    assert.strictEqual(opts?.squash, true);
    assert.strictEqual(opts?.noCommit, true);
    assert.strictEqual(opts?.noVerify, true);
    assert.strictEqual(opts?.rebase, undefined);
    assert.strictEqual(opts?.ffOnly, undefined);
  });

  it('cancel at source step → no pull, no toasts', async () => {
    const h = createHarness({ sourcePickerCancelled: true });
    const outcome = await runPullDialog(h.deps);
    assert.deepStrictEqual(outcome, { status: 'cancelled', step: 'source' });
    assert.deepStrictEqual(h.pullCalls, []);
    assert.deepStrictEqual(h.infoMessages, []);
    assert.deepStrictEqual(h.warningMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
  });

  it('cancel at flags step → no pull, no toasts', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      flagPickerCancelled: true,
    });
    const outcome = await runPullDialog(h.deps);
    assert.deepStrictEqual(outcome, { status: 'cancelled', step: 'options' });
    assert.deepStrictEqual(h.pullCalls, []);
  });

  it('flags picker submitted without ▶ Pull → treated as cancel', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      flagPicks: ['--rebase'], // missing the terminal confirm item
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'cancelled');
    assert.deepStrictEqual(h.pullCalls, []);
  });

  it('prefilledSource skips the step-1 picker', async () => {
    const h = createHarness({
      prefilledSource: { remote: 'upstream', branch: 'main' },
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'pulled');
    assert.strictEqual(h.singleCalls.length, 0, 'step-1 picker should be skipped');
    assert.strictEqual(h.pullCalls[0].options?.remote, 'upstream');
    assert.strictEqual(h.pullCalls[0].options?.branch, 'main');
  });

  it('empty remote-branch list shows an error and returns without pulling', async () => {
    const h = createHarness({ branches: [] });
    const outcome = await runPullDialog(h.deps);
    assert.deepStrictEqual(outcome, { status: 'cancelled', step: 'source' });
    assert.deepStrictEqual(h.pullCalls, []);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(h.errorMessages[0].includes('No remote branches'));
  });

  it('pull CONFLICT hands off to openResolveConflictsDialog with merge operation', async () => {
    const conflictedFiles = [{ path: 'src/foo.ts', resolved: false }];
    const h = createHarness({
      sourcePick: '$(cloud) main',
      pullError: new Error('Automatic merge failed; CONFLICT (content) in src/foo.ts'),
      conflictedFiles,
    });
    const outcome = await runPullDialog(h.deps);

    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(h.pullCalls.length, 1);
    assert.strictEqual(h.openResolveConflictsDialogCalls.length, 1);

    const handoff = h.openResolveConflictsDialogCalls[0];
    assert.strictEqual(handoff.opContext.operation, 'merge');
    assert.strictEqual(handoff.opContext.target, 'origin/main');
    assert.strictEqual(handoff.opContext.canAbort, true);
    assert.strictEqual(handoff.opContext.canContinue, true);
    assert.deepStrictEqual(handoff.conflicts, conflictedFiles);

    // No fallback toast when the dialog handles it.
    assert.deepStrictEqual(h.infoMessages, []);
    assert.deepStrictEqual(h.warningMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
  });

  it('pull CONFLICT with --rebase maps operation to "rebase"', async () => {
    const h = createHarness({
      preset: 'rebase',
      sourcePick: '$(cloud) main',
      flagPicks: ['--rebase', '$(play) Pull'],
      pullError: new Error('CONFLICT (content) during rebase'),
      conflictedFiles: [{ path: 'a.ts', resolved: false }],
    });
    const outcome = await runPullDialog(h.deps);

    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(h.openResolveConflictsDialogCalls.length, 1);
    assert.strictEqual(h.openResolveConflictsDialogCalls[0].opContext.operation, 'rebase');
  });

  it('openResolveConflictsDialog failure falls back to a warning toast', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      pullError: new Error('CONFLICT (content) in src/foo.ts'),
      conflictedFiles: [{ path: 'src/foo.ts', resolved: false }],
      openResolveConflictsDialogError: new Error('dialog boom'),
    });
    const outcome = await runPullDialog(h.deps);

    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(h.openResolveConflictsDialogCalls.length, 1);
    assert.strictEqual(h.warningMessages.length, 1);
    assert.ok(h.warningMessages[0].includes('dialog boom'));
    // No success info toast and no error toast beyond the fallback warning.
    assert.deepStrictEqual(h.infoMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
  });

  it('pull non-conflict error → error toast, no warning', async () => {
    const h = createHarness({
      sourcePick: '$(cloud) main',
      pullError: new Error('fatal: unable to access remote'),
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'error');
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(h.errorMessages[0].includes('unable to access remote'));
    assert.deepStrictEqual(h.warningMessages, []);
    assert.deepStrictEqual(h.openResolveConflictsDialogCalls, []);
  });

  // TL-72 (Wave 9) — non-conflict pull failure must run through
  // sanitizeGitError before the toast is rendered. Pre-fix the catch
  // block at PullDialog.ts:407 concatenated raw `error.message` into
  // the showErrorMessage template, leaking credentialed remote URLs
  // and POSIX home paths into the user's notification history.
  it('TL-72 — non-conflict pull error toast sanitizes credentialed URL + home path', async () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
    const h = createHarness({
      sourcePick: '$(cloud) main',
      pullError: new Error(RAW),
    });
    const outcome = await runPullDialog(h.deps);
    assert.strictEqual(outcome.status, 'error');
    assert.strictEqual(h.errorMessages.length, 1);
    assert.strictEqual(h.errorMessages[0], `Failed to pull: ${EXPECTED}`);
    assert.ok(!h.errorMessages[0].includes('alice:secret'), 'toast must not leak credentials');
    assert.ok(!h.errorMessages[0].includes('/Users/alice'), 'toast must not leak home path');
  });
});

// ─── GitService.pull arg order (via a mock gitCli-like stub) ────────────────

describe('T1-02 GitService.pull — flag arg ordering', () => {
  it('builds args in the order [strategy] [modifiers] <remote> <branch>', async () => {
    // Use a lightweight GitService-like harness: we directly test the shape
    // of the command args by invoking pull through a minimal stub. We reuse
    // the actual GitService implementation but swap its private _gitCli for
    // a tracking stub (same pattern as the existing GitService.test.ts).
    const { GitService } = await import('../../../services/GitService');
    const executed: string[][] = [];
    const gitCli = {
      exec: async (args: string[]) => {
        executed.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      invalidateCache: () => {},
    };
    const gitService = new GitService();
    (gitService as unknown as { _gitCli: typeof gitCli })._gitCli = gitCli;
    const repo = createRepo();

    await gitService.pull(repo, {
      rebase: true,
      ffOnly: true, // should be skipped due to mutex in the caller — but if we
      //            do pass both, the production code picks rebase.
      squash: true,
      noCommit: true,
      noVerify: true,
      remote: 'origin',
      branch: 'main',
    });

    assert.deepStrictEqual(executed[0], [
      'pull',
      '--rebase',
      '--squash',
      '--no-commit',
      '--no-verify',
      'origin',
      'main',
    ]);

    await gitService.pull(repo, { ffOnly: true, remote: 'origin', branch: 'main' });
    assert.deepStrictEqual(executed[1], ['pull', '--ff-only', 'origin', 'main']);

    await gitService.pull(repo, { noFf: true, remote: 'origin', branch: 'main' });
    assert.deepStrictEqual(executed[2], ['pull', '--no-ff', 'origin', 'main']);

    await gitService.pull(repo, { remote: 'origin', branch: 'main' });
    assert.deepStrictEqual(executed[3], ['pull', 'origin', 'main']);
  });
});
