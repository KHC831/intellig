/**
 * Commit Context Menu Commands implementation.
 * Provides command handlers for commit context menu actions in the Git Graph Panel.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository } from '../services/interfaces/IGitService';
import { IRebaseService } from '../services/interfaces/IRebaseService';
import { GitToolWindowProvider, LogContextAction } from '../services/GitToolWindowProvider';
import { GitCli } from '../utils/gitCli';

/**
 * Commit Context Menu Commands class.
 * Registers and handles all commit-related context menu commands from the Graph Panel.
 */
export class CommitContextMenuCommands {
  private _gitService: IGitService;
  private _rebaseService: IRebaseService;
  private _gitToolWindowProvider: GitToolWindowProvider;
  private _gitCli: GitCli;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    gitService: IGitService,
    rebaseService: IRebaseService,
    gitToolWindowProvider: GitToolWindowProvider,
    gitCli?: GitCli
  ) {
    this._gitService = gitService;
    this._rebaseService = rebaseService;
    this._gitToolWindowProvider = gitToolWindowProvider;
    this._gitCli = gitCli || new GitCli();
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
    const disposable = this._gitToolWindowProvider.onDidRequestLogContextAction(
      (event) => this._handleAction(event.action, event.commitHashes)
    );
    this._disposables.push(disposable);
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Get the current repository.
   */
  private _getRepository(): IRepository | undefined {
    const repos = this._gitService.getRepositories();
    return repos.length > 0 ? repos[0] : undefined;
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
    const repo = this._getRepository();
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
    const hasUnmerged = statusLines.some(l =>
      l.startsWith('U') || l.startsWith('AA') || l.startsWith('DD') ||
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
   * Calls git revert directly — no stashing needed since revert creates a new commit.
   */
  private async _handleRevert(commitHashes: string[]): Promise<void> {
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    try {
      const result = await this._gitService.revert(repo, commitHashes);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Reverted ${commitHashes.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
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
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to revert: ${errorMessage}`);
    }
  }

  /**
   * Checkout the selected commit in detached HEAD mode.
   * Uses the stash/force fallback pattern from BranchContextMenuCommands.
   */
  private async _handleCheckoutRevision(commitHashes: string[]): Promise<void> {
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      await this._gitService.checkout(repo, hash);
      void vscode.window.showInformationMessage(`Checked out revision ${hash.substring(0, 8)} (detached HEAD)`);
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
            await this._gitService.stash(repo, `Auto-stash before checkout ${hash.substring(0, 8)}`);
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
   * Shows a quick pick with Soft/Mixed/Hard options.
   */
  private async _handleResetToHere(commitHashes: string[]): Promise<void> {
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    const resetMode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'Keep changes staged', mode: 'soft' },
        { label: 'Mixed', description: 'Keep changes unstaged', mode: 'mixed' },
        { label: 'Hard', description: 'Discard all changes', mode: 'hard' },
      ],
      {
        title: 'Reset Current Branch',
        placeHolder: 'Select reset mode',
      }
    );

    if (!resetMode) {
      return;
    }

    try {
      const result = await this._gitCli.exec(
        ['reset', `--${resetMode.mode}`, hash],
        { cwd: repo.rootUri.fsPath, throwOnError: true }
      );

      if (result.exitCode === 0) {
        void vscode.window.showInformationMessage(
          `Reset to ${hash.substring(0, 8)} (${resetMode.mode})`
        );
      }
      this._gitToolWindowProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to reset: ${errorMessage}`);
    }
  }

  /**
   * Generate a patch file from the selected commit and prompt the user to save it.
   */
  private async _handleCreatePatch(commitHashes: string[]): Promise<void> {
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const result = await this._gitCli.exec(
        ['format-patch', '-1', hash, '--stdout'],
        { cwd: repo.rootUri.fsPath, throwOnError: true }
      );

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
    const repo = this._getRepository();
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

      // Open the first file's diff as a starting point
      const firstDiff = diffs[0];
      const commitUri = vscode.Uri.parse(`git-show:${firstDiff.path}?${JSON.stringify({ ref: hash, path: firstDiff.path })}`);
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
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];

    try {
      const result = await this._gitCli.exec(
        ['ls-tree', '--name-only', '-r', hash],
        { cwd: repo.rootUri.fsPath, throwOnError: true }
      );

      const files = result.stdout.trim().split('\n').filter(f => f.length > 0);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('No files found at this revision.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        files.map(f => ({ label: f, description: hash.substring(0, 8) })),
        {
          title: `Repository at ${hash.substring(0, 8)}`,
          placeHolder: 'Select a file to view',
          matchOnDescription: true,
        }
      );

      if (selected) {
        const fileUri = vscode.Uri.parse(
          `git-show:${selected.label}?${JSON.stringify({ ref: hash, path: selected.label })}`
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
    const repo = this._getRepository();
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
      await this._gitCli.exec(
        ['reset', '--soft', 'HEAD~1'],
        { cwd: repo.rootUri.fsPath, throwOnError: true }
      );

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
    const repo = this._getRepository();
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

        const targetCommit = session.commits.find(c => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash));
        if (!targetCommit) {
          void vscode.window.showErrorMessage(`Commit ${hash.substring(0, 8)} not found in rebase session.`);
          await this._rebaseService.abortRebase(repo);
          if (stashed) {
            await this._unstash(cwd);
          }
          return;
        }

        this._rebaseService.updateRebasePlan(repo, session.commits.map(c =>
          c.hash === targetCommit.hash
            ? { hash: c.hash, action: 'drop' as const }
            : { hash: c.hash, action: c.action }
        ));

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
    const repo = this._getRepository();
    if (!repo || commitHashes.length === 0) {
      return;
    }

    const hash = commitHashes[0];
    const cwd = repo.rootUri.fsPath;

    try {
      // Fetch the full commit message
      let fullMessage = '';
      try {
        const msgResult = await this._gitCli.exec(
          ['log', '-1', '--format=%B', hash],
          { cwd }
        );
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
      const isHead = headHash && (headHash === hash || headHash.startsWith(hash) || hash.startsWith(headHash));

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

          const targetCommit = session.commits.find(c =>
            c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
          );
          if (!targetCommit) {
            void vscode.window.showErrorMessage(`Commit ${hash.substring(0, 8)} not found in rebase session.`);
            await this._rebaseService.abortRebase(repo);
            if (stashed) {
              await this._unstash(cwd);
            }
            return;
          }

          this._rebaseService.updateRebasePlan(repo, session.commits.map(c =>
            c.hash === targetCommit.hash
              ? { hash: c.hash, action: 'reword' as const, newMessage }
              : { hash: c.hash, action: c.action }
          ));

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

      void vscode.window.showInformationMessage(`Updated commit message for ${hash.substring(0, 8)}`);
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
    const repo = this._getRepository();
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
            await this._gitCli.exec(['merge', '--abort'], { cwd: repo.rootUri.fsPath, throwOnError: true });
            void vscode.window.showInformationMessage('Merge aborted.');
          } catch (abortError) {
            const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to abort merge: ${abortMsg}`);
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
    const repo = this._getRepository();
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
  gitCli?: GitCli
): CommitContextMenuCommands {
  return new CommitContextMenuCommands(gitService, rebaseService, gitToolWindowProvider, gitCli);
}
