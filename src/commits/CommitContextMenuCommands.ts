/**
 * Commit Context Menu Commands implementation.
 * Provides command handlers for commit context menu actions in the Git Graph Panel.
 */

import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { IBranch, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
  REBASE_ROOT,
} from '../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../ui-shell/GitToolWindowProvider';
import { GitCli, revParseVerified } from '../git-core/gitCli';
import { isFirstParentAncestor } from '../git-core/rebaseRange';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { resolveRepo } from '../utils/resolveRepo';
import { sanitizeGitError } from '../git-core/gitError';
import { findBlockingOperation, resolveGitDir } from '../git-core/gitDirMarkers';
import {
  isSelectionContiguous,
  isContiguousFirstParentChain,
  type IMenuStateNode,
} from '../git-core/gitToolWindow/multiSelect';
import type { BranchComparisonView } from '../branches/BranchComparisonView';
import { getLogger } from '../utils/logger';
import { SquashMessageDialog } from './SquashMessageDialog';
import { CommitMessageDialog } from './CommitMessageDialog';
import { CommitDialog } from './CommitDialog';
import { buildSquashRebasePlan } from './squashPlan';
import {
  detectLocalChanges,
  saveLocalChanges,
  restoreLocalChanges,
} from '../git-core/ops/preservedChanges';
import { AUTOSTASH_PARKED_WARNING } from '../git-core/rebaseAutostash';
import { restorePathsToHead, IRestoreToHeadRequest } from '../git-core/worktree/restoreToHead';
import { allHashesValid, STALE_SELECTION_TOAST } from './commitContextMenuShared';
import {
  createPatch,
  createPatchToClipboard,
  type ICommitPatchActionsContext,
} from './commitPatchActions';
import {
  compareWithLocal,
  compareVersions,
  showRepoAtRevision,
  type ICommitCompareActionsContext,
} from './commitCompareActions';
import {
  checkoutRevision,
  resetToHere,
  type ICommitCheckoutResetActionsContext,
} from './commitCheckoutResetActions';
import {
  isCommitPushed,
  isNotOnProtectedBranch,
  anyIsMergeCommit,
  pickMainlineParent,
  isOldestInCurrentBranch,
  isRangeMergeFree,
  type ICommitGuardsContext,
} from './commitActionGuards';
import { undoCommit, type ICommitUndoContext } from './commitUndoActions';
import { handleRevert, type ICommitRevertActionsContext } from './commitRevertActions';
import { copyHash } from './commitClipboardActions';
import { newBranch, newTag, type ICommitRefActionsContext } from './commitRefActions';

/**
 * Signature of the repository resolver injected into
 * {@link CommitContextMenuCommands}. Matches the default
 * `resolveRepo(gitService, context)` but extracted so tests can stub the
 * multi-root disambiguation without a real VS Code host.
 */
export type RepoResolver = (
  gitService: IGitService,
  context: { preferActive?: boolean; silent?: boolean }
) => Promise<IRepository | undefined>;

/**
 * Commit Context Menu Commands class.
 * Registers and handles all commit-related context menu commands from the Graph Panel.
 */
export class CommitContextMenuCommands {
  private _gitService: IGitService;
  private _rebaseService: IRebaseService;
  private _gitToolWindowProvider: GitToolWindowProvider;
  private _gitCli: GitCli;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  private _commitComposer?: { prefillComposerMessage(message: string): void };

  /**
   * Late-bound changelist seam for Undo Commit's target-changelist chooser
   * (IntelliJ GitUncommitAction's ChangeListChooser). Optional — without it
   * the uncommitted changes land in the current default changelist.
   */
  private _changelistService?: {
    getChangelists(repo: IRepository): { id: string; name: string; isDefault?: boolean }[];
    createChangelist(repo: IRepository, name: string): { id: string; name: string };
    moveToChangelist(repo: IRepository, files: string[], changelistId: string): void;
  };
  // late-bound by extension.ts via {@link setRebaseEditorOpener}; opens the
  // interactive-rebase plan editor (RebaseEditor singleton) for a repo onto
  // a base commit.
  private _openRebaseEditor?: (repo: IRepository, onto: string) => Promise<{ executed: boolean }>;
  // late-bound by extension.ts via {@link setBranchComparisonView}
  // because BranchComparisonView is constructed AFTER this commands class
  // in the activate() order. The compareWithBranch handler guards on
  // undefined and surfaces a graceful error toast if the user fires the
  // action before wiring completes.
  private _branchComparisonView: BranchComparisonView | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _context: vscode.ExtensionContext | undefined;
  private readonly _resolveRepo: RepoResolver;
  /**
   * Rendered commit rows for the in-flight {@link _handleAction} dispatch
   * (newest-first), each carrying its own `repoRoot` in the merged
   * "All Repositories" log. Set for the duration of one dispatch and restored
   * afterwards so commit-targeted resolution prefers the row the user clicked
   * over the provider's hash-keyed index — which can only hold one root per
   * hash. Empty for entry points that arrive without rendered rows (palette
   * commands), which then fall back to the index.
   */
  private _dispatchNodes: readonly IMenuStateNode[] = [];

  constructor(
    gitService: IGitService,
    rebaseService: IRebaseService,
    gitToolWindowProvider: GitToolWindowProvider,
    gitCli?: GitCli,
    conflictResolutionService?: IConflictResolutionService,
    repoResolver?: RepoResolver
  ) {
    this._gitService = gitService;
    this._rebaseService = rebaseService;
    this._gitToolWindowProvider = gitToolWindowProvider;
    this._gitCli = gitCli || new GitCli();
    this._conflictResolutionService = conflictResolutionService;
    this._resolveRepo =
      repoResolver ?? ((svc, ctx): Promise<IRepository | undefined> => resolveRepo(svc, ctx));
  }

  /**
   * Late-bind the conflict resolution service (for wiring migration).
   */
  setConflictResolutionService(service: IConflictResolutionService): void {
    this._conflictResolutionService = service;
  }

  /**
   * Late-bind the commit composer so Undo Commit can restore the undone
   * commit's message into the message field (IntelliJ GitUncommitAction).
   */
  setCommitComposer(composer: { prefillComposerMessage(message: string): void }): void {
    this._commitComposer = composer;
  }

  /** Late-bind the changelist service (see {@link _changelistService}). */
  setChangelistService(
    service: NonNullable<CommitContextMenuCommands['_changelistService']>
  ): void {
    this._changelistService = service;
  }

  /**
   * Late-bind the interactive-rebase editor opener. The RebaseEditor
   * singleton lives in extension.ts (created lazily, disposed on
   * deactivate), so the wiring hands us a thunk that opens it for a repo
   * onto a base and resolves with whether the plan was executed. Without it
   * "Interactively Rebase from Here" has no UI to show and refuses.
   */
  setRebaseEditorOpener(
    opener: (repo: IRepository, onto: string) => Promise<{ executed: boolean }>
  ): void {
    this._openRebaseEditor = opener;
  }

  /**
   * late-bind the branch comparison view. Extension.ts
   * constructs `BranchComparisonView` AFTER this class (the panel layer
   * predates the comparison view), so we accept the dependency through a
   * setter rather than the constructor. Idempotent — duplicate calls
   * just rebind the reference.
   */
  setBranchComparisonView(view: BranchComparisonView): void {
    this._branchComparisonView = view;
  }

  /**
   * Open the Resolve Conflicts dialog for conflicts produced by the given op.
   * No-op if the conflict resolution service isn't wired in.
   */
  private async _openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      /**
       * Whether a rebase is still in progress. When `false` (an
       * `--autostash` pop conflict surfaced after the rebase already
       * finished) the continue/abort affordances are suppressed — `git rebase
       * --continue`/`--abort` would dead-end on "no rebase in progress". The
       * drop/squash flows pre-stash, so they never reach the pop-conflict
       * state, but the flag is honored for a uniform safe default. Defaults to
       * `true`.
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
   * Get the rebase service for interactive rebase operations.
   */
  get rebaseService(): IRebaseService {
    return this._rebaseService;
  }

