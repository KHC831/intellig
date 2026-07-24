/**
 * Shared spine of every history-rewrite flow (drop, squash/fixup, reword,
 * interactive rebase, autosquash): the rewrite context the dispatcher wires,
 * the gate chain + interactive-rebase runner, and the rewrite-base resolver.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
  REBASE_ROOT,
} from '../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider } from '../ui-shell/GitToolWindowProvider';
import { GitCli } from '../git-core/gitCli';
import { type IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import { detectLocalChanges } from '../git-core/ops/preservedChanges';
import { AUTOSTASH_PARKED_WARNING } from '../git-core/rebaseAutostash';
import { findBlockingOperation, resolveGitDir } from '../git-core/gitDirMarkers';
import { reloadAndRefresh, type ICommitSelectionContext } from './commitContextMenuShared';

/** Deps the history-rewrite unit reaches back into the dispatcher for. */
export interface ICommitHistoryRewriteContext extends ICommitSelectionContext {
  readonly gitService: IGitService;
  readonly gitCli: GitCli;
  readonly gitToolWindowProvider: GitToolWindowProvider;
  readonly rebaseService: IRebaseService;
  readonly context: vscode.ExtensionContext | undefined;
  readonly dispatchNodes: readonly IMenuStateNode[];
  // live-read-exempt: wired once at activation (extension.ts setRebaseEditorOpener), never reassigned.
  readonly openRebaseEditor?: (repo: IRepository, onto: string) => Promise<{ executed: boolean }>;
  isOldestInCurrentBranch(repo: IRepository, oldestHash: string): Promise<boolean>;
  isNotOnProtectedBranch(cwd: string, hash: string, opLabel: string): Promise<boolean>;
  isRangeMergeFree(
    repo: IRepository,
    onto: string,
    opLabel: string,
    refusalHint?: () => Promise<string>
  ): Promise<boolean>;
  anyIsMergeCommit(repo: IRepository, hashes: string[]): Promise<boolean>;
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      rebaseInProgress?: boolean;
    }
  ): Promise<void>;
}

/**
 * Shared skeleton for the history-rewrite flows (single/multi drop,
 * squash/fixup, reword): pre-flight → plan → execute → one outcome switch.
 * Bodies own op-specific guards, confirm modals, message dialogs, and
 * their catch-clause copy; the runner owns the invariants:
 *
 *  - Unmerged files refuse the operation before any git mutation.
 *  - No manual stash bracket — `executeRebase` passes `--autostash`, so
 *    git owns saving and restoring local changes via the
 *    `.git/rebase-merge/autostash` marker on every terminal path
 *    (continue, abort, terminal git included).
 *  - A stale plan clears the planning session; no rebase has started, so
 *    there is nothing to abort.
 *  - A conflicted rebase is left PAUSED and handed to the resolve dialog
 *    with `rebaseInProgress` passed VERBATIM (Continue/Abort/Skip render
 *    only when a rebase is actually in progress). `rebase --abort` runs
 *    only from explicit user actions: dialog Abort, palette, the
 *    paused-rebase warning toast, or the terminal — matching git4idea's
 *    GitRebaseProcess, whose conflict loop never aborts.
 *  - Every executed arm reloads the repo and refreshes the log (HEAD may
 *    sit at the replayed prefix even when paused).
 */
