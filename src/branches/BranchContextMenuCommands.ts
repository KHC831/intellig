/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import {
  IBranch,
  IGitService,
  IRefDiffFile,
  IRemote,
  IRepository,
  IUpstream,
} from '../git-core/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { getIncomingOutgoingFetcher } from './BranchPopup';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { PullDialog } from '../sync/PullDialog';
import type { PushDialog, IPushPreselect } from '../sync/PushDialog';
import type { MergeDialog } from '../conflicts/MergeDialog';
import type { RebaseDialog } from '../rebase/RebaseDialog';
import type { NewBranchDialog } from './NewBranchDialog';
import {
  sanitizeGitError,
  formatActionFailureToast,
  worktreeConflictMessage,
} from '../git-core/gitError';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import { getLogger, registerLoggedCommand } from '../utils/logger';
import {
  registerTreeItemCommand,
  ITreeItemCommandDeps,
  ITreeItemBatchEntry,
  ITreeItemRunArgs,
  TreeItemTarget,
} from '../commands/registration/commandSpine';
import type { IWorktreeCapableService, IWorktreeEntry } from '../git-core/ops/WorktreeOps';
import { buildUpdatePullOptions, resolveUpdateRebase } from '../sync/updateProject';
import { readConfig } from '../config/configKeys';
import { isProtectedTarget } from '../sync/PushDialog';
import { isNotFullyMergedError, proposeDeleteMergedBranch } from './deleteOnMerge';
import type { BranchComparisonView } from './BranchComparisonView';

/** Thunk that lazily returns the shared {@link PullDialog} singleton. */
export type PullDialogAccessor = () => PullDialog | undefined;

/**
 * Thunk that opens a fresh Push Dialog pre-selected on the given repo + branch.
 * Push dialogs are not singletons (row table reflects current state), so this
 * is a one-shot opener rather than a getter.
 */
export type PushDialogOpener = (preselect: IPushPreselect) => PushDialog | undefined;

/**
 * Open a fresh Merge Dialog for `repo` merging `sourceBranch` into
 * the current branch. `proposeDeleteOnMerge` enables the deleteOnMerge
 * PROPOSE affordance on success (non-protected local branches only —
 * the caller computes eligibility).
 */
export type MergeDialogOpener = (preselect: {
  repo: IRepository;
  sourceBranch: string;
  proposeDeleteOnMerge?: boolean;
}) => MergeDialog | undefined;

/**
 * Open the unified Rebase Dialog for `repo`, preselecting `onto` as the
 * rebase target. Async because the opener fetches the branch list for the
 * dropdown at open time.
 */
export type RebaseDialogOpener = (preselect: {
  repo: IRepository;
  onto?: string;
  interactiveDefault?: boolean;
}) => Promise<RebaseDialog | undefined>;

/**
 * Open a fresh New Branch Dialog with the given start point.
 */
export type NewBranchDialogOpener = (preselect: {
  repo: IRepository;
  startPoint?: string;
  defaultName?: string;
}) => NewBranchDialog | undefined;

/**
 * One selected local branch fed to {@link planAlignLocal}, carrying just the
 * facts the FF-vs-skip decision needs: whether it is checked out, its tracking
 * upstream, and its incoming/outgoing counts relative to that upstream.
 */
export interface IAlignLocalBranchInput {
  /** Local branch short name (e.g. `main`, `feature/x`). */
  name: string;
  /** True when this is the repository's checked-out branch. */
  isCurrent: boolean;
  /** Tracking upstream, or undefined when the branch tracks nothing. */
  upstream?: IUpstream;
  /** Commits the upstream has that the local branch lacks (git "behind"). */
  incoming: number;
  /** Local commits the upstream lacks (git "ahead"). */
  outgoing: number;
}

/** A fast-forward fetch the align-local action will run for one branch. */
export interface IAlignLocalFetch {
  /** Local branch being advanced. */
  branch: string;
  /** Remote to fetch from (the upstream's remote). */
  remote: string;
  /** `<remoteRef>:<localRef>` refspec — fetch FFs the local ref or refuses. */
  refspec: string;
}

/** Outcome of classifying a selection of local branches for align-local. */
export interface IAlignLocalPlan {
  /** Branches that are behind-only and will be fast-forwarded. */
  fetches: IAlignLocalFetch[];
  /** Branches we won't touch, with a user-facing reason. */
  skipped: { branch: string; reason: string }[];
  /** Branches already in sync with their upstream — nothing to do. */
  upToDate: string[];
}

/**
 * Classify selected local branches into fast-forward / skip / up-to-date
 * buckets for the align-local "Update Selected" action.
 *
 * Mirrors git4idea's GitBranchActionsUtil.updateBranches: every NON-current
 * tracking branch is fast-forwarded via a `<remoteRef>:<localRef>` fetch
 * refspec (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`), and
 * the action only ever fast-forwards — a diverged branch is left alone. We
 * decide FF-ability from the incoming/outgoing counts (behind-only ⇒ FF-able;
 * any outgoing ⇒ diverged) so we never even attempt a non-FF fetch, rather
 * than relying on git to refuse it.
 *
 * Skip reasons:
 * - no upstream configured.
 * - checked-out current branch — FF into a checked-out ref is refused. This
 *   is planner-level defense only: the Update / Update Selected handlers
 *   route the current branch to a full integration
 *   (`_updateCurrentBranch`, GitUpdateExecutionProcess parity) before ever
 *   consulting this planner.
 * - diverged (has outgoing commits) — not a fast-forward.
 *
 * The refspec joins user-controlled ref names; callers MUST splice it through
 * `buildGitArgs` (the fetch op does) so it can never be parsed as a git flag.
 */
export function planAlignLocal(inputs: IAlignLocalBranchInput[]): IAlignLocalPlan {
  const plan: IAlignLocalPlan = { fetches: [], skipped: [], upToDate: [] };

  for (const input of inputs) {
    if (!input.upstream) {
      plan.skipped.push({ branch: input.name, reason: 'no upstream configured' });
      continue;
    }
    if (input.isCurrent) {
      plan.skipped.push({
        branch: input.name,
        reason: 'checked out — use Update/Pull to advance the current branch',
      });
      continue;
    }
    if (input.outgoing > 0) {
      plan.skipped.push({
        branch: input.name,
        reason: 'diverged from upstream — not fast-forwardable',
      });
      continue;
    }
    if (input.incoming === 0) {
      plan.upToDate.push(input.name);
      continue;
    }
    plan.fetches.push({
      branch: input.name,
      remote: input.upstream.remote,
      refspec: `${input.upstream.name}:${input.name}`,
    });
  }

  return plan;
}

/**
 * Detect git's "untracked working tree files would be overwritten" refusal
 * and extract the blocked files. Returns `null` when the message is not that
 * error (including the TRACKED "Your local changes …" form, which keeps the
 * smart-checkout offer).
 *
 * Mirrors git4idea's GitUntrackedFilesOverwrittenByOperationDetector: the
 * modern form is a header line followed by tab-indented file lines up to the
 * "Please move or remove them" hint; the legacy form names a single file
 * inline. The reference treats this arm as FATAL (file list, no smart
 * checkout — GitCheckoutOperation.java:187-190): a stash without
 * `--include-untracked` cannot move untracked files, so a stash-and-retry
 * would fail on exactly the same files.
 */
export function parseUntrackedOverwriteFiles(message: string): string[] | null {
  const lines = message.split('\n');
  const headerIdx = lines.findIndex((l) =>
    /untracked working tree files would be overwritten by/i.test(l)
  );
  if (headerIdx >= 0) {
    const files: string[] = [];
    for (const line of lines.slice(headerIdx + 1)) {
      if (/^\s*please move or remove them/i.test(line)) {
        break;
      }
      const file = line.trim();
      if (file.length > 0) {
        files.push(file);
      }
    }
    return files;
  }
  const legacy = message.match(/untracked working tree file '(.*)' would be overwritten by/i);
  if (legacy) {
    return [legacy[1]];
  }
  return null;
}

/**
 * Branch Context Menu Commands class.
 * Registers and handles all branch-related context menu commands.
 */
