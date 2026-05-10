/**
 * Commit Context Menu Commands implementation.
 * Provides command handlers for commit context menu actions in the Git Graph Panel.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository } from '../services/interfaces/IGitService';
import { IRebaseService } from '../services/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../services/GitToolWindowProvider';
import { showResetDialog } from '../services/ResetDialog';
import { GitCli } from '../utils/gitCli';
import { IConflictResolutionService } from '../services/interfaces/IConflictResolutionService';
import { resolveRepo } from '../utils/resolveRepo';

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
    this._resolveRepo = repoResolver ?? ((svc, ctx) => resolveRepo(svc, ctx));
  }

  /**
   * Late-bind the conflict resolution service (for wiring migration).
   */
  setConflictResolutionService(service: IConflictResolutionService): void {
    this._conflictResolutionService = service;
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
      this._handleAction(event.action, event.commitHashes)
    );
    this._disposables.push(disposable);
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Resolve the repository the current action should target.
   *
   * R5 H-3: previously pinned `getRepositories()[0]`, which silently targeted
   * the wrong repo in multi-root workspaces for every destructive action in
   * this class. Routes through `resolveRepo(preferActive: true, silent: true)`
   * so the action follows the same fallback chain as other multi-root-aware
   * entry points (see `CommitToolWindow._firstRepo`, R1-HIGH SR-8).
   */
  private async _getRepository(): Promise<IRepository | undefined> {
    return this._resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
  }

  /**
   * Dispatch the action to the appropriate handler method.
   */
  async _handleAction(action: LogContextAction, commitHashes: string[]): Promise<void> {
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
        await this._handleCreatePatch(commitHashes);
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
        await this._handleDropCommit(commitHashes);
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
      void vscode.window.showErrorMessage(`Failed to list files for ${shortHash}: ${msg}`);
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
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to drop changes: ${msg}`);
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
   * Copy the full SHA to the system clipboard.
   */
  private async _handleCopyHash(commitHashes: string[]): Promise<void> {
    if (commitHashes.length === 0) {
      return;
    }

    try {
      const hash = commitHashes[0];
      await vscode.env.clipboard.writeText(hash);
      void vscode.window.showInformationMessage(`Copied commit hash: ${hash}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to copy hash: ${errorMessage}`);
    }
  }

  /**
   * Cherry-pick the selected commit(s) onto the current branch.
   */
  private async _handleCherryPick(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    try {
      const result = await this._gitService.cherryPick(repo, commitHashes);

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
              void vscode.window.showErrorMessage(`Failed to abort cherry-pick: ${abortMsg}`);
            }
          }
        }
      }
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to cherry-pick: ${errorMessage}`);
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
              void vscode.window.showErrorMessage(`Failed to abort revert: ${abortMsg}`);
            }
          }
        }
      }
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to revert: ${errorMessage}`);
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
      void vscode.window.showErrorMessage(`Failed to start selective revert: ${msg}`);
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
        `Failed to exclude files from revert: ${msg}. Revert aborted.`
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
      void vscode.window.showErrorMessage(`Failed to commit partial revert: ${msg}`);
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
            void vscode.window.showInformationMessage(
              `Stashed changes and checked out revision ${hash.substring(0, 8)} (detached HEAD)`
            );
            this._gitToolWindowProvider.refresh();
          } catch (stashError) {
            const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to stash and checkout: ${stashMsg}`);
          }
        } else if (choice === 'Force Checkout') {
          try {
            await this._gitService.checkout(repo, hash, { force: true });
            void vscode.window.showInformationMessage(
              `Force checked out revision ${hash.substring(0, 8)} (detached HEAD)`
            );
            this._gitToolWindowProvider.refresh();
          } catch (forceError) {
            const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to force checkout: ${forceMsg}`);
          }
        }
      } else {
        void vscode.window.showErrorMessage(`Failed to checkout revision: ${errorMessage}`);
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
        this._gitToolWindowProvider.refresh();
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
   * Generate a patch file from the selected commit and prompt the user to save it.
   */
  private async _handleCreatePatch(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const result = await this._gitCli.exec(['format-patch', '-1', hash, '--stdout'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      });

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${hash.substring(0, 8)}.patch`),
        filters: { 'Patch Files': ['patch'], 'All Files': ['*'] },
      });

      if (!saveUri) {
        return;
      }

      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(result.stdout, 'utf-8'));
      void vscode.window.showInformationMessage(`Patch saved to ${saveUri.fsPath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to create patch: ${errorMessage}`);
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
      // resolve the left-hand side of the diff (senior-R5 L-3, user-reported).
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
      void vscode.window.showErrorMessage(`Failed to compare with local: ${errorMessage}`);
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
      void vscode.window.showErrorMessage(`Failed to show repository at revision: ${errorMessage}`);
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
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to undo commit: ${errorMessage}`);
    }
  }

  /**
   * Drop the selected commit using interactive rebase.
   * Uses hash~1 as the onto target so the selected commit is included in the session.
   */
  private async _handleDropCommit(commitHashes: string[]): Promise<void> {
    const repo = await this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    const cwd = repo.rootUri.fsPath;

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
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to drop commit: ${errorMessage}`);
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
      }

      void vscode.window.showInformationMessage(
        `Updated commit message for ${hash.substring(0, 8)}`
      );
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to edit commit message: ${errorMessage}`);
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
              void vscode.window.showErrorMessage(`Failed to abort merge: ${abortMsg}`);
            }
          }
        }
      }
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge: ${errorMessage}`);
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
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to start interactive rebase: ${errorMessage}`);
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