export async function runHistoryRewrite(
  ctx: ICommitHistoryRewriteContext,
  repo: IRepository,
  opts: {
    /** Rebase base, e.g. `${hash}~1`. */
    onto: string;
    /**
     * Oldest commit being rewritten (the child of `onto`). The
     * protected-branch gate probes its remote containment — one commit
     * suffices, see `ctx.isNotOnProtectedBranch`.
     */
    oldest: string;
    /**
     * Turn the planning session into a plan. Returning `'stale'` refuses
     * the operation (the body surfaces its own stale/not-found toast).
     */
    buildPlan: (session: IRebaseSession) => IRebaseAction[] | 'stale';
    /** Toast subject: 'Drop' | 'Squash' | 'Fixup' | 'Edit message'. */
    opLabel: string;
    /** Resolve-dialog target: 'drop' | 'squash' | 'reword'. */
    target: string;
    successToast: string;
    /**
     * Reword only: consume the paused reword step(s) and return the final
     * result for the outcome switch. Drop/squash omit it.
     */
    drivePaused?: (first: IRebaseResult) => Promise<IRebaseResult>;
  }
): Promise<void> {
  // rebase-containment-exempt: every body runs isOldestInCurrentBranch on
  // its own oldest hash BEFORE calling the runner — the runner only receives
  // the prepared `onto` base and cannot know which commit is oldest.
  const cwd = repo.rootUri.fsPath;

  // In-progress pre-flight — refuse while a rebase or a cherry-pick/revert
  // sequencer is live (see isNoOperationInProgress). Runs FIRST: a rebase
  // paused at an `edit` step has a clean tree, so the unmerged probe below
  // would let it through into a "rebase-merge already exists" failure that
  // handleRebaseResult misreads as OUR paused rebase.
  if (!(await isNoOperationInProgress(repo, opts.opLabel))) {
    return;
  }

  if ((await detectLocalChanges(ctx.gitCli, cwd)) === 'blocked-unmerged') {
    void vscode.window.showErrorMessage(
      `Cannot ${opts.opLabel.toLowerCase()} while you have unmerged files. Please resolve conflicts first.`
    );
    return;
  }

  // Merge-flattening gate — refuse BEFORE any git mutation when the range
  // carries merges (see ctx.isRangeMergeFree). The menu enable-state mirrors
  // this refusal; the runner owns it for palette / scripted entry points.
  if (!(await ctx.isRangeMergeFree(repo, opts.onto, opts.opLabel))) {
    return;
  }

  // Protected-branch gate — a rewrite touching history already on a
  // protected remote branch is refused outright (see
  // ctx.isNotOnProtectedBranch).
  if (!(await ctx.isNotOnProtectedBranch(cwd, opts.oldest, opts.opLabel))) {
    return;
  }

  const session = await ctx.rebaseService.startInteractiveRebase(repo, opts.onto);
  const plan = opts.buildPlan(session);
  if (plan === 'stale') {
    ctx.rebaseService.clearSession(repo);
    return;
  }
  ctx.rebaseService.updateRebasePlan(repo, plan);

  const first = await ctx.rebaseService.executeRebase(repo);
  const result = opts.drivePaused ? await opts.drivePaused(first) : first;

  if (result.success && result.status === 'completed') {
    void vscode.window.showInformationMessage(opts.successToast);
    if (result.autostashParked) {
      void vscode.window.showWarningMessage(AUTOSTASH_PARKED_WARNING);
    }
  } else if (result.status === 'conflict' && result.conflictedFiles.length > 0) {
    if (result.rebaseInProgress !== false) {
      void vscode.window.showWarningMessage(
        `${opts.opLabel} hit conflicts in ${result.conflictedFiles.length} file(s) — resolve them to continue, or abort to roll back.`
      );
    }
    // A live conflict gets Continue/Abort/Skip; a terminal conflict (the
    // defensive autostash-pop arm) renders resolve-only.
    await ctx.openResolveConflictsDialog(repo, result.conflictedFiles, {
      operation: 'rebase',
      target: opts.target,
      rebaseInProgress: result.rebaseInProgress,
    });
  } else if (result.status === 'cleared-stale') {
    // A continue/reword drive found no live rebase and self-cleared the
    // phantom session — report the no-op honestly.
    void vscode.window.showInformationMessage('No rebase in progress — cleared a stale session.');
  } else if (result.status === 'paused') {
    void vscode.window.showWarningMessage(
      `${opts.opLabel} partially complete — resume via 'git rebase --continue' or abort via 'git rebase --abort'.`
    );
  } else {
    void vscode.window.showErrorMessage(
      `${opts.opLabel} failed: the rebase did not complete successfully.`
    );
  }
  // HEAD may have moved on every executed arm (completed rewrite, replayed
  // prefix at a pause, autostash reapply); reload before refresh.
  await reloadAndRefresh(ctx, repo);
}

/**
 * Resolve the rebase base for a rewrite whose oldest commit is `oldestHash`:
 * `<oldest>~1` normally; for the INITIAL commit (no parent) IntelliJ warns
 * and proceeds with a full-history rebase
 * (GitCommitEditingActionBase.kt:202-210,266-275 → `--root`), so a
 * confirmed warning returns {@link REBASE_ROOT} and a dismissal returns
 * `undefined` (caller cancels cleanly).
 */
export async function resolveRewriteBase(
  oldestHash: string,
  isInitialCommit: boolean,
  opLabel: string
): Promise<string | undefined> {
  if (!isInitialCommit) {
    return `${oldestHash}~1`;
  }
  const choice = await vscode.window.showWarningMessage(
    `${opLabel} includes the initial commit — the entire history will be rewritten ` +
      `(git rebase --root). Continue?`,
    { modal: true },
    'Continue'
  );
  return choice === 'Continue' ? REBASE_ROOT : undefined;
}

/**
 * In-progress pre-flight shared by the history-rewrite entry points: a new
 * interactive rebase cannot start while a rebase or a cherry-pick/revert
 * sequencer is mid-flight. Without this gate, `git rebase -i` fails
 * ("rebase-merge already exists") and `handleRebaseResult` sees the
 * PRE-EXISTING pause, reporting the new operation "partially complete" —
 * untrue (nothing started) with dangerous advice ('continue' drives the
 * OTHER operation). IntelliJ prohibits commit editing during an unfinished
 * operation (GitRewordAction.kt:14-16, GitInteractiveRebaseAction /
 * GitDropSelectedChangesAction prohibit policies).
 *
 * Reads the FRESH on-disk markers (`repo.state` can be stale between
 * reloads). Returns `true` to proceed; toasts the refusal naming the
 * blocking operation otherwise.
 */
export async function isNoOperationInProgress(
  repo: IRepository,
  opLabel: string
): Promise<boolean> {
  const gitDir = await resolveGitDir(repo.rootUri.fsPath);
  const blocking = await findBlockingOperation(gitDir);
  if (blocking === undefined) {
    return true;
  }
  void vscode.window.showErrorMessage(
    `Cannot ${opLabel.toLowerCase()}: a ${blocking} is in progress — finish or abort it first.`
  );
  return false;
}
