/**
 * Commit Context Menu Commands implementation.
 * Provides command handlers for commit context menu actions in the Git Graph Panel.
 */

import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import { IBranch, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { IRebaseService } from '../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../ui-shell/GitToolWindowProvider';
import { GitCli } from '../git-core/gitCli';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { resolveRepo } from '../utils/resolveRepo';
import { sanitizeGitError } from '../git-core/gitError';
import { type IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import type { BranchComparisonView } from '../branches/BranchComparisonView';
import { CommitDialog } from './CommitDialog';
import {
  allHashesValid,
  type ICommitRepoContext,
  type ICommitSelectionContext,
} from './commitContextMenuShared';
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
import { handleCherryPick, type ICommitCherryPickActionsContext } from './commitCherryPickActions';
import { type ICommitHistoryRewriteContext } from './commitHistoryRewriteRunner';
import { handleDropCommit, handleDropSelectedChanges } from './commitDropActions';
import { handleSquashCommits } from './commitSquashActions';
import { handleEditCommitMessage } from './commitRewordActions';
import { handleInteractiveRebase, runAutosquashNow } from './commitInteractiveRebaseActions';
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

  private _handleDropSelectedChanges(repo: IRepository, hash: string): Promise<void> {
    return handleDropSelectedChanges(this._historyRewriteContext(), repo, hash);
  }

  /** Core repo-resolution deps shared by every action-module context. */
  private _repoContext(): ICommitRepoContext {
    return {
      getRepositoryForCommit: (hash) => this._getRepositoryForCommit(hash),
    };
  }

  /** Repo resolution + the cross-repo selection probe (multi-select actions). */
  private _selectionContext(): ICommitSelectionContext {
    return {
      ...this._repoContext(),
      isCrossRepoSelection: (commitHashes) => this._isCrossRepoSelection(commitHashes),
    };
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

  private _handleCherryPick(commitHashes: string[]): Promise<void> {
    return handleCherryPick(this._cherryPickActionsContext(), commitHashes);
  }

  private _cherryPickActionsContext(): ICommitCherryPickActionsContext {
    return {
      gitService: this._gitService,
      gitToolWindowProvider: this._gitToolWindowProvider,
      ...this._selectionContext(),
      anyIsMergeCommit: (repo, hashes) => anyIsMergeCommit(this._guardsContext(), repo, hashes),
      pickMainlineParent: (repo, hashes) => pickMainlineParent(this._guardsContext(), repo, hashes),
      isCommitPushed: (cwd, hash, probeFailureMeansPushed) =>
        isCommitPushed(this._guardsContext(), cwd, hash, probeFailureMeansPushed),
      conflictResolutionService: () => this._conflictResolutionService,
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
    };
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
      ...this._selectionContext(),
      anyIsMergeCommit: (repo, hashes) => anyIsMergeCommit(this._guardsContext(), repo, hashes),
      pickMainlineParent: (repo, hashes) => pickMainlineParent(this._guardsContext(), repo, hashes),
      handleRevertConflicts: (repo, conflicts, commitHashes) =>
        this._handleRevertConflicts(repo, conflicts, commitHashes),
    };
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
      ...this._repoContext(),
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
      ...this._selectionContext(),
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
      ...this._selectionContext(),
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
      changelistService: () => this._changelistService,
      commitComposer: () => this._commitComposer,
      ...this._repoContext(),
      isNotOnProtectedBranch: (cwd, hash, opLabel) =>
        isNotOnProtectedBranch(this._guardsContext(), cwd, hash, opLabel),
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
  private _handleDropCommit(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    return handleDropCommit(this._historyRewriteContext(), commitHashes, commitNodes);
  }

  private _historyRewriteContext(): ICommitHistoryRewriteContext {
    return {
      gitService: this._gitService,
      gitCli: this._gitCli,
      gitToolWindowProvider: this._gitToolWindowProvider,
      rebaseService: this._rebaseService,
      context: this._context,
      dispatchNodes: this._dispatchNodes,
      openRebaseEditor: this._openRebaseEditor, // live-read-exempt: wired once at activation (setRebaseEditorOpener), never reassigned.
      ...this._selectionContext(),
      isOldestInCurrentBranch: (repo, oldestHash) =>
        isOldestInCurrentBranch(this._guardsContext(), repo, oldestHash),
      isNotOnProtectedBranch: (cwd, hash, opLabel) =>
        isNotOnProtectedBranch(this._guardsContext(), cwd, hash, opLabel),
      isRangeMergeFree: (repo, onto, opLabel, refusalHint) =>
        isRangeMergeFree(this._guardsContext(), repo, onto, opLabel, refusalHint),
      anyIsMergeCommit: (repo, hashes) => anyIsMergeCommit(this._guardsContext(), repo, hashes),
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
    };
  }

  private _handleSquashCommits(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = [],
    options?: { mode?: 'squash' | 'fixup' }
  ): Promise<void> {
    return handleSquashCommits(this._historyRewriteContext(), commitHashes, commitNodes, options);
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

  private _handleEditCommitMessage(commitHashes: string[]): Promise<void> {
    return handleEditCommitMessage(this._historyRewriteContext(), commitHashes);
  }

  private _handleInteractiveRebase(commitHashes: string[]): Promise<void> {
    return handleInteractiveRebase(this._historyRewriteContext(), commitHashes);
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
      ...this._repoContext(),
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

  private _runAutosquashNow(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): Promise<void> {
    return runAutosquashNow(this._historyRewriteContext(), repo, targetHash, mode);
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
