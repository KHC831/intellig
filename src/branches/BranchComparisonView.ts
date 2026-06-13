/**
 * Branch Comparison View implementation.
 * Provides branch comparison UI with two branch selectors, commit lists,
 * file differences, and ahead/behind counts.
 * Uses VS Code's QuickPick API for a native-feeling experience.
 */

import * as vscode from 'vscode';
import {
  IGitService,
  IRepository,
  IBranch,
  ICommit,
  IBranchComparison,
} from '../git-core/interfaces/IGitService';
import {
  IBranchComparisonView,
  IBranchComparisonViewState,
  IBranchComparisonResult,
  BranchComparisonAction,
} from './interfaces/IBranchComparisonView';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Quick pick item for branch selection
 */
interface IBranchQuickPickItem extends vscode.QuickPickItem {
  branch?: IBranch;
  branchName?: string;
}

/**
 * Quick pick item for comparison results
 */
interface IComparisonQuickPickItem extends vscode.QuickPickItem {
  type: 'commit-ahead' | 'commit-behind' | 'file' | 'action' | 'separator' | 'header';
  commit?: ICommit;
  filePath?: string;
  action?: BranchComparisonAction;
}

/**
 * Branch Comparison View class.
 * Provides branch comparison functionality including branch selection,
 * commit lists, file differences, and ahead/behind counts.
 *
 * - Prompt for target branch to compare
 * - Display commits unique to each branch
 * - Display files that differ between branches
 * - Display diff for selected file
 * - Compare with remote tracking branch
 * - Show ahead/behind commit counts
 */
export class BranchComparisonView implements IBranchComparisonView {
  private _gitService: IGitService;
  private _repository: IRepository | undefined;
  private _state: IBranchComparisonViewState;
  private _disposables: vscode.Disposable[] = [];

  // Event emitters
  private readonly _onDidChangeComparison = new vscode.EventEmitter<
    IBranchComparison | undefined
  >();
  private readonly _onDidSelectFile = new vscode.EventEmitter<string>();
  private readonly _onDidSelectCommit = new vscode.EventEmitter<ICommit>();

  // Public events
  public readonly onDidChangeComparison = this._onDidChangeComparison.event;
  public readonly onDidSelectFile = this._onDidSelectFile.event;
  public readonly onDidSelectCommit = this._onDidSelectCommit.event;

