/**
 * Commit Context Menu Commands implementation.
 * Provides command handlers for commit context menu actions in the Git Graph Panel.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { IBranch, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { IRebaseService } from '../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../ui-shell/GitToolWindowProvider';
import { showResetDialog } from '../ui-shell/ResetDialog';
import { GitCli } from '../git-core/gitCli';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { resolveRepo } from '../utils/resolveRepo';
import { atomicWriteFile } from '../utils/atomicWrite';
import { sanitizeGitError } from '../git-core/gitError';
import { isSelectionContiguous, type IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import type { BranchComparisonView } from '../branches/BranchComparisonView';
import { getLogger } from '../utils/logger';

/**
 * Defence-in-depth hash format check.
 *
 * `_handleCommitContextMenu` already rejects hashes that
 * aren't in the rendered `commitNodes`, but a future bypass (palette
 * command, scripted entry point) could feed unvalidated input. A
 * lowercase-hex regex catches obvious shell-injection / typoed-string
 * inputs before they reach the gitCli argv. Bounds:
 *   - 4 chars is the shortest `git rev-parse` accepts (abbreviated
 *     refs).
 *   - The upper bound is 64 (not 40) to support
 *     SHA-256 repos created by `git init --object-format=sha256` (Git
 *     ≥ 2.29). A SHA-1 cap would silently reject valid SHA-256
 *     hashes.
 */
const HASH_RE = /^[0-9a-f]{4,64}$/i;
function allHashesValid(hashes: readonly string[]): boolean {
  return hashes.every((h) => HASH_RE.test(h));
}

/**
 * Single source of truth for the stale-selection
 * toast surfaced when an in-order guard rejects a dispatched action whose
 * commit hash is no longer in the rendered commitNodes. The same
 * literal previously lived in five places (createPatchMulti, compareVersions,
 * dropCommitMulti, squashCommits, dropCommit) and inline structural tests
 * pinned exact matches. The const lets future copy edits land in one
 * place. Wire format frozen here.
 *
 * TODO(post-locale): when locale work begins, replace this with a
 * message-id and ship the localised string from a resource bundle.
 *
 * TODO(Wave D / TLC-L-2): the single-commit handlers (cherry-pick,
 * revert, etc.) still don't run `allHashesValid` on entry — only the
 * multi-commit ones do. Adopt the regex check at the top of every
 * single-commit handler in a follow-up; the dispatch path
 * catches webview-driven calls,
 * but a palette / scripted entry could feed unvalidated hex.
 */