  /**
   * Register the commit context menu command handler.
   *
   * @param context - The VS Code extension context
   */
  register(context: vscode.ExtensionContext): void {
    this._context = context;
    const disposable = this._gitToolWindowProvider.onDidRequestLogContextAction((event) =>
      // commitNodes (the slim
      // IMenuStateNode list, newest-first) threaded through the event
      // payload so multi-commit handlers (cherry-pick, drop, squash,
      // createPatch, compareVersions) don't reach back into the
      // provider for it. ADR-009 inversion fix; collapsed the prior
      // parallel `displayOrder` + `parentCounts` records to this single
      // typed list.
      this._handleAction(event.action, event.commitHashes, event.commitNodes)
    );
    this._disposables.push(disposable);
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Resolve the repository the current action should target.
   *
   * The Git tool window's repo selector dropdown is the source of
   * truth: the user clicked the commit while looking at a specific
   * repo's log, and the action should target THAT repo without
   * prompting again. Previously this routed through
   * `resolveRepo(preferActive: true, silent: true)`, which in a
   * multi-root workspace would surface a "Choose Repository"
   * QuickPick whenever the active editor wasn't inside the
   * Git-tool-window's repo — visible to the user as an unwelcome
   * popup before Edit Commit Message / Squash Commits / etc. ever
   * ran.
   *
   * Order of preference:
   *   1. Git-tool-window's selected repo (the dropdown the user
   *      most recently set; matches the log they're staring at).
   *   2. `resolveRepo(preferActive)` fallback for callers without
   *      a tool-window provider wired up (palette commands, scripted
   *      entries, tests).
   */
  private async _getRepository(): Promise<IRepository | undefined> {
    // Defensive: a few legacy test harnesses construct partial provider
    // stubs that omit `getSelectedRepository`. Use the dropdown's
    // selected repo when the method exists; otherwise fall through to
    // the resolveRepo fallback so those callers keep working.
    const maybeGetSelected = (
      this._gitToolWindowProvider as unknown as {
        getSelectedRepository?: () => IRepository | undefined;
      }
    ).getSelectedRepository;
    if (typeof maybeGetSelected === 'function') {
      const selected = maybeGetSelected.call(this._gitToolWindowProvider);
      if (selected) {
        return selected;
      }
    }
    return this._resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
  }

  /**
   * Resolve the repository a CLICKED commit belongs to.
   *
   * In the merged "All Repositories" scope the log interleaves commits from
   * every root, so the dropdown's selected repo ({@link _getRepository}) is
   * the context repo — NOT necessarily the clicked commit's owner. The
   * provider records each commit's source root in a hash→root index
   * (`getRepoRootForCommit`); when a root is recorded we resolve THAT repo so
   * the op targets the commit's own repo. This mirrors `resolveCommitRepoByRoot`
   * in `registration/wiring.ts`, which already fixed the commit select / diff
   * handlers.
   *
   * Falls back to {@link _getRepository} (the selected/context repo) when:
   *   - no hash is supplied (programmatic callers without a clicked commit),
   *   - no root is recorded (single-repo / specific-scope log), or
   *   - the recorded root no longer resolves to an open repo.
   *
   * The provider surface is read structurally + guarded so legacy test stubs
   * that omit `getRepoRootForCommit` keep working (same defensive shape as
   * `_getRepository`'s `getSelectedRepository` probe).
   */
  private async _getRepositoryForCommit(hash?: string): Promise<IRepository | undefined> {
    if (hash) {
      const root = this._recordedRepoRoot(hash);
      if (root) {
        const repo = await this._gitService.getRepository(vscode.Uri.file(root));
        if (repo) {
          return repo;
        }
      }
    }
    return this._getRepository();
  }

  /**
   * Source repository root for `hash` in the merged "all roots" log, or
   * `undefined` when none is known (single-repo / specific-scope, or the
   * provider stub omits the index).
   *
   * Prefers the repoRoot carried on the CLICKED row in the current dispatch:
   * the row reflects exactly what the user sees, so a hash shared across roots
   * resolves to the repo whose row was clicked. Only when no row carries a
   * root (palette entry points, or a single-repo log) do we fall back to the
   * provider's hash-keyed index, which is last-writer-wins for a shared hash.
   *
   * Residual: if two rendered rows share the hash, the first in display order
   * wins — the webview posts the hash, not a row identity, so the host can't
   * distinguish two same-hash rows. This matches display order and is no worse
   * than the index it replaces.
   */
  private _recordedRepoRoot(hash: string): string | undefined {
    const row = this._dispatchNodes.find((n) => n.hash === hash);
    if (row?.repoRoot) {
      return row.repoRoot;
    }
    const maybeGetRoot = (
      this._gitToolWindowProvider as unknown as {
        getRepoRootForCommit?: (hash: string) => string | undefined;
      }
    ).getRepoRootForCommit;
    if (typeof maybeGetRoot !== 'function') {
      return undefined;
    }
    return maybeGetRoot.call(this._gitToolWindowProvider, hash);
  }

  /**
   * Guard a multi-commit action against a selection that spans more than one
   * source repository in the merged "all roots" log. Acting on such a
   * selection would replay / rewrite foreign-repo hashes against a single
   * resolved repo, so we refuse with a clear toast rather than guess.
   *
   * Cheap + non-intrusive: only the merged scope records roots, and only a
   * multi-commit selection can straddle repos. Returns `false` (not blocked)
   * for single-commit selections and for single-repo / specific-scope logs
   * where no roots are recorded — leaving those paths unchanged.
   */
  private _isCrossRepoSelection(commitHashes: readonly string[]): boolean {
    if (commitHashes.length < 2) {
      return false;
    }
    const roots = new Set<string>();
    for (const h of commitHashes) {
      const root = this._recordedRepoRoot(h);
      if (root) {
        roots.add(root);
      }
    }
    if (roots.size > 1) {
      void vscode.window.showWarningMessage(
        'This action spans commits from multiple repositories. Select commits from a single repository and try again.'
      );
      return true;
    }
    return false;
  }

  /**
   * Dispatch the action to the appropriate handler method.
   *
   * `commitNodes` is the slim
   * newest-first commit-node list supplied by the dispatcher
   * (`GitToolWindowProvider._handleCommitContextMenu`). Multi-commit
   * handlers (cherry-pick, drop, squash, createPatch, compareVersions)
   * consume it to compute oldest-first replay order / contiguity /
   * parent lookups WITHOUT reaching back into the provider via
   * `getExtendedLogState()`. ADR-009 inversion fix: handlers receive
   * everything they need on the event payload.
   *
   * Collapsed the prior `displayOrder` + `parentCounts` parallel
   * records to this single `IMenuStateNode[]` shape — same data, one
   * lookup, one test fixture.
   *
   * Single-commit handlers ignore the parameter — they only need the
   * one hash. Defensive default `[]` lets external callers (palette
   * commands, scripted entry points) invoke the handler chain without
   * having to fabricate the list; those callers shouldn't exercise the
   * multi-commit branches anyway. The multi-commit handlers' in-order
   * checks then reject every hash for an empty `commitNodes`, surfacing
   * the stale-selection toast — see ADR-009 section 6.
   */
  async _handleAction(
    action: LogContextAction,
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    // Expose the rendered rows to repo resolution for this dispatch only, then
    // restore the prior value — so the clicked row's own repoRoot wins over the
    // provider's hash-keyed (last-writer-wins) index. Save/restore rather than
    // clear keeps a nested/concurrent dispatch from blanking an outer one.
    const previousDispatchNodes = this._dispatchNodes;
    this._dispatchNodes = commitNodes;
    try {
      await this._dispatchAction(action, commitHashes, commitNodes);
    } finally {
      this._dispatchNodes = previousDispatchNodes;
    }
  }

  private async _dispatchAction(
    action: LogContextAction,
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[]
  ): Promise<void> {
    // Central hash validation. Every action below operates on the selected
    // commit hashes; reject a dispatch carrying a non-hex hash before it
    // reaches any handler, so a palette / scripted entry can't feed
    // unvalidated input downstream (the argv `--end-of-options` discipline
    // is the deeper guard; this is the early, uniform rejection). The webview
    // no-op actions carry no hash payload, so an empty list is allowed.
    // `allHashesValid([])` is vacuously true; per-handler empty-selection
    // guards still apply.
    if (action !== 'goToParent' && action !== 'goToChild' && !allHashesValid(commitHashes)) {
      return;
    }

    switch (action) {
      case 'copyHash':
        await this._handleCopyHash(commitHashes);
        break;
      case 'cherryPick':
        await this._handleCherryPick(commitHashes);
        break;
      case 'revert':
        await this._handleRevert(commitHashes);
        break;
      case 'checkoutRevision':
        await this._handleCheckoutRevision(commitHashes);
        break;
      case 'resetToHere':
        await this._handleResetToHere(commitHashes);
        break;
      case 'createPatch':
        await this._handleCreatePatch(commitHashes, commitNodes);
        break;
      case 'createPatchToClipboard':
        await this._handleCreatePatchToClipboard(commitHashes, commitNodes);
        break;
      case 'showRepoAtRevision':
        await this._handleShowRepoAtRevision(commitHashes);
        break;
      case 'compareWithLocal':
        await this._handleCompareWithLocal(commitHashes);
        break;
      case 'undoCommit':
        await this._handleUndoCommit(commitHashes);
        break;
      case 'dropCommit':
        // `_handleDropCommit` internally routes N>=2 to
        // `_handleDropCommitMulti`. Keeping a single dispatcher arm
        // preserves the dispatch-property invariant (one handler per
        // action) while still landing the multi-commit semantics.
        await this._handleDropCommit(commitHashes, commitNodes);
        break;
      case 'editCommitMessage':
        await this._handleEditCommitMessage(commitHashes);
        break;
      case 'interactiveRebase':
        await this._handleInteractiveRebase(commitHashes);
        break;
      case 'squashCommits':
        // Gated to N>=2 contiguous non-merge by 's
        // `computeMenuEnableState`; defence-in-depth at handler entry.
        await this._handleSquashCommits(commitHashes, commitNodes);
        break;
      case 'compareVersions':
        await this._handleCompareVersions(commitHashes, commitNodes);
        break;
      // IntelliJ Git.Fixup.To.Commit / Git.Squash.Into.Commit: commit the
      // currently-staged changes as a fixup!/squash! of the selected commit.
      case 'fixup':
        await this._handleCommitFixup(commitHashes, 'fixup');
        break;
      case 'squashInto':
        await this._handleCommitFixup(commitHashes, 'squash');
        break;
      // Open the Compare-with-Branch picker (local
      // remote + tags) and route through BranchComparisonView.
      case 'compareWithBranch':
        await this._handleCompareWithBranch(commitHashes);
        break;
      // IntelliJ Git.PushUpToHere: delegate to the registered command with
      // the single selected commit hash. The command owns repo resolution +
      // refspec construction so that the same logic is exercised whether the
      // user reaches it from the context menu or the palette.
      case 'pushUpToCommit':
        await this._handlePushUpToCommit(commitHashes);
        break;
      // IntelliJ Git.CreateNewBranch.FromCommit / Git.CreateNewTag: delegate
      // to the registered commands so the New Branch dialog / New Tag flow is
      // the single source of truth whether reached from the menu or palette.
      case 'newBranch':
        await this._handleNewBranch(commitHashes);
        break;
      case 'newTag':
        await this._handleNewTag(commitHashes);
        break;
      // G9: goToParent / goToChild are handled entirely in the webview JS
      // (jumpToCommitHash). The host never receives these actions — the webview
      // intercepts them before calling postMessage. These stubs prevent the
      // structural guard in multiSelectR1.test.ts from failing should the
      // message arrive in a code path we don't control.
      case 'goToParent':
      case 'goToChild':
        break;
      default:
        // Unknown action — no-op
        break;
    }
  }

  /**
   * Public entry point invoked by the `intellig.commit.dropSelectedChanges`
   * palette command. Surfaced on the class (rather than through the
   * webview-dispatcher event) because the LogContextAction union lives in
   * `gitToolWindow/`.
   *
   * Rewrites the HEAD commit to remove the user-selected files. Refuses
   * on pushed commits or on non-HEAD ancestors. Single destructive-op
   * confirm per the safety policy.
   */
  async dropSelectedChangesFromCommit(hash: string): Promise<void> {
    // Defense-in-depth hex validation before any git work. The HEAD===hash
    // rev-parse gate downstream already rejects a non-hex hash (it can't match
    // a real commit), but mirror the central guard every other dispatched
    // commit action runs so this entry point isn't an exception.
    if (!hash || !allHashesValid([hash])) {
      return;
    }
    const repo = await this._getRepositoryForCommit(hash);
    if (!repo) {
      return;
    }
    await this._handleDropSelectedChanges(repo, hash);
  }

  /**
   * Implementation for Drop Selected Changes. See
   * {@link dropSelectedChangesFromCommit}.
   */
  private async _handleDropSelectedChanges(repo: IRepository, hash: string): Promise<void> {
    const cwd = repo.rootUri.fsPath;
    const shortHash = hash.substring(0, 8);

    // 1. HEAD probe — selects the strategy, not a gate: HEAD rewrites via
    //    the soft-reset + re-commit fast path (no rebase); any other commit
    //    rides the history-rewrite runner with an `edit` pause (reference:
    //    the rebase-based GitDropSelectedChangesOperation works on ANY
    //    commit).
    let isHead = false;
    try {
      const headResult = await this._gitCli.exec(['rev-parse', 'HEAD'], { cwd });
      if (headResult.exitCode === 0) {
        isHead = headResult.stdout.trim() === hash;
      }
    } catch (error) {
      // Treat unknown state as "not HEAD" — the rebase path handles any
      // commit. Log the probe fault so it stays visible.
      getLogger()
        .child({ component: 'CommitContextMenuCommands' })
        .debug('dropSelectedChanges: HEAD probe failed', {
          err: error instanceof Error ? error.message : String(error),
        });
    }

    // 2. Safety: refuse while a rebase/sequencer is live (IntelliJ Prohibit
    //    policy) — a soft-reset mid-rebase corrupts the detached-HEAD state.
    if (!(await this._isNoOperationInProgress(repo, 'Drop selected changes'))) {
      return;
    }

    // 2b. Safety: refuse on commits published to a protected branch. (The
    //    reference blocks the protected list only — findProtectedRemoteBranch
    //    — not pushed-anywhere; unprotected published history stays editable.)
    if (!(await this._isNotOnProtectedBranch(cwd, hash, 'Drop Selected Changes'))) {
      return;
    }

    // 3. Safety: refuse on merge commits. A merge commit has two parents; the
    //    soft-reset + re-commit path records only the first parent, silently
    //    discarding the merge relationship with no warning. Mirror the guard
    //    that the regular Drop handler uses for the same reason.
    if (await this._anyIsMergeCommit(repo, [hash]).catch(() => false)) {
      void vscode.window.showErrorMessage(
        `${shortHash} is a merge commit. Drop Selected Changes cannot run on a merge — ` +
          `use Reset to a non-merge ancestor instead.`
      );
      return;
    }

    // 3b. Non-HEAD rides a `hash~1..HEAD` rebase — same containment
    //     requirement as every other history-rewriting flow.
    if (!isHead && !(await this._isOldestInCurrentBranch(repo, hash))) {
      return;
    }

    // 4. File picker — user selects files to DROP.
    let diffs;
    try {
      diffs = await this._gitService.getCommitDiff(repo, hash);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to list files for ${shortHash}: ${sanitizeGitError(msg)}`
      );
      return;
    }
    if (!diffs || diffs.length === 0) {
      void vscode.window.showInformationMessage(`Commit ${shortHash} has no files to drop.`);
      return;
    }

    const pickItems = diffs.map((d) => ({
      label: d.path,
      description: d.status,
      path: d.path,
    }));
    const dropPicks = await vscode.window.showQuickPick(pickItems, {
      title: `Drop changes from ${shortHash} — select files to remove`,
      placeHolder: 'These files will be excluded from the commit',
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!dropPicks || dropPicks.length === 0) {
      return;
    }

    // 4a. All-files selection removes the whole commit — the arm the
    //     reference DISABLES (GitDropSelectedChangesAction: "use Drop
    //     Commit"). Refuse with the same redirect.
    if (dropPicks.length === diffs.length) {
      void vscode.window.showErrorMessage(
        `Dropping every file removes commit ${shortHash} entirely — use Drop Commit instead.`
      );
      return;
    }

    // 4b. Single destructive-op confirm (safety policy).
    const confirm = await vscode.window.showWarningMessage(
      `Drop ${dropPicks.length} file(s) from commit ${shortHash}? This rewrites history.`,
      { modal: true },
      'Drop',
      'Cancel'
    );
    if (confirm !== 'Drop') {
      return;
    }

    const droppedPaths = dropPicks.map((p) => p.path);
    const diffByPath = new Map(diffs.map((d) => [d.path, d]));

    // Non-HEAD: ride the shared runner with an edit-pause rewrite; the fast
    // path below is HEAD-only (soft reset needs HEAD to be the target).
    if (!isHead) {
      await this._dropSelectedChangesViaRebase(repo, hash, droppedPaths, diffByPath);
      return;
    }

    // Map each dropped file to a restore-to-HEAD request for the shared
    // writer (which owns the added/renamed/tracked partition): an ADDED file
    // has no parent blob (unindex, keep on disk as untracked); a RENAMED or
    // COPIED file's new path is likewise absent from the parent while its
    // source is what gets restored; modified/deleted restore in place. At
    // apply time HEAD IS the parent (post soft-reset), so `inHead` is decided
    // against the parent tree.
    const restoreRequests: IRestoreToHeadRequest[] = droppedPaths.map((p) => {
      const diff = diffByPath.get(p);
      const status = diff?.status;
      if (status === 'added') {
        return { path: p, inHead: false };
      }
      if (status === 'renamed' || status === 'copied') {
        return { path: p, oldPath: diff?.oldPath, inHead: false };
      }
      return { path: p, inHead: true };
    });
    const addedDropped = droppedPaths.filter((p) => {
      const st = diffByPath.get(p)?.status;
      return st === 'added' || st === 'renamed' || st === 'copied';
    });

    // 4b. Save local changes around the rewrite (shared bracket — same
    //     discipline as the drop/squash rebase flows). Without it,
    //     `reset --soft HEAD^` merges the user's STAGED work into the index
    //     and `commit -C` silently absorbs it into the rewritten commit, and
    //     `checkout HEAD -- <dropped>` clobbers uncommitted edits to a
    //     dropped file.
    const saved = await saveLocalChanges(
      this._gitCli,
      cwd,
      'Auto-stash before drop selected changes'
    );
    if (saved.status === 'blocked-unmerged') {
      void vscode.window.showErrorMessage(
        'Cannot drop selected changes while you have unmerged files. Resolve the conflicts first.'
      );
      return;
    }
    const restoreSavedChanges = async (): Promise<void> => {
      if (saved.status !== 'saved') {
        return;
      }
      const restore = await restoreLocalChanges(this._gitCli, cwd, saved.stashSha);
      if (restore.status === 'failed') {
        void vscode.window.showWarningMessage(
          `Drop finished, but restoring your stashed local changes failed: ${restore.detail}. ` +
            `They remain in the stash list.`
        );
      }
    };

    // 5. Rewrite HEAD.
    //    Strategy (safer than interactive rebase for HEAD-only):
    //      a. git reset --soft HEAD^   (uncommit, keep index + working tree intact)
    //      b. for each dropped ADDED file: git rm --cached -- <path>
    //         (the file was newly introduced — the parent doesn't have it, so
    //         checkout would fail; rm --cached removes the staged copy only)
    //      c. for each other dropped file: git checkout HEAD -- <path>
    //         (at this point HEAD is the parent; restore parent's content
    //         in both index and working tree)
    //      d. if any files were kept, re-commit as `git commit -C <hash>`.
    //         If all files were dropped, HEAD is already at the parent.
    //    Rollback: if anything fails after the soft-reset un-commits HEAD,
    //    restore the original commit via `git reset --soft <hash>` so the
    //    repo is never left in a half-rewritten state.
    try {
      await this._gitCli.exec(['reset', '--soft', 'HEAD^'], { cwd, throwOnError: true });

      try {
        await restorePathsToHead(this._gitCli, cwd, restoreRequests);

        // `git rm --cached` removes newly-added files from the index but leaves
        // them as untracked files on disk. Clarify this in the success toast so
        // the user isn't surprised to find the file still in their working tree.
        const untrackedNote =
          addedDropped.length > 0
            ? `; ${addedDropped.length} file(s) new in this commit remain on disk as untracked: ${addedDropped.join(', ')}`
            : '';

        // Re-commit with original author + message from the saved hash. At
        // least one file is always kept — the all-files selection was
        // refused above (Drop Commit's job).
        await this._gitCli.exec(['commit', '-C', hash], { cwd, throwOnError: true });
        void vscode.window.showInformationMessage(
          `Dropped ${droppedPaths.length} file(s) from ${shortHash}${untrackedNote}`
        );
      } catch (innerError) {
        // Something failed after the soft-reset removed the commit from HEAD.
        // Restore the original commit pointer (best-effort). Note: soft-reset
        // only moves the branch ref — the index/worktree may still reflect
        // partial side-effects from rm --cached / checkout. Tell the user to
        // inspect git status rather than silently leaving them confused.
        await this._gitCli.exec(['reset', '--soft', hash], { cwd });
        await restoreSavedChanges();
        const msg = innerError instanceof Error ? innerError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to drop changes: ${sanitizeGitError(msg)}. Original commit restored; check \`git status\` for any partially-applied changes.`
        );
        // Reload so the panel reflects the restored HEAD — the toast already
        // fired, so a reload failure must not mask it.
        try {
          await this._gitService.reloadRepository(repo);
          this._gitToolWindowProvider.refresh();
        } catch (reloadErr) {
          // Non-fatal: the error toast already fired. Log so it stays visible.
          getLogger()
            .child({ component: 'CommitContextMenuCommands' })
            .debug('dropSelectedChanges: reload after rollback failed', {
              err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
            });
        }
        return;
      }

      await restoreSavedChanges();

      // Synchronously reload before refresh so panel sees fresh
      // `repo.head.commit` (history rewrite moved HEAD).
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      // The initial soft-reset itself failed — HEAD is untouched; still put
      // the user's saved changes back.
      await restoreSavedChanges();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to drop changes: ${sanitizeGitError(msg)}`);
    }
  }

  /**
   * Drop selected files from a NON-HEAD commit by riding the shared
   * history-rewrite runner: the target pauses at an `edit` step (HEAD is
   * then the target itself), the dropped changes are unwound in place —
   * paths the commit ADDED are removed (index + worktree, so descendant
   * replays that re-touch them apply cleanly), everything else restores
   * from the parent (`HEAD^`, always present there) — the commit is amended
   * preserving its message + author, and the rebase continues. Descendant
   * replays that conflict pause into the resolve dialog like every other
   * runner flow. Reference: the rebase-based
   * GitDropSelectedChangesOperation (git4idea
   * rebase/log/changes/GitDropSelectedChangesAction.kt).
   */
  private async _dropSelectedChangesViaRebase(
    repo: IRepository,
    hash: string,
    droppedPaths: string[],
    diffByPath: Map<string, { status: string; oldPath?: string }>
  ): Promise<void> {
    const cwd = repo.rootUri.fsPath;
    const shortHash = hash.substring(0, 8);
    try {
      await this._runHistoryRewrite(repo, {
        onto: `${hash}~1`,
        oldest: hash,
        opLabel: 'Drop selected changes',
        target: 'drop',
        successToast: `Dropped ${droppedPaths.length} file(s) from ${shortHash}`,
        buildPlan: (session) => {
          const targetCommit = session.commits.find(
            (c) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
          );
          if (!targetCommit) {
            void vscode.window.showErrorMessage(`Commit ${shortHash} not found in rebase session.`);
            return 'stale';
          }
          return session.commits.map((c) =>
            c.hash === targetCommit.hash
              ? { hash: c.hash, action: 'edit' as const }
              : { hash: c.hash, action: c.action }
          );
        },
        drivePaused: async (first) => {
          if (!(first.success && first.status === 'paused')) {
            // Conflict / cleared-stale before the edit step — the runner's
            // outcome switch owns it.
            return first;
          }
          for (const p of droppedPaths) {
            const diff = diffByPath.get(p);
            const status = diff?.status;
            if (status === 'added' || status === 'renamed' || status === 'copied') {
              await this._gitCli.exec(['rm', '-f', '--', p], { cwd, throwOnError: true });
              if ((status === 'renamed' || status === 'copied') && diff?.oldPath) {
                await this._gitCli.exec(['checkout', 'HEAD^', '--', diff.oldPath], {
                  cwd,
                  throwOnError: true,
                });
              }
            } else {
              await this._gitCli.exec(['checkout', 'HEAD^', '--', p], {
                cwd,
                throwOnError: true,
              });
            }
          }
          await this._gitCli.exec(['commit', '--amend', '-C', 'HEAD'], {
            cwd,
            throwOnError: true,
          });
          return this._rebaseService.continueRebase(repo);
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to drop changes from ${shortHash}: ${sanitizeGitError(errorMessage)}. ` +
          `A rebase may be paused — use the Rebase Progress panel to continue or abort.`
      );
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    }
  }

  private _isCommitPushed(
    cwd: string,
    hash: string,
    probeFailureMeansPushed?: boolean
  ): Promise<boolean> {
    return isCommitPushed(this._guardsContext(), cwd, hash, probeFailureMeansPushed);
  }

  private _isNotOnProtectedBranch(cwd: string, hash: string, opLabel: string): Promise<boolean> {
    return isNotOnProtectedBranch(this._guardsContext(), cwd, hash, opLabel);
  }

  private _guardsContext(): ICommitGuardsContext {
    return {
      gitService: this._gitService,
      gitCli: this._gitCli,
      readProtectedBranches: () => this._readProtectedBranches(),
    };
  }

  /** Copy the full SHA(s) to the system clipboard. */
  private _handleCopyHash(commitHashes: string[]): Promise<void> {
    return copyHash(commitHashes);
  }

  /**
   * Cherry-pick the selected commit(s) onto the current branch.
   *
   * `commitHashes` arrives in NEWEST-FIRST order (the
   * webview sends DOM order from `.commit-row.selected`). For a
   * cherry-pick, that's the wrong direction: replaying newest-first
   * destroys authored ordering on the target branch. The
   * WARNING on `getSelectedCommits()` covers this contract: chronological-
   * replay consumers MUST `.reverse()`. We do it here so the `gitService`
   * call site is the canonical "this is the order git will see" point.
   *
   * Reversing also normalizes single-commit behavior — `[h]` reversed
   * is still `[h]`, no change.
   */
  private async _handleCherryPick(commitHashes: string[]): Promise<void> {
    if (this._isCrossRepoSelection(commitHashes)) {
      return;
    }
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo || commitHashes.length === 0) {
      return;
    }

    // Display order (newest-first) → replay order
    // (oldest-first). Slice first so we don't mutate the caller's array.
    const replayOrder = [...commitHashes].reverse();

    try {
      // Detect merge commits: a merge needs `-m <parent>` so git knows which
      // parent line is the mainline. Prompt for the parent (parent 1 = default
      // mainline). If the probe fails (e.g. network/bad hash), fall back to no
      // mainline — git will surface its own "is a merge" error in that edge case.
      const hasMerge = await this._anyIsMergeCommit(repo, replayOrder).catch(() => false);
      let cherryOptions: { mainline?: number; addCherryPickedFrom?: boolean } | undefined;
      if (hasMerge) {
        const picked = await this._pickMainlineParent(repo, replayOrder);
        if (picked.cancelled) {
          return;
        }
        cherryOptions = { mainline: picked.mainline };
      }

      // "(cherry picked from commit <hash>)" suffix for published commits —
      // IntelliJ applies `-x` per commit when the setting is on and the commit
      // is published (CherryPickProcess.kt shouldAddSuffix). Our single git
      // invocation annotates all-or-none, so require EVERY picked commit to be
      // published: the newest picked commit publishes its ancestors, but a
      // multi-select need not be one chain, so probe each.
      if (readConfig('addCherryPickedFromSuffix')) {
        const cwd = repo.rootUri.fsPath;
        let allPublished = true;
        for (const h of replayOrder) {
          if (!(await this._isCommitPushed(cwd, h, /* probeFailureMeansPushed */ false))) {
            allPublished = false;
            break;
          }
        }
        if (allPublished) {
          cherryOptions = { ...cherryOptions, addCherryPickedFrom: true };
        }
      }

      const result = await this._gitService.cherryPick(repo, replayOrder, cherryOptions).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked ${commitHashes.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open the Resolve Conflicts dialog. Falls back to the legacy
        // toast if conflictResolutionService isn't wired yet.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'cherryPick',
            target: commitHashes[0].substring(0, 8),
          });
        } else {
          const choice = await vscode.window.showWarningMessage(
            `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`,
            'Open Conflicts',
            'Abort Cherry-Pick'
          );
          if (choice === 'Open Conflicts') {
            for (const filePath of result.conflicts) {
              const fileUri = vscode.Uri.joinPath(repo.rootUri, filePath);
              await vscode.commands.executeCommand('vscode.open', fileUri);
            }
          } else if (choice === 'Abort Cherry-Pick') {
            try {
              await this._gitService.cherryPickAbort(repo).match(
                () => undefined,
                (e) => {
                  throw e;
                }
              );
              void vscode.window.showInformationMessage('Cherry-pick aborted.');
            } catch (abortError) {
              const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
              void vscode.window.showErrorMessage(
                `Failed to abort cherry-pick: ${sanitizeGitError(abortMsg)}`
              );
            }
          }
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
      }
      // Synchronously reload before refresh so panel sees fresh
      // `repo.head.commit` after the cherry-pick.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Open an editor for the squash commit
   * message and resolve when the user saves or closes it.
   *
   * Previously used `vscode.window.showInputBox`, which is a single-line
   * affordance that renders multi-line seeds with literal `\n`
   * characters — a real UX bug for any squash spanning a commit with a
   * body. Switches to an editor opened on a tempfile inside
   * `os.tmpdir()` so:
   *   - multi-line editing is natural (no `\n` literals).
   *   - language `'git-commit'` triggers VS Code's commit-message
   *     syntax highlighting (subject vs body).
   *   - the URI has a backing file path, so `Cmd/Ctrl-S` lands silently
   *     (no "Save As" dialog like an untitled doc would surface).
   *
   * Resolution contract:
   *   - Save → resolve with the saved text.
   *   - Close without save → resolve `undefined` (cancel).
   *   - Save with empty / whitespace-only content
   *     is treated as cancel: returning `undefined` rather than
   *     re-opening or toasting an error matches IntelliJ's "user
   *     changed their mind" semantics.
   *
   * After resolution the helper closes the editor and best-effort
   * deletes the tempfile so the user doesn't see stale artifacts.
   */
  private async _promptForMessageInEditor(
    seedMessage: string,
    opts: { tmpInfix: string; opName: string; fallbackPrompt: string }
  ): Promise<string | undefined> {
    // Build the tempfile path. The `.git/COMMIT_EDITMSG`-style suffix
    // makes some VS Code installs apply git-commit highlighting
    // automatically.
    //
    // Append 8 random hex chars to the name so two
    // dialogs opened in the same millisecond on the same PID
    // (background flow + user re-trigger) don't collide on the
    // tempfile path.
    const tmpDir = os.tmpdir();
    const rand = crypto.randomBytes(4).toString('hex');
    const tmpPath = path.join(
      tmpDir,
      `intellig-${opts.tmpInfix}-${process.pid}-${Date.now()}-${rand}-COMMIT_EDITMSG`
    );

    // Pre-write the seed so the editor opens with content already on
    // disk — saves a `setText` step and keeps the file content in sync
    // with what the user sees on first frame.
    try {
      fs.writeFileSync(tmpPath, seedMessage, { encoding: 'utf8' });
    } catch {
      // Degraded fallback now surfaces a heads-up
      // toast so the user knows the multi-line editor was attempted.
      void vscode.window.showInformationMessage(
        'Multi-line message editor unavailable; using single-line fallback.'
      );
      return this._messageInputBoxFallback(seedMessage, opts.fallbackPrompt);
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    } catch {
      // Same fallback as above — VS Code refused to open the tempfile.
      try {
        fs.unlinkSync(tmpPath);
        // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a temp file; a stale temp file is harmless and there is no recovery worth surfacing.
      } catch {
        // ignore
      }
      void vscode.window.showInformationMessage(
        'Multi-line message editor unavailable; using single-line fallback.'
      );
      return this._messageInputBoxFallback(seedMessage, opts.fallbackPrompt);
    }

    // Open beside the active column so the message
    // editor doesn't cover the log the user was looking at.
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });

    const expectedFsPath = document.uri.fsPath;

    const message = await new Promise<string | undefined>((resolve) => {
      let resolved = false;
      const disposables: vscode.Disposable[] = [];

      const finish = (value: string | undefined): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        for (const d of disposables) {
          d.dispose();
        }
        resolve(value);
      };

      disposables.push(
        vscode.workspace.onDidSaveTextDocument((saved) => {
          if (saved.uri.toString() === document.uri.toString()) {
            finish(saved.getText());
            return;
          }
          // Save-As silent abort. When the user
          // hits Save-As, VS Code fires `onDidSaveTextDocument` with
          // the NEW URI (not the original tempfile's URI). The matching
          // close event fires for the original — without this branch
          // we'd treat it as cancel and the user's edited message
          // disappears. Detect and surface a clarifying toast instead.
          if (saved.uri.fsPath !== expectedFsPath) {
            void vscode.window.showWarningMessage(
              `${opts.opName} cancelled — message was saved to ${saved.uri.fsPath} instead of being applied. Re-run ${opts.opName} if you want to use that text.`
            );
            finish(undefined);
          }
        })
      );
      disposables.push(
        vscode.workspace.onDidCloseTextDocument((closed) => {
          if (closed.uri.toString() === document.uri.toString()) {
            // close-without-save = cancel.
            finish(undefined);
          }
        })
      );
    });

    // Best-effort cleanup.: closing the active
    // editor is a footgun when focus has shifted — it would close
    // whatever the user moved on to. Use the tab API to target the
    // message tab specifically; falls through gracefully when the tab
    // is already gone (e.g. user closed it manually).
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      const messageTab = tabs.find(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.toString() === document.uri.toString()
      );
      if (messageTab) {
        await vscode.window.tabGroups.close(messageTab);
      }
      // eslint-disable-next-line no-restricted-syntax -- closing an already-closed tab throws; that is the expected outcome here, nothing to recover.
    } catch {
      // Tab already gone — fine.
    }
    try {
      fs.unlinkSync(tmpPath);
      // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a temp file; a stale temp file is harmless and there is no recovery worth surfacing.
    } catch {
      // ignore
    }

    if (message === undefined) {
      return undefined;
    }
    if (message.trim().length === 0) {
      // Empty save = cancel. User changed their mind
      // mid-edit; treat that as a cancel rather than an error toast.
      return undefined;
    }
    return message;
  }

  /**
   * single-line `showInputBox` fallback for
   * `_promptForMessageInEditor`. Extracted so the two failure sites
   * (tempfile write fail, openTextDocument fail) share one implementation.
   * The caller is expected to surface the heads-up info toast before
   * delegating here. Note this fallback is inherently single-line — a
   * multi-line body cannot be entered here; it is only reached when the
   * tempfile editor itself is unavailable.
   */
  private async _messageInputBoxFallback(
    seedMessage: string,
    prompt: string
  ): Promise<string | undefined> {
    const fallback = await vscode.window.showInputBox({
      value: seedMessage,
      prompt,
      ignoreFocusOut: true,
      valueSelection: [0, 0],
    });
    if (fallback === undefined || fallback.trim().length === 0) {
      return undefined;
    }
    return fallback;
  }

  /**
   * Revert the selected commit(s).
   *
   * When a single commit is passed AND it touches more than one file,
   * show a multi-select QuickPick so the user can deselect files
   * to exclude from the revert. Default = all files selected. If the
   * user keeps everything (or only one file was in the commit), the
   * flow falls through to the normal `gitService.revert` path exactly
   * as before. If files are deselected, we use the `git revert -n`
   * plumbing:
   *   1. `git revert -n <hash>` — stage the full revert without committing.
   *   2. `git checkout HEAD -- <excluded files>` — undo the staged revert
   *      for the files the user wants to keep reverted-of.
   *   3. `git commit -m "Revert \"<subject>\""` — finalize the partial revert.
   *
   * Multi-commit reverts always run the full-commit flow (no deselection).
   */
  private _handleRevert(commitHashes: string[]): Promise<void> {
    return handleRevert(this._revertActionsContext(), commitHashes);
  }

  private _revertActionsContext(): ICommitRevertActionsContext {
    return {
      gitService: this._gitService,
      gitCli: this._gitCli,
      gitToolWindowProvider: this._gitToolWindowProvider,
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
      isCrossRepoSelection: (commitHashes) => this._isCrossRepoSelection(commitHashes),
      anyIsMergeCommit: (repo, hashes) => this._anyIsMergeCommit(repo, hashes),
      pickMainlineParent: (repo, hashes) => this._pickMainlineParent(repo, hashes),
      handleRevertConflicts: (repo, conflicts, commitHashes) =>
        this._handleRevertConflicts(repo, conflicts, commitHashes),
    };
  }

  private _anyIsMergeCommit(repo: IRepository, hashes: string[]): Promise<boolean> {
    return anyIsMergeCommit(this._guardsContext(), repo, hashes);
  }

  private _pickMainlineParent(
    repo: IRepository,
    hashes: string[]
  ): Promise<{ cancelled: false; mainline: number } | { cancelled: true }> {
    return pickMainlineParent(this._guardsContext(), repo, hashes);
  }

  /** Shared conflict-resolution UX for both revert paths. */
  private async _handleRevertConflicts(
    repo: IRepository,
    conflicts: string[],
    commitHashes: string[]
  ): Promise<void> {
    if (this._conflictResolutionService) {
      await this._openResolveConflictsDialog(repo, conflicts, {
        operation: 'revert',
        target: commitHashes[0].substring(0, 8),
      });
    } else {
      const choice = await vscode.window.showWarningMessage(
        `Revert conflicts in ${conflicts.length} file(s). Please resolve conflicts.`,
        'Open Conflicts',
        'Abort Revert'
      );
      if (choice === 'Open Conflicts') {
        for (const filePath of conflicts) {
          const fileUri = vscode.Uri.joinPath(repo.rootUri, filePath);
          await vscode.commands.executeCommand('vscode.open', fileUri);
        }
      } else if (choice === 'Abort Revert') {
        try {
          await this._gitService.revertAbort(repo).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          void vscode.window.showInformationMessage('Revert aborted.');
        } catch (abortError) {
          const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to abort revert: ${sanitizeGitError(abortMsg)}`
          );
        }
      }
    }
  }

  /** Checkout the selected commit in detached HEAD mode. */
  private _handleCheckoutRevision(commitHashes: string[]): Promise<void> {
    return checkoutRevision(this._checkoutResetActionsContext(), commitHashes);
  }

  /** Soft/mixed/hard reset the current branch to the selected commit. */
  private _handleResetToHere(commitHashes: string[]): Promise<void> {
    return resetToHere(this._checkoutResetActionsContext(), commitHashes);
  }

  private _checkoutResetActionsContext(): ICommitCheckoutResetActionsContext {
    return {
      gitService: this._gitService,
      gitToolWindowProvider: this._gitToolWindowProvider,
      context: this._context,
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
      readProtectedBranches: () => this._readProtectedBranches(),
    };
  }

  /**
   * Read `intellig.protectedBranches` from configuration.
   */
  private _readProtectedBranches(): string[] {
    const value = readConfig('protectedBranches');
    return Array.isArray(value) ? value.filter((s) => typeof s === 'string') : [];
  }

  /** Generate patch file(s) from the selected commit(s). */
  private _handleCreatePatch(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    return createPatch(this._patchActionsContext(), commitHashes, commitNodes);
  }

  /** Silent clipboard variant of Create Patch (no dialogs). */
  private _handleCreatePatchToClipboard(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    return createPatchToClipboard(this._patchActionsContext(), commitHashes, commitNodes);
  }

  private _patchActionsContext(): ICommitPatchActionsContext {
    return {
      gitCli: this._gitCli,
      context: this._context,
      isCrossRepoSelection: (commitHashes) => this._isCrossRepoSelection(commitHashes),
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
    };
  }

  /** Open a diff between the selected commit and the working tree. */
  private _handleCompareWithLocal(commitHashes: string[]): Promise<void> {
    return compareWithLocal(this._compareActionsContext(), commitHashes);
  }

  /** Compare the two selected revisions file by file. */
  private _handleCompareVersions(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    return compareVersions(this._compareActionsContext(), commitHashes, commitNodes);
  }

  /** Open the selected commit's files at that revision. */
  private _handleShowRepoAtRevision(commitHashes: string[]): Promise<void> {
    return showRepoAtRevision(this._compareActionsContext(), commitHashes);
  }

  private _compareActionsContext(): ICommitCompareActionsContext {
    return {
      gitCli: this._gitCli,
      gitService: this._gitService,
      isCrossRepoSelection: (commitHashes) => this._isCrossRepoSelection(commitHashes),
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
    };
  }

  /**
   * Undo the selected commit by performing a soft reset to its parent.
   * Only works if the selected commit is the HEAD commit.
   */
  private _handleUndoCommit(commitHashes: string[]): Promise<void> {
    return undoCommit(this._undoContext(), commitHashes);
  }

  private _undoContext(): ICommitUndoContext {
    return {
      gitService: this._gitService,
      gitCli: this._gitCli,
      gitToolWindowProvider: this._gitToolWindowProvider,
      changelistService: this._changelistService,
      commitComposer: this._commitComposer,
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
      isNotOnProtectedBranch: (cwd, hash, opLabel) =>
        this._isNotOnProtectedBranch(cwd, hash, opLabel),
    };
  }

  /**
   * Drop the selected commit using interactive rebase.
   * Uses hash~1 as the onto target so the selected commit is included in the session.
   *
   * Single-commit path. Multi-commit selections route via the
   * dispatcher to {@link _handleDropCommitMulti}. Both paths share the
   * merge-commit gate (UI disables it via `computeMenuEnableState`;
   * the handler re-checks here as belt-and-suspenders).
   */
  private _isOldestInCurrentBranch(repo: IRepository, oldestHash: string): Promise<boolean> {
    return isOldestInCurrentBranch(this._guardsContext(), repo, oldestHash);
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
  private async _runHistoryRewrite(
    repo: IRepository,
    opts: {
      /** Rebase base, e.g. `${hash}~1`. */
      onto: string;
      /**
       * Oldest commit being rewritten (the child of `onto`). The
       * protected-branch gate probes its remote containment — one commit
       * suffices, see {@link _isNotOnProtectedBranch}.
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
    // rebase-containment-exempt: every body runs _isOldestInCurrentBranch on
    // its own oldest hash BEFORE calling the runner — the runner only receives
    // the prepared `onto` base and cannot know which commit is oldest.
    const cwd = repo.rootUri.fsPath;

    // In-progress pre-flight — refuse while a rebase or a cherry-pick/revert
    // sequencer is live (see _isNoOperationInProgress). Runs FIRST: a rebase
    // paused at an `edit` step has a clean tree, so the unmerged probe below
    // would let it through into a "rebase-merge already exists" failure that
    // handleRebaseResult misreads as OUR paused rebase.
    if (!(await this._isNoOperationInProgress(repo, opts.opLabel))) {
      return;
    }

    if ((await detectLocalChanges(this._gitCli, cwd)) === 'blocked-unmerged') {
      void vscode.window.showErrorMessage(
        `Cannot ${opts.opLabel.toLowerCase()} while you have unmerged files. Please resolve conflicts first.`
      );
      return;
    }

    // Merge-flattening gate — refuse BEFORE any git mutation when the range
    // carries merges (see _isRangeMergeFree). The menu enable-state mirrors
    // this refusal; the runner owns it for palette / scripted entry points.
    if (!(await this._isRangeMergeFree(repo, opts.onto, opts.opLabel))) {
      return;
    }

    // Protected-branch gate — a rewrite touching history already on a
    // protected remote branch is refused outright (see
    // _isNotOnProtectedBranch).
    if (!(await this._isNotOnProtectedBranch(cwd, opts.oldest, opts.opLabel))) {
      return;
    }

    const session = await this._rebaseService.startInteractiveRebase(repo, opts.onto);
    const plan = opts.buildPlan(session);
    if (plan === 'stale') {
      this._rebaseService.clearSession(repo);
      return;
    }
    this._rebaseService.updateRebasePlan(repo, plan);

    const first = await this._rebaseService.executeRebase(repo);
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
      await this._openResolveConflictsDialog(repo, result.conflictedFiles, {
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
    await this._gitService.reloadRepository(repo);
    this._gitToolWindowProvider.refresh();
  }

  private async _handleDropCommit(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }
    // Guard a merged-log selection that straddles repos before any routing —
    // a single rebase can't drop foreign-repo commits.
    if (this._isCrossRepoSelection(commitHashes)) {
      return;
    }

    // hash-format validation applies to BOTH the single- and multi-commit
    // drop paths. Lifted above the N>=2 routing so palette / scripted entry
    // points hitting either branch get the same defence-in-depth. (The
    // initial-commit arm is handled per-path via _resolveRewriteBase — warn
    // then `--root`, per the reference.)
    if (!allHashesValid(commitHashes)) {
      return;
    }

    // N>=2 routes to the multi-commit drop flow. Single
    // entry point keeps the dispatcher simple and preserves the
    // dispatch-property invariant.
    if (commitHashes.length >= 2) {
      await this._handleDropCommitMulti(commitHashes, commitNodes);
      return;
    }

    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo) {
      return;
    }

    const hash = commitHashes[0];

    // defence-in-depth merge-commit gate. The UI hides the
    // action entirely when the selection contains a merge commit, but
    // a palette / scripted entry point could still call this handler
    // with a merge hash. Refuse with a friendly toast.
    const dropTargetParents = commitNodes.find((n) => n.hash === hash)?.parentCount;
    if (dropTargetParents !== undefined && dropTargetParents >= 2) {
      void vscode.window.showErrorMessage(
        'Drop cannot include merge commits — use Reset to a non-merge ancestor instead.'
      );
      return;
    }

    // HEAD-containment gate (before any confirm / stash / rebase): dropping a
    // commit HEAD doesn't contain would rebase and move the checked-out branch.
    if (!(await this._isOldestInCurrentBranch(repo, hash))) {
      return;
    }

    // Initial-commit arm: warn-and-proceed via --root (reference parity).
    const onto = await this._resolveRewriteBase(hash, dropTargetParents === 0, 'Drop');
    if (onto === undefined) {
      return;
    }

    // Confirm modal — dropping a commit rewrites history. The multi-drop
    // sibling (_handleDropCommitMulti) confirms; the single path must match
    // (feedback_data_loss_confirms minimal-confirm policy). Show the
    // short-sha + subject for disambiguation, racing the subject lookup
    // against a 500ms timeout so a hung git process can't stall the modal.
    const shortSha = hash.substring(0, 8);
    let subject = '';
    try {
      const previewCommit = await Promise.race([
        this._gitService.getCommit(repo, hash),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]);
      subject = (previewCommit?.message ?? '').split('\n')[0].slice(0, 60);
    } catch {
      subject = '';
    }
    const confirmChoice = await vscode.window.showWarningMessage(
      `Drop commit ${shortSha}${subject ? ` — ${subject}` : ''}? This rewrites history.`,
      { modal: true },
      'Drop'
    );
    if (confirmChoice !== 'Drop') {
      return;
    }

    try {
      await this._runHistoryRewrite(repo, {
        onto,
        oldest: hash,
        opLabel: 'Drop',
        target: 'drop',
        successToast: `Dropped commit ${hash.substring(0, 8)}`,
        buildPlan: (session) => {
          const targetCommit = session.commits.find(
            (c) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
          );
          if (!targetCommit) {
            void vscode.window.showErrorMessage(
              `Commit ${hash.substring(0, 8)} not found in rebase session.`
            );
            return 'stale';
          }
          return session.commits.map((c) =>
            c.hash === targetCommit.hash
              ? { hash: c.hash, action: 'drop' as const }
              : { hash: c.hash, action: c.action }
          );
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to drop commit: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Drop N>=2 contiguous-or-not commits via a single
   * interactive rebase.
   *
   * Flow:
   *   1. Validate every hash is hex (belt-and-suspenders).
   *   2. In-order guard: every selected hash must still be in the
   *      rendered commitNodes; otherwise toast "selection changed" and
   *      abort. Mirror of `_handleCommitContextMenu`.
   *   3. Defence-in-depth — refuse if any selected commit is a merge.
   *      The UI gates this in `computeMenuEnableState`; this is the
   *      handler-side mirror.
   *   4. Initial-commit edge — `oldest^` doesn't resolve when oldest
   *      is the initial commit. Detect via parentCount=0 and toast.
   *   5. Confirm modal — N>=2 only. List up to 5 short-shas.
   *   6. Hand off to {@link _runHistoryRewrite}: rebase onto `oldest^`
   *      with every commit in the window staying `pick` unless its hash is
   *      in the selected set (which becomes `drop`); on conflict the rebase
   *      stays paused and the resolve dialog opens
   *      (operation:'rebase', target:'drop').
   *
   * Replay direction (trap #3): commitHashes arrives newest-first from
   * the webview. The rebase window is built oldest-first by
   * `RebaseService.getCommitsToRebase` (it walks `<onto>..HEAD --reverse`),
   * so we don't need to manage replay order ourselves — we just turn
   * each plan entry to drop/pick by membership in the selected set.
   */
  private async _handleDropCommitMulti(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo || commitHashes.length < 2) {
      return;
    }

    // 1. Hash format validation.
    if (!allHashesValid(commitHashes)) {
      return;
    }

    // 2. In-order guard — every selected hash must be in commitNodes.
    const inOrder = new Set(commitNodes.map((n) => n.hash));
    const stale = commitHashes.filter((h) => !inOrder.has(h));
    if (stale.length > 0) {
      void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
      return;
    }

    // 3. Defence-in-depth — refuse merge-commit selections.
    const selectedSet = new Set(commitHashes);
    const hasMerge = commitNodes.some((n) => selectedSet.has(n.hash) && n.parentCount >= 2);
    if (hasMerge) {
      void vscode.window.showErrorMessage(
        'Drop cannot include merge commits — use Reset to a non-merge ancestor instead.'
      );
      return;
    }

    // Project to display indices and find the oldest selected (largest
    // index in newest-first display order).
    const indexByHash = new Map<string, number>();
    for (let i = 0; i < commitNodes.length; i++) {
      indexByHash.set(commitNodes[i].hash, i);
    }
    const indices = commitHashes
      .map((h) => indexByHash.get(h))
      .filter((i): i is number => i !== undefined)
      .slice()
      .sort((a, b) => a - b);
    // Newest-first display: largest index = oldest commit.
    const oldestIdx = indices[indices.length - 1];
    const oldestHash = commitNodes[oldestIdx].hash;

    // 4. HEAD-containment gate (before any confirm / stash / rebase): if the
    // oldest selected commit isn't reachable from HEAD, the `oldest^..HEAD`
    // rebase would rewrite and move the checked-out branch instead.
    if (!(await this._isOldestInCurrentBranch(repo, oldestHash))) {
      return;
    }

    // 4b. Initial-commit arm — `oldest^` cannot resolve; warn-and-proceed
    // via --root (reference parity).
    const onto = await this._resolveRewriteBase(
      oldestHash,
      commitNodes[oldestIdx].parentCount === 0,
      'Drop'
    );
    if (onto === undefined) {
      return;
    }

    // 5. Confirm modal (N>=2 only). Surface up to 5 rows formatted
    // as `<short-sha> — <subject>` so the user can verify exactly which
    // commits the destructive op will rewrite. Earlier we listed bare
    // short-shas, which the user couldn't disambiguate against the log.
    // Subjects pulled via getCommit and truncated to
    // 60 chars; failed lookups fall back to the bare short-sha.
    //
    // Wrap each lookup in a 500ms `Promise.race` so a
    // slow / hung git process can't stall the modal indefinitely on a
    // huge repo. Timeout falls back to the bare short-sha — the user
    // still sees the destructive-op confirm with valid disambiguation.
    //
    // Bare 'Drop' label is intentional per
    // `feedback_data_loss_confirms.md`'s minimal-confirm policy.
    const previewLimit = 5;
    const previewTimeoutMs = 500;
    const previewRows = await Promise.all(
      commitHashes.slice(0, previewLimit).map(async (h) => {
        try {
          const commit = await Promise.race([
            this._gitService.getCommit(repo, h),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), previewTimeoutMs)
            ),
          ]);
          const subject = (commit?.message ?? '').split('\n')[0].slice(0, 60);
          return subject ? `${h.substring(0, 8)} — ${subject}` : h.substring(0, 8);
        } catch {
          return h.substring(0, 8);
        }
      })
    );
    const preview =
      previewRows.join('\n') +
      (commitHashes.length > previewLimit
        ? `\n… and ${commitHashes.length - previewLimit} more`
        : '');
    const confirmChoice = await vscode.window.showWarningMessage(
      `Drop ${commitHashes.length} commits? This rewrites history.\n\n${preview}`,
      { modal: true },
      'Drop'
    );
    if (confirmChoice !== 'Drop') {
      return;
    }

    try {
      // 6-8. The shared runner: rebase onto `oldest^` (the window covers
      // every commit reachable from HEAD that's newer than oldestHash^ —
      // including non-selected commits that must stay), pause on conflict,
      // hand off to the resolve dialog.
      await this._runHistoryRewrite(repo, {
        onto,
        oldest: oldestHash,
        opLabel: 'Drop',
        target: 'drop',
        successToast: `Dropped ${commitHashes.length} commits successfully.`,
        buildPlan: (session) => {
          // Each commit in the session stays `pick` unless its hash is in
          // the selected drop set.
          const plan = session.commits.map((c) =>
            selectedSet.has(c.hash)
              ? { hash: c.hash, action: 'drop' as const }
              : { hash: c.hash, action: c.action }
          );

          // Empty rebase-window or partial-coverage guard. If
          // `getCommitsToRebase` returned fewer commits than the user
          // selected (the most plausible cause: a force-push landed between
          // dispatch and rebase, mutating reachable history), the empty plan
          // would `executeRebase` to a no-op success and we'd surface a
          // misleading "dropped N commits" toast. Detect via "every selected
          // hash must be a drop in the plan"; toast STALE_SELECTION_TOAST
          // and refuse. Compare against `selectedSet.size`, not
          // `commitHashes.length`, so a duplicate-hash payload from a future
          // palette / scripted entry point keeps the guard robust.
          const planDropCount = plan.filter((p) => p.action === 'drop').length;
          if (planDropCount < selectedSet.size) {
            void vscode.window.showWarningMessage(STALE_SELECTION_TOAST);
            return 'stale';
          }
          return plan;
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to drop commits: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Squash N>=2 contiguous non-merge commits into one via a
   * single interactive rebase.
   *
   * Flow (IntelliJ semantics: dialog runs BEFORE the rebase):
   *   1. Validate hashes; in-order guard; defence-in-depth contiguity +
   *      no-merge checks (UI gates them in `computeMenuEnableState`).
   *   2. Determine the oldest selected commit (largest index in newest-
   *      first display order). An oldest with no parent (the initial
   *      commit) warns and proceeds via `--root`.
   *   3. Fetch each selected commit's full message via `getCommit`. Join
   *      with `\n\n` to seed the message editor.
   *   4. Open the squash-message dialog with the seed value. On cancel
   *      or a blank message, abort with no git side-effects.
   *   5. Hand off to {@link _runHistoryRewrite}: rebase onto `oldest^`
   *      with the plan mirroring git4idea's unite model — the oldest
   *      selected commit (the unite root) becomes `reword` carrying the
   *      user's combined message; every other selected commit becomes
   *      `fixup` (its own message discarded); non-selected commits keep
   *      their action. The combined message is delivered through the
   *      reword override in the plan (realised as `pick` + a
   *      non-interactive `commit --amend -F`), so the rebase runs to
   *      completion without pausing for a message. On conflict the rebase
   *      stays paused and the resolve dialog opens
   *      (operation:'rebase', target:'squash').
   */
  private async _handleSquashCommits(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = [],
    // Optional mode flag distinguishing the
    // user-visible squash variant from a `git --fixup` variant. The latter
    // skips the message-edit dialog and reuses the parent commit's
    // existing message verbatim, matching git's `--fixup` semantics. The
    // existing single-source-of-truth squash plan is preserved; only the
    // pre-rebase prompt + post-rebase squash-message marshalling differ.
    options?: { mode?: 'squash' | 'fixup' }
  ): Promise<void> {
    const mode = options?.mode ?? 'squash';
    const log = getLogger().child({ component: 'CommitContextMenuCommands' });
    log.debug('squash commits handler invoked', {
      mode,
      commitHashesCount: commitHashes.length,
      commitNodesCount: commitNodes.length,
    });
    if (this._isCrossRepoSelection(commitHashes)) {
      return;
    }
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo) {
      log.warn('squash aborted: no repository resolved');
      void vscode.window.showWarningMessage(
        `Cannot ${mode === 'fixup' ? 'fixup' : 'squash'} commits: no repository found.`
      );
      return;
    }
    if (commitHashes.length < 2) {
      // Squash needs ≥ 2 commits. Surface a toast so the user knows
      // their click was received but the action requires more
      // selection.
      log.warn('squash aborted: fewer than 2 commits selected', {
        commitHashesCount: commitHashes.length,
      });
      void vscode.window.showWarningMessage(
        `Cannot ${mode === 'fixup' ? 'fixup' : 'squash'} commits: select 2 or more commits first.`
      );
      return;
    }

    // 1. Hash format validation.
    if (!allHashesValid(commitHashes)) {
      // Hash format failure — should not happen in practice given the
      // webview only sends rendered hashes, but if it does the user
      // needs to know the click was received and rejected for a real
      // reason rather than silently dropped.
      log.warn('squash aborted: hash format validation failed', { commitHashes });
      void vscode.window.showErrorMessage(
        'Squash aborted: one or more selected commit hashes are malformed.'
      );
      return;
    }

    // 1b. In-order guard.
    const knownHashes = new Set(commitNodes.map((n) => n.hash));
    const stale = commitHashes.filter((h) => !knownHashes.has(h));
    if (stale.length > 0) {
      log.warn('squash aborted: stale selection (commit hashes not in current commitNodes)', {
        staleCount: stale.length,
      });
      void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
      return;
    }

    // 1c. Defence-in-depth — squash must be contiguous + non-merge.
    const displayOrder = commitNodes.map((n) => n.hash);
    if (!isSelectionContiguous(new Set(commitHashes), displayOrder)) {
      void vscode.window.showErrorMessage(
        'Squash needs contiguous (consecutive) commits — gaps in the selection are not supported.'
      );
      return;
    }
    const selectedSet = new Set(commitHashes);
    const hasMerge = commitNodes.some((n) => selectedSet.has(n.hash) && n.parentCount >= 2);
    if (hasMerge) {
      void vscode.window.showErrorMessage('Squash cannot include merge commits.');
      return;
    }
    // The selection must be a single first-parent chain (one branch), not just
    // display-contiguous — a shift-range can span interleaved branches. Re-check
    // at perform time (the menu-enable gate is advisory and can race a stale
    // selection), mirroring IntelliJ's checkHeadLinearHistory.
    if (!isContiguousFirstParentChain(selectedSet, commitNodes)) {
      void vscode.window.showErrorMessage(
        'Squash needs commits on a single branch (one first-parent chain) — the selection spans branches.'
      );
      return;
    }

    // 2. Find the oldest selected commit (largest index in newest-first display order).
    const indexByHash = new Map<string, number>();
    for (let i = 0; i < commitNodes.length; i++) {
      indexByHash.set(commitNodes[i].hash, i);
    }
    const indices = commitHashes
      .map((h) => indexByHash.get(h))
      .filter((i): i is number => i !== undefined)
      .slice()
      .sort((a, b) => a - b);
    const oldestIdx = indices[indices.length - 1];
    const oldestHash = commitNodes[oldestIdx].hash;

    // 2b. HEAD-containment gate (before the message dialog / stash / rebase):
    // squashing commits HEAD doesn't contain would rebase `oldest^..HEAD` and
    // move the checked-out branch instead of the target's branch.
    if (!(await this._isOldestInCurrentBranch(repo, oldestHash))) {
      return;
    }

    // 2c. Initial-commit arm — the root is a non-merge commit with no parent,
    // so `oldest^` cannot resolve; warn-and-proceed via --root.
    const onto = await this._resolveRewriteBase(
      oldestHash,
      commitNodes[oldestIdx].parentCount === 0,
      mode === 'fixup' ? 'Fixup' : 'Squash'
    );
    if (onto === undefined) {
      return;
    }

    // 3. Fetch each selected commit's full message and join in oldest-
    // first order (chronological: oldest commit's message comes first
    // in the seed). commitHashes is newest-first; oldest-first =
    // .slice().reverse().
    const oldestFirst = [...commitHashes].reverse();
    const messages: string[] = [];
    for (const h of oldestFirst) {
      try {
        const commit = await this._gitService.getCommit(repo, h);
        messages.push(commit.message ?? '');
      } catch {
        // If lookup fails, fall back to the short-sha so the seed
        // still has a marker for the user to edit.
        messages.push(h.substring(0, 8));
      }
    }
    const seedMessage = messages.filter((m) => m.length > 0).join('\n\n');

    // 4. Show the squash-message editor: a webview-hosted modal dialog with
    // a multi-line textarea seeded with the `\n\n`-joined messages; it
    // resolves with the user's message on submit or `undefined` on cancel.
    // Falls back to the temp-file editor when the extension context isn't
    // available (palette / scripted callers that didn't go through
    // `register()`).
    //
    // `mode === 'fixup'` skips the dialog entirely: the oldest selected
    // commit stays `pick`, so it keeps its own message verbatim (matching
    // `git commit --fixup`) — no message needs to be collected or applied.
    let userMessage: string | undefined;
    if (mode === 'squash') {
      log.debug('squash: opening message dialog', {
        commitCount: commitHashes.length,
      });
      if (this._context) {
        const dialog = new SquashMessageDialog(this._context, {
          seedMessage,
          commitCount: commitHashes.length,
        });
        userMessage = await dialog.prompt();
      } else {
        userMessage = await this._promptForMessageInEditor(seedMessage, {
          tmpInfix: 'squash',
          opName: 'Squash',
          fallbackPrompt: `Squashed commit message (${commitHashes.length} commits)`,
        });
      }
      // A blank message is a cancel, not an override: carrying an empty
      // string into the plan would fail hasRewordOverride and silently fall
      // back to a classic reword (which keeps the target's own message under
      // GIT_EDITOR=true). Treat undefined AND blank as a clean cancel so the
      // combined-message contract holds regardless of which dialog produced it.
      if (userMessage === undefined || userMessage.trim().length === 0) {
        log.debug('squash cancelled: user dismissed the message dialog');
        return;
      }
    }

    try {
      // 5-7. The shared runner: rebase onto `oldest^` with the squash plan
      // (reword the unite root with the combined message, fixup the rest —
      // git4idea parity; see {@link buildSquashRebasePlan}. Fixup carries no
      // message, so the target keeps its own — the root stays pick). The
      // combined message is delivered through the plan (a reword override on
      // the squash target), so the rebase runs non-interactively — it never
      // pauses for the message. On conflict the rebase stays paused and the
      // resolve dialog opens (operation:'rebase', target:'squash').
      const verb = mode === 'fixup' ? 'Fixup' : 'Squash';
      await this._runHistoryRewrite(repo, {
        onto,
        oldest: oldestHash,
        opLabel: verb,
        target: 'squash',
        successToast: `${mode === 'fixup' ? "Fixup'd" : 'Squashed'} ${commitHashes.length} commits successfully.`,
        buildPlan: (session) =>
          mode === 'fixup'
            ? buildSquashRebasePlan(session.commits, selectedSet, oldestHash)
            : buildSquashRebasePlan(session.commits, selectedSet, oldestHash, userMessage),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const verb = mode === 'fixup' ? 'fixup commits' : 'squash commits';
      void vscode.window.showErrorMessage(`Failed to ${verb}: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * IntelliJ-parity "Compare with Branch...". Opens
   * a single QuickPick listing local branches + remote branches + tags
   * (each group separated by a `Separator` kind item) and routes the
   * picked ref through {@link BranchComparisonView.show}. The clicked
   * commit's full SHA is one side of the comparison; the picked ref is
   * the other. Git accepts a SHA on either side of `branch1...branch2`
   * and `branch1..branch2` so we treat the SHA as a "branch" alias for
   * the diff purposes — no new GitService method needed.
   */
  private async _handleCompareWithBranch(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    if (!allHashesValid([hash])) {
      return;
    }

    // Lazy-import BranchComparisonView via a setter — extension.ts wires
    // it post-construction (the view is created AFTER this commands
    // class). When the setter hasn't fired yet, fall back to a
    // best-effort error toast rather than crashing.
    if (!this._branchComparisonView) {
      void vscode.window.showErrorMessage(
        'Branch comparison view is not available yet — try again after the workspace finishes loading.'
      );
      return;
    }

    let branches;
    let tags;
    try {
      [branches, tags] = await Promise.all([
        this._gitService.getBranches(repo),
        this._gitService.getTags(repo),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to load refs for comparison: ${sanitizeGitError(msg)}`
      );
      return;
    }

    interface IComparePickItem extends vscode.QuickPickItem {
      ref?: string;
    }
    const items: IComparePickItem[] = [];

    // Single-pass partition by branch type. `IBranch.type` is the
    // `BranchType` union (`'local' | 'remote' | 'tag'`); we display
    // local + remote here and rely on `getTags()` for the Tags section
    // below. Any future fourth variant added to `BranchType` will land
    // in `_other` and stay invisible to the picker until explicitly
    // wired — making the assumption fail loudly via dead code rather
    // than silently dropping entries inside a chained `.filter()`.
    const localBranches: IBranch[] = [];
    const remoteBranches: IBranch[] = [];
    const _other: IBranch[] = [];
    for (const b of branches || []) {
      if (b.type === 'local') {
        localBranches.push(b);
      } else if (b.type === 'remote') {
        remoteBranches.push(b);
      } else {
        // 'tag' (or any future variant) — surfaced via getTags() below.
        _other.push(b);
      }
    }

    if (localBranches.length > 0) {
      items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
      for (const b of localBranches) {
        items.push({
          label: `$(git-branch) ${b.name}`,
          description: b.commit ? b.commit.substring(0, 7) : '',
          ref: b.name,
        });
      }
    }

    if (remoteBranches.length > 0) {
      items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
      for (const b of remoteBranches) {
        items.push({
          label: `$(git-branch) ${b.name}`,
          description: b.commit ? b.commit.substring(0, 7) : '',
          ref: b.name,
        });
      }
    }

    if (tags && tags.length > 0) {
      items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
      for (const t of tags) {
        items.push({
          label: `$(tag) ${t.name}`,
          description: t.commit ? t.commit.substring(0, 7) : '',
          ref: t.name,
        });
      }
    }

    if (items.length === 0) {
      void vscode.window.showInformationMessage('No branches or tags available for comparison.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Compare ${hash.substring(0, 8)} with...`,
      placeHolder: 'Select a branch or tag to compare with',
    });
    if (!picked || !picked.ref) {
      return;
    }

    try {
      // BranchComparisonView.show accepts arbitrary refs in branch1 /
      // branch2 — the underlying compareBranches splices them through
      // `git rev-list --left-right --count <a>...<b>` and `git diff
      // --name-only <a>...<b>` which both accept SHAs as ref aliases.
      // No new GitService surface needed.
      await this._branchComparisonView.show(repo, hash, picked.ref);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to compare with ${picked.ref}: ${sanitizeGitError(msg)}`
      );
    }
  }

  /**
   * Edit the commit message of the selected commit.
   * Uses git commit --amend for HEAD commits.
   * Uses interactive rebase with reword for non-HEAD commits.
   * Both paths stash uncommitted/unmerged changes first to avoid conflicts.
   */
  private async _handleEditCommitMessage(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    const cwd = repo.rootUri.fsPath;

    // HEAD-containment gate (before the message dialog / stash / rebase). The
    // non-HEAD path rewords via `hash~1..HEAD` rebase, which would move the
    // checked-out branch for a commit HEAD doesn't contain; the HEAD-amend path
    // targets HEAD itself, which is trivially contained (guard passes).
    if (!(await this._isOldestInCurrentBranch(repo, hash))) {
      return;
    }

    // Protected-branch gate BEFORE the message dialog, mirroring IntelliJ's
    // perform-time check ordering (lastCheckCommitsEditingAvailability runs
    // before the reword dialog). Applies to BOTH arms: the HEAD amend
    // rewrites protected published history just like the non-HEAD rebase
    // (which the runner would also gate, later).
    if (!(await this._isNotOnProtectedBranch(cwd, hash, 'Edit message'))) {
      return;
    }

    try {
      // Fetch the full commit message
      let fullMessage = '';
      try {
        const msgResult = await this._gitCli.exec(['log', '-1', '--format=%B', hash], { cwd });
        if (msgResult.exitCode === 0 && msgResult.stdout.trim()) {
          fullMessage = msgResult.stdout.trim();
        }
      } catch (error) {
        // Continue with empty message; log the probe fault so it stays visible.
        getLogger()
          .child({ component: 'CommitContextMenuCommands' })
          .debug('editCommitMessage: full-message fetch failed', {
            err: error instanceof Error ? error.message : String(error),
          });
      }

      // Multi-line editor so the user can enter a subject + body (a
      // single-line input would collapse the whole message into the
      // subject). Primary: the webview dialog (when an extension context
      // is available); fallback: a tempfile editor — matching the squash
      // message flow.
      let newMessage: string | undefined;
      if (this._context) {
        const dialog = new CommitMessageDialog(this._context, {
          seedMessage: fullMessage,
          viewType: 'intellig.editMessageDialog',
          title: 'Edit Commit Message',
          heading: 'Edit commit message',
          submitLabel: 'Update Message',
          submitVerb: 'save',
        });
        newMessage = await dialog.prompt();
      } else {
        newMessage = await this._promptForMessageInEditor(fullMessage, {
          tmpInfix: 'reword',
          opName: 'Edit message',
          fallbackPrompt: 'Edit commit message',
        });
      }

      // Undefined OR blank = cancel: the dialogs collapse a blank submit
      // to undefined, but guard explicitly so an empty message never
      // becomes a no-op reword with an empty subject.
      if (newMessage === undefined || newMessage.trim().length === 0) {
        return;
      }

      const headHash = repo.head?.commit;
      const isHead =
        headHash && (headHash === hash || headHash.startsWith(hash) || hash.startsWith(headHash));

      if (isHead) {
        // HEAD amend: git commit --amend -m only rewrites the commit message.
        // It doesn't touch the working tree or index, so it works even with
        // unmerged files or dirty state — no stash needed.
        await this._gitCli.exec(
          ['commit', '--amend', '--allow-empty', '--only', '-m', newMessage],
          { cwd, throwOnError: true }
        );
        void vscode.window.showInformationMessage(
          `Updated commit message for ${hash.substring(0, 8)}`
        );
        // The amend rewrote HEAD; reload before refresh.
        await this._gitService.reloadRepository(repo);
        this._gitToolWindowProvider.refresh();
      } else {
        // Non-HEAD: reword via the shared history-rewrite runner.
        await this._runHistoryRewrite(repo, {
          onto: `${hash}~1`,
          oldest: hash,
          opLabel: 'Edit message',
          target: 'reword',
          successToast: `Updated commit message for ${hash.substring(0, 8)}`,
          buildPlan: (session) => {
            const targetCommit = session.commits.find(
              (c) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
            );
            if (!targetCommit) {
              void vscode.window.showErrorMessage(
                `Commit ${hash.substring(0, 8)} not found in rebase session.`
              );
              return 'stale';
            }
            return session.commits.map((c) =>
              c.hash === targetCommit.hash
                ? { hash: c.hash, action: 'reword' as const, newMessage }
                : { hash: c.hash, action: c.action }
            );
          },
          // `git rebase -i` pauses at the reword step waiting for a commit
          // message in `$GIT_EDITOR` / `core.editor`. Headless extension
          // hosts have no GIT_EDITOR (only GIT_SEQUENCE_EDITOR is set), so
          // git pauses with the rebase metadata still in
          // `.git/rebase-merge/` and HEAD detached at the parent of the
          // reword target. `provideRewordMessage` runs `git commit --amend
          // -m <msg>` (no editor needed) followed by `git rebase
          // --continue`, which lands the rewrite and updates the branch
          // ref. The common single-reword case has one paused step; the
          // loop covers a plan with multiple reword actions in sequence.
          // A conflict (or cleared-stale no-op) surfaced mid-drive returns
          // to the runner's outcome switch, which pauses / reports it.
          drivePaused: async (first) => {
            let result = first;
            while (result.success && result.status === 'paused') {
              result = await this._rebaseService.provideRewordMessage(repo, newMessage);
            }
            return result;
          },
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to edit commit message: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * "Interactively Rebase from Here" — open the rebase plan editor with the
   * clicked commit INCLUDED: the plan rebases onto the commit's FIRST PARENT
   * (IntelliJ GitInteractiveRebaseAction / getRebaseUpstreamFor). The editor
   * owns all further UX (plan, execute, pause, abort); this handler only
   * resolves the base and refreshes after an executed plan. Calling the
   * rebase SERVICE directly here produced a headless planning session — a
   * toast and no UI.
   */
  private async _handleInteractiveRebase(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepositoryForCommit(commitHashes[0]);
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    // In-progress pre-flight (IntelliJ Prohibit-during-rebase policy): the
    // editor's execute would collide with the live rebase's state directory.
    if (!(await this._isNoOperationInProgress(repo, 'Start an interactive rebase'))) {
      return;
    }

    // HEAD-containment gate (before opening the editor): rebasing onto the
    // clicked commit's parent rewrites `clicked^..HEAD` — for a commit HEAD
    // doesn't contain that would transplant / move the checked-out branch.
    if (!(await this._isOldestInCurrentBranch(repo, hash))) {
      return;
    }

    try {
      const onto = await this._resolveFirstParent(repo, hash);
      if (onto === undefined) {
        void vscode.window.showWarningMessage(
          'Cannot interactively rebase from the root commit — it has no parent to rebase onto.'
        );
        return;
      }
      if (!this._openRebaseEditor) {
        void vscode.window.showErrorMessage(
          'Interactive rebase editor is not available — reload the window and try again.'
        );
        return;
      }
      // Pre-flight: a base on a merged side branch renders visually adjacent
      // to HEAD, but `<onto>..HEAD` spans everything the mainline gained since
      // that branch forked, and a plain interactive rebase FLATTENS every
      // merge in the range. Refuse before opening the editor; a merge-free
      // range (the common linear case) stays silent. The refusal hint keys
      // off the CLICKED commit, not the rebase base (its parent): for the
      // first commit of a merged branch — the whole branch, in the common
      // single-commit case — the parent is the mainline fork point, so a
      // base-side check would stay silent exactly where the hint matters most.
      const refused = !(await this._isRangeMergeFree(repo, onto, 'Interactive rebase', async () => {
        const clickedOnMainline = await isFirstParentAncestor(
          this._gitCli,
          repo.rootUri.fsPath,
          hash
        );
        return clickedOnMainline
          ? ''
          : ` '${hash.substring(0, 8)}' is on a merged branch, not the main line — to edit ` +
              `recent commits, pick a commit on the main line instead.`;
      }));
      if (refused) {
        return;
      }
      const result = await this._openRebaseEditor(repo, onto);
      if (result.executed) {
        // The rebase moved HEAD; reload before refresh.
        await this._gitService.reloadRepository(repo);
        this._gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to start interactive rebase: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Resolve the rebase base for a rewrite whose oldest commit is `oldestHash`:
   * `<oldest>~1` normally; for the INITIAL commit (no parent) IntelliJ warns
   * and proceeds with a full-history rebase
   * (GitCommitEditingActionBase.kt:202-210,266-275 → `--root`), so a
   * confirmed warning returns {@link REBASE_ROOT} and a dismissal returns
   * `undefined` (caller cancels cleanly).
   */
  private async _resolveRewriteBase(
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
  private async _isNoOperationInProgress(repo: IRepository, opLabel: string): Promise<boolean> {
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

  private _isRangeMergeFree(
    repo: IRepository,
    onto: string,
    opLabel: string,
    refusalHint?: () => Promise<string>
  ): Promise<boolean> {
    return isRangeMergeFree(this._guardsContext(), repo, onto, opLabel, refusalHint);
  }

  /**
   * First parent of `hash`, from the clicked row when the dispatch carries
   * it (no subprocess), else via `git rev-parse <hash>^`. `undefined` for a
   * root commit.
   */
  private async _resolveFirstParent(repo: IRepository, hash: string): Promise<string | undefined> {
    const row = this._dispatchNodes.find((n) => n.hash === hash);
    if (row) {
      if (row.parents && row.parents.length > 0) {
        return row.parents[0];
      }
      if (row.parentCount === 0) {
        return undefined;
      }
      // parentCount > 0 but hashes not threaded — fall through to git.
    }
    // revParseVerified, not a flagless rev-parse: the flagless form echoes a
    // literal `--end-of-options` line into stdout, corrupting the returned rev.
    // `hash^` fails to resolve exactly when there is no parent (root commit).
    return revParseVerified(this._gitCli, repo.rootUri.fsPath, `${hash}^`);
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

  /**
   * Handle "Push up to here" — IntelliJ's Git.PushUpToHere (parity).
   *
   * Delegates to `intellig.pushUpToCommit` which owns refspec construction so
   * the same logic is exercised from the context menu and the palette. The
   * handler is a thin bridge; the command is the authoritative entry point.
   *
   * Threads the clicked commit's OWN repo root as the second argument: in the
   * merged "all roots" scope the command would otherwise re-resolve via
   * `resolveRepo(preferActive)` (the active editor / a fresh QuickPick) and
   * push the foreign hash against the wrong repo. The root pins the resolution
   * to the clicked commit's repo; `undefined` leaves the command's existing
   * resolution untouched for single-repo / specific-scope callers.
   */
  private async _handlePushUpToCommit(commitHashes: string[]): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }
    const hash = commitHashes[0];
    if (!allHashesValid([hash])) {
      void vscode.window.showErrorMessage('Cannot push: invalid commit hash.');
      return;
    }
    const repo = await this._getRepositoryForCommit(hash);
    await vscode.commands.executeCommand('intellig.pushUpToCommit', hash, repo?.rootUri.fsPath);
  }

  private _handleNewBranch(commitHashes: string[]): Promise<void> {
    return newBranch(this._refActionsContext(), commitHashes);
  }

  private _handleNewTag(commitHashes: string[]): Promise<void> {
    return newTag(this._refActionsContext(), commitHashes);
  }

  private _refActionsContext(): ICommitRefActionsContext {
    return {
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
    };
  }

  /**
   * Handle "Fixup…" / "Squash Into…" — IntelliJ's Git.Fixup.To.Commit /
   * Git.Squash.Into.Commit (parity).
   *
   * Reference (GitAutoSquashCommitAction.kt:29-61): opens the COMMIT DIALOG
   * seeded `fixup!/squash! <subject>` and offers a commit-and-rebase
   * executor. Adapted to our paradigm: the seeded {@link CommitDialog}
   * reviews the staged changes first; a successful commit then offers a
   * `Rebase Now` toast that folds the new commit into its target via the
   * shared runner (see {@link _runAutosquashNow}). Callers without an
   * extension context (scripted entry points that never ran `register()`)
   * fall back to the immediate `GitService.commitFixup` commit.
   */
  private async _handleCommitFixup(
    commitHashes: string[],
    mode: 'fixup' | 'squash'
  ): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }
    const hash = commitHashes[0];
    if (!allHashesValid([hash])) {
      void vscode.window.showErrorMessage('Cannot commit: invalid commit hash.');
      return;
    }
    const repo = await this._getRepositoryForCommit(hash);
    if (!repo) {
      return;
    }

    const shortHash = hash.substring(0, 8);
    const verb = mode === 'fixup' ? 'fixup' : 'squash';

    if (this._context) {
      // Seed the dialog from the target's subject, reference-style.
      let subject = '';
      try {
        subject = (await this._gitService.getCommit(repo, hash)).message.split('\n')[0];
      } catch {
        subject = shortHash;
      }
      const dialog = new CommitDialog(
        this._context.extensionUri,
        this._gitService,
        this._context.workspaceState
      );
      const result = await dialog.show(repo, { initialMessage: `${mode}! ${subject}` });
      if (!result.committed) {
        return;
      }
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
      const choice = await vscode.window.showInformationMessage(
        `Created ${verb}! commit for ${shortHash}.`,
        'Rebase Now'
      );
      if (choice === 'Rebase Now') {
        await this._runAutosquashNow(repo, hash, mode);
      }
      return;
    }

    try {
      const result = await this._gitService.commitFixup(repo, hash, mode).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
      if (result.success) {
        void vscode.window.showInformationMessage(`Created ${verb}! commit for ${shortHash}`);
        await this._gitService.reloadRepository(repo);
        this._gitToolWindowProvider.refresh();
        return;
      }
      if (result.reason === 'nothing-to-commit') {
        void vscode.window.showErrorMessage(
          `Nothing to commit — stage changes to ${verb} into ${shortHash}`
        );
        return;
      }
      if (result.reason === 'invalid-hash') {
        void vscode.window.showErrorMessage('Cannot commit: invalid commit hash.');
        return;
      }
      void vscode.window.showErrorMessage(
        `Failed to ${verb} into ${shortHash}: ${sanitizeGitError(result.message ?? 'unknown error')}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to ${verb} into ${shortHash}: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * "Rebase Now" leg of Fixup / Squash Into: fold the just-created HEAD
   * `fixup!/squash!` commit into `targetHash` via the shared runner — the
   * plan moves it right after the target as a `fixup` line (git-autosquash
   * equivalent for a single commit). Squash mode combines messages the way
   * autosquash editing would: the target message plus the squash! commit's
   * body (its `squash! <subject>` marker line dropped), delivered through a
   * non-interactive reword override on the target.
   */
  private async _runAutosquashNow(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): Promise<void> {
    const verb = mode === 'fixup' ? 'Fixup' : 'Squash';
    try {
      if (!(await this._isOldestInCurrentBranch(repo, targetHash))) {
        return;
      }
      // The dialog committed onto HEAD — that IS the fixup!/squash! commit.
      const created = await this._gitService.getCommit(repo, 'HEAD');
      let combinedMessage: string | undefined;
      if (mode === 'squash') {
        const target = await this._gitService.getCommit(repo, targetHash);
        const extra = created.message
          .split('\n')
          .filter((line, i) => !(i === 0 && line.startsWith('squash!')))
          .join('\n')
          .trim();
        combinedMessage = extra.length > 0 ? `${target.message.trim()}\n\n${extra}` : undefined;
      }

      const node = this._dispatchNodes.find((n) => n.hash === targetHash);
      const onto = await this._resolveRewriteBase(targetHash, node?.parentCount === 0, verb);
      if (onto === undefined) {
        return;
      }

      await this._runHistoryRewrite(repo, {
        onto,
        oldest: targetHash,
        opLabel: verb,
        target: 'squash',
        successToast: `${verb} applied to ${targetHash.substring(0, 8)}.`,
        buildPlan: (session) => {
          const target = session.commits.find(
            (c) =>
              c.hash === targetHash ||
              c.hash.startsWith(targetHash) ||
              targetHash.startsWith(c.hash)
          );
          const createdEntry = session.commits.find(
            (c) => c.hash === created.hash || created.hash.startsWith(c.hash)
          );
          if (!target || !createdEntry || target.hash === createdEntry.hash) {
            void vscode.window.showErrorMessage(
              `Commit ${targetHash.substring(0, 8)} not found in rebase session.`
            );
            return 'stale';
          }
          const plan: IRebaseAction[] = [];
          for (const c of session.commits) {
            if (c.hash === createdEntry.hash) {
              continue;
            }
            if (c.hash === target.hash) {
              plan.push(
                combinedMessage !== undefined
                  ? { hash: c.hash, action: 'reword', newMessage: combinedMessage }
                  : { hash: c.hash, action: c.action }
              );
              plan.push({ hash: createdEntry.hash, action: 'fixup' });
            } else {
              plan.push({ hash: c.hash, action: c.action });
            }
          }
          return plan;
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to rebase the ${verb.toLowerCase()}! commit: ${sanitizeGitError(errorMessage)}`
      );
    }
  }
}

/**
 * Create a new CommitContextMenuCommands instance.
 *
 * @param gitService - The Git service to use
 * @param rebaseService - The Rebase service to use
 * @param gitToolWindowProvider - The Git Tool Window Provider
 * @param gitCli - Optional GitCli instance
 * @returns A new CommitContextMenuCommands instance
 */
export function createCommitContextMenuCommands(
  gitService: IGitService,
  rebaseService: IRebaseService,
  gitToolWindowProvider: GitToolWindowProvider,
  gitCli?: GitCli,
  conflictResolutionService?: IConflictResolutionService,
  repoResolver?: RepoResolver
): CommitContextMenuCommands {
  return new CommitContextMenuCommands(
    gitService,
    rebaseService,
    gitToolWindowProvider,
    gitCli,
    conflictResolutionService,
    repoResolver
  );
}