  constructor(gitService: IGitService) {
    this._gitService = gitService;
    this._state = this._createInitialState();

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeComparison,
      this._onDidSelectFile,
      this._onDidSelectCommit
    );
  }

  /**
   * Create the initial state for the branch comparison view.
   */
  private _createInitialState(): IBranchComparisonViewState {
    return {
      branch1: undefined,
      branch2: undefined,
      comparison: undefined,
      loading: false,
    };
  }

  /**
   * Show the branch comparison view.
   *
   * @param repository - The repository to compare branches in
   * @param branch1 - Optional first branch (defaults to current branch)
   * @param branch2 - Optional second branch (will prompt if not provided)
   * @returns Promise resolving to the comparison result
   */
  async show(
    repository: IRepository,
    branch1?: string,
    branch2?: string
  ): Promise<IBranchComparisonResult> {
    this._repository = repository;

    // Get current branch if branch1 not provided
    const currentBranch = repository.head?.name?.replace('refs/heads/', '') || 'HEAD';
    const firstBranch = branch1 || currentBranch;

    // If branch2 not provided, prompt for it
    let secondBranch = branch2;
    if (!secondBranch) {
      secondBranch = await this._promptForBranch(repository, firstBranch);
      if (!secondBranch) {
        return { compared: false };
      }
    }

    // Perform the comparison. setBranches() returns `{ error? }` (never
    // rejects) — per ADR-006, the return value is the canonical error
    // channel for QuickPick views.
    const setResult = await this.setBranches(firstBranch, secondBranch);

    if (setResult.error || !this._state.comparison) {
      return { compared: false };
    }

    // Show the comparison results
    this._showComparisonResults();

    return {
      compared: true,
      branch1: firstBranch,
      branch2: secondBranch,
      comparison: this._state.comparison,
    };
  }

  /**
   * Hide the branch comparison view.
   */
  hide(): void {
    // QuickPick handles its own hiding
  }

  /**
   * Refresh the comparison with current branches.
   *
   * Resolves to `{ error?: string }`. On success `error` is undefined; on
   * failure `error` holds a human-readable (sanitised) message suitable
   * for a toast or OutputChannel entry. Never rejects.
   *
   * No sideband on `_state` — `getState()` carries no `error` field. Per
   * ADR-006 (`docs/adr/ADR-006-...md`) QuickPick views bind errors
   * through the refresh return value rather than a `_state.error` mirror.
   */
  async refresh(): Promise<{ error?: string }> {
    if (!this._repository || !this._state.branch1 || !this._state.branch2) {
      return {};
    }

    return this._performComparison();
  }

  /**
   * Get the current state of the branch comparison view.
   */
  getState(): IBranchComparisonViewState {
    return { ...this._state };
  }

  /**
   * Set the branches to compare and run the comparison as a side effect.
   *
   * Resolves to `{ error?: string }` — same canonical-channel shape as
   * {@link refresh}. Per ADR-006.
   *
   * @param branch1 - The first branch
   * @param branch2 - The second branch
   */
  async setBranches(branch1: string, branch2: string): Promise<{ error?: string }> {
    this._state.branch1 = branch1;
    this._state.branch2 = branch2;
    return this._performComparison();
  }

  /**
   * Swap the two branches being compared.
   *
   * Resolves to the same `{ error? }` shape as {@link refresh}.
   */
  async swapBranches(): Promise<{ error?: string }> {
    if (!this._state.branch1 || !this._state.branch2) {
      return {};
    }

    const temp = this._state.branch1;
    this._state.branch1 = this._state.branch2;
    this._state.branch2 = temp;

    const result = await this._performComparison();
    if (!result.error) {
      this._showComparisonResults();
    }
    return result;
  }

  /**
   * Compare with remote tracking branch.
   *
   * @param repository - The repository
   * @param localBranch - The local branch to compare (defaults to current)
   * @returns Promise resolving to the comparison result
   */
  async compareWithRemote(
    repository: IRepository,
    localBranch?: string
  ): Promise<IBranchComparisonResult> {
    this._repository = repository;

    // Get current branch if not provided
    const currentBranch = localBranch || repository.head?.name?.replace('refs/heads/', '');
    if (!currentBranch) {
      void vscode.window.showErrorMessage('No branch to compare');
      return { compared: false };
    }

    // Get the upstream tracking branch
    const branches = await this._gitService.getBranches(repository);
    const localBranchInfo = branches.find((b) => b.type === 'local' && b.name === currentBranch);

    if (!localBranchInfo?.upstream) {
      void vscode.window.showErrorMessage(
        `Branch '${currentBranch}' has no remote tracking branch`
      );
      return { compared: false };
    }

    const remoteBranch = `${localBranchInfo.upstream.remote}/${localBranchInfo.upstream.name}`;

    return this.show(repository, currentBranch, remoteBranch);
  }

  /**
   * View the diff for a specific file between the two branches.
   *
   * @param filePath - The file path to view diff for
   */
  async viewFileDiff(filePath: string): Promise<void> {
    if (!this._repository || !this._state.branch1 || !this._state.branch2) {
      void vscode.window.showErrorMessage('No comparison active');
      return;
    }

    try {
      // Create URIs for the two versions of the file.
      // Uses the `intellig-git:` scheme registered by
      // `registerGitContentProvider` in extension.ts. That provider reads
      // `uri.query` as the raw, URL-encoded git ref (so refs containing `/`
      // like `origin/main` round-trip correctly). Prior shape used the
      // unregistered `git-show:` scheme with a JSON query and then `.with({
      // scheme: 'git', ... })`, which made VS Code hand the URI to its own
      // builtin `git` provider with an unexpected query shape — causing
      // "Compare Branches → file diff" to throw "Unable to resolve resource"
      // (user-reported crash on "Compare Branches → file diff").
      const branch1Uri = vscode.Uri.parse(
        `intellig-git:${filePath}?${encodeURIComponent(this._state.branch1)}`
      );

      const branch2Uri = vscode.Uri.parse(
        `intellig-git:${filePath}?${encodeURIComponent(this._state.branch2)}`
      );

      // Open diff editor
      const title = `${this._getFileName(filePath)} (${this._state.branch1} ↔ ${this._state.branch2})`;
      await vscode.commands.executeCommand('vscode.diff', branch1Uri, branch2Uri, title);

      this._onDidSelectFile.fire(filePath);
    } catch (error) {
      // Fallback: show diff content in a document
      await this._showFileDiffContent(filePath);
    }
  }

  /**
   * View details of a specific commit.
   *
   * @param commit - The commit to view
   */
  async viewCommit(commit: ICommit): Promise<void> {
    if (!this._repository) {
      return;
    }

    try {
      // Get the commit diff
      const diffs = await this._gitService.getCommitDiff(this._repository, commit.hash);

      // Show commit details
      await this._showCommitDetails(commit, diffs);

      this._onDidSelectCommit.fire(commit);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to view commit: ${sanitizeGitError(errorMessage)}`
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

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Prompt user to select a branch for comparison.
   */
  private async _promptForBranch(
    repository: IRepository,
    excludeBranch: string
  ): Promise<string | undefined> {
    const branches = await this._gitService.getBranches(repository);

    // Build quick pick items
    const items: IBranchQuickPickItem[] = [];

    // Local branches
    const localBranches = branches.filter((b) => b.type === 'local' && b.name !== excludeBranch);
    if (localBranches.length > 0) {
      items.push({
        label: 'Local',
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const branch of localBranches) {
        items.push({
          label: `$(git-branch) ${branch.name}`,
          description: branch.commit.substring(0, 7),
          branch,
          branchName: branch.name,
        });
      }
    }

    // Remote branches
    const remoteBranches = branches.filter((b) => b.type === 'remote');
    if (remoteBranches.length > 0) {
      items.push({
        label: 'Remote',
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const branch of remoteBranches) {
        items.push({
          label: `$(git-branch) ${branch.name}`,
          description: branch.commit.substring(0, 7),
          branch,
          branchName: branch.name,
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      title: `Compare '${excludeBranch}' with...`,
      placeHolder: 'Select a branch to compare with',
    });

    return selected?.branchName;
  }

  /**
   * Perform the branch comparison.
   *
   * Resolves to `{ error?: string }`. On success `error` is undefined; on
   * failure `error` holds a sanitised, human-readable message. Never
   * rejects. The error toast is still emitted from this method (for
   * UX continuity with the previous behaviour) but the canonical
   * channel for downstream callers is the return value, not a sideband.
   */
  private async _performComparison(): Promise<{ error?: string }> {
    if (!this._repository || !this._state.branch1 || !this._state.branch2) {
      return {};
    }

    this._state.loading = true;

    try {
      const comparison = await this._gitService.compareBranches(
        this._repository,
        this._state.branch1,
        this._state.branch2
      );

      this._state.comparison = comparison;
      this._onDidChangeComparison.fire(comparison);
      return {};
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Unknown error';
      const sanitized = sanitizeGitError(raw);
      this._state.comparison = undefined;
      this._onDidChangeComparison.fire(undefined);
      void vscode.window.showErrorMessage(`Failed to compare branches: ${sanitized}`);
      return { error: sanitized };
    } finally {
      this._state.loading = false;
    }
  }

  /**
   * Show the comparison results in a quick pick.
   *
   * Early-returns when `_state.comparison` is undefined — this is the
   * post-failure state (`_performComparison` clears it on error). The
   * contract surfaces refresh errors through the return value
   * of `refresh()` / `setBranches()` / `swapBranches()`, so callers
   * normally check the result before reaching this method; the guard
   * here is the last line of defence against the comparison-null path.
   * Pinned by a test in
   * `src/test/unit/services/branchComparisonView.test.ts`.
   */
  private _showComparisonResults(): void {
    if (!this._state.comparison || !this._state.branch1 || !this._state.branch2) {
      return;
    }

    const comparison = this._state.comparison;
    const items = this._buildComparisonQuickPickItems(comparison);

    // Create quick pick
    const quickPick = vscode.window.createQuickPick<IComparisonQuickPickItem>();
    quickPick.title = `Comparing: ${this._state.branch1} ↔ ${this._state.branch2}`;
    quickPick.placeholder = this._getComparisonSummary(comparison);
    quickPick.items = items;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // Handle selection
    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }

      switch (selected.type) {
        case 'commit-ahead':
        case 'commit-behind':
          if (selected.commit) {
            quickPick.hide();
            await this.viewCommit(selected.commit);
          }
          break;

        case 'file':
          if (selected.filePath) {
            quickPick.hide();
            await this.viewFileDiff(selected.filePath);
          }
          break;

        case 'action':
          if (selected.action === 'swap-branches') {
            quickPick.hide();
            await this.swapBranches();
          } else if (selected.action === 'refresh') {
            // refresh() returns `{ error? }` (never rejects). On success
            // we rebuild the items with the new comparison; on error
            // _performComparison already showed the toast and cleared
            // `_state.comparison`, so we leave the existing items in
            // place rather than crash on the non-null assertion.
            const result = await this.refresh();
            if (!result.error && this._state.comparison) {
              quickPick.items = this._buildComparisonQuickPickItems(this._state.comparison);
            }
          }
          break;
      }
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
    });

    quickPick.show();
  }

  /**
   * Build quick pick items from comparison results.
   */
  private _buildComparisonQuickPickItems(
    comparison: IBranchComparison
  ): IComparisonQuickPickItem[] {
    const items: IComparisonQuickPickItem[] = [];

    // Actions section
    items.push({
      label: '$(arrow-swap) Swap Branches',
      description: `Switch ${this._state.branch1} ↔ ${this._state.branch2}`,
      type: 'action',
      action: 'swap-branches',
    });

    items.push({
      label: '$(refresh) Refresh',
      description: 'Refresh the comparison',
      type: 'action',
      action: 'refresh',
    });

    // Summary header
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      type: 'separator',
    });

    // Ahead commits section (commits in branch1 not in branch2)
    if (comparison.aheadCount > 0) {
      items.push({
        label: `$(arrow-up) Ahead: ${comparison.aheadCount} commit${comparison.aheadCount !== 1 ? 's' : ''} in ${this._state.branch1}`,
        kind: vscode.QuickPickItemKind.Separator,
        type: 'header',
      });

      for (const commit of comparison.commitsAhead) {
        items.push({
          label: `  $(git-commit) ${commit.shortHash}`,
          description: this._truncateMessage(commit.message),
          detail: `${commit.author.name} • ${this._getRelativeTime(commit.authorDate)}`,
          type: 'commit-ahead',
          commit,
        });
      }
    }

    // Behind commits section (commits in branch2 not in branch1)
    if (comparison.behindCount > 0) {
      items.push({
        label: `$(arrow-down) Behind: ${comparison.behindCount} commit${comparison.behindCount !== 1 ? 's' : ''} in ${this._state.branch2}`,
        kind: vscode.QuickPickItemKind.Separator,
        type: 'header',
      });

      for (const commit of comparison.commitsBehind) {
        items.push({
          label: `  $(git-commit) ${commit.shortHash}`,
          description: this._truncateMessage(commit.message),
          detail: `${commit.author.name} • ${this._getRelativeTime(commit.authorDate)}`,
          type: 'commit-behind',
          commit,
        });
      }
    }

    // Changed files section
    if (comparison.changedFiles.length > 0) {
      items.push({
        label: `$(files) Changed Files: ${comparison.changedFiles.length}`,
        kind: vscode.QuickPickItemKind.Separator,
        type: 'header',
      });

      for (const filePath of comparison.changedFiles) {
        items.push({
          label: `  $(file) ${this._getFileName(filePath)}`,
          description: this._getFileDir(filePath),
          detail: 'Click to view diff',
          type: 'file',
          filePath,
        });
      }
    }

    // No differences message
    if (
      comparison.aheadCount === 0 &&
      comparison.behindCount === 0 &&
      comparison.changedFiles.length === 0
    ) {
      items.push({
        label: '$(check) Branches are identical',
        description: 'No differences found',
        type: 'header',
      });
    }

    return items;
  }

  /**
   * Get a summary string for the comparison.
   */
  private _getComparisonSummary(comparison: IBranchComparison): string {
    const parts: string[] = [];

    if (comparison.aheadCount > 0) {
      parts.push(`↑${comparison.aheadCount} ahead`);
    }
    if (comparison.behindCount > 0) {
      parts.push(`↓${comparison.behindCount} behind`);
    }
    if (comparison.changedFiles.length > 0) {
      parts.push(`${comparison.changedFiles.length} files changed`);
    }

    if (parts.length === 0) {
      return 'Branches are identical';
    }

    return parts.join(' • ');
  }

  /**
   * Show file diff content in a virtual document.
   */
  private async _showFileDiffContent(filePath: string): Promise<void> {
    if (!this._repository || !this._state.branch1 || !this._state.branch2) {
      return;
    }

    try {
      // Get diff between the two branches for this file
      const gitCli = (
        this._gitService as unknown as {
          gitCli: {
            exec: (
              args: string[],
              options: { cwd: string }
            ) => Promise<{ stdout: string; exitCode: number }>;
          };
        }
      ).gitCli;

      if (!gitCli) {
        void vscode.window.showErrorMessage('Unable to get file diff');
        return;
      }

      const result = await gitCli.exec(
        ['diff', `${this._state.branch1}...${this._state.branch2}`, '--', filePath],
        { cwd: this._repository.rootUri.fsPath }
      );

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        void vscode.window.showInformationMessage('No differences found for this file');
        return;
      }

      // Create diff content
      let content = `Comparing: ${this._state.branch1} ↔ ${this._state.branch2}\n`;
      content += `File: ${filePath}\n`;
      content += '─'.repeat(60) + '\n\n';
      content += result.stdout;

      // Show in a new untitled document
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'diff',
      });

      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to get file diff: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Show commit details in a quick pick or document.
   */
  private async _showCommitDetails(
    commit: ICommit,
    diffs: {
      path: string;
      hunks: { header: string; lines: { type: string; content: string }[] }[];
    }[]
  ): Promise<void> {
    // Build content
    let content = `Commit: ${commit.hash}\n`;
    content += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    content += `Date: ${commit.authorDate.toLocaleString()}\n`;
    content += '\n';
    content += `${commit.message}\n`;
    if (commit.body) {
      content += `\n${commit.body}\n`;
    }
    content += '\n' + '─'.repeat(60) + '\n\n';

    // Add file changes
    content += `Changed files (${diffs.length}):\n\n`;

    for (const diff of diffs) {
      content += `--- ${diff.path}\n`;
      for (const hunk of diff.hunks) {
        content += `${hunk.header}\n`;
        for (const line of hunk.lines) {
          const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
          content += `${prefix}${line.content}\n`;
        }
      }
      content += '\n';
    }

    // Show in a new untitled document
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'diff',
    });

    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Get file name from path.
   */
  private _getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Get directory from path.
   */
  private _getFileDir(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 1) {
      return '';
    }
    return parts.slice(0, -1).join('/');
  }

  /**
   * Truncate a commit message for display.
   */
  private _truncateMessage(message: string, maxLength: number = 60): string {
    const firstLine = message.split('\n')[0];
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return firstLine.substring(0, maxLength - 3) + '...';
  }

  /**
   * Get relative time string from a date.
   */
  private _getRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffSecs < 60) {
      return 'just now';
    } else if (diffMins < 60) {
      return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else if (diffWeeks < 4) {
      return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`;
    } else {
      return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
    }
  }
}

/**
 * Create a new BranchComparisonView instance.
 *
 * @param gitService - The Git service to use
 * @returns A new BranchComparisonView instance
 */
export function createBranchComparisonView(gitService: IGitService): BranchComparisonView {
  return new BranchComparisonView(gitService);
}