const STALE_SELECTION_TOAST = 'Commit selection changed since the menu opened — please retry.';

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
  // late-bound by extension.ts via {@link setBranchComparisonView}
  // because BranchComparisonView is constructed AFTER this commands class
  // in the activate() order. The compareWithBranch handler guards on
  // undefined and surfaces a graceful error toast if the user fires the
  // action before wiring completes.
  private _branchComparisonView: BranchComparisonView | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _context: vscode.ExtensionContext | undefined;
  private readonly _resolveRepo: RepoResolver;

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
    }
  ): Promise<void> {
    if (!this._conflictResolutionService || conflicts.length === 0) {
      return;
    }
    await this._conflictResolutionService.openResolveConflictsDialog(
      repo,
      conflicts.map((p) => ({ path: p, resolved: false })),
      {
        operation: opContext.operation,
        target: opContext.target,
        canAbort: true,
        canContinue: true,
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
   * Previously pinned `getRepositories()[0]`, which silently targeted
   * the wrong repo in multi-root workspaces for every destructive action in
   * this class. Routes through `resolveRepo(preferActive: true, silent: true)`
   * so the action follows the same fallback chain as other multi-root-aware
   * entry points (see `CommitToolWindow._resolveRepo`).
   */
  private async _getRepository(): Promise<IRepository | undefined> {
    return this._resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
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
   * the stale-selection toast — see ADR-009 §6.
   */
  async _handleAction(
    action: LogContextAction,
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
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
      case 'mergeIntoCurrent':
        await this._handleMergeIntoCurrent(commitHashes);
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
      // IntelliJ-parity single-commit Squash/Fixup with
      // Previous. Both delegate into `_handleSquashCommits` with a
      // synthesised 2-commit selection (clicked commit + its first
      // parent).: single source of truth for the squash plan.
      case 'squashWithPrevious':
        await this._handleSquashWithPrevious(commitHashes);
        break;
      case 'fixupWithPrevious':
        await this._handleFixupWithPrevious(commitHashes);
        break;
      // Open the Compare-with-Branch picker (local
      // remote + tags) and route through BranchComparisonView.
      case 'compareWithBranch':
        await this._handleCompareWithBranch(commitHashes);
        break;
      default:
        // Unknown action — no-op
        break;
    }
  }

  /**
   * T2-04 public entry point invoked by the `intellig.commit.dropSelectedChanges`
   * palette command. Surfaced on the class (rather than through the
   * webview-dispatcher event) because the LogContextAction union lives in
   * `gitToolWindow/` which is out of scope for this step.
   *
   * Rewrites the HEAD commit to remove the user-selected files. Refuses
   * on pushed commits or on non-HEAD ancestors. Single destructive-op
   * confirm per the safety policy.
   */
  async dropSelectedChangesFromCommit(hash: string): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || !hash) {
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

    // 1. Safety: must be the HEAD commit. Dropping selected changes from
    //    an ancestor requires interactive rebase with a scripted editor,
    //    which is out of scope for the T2-04 MVP. Surface an explanatory
    //    toast so the user knows this is intentional.
    let isHead = false;
    try {
      const headResult = await this._gitCli.exec(['rev-parse', 'HEAD'], { cwd });
      if (headResult.exitCode === 0) {
        isHead = headResult.stdout.trim() === hash;
      }
    } catch {
      // Treat unknown state as "not HEAD" — safer default.
    }
    if (!isHead) {
      void vscode.window.showErrorMessage(
        `Drop Selected Changes is only supported on the most recent commit in this release. ` +
          `${shortHash} is not HEAD.`
      );
      return;
    }

    // 2. Safety: refuse on pushed commits (force-push territory).
    if (await this._isCommitPushed(cwd, hash)) {
      void vscode.window.showErrorMessage(
        `${shortHash} has already been pushed. Drop Selected Changes would rewrite published ` +
          `history — use the reset/force-push workflow instead.`
      );
      return;
    }

    // 3. File picker — user selects files to DROP.
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

    // 4. Single destructive-op confirm (safety policy).
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
    const keptPaths = diffs.map((d) => d.path).filter((p) => !droppedPaths.includes(p));

    // 5. Rewrite HEAD.
    //    Strategy (safer than interactive rebase for HEAD-only):
    //      a. git reset --soft HEAD^   (uncommit, keep index + working tree intact)
    //      b. for each dropped file: git checkout HEAD -- <file>
    //         (at this point HEAD is the parent; restore parent's content
    //         in both index and working tree — effectively removing the
    //         file's changes from the to-be-amended commit).
    //      c. if all files were kept, re-commit as `git commit -C <hash>`.
    //         If all files were dropped, the staging area equals parent →
    //         HEAD is already at the parent; we simply don't create a new
    //         commit (the original is gone).
    try {
      await this._gitCli.exec(['reset', '--soft', 'HEAD^'], { cwd, throwOnError: true });

      if (droppedPaths.length > 0) {
        await this._gitCli.exec(['checkout', 'HEAD', '--', ...droppedPaths], {
          cwd,
          throwOnError: true,
        });
      }

      if (keptPaths.length > 0) {
        // Re-commit with original author + message from the saved hash.
        await this._gitCli.exec(['commit', '-C', hash], { cwd, throwOnError: true });
        void vscode.window.showInformationMessage(
          `Dropped ${droppedPaths.length} file(s) from ${shortHash}`
        );
      } else {
        // Every file dropped → the commit effectively disappears. HEAD
        // is already at the parent after the soft-reset + checkout pair.
        void vscode.window.showInformationMessage(
          `Removed commit ${shortHash} (all ${droppedPaths.length} file(s) dropped).`
        );
      }
      // Synchronously reload before refresh so panel sees fresh
      // `repo.head.commit` (history rewrite moved HEAD).
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to drop changes: ${sanitizeGitError(msg)}`);
    }
  }

  /**
   * Return true when the given commit is reachable from any remote-tracking
   * branch — i.e., someone has already pushed it somewhere.
   *
   * Uses `git branch --contains <hash> --remotes`. An empty output means
   * no remote branch contains the commit, so it's safe to rewrite.
   */
  private async _isCommitPushed(cwd: string, hash: string): Promise<boolean> {
    try {
      const res = await this._gitCli.exec(['branch', '--remotes', '--contains', hash], { cwd });
      if (res.exitCode !== 0) {
        // Be conservative — if the query failed, assume pushed so we don't
        // rewrite anything the user might regret.
        return true;
      }
      return res.stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Copy the full SHA(s) to the system clipboard.
   *
   * N=1 (legacy): one hash, no newline.
   * N>=2 joins hashes with `\n` so a paste into a shell or
   * editor lands them as a vertical list. Order is preserved as supplied
   * (newest-first per the webview's DOM order).
   */
  private async _handleCopyHash(commitHashes: string[]): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }

    try {
      const text = commitHashes.length === 1 ? commitHashes[0] : commitHashes.join('\n');
      await vscode.env.clipboard.writeText(text);
      const message =
        commitHashes.length === 1
          ? `Copied commit hash: ${commitHashes[0]}`
          : `Copied ${commitHashes.length} commit hashes to clipboard`;
      void vscode.window.showInformationMessage(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to copy hash: ${sanitizeGitError(errorMessage)}`);
    }
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
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    // Display order (newest-first) → replay order
    // (oldest-first). Slice first so we don't mutate the caller's array.
    const replayOrder = [...commitHashes].reverse();

    try {
      const result = await this._gitService.cherryPick(repo, replayOrder);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked ${commitHashes.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog. Falls back to the
        // legacy toast if conflictResolutionService isn't wired yet.
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
              await this._gitService.cherryPickAbort(repo);
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
   * Stash dirty working tree if needed, returning whether a stash was created.
   * Refuses to stash if there are unmerged files (returns false and shows error).
   */
  private async _stashIfDirty(cwd: string): Promise<{ stashed: boolean; blocked: boolean }> {
    const statusResult = await this._gitCli.exec(['status', '--porcelain'], { cwd });
    const hasChanges = statusResult.stdout.trim().length > 0;
    if (!hasChanges) {
      return { stashed: false, blocked: false };
    }
    const statusLines = statusResult.stdout.trim().split('\n');
    const hasUnmerged = statusLines.some(
      (l) =>
        l.startsWith('U') ||
        l.startsWith('AA') ||
        l.startsWith('DD') ||
        (l.length > 1 && l.charAt(1) === 'U')
    );
    if (hasUnmerged) {
      return { stashed: false, blocked: true };
    }
    await this._gitCli.exec(
      ['stash', 'push', '--include-untracked', '-m', 'Auto-stash before git operation'],
      { cwd, throwOnError: true }
    );
    return { stashed: true, blocked: false };
  }

  /**
   * Pop the stash if one was created.
   */
  private async _unstash(cwd: string): Promise<void> {
    try {
      await this._gitCli.exec(['stash', 'pop'], { cwd });
    } catch {
      // Leave in stash if pop fails
    }
  }

  /**
   * Pop the stash on the success path of a
   * destructive operation (drop / squash) and surface a distinct toast
   * if it fails. The plain {@link _unstash} helper swallows errors by
   * design; on the success path that's misleading because the user
   * sees "Squashed N commits successfully" but their stashed working
   * changes silently stay in the stash list.
   *
   * Single source of truth so drop-multi and squash-multi share the
   * same phrasing — the drop path previously inlined this logic and the
   * squash path used the silent helper.
   *
   * Single-commit handlers (drop, edit-commit-message) keep their
   * existing `_unstash` shape; the follow-up TODO tracks adopting
   * this helper there too.
   */
  private async _unstashWithErrorReport(cwd: string, opName: string): Promise<void> {
    try {
      const popResult = await this._gitCli.exec(['stash', 'pop'], { cwd });
      if (popResult.exitCode !== 0) {
        const stderr = (popResult.stderr || popResult.stdout || '').trim();
        void vscode.window.showWarningMessage(
          `${opName} succeeded but failed to restore stash: ${sanitizeGitError(stderr || 'unknown stash pop failure')}`
        );
      }
    } catch (unstashErr) {
      const msg = unstashErr instanceof Error ? unstashErr.message : 'Unknown error';
      void vscode.window.showWarningMessage(
        `${opName} succeeded but failed to restore stash: ${sanitizeGitError(msg)}`
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
  private async _promptForSquashMessage(
    seedMessage: string,
    commitCount: number
  ): Promise<string | undefined> {
    // Build the tempfile path. The `.git/COMMIT_EDITMSG`-style suffix
    // makes some VS Code installs apply git-commit highlighting
    // automatically.
    //
    // Append 8 random hex chars to the name so two
    // squash dialogs opened in the same millisecond on the same PID
    // (background flow + user re-trigger) don't collide on the
    // tempfile path.
    const tmpDir = os.tmpdir();
    const rand = crypto.randomBytes(4).toString('hex');
    const tmpPath = path.join(
      tmpDir,
      `intellig-squash-${process.pid}-${Date.now()}-${rand}-COMMIT_EDITMSG`
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
        'Multi-line squash editor unavailable; using single-line fallback.'
      );
      return this._squashMessageInputBoxFallback(seedMessage, commitCount);
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    } catch {
      // Same fallback as above — VS Code refused to open the tempfile.
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      void vscode.window.showInformationMessage(
        'Multi-line squash editor unavailable; using single-line fallback.'
      );
      return this._squashMessageInputBoxFallback(seedMessage, commitCount);
    }

    // Open beside the active column so the squash
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
              `Squash cancelled — message was saved to ${saved.uri.fsPath} instead of being applied. Re-run Squash if you want to use that text.`
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
    // squash tab specifically; falls through gracefully when the tab
    // is already gone (e.g. user closed it manually).
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      const squashTab = tabs.find(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.toString() === document.uri.toString()
      );
      if (squashTab) {
        await vscode.window.tabGroups.close(squashTab);
      }
    } catch {
      // Tab already gone — fine.
    }
    try {
      fs.unlinkSync(tmpPath);
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
   * `_promptForSquashMessage`. Extracted so the two failure sites
   * (tempfile write fail, openTextDocument fail) share one implementation.
   * The caller is expected to surface the heads-up info toast before
   * delegating here.
   */
  private async _squashMessageInputBoxFallback(
    seedMessage: string,
    commitCount: number
  ): Promise<string | undefined> {
    const fallback = await vscode.window.showInputBox({
      value: seedMessage,
      prompt: `Squashed commit message (${commitCount} commits)`,
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
   * T2-04 — when a single commit is passed AND it touches more than one
   * file, show a multi-select QuickPick so the user can deselect files
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
  private async _handleRevert(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    // Selective-file revert is only offered on single-commit reverts.
    if (commitHashes.length === 1) {
      const outcome = await this._runSelectiveRevertIfApplicable(repo, commitHashes[0]);
      if (outcome === 'handled') {
        // selective-revert runs `git commit` internally (mutates
        // HEAD); reload before refresh so panel sees fresh state.
        await this._gitService.reloadRepository(repo);
        this._gitToolWindowProvider.refresh();
        return;
      }
      if (outcome === 'cancelled') {
        // User cancelled at the file-picker — no-op, no toast.
        return;
      }
      // `fallThrough` → drop into the standard revert path below.
    }

    try {
      // `commitHashes` arrives newest-first (DOM order). For
      // revert, that IS the right direction: undoing the most recent
      // change first means each subsequent revert applies to a tree the
      // user can mentally check against the displayed log. Cherry-pick
      // reverses; revert does not. ADR follows the contract.
      const result = await this._gitService.revert(repo, commitHashes);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Reverted ${commitHashes.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog. Falls back to the
        // legacy toast if conflictResolutionService isn't wired yet.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'revert',
            target: commitHashes[0].substring(0, 8),
          });
        } else {
          const choice = await vscode.window.showWarningMessage(
            `Revert conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`,
            'Open Conflicts',
            'Abort Revert'
          );
          if (choice === 'Open Conflicts') {
            for (const filePath of result.conflicts) {
              const fileUri = vscode.Uri.joinPath(repo.rootUri, filePath);
              await vscode.commands.executeCommand('vscode.open', fileUri);
            }
          } else if (choice === 'Abort Revert') {
            try {
              await this._gitService.revertAbort(repo);
              void vscode.window.showInformationMessage('Revert aborted.');
            } catch (abortError) {
              const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
              void vscode.window.showErrorMessage(
                `Failed to abort revert: ${sanitizeGitError(abortMsg)}`
              );
            }
          }
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to revert: ${sanitizeGitError(reason)}`);
      }
      // Synchronously reload before refresh so panel sees fresh
      // `repo.head.commit` after the revert.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to revert: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Implements the T2-04 selective-file revert QuickPick.
   *
   * Return value:
   *  - `'fallThrough'` — no prompt shown (single-file commit, or diff
   *    lookup failed); the caller should run the normal revert path.
   *  - `'cancelled'`   — user pressed Esc at the QuickPick; caller should
   *    return without showing any toast.
   *  - `'handled'`     — selective revert ran (partial or full); caller
   *    should skip the normal revert path.
   */
  private async _runSelectiveRevertIfApplicable(
    repo: IRepository,
    hash: string
  ): Promise<'fallThrough' | 'cancelled' | 'handled'> {
    let diffs;
    try {
      diffs = await this._gitService.getCommitDiff(repo, hash);
    } catch {
      return 'fallThrough';
    }
    if (!diffs || diffs.length <= 1) {
      // Nothing meaningful to deselect — normal revert.
      return 'fallThrough';
    }

    const items = diffs.map((d) => ({
      label: d.path,
      description: d.status,
      picked: true,
      path: d.path,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Revert ${hash.substring(0, 8)} — choose files to include`,
      placeHolder: 'Deselect files to keep their changes intact',
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picked) {
      return 'cancelled';
    }
    if (picked.length === 0) {
      void vscode.window.showInformationMessage('No files selected — revert skipped.');
      return 'handled';
    }

    const pickedPaths = new Set(picked.map((p) => p.path));
    const excludedPaths = diffs.map((d) => d.path).filter((p) => !pickedPaths.has(p));

    if (excludedPaths.length === 0) {
      // User kept everything — fall through to the standard flow.
      return 'fallThrough';
    }

    // Partial revert via the `git revert -n` plumbing.
    const cwd = repo.rootUri.fsPath;
    try {
      await this._gitCli.exec(['revert', '-n', hash], { cwd, throwOnError: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to start selective revert: ${sanitizeGitError(msg)}`
      );
      return 'handled';
    }

    // Undo the staged revert for each excluded file — this restores the
    // file to its HEAD (pre-revert-attempt) state in both index and
    // working tree, so only the user's picked files remain reverted.
    try {
      await this._gitCli.exec(['checkout', 'HEAD', '--', ...excludedPaths], {
        cwd,
        throwOnError: true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      // Best-effort abort so the working tree isn't half-reverted.
      try {
        await this._gitService.revertAbort(repo);
      } catch {
        // swallow; the primary error below is what the user needs to see
      }
      void vscode.window.showErrorMessage(
        `Failed to exclude files from revert: ${sanitizeGitError(msg)}. Revert aborted.`
      );
      return 'handled';
    }

    // Finalize the commit.
    let subject = hash.substring(0, 8);
    try {
      const commit = await this._gitService.getCommit(repo, hash);
      if (commit.message) {
        subject = commit.message.split('\n')[0];
      }
    } catch {
      // Keep short-hash fallback.
    }
    const commitMessage = `Revert "${subject}"\n\nThis reverts parts of commit ${hash}.`;
    try {
      await this._gitCli.exec(['commit', '-m', commitMessage], { cwd, throwOnError: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to commit partial revert: ${sanitizeGitError(msg)}`
      );
      return 'handled';
    }

    void vscode.window.showInformationMessage(
      `Reverted ${pickedPaths.size} of ${diffs.length} file(s) from ${hash.substring(0, 8)}`
    );
    return 'handled';
  }

  /**
   * Checkout the selected commit in detached HEAD mode.
   * Uses the stash/force fallback pattern from BranchContextMenuCommands.
   */
  private async _handleCheckoutRevision(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      await this._gitService.checkout(repo, hash);
      // Synchronously reload after checkout so the panel reload
      // runs against fresh `repo.head.commit` (the user's stated bug).
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Checked out revision ${hash.substring(0, 8)} (detached HEAD)`
      );
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes')
      ) {
        const choice = await vscode.window.showWarningMessage(
          `Cannot checkout revision: local changes would be overwritten.`,
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(
              repo,
              `Auto-stash before checkout ${hash.substring(0, 8)}`
            );
            await this._gitService.checkout(repo, hash);
            // Reload after the stash + checkout pair so panel
            // reload sees fresh `repo.head.commit`.
            await this._gitService.reloadRepository(repo);
            void vscode.window.showInformationMessage(
              `Stashed changes and checked out revision ${hash.substring(0, 8)} (detached HEAD)`
            );
            this._gitToolWindowProvider.refresh();
          } catch (stashError) {
            const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
            void vscode.window.showErrorMessage(
              `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
            );
          }
        } else if (choice === 'Force Checkout') {
          try {
            await this._gitService.checkout(repo, hash, { force: true });
            // Reload after force checkout.
            await this._gitService.reloadRepository(repo);
            void vscode.window.showInformationMessage(
              `Force checked out revision ${hash.substring(0, 8)} (detached HEAD)`
            );
            this._gitToolWindowProvider.refresh();
          } catch (forceError) {
            const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
            void vscode.window.showErrorMessage(
              `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
            );
          }
        }
      } else {
        void vscode.window.showErrorMessage(
          `Failed to checkout revision: ${sanitizeGitError(errorMessage)}`
        );
      }
    }
  }

  /**
   * Reset the current branch to the selected commit.
   * Opens the T1-11 ResetDialog (webview-based 4-mode picker with
   * protected-branch guard and single destructive-op confirm).
   */
  private async _handleResetToHere(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }
    if (!this._context) {
      // Should not happen in production — register() wires this — but
      // guard defensively so tests that skip register() don't crash.
      void vscode.window.showErrorMessage(
        'Reset dialog is unavailable: extension context not initialised.'
      );
      return;
    }

    const hash = commitHashes[0];

    // Resolve commit subject for the dialog header; fall back to empty.
    let subject = '';
    try {
      const commit = await this._gitService.getCommit(repo, hash);
      subject = commit.message.split('\n')[0];
    } catch {
      // Leave subject blank — dialog still renders.
    }

    const currentBranch = this._extractBranchName(repo.head?.name) ?? '';
    const protectedBranches = this._readProtectedBranches();

    showResetDialog(this._context, {
      repo,
      target: { hash, subject },
      currentBranch,
      protectedBranches,
      gitService: this._gitService,
      onResetComplete: () => {
        // fire-and-forget reload before refresh so panel sees
        // fresh `repo.head.commit` after the dialog's resetToCommit. The
        // callback can't be async (dialog API constraint), so we
        // sequence reload → refresh inside an IIFE; the watcher's
        // debounced reload remains as a fallback.
        void (async (): Promise<void> => {
          await this._gitService.reloadRepository(repo);
          this._gitToolWindowProvider.refresh();
        })();
      },
    });
  }

  /**
   * Convert a refspec like `refs/heads/main` to its short branch name (`main`).
   * Returns undefined for detached HEAD / falsy input.
   */
  private _extractBranchName(ref: string | undefined): string | undefined {
    if (!ref) {
      return undefined;
    }
    return ref.replace(/^refs\/heads\//, '');
  }

  /**
   * Read `intellig.protectedBranches` from configuration.
   */
  private _readProtectedBranches(): string[] {
    const cfg = vscode.workspace.getConfiguration('intellig');
    const value = cfg.get<string[]>('protectedBranches', ['main', 'master']);
    return Array.isArray(value) ? value.filter((s) => typeof s === 'string') : [];
  }

  /**
   * Generate patch file(s) from the selected commit(s).
   *
   * Single-commit (N=1): legacy flow — `git format-patch -1 <hash>
   * --stdout` to a temp buffer, then `vscode.window.showSaveDialog` for
   * the destination, then `atomicWriteFile`.
   *
   * Multi-commit (N>=2) flow.
   *   - User picks a directory (`vscode.window.showOpenDialog` with
   *     `canSelectFolders=true`).
   *   - We classify the selection: "contiguous" iff the commits land on
   *     consecutive display indices in `commitNodes`. The display order
   *     is newest-first, so contiguous means there are no gaps in the
   *     index range from min to max selected.
   *   - Contiguous: `git format-patch <oldest>^..<newest> -o <dir>`. git
   *     emits one numbered `.patch` per commit in topological order.
   *   - Non-contiguous: `git format-patch -o <dir> <oldest> ... <newest>`
   *     (each hash is a separate `-1` style invocation under the hood;
   *     git produces N numbered patches, one per supplied commit).
   *   - In both modes git writes the files itself, so the host doesn't
   *     do per-file I/O — a partial mid-write failure leaves the dir
   *     state coherent (failed patches just aren't there).
   */
  private async _handleCreatePatch(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }
    // defence-in-depth hash regex.
    if (!allHashesValid(commitHashes)) {
      return;
    }

    if (commitHashes.length >= 2) {
      await this._handleCreatePatchMulti(repo, commitHashes, commitNodes);
      return;
    }

    const hash = commitHashes[0];

    let stdout: string;
    try {
      const result = await this._gitCli.exec(['format-patch', '-1', hash, '--stdout'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      });
      stdout = result.stdout;
    } catch (error) {
      // git exec failure — keep the historical "Failed to create patch"
      // phrasing so existing tests + docs still match.
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to create patch: ${sanitizeGitError(errorMessage)}`
      );
      return;
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${hash.substring(0, 8)}.patch`),
      filters: { 'Patch Files': ['patch'], 'All Files': ['*'] },
    });

    if (!saveUri) {
      return;
    }

    // Route the user-picked save through atomicWriteFile so a partial
    // write (EBUSY on a Windows-locked file, ENOSPC on a full disk,
    // process kill mid-flight) never leaves a truncated `.patch`
    // file — `git apply`/`git am` would silently fail downstream on junk.
    // Write error is caught separately from the git exec error above so
    // a write-only failure can't be masked by a git-exec error path in
    // future refactors.
    try {
      await atomicWriteFile(saveUri.fsPath, stdout);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to write patch: ${sanitizeGitError(raw)}`);
      return;
    }
    // Clickable "Open Folder" affordance (IntelliJ parity).
    void this._toastPatchSavedSingle(saveUri.fsPath);
  }

  /**
   * Multi-commit `format-patch` driver. See
   * {@link _handleCreatePatch} for the contract.
   *
   * Consumes the typed `commitNodes` payload (newest-
   * first `IMenuStateNode[]`) and derives `displayOrder` + parent
   * lookups from it, replacing the prior parallel records.
   *
   * See ADR-009 §6 for the display-order vs replay-
   * order contract; `getSelectedCommitsOldestFirst()` is the
   * programmatic-caller equivalent of the dispatch payload.
   *
   * Fixes (preserved):
   *   - Every commitHash MUST resolve in displayOrder; abort
   *     with the toast otherwise (no silent drop).
   *   - When oldest is the initial commit (parents=0),
   *     `<oldest>^..` doesn't resolve. Switch to positional fallback.
   *   - Contiguity check delegates to `isSelectionContiguous`
   *     from `multiSelect.ts` (no inline `indices.every` reimpl).
   *   - Takes `commitNodes` directly via the dispatch event,
   *     no `getExtendedLogState()` call.
   *   - Success toast offers "Open Folder" via
   *     `revealFileInOS`.
   */
  private async _handleCreatePatchMulti(
    repo: IRepository,
    commitHashes: readonly string[],
    commitNodes: readonly IMenuStateNode[]
  ): Promise<void> {
    // Derive `displayOrder` from the typed nodes.
    const displayOrder = commitNodes.map((n) => n.hash);

    // Every commitHash MUST be in displayOrder. The
    // host already validates against commitNodes; this is the
    // belt-and-suspenders mirror at the handler boundary.
    const inOrder = new Set(displayOrder);
    const stale = commitHashes.filter((h) => !inOrder.has(h));
    if (stale.length > 0) {
      void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
      return;
    }

    // Project to display indices for contiguity + range-form bounds.
    const indexByHash = new Map<string, number>();
    for (let i = 0; i < displayOrder.length; i++) {
      indexByHash.set(displayOrder[i], i);
    }
    const indices = commitHashes
      .map((h) => indexByHash.get(h))
      .filter((i): i is number => i !== undefined)
      .slice()
      .sort((a, b) => a - b);
    // Display order (newest-first): smallest index = newest commit.
    const newestIdx = indices[0];
    const oldestIdx = indices[indices.length - 1];
    const newestHash = displayOrder[newestIdx];
    const oldestHash = displayOrder[oldestIdx];

    // Delegate contiguity to the multiSelect helper.
    const isContiguous = isSelectionContiguous(new Set(commitHashes), displayOrder);

    // `<oldest>^..` fails when oldest is the initial
    // commit (no parent → `oldest^` doesn't resolve). Detect via the
    // event-supplied commitNodes and fall through to the positional
    // form, which uses each hash standalone and tolerates initial-commit.
    const oldestParents = commitNodes.find((n) => n.hash === oldestHash)?.parentCount ?? 1;
    const useRangeForm = isContiguous && oldestParents > 0;

    // Ask the user once for the destination directory.
    const dirChoice = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Save Patches Here',
      title: `Choose a folder for ${commitHashes.length} patch files`,
    });
    if (!dirChoice || dirChoice.length === 0) {
      // Quiet abort — the user cancelled.
      return;
    }
    const outDir = dirChoice[0].fsPath;

    // Build the format-patch argv. Output flag first so range / positional
    // code paths share the same prefix.
    const argv = ['format-patch', '-o', outDir];
    if (useRangeForm) {
      // <oldest>^..<newest> emits one .patch per commit in the range,
      // numbered topologically (oldest-first). `^..` = "from oldest's
      // parent up to newest inclusive."
      argv.push(`${oldestHash}^..${newestHash}`);
    } else {
      // Declarative one-liner replaces the earlier
      // walk-through comment block. Sort descending by display index
      // → oldest-first replay order (newest-first display means
      // larger index = older).
      const positional = [...commitHashes]
        .filter((h) => indexByHash.has(h))
        .sort((a, b) => (indexByHash.get(b) ?? 0) - (indexByHash.get(a) ?? 0));
      argv.push(...positional);
    }

    try {
      const result = await this._gitCli.exec(argv, {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      });
      // git format-patch prints the path of each emitted file on stdout,
      // one per line. Count non-empty lines to surface "wrote N patches".
      const written = result.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
      void this._toastPatchSavedMulti(outDir, written || commitHashes.length);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to create patches: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Show the success toast with a clickable "Open
   * Folder" action that reveals the patch file in the host OS file
   * manager (Finder / Explorer / xdg-open). IntelliJ parity.
   */
  private async _toastPatchSavedSingle(filePath: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Patch saved to ${filePath}`,
      'Open Folder'
    );
    if (choice === 'Open Folder') {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    }
  }

  /**
   * multi-commit success toast variant.
   */
  private async _toastPatchSavedMulti(outDir: string, count: number): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Wrote ${count} patch file(s) to ${outDir}`,
      'Open Folder'
    );
    if (choice === 'Open Folder') {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
    }
  }

  /**
   * Open a diff comparison between the selected commit and the current working tree.
   * Lists changed files and opens the diff for each.
   */
  private async _handleCompareWithLocal(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const diffs = await this._gitService.getCommitDiff(repo, hash);
      if (diffs.length === 0) {
        void vscode.window.showInformationMessage('No changes found in this commit.');
        return;
      }

      // Open the first file's diff as a starting point.
      // The `intellig-git:` TextDocumentContentProvider (registered in
      // extension.ts::registerGitContentProvider) reads the URI query as the
      // raw, URL-encoded git ref. Prior shape used the unregistered
      // `git-show:` scheme with a JSON query, causing VS Code to fail to
      // resolve the left-hand side of the diff (user-reported crash).
      const firstDiff = diffs[0];
      const commitUri = vscode.Uri.parse(
        `intellig-git:${firstDiff.path}?${encodeURIComponent(hash)}`
      );
      const localUri = vscode.Uri.joinPath(repo.rootUri, firstDiff.path);

      await vscode.commands.executeCommand(
        'vscode.diff',
        commitUri,
        localUri,
        `${firstDiff.path} (${hash.substring(0, 8)} ↔ Working Tree)`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to compare with local: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Compare Versions: open `vscode.diff` between the two
   * selected commits.
   *
   * Reuses the `intellig-git:` `TextDocumentContentProvider` already
   * registered for `_handleCompareWithLocal` so both diff flows share
   * one URI scheme. The provider reads the URI query as the
   * URL-encoded git ref; we hand it the OLDEST hash on the LHS and the
   * NEWEST hash on the RHS (matches IntelliJ's "Compare Versions"
   * direction — older on the left, newer on the right).
   *
   * Action visibility / enable is gated host-side by `computeMenuState`
   * (visible AND enabled iff N=2). This handler only runs when the
   * gating allows it; defensive `length !== 2` no-op so a stale
   * dispatch can't crash.
   */
  private async _handleCompareVersions(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    if (commitHashes.length !== 2) {
      // Should never happen — the menu gating ensures N=2 — but stay
      // quiet rather than throw on a stale dispatch.
      return;
    }
    // defence-in-depth hash regex (cap raised to 64
    // for SHA-256 support).
    if (!allHashesValid(commitHashes)) {
      return;
    }
    const repo = await this._getRepository();
    if (!repo) {
      return;
    }

    // Derive displayOrder from the typed nodes.
    const displayOrder = commitNodes.map((n) => n.hash);

    // Symmetry with `_handleCreatePatchMulti`: every
    // commitHash must be in commitNodes. Without this guard a hex-format
    // hash that isn't in the rendered log slips past the regex check
    // and `git diff <bad>..<good>` produces a noisy "fatal: bad
    // revision" toast instead of the cleaner stale-selection phrasing.
    const inOrder = new Set(displayOrder);
    const stale = commitHashes.filter((h) => !inOrder.has(h));
    if (stale.length > 0) {
      void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
      return;
    }

    // The webview hands hashes in newest-first display order. See
    // ADR-009 §5 (selection mutations come in two flavours) and the
    // WARNING on `getSelectedCommits()` for the contract:
    // newest-first is the canonical projection from the rendered log.
    // Project against the dispatched
    // commitNodes instead of `getExtendedLogState()` so the handler
    // stays decoupled from provider state.
    //
    // The dispatcher already aborts
    // upstream when a hash isn't in the rendered commitNodes, AND the
    // in-order guard immediately above also catches it; the swap-
    // fallback that lived here earlier is dead. Webview-driven dispatches
    // see the dispatcher guard plus the in-order check; an external caller passing
    // default `commitNodes = []` will see EVERY hash as stale and get
    // the stale-selection toast — they must supply a non-empty
    // `commitNodes: readonly IMenuStateNode[]` covering both targeted
    // hashes. The canonical projection lives in
    // `GitToolWindowProvider._handleCommitContextMenu`, which maps
    // `getExtendedLogState().commitNodes` to
    // `{hash, parentCount: parents.length}` per node; programmatic
    // callers should mirror that projection (or call into the same
    // routing path). The idx0 / idx1 projection here only runs after
    // both guards, so both indices are guaranteed found.
    const idx0 = displayOrder.indexOf(commitHashes[0]);
    const idx1 = displayOrder.indexOf(commitHashes[1]);
    // Larger display index = older commit.
    const oldHash = idx0 > idx1 ? commitHashes[0] : commitHashes[1];
    const newHash = idx0 > idx1 ? commitHashes[1] : commitHashes[0];

    // `git diff --name-only oldHash..newHash`
    // gives ONLY the changes from oldHash to newHash, the right
    // semantic for "compare these two commits". The earlier path used
    // `getMultiCommitDiff` which returns CUMULATIVE changes across all
    // listed commits — wrong for non-adjacent endpoints where the user
    // explicitly skipped the intermediates.
    const result = await this._gitCli.exec(['diff', '--name-only', `${oldHash}..${newHash}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: false,
    });

    // Propagate failure as a sanitised toast instead
    // of silently returning undefined.
    if (result.exitCode !== 0) {
      const stderr = (result.stderr || result.stdout || 'git diff failed').trim();
      void vscode.window.showErrorMessage(
        `Failed to compare versions: ${sanitizeGitError(stderr)}`
      );
      return;
    }

    const firstFile = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)[0];
    if (!firstFile) {
      void vscode.window.showInformationMessage(
        `No file changes between ${oldHash.substring(0, 8)} and ${newHash.substring(0, 8)}.`
      );
      return;
    }
    const lhs = vscode.Uri.parse(`intellig-git:${firstFile}?${encodeURIComponent(oldHash)}`);
    const rhs = vscode.Uri.parse(`intellig-git:${firstFile}?${encodeURIComponent(newHash)}`);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        lhs,
        rhs,
        `${firstFile} (${oldHash.substring(0, 8)} ↔ ${newHash.substring(0, 8)})`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to compare versions: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Show the repository file tree at the selected commit revision.
   * Opens the commit's changed files list so the user can browse the state at that point.
   */
  private async _handleShowRepoAtRevision(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const result = await this._gitCli.exec(['ls-tree', '--name-only', '-r', hash], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      });

      const files = result.stdout
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('No files found at this revision.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f, description: hash.substring(0, 8) })),
        {
          title: `Repository at ${hash.substring(0, 8)}`,
          placeHolder: 'Select a file to view',
          matchOnDescription: true,
        }
      );

      if (selected) {
        // See `_handleCompareWithLocal` above for why this uses the
        // `intellig-git:` scheme with a URL-encoded ref in the query.
        const fileUri = vscode.Uri.parse(
          `intellig-git:${selected.label}?${encodeURIComponent(hash)}`
        );
        await vscode.commands.executeCommand('vscode.open', fileUri);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to show repository at revision: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Undo the selected commit by performing a soft reset to its parent.
   * Only works if the selected commit is the HEAD commit.
   */
  private async _handleUndoCommit(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    const headHash = repo.head?.commit;

    if (!headHash || hash !== headHash) {
      void vscode.window.showErrorMessage('Undo Commit can only be performed on the HEAD commit.');
      return;
    }

    try {
      await this._gitCli.exec(['reset', '--soft', 'HEAD~1'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      });

      void vscode.window.showInformationMessage('Commit undone. Changes restored to staging area.');
      // soft-reset moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to undo commit: ${sanitizeGitError(errorMessage)}`
      );
    }
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
  private async _handleDropCommit(
    commitHashes: string[],
    commitNodes: readonly IMenuStateNode[] = []
  ): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }

    // hash-format validation and initial-commit
    // guards apply to BOTH the single- and multi-commit drop paths. Lift
    // them above the N>=2 routing so palette / scripted entry points
    // hitting either branch get the same defence-in-depth.
    if (!allHashesValid(commitHashes)) {
      return;
    }
    // Initial-commit edge: dropping the initial commit means
    // `<hash>~1` (single) or `<oldest>^` (multi) doesn't resolve.
    // Check the oldest selected (last in newest-first display order).
    if (commitNodes.length > 0) {
      const indices = commitHashes
        .map((h) => commitNodes.findIndex((n) => n.hash === h))
        .filter((i) => i >= 0);
      if (indices.length > 0) {
        const oldestIdx = Math.max(...indices);
        if (commitNodes[oldestIdx].parentCount === 0) {
          void vscode.window.showErrorMessage(
            'Cannot drop the initial commit — use `git update-ref -d HEAD` to reset the branch instead.'
          );
          return;
        }
      }
    }

    // N>=2 routes to the multi-commit drop flow. Single
    // entry point keeps the dispatcher simple and preserves the
    // dispatch-property invariant.
    if (commitHashes.length >= 2) {
      await this._handleDropCommitMulti(commitHashes, commitNodes);
      return;
    }

    const repo = await this._getRepository();
    if (!repo) {
      return;
    }

    const hash = commitHashes[0];
    const cwd = repo.rootUri.fsPath;

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

    try {
      const { stashed, blocked } = await this._stashIfDirty(cwd);
      if (blocked) {
        void vscode.window.showErrorMessage(
          'Cannot drop commit while you have unmerged files. Please resolve conflicts first.'
        );
        return;
      }

      try {
        const session = await this._rebaseService.startInteractiveRebase(repo, `${hash}~1`);

        const targetCommit = session.commits.find(
          (c) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
        );
        if (!targetCommit) {
          void vscode.window.showErrorMessage(
            `Commit ${hash.substring(0, 8)} not found in rebase session.`
          );
          await this._rebaseService.abortRebase(repo);
          if (stashed) {
            await this._unstash(cwd);
          }
          return;
        }

        this._rebaseService.updateRebasePlan(
          repo,
          session.commits.map((c) =>
            c.hash === targetCommit.hash
              ? { hash: c.hash, action: 'drop' as const }
              : { hash: c.hash, action: c.action }
          )
        );

        const result = await this._rebaseService.executeRebase(repo);

        if (result.success) {
          void vscode.window.showInformationMessage(`Dropped commit ${hash.substring(0, 8)}`);
        } else if (result.conflictedFiles && result.conflictedFiles.length > 0) {
          await this._rebaseService.abortRebase(repo);
          if (stashed) {
            await this._unstash(cwd);
          }
          void vscode.window.showWarningMessage(
            `Drop commit conflicts in ${result.conflictedFiles.length} file(s). The operation has been aborted.`
          );
          // Abort moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._gitToolWindowProvider.refresh();
          return;
        }
      } catch (opError) {
        if (stashed) {
          await this._unstash(cwd);
        }
        throw opError;
      }

      if (stashed) {
        await this._unstash(cwd);
      }
      // drop-via-rebase moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
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
   *   6. Stash dirty working tree if needed (mirrors single-drop).
   *   7. Start interactive rebase onto `oldest^`. Build the plan: every
   *      commit in the rebase window stays `pick` unless its hash is in
   *      the selected set, which becomes `drop`.
   *   8. Execute. On success, refresh + toast. On conflict, abort
   *      the rebase + unstash, then route the conflict files through
   *      `_openResolveConflictsDialog(operation: 'rebase', target: 'drop')`.
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
    const repo = await this._getRepository();
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

    // 4. Initial-commit edge — `oldest^` cannot resolve.
    const oldestParents = commitNodes[oldestIdx].parentCount;
    if (oldestParents === 0) {
      void vscode.window.showErrorMessage(
        'Cannot drop the initial commit — use `git update-ref -d HEAD` to reset the branch instead.'
      );
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

    const cwd = repo.rootUri.fsPath;
    let stashed = false;

    try {
      // 6. Stash dirty tree.
      const stashResult = await this._stashIfDirty(cwd);
      stashed = stashResult.stashed;
      if (stashResult.blocked) {
        void vscode.window.showErrorMessage(
          'Cannot drop commits while you have unmerged files. Please resolve conflicts first.'
        );
        return;
      }

      try {
        // 7. Start interactive rebase onto `oldest^`. The rebase window
        // covers every commit reachable from HEAD that's newer than
        // oldestHash^ — including non-selected commits that must stay.
        const session = await this._rebaseService.startInteractiveRebase(repo, `${oldestHash}^`);

        // Build the plan: each commit in the session stays `pick`
        // unless its hash is in the selected drop set.
        const plan = session.commits.map((c) =>
          selectedSet.has(c.hash)
            ? { hash: c.hash, action: 'drop' as const }
            : { hash: c.hash, action: c.action }
        );

        // Empty rebase-window or partial-coverage
        // guard. If `getCommitsToRebase` returned fewer commits than
        // the user selected (the most plausible cause: a force-push
        // landed between dispatch and rebase, mutating reachable
        // history), the empty plan would `executeRebase` to a no-op
        // success and we'd surface a misleading "dropped N commits"
        // toast. Detect via "every selected hash must be a drop in
        // the plan"; toast STALE_SELECTION_TOAST and abort.
        // Compare against `selectedSet.size`, not
        // `commitHashes.length`. The webview never produces duplicate
        // hashes today, but a future palette / scripted entry point
        // might (e.g. a user pasting `[abc, abc]` from the clipboard).
        // Comparing against the deduped set size keeps the guard
        // robust without reading like a coincidence.
        const planDropCount = plan.filter((p) => p.action === 'drop').length;
        if (planDropCount < selectedSet.size) {
          void vscode.window.showWarningMessage(STALE_SELECTION_TOAST);
          await this._rebaseService.abortRebase(repo);
          return;
        }
        this._rebaseService.updateRebasePlan(repo, plan);

        const result = await this._rebaseService.executeRebase(repo);

        if (result.success) {
          void vscode.window.showInformationMessage(
            `Dropped ${commitHashes.length} commits successfully.`
          );
        } else if (result.conflictedFiles && result.conflictedFiles.length > 0) {
          // 8. Conflict path — abort + unstash, then hand off to the
          // resolve dialog with operation:'rebase', target:'drop'.
          await this._rebaseService.abortRebase(repo);
          if (stashed) {
            await this._unstash(cwd);
            stashed = false;
          }
          await this._openResolveConflictsDialog(repo, result.conflictedFiles, {
            operation: 'rebase',
            target: 'drop',
          });
          // abortRebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._gitToolWindowProvider.refresh();
          return;
        }
      } catch (opError) {
        if (stashed) {
          await this._unstash(cwd);
          stashed = false;
        }
        throw opError;
      }

      // Post-success unstash uses
      // the shared {@link _unstashWithErrorReport} helper so the drop
      // and squash success paths share the same phrasing.
      if (stashed) {
        await this._unstashWithErrorReport(cwd, 'Drop');
      }
      // multi-drop rebase moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
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
   *      first display order). Drop the parent-count check at this
   *      site — the squash UI gate already requires no merge commits,
   *      and a non-merge always has a parent.
   *   3. Fetch each selected commit's full message via `getCommit`. Join
   *      with `\n\n` to seed the message editor.
   *   4. Open `vscode.window.showInputBox` with the seed value. On
   *      cancel (undefined), abort with no git side-effects.
   *   5. Stash dirty tree. On unmerged-files block, error toast.
   *   6. Start rebase onto `oldest^`. Build the plan: oldest selected
   *      stays `pick` (it's the squash target); every other selected
   *      becomes `squash`; non-selected stays `pick`.
   *   7. Execute the rebase. When it pauses for the squash message,
   *      thread the user's chosen message via `provideSquashMessage`.
   *   8. Conflict path: abort + unstash + handoff to the resolve
   *      dialog with operation:'rebase', target:'squash'.
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
    const repo = await this._getRepository();
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
      // selection — previously a silent return.
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

    // 4. Show the squash-message editor. This previously
    // used `showInputBox`, which is single-line and rendered the
    // multi-line `\n\n`-joined seed with literal backslash-n. It now
    // switches to an untitled-style editor opened on a tempfile so
    // multi-line editing works naturally and `git-commit` syntax
    // highlighting kicks in. Cancel (close-without-save OR empty save)
    // aborts the flow with NO git side-effects.
    //
    // When `mode === 'fixup'` the editor step is
    // skipped — fixup semantics reuse the kept commit's message verbatim
    // (matching `git commit --fixup`). The kept commit is the OLDEST in
    // display order (the rebase plan keeps it as `pick`); its message
    // was loaded into the messages[0] slot above.
    let userMessage: string | undefined;
    if (mode === 'fixup') {
      // The oldest selected commit is at the start of `oldestFirst`, so
      // its message is `messages[0]`. In the entry path that is the
      // PARENT of the right-clicked commit. Falling back to the seed if
      // for any reason messages[0] is empty (e.g. getCommit failed and
      // the shortHash sentinel is in messages[0]) keeps the rebase
      // working rather than landing an empty message.
      userMessage = messages[0] && messages[0].length > 0 ? messages[0] : seedMessage;
    } else {
      // Heads-up toast so the user notices the side editor opening.
      // Without this, users routinely missed the message-editor tab
      // (it opens beside the active editor column, which is often
      // far from the bottom-panel-hosted Git tool window) and reported
      // the squash action as "no response".
      log.debug('squash: opening message editor', {
        commitCount: commitHashes.length,
      });
      void vscode.window.showInformationMessage(
        `Squash: editing combined message for ${commitHashes.length} commits. Save the editor tab to apply, or close it to cancel.`
      );
      userMessage = await this._promptForSquashMessage(seedMessage, commitHashes.length);
      if (userMessage === undefined) {
        log.debug('squash cancelled: user closed the message editor without saving');
        return;
      }
    }

    const cwd = repo.rootUri.fsPath;

    try {
      // 5. Stash dirty tree.
      const { stashed, blocked } = await this._stashIfDirty(cwd);
      if (blocked) {
        const verb = mode === 'fixup' ? 'fixup commits' : 'squash commits';
        void vscode.window.showErrorMessage(
          `Cannot ${verb} while you have unmerged files. Please resolve conflicts first.`
        );
        return;
      }

      try {
        // 6. Start interactive rebase onto oldest^.
        const session = await this._rebaseService.startInteractiveRebase(repo, `${oldestHash}^`);

        // Build the plan: oldest selected stays `pick` (the squash target);
        // every other selected becomes `squash`; non-selected stays `pick`.
        const plan = session.commits.map((c) => {
          if (!selectedSet.has(c.hash)) {
            return { hash: c.hash, action: c.action };
          }
          if (c.hash === oldestHash) {
            return { hash: c.hash, action: 'pick' as const };
          }
          return { hash: c.hash, action: 'squash' as const };
        });
        this._rebaseService.updateRebasePlan(repo, plan);

        // 7. Execute. The rebase pauses after squash steps to ask for
        // the combined message; we thread the user's chosen message
        // via `provideSquashMessage`.
        let result = await this._rebaseService.executeRebase(repo);
        if (result.status === 'paused') {
          result = await this._rebaseService.provideSquashMessage(repo, userMessage);
        }

        // `result.success` alone is not sufficient:
        // `RebaseService.amendEditCommit` returns `{success: true,
        // status: 'paused'}` when the amend lands but the rebase still
        // has more steps to run. Treating that as "squash done" surfaces
        // a misleading toast. Pin the success branch to `'completed'`
        // and route `'paused'` through a "partial" warning so the user
        // knows to resume manually.
        if (result.success && result.status === 'completed') {
          // Phrase the toast per mode so the user reads the
          // semantically correct verb ("Squashed" vs "Fixup'd"). Plurality
          // matches existing squash semantics: the count is the number of
          // commits that were combined.
          const verb = mode === 'fixup' ? "Fixup'd" : 'Squashed';
          void vscode.window.showInformationMessage(
            `${verb} ${commitHashes.length} commits successfully.`
          );
        } else if (result.status === 'paused') {
          const verbCap = mode === 'fixup' ? 'Fixup' : 'Squash';
          void vscode.window.showWarningMessage(
            `${verbCap} partially complete — resume via 'git rebase --continue' or abort via 'git rebase --abort'.`
          );
        } else if (result.conflictedFiles && result.conflictedFiles.length > 0) {
          // 8. Conflict path — abort + unstash + handoff.
          await this._rebaseService.abortRebase(repo);
          if (stashed) {
            await this._unstash(cwd);
          }
          await this._openResolveConflictsDialog(repo, result.conflictedFiles, {
            operation: 'rebase',
            target: 'squash',
          });
          // abortRebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._gitToolWindowProvider.refresh();
          return;
        }
      } catch (opError) {
        if (stashed) {
          await this._unstash(cwd);
        }
        throw opError;
      }

      // Squash success path now reports unstash
      // failures distinctly via {@link _unstashWithErrorReport}, mirroring
      // the drop path. The earlier silent `_unstash` would leave the user
      // believing the squash had restored their working changes.
      if (stashed) {
        await this._unstashWithErrorReport(cwd, mode === 'fixup' ? 'Fixup' : 'Squash');
      }
      // Squash rebase moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const verb = mode === 'fixup' ? 'fixup commits' : 'squash commits';
      void vscode.window.showErrorMessage(`Failed to ${verb}: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * IntelliJ-parity "Squash with Previous". Combines
   * the right-clicked commit with its first parent into a single commit
   * via the existing {@link _handleSquashCommits} pipeline. Synthesises
   * the 2-commit selection [clicked, parent] in newest-first display order
   * plus the matching `IMenuStateNode[]` so the contiguity / merge-commit
   * guards apply unchanged. The existing squash-message editor still runs
   * pre-rebase; the user can edit the seeded `clicked\n\nparent` message
   * before the rebase runs.
   *
   * Defence-in-depth checks before delegating:
   *   - Hash format valid (`HASH_RE`).
   *   - Commit lookup succeeds (otherwise we can't read parents).
   *   - Commit has at least one parent (root commit can't be squashed
   *     into anything).
   *   - Commit has at most one parent (merge commits are rejected — the
   *     existing `_handleSquashCommits` rejects them too, but we emit a
   *     friendlier per-action message here).
   */
  private async _handleSquashWithPrevious(commitHashes: string[]): Promise<void> {
    await this._handleSquashOrFixupWithPrevious(commitHashes, 'squash');
  }

  /**
   * IntelliJ-parity "Fixup with Previous". Same
   * shape as {@link _handleSquashWithPrevious} but routes through
   * `_handleSquashCommits` with `mode: 'fixup'` so the squash-message
   * editor is skipped and the parent's existing message is reused
   * verbatim — matching `git commit --fixup` semantics.
   */
  private async _handleFixupWithPrevious(commitHashes: string[]): Promise<void> {
    await this._handleSquashOrFixupWithPrevious(commitHashes, 'fixup');
  }

  /**
   * Shared body for {@link _handleSquashWithPrevious} and
   * {@link _handleFixupWithPrevious}. The two entry points differ only in
   * the mode flag passed to `_handleSquashCommits`.
   */
  private async _handleSquashOrFixupWithPrevious(
    commitHashes: string[],
    mode: 'squash' | 'fixup'
  ): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    if (!allHashesValid([hash])) {
      return;
    }

    let commit;
    try {
      commit = await this._gitService.getCommit(repo, hash);
    } catch {
      void vscode.window.showErrorMessage('Could not load commit information.');
      return;
    }

    if (!commit.parents || commit.parents.length === 0) {
      const verb = mode === 'fixup' ? 'fixup' : 'squash';
      void vscode.window.showErrorMessage(
        `Cannot ${verb} a root commit (no parent to ${verb} into).`
      );
      return;
    }
    if (commit.parents.length >= 2) {
      const verb = mode === 'fixup' ? 'fixup' : 'squash';
      const tail = mode === 'squash' ? ' Use "Drop Commit" to discard the merge.' : '';
      void vscode.window.showErrorMessage(`Cannot ${verb} a merge commit.${tail}`);
      return;
    }

    const parentHash = commit.parents[0];
    // The synthesised IMenuStateNode list mirrors the newest-first
    // commitHashes order — `_handleSquashCommits` indexes by hash and
    // computes `oldestIdx = max(indices)`, so the parent (older) lands
    // in the trailing slot and is kept as `pick`. Both nodes carry
    // `parentCount: 1` since the merge-commit guard already rejected
    // multi-parent inputs.
    const synthNodes: IMenuStateNode[] = [
      { hash, parentCount: 1 },
      { hash: parentHash, parentCount: 1 },
    ];
    await this._handleSquashCommits([hash, parentHash], synthNodes, { mode });
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
    const repo = await this._getRepository();
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
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    const cwd = repo.rootUri.fsPath;

    try {
      // Fetch the full commit message
      let fullMessage = '';
      try {
        const msgResult = await this._gitCli.exec(['log', '-1', '--format=%B', hash], { cwd });
        if (msgResult.exitCode === 0 && msgResult.stdout.trim()) {
          fullMessage = msgResult.stdout.trim();
        }
      } catch {
        // Continue with empty message
      }

      const newMessage = await vscode.window.showInputBox({
        prompt: 'Edit commit message',
        value: fullMessage,
        placeHolder: 'Enter new commit message',
      });

      if (newMessage === undefined) {
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
      } else {
        // Non-HEAD: interactive rebase requires a clean working tree.
        const { stashed, blocked } = await this._stashIfDirty(cwd);
        if (blocked) {
          void vscode.window.showErrorMessage(
            'Cannot edit a non-HEAD commit message while you have unmerged files. Please resolve conflicts first.'
          );
          return;
        }

        try {
          const session = await this._rebaseService.startInteractiveRebase(repo, `${hash}~1`);

          const targetCommit = session.commits.find(
            (c) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
          );
          if (!targetCommit) {
            void vscode.window.showErrorMessage(
              `Commit ${hash.substring(0, 8)} not found in rebase session.`
            );
            await this._rebaseService.abortRebase(repo);
            if (stashed) {
              await this._unstash(cwd);
            }
            return;
          }

          this._rebaseService.updateRebasePlan(
            repo,
            session.commits.map((c) =>
              c.hash === targetCommit.hash
                ? { hash: c.hash, action: 'reword' as const, newMessage }
                : { hash: c.hash, action: c.action }
            )
          );

          const result = await this._rebaseService.executeRebase(repo);

          if (!result.success && result.conflictedFiles && result.conflictedFiles.length > 0) {
            await this._rebaseService.abortRebase(repo);
            if (stashed) {
              await this._unstash(cwd);
            }
            void vscode.window.showErrorMessage(
              'Failed to edit commit message: rebase encountered conflicts. The operation has been aborted.'
            );
            // abortRebase moved HEAD; reload before refresh.
            await this._gitService.reloadRepository(repo);
            this._gitToolWindowProvider.refresh();
            return;
          }

          // `git rebase -i` pauses at the reword step waiting for the
          // user to type a new commit message in `$GIT_EDITOR` /
          // `core.editor`. Headless extension hosts have no
          // GIT_EDITOR (we only set GIT_SEQUENCE_EDITOR), so git
          // pauses with the rebase metadata still in `.git/rebase-merge/`
          // and HEAD detached at the parent of the reword target —
          // the user-visible "branch dropped to detached HEAD" symptom.
          //
          // The codebase already provides the right primitive:
          // `provideRewordMessage` runs `git commit --amend -m <msg>`
          // (no editor needed) followed by `git rebase --continue`,
          // which lands the rewrite and updates the branch ref. We
          // route through it here so the rebase actually completes.
          //
          // For the common single-reword case there's only one paused
          // step, but we loop in case a future caller passes a plan
          // with multiple reword actions in sequence.
          let pausedResult = result;
          while (pausedResult.success && pausedResult.status === 'paused') {
            pausedResult = await this._rebaseService.provideRewordMessage(repo, newMessage);
            if (
              !pausedResult.success &&
              pausedResult.conflictedFiles &&
              pausedResult.conflictedFiles.length > 0
            ) {
              await this._rebaseService.abortRebase(repo);
              if (stashed) {
                await this._unstash(cwd);
              }
              void vscode.window.showErrorMessage(
                'Failed to edit commit message: rebase encountered conflicts. The operation has been aborted.'
              );
              await this._gitService.reloadRepository(repo);
              this._gitToolWindowProvider.refresh();
              return;
            }
          }
        } catch (opError) {
          if (stashed) {
            await this._unstash(cwd);
          }
          throw opError;
        }

        if (stashed) {
          await this._unstash(cwd);
        }
      }

      void vscode.window.showInformationMessage(
        `Updated commit message for ${hash.substring(0, 8)}`
      );
      // Reword rewrote history; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to edit commit message: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Merge the selected commit into the current branch.
   */
  private async _handleMergeIntoCurrent(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const result = await this._gitService.mergeBranch(repo, hash);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Merged ${hash.substring(0, 8)} into current branch successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog. Falls back to the
        // legacy toast if conflictResolutionService isn't wired yet.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: hash.substring(0, 8),
          });
        } else {
          const choice = await vscode.window.showWarningMessage(
            `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`,
            'Open Conflicts',
            'Abort Merge'
          );
          if (choice === 'Open Conflicts') {
            for (const filePath of result.conflicts) {
              const fileUri = vscode.Uri.joinPath(repo.rootUri, filePath);
              await vscode.commands.executeCommand('vscode.open', fileUri);
            }
          } else if (choice === 'Abort Merge') {
            try {
              await this._gitCli.exec(['merge', '--abort'], {
                cwd: repo.rootUri.fsPath,
                throwOnError: true,
              });
              void vscode.window.showInformationMessage('Merge aborted.');
            } catch (abortError) {
              const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
              void vscode.window.showErrorMessage(
                `Failed to abort merge: ${sanitizeGitError(abortMsg)}`
              );
            }
          }
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to merge: ${sanitizeGitError(reason)}`);
      }
      // Merge moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Start an interactive rebase session from the selected commit.
   */
  private async _handleInteractiveRebase(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      await this._rebaseService.startInteractiveRebase(repo, hash);
      void vscode.window.showInformationMessage(
        `Interactive rebase started from ${hash.substring(0, 8)}`
      );
      // Interactive rebase may have moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to start interactive rebase: ${sanitizeGitError(errorMessage)}`
      );
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