export class BranchContextMenuCommands {
  private _gitService: IGitService;
  private _branchTreeProvider: BranchTreeProvider;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  private _pullDialogAccessor?: PullDialogAccessor;
  private _pushDialogOpener?: PushDialogOpener;
  private _mergeDialogOpener?: MergeDialogOpener;
  private _rebaseDialogOpener?: RebaseDialogOpener;
  private _newBranchDialogOpener?: NewBranchDialogOpener;
  private _branchComparisonView?: BranchComparisonView;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    gitService: IGitService,
    branchTreeProvider: BranchTreeProvider,
    conflictResolutionService?: IConflictResolutionService,
    pullDialogAccessor?: PullDialogAccessor,
    pushDialogOpener?: PushDialogOpener,
    mergeDialogOpener?: MergeDialogOpener,
    newBranchDialogOpener?: NewBranchDialogOpener,
    rebaseDialogOpener?: RebaseDialogOpener
  ) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
    this._conflictResolutionService = conflictResolutionService;
    this._pullDialogAccessor = pullDialogAccessor;
    this._pushDialogOpener = pushDialogOpener;
    this._mergeDialogOpener = mergeDialogOpener;
    this._newBranchDialogOpener = newBranchDialogOpener;
    this._rebaseDialogOpener = rebaseDialogOpener;
  }

  /**
   * Late-bind the conflict resolution service. Used when the service isn't
   * available at construction time (e.g. existing wiring that hasn't been
   * updated yet). Safe no-op for duplicate calls.
   */
  setConflictResolutionService(service: IConflictResolutionService): void {
    this._conflictResolutionService = service;
  }

  /**
   * Late-bind the Branch Comparison View — constructed AFTER this commands
   * class in the activate() sequence, mirroring
   * {@link CommitContextMenuCommands.setBranchComparisonView}. Compare With
   * Current routes through it; without it the summary toast remains as the
   * fallback.
   */
  setBranchComparisonView(view: BranchComparisonView): void {
    this._branchComparisonView = view;
  }

  /**
   * Open the Resolve Conflicts dialog for conflicts produced by the given op.
   * No-op if the conflict resolution service hasn't been wired in (legacy
   * callers that haven't migrated).
   *
   * The operation union includes `'pull'` (pull-using-rebase maps
   * to `'rebase'`, pull-using-merge maps to `'merge'`) so Pull Dialog and
   * branch-menu pull handlers share this helper with the existing
   * merge/rebase/cherryPick/revert callers.
   */
  private async _openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      /**
       * Whether a rebase is still in progress. When `false` (an
       * `--autostash` pop conflict after the rebase already finished) the
       * continue/abort affordances are suppressed — `git rebase
       * --continue`/`--abort` would dead-end on "no rebase in progress" — and
       * the dialog offers resolve-and-stage only. Defaults to `true` for the
       * mid-rebase / merge / cherry-pick / revert callers.
       */
      rebaseInProgress?: boolean;
    }
  ): Promise<void> {
    if (!this._conflictResolutionService || conflicts.length === 0) {
      return;
    }
    const continuable = opContext.rebaseInProgress !== false;
    await this._conflictResolutionService.openResolveConflictsDialog(
      repo,
      conflicts.map((p) => ({ path: p, resolved: false })),
      {
        operation: opContext.operation,
        target: opContext.target,
        canAbort: continuable,
        canContinue: continuable,
      }
    );
  }

  /**
   * Surface a rebase conflict result, routing by continuability.
   *
   * A continuable mid-rebase conflict opens the Resolve Conflicts dialog with
   * the continue/abort affordances (falling back to a "resolve conflicts"
   * warning when the dialog isn't wired). A non-continuable conflict — an
   * `--autostash` pop conflict surfaced after the rebase already finished —
   * opens the same dialog WITHOUT continue/abort (`git rebase
   * --continue`/`--abort` would dead-end on "no rebase in progress") and the
   * fallback warning instead tells the user to resolve and `git add` the
   * files, since the rebase is already complete.
   */
  private async _surfaceRebaseConflicts(
    repo: IRepository,
    conflicts: string[],
    target: string,
    rebaseInProgress: boolean | undefined
  ): Promise<void> {
    if (this._conflictResolutionService) {
      await this._openResolveConflictsDialog(repo, conflicts, {
        operation: 'rebase',
        target,
        rebaseInProgress,
      });
      return;
    }
    if (rebaseInProgress === false) {
      void vscode.window.showWarningMessage(
        `Rebase onto '${target}' succeeded, but re-applying your stashed changes ` +
          `conflicted in ${conflicts.length} file(s). Resolve them and \`git add\` them. ` +
          `Do not continue or abort — the rebase is already complete.`
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `Rebase conflicts in ${conflicts.length} file(s). Please resolve conflicts.`
    );
  }

  /**
   * View the GitService through its worktree capability. The frozen
   * {@link IGitService} composite (ADR-001) does not declare the post-freeze
   * worktree methods; the concrete `GitService` implements them, so consumers
   * widen through the {@link IWorktreeCapableService} role interface.
   */
  private _worktreeService(): IWorktreeCapableService {
    return this._gitService as unknown as IWorktreeCapableService;
  }

  /**
   * "New Worktree…" — create a linked worktree checked out at the right-clicked
   * branch/tag (or a prompted ref), at a user-chosen path. Mirrors IntelliJ
   * git4idea's `git worktree add`: prompts whether to create a NEW branch in
   * the worktree or check out the existing ref, validates the target path does
   * not already exist, then runs the injection-safe argv builder in
   * {@link WorktreeOps.addWorktree}. Offers to open the new worktree afterward.
   */
  private async _handleNewWorktree(item?: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo) {
      return;
    }

    const ref = item?.branch?.name ?? item?.tag?.name ?? item?.getDetachedHeadSha() ?? 'HEAD';

    const targetPath = await vscode.window.showInputBox({
      prompt: `Path for the new worktree (checked out at '${ref}')`,
      placeHolder: '/absolute/path/to/worktree',
      validateInput: (value) => {
        const trimmed = value?.trim() ?? '';
        if (trimmed.length === 0) {
          return 'Worktree path cannot be empty';
        }
        if (trimmed.startsWith('-')) {
          return 'Worktree path cannot start with "-"';
        }
        return undefined;
      },
    });
    if (!targetPath || targetPath.trim().length === 0) {
      return;
    }
    const worktreePath = targetPath.trim();

    // Refuse a path that already exists — git would fail with a terse error;
    // a clear pre-check is friendlier and matches IntelliJ's path validation.
    let pathExists = false;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(worktreePath));
      pathExists = true;
    } catch {
      pathExists = false;
    }
    if (pathExists) {
      void vscode.window.showErrorMessage(
        `Cannot create worktree: '${worktreePath}' already exists.`
      );
      return;
    }

    const createBranchPick = await vscode.window.showQuickPick(
      [
        { label: `Check out '${ref}'`, mode: 'existing' as const },
        { label: 'Create a new branch in the worktree…', mode: 'new' as const },
      ],
      { placeHolder: 'How should the worktree be checked out?' }
    );
    if (!createBranchPick) {
      return;
    }

    let newBranch: string | undefined;
    if (createBranchPick.mode === 'new') {
      newBranch = await vscode.window.showInputBox({
        prompt: `New branch name (created at '${ref}')`,
        placeHolder: 'feature/my-worktree-branch',
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return 'Branch name cannot be empty';
          }
          if (!/^(?![-.])[\w\-./]+$/.test(value)) {
            return 'Invalid branch name';
          }
          return undefined;
        },
      });
      if (!newBranch) {
        return;
      }
    }

    const created = await this._worktreeService()
      .addWorktree(repo, { path: worktreePath, ref, newBranch })
      .match(
        () => true,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to create worktree', error)
          );
          return false;
        }
      );
    if (!created) {
      return;
    }

    this._branchTreeProvider.refresh();

    const open = await vscode.window.showInformationMessage(
      `Worktree created at '${worktreePath}'.`,
      'Open in New Window',
      'Open in Current Window'
    );
    if (open === 'Open in New Window' || open === 'Open in Current Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
        forceNewWindow: open === 'Open in New Window',
      });
    }
  }

  /**
   * "Open Worktree…" — list the repo's worktrees
   * (`git worktree list --porcelain`), let the user pick one, and open it as a
   * VS Code folder. The current/main worktree and any path equal to the active
   * repo root are still listed (you may want to reopen the main checkout in a
   * fresh window).
   */
  private async _handleOpenWorktree(): Promise<void> {
    const repo = this._getRepository();
    if (!repo) {
      return;
    }

    const worktrees = await this._worktreeService()
      .listWorktrees(repo)
      .match(
        (list) => list,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to list worktrees', error)
          );
          return undefined;
        }
      );
    if (!worktrees) {
      return;
    }
    if (worktrees.length === 0) {
      void vscode.window.showInformationMessage('No worktrees found for this repository.');
      return;
    }

    const items = worktrees.map((wt) => ({
      label: this._worktreeLabel(wt),
      description: wt.path,
      worktree: wt,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a worktree to open',
    });
    if (!picked) {
      return;
    }

    const newWindow = await vscode.window.showQuickPick(
      [
        { label: 'Open in New Window', forceNewWindow: true },
        { label: 'Open in Current Window', forceNewWindow: false },
      ],
      { placeHolder: `Open '${picked.worktree.path}'` }
    );
    if (!newWindow) {
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(picked.worktree.path),
      { forceNewWindow: newWindow.forceNewWindow }
    );
  }

  /**
   * "Remove Worktree…" — pick a linked worktree (never the main worktree or
   * the checkout this window has open), confirm once, and `git worktree
   * remove` it. Git's dirty/locked refusal is surfaced with a Force Remove
   * retry. The same picker carries a prune item (`git worktree prune`) so
   * stale records of manually-deleted worktrees are cleanable from one
   * front door.
   */
  private async _handleRemoveWorktree(): Promise<void> {
    const repo = this._getRepository();
    if (!repo) {
      return;
    }

    const worktrees = await this._worktreeService()
      .listWorktrees(repo)
      .match(
        (list) => list,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to list worktrees', error)
          );
          return undefined;
        }
      );
    if (!worktrees) {
      return;
    }

    const repoRoot = repo.rootUri.fsPath;
    const removable = worktrees.filter((wt) => !wt.isMain && wt.path !== repoRoot);

    type RemoveItem = vscode.QuickPickItem & { worktree?: IWorktreeEntry; prune?: boolean };
    const items: RemoveItem[] = removable.map((wt) => ({
      label: this._worktreeLabel(wt),
      description: wt.path,
      worktree: wt,
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(trash) Prune stale worktree records', prune: true });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder:
        removable.length === 0
          ? 'No linked worktrees to remove — prune cleans records of deleted ones'
          : 'Select a worktree to remove',
    });
    if (!picked) {
      return;
    }

    if (picked.prune) {
      const pruned = await this._worktreeService()
        .pruneWorktrees(repo)
        .match(
          () => true,
          (error) => {
            void vscode.window.showErrorMessage(
              formatActionFailureToast('Failed to prune worktrees', error)
            );
            return false;
          }
        );
      if (pruned) {
        void vscode.window.showInformationMessage('Pruned stale worktree records.');
        this._branchTreeProvider.refresh();
      }
      return;
    }

    const worktree = picked.worktree;
    if (!worktree) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove worktree '${worktree.path}'?`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') {
      return;
    }
    await this._removeWorktreeReporting(repo, worktree.path, false);
  }

  /**
   * Run one `git worktree remove`; on git's use-`--force` refusal (dirty or
   * locked tree) offer a single Force Remove retry, otherwise surface the
   * sanitized failure.
   */
  private async _removeWorktreeReporting(
    repo: IRepository,
    worktreePath: string,
    force: boolean
  ): Promise<void> {
    const failure = await this._worktreeService()
      .removeWorktree(repo, worktreePath, force ? true : undefined)
      .match(
        () => undefined,
        (error) => error
      );
    if (!failure) {
      void vscode.window.showInformationMessage(`Removed worktree '${worktreePath}'.`);
      this._branchTreeProvider.refresh();
      return;
    }
    if (!force && /--force/.test(failure.message)) {
      const choice = await vscode.window.showWarningMessage(
        `Worktree '${worktreePath}' has local modifications or is locked. Remove it anyway?`,
        { modal: true },
        'Force Remove'
      );
      if (choice === 'Force Remove') {
        await this._removeWorktreeReporting(repo, worktreePath, true);
      }
      return;
    }
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to remove worktree', failure)
    );
  }

  /**
   * Human-readable label for a worktree pick: the short branch name (stripping
   * the `refs/heads/` prefix git's porcelain emits), `(detached)` /
   * `(bare)` for those states, plus a `(locked)` / `(main)` suffix.
   */
  private _worktreeLabel(wt: IWorktreeEntry): string {
    let base: string;
    if (wt.isBare) {
      base = '(bare)';
    } else if (wt.isDetached) {
      base = '(detached)';
    } else if (wt.branch) {
      base = wt.branch.replace(/^refs\/heads\//, '');
    } else {
      base = '(unknown)';
    }
    const tags: string[] = [];
    if (wt.isMain) {
      tags.push('main');
    }
    if (wt.isLocked) {
      tags.push('locked');
    }
    return tags.length > 0 ? `${base} (${tags.join(', ')})` : base;
  }

  /**
   * Register all branch context menu commands.
   *
   * @param context - The VS Code extension context
   */
  register(context: vscode.ExtensionContext): void {
    // Local branch commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.checkout',
        failureTitle: 'Failed to check out',
        accepts: ['branch', 'detached'],
        run: (args) => this._handleCheckout(args),
      })
    );

    this._disposables.push(
      // spine-exempt: itemless dialog opener (New Branch works from any context)
      registerLoggedCommand('intellig.branch.new', () => this._handleNewBranch())
    );
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.newBranchFrom',
        failureTitle: 'Failed to create branch',
        accepts: ['branch', 'tag', 'detached'],
        run: (args) => this._handleNewBranchFrom(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.mergeIntoCurrent',
        failureTitle: 'Failed to merge',
        accepts: ['branch'],
        run: (args) => this._handleMergeIntoCurrent(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.rebaseCurrentOnto',
        failureTitle: 'Failed to rebase',
        accepts: ['branch'],
        run: (args) => this._handleRebaseCurrentOnto(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.compareWithCurrent',
        failureTitle: 'Failed to compare branches',
        accepts: ['branch'],
        run: async ({ repo, target }) => {
          const currentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';

          // GitCompareWithBranchAction opens a comparison surface, not a
          // notification — route through the Branch Comparison View (shared
          // with the commit menu's Compare with Branch…). The summary toast
          // remains only as the no-view fallback (legacy wiring / tests).
          if (this._branchComparisonView) {
            await this._branchComparisonView.show(repo, currentBranch, target.branch.name);
            return;
          }

          const comparison = await this._gitService.compareBranches(
            repo,
            currentBranch,
            target.branch.name
          );

          // Single line — VS Code notifications collapse newlines.
          void vscode.window.showInformationMessage(
            `Comparing ${currentBranch} with ${target.branch.name}: ` +
              `${comparison.aheadCount} commit(s) ahead · ` +
              `${comparison.behindCount} commit(s) behind · ` +
              `${comparison.changedFiles.length} file(s) changed`
          );
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.rename',
        failureTitle: 'Failed to rename branch',
        accepts: ['branch'],
        refreshOnSuccess: true,
        run: async ({ repo, target }) => {
          const oldName = target.branch.name;
          const newName = await vscode.window.showInputBox({
            prompt: `Rename branch '${oldName}' to:`,
            value: oldName,
            validateInput: (value) => {
              if (!value || !value.trim()) {
                return 'Branch name cannot be empty';
              }
              if (value === oldName) {
                return 'New name must be different';
              }
              // Reject leading `-` (git interprets as a CLI flag) and leading
              // `.` (git-check-ref-format) at the validator level, not just at
              // the service boundary.
              if (!/^(?![-.])[\w\-./]+$/.test(value)) {
                return 'Branch name contains invalid characters';
              }
              return undefined;
            },
          });
          if (!newName) {
            return;
          }
          await this._gitService.renameBranch(repo, oldName, newName).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Rename may have updated `repo.head.name` (if renaming the current
          // branch); reload before the spine's refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.delete',
        failureTitle: 'Failed to delete branch',
        accepts: ['branch'],
        run: (args) => this._handleDelete(args),
      })
    );

    // Remote branch commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.checkoutAsLocal',
        failureTitle: 'Failed to checkout branch',
        accepts: ['branch'],
        run: (args) => this._handleCheckoutAsLocal(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.cherryPickCommits',
        failureTitle: 'Failed to cherry-pick',
        accepts: ['branch'],
        run: (args) => this._handleCherryPickCommits(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullIntoCurrent',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'merge'),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.deleteRemote',
        failureTitle: 'Failed to delete remote branch',
        accepts: ['branch'],
        run: (args) => this._handleDeleteRemote(args),
      })
    );

    // Track Remote Branch single-entry smart-detect.
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.trackBranch',
        failureTitle: 'Failed to track branch',
        accepts: ['branch'],
        run: (args) => this._handleTrackRemote(args),
      })
    );

    // New command handlers
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.update',
        failureTitle: 'Failed to update branch',
        accepts: ['branch'],
        run: (args) => this._handleUpdate(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.updateSelected',
        failureTitle: 'Failed to update branch',
        accepts: ['branch'],
        run: (args) => this._handleUpdateSelected(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.push',
        failureTitle: 'Failed to push',
        accepts: ['branch'],
        run: (args) => this._handlePush(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.showDiffWithWorkingTree',
        failureTitle: 'Failed to show diff',
        accepts: ['branch'],
        run: (args) => this._handleShowDiffWithWorkingTree(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.checkoutAndRebase',
        failureTitle: 'Failed to checkout and rebase',
        accepts: ['branch'],
        run: (args) => this._handleCheckoutAndRebase(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullUsingRebase',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'rebase'),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullUsingMerge',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'merge'),
      })
    );

    // Tag commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.checkoutDetached',
        failureTitle: 'Failed to check out tag',
        accepts: ['tag'],
        run: (args) => this._handleTagCheckoutDetached(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.newBranchFrom',
        failureTitle: 'Failed to create branch',
        accepts: ['tag'],
        run: (args) => this._handleNewBranchFrom(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.cherryPick',
        failureTitle: 'Failed to cherry-pick tag',
        accepts: ['tag'],
        run: (args) => this._handleTagCherryPick(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.mergeIntoCurrent',
        failureTitle: 'Failed to merge tag',
        accepts: ['tag'],
        run: (args) => this._handleTagMergeIntoCurrent(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.delete',
        failureTitle: 'Failed to delete tag',
        accepts: ['tag'],
        refreshOnSuccess: true,
        run: async ({ repo, target, batch }) => {
          if (batch.length > 1) {
            return this._handleTagDeleteBatch(batch);
          }
          const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the tag '${target.tag.name}'?`,
            { modal: true },
            'Delete'
          );
          if (confirm !== 'Delete') {
            return;
          }
          await this._gitService.deleteTag(repo, target.tag.name).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Tag list changed; reload so the tree's tags section reflects the
          // post-deletion ref set before the spine's refresh.
          await this._gitService.reloadRepository(repo);
          // Fire-and-forget: the success toast + optional remote-delete action
          // must not hold the command (and its refresh) pending on the toast.
          void this._offerRemoteDeleteForLocalTags([{ repo, name: target.tag.name }]);
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.push',
        failureTitle: 'Failed to push tag',
        accepts: ['tag'],
        run: (args) => this._handleTagPush(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.deleteRemote',
        failureTitle: 'Failed to delete tag on remote',
        accepts: ['tag'],
        run: (args) => this._handleTagDeleteRemote(args),
      })
    );

    // Worktree commands
    this._disposables.push(
      // spine-exempt: deliberately usable without a tree target (worktree ref falls back to HEAD)
      registerLoggedCommand('intellig.branch.newWorktree', (item?: BranchTreeItem) =>
        this._handleNewWorktree(item)
      )
    );
    this._disposables.push(
      // spine-exempt: itemless repo-scope picker (lists worktrees, no tree target)
      registerLoggedCommand('intellig.branch.openWorktree', () => this._handleOpenWorktree())
    );
    this._disposables.push(
      // spine-exempt: itemless repo-scope picker (lists worktrees, no tree target)
      registerLoggedCommand('intellig.branch.removeWorktree', () => this._handleRemoveWorktree())
    );

    // Refresh command
    this._disposables.push(
      // spine-exempt: provider-only view refresh; needs no target or repo
      registerLoggedCommand('intellig.branches.refresh', () => this._branchTreeProvider.refresh())
    );

    // Add all disposables to context
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Get the current repository.
   */
  /**
   * Tree-item spine deps (see {@link registerTreeItemCommand}): the tree's
   * current repo as the fallback for items that don't carry one, and the
   * tree refresh for `refreshOnSuccess` specs.
   */
  private _treeItemDeps(): ITreeItemCommandDeps {
    return {
      getRepository: () => this._getRepository(),
      refresh: () => this._branchTreeProvider.refresh(),
    };
  }

  private _getRepository(): IRepository | undefined {
    return this._branchTreeProvider.getRepository();
  }

  /**
   * Resolve the repository a context-menu action targets. The clicked tree
   * leaf carries its owning repository — every branch/remote leaf is tagged
   * with the repo whose node it hangs under — so a colliding name (e.g.
   * `main`, present in every repo of a multi-root workspace) drives the git
   * op against the RIGHT repo. Falls back to the tree's current repository
   * for palette invocations, where no item is supplied.
   */
  private _resolveRepository(item?: BranchTreeItem): IRepository | undefined {
    return item?.repository ?? this._getRepository();
  }

  // ============================================
  // Shared error-handling helpers
  // ============================================

  /**
   * Handle the outer dirty-working-tree checkout error pattern.
   *
   * Four cases:
   * - Worktree conflict (git refuses atomically) → shows a targeted error,
   *   returns `null` (caller must not show a second error).
   * - UNTRACKED files would be overwritten → fatal error naming the files,
   *   returns `null`. No Stash & Switch: the stash has no
   *   `--include-untracked`, so a stash-and-retry fails on the same files
   *   (git4idea treats this arm as fatal, GitCheckoutOperation.java:187-190).
   * - TRACKED dirty tree (`would be overwritten` / `Please commit`) → shows
   *   the Stash & Switch / Force Checkout / Cancel dialog, returns the
   *   user's choice or `null` on Cancel.
   * - Any other error → shows `fallbackError` and returns `null`.
   *
   * Callers act on the returned choice and provide their own
   * branch-specific stash/force logic.
   */
  private async _handleDirtyTreeError(
    errorMessage: string,
    dirtyHeader: string,
    fallbackError: string
  ): Promise<'Stash & Switch' | 'Force Checkout' | null> {
    const worktreeMessage = worktreeConflictMessage(errorMessage);
    if (worktreeMessage) {
      void vscode.window.showErrorMessage(worktreeMessage);
      return null;
    }
    const untracked = parseUntrackedOverwriteFiles(errorMessage);
    if (untracked) {
      void vscode.window.showErrorMessage(
        `Untracked working tree files would be overwritten: ${untracked.join(', ')}. ` +
          `Move or remove them, then retry.`
      );
      return null;
    }
    if (
      errorMessage.includes('would be overwritten') ||
      errorMessage.includes('Please commit your changes or stash them')
    ) {
      const choice = await vscode.window.showWarningMessage(
        dirtyHeader,
        'Stash & Switch',
        'Force Checkout',
        'Cancel'
      );
      if (choice === 'Stash & Switch' || choice === 'Force Checkout') {
        return choice as 'Stash & Switch' | 'Force Checkout';
      }
      return null;
    }
    void vscode.window.showErrorMessage(fallbackError);
    return null;
  }

  /**
   * Restore ("pop") the auto-stash created by a Stash & Switch / Stash and
   * reset flow after the checkout landed — git4idea's Smart Checkout is
   * stash → checkout → UNSTASH; stopping after the checkout silently parks
   * the user's changes in the stash.
   *
   * A pop that conflicts with the switched-to branch routes into the
   * Resolve Conflicts flow as an `unstash` (same handoff StashView uses, so
   * ours/theirs reversal is correct); any other failure keeps the changes
   * safely in the stash and says so.
   *
   * @returns `'restored'` on a clean pop, `'conflict-routed'` when the
   *   Resolve Conflicts dialog took over, `'failed'` when the changes stay
   *   parked in the stash (already surfaced to the user).
   */
  private async _restoreStashAfterSwitch(
    repo: IRepository,
    stashSha?: string
  ): Promise<'restored' | 'conflict-routed' | 'failed'> {
    // Resolve the CREATED entry's current position first — `stash@{0}` is not
    // stable between the push and this pop (an autostash, a concurrent flow
    // or the user can push another entry, renumbering the stack), and popping
    // the head blindly applies the WRONG stash. `stashSha` is captured right
    // after the push; a legacy no-hash listing falls back to the head.
    let index = 0;
    if (stashSha !== undefined) {
      const entries = await this._gitService.stashList(repo);
      const entry = entries.find((e) => e.hash === stashSha);
      if (!entry) {
        void vscode.window.showWarningMessage(
          'Switched, but the auto-stash created for this checkout is no longer in the stash ' +
            'list — your changes were not restored.'
        );
        return 'failed';
      }
      index = entry.index;
    }
    try {
      await this._gitService.stashPop(repo, index).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      return 'restored';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this._conflictResolutionService && /conflict|needs merge/i.test(message)) {
        const conflicts = await this._conflictResolutionService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          await this._conflictResolutionService.openResolveConflictsDialog(repo, conflicts, {
            operation: 'unstash',
            target: `stash@{${index}}`,
            canAbort: true,
            canContinue: true,
          });
          return 'conflict-routed';
        }
      }
      void vscode.window.showWarningMessage(
        `Switched, but restoring your stashed changes failed: ${sanitizeGitError(message)}. ` +
          `They remain in the stash list.`
      );
      return 'failed';
    }
  }

  /**
   * The sha of the most recently created stash entry, captured immediately
   * after a `stash push` so {@link _restoreStashAfterSwitch} can pop exactly
   * that entry later. `undefined` when the listing carries no hash (legacy
   * stash-list form) — the restore then falls back to the head.
   */
  private async _createdStashSha(repo: IRepository): Promise<string | undefined> {
    try {
      const entries = await this._gitService.stashList(repo);
      return entries[0]?.hash;
    } catch {
      return undefined;
    }
  }

  // ============================================
  // Local Branch Command Handlers
  // ============================================

  /**
   * Handle checkout command for local branches.
   */
  private async _handleCheckout({
    repo,
    target,
  }: ITreeItemRunArgs<'branch' | 'detached'>): Promise<void> {
    // Accept the detached row as a checkout target (the SHA rides on the
    // target). The git command runs uniformly (no early-return on "already
    // at that commit" — IntelliJ does the same; the dirty-working-tree
    // fallback flow handles errors). The toast branches: branch name vs
    // detached re-checkout.
    const branch = target.kind === 'branch' ? target.branch : undefined;
    const ref = branch?.name ?? (target.kind === 'detached' ? target.sha : undefined);
    if (!ref) {
      return;
    }
    const successToast = (): string =>
      branch
        ? `Switched to branch '${branch.name}'`
        : `Re-checked out detached HEAD at ${ref.substring(0, 7)}`;
    const dirtyHeader = (): string =>
      branch
        ? `Cannot switch to '${branch.name}': local changes would be overwritten.`
        : `Cannot re-checkout detached HEAD at ${ref.substring(0, 7)}: local changes would be overwritten.`;
    const stashLabel = (): string =>
      branch
        ? `Auto-stash before checkout ${branch.name}`
        : `Auto-stash before checkout ${ref.substring(0, 7)}`;
    const stashSuccessToast = (restored: boolean): string => {
      const target = branch
        ? `switched to '${branch.name}'`
        : `re-checked out detached HEAD at ${ref.substring(0, 7)}`;
      return restored
        ? `Stashed changes, ${target}, and restored them`
        : `Stashed changes and ${target}`;
    };
    const forceSuccessToast = (): string =>
      branch
        ? `Force switched to '${branch.name}'`
        : `Force re-checked out detached HEAD at ${ref.substring(0, 7)}`;

    try {
      await this._gitService.checkout(repo, ref).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Checkout moved HEAD; reload before refresh so the
      // BranchTreeProvider's "current branch" mark reflects fresh state.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(successToast());
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        dirtyHeader(),
        `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, stashLabel()).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          await this._gitService.checkout(repo, ref).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Smart-checkout parity: restore the stash onto the new branch.
          const restore = await this._restoreStashAfterSwitch(repo, createdStashSha);
          // Stash + checkout (+ pop) moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          if (restore !== 'conflict-routed') {
            void vscode.window.showInformationMessage(stashSuccessToast(restore === 'restored'));
          }
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          await this._gitService.checkout(repo, ref, { force: true }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Force checkout moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(forceSuccessToast());
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

  /**
   * Handle the popup-header "New Branch" action — create a new branch starting
   * from the current HEAD (git4idea `Git.CreateNewBranch`). Routes through the
   * New Branch Dialog when wired; the dialog defaults its start point to HEAD
   * when none is supplied.
   */
  private _handleNewBranch(): void {
    const repo = this._getRepository();
    if (!repo) {
      void vscode.window.showErrorMessage('No Git repository found');
      return;
    }

    const startPoint = repo.head?.name?.replace('refs/heads/', '') || undefined;

    if (this._newBranchDialogOpener) {
      this._newBranchDialogOpener({ repo, startPoint });
      return;
    }

    void vscode.window.showErrorMessage('New Branch dialog is not available.');
  }

  /**
   * Handle new branch from here command.
   */
  private async _handleNewBranchFrom({
    repo,
    target,
  }: {
    repo: IRepository;
    target: TreeItemTarget;
  }): Promise<void> {
    // The start point is whatever was clicked: a branch name, a tag name,
    // or the detached row's 40-char SHA (never the parenthesized label).
    const startPoint =
      target.kind === 'branch'
        ? target.branch.name
        : target.kind === 'tag'
          ? target.tag.name
          : target.sha;
    if (!startPoint) {
      return;
    }

    // Route through the New Branch Dialog when the opener is wired.
    // Dialog handles name validation, tracking, overwrite, and checkout in a
    // single webview with typed options. Falls back to the old showInputBox
    // path when the opener is absent (test fixtures).
    if (this._newBranchDialogOpener) {
      this._newBranchDialogOpener({ repo, startPoint });
      return;
    }

    const branchName = await vscode.window.showInputBox({
      prompt: `Enter new branch name (from ${startPoint})`,
      placeHolder: 'feature/my-new-branch',
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Branch name cannot be empty';
        }
        // Reject leading `-` (git interprets as a CLI flag)
        // and leading `.` (git rejects refs starting with `.` per
        // git-check-ref-format) at the validator level. The
        // regex `^[\w\-./]+$` accepted `-foo` and `.hidden` because the
        // character class allowed `-` and `.` anywhere including the
        // first position; the service-boundary guard in
        // `GitService.createBranch` was the only line of defense.
        if (!/^(?![-.])[\w\-./]+$/.test(value)) {
          return 'Branch name contains invalid characters';
        }
        return undefined;
      },
    });

    if (!branchName) {
      return;
    }

    try {
      await this._gitService.createBranch(repo, branchName, startPoint).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      await this._gitService.checkout(repo, branchName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // createBranch + checkout pair moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Created and switched to branch '${branchName}' from '${startPoint}'`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to create branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle merge into current command.
   */
  private async _handleMergeIntoCurrent({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // deleteOnMerge = PROPOSE for a non-protected local branch
    // (GitBranchPopupActions.java:287-291); tags route through
    // _handleTagMergeIntoCurrent and never propose.
    const proposeDeleteOnMerge =
      target.branch.type === 'local' &&
      !target.branch.isHead &&
      !isProtectedTarget(target.branch.name, readConfig('protectedBranches'));

    // Route through the Merge Dialog when the opener is wired; the
    // dialog handles options (ff-only / no-ff / squash / no-commit / -m),
    // conflict handoff, and the PROPOSE affordance itself. Fallback path
    // (no opener) preserves the legacy direct-merge behaviour for tests.
    if (this._mergeDialogOpener) {
      this._mergeDialogOpener({ repo, sourceBranch: target.branch.name, proposeDeleteOnMerge });
      return;
    }

    try {
      const result = await this._gitService.mergeBranch(repo, target.branch.name);

      if (result.success) {
        const successMessage = `Merged '${target.branch.name}' successfully`;
        if (proposeDeleteOnMerge) {
          // Fire-and-forget: the PROPOSE toast must not hold the command.
          void proposeDeleteMergedBranch(
            { gitService: this._gitService, onDeleted: () => this._branchTreeProvider.refresh() },
            repo,
            target.branch.name,
            successMessage
          );
        } else {
          void vscode.window.showInformationMessage(successMessage);
        }
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back
        // to a warning toast otherwise (legacy callers without the service).
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: target.branch.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        // Non-conflict failure (refused merge, unrelated histories, dirty
        // tree, etc.). Surface the underlying git error instead of a
        // silent no-op. `failureReason` is sanitized at the GitService
        // boundary; safe to drop straight into a toast.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to merge '${target.branch.name}': ${sanitizeGitError(reason)}`
        );
      }
      // Merge moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to merge branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle rebase current onto command.
   *
   * Rebases the current branch onto the right-clicked one without walling off
   * a dirty working tree: `rebaseBranch` passes `--autostash`, so git stashes
   * any uncommitted changes, replays, and re-applies them (IntelliJ
   * smart-stash parity). A clean rebase reports success with the changes
   * restored. An autostash-pop conflict — where re-applying the stash collides
   * with the rebased changes — is surfaced via the conflicts path with
   * `rebaseInProgress: false`, so the user resolves and `git add`s the files
   * (no continue/abort, since the rebase already completed). A genuine
   * non-conflict failure surfaces git's reason via a `failureReason` toast.
   *
   * After the rebase runs, the handler reloads the repo
   * and inspects `repo.inProgress` (populated from `readInProgressOperation`
   * via `loadRepository`). On a non-conflict failure that left an orphaned
   * `rebasing` state created by OUR invocation, it auto-aborts. When a
   * rebasing state remains for any other reason (e.g. paused on conflicts
   * with no Resolve Conflicts dialog wired), it surfaces an actionable
   * "rebase paused" warning. The before/after snapshot of
   * `inProgress.kind` ensures we never touch a rebase the user already had
   * in progress before they clicked.
   */
  private async _handleRebaseCurrentOnto({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Canonical surface: route through the unified Rebase dialog (onto =
    // the clicked branch, Interactive unchecked by default). The dialog owns
    // the same conflict + orphan-recovery handling ported from the inline
    // path below. The inline path remains the fallback when no opener is
    // wired (legacy construction / focused unit tests).
    if (this._rebaseDialogOpener) {
      await this._rebaseDialogOpener({
        repo,
        onto: target.branch.name,
        interactiveDefault: false,
      });
      return;
    }

    try {
      // No dirty-tree pre-check: rebaseBranch passes `--autostash`, so a dirty
      // tree is stashed and re-applied around the replay (IntelliJ smart-stash
      // parity). A clean rebase reports success with changes restored; an
      // autostash-pop conflict surfaces below via the conflicts path. Walling
      // off dirty trees here would block exactly what autostash handles.

      // Snapshot the in-progress operation BEFORE invoking the
      // rebase. This lets us distinguish a rebasing state that OUR call
      // created (eligible for auto-abort / pause-warning recovery) from one
      // the user already had paused before they clicked. `repo.inProgress`
      // is populated by `loadRepository` via `readInProgressOperation`
      // (see gitInProgress.ts); `kind` is the `IInProgressOperation` field.
      const beforeKind = repo.inProgress?.kind;

      const result = await this._gitService.rebaseBranch(repo, target.branch.name);

      // Track whether the Resolve Conflicts dialog was opened so we suppress
      // the redundant "rebase paused" warning for that same state —
      // the dialog is itself the actionable continue/abort UI.
      let conflictDialogOpened = false;
      // Track the non-conflict-failure branch so only it is eligible for
      // auto-abort of an orphaned rebase.
      let nonConflictFailure = false;

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Rebased onto '${target.branch.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back to a
        // warning toast otherwise. A non-continuable autostash-pop conflict
        // (rebaseInProgress === false) suppresses continue/abort.
        conflictDialogOpened = !!this._conflictResolutionService;
        await this._surfaceRebaseConflicts(
          repo,
          result.conflicts,
          target.branch.name,
          result.rebaseInProgress
        );
      } else {
        // Non-conflict failure (e.g. dirty tree, in-progress rebase, refs
        // out of sync, remote ref disappeared, etc.). Surface the underlying
        // git error so the user has SOMETHING to act on instead of a silent
        // no-op. `failureReason` is already sanitized at the GitService
        // boundary, but we re-pipe through `sanitizeGitError` here so the
        // safety contract is locally evident at the toast site
        // and survives any future refactor of the source side.
        nonConflictFailure = true;
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to rebase onto '${target.branch.name}': ${sanitizeGitError(reason)}`
        );
      }

      // Rebase moved HEAD (or left an in-progress marker); reload before
      // refresh so the fresh `inProgress` state is read off disk.
      const reloaded = await this._gitService.reloadRepository(repo);
      const afterKind = (reloaded ?? repo).inProgress?.kind;

      if (nonConflictFailure && beforeKind !== 'rebasing' && afterKind === 'rebasing') {
        // Our non-conflict-failure invocation left an orphaned
        // rebasing state (`.git/rebase-merge/`). The user's mental model is
        // "I clicked rebase, it didn't work, it should be like I never
        // clicked it" — so auto-abort AFTER the error toast above. The
        // boundary is strict: only abort when the rebasing state did NOT
        // exist before our call. If the user already had a rebase paused,
        // `beforeKind === 'rebasing'` and we never touch it.
        try {
          // rebase-abort-exempt: orphaned-rebase recovery — non-conflict failure only; the before/after boundary above proves THIS invocation created the rebasing state
          await this._gitService.rebaseAbort(repo).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        } catch (abortError) {
          const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to abort orphaned rebase: ${sanitizeGitError(abortMsg)}`
          );
        }
      } else if (afterKind === 'rebasing' && !conflictDialogOpened) {
        // A rebasing state remains after the operation and we did
        // NOT open the Resolve Conflicts dialog as a dedicated UI. The rebase
        // is paused (conflicts) or was interrupted. Surface an actionable
        // warning. Of the rebase recovery commands the extension contributes,
        // only `intellig.rebase.skip` exists today (continue/abort are not
        // registered commands), so the message stays generic rather than
        // referencing command IDs that don't exist.
        void vscode.window.showWarningMessage(
          'Rebase paused with conflicts (or interruption). Resolve and continue, or abort.'
        );
      }

      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to rebase: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Handle delete command.
   *
   * Two-tier UX matching IntelliJ: the first attempt uses safe delete
   * (`git branch -d`), which refuses to delete a branch whose tip
   * commits aren't reachable from any other ref. On that specific
   * failure, prompt the user with a "Force delete?" modal and, on
   * confirm, retry with `git branch -D` (force).
   */
  private async _handleDelete(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    if (args.batch.length > 1) {
      return this._handleDeleteBatch(args.batch);
    }
    const { repo, target } = args;
    const branchName = target.branch.name;

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the branch '${branchName}'?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    const upstream = target.branch.upstream;
    try {
      await this._gitService.deleteBranch(repo, branchName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Branch list changed; reload so the tree shows the
      // post-deletion ref set deterministically.
      await this._gitService.reloadRepository(repo);
      // Fire-and-forget: the success toast + optional tracked-branch cascade
      // must not hold the command pending on the toast.
      void this._offerDeleteTrackedBranches(`Deleted branch '${branchName}'`, [
        { repo, name: branchName, upstream },
      ]);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (isNotFullyMergedError(errorMessage)) {
        const forceConfirm = await vscode.window.showWarningMessage(
          `Branch '${branchName}' is not fully merged. Force delete? Unmerged commits will be lost.`,
          { modal: true },
          'Force Delete'
        );
        if (forceConfirm !== 'Force Delete') {
          return;
        }
        try {
          await this._gitService.deleteBranch(repo, branchName, true).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          await this._gitService.reloadRepository(repo);
          void this._offerDeleteTrackedBranches(`Force-deleted branch '${branchName}'`, [
            { repo, name: branchName, upstream },
          ]);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMessage = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force-delete branch: ${sanitizeGitError(forceMessage)}`
          );
        }
        return;
      }

      void vscode.window.showErrorMessage(
        `Failed to delete branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Delete every branch in a multi-select batch: ONE confirm naming them
   * all, per-branch deletion with per-item repos, then ONE follow-up force
   * prompt covering every not-fully-merged branch (instead of a modal per
   * branch mid-batch). Other failures are collected into a single error
   * toast; the batch never stops early, so one refused branch doesn't strand
   * the rest of a cleanup.
   */
  private async _handleDeleteBatch(
    batch: ReadonlyArray<ITreeItemBatchEntry<'branch'>>
  ): Promise<void> {
    const names = batch.map((e) => e.target.branch.name);
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${batch.length} branches?\n\n${names.join(', ')}`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') {
      return;
    }

    const notMerged: Array<ITreeItemBatchEntry<'branch'>> = [];
    const failures: string[] = [];
    const touchedRepos = new Map<string, IRepository>();
    const deletedEntries: Array<{ repo: IRepository; name: string; upstream?: IUpstream }> = [];

    const tryDelete = async (
      entry: ITreeItemBatchEntry<'branch'>,
      force: boolean
    ): Promise<void> => {
      const name = entry.target.branch.name;
      try {
        await this._gitService.deleteBranch(entry.repo, name, force || undefined).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        deletedEntries.push({ repo: entry.repo, name, upstream: entry.target.branch.upstream });
        touchedRepos.set(entry.repo.rootUri.fsPath, entry.repo);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (!force && isNotFullyMergedError(message)) {
          notMerged.push(entry);
        } else {
          failures.push(`${name}: ${sanitizeGitError(message)}`);
        }
      }
    };

    for (const entry of batch) {
      await tryDelete(entry, false);
    }

    if (notMerged.length > 0) {
      const unmergedNames = notMerged.map((e) => e.target.branch.name).join(', ');
      const forceConfirm = await vscode.window.showWarningMessage(
        `${notMerged.length} branch(es) are not fully merged: ${unmergedNames}. ` +
          `Force delete? Unmerged commits will be lost.`,
        { modal: true },
        'Force Delete'
      );
      if (forceConfirm === 'Force Delete') {
        for (const entry of notMerged) {
          await tryDelete(entry, true);
        }
      }
    }

    for (const repo of touchedRepos.values()) {
      await this._gitService.reloadRepository(repo);
    }
    if (deletedEntries.length > 0) {
      // Fire-and-forget: the toast + optional tracked-branch cascade must
      // not hold the command pending on the toast.
      void this._offerDeleteTrackedBranches(
        deletedEntries.length === batch.length
          ? `Deleted ${deletedEntries.length} branches`
          : `Deleted ${deletedEntries.length} of ${batch.length} branches`,
        deletedEntries
      );
    }
    if (failures.length > 0) {
      void vscode.window.showErrorMessage(`Failed to delete: ${failures.join('; ')}`);
    }
    this._branchTreeProvider.refresh();
  }

  /**
   * Delete every tag in a multi-select batch: ONE confirm naming them all,
   * per-tag deletion with per-item repos, failures collected into a single
   * error toast. The spine's refreshOnSuccess covers the tree refresh.
   */
  private async _handleTagDeleteBatch(
    batch: ReadonlyArray<ITreeItemBatchEntry<'tag'>>
  ): Promise<void> {
    const names = batch.map((e) => e.target.tag.name);
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${batch.length} tags?\n\n${names.join(', ')}`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') {
      return;
    }

    const failures: string[] = [];
    const touchedRepos = new Map<string, IRepository>();
    const deleted: Array<{ repo: IRepository; name: string }> = [];
    for (const entry of batch) {
      const name = entry.target.tag.name;
      try {
        await this._gitService.deleteTag(entry.repo, name).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        deleted.push({ repo: entry.repo, name });
        touchedRepos.set(entry.repo.rootUri.fsPath, entry.repo);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        failures.push(`${name}: ${sanitizeGitError(message)}`);
      }
    }
    for (const repo of touchedRepos.values()) {
      await this._gitService.reloadRepository(repo);
    }
    // Fire-and-forget the success toast + optional remote-delete offer so it
    // doesn't hold the command pending on the toast.
    void this._offerRemoteDeleteForLocalTags(deleted);
    if (failures.length > 0) {
      void vscode.window.showErrorMessage(`Failed to delete: ${failures.join('; ')}`);
    }
  }

  // ============================================
  // New Command Handlers
  // ============================================

  /**
   * Handle update command for local branches — git4idea updateBranches parity
   * (GitBranchActionsUtil.updateBranches).
   *
   * A NON-current branch gets the align-local fast-forward via a
   * `<remoteRef>:<localRef>` fetch refspec (shared with Update Selected). The
   * CURRENT branch cannot be fetched into, so it is INTEGRATED — the
   * reference routes it through GitUpdateExecutionProcess (fetch + merge or
   * rebase per the update settings); ours mirrors Update Project's per-repo
   * step in {@link _updateCurrentBranch}.
   */
  private async _handleUpdate({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    const upstream = target.branch.upstream;
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Branch '${target.branch.name}' has no upstream configured.`
      );
      return;
    }

    if (!target.branch.isHead) {
      await this._alignLocalBranch(repo, target.branch);
      return;
    }

    await this._updateCurrentBranch(repo, target.branch);
  }

  /**
   * Integrate the CURRENT branch with its upstream. git4idea routes Update on
   * the checked-out branch through `GitUpdateExecutionProcess.update` (fetch +
   * merge/rebase per the update method, with a local-changes saver;
   * GitBranchActionsUtil.kt:51-63) — a fetch-plus-toast is not an update.
   *
   * Mirrors Update Project's single-repo step: fetch the upstream remote with
   * prune, probe the incoming count (0 ⇒ up-to-date toast, probe failure ⇒
   * pull anyway — never claim up-to-date on data we did not read), then pull
   * with the branch-default strategy (`resolveUpdateRebase` over
   * `intellig.pullRebase`) + autostash via {@link buildUpdatePullOptions}. A
   * pull that stops on conflicts routes into the Resolve Conflicts dialog
   * with the operation matching the strategy, so ours/theirs naming follows
   * the same reversal inference the pull handlers use.
   */
  private async _updateCurrentBranch(repo: IRepository, branch: IBranch): Promise<void> {
    const upstream = branch.upstream;
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Branch '${branch.name}' has no upstream configured.`
      );
      return;
    }
    const rebase = resolveUpdateRebase('branch-default', readConfig('pullRebase'));
    const strategy = rebase ? 'rebase' : 'merge';
    try {
      await this._gitService.fetch(repo, { remote: upstream.remote, prune: true }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      let incoming: number | undefined;
      const fetcher = getIncomingOutgoingFetcher(this._gitService);
      if (fetcher) {
        try {
          incoming = (await fetcher(repo, branch.name)).incoming;
        } catch {
          incoming = undefined;
        }
      }
      if (incoming === 0) {
        // Fetch updated remote-tracking refs; reload so ahead/behind counts
        // on the branch tree match the post-fetch state.
        await this._gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(
          `Fetched '${upstream.remote}'. '${branch.name}' is up to date.`
        );
        this._branchTreeProvider.refresh();
        return;
      }
      await this._gitService.pull(repo, buildUpdatePullOptions(rebase)).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Pull moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        incoming === undefined
          ? `Updated '${branch.name}' from '${upstream.remote}' using ${strategy}`
          : `Updated '${branch.name}': integrated ${incoming} commit(s) from ` +
              `'${upstream.remote}' using ${strategy}`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (await this._routePullConflicts(repo, strategy, branch.name)) {
        return;
      }
      void vscode.window.showErrorMessage(
        `Failed to update branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * After a failed pull, probe the working tree for unresolved conflicts and
   * hand off to the Resolve Conflicts dialog when any are present. Returns
   * whether the dialog took over (callers suppress their generic error toast
   * then). A probe failure is logged and treated as "no conflicts" so it
   * never swallows the original pull error.
   */
  private async _routePullConflicts(
    repo: IRepository,
    operation: 'merge' | 'rebase',
    target: string
  ): Promise<boolean> {
    if (!this._conflictResolutionService) {
      return false;
    }
    try {
      const conflicts = await this._conflictResolutionService.getConflictedFiles(repo);
      if (conflicts.length === 0) {
        return false;
      }
      await this._openResolveConflictsDialog(
        repo,
        conflicts.map((c) => c.path),
        { operation, target }
      );
      // The pull may have partially advanced HEAD before the conflict;
      // reload so the tree reflects the post-conflict state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
      return true;
    } catch (probeError) {
      // Do NOT toast the probe failure itself — the caller's generic error
      // is the one the user cares about. Keep the probe error in the log.
      getLogger()
        .child({ component: 'BranchContextMenuCommands' })
        .warn('pull conflict probe failed', {
          probeError: probeError instanceof Error ? probeError.message : String(probeError),
        });
      return false;
    }
  }

  /**
   * Align-local "Update Selected": fast-forward the clicked local branch to its
   * tracked remote WITHOUT checking it out, skipping it when it has diverged.
   *
   * git4idea parity: GitBranchActionsUtil.updateBranches advances every
   * non-current tracking branch via a `<remoteRef>:<localRef>` fetch refspec
   * (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`) and only ever
   * fast-forwards — diverged branches are left untouched. The current branch
   * is routed to a full integration instead (GitUpdateExecutionProcess in the
   * reference, {@link _updateCurrentBranch} here), since fetching into a
   * checked-out ref is refused. Surfaced from
   * BranchesDashboardActions.UpdateSelectedBranchAction.
   */
  private async _handleUpdateSelected({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    if (target.branch.isHead && target.branch.upstream) {
      await this._updateCurrentBranch(repo, target.branch);
      return;
    }
    await this._alignLocalBranch(repo, target.branch);
  }

  /**
   * Fast-forward one local branch to its tracked remote via the align-local
   * refspec fetch, shared by Update (non-current branches) and Update
   * Selected. When the divergence probe is unavailable or fails, the FF fetch
   * is attempted anyway — git itself refuses a non-fast-forward into a
   * non-checked-out ref — instead of claiming "up to date" on data we never
   * read.
   */
  private async _alignLocalBranch(repo: IRepository, branch: IBranch): Promise<void> {
    // Incoming/outgoing lives on the concrete GitService, not the frozen
    // IGitService (ADR-001), so reach it through the same duck-typed fetcher
    // the branch popup/tree use rather than widening the interface.
    const fetcher = getIncomingOutgoingFetcher(this._gitService);
    let counts: { incoming: number; outgoing: number } | undefined;
    if (fetcher) {
      try {
        const io = await fetcher(repo, branch.name);
        counts = { incoming: io.incoming, outgoing: io.outgoing };
      } catch {
        counts = undefined;
      }
    }

    let fetches: IAlignLocalFetch[];
    const skipped: { branch: string; reason: string }[] = [];
    let upToDate: string[] = [];
    if (counts === undefined) {
      // Divergence unknown. Classify via the planner with a synthetic
      // behind-only count so the checked-out / no-upstream skip reasons stay
      // canonical, then let git enforce FF-only on the attempted fetch.
      const plan = planAlignLocal([
        {
          name: branch.name,
          isCurrent: branch.isHead,
          upstream: branch.upstream,
          incoming: 1,
          outgoing: 0,
        },
      ]);
      fetches = plan.fetches;
      skipped.push(...plan.skipped);
    } else {
      const plan = planAlignLocal([
        {
          name: branch.name,
          isCurrent: branch.isHead,
          upstream: branch.upstream,
          incoming: counts.incoming,
          outgoing: counts.outgoing,
        },
      ]);
      fetches = plan.fetches;
      skipped.push(...plan.skipped);
      upToDate = plan.upToDate;
    }

    const advanced: string[] = [];
    for (const fetch of fetches) {
      try {
        await this._gitService.fetch(repo, { remote: fetch.remote, refspec: fetch.refspec }).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        advanced.push(fetch.branch);
      } catch (error) {
        // git refuses a non-FF update into a non-checked-out ref; treat a late
        // divergence (the tracking ref moved since we read the counts) as a
        // skip rather than a hard error, mirroring git4idea's FF-only semantics.
        const message = error instanceof Error ? error.message : 'Unknown error';
        skipped.push({
          branch: fetch.branch,
          reason: `fast-forward failed — ${sanitizeGitError(message)}`,
        });
      }
    }

    if (advanced.length > 0) {
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    }

    this._reportAlignLocalResult(advanced, skipped, upToDate);
  }

  /**
   * Surface the align-local outcome as a single info/warning toast. A clean
   * fast-forward is an info; any skip (diverged, no upstream, checked out)
   * downgrades to a warning so the user notices the branch was left behind.
   */
  private _reportAlignLocalResult(
    advanced: string[],
    skipped: { branch: string; reason: string }[],
    upToDate: string[]
  ): void {
    const parts: string[] = [];
    if (advanced.length > 0) {
      parts.push(`Fast-forwarded ${advanced.join(', ')}`);
    }
    if (upToDate.length > 0) {
      parts.push(`${upToDate.join(', ')} already up to date`);
    }
    for (const s of skipped) {
      parts.push(`Skipped ${s.branch}: ${s.reason}`);
    }

    const summary = parts.join('. ') + '.';
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(summary);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  }

  /**
   * Pick the target remote for a push — IntelliJ GitPushTarget.getRemoteToPush
   * / GitUtil.getDefaultOrFirstRemote parity
   * (git4idea/backend/src/push/GitPushTarget.java,
   * git4idea/backend/src/GitUtil.java#getDefaultOrFirstRemote).
   *
   * With at most one remote there is nothing to choose, so we return it
   * without prompting (single-remote fast path, unchanged behaviour). With
   * several remotes we show a QuickPick whose default — preselected first so
   * Enter accepts it, mirroring IntelliJ's preselected combobox — is the
   * branch's tracked remote when it still exists, else `origin`, else the
   * first remote. Returns the chosen remote name, or `undefined` if the user
   * cancels (caller aborts the push).
   *
   * The returned name flows into `gitService.push` / `pushTag`, both of which
   * splice it through `buildGitArgs` with `--end-of-options` ahead of the
   * remote — so a hostile remote name from `.git/config` can never be parsed
   * as a git flag (argv-injection defense; check:remote-ops-eoo).
   */
  private async _chooseTargetRemote(
    repo: IRepository,
    preferred?: string
  ): Promise<string | undefined> {
    let remotes: IRemote[];
    try {
      remotes = await this._gitService.getRemotes(repo).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
    } catch {
      // Enumeration failed (rare) — fall back to the preferred/origin default
      // and let the push itself surface any real error.
      return preferred ?? 'origin';
    }
    if (remotes.length <= 1) {
      return remotes[0]?.name ?? preferred ?? 'origin';
    }

    const names = remotes.map((r) => r.name);
    const fallback = names.includes('origin') ? 'origin' : names[0];
    const def = preferred && names.includes(preferred) ? preferred : fallback;
    const ordered = [def, ...names.filter((n) => n !== def)];

    const picked = await vscode.window.showQuickPick(
      ordered.map((name) => ({
        label: name,
        description: name === def ? 'default' : undefined,
      })),
      {
        title: 'Push — Choose Target Remote',
        placeHolder: `Select the remote to push to (default: ${def})`,
      }
    );
    return picked?.label;
  }

  /**
   * Handle push command for local branches.
   * Pushes the branch to its upstream remote, or sets upstream if none configured.
   */
  private async _handlePush({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Route through the Push Dialog when available so the user gets
    // the per-row target edit, force-with-lease dropdown, and protected-
    // branch guard. Falls back to a direct push (original behaviour) when
    // the opener is absent — e.g. in unit tests that don't wire the dialog.
    if (this._pushDialogOpener) {
      // Thread the clicked branch's OWN upstream so a non-HEAD branch that
      // already tracks a remote keeps it in the dialog instead of being forced
      // to --set-upstream against the fallback remote.
      this._pushDialogOpener({
        repo,
        branch: target.branch.name,
        upstream: target.branch.upstream,
        // Thread the clicked branch's OWN divergence so a non-HEAD row shows
        // its real ahead/behind and the force-with-lease flip fires.
        ahead: target.branch.ahead,
        behind: target.branch.behind,
      });
      return;
    }

    try {
      const upstream = target.branch.upstream;
      // When several remotes exist, let the user pick the target (default =
      // tracked remote / origin); a single remote skips the prompt. Cancelling
      // the picker aborts the push.
      const targetRemote = await this._chooseTargetRemote(repo, upstream?.remote);
      if (!targetRemote) {
        return;
      }
      // Set upstream when the branch isn't yet tracking, or when the user
      // redirected it to a remote other than its current upstream — matching
      // IntelliJ's "set new upstream" on a remote change. Pushing to the
      // already-tracked remote keeps the existing tracking untouched.
      const setUpstream = !upstream || targetRemote !== upstream.remote;
      await this._gitService
        .push(repo, {
          remote: targetRemote,
          branch: target.branch.name,
          ...(setUpstream ? { setUpstream: true } : {}),
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      void vscode.window.showInformationMessage(
        `Pushed branch '${target.branch.name}' to '${targetRemote}'`
      );
      // Fallback push path lacked any
      // reload/refresh; add both so ahead/behind counts on the
      // branch tree match the post-push state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to push branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle show diff with working tree command.
   * Opens a per-file diff comparison between the right-clicked branch ref and the working tree.
   *
   * Flow:
   *   1. List changed files between `<branchRef>` and the working tree
   *      (`git diff --name-status -z <ref>` via `getChangedFilesAgainstWorkingTree`).
   *   2. If zero files → `showInformationMessage`, return.
   *   3. Else show a multi-select QuickPick of the changed files (with M/A/D/R/C/T/U status).
   *   4. For each selected file, open a `vscode.diff` tab:
   *        left  = `intellig-git:<filePath>?<branchRef>` (served by the git content provider)
   *        right = on-disk working-tree file
   *      title  = `<basename> (<branchRef> ↔ Working Tree)`
   *   5. User cancels the QuickPick → no-op, no toast, no error.
   */
  private async _handleShowDiffWithWorkingTree({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    const branchRef = target.branch.name;

    let files: IRefDiffFile[];
    try {
      // Capability is declared optional on IGitService so implementations can opt in;
      // all production impls provide it, but guard in case a mock omits it.
      if (typeof this._gitService.getChangedFilesAgainstWorkingTree !== 'function') {
        void vscode.window.showErrorMessage(
          'Failed to show diff: Git service does not support ref-vs-working-tree diffs'
        );
        return;
      }
      files = await this._gitService.getChangedFilesAgainstWorkingTree(repo, branchRef);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to list changed files: ${sanitizeGitError(errorMessage)}`
      );
      return;
    }

    if (files.length === 0) {
      void vscode.window.showInformationMessage(`No changes between ${branchRef} and working tree`);
      return;
    }

    // Multi-select QuickPick: one row per changed file, prefixed with the status code.
    const items: Array<vscode.QuickPickItem & { file: IRefDiffFile }> = files.map((f) => ({
      label: `${f.status} ${f.path}`,
      description: f.oldPath ? `← ${f.oldPath}` : undefined,
      file: f,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Compare with ${branchRef}`,
      placeHolder: 'Select files to diff against the working tree (multi-select)…',
      canPickMany: true,
      matchOnDescription: true,
    });

    // User cancelled (hit Esc) → `selected` is undefined.
    // User accepted nothing → `selected` is an empty array; still a no-op.
    if (!selected || selected.length === 0) {
      return;
    }

    const rootFsPath = repo.rootUri.fsPath;
    const separator = rootFsPath.endsWith('/') || rootFsPath.endsWith('\\') ? '' : '/';

    for (const pick of selected) {
      const filePath = pick.file.path;
      const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(branchRef)}`);
      const rightUri = vscode.Uri.file(`${rootFsPath}${separator}${filePath}`);
      const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
      const title = `${basename} (${branchRef} ↔ Working Tree)`;

      await openRevisionDiff({ leftUri, rightUri, title }, `Failed to show diff for ${filePath}`);
    }
  }

  /**
   * Handle checkout and rebase command.
   * Checks out the right-clicked branch and rebases it onto the previously
   * current branch — IntelliJ's "Checkout and Rebase onto '{current}'" flow.
   *
   * Remote-branch handling: a plain `git checkout origin/main` on a
   * remote-tracking ref detaches HEAD at that ref's commit (remote-tracking
   * refs aren't local branches). IntelliJ's behaviour is to create or
   * fast-forward a LOCAL branch of the same leaf name, tracking the remote,
   * and check THAT out so HEAD stays attached. The fix below uses
   * `checkout -B <local> --track <remote>` when the right-clicked item is
   * a remote branch, mirroring `_handleCheckoutAsLocal`'s pattern.
   */
  private async _handleCheckoutAndRebase({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Store the revision to rebase onto BEFORE checkout. When HEAD is attached
    // that's the branch name; when DETACHED there's no branch name, so capture
    // the prior COMMIT sha — rebasing onto the literal 'HEAD' would target the
    // just-moved HEAD (a no-op / nonsensical target).
    const previousCurrentBranch = repo.head?.name?.replace('refs/heads/', '') || repo.head?.commit;
    if (!previousCurrentBranch) {
      void vscode.window.showErrorMessage('Cannot determine the previous revision to rebase onto.');
      return;
    }

    // Resolve the actual checkout target:
    //   - Local branch  → check out by name (`git checkout main`).
    //   - Remote branch → create-or-fast-forward a local tracking branch
    //     of the same leaf name (`git checkout -B main --track origin/main`).
    //     This keeps HEAD attached. IntelliJ parity.
    const isRemote = target.branch.type === 'remote';
    const remoteFullName = target.branch.name; // e.g. 'origin/main'
    const localLeafName = isRemote
      ? remoteFullName.split('/').slice(1).join('/') // 'origin/main' → 'main'
      : target.branch.name;
    // The branch label rendered in toasts always uses the LOCAL leaf name —
    // reads as "Checked out main" rather than "Checked out origin/main".
    const displayName = localLeafName;
    const checkout = (force?: boolean): Promise<void> =>
      (isRemote
        ? this._gitService.checkout(repo, localLeafName, {
            forceCreate: true,
            track: remoteFullName,
            ...(force ? { force: true } : {}),
          })
        : this._gitService.checkout(repo, localLeafName, force ? { force: true } : undefined)
      ).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

    try {
      // Checkout the right-clicked branch (attached HEAD).
      await checkout();

      // Rebase onto the previously current branch
      const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        await this._surfaceRebaseConflicts(
          repo,
          result.conflicts,
          previousCurrentBranch,
          result.rebaseInProgress
        );
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
        );
      }
      // Checkout + rebase moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        `Cannot switch to '${displayName}': local changes would be overwritten.`,
        `Failed to checkout and rebase: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, `Auto-stash before checkout ${displayName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          await checkout();
          // Smart-checkout parity: restore the stash before the rebase (the
          // rebase itself runs with --autostash, so restored dirtiness is
          // handled). A conflicted restore hands off to the Resolve
          // Conflicts flow and must NOT start a rebase over an unmerged tree.
          const restoreOutcome = await this._restoreStashAfterSwitch(repo, createdStashSha);
          if (restoreOutcome === 'conflict-routed') {
            await this._gitService.reloadRepository(repo);
            this._branchTreeProvider.refresh();
            return;
          }
          const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
          if (result.success) {
            void vscode.window.showInformationMessage(
              `Stashed changes, checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
            );
          } else if (result.conflicts && result.conflicts.length > 0) {
            await this._surfaceRebaseConflicts(
              repo,
              result.conflicts,
              previousCurrentBranch,
              result.rebaseInProgress
            );
          } else {
            // Non-conflict failure: surface the underlying git error.
            const reason = result.failureReason ?? 'unknown error (no output from git)';
            void vscode.window.showErrorMessage(
              `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
            );
          }
          // Stash + checkout + rebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          await checkout(true);
          const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
          if (result.success) {
            void vscode.window.showInformationMessage(
              `Force checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
            );
          } else if (result.conflicts && result.conflicts.length > 0) {
            await this._surfaceRebaseConflicts(
              repo,
              result.conflicts,
              previousCurrentBranch,
              result.rebaseInProgress
            );
          } else {
            // Non-conflict failure: surface the underlying git error.
            const reason = result.failureReason ?? 'unknown error (no output from git)';
            void vscode.window.showErrorMessage(
              `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
            );
          }
          // Force checkout + rebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout and rebase: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

  /**
   * Shared implementation for the pullUsing* handlers.
   *
   * The right-click menu entry already chose the strategy
   * (`pullUsingRebase` → rebase, `pullUsingMerge` → merge), so this path
   * pulls directly via `gitService.pull` with `rebase: preset === 'rebase'`
   * and never opens the PullDialog. Previously this delegated to
   * `PullDialog.show`, which popped a second "Pull: Options" QuickPick
   * requiring the synthetic ▶ Pull terminal item; dismissing it returned
   * `{status:'cancelled'}` that the caller awaited but never branched on,
   * making the action look like a silent no-op.
   *
   * `_pullDialogAccessor` remains a field/constructor param (other wiring
   * may reference it) but is intentionally NOT consulted here. The generic
   * `intellig.pull` palette command still routes through PullDialog — that
   * entry point is where strategy IS the question.
   */
  private async _runPullFromBranchMenu(
    { repo, target }: ITreeItemRunArgs<'branch'>,
    preset: 'rebase' | 'merge'
  ): Promise<void> {
    // Parse remote name and branch name from target.branch.name
    // (e.g., "origin/main" -> "origin", "main")
    const slashIndex = target.branch.name.indexOf('/');
    const remoteName =
      slashIndex >= 0 ? target.branch.name.substring(0, slashIndex) : target.branch.name;
    const branchName =
      slashIndex >= 0 ? target.branch.name.substring(slashIndex + 1) : target.branch.name;

    // The right-click pullUsing* entries intentionally bypass the
    // PullDialog — the menu entry already chose the strategy, so the second
    // "Pull: Options" QuickPick was redundant friction whose silent cancel
    // looked like a no-op. The `_pullDialogAccessor` field is retained for
    // constructor-arity / wiring compatibility (the generic `intellig.pull`
    // palette command still routes through PullDialog). Emit a debug note
    // (visible only at `log.level=debug`) so a received click is observable
    // even though no dialog opens.
    getLogger()
      .child({ component: 'BranchContextMenuCommands' })
      .debug('pullUsing* bypassing PullDialog (strategy chosen via menu)', {
        preset,
        dialogAvailable: this._pullDialogAccessor !== undefined,
      });

    // Direct-pull path — the only path for both presets. The conflict-probe
    // handoff below auto-opens the Resolve Conflicts dialog when the pull
    // leaves the working tree with unresolved conflicts.
    try {
      await this._gitService
        .pull(repo, {
          remote: remoteName,
          branch: branchName,
          rebase: preset === 'rebase',
          prune: true,
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showInformationMessage(
        `Pulled '${target.branch.name}' into current branch using ${strategy}`
      );
      // Pull moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Conflict handoff: probe the working tree and auto-open the Resolve
      // Conflicts dialog when the pull left unresolved conflicts.
      // Pull-using-rebase maps to `'rebase'` and pull-using-merge to
      // `'merge'` — the same post-conflict states merge / rebase produce
      // directly. A probe failure never swallows the original pull error —
      // the generic toast below still fires.
      if (await this._routePullConflicts(repo, preset, target.branch.name)) {
        return;
      }
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showErrorMessage(
        `Failed to pull using ${strategy}: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  // ============================================
  // Remote Branch Command Handlers
  // ============================================

  /**
   * Handle checkout as local branch command.
   *
   * A remote branch "Checkout" must land the user on the remote tip
   * even when a stale local of the same name exists. We use IntelliJ's
   * idiom `git checkout -B <branch> <remote>/<branch>` (forceCreate) which
   * creates-or-resets the local to the remote tip in one step — the old
   * `localExists ? plain-checkout : create-tracking` branching left a stale
   * local untouched. Because `-B` rewrites the local's commit pointer, we
   * first probe the local branch's `ahead` count and, when it has commits
   * not on the remote (which would become unreachable), show a modal
   * confirmation before resetting.
   */
  private async _handleCheckoutAsLocal({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
    const parts = target.branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');
    const track = `${remoteName}/${branchName}`;

    try {
      // Data-loss guard: if a local branch of the same name exists and is
      // ahead of the remote, `-B` would orphan its unique commits. Probe the
      // local IBranch and prompt before resetting. When the local doesn't
      // exist (nothing to lose) or `ahead === 0` (the reset is a no-op or a
      // fast-forward), skip the prompt and reset directly.
      const branches = await this._gitService.getBranches(repo);
      const local = branches.find((b) => b.type === 'local' && b.name === branchName);
      const ahead = local?.ahead ?? 0;

      let stashedBeforeReset = false;
      let stashShaBeforeReset: string | undefined;
      if (local && ahead > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Local branch '${branchName}' has ${ahead} commit${ahead === 1 ? '' : 's'} ` +
            `not on remote '${track}'. Resetting to the remote tip will make ` +
            `${ahead === 1 ? 'it' : 'them'} unreachable.`,
          { modal: true },
          'Reset anyway',
          'Stash and reset'
        );
        if (choice === 'Stash and reset') {
          await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          stashShaBeforeReset = await this._createdStashSha(repo);
          stashedBeforeReset = true;
        } else if (choice !== 'Reset anyway') {
          // Cancel (or dialog dismissed): do not touch the local branch.
          return;
        }
      }

      // Create-or-reset the local to the remote tip in one step.
      await this._gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

      // Smart-checkout parity: a "Stash and reset" restores the stash too.
      const resetRestore = stashedBeforeReset
        ? await this._restoreStashAfterSwitch(repo, stashShaBeforeReset)
        : 'restored';

      // checkout-as-local moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      if (resetRestore !== 'conflict-routed') {
        void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        `Cannot switch to '${branchName}': local changes would be overwritten.`,
        `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          // `-B` create-or-resets regardless of whether a local exists.
          await this._gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Smart-checkout parity: restore the stash onto the new branch.
          const restore = await this._restoreStashAfterSwitch(repo, createdStashSha);
          // Stash + checkout (+ pop) moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          if (restore !== 'conflict-routed') {
            void vscode.window.showInformationMessage(
              restore === 'restored'
                ? `Stashed changes, switched to '${branchName}', and restored them`
                : `Stashed changes and switched to '${branchName}'`
            );
          }
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          // `-B` create-or-resets regardless of whether a local exists.
          await this._gitService
            .checkout(repo, branchName, {
              forceCreate: true,
              force: true,
              track,
            })
            .match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          // Force checkout moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(`Force switched to '${branchName}'`);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

  /**
   * Handle cherry-pick commits command.
   */
  private async _handleCherryPickCommits({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    try {
      // Scope the log to the SELECTED branch (e.g. `origin/feature`), not the
      // repo's global HEAD history — otherwise the picker lists HEAD's recent
      // commits and the user cherry-picks the wrong commits.
      const commits = await this._gitService.getLog(repo, {
        maxCount: 50,
        ref: target.branch.name,
      });

      const commitItems = commits.map((commit) => ({
        label: commit.shortHash,
        description: commit.message.split('\n')[0],
        detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
        commit,
      }));

      const selected = await vscode.window.showQuickPick(commitItems, {
        title: `Cherry-pick commits from ${target.branch.name}`,
        placeHolder: 'Select commits to cherry-pick',
        canPickMany: true,
      });

      if (!selected || selected.length === 0) {
        return;
      }

      const commitHashes = selected.map((s) => s.commit.hash);
      const result = await this._gitService.cherryPick(repo, commitHashes).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked ${selected.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'cherryPick',
            target: target.branch.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
      }
      // cherry-pick moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Report a local branch deletion and, when the deleted branch's upstream is
   * now orphaned, offer to delete it on the remote too. Mirrors IntelliJ's
   * GitDeleteBranchOperation success notification, whose "Delete Tracked
   * Branch" action appears when the upstream has no other tracking branch
   * and is not protected (GitDeleteBranchOperation.java:158-165) — and our
   * own tag cascade ({@link _offerRemoteDeleteForLocalTags}).
   */
  private async _offerDeleteTrackedBranches(
    summary: string,
    deleted: ReadonlyArray<{ repo: IRepository; name: string; upstream?: IUpstream }>
  ): Promise<void> {
    const protectedBranches = readConfig('protectedBranches');
    // Eligibility per deleted branch: it tracked an upstream, that upstream
    // is not protected, and no surviving local still tracks it. The branch
    // list is read AFTER the deletion, so the deleted branch itself never
    // counts as a tracker. A branch-list read failure degrades to no offer.
    const branchesByRepo = new Map<string, IBranch[]>();
    const eligible: Array<{ repo: IRepository; upstream: IUpstream }> = [];
    for (const d of deleted) {
      if (!d.upstream || isProtectedTarget(d.upstream.name, protectedBranches)) {
        continue;
      }
      const key = d.repo.rootUri.fsPath;
      let branches = branchesByRepo.get(key);
      if (!branches) {
        try {
          branches = await this._gitService.getBranches(d.repo);
        } catch {
          branches = [];
        }
        branchesByRepo.set(key, branches);
      }
      const upstream = d.upstream;
      const stillTracked = branches.some(
        (b) =>
          b.type === 'local' &&
          b.upstream?.remote === upstream.remote &&
          b.upstream?.name === upstream.name
      );
      if (!stillTracked) {
        eligible.push({ repo: d.repo, upstream });
      }
    }

    if (eligible.length === 0) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    const label = eligible.length === 1 ? 'Delete Tracked Branch' : 'Delete Tracked Branches';
    const named =
      eligible.length === 1
        ? `'${eligible[0].upstream.remote}/${eligible[0].upstream.name}' is no longer tracked.`
        : `${eligible.length} upstream branches are no longer tracked.`;
    const choice = await vscode.window.showInformationMessage(`${summary}. ${named}`, label);
    if (choice !== label) {
      return;
    }
    let removed = 0;
    for (const e of eligible) {
      if (await this._deleteRemoteBranchRef(e.repo, e.upstream.remote, e.upstream.name)) {
        removed += 1;
      }
    }
    if (removed > 0) {
      const last = eligible[eligible.length - 1];
      void vscode.window.showInformationMessage(
        removed === 1
          ? `Deleted remote branch '${last.upstream.remote}/${last.upstream.name}'`
          : `Deleted ${removed} remote branches`
      );
      this._branchTreeProvider.refresh();
    }
  }

  /**
   * Delete one branch on `remote` (`git push <remote> :<name>`). Returns
   * whether it succeeded; a failure is toasted (credentials scrubbed) and
   * swallowed so a cascade can continue. Confirmation is the caller's job.
   */
  private async _deleteRemoteBranchRef(
    repo: IRepository,
    remote: string,
    name: string
  ): Promise<boolean> {
    try {
      await this._gitService.push(repo, { remote, branch: `:${name}` }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Push :branch removed the remote ref; reload so the tree's
      // remote-branches list reflects the deletion.
      await this._gitService.reloadRepository(repo);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to delete remote branch '${remote}/${name}': ${sanitizeGitError(errorMessage)}`
      );
      return false;
    }
  }

  /**
   * Handle delete remote branch command.
   *
   * IntelliJ parity (GitDeleteRemoteBranchOperation.java:46-72): the confirm
   * also offers deleting the LOCAL branches tracking the remote one — the
   * current branch excluded. Accepting deletes the remote ref, then each
   * tracking local; a not-fully-merged local is force-deleted without a
   * second prompt, matching the reference's execute() flow (the user already
   * confirmed deleting exactly these branches).
   */
  private async _handleDeleteRemote({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Parse remote name from branch name
    const parts = target.branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');

    // Tracking locals eligible for the cascade (current branch excluded —
    // "don't propose to remove current branch even if it tracks the remote
    // branch"). A branch-list read failure degrades to the plain confirm.
    let trackingLocals: string[] = [];
    try {
      const branches = await this._gitService.getBranches(repo);
      trackingLocals = branches
        .filter(
          (b) =>
            b.type === 'local' &&
            !b.isHead &&
            b.upstream?.remote === remoteName &&
            b.upstream?.name === branchName
        )
        .map((b) => b.name);
    } catch {
      trackingLocals = [];
    }

    const DELETE_WITH_LOCALS = 'Delete with Local Branches';
    const message =
      trackingLocals.length > 0
        ? `Are you sure you want to delete the remote branch '${target.branch.name}'? ` +
          `This cannot be undone. Tracking local branch(es): ${trackingLocals.join(', ')}.`
        : `Are you sure you want to delete the remote branch '${target.branch.name}'? This cannot be undone.`;
    const buttons = trackingLocals.length > 0 ? ['Delete', DELETE_WITH_LOCALS] : ['Delete'];
    const confirm = await vscode.window.showWarningMessage(message, { modal: true }, ...buttons);
    if (confirm !== 'Delete' && confirm !== DELETE_WITH_LOCALS) {
      return;
    }

    if (!(await this._deleteRemoteBranchRef(repo, remoteName, branchName))) {
      return;
    }

    const deletedLocals: string[] = [];
    if (confirm === DELETE_WITH_LOCALS) {
      for (const local of trackingLocals) {
        try {
          try {
            await this._gitService.deleteBranch(repo, local).match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            if (!isNotFullyMergedError(msg)) {
              throw error;
            }
            // Auto-force, reference parity: GitDeleteBranchOperation retries
            // with force when the safe delete reports not-fully-merged; the
            // confirm above already named this branch.
            await this._gitService.deleteBranch(repo, local, true).match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          }
          deletedLocals.push(local);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to delete local branch '${local}': ${sanitizeGitError(msg)}`
          );
        }
      }
    }

    await this._gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(
      deletedLocals.length > 0
        ? `Deleted remote branch '${target.branch.name}' and local ${deletedLocals.join(', ')}`
        : `Deleted remote branch '${target.branch.name}'`
    );
    this._branchTreeProvider.refresh();
  }

  /**
   * IntelliJ-parity "Track Branch" — single menu
   * entry with smart detection of the user's intent based on whether a
   * matching local branch already exists.
   *
   * Behaviour matrix (matching IntelliJ's "Track Branch" semantics):
   *
   *   - **No local with the simple name**: create + checkout the local
   *     branch with the right-clicked remote ref as upstream
   *     (`git checkout --track <remote>/<branch>` shape via
   *     `gitService.checkout(createBranch: true, track: …)`).
   *
   *   - **Local exists with no upstream**: silently set its upstream
   *     to the right-clicked remote ref via
   *     `gitService.setBranchUpstream(local, upstream)`. No checkout
   *     (the user is already in the local; if they're not, they didn't
   *     ask to switch).
   *
   *   - **Local exists with a different upstream**: confirm dialog,
   *     then `gitService.setBranchUpstream(local, upstream)` if the
   *     user agrees. The cross-tracking case is the one footgun in
   *     this menu — without confirm, the user could accidentally lose
   *     their existing tracking association on `git pull`.
   *
   *   - **Local exists with the SAME upstream**: no-op + info toast
   *     ("Already tracking …"). Saves the user wondering whether the
   *     menu fired at all.
   *
   * We exposed only `Checkout (as new local)` for remote
   * branches, which always created a new local — the existing-local
   * cross-tracking case had no menu surface at all. Closes that
   * IntelliJ-parity gap.
   */
  private async _handleTrackRemote({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Parse remote name from branch name (e.g. "origin/main" -> remote
    // "origin", branch "main"). The "simple name" extraction matches
    // the existing checkoutAsLocal path; nested branch names like
    // `origin/feature/foo` produce simple-name `feature/foo`.
    const parts = target.branch.name.split('/');
    if (parts.length < 2) {
      // Defensive — `IBranch.type === 'remote'` should guarantee a
      // remote-prefixed name, but if somehow we got a malformed input
      // surface a clear error rather than crashing on the slice below.
      void vscode.window.showErrorMessage(
        `Cannot parse remote branch '${target.branch.name}' — expected format <remote>/<branch>.`
      );
      return;
    }
    const upstreamRef = target.branch.name; // e.g. "origin/main"
    const simpleName = parts.slice(1).join('/');

    // SK-2 — defense-in-depth: sweep relied on
    // validateBranchName at the service boundary for checkout({ createBranch }),
    // but the simpleName here is sliced from a parsed remote branch name
    // which could theoretically be hostile (e.g. a malformed remote ref like
    // `origin/-evil` or `origin/.hidden`). Guard explicitly before the
    // checkout / setBranchUpstream call so the error surface is a friendly
    // showErrorMessage rather than a service-boundary throw.
    if (simpleName.startsWith('-') || simpleName.startsWith('.')) {
      void vscode.window.showErrorMessage(
        `Cannot create local branch from remote with reserved name prefix: ${simpleName}`
      );
      return;
    }

    let existingLocal: IBranch | undefined;
    try {
      const branches = await this._gitService.getBranches(repo);
      existingLocal = branches.find((b) => b.type === 'local' && b.name === simpleName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to load branches: ${sanitizeGitError(msg)}`);
      return;
    }

    try {
      if (!existingLocal) {
        // No local with this name → create + checkout with --track.
        await this._gitService
          .checkout(repo, simpleName, {
            createBranch: true,
            track: upstreamRef,
          })
          .match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        await this._gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(
          `Created local branch '${simpleName}' tracking '${upstreamRef}'`
        );
        this._branchTreeProvider.refresh();
        return;
      }

      // Existing local — examine its upstream.
      const currentUpstream = existingLocal.upstream
        ? `${existingLocal.upstream.remote}/${existingLocal.upstream.name}`
        : undefined;

      if (currentUpstream === upstreamRef) {
        void vscode.window.showInformationMessage(
          `'${simpleName}' already tracks '${upstreamRef}'`
        );
        return;
      }

      if (currentUpstream && currentUpstream !== upstreamRef) {
        const confirm = await vscode.window.showWarningMessage(
          `'${simpleName}' currently tracks '${currentUpstream}'. Re-track to '${upstreamRef}'?`,
          { modal: true },
          'Re-track'
        );
        if (confirm !== 'Re-track') {
          return;
        }
      }

      await this._gitService.setBranchUpstream(repo, simpleName, upstreamRef).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`'${simpleName}' now tracks '${upstreamRef}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to track branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  // ============================================
  // Tag Command Handlers
  // ============================================

  /**
   * Handle tag checkout (detached) command.
   */
  private async _handleTagCheckoutDetached({
    repo,
    target,
  }: ITreeItemRunArgs<'tag'>): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Checking out tag '${target.tag.name}' will put you in detached HEAD state. Continue?`,
      { modal: true },
      'Checkout'
    );

    if (confirm !== 'Checkout') {
      return;
    }

    try {
      await this._gitService.checkout(repo, target.tag.name).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // checkout-tag moved HEAD into detached state; reload
      // before refresh so the tree's "current branch" mark clears
      // (HEAD chip on the log graph drives the user-visible cue).
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Checked out tag '${target.tag.name}' (detached HEAD)`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to checkout tag: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle tag cherry-pick command.
   */
  private async _handleTagCherryPick({ repo, target }: ITreeItemRunArgs<'tag'>): Promise<void> {
    try {
      const result = await this._gitService.cherryPick(repo, [target.tag.commit]).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked tag '${target.tag.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Hand off to the Resolve Conflicts dialog like every sibling
        // cherry-pick path (branch-scoped picker, commit context menu) —
        // the sequencer is mid-cherry-pick and needs resolve/abort
        // affordances, not a dead-end toast. Cherry-pick is a forward
        // operation: no ours/theirs reversal.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'cherryPick',
            target: target.tag.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
      }
      // cherry-pick from tag moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle tag "Merge into Current" command — merge the selected tag into the
   * current branch. IntelliJ git4idea parity: GitBranchPopupActions.TagActions
   * offers a MergeAction built from `new GitTag(tagName)`, so the same
   * `Merge <ref> into Current` flow that branches use applies to a tag ref.
   *
   * Reuses the existing merge surface: routes through the Merge Dialog when
   * wired (the dialog feeds the tag name straight into `mergeBranch` as a
   * generic source ref and owns the ff-only/no-ff/squash options plus conflict
   * handoff), falling back to a direct `mergeBranch` with the same conflict /
   * non-conflict-failure routing as `_handleMergeIntoCurrent`.
   */
  private async _handleTagMergeIntoCurrent({
    repo,
    target,
  }: ITreeItemRunArgs<'tag'>): Promise<void> {
    const tagRef = target.tag.name;

    if (this._mergeDialogOpener) {
      this._mergeDialogOpener({ repo, sourceBranch: tagRef });
      return;
    }

    try {
      const result = await this._gitService.mergeBranch(repo, tagRef);

      if (result.success) {
        void vscode.window.showInformationMessage(`Merged '${tagRef}' successfully`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: tagRef,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to merge '${tagRef}': ${sanitizeGitError(reason)}`
        );
      }
      // Merge moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge tag: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Handle push tag command.
   */
  private async _handleTagPush({ repo, target }: ITreeItemRunArgs<'tag'>): Promise<void> {
    try {
      // Choose the target remote when several exist (default = origin / first);
      // a single remote pushes without prompting. Cancel aborts.
      const targetRemote = await this._chooseTargetRemote(repo);
      if (!targetRemote) {
        return;
      }
      await this._gitService.pushTag(repo, target.tag.name, targetRemote).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        `Pushed tag '${target.tag.name}' to '${targetRemote}'`
      );
      // pushTag updates remote-tracking refs;
      // reload + refresh so the tag tree's "pushed to remote" cue
      // (when present) reads the post-push state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push tag: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Handle delete-remote-tag command — IntelliJ GitDeleteRemoteTagOperation parity
   * (`git4idea/backend/src/ui/GitTagDialog.java` and
   * `StashTagHistoryOps.deleteRemoteTag`).
   *
   * Prompts for confirmation then calls
   * `git push <remote> :refs/tags/<name>` via the existing
   * {@link StashTagHistoryOps.deleteRemoteTag} op. Errors route through
   * {@link sanitizeGitError} so credentials in remote URLs are stripped.
   */
  private async _handleTagDeleteRemote({ repo, target }: ITreeItemRunArgs<'tag'>): Promise<void> {
    // Choose the target remote (default = origin / first; prompt when several
    // exist), mirroring `_handleTagPush` — don't silently hardcode origin in a
    // multi-remote repo. Cancel aborts.
    const targetRemote = await this._chooseTargetRemote(repo);
    if (!targetRemote) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete remote tag '${target.tag.name}' from ${targetRemote}?`,
      { modal: true },
      'Delete from Remote'
    );

    if (confirm !== 'Delete from Remote') {
      return;
    }

    if (!(await this._deleteRemoteTag(repo, target.tag.name, targetRemote))) {
      return;
    }
    // Re-sync the tree with reality (this command previously never refreshed).
    this._branchTreeProvider.refresh();
    // Fire-and-forget the success toast + local-delete offer so it never holds
    // the command pending on the toast.
    void this._offerLocalDeleteAfterRemote(repo, target.tag.name, targetRemote);
  }

  /**
   * Report a remote tag deletion and offer to delete the still-present local
   * tag too. The branch window lists LOCAL tags (`git tag -l`); deleting the
   * remote ref leaves the local one, so the tag keeps showing unchanged and the
   * user thinks the delete failed. Mirror of {@link _offerRemoteDeleteForLocalTags}
   * in the other direction so a tag can be fully removed from either entry point.
   */
  private async _offerLocalDeleteAfterRemote(
    repo: IRepository,
    name: string,
    remote: string
  ): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Deleted remote tag '${name}' from ${remote}. It still exists locally.`,
      'Delete Locally'
    );
    if (choice !== 'Delete Locally') {
      return;
    }
    const deleted = await this._gitService.deleteTag(repo, name).match(
      () => true,
      (error) => {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to delete tag', error)
        );
        return false;
      }
    );
    if (!deleted) {
      return;
    }
    // Tag list changed; reload so the tree drops the tag before the repaint.
    await this._gitService.reloadRepository(repo);
    this._branchTreeProvider.refresh();
    void vscode.window.showInformationMessage(`Deleted tag '${name}' locally`);
  }

  /**
   * Delete one tag on `remote` (`git push <remote> :refs/tags/<name>`). Returns
   * whether it succeeded; a failure is toasted (credentials scrubbed) and
   * swallowed so a batch can continue. Confirmation is the caller's job — the
   * direct command uses a modal, the post-local-delete affordance uses the
   * toast action as the confirm.
   */
  private async _deleteRemoteTag(
    repo: IRepository,
    name: string,
    remote: string
  ): Promise<boolean> {
    try {
      await this._gitService.deleteRemoteTag(repo, name, remote).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to delete remote tag '${name}': ${sanitizeGitError(errorMessage)}`
      );
      return false;
    }
  }

  /**
   * Report a local tag deletion and, when a deleted tag's repo has a remote,
   * offer to delete it there too. A local `git tag -d` never touches the remote
   * and AutoFetch re-imports a tag that still exists on a remote — so without
   * this the tag "comes back" after a delete that reported success. Mirrors
   * IntelliJ's GitDeleteTagOperation, whose success notification carries a
   * "Delete on Remote" action when the repo has remotes
   * (git4idea/backend/src/branch/GitDeleteTagOperation.java).
   */
  private async _offerRemoteDeleteForLocalTags(
    deleted: ReadonlyArray<{ repo: IRepository; name: string }>
  ): Promise<void> {
    if (deleted.length === 0) {
      return;
    }
    const summary =
      deleted.length === 1
        ? `Deleted tag '${deleted[0].name}' locally`
        : `Deleted ${deleted.length} tags locally`;
    if (!deleted.some((d) => d.repo.remotes.length > 0)) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${summary}. ${deleted.length === 1 ? 'It may' : 'They may'} still exist on the remote.`,
      'Delete on Remote'
    );
    if (choice !== 'Delete on Remote') {
      return;
    }
    // Group by repo so a multi-remote repo prompts for its remote only once.
    const byRepo = new Map<string, { repo: IRepository; names: string[] }>();
    for (const d of deleted) {
      const entry = byRepo.get(d.repo.rootUri.fsPath) ?? { repo: d.repo, names: [] };
      entry.names.push(d.name);
      byRepo.set(d.repo.rootUri.fsPath, entry);
    }
    let removed = 0;
    let lastName = '';
    for (const { repo, names } of byRepo.values()) {
      if (repo.remotes.length === 0) {
        continue;
      }
      const remote = await this._chooseTargetRemote(repo);
      if (!remote) {
        continue;
      }
      for (const name of names) {
        if (await this._deleteRemoteTag(repo, name, remote)) {
          removed += 1;
          lastName = name;
        }
      }
    }
    if (removed === 1) {
      void vscode.window.showInformationMessage(`Deleted remote tag '${lastName}'`);
    } else if (removed > 1) {
      void vscode.window.showInformationMessage(`Deleted ${removed} remote tags`);
    }
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new BranchContextMenuCommands instance.
 *
 * @param gitService - The Git service to use
 * @param branchTreeProvider - The branch tree provider
 * @returns A new BranchContextMenuCommands instance
 */
export function createBranchContextMenuCommands(
  gitService: IGitService,
  branchTreeProvider: BranchTreeProvider,
  conflictResolutionService?: IConflictResolutionService,
  pullDialogAccessor?: PullDialogAccessor,
  pushDialogOpener?: PushDialogOpener,
  mergeDialogOpener?: MergeDialogOpener,
  newBranchDialogOpener?: NewBranchDialogOpener,
  rebaseDialogOpener?: RebaseDialogOpener
): BranchContextMenuCommands {
  return new BranchContextMenuCommands(
    gitService,
    branchTreeProvider,
    conflictResolutionService,
    pullDialogAccessor,
    pushDialogOpener,
    mergeDialogOpener,
    newBranchDialogOpener,
    rebaseDialogOpener
  );
}
