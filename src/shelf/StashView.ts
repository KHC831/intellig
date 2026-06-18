/**
 * Stash View implementation.
 * Provides stash management UI with list display, context menu actions, and creation dialog.
 * Uses VS Code's QuickPick API for a native-feeling experience.
 */

import * as vscode from 'vscode';
import {
  IGitService,
  IRepository,
  IStash,
  IStashOptions,
  IDiff,
} from '../git-core/interfaces/IGitService';
import {
  IStashView,
  IStashViewState,
  IStashCreationResult,
  IStashActionResult,
  StashContextAction,
} from './interfaces/IStashView';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { renderDiffAsText } from './diffText';

/**
 * Quick pick item for stash list
 */
interface IStashQuickPickItem extends vscode.QuickPickItem {
  stash?: IStash;
  action?: StashContextAction;
  isAction?: boolean;
  isSeparator?: boolean;
}

/**
 * Stash View class.
 * Provides stash management functionality including list display, context menu actions,
 * and stash creation dialog.
 *
 * - Create Git stash with optional message
 * - Offer options to include untracked files and keep index
 * - Display all stashes with messages and timestamps
 * - Apply stash contents to working directory
 * - Apply and remove stash (pop)
 * - Delete stash after confirmation
 * - Display stash contents as diff
 */
export class StashView implements IStashView {
  private _gitService: IGitService;
  private _repository: IRepository | undefined;
  private _state: IStashViewState;
  private _disposables: vscode.Disposable[] = [];
  private _conflictResolutionService: IConflictResolutionService | undefined;

  // Event emitters
  private readonly _onDidChangeStashes = new vscode.EventEmitter<IStash[]>();
  private readonly _onDidSelectStash = new vscode.EventEmitter<IStash | undefined>();
  private readonly _onDidRequestAction = new vscode.EventEmitter<{
    action: StashContextAction;
    stash: IStash;
  }>();

  // Public events
  public readonly onDidChangeStashes = this._onDidChangeStashes.event;
  public readonly onDidSelectStash = this._onDidSelectStash.event;
  public readonly onDidRequestAction = this._onDidRequestAction.event;

  constructor(gitService: IGitService, conflictResolutionService?: IConflictResolutionService) {
    this._gitService = gitService;
    this._conflictResolutionService = conflictResolutionService;
    this._state = this._createInitialState();

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeStashes,
      this._onDidSelectStash,
      this._onDidRequestAction
    );
  }

  /**
   * Create the initial state for the stash view.
   */
  private _createInitialState(): IStashViewState {
    return {
      stashes: [],
      selectedIndex: undefined,
      loading: false,
    };
  }

  /**
   * Show the stash list view.
   *
   * @param repository - The repository to show stashes for
   */
  async show(repository: IRepository): Promise<void> {
    this._repository = repository;
    await this._showStashList();
  }

  /**
   * Hide the stash view.
   */
  hide(): void {
    // QuickPick handles its own hiding
  }

  /**
   * Refresh the stash list.
   *
   * Resolves to `{ error?: string }`. On success `error` is undefined; on
   * failure `error` holds a human-readable (sanitised) message suitable
   * for a toast or OutputChannel entry. Never rejects — every caller
   * (sync or async) handles the outcome by reading the returned object.
   *
   * No sideband on `_state` — `getState()` carries no `error` field. The
   * returned object is the sole canonical channel; per ADR-006 QuickPick
   * views bind errors through the refresh return value rather than a
   * `_state.error` mirror. See `docs/adr/ADR-006-...md`.
   */
  async refresh(): Promise<{ error?: string }> {
    if (!this._repository) {
      return {};
    }

    this._state.loading = true;

    try {
      const stashes = await this._gitService.stashList(this._repository);
      this._state.stashes = stashes.map((stash) => ({
        stash,
        selected: false,
      }));
      this._onDidChangeStashes.fire(stashes);
      return {};
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Unknown error';
      const sanitized = sanitizeGitError(raw);
      return { error: sanitized };
    } finally {
      this._state.loading = false;
    }
  }

  /**
   * Get the current state of the stash view.
   */
  getState(): IStashViewState {
    return {
      ...this._state,
      stashes: [...this._state.stashes],
    };
  }

  /**
   * Select a stash in the list.
   *
   * @param index - The stash index to select
   */
  selectStash(index: number): void {
    // Deselect all
    this._state.stashes.forEach((item) => {
      item.selected = false;
    });

    // Select the specified stash
    const item = this._state.stashes.find((s) => s.stash.index === index);
    if (item) {
      item.selected = true;
      this._state.selectedIndex = index;
      this._onDidSelectStash.fire(item.stash);
    } else {
      this._state.selectedIndex = undefined;
      this._onDidSelectStash.fire(undefined);
    }
  }

  /**
   * Show the stash creation dialog.
   *
   * @param repository - The repository to create stash in
   * @returns Promise resolving to the creation result
   */
  async showCreateDialog(repository: IRepository): Promise<IStashCreationResult> {
    this._repository = repository;

    // Get stash message
    const message = await vscode.window.showInputBox({
      prompt: 'Enter stash message (optional)',
      placeHolder: 'WIP: My work in progress',
      title: 'Stash Changes',
    });

    // User cancelled
    if (message === undefined) {
      return { created: false };
    }

    // Show options
    const options = await this._showStashOptionsDialog();
    if (options === undefined) {
      return { created: false };
    }

    // Create the stash
    try {
      await this._gitService.stash(repository, message || undefined, options);
      // sanitize-exempt: user-input: message is the user-typed stash label from showInputBox above, not git stderr
      void vscode.window.showInformationMessage(
        message ? `Stashed changes: "${message}"` : 'Stashed changes'
      );

      // refresh() never rejects — it returns `{ error? }` so we surface
      // a post-stash refresh failure as a warning toast. The stash
      // itself succeeded, so this is a secondary signal (the user's
      // view may be stale until next list-open). showWarningMessage,
      // not showErrorMessage. Mirrors ShelfView's post-stash refresh policy.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Stash list refresh failed: ${refreshResult.error}`);
      }

      return {
        created: true,
        message: message || undefined,
        options,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to create stash: ${sanitizeGitError(errorMessage)}`
      );
      return { created: false };
    }
  }

  /**
   * Show stash options dialog.
   */
  private async _showStashOptionsDialog(): Promise<IStashOptions | undefined> {
    const options: vscode.QuickPickItem[] = [
      {
        label: '$(check) Stash Changes',
        description: 'Stash tracked changes only',
        picked: true,
      },
      {
        label: '$(file-add) Include Untracked Files',
        description: 'Also stash untracked files',
      },
      {
        label: '$(pin) Keep Index',
        description: 'Keep staged changes in the index',
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      title: 'Stash Options',
      placeHolder: 'Select stash options',
      canPickMany: true,
    });

    if (selected === undefined) {
      return undefined;
    }

    const stashOptions: IStashOptions = {
      includeUntracked: selected.some((item) => item.label.includes('Include Untracked')),
      keepIndex: selected.some((item) => item.label.includes('Keep Index')),
    };

    return stashOptions;
  }

  /**
   * Apply a stash to the working directory.
   *
   * @param index - The stash index to apply
   * @param reinstateIndex - When true (default), pass `--index` to restore the
   *   staged/unstaged split; when false, apply working-tree changes only.
   *   Mirrors IntelliJ unstash "Reinstate index".
   * @returns Promise resolving to the action result
   */
  async applyStash(index: number, reinstateIndex = true): Promise<IStashActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    try {
      await this._gitService.stashApply(this._repository, index, reinstateIndex);
      void vscode.window.showInformationMessage(`Applied stash@{${index}}`);

      this._onDidRequestAction.fire({ action: 'apply', stash });

      return {
        success: true,
        action: 'apply',
        stash,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // On conflict, route to the Resolve Conflicts dialog instead of
      // surfacing a raw error toast.
      if (this._conflictResolutionService && this._looksLikeConflictError(errorMessage)) {
        const conflicts = await this._conflictResolutionService.getConflictedFiles(
          this._repository
        );
        if (conflicts.length > 0) {
          await this._conflictResolutionService.openResolveConflictsDialog(
            this._repository,
            conflicts,
            {
              operation: 'unstash',
              target: `stash@{${index}}`,
              canAbort: true,
              canContinue: true,
            }
          );
          return { success: false, action: 'apply', stash, error: errorMessage };
        }
      }
      void vscode.window.showErrorMessage(
        `Failed to apply stash: ${sanitizeGitError(errorMessage)}`
      );
      return { success: false, action: 'apply', stash, error: errorMessage };
    }
  }

  /**
   * Heuristic: does this git error look like a conflict? We match on the
   * standard phrases git emits for `stash apply`/`stash pop` conflicts.
   */
  private _looksLikeConflictError(errorMessage: string): boolean {
    const lower = errorMessage.toLowerCase();
    return (
      lower.includes('conflict') ||
      lower.includes('merge conflict') ||
      lower.includes('needs merge')
    );
  }

  /**
   * Pop a stash (apply and remove).
   *
   * @param index - The stash index to pop
   * @param reinstateIndex - When true (default), pass `--index` to restore the
   *   staged/unstaged split; when false, apply working-tree changes only.
   *   Mirrors IntelliJ unstash "Reinstate index".
   * @returns Promise resolving to the action result
   */
  async popStash(index: number, reinstateIndex = true): Promise<IStashActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    try {
      await this._gitService.stashPop(this._repository, index, reinstateIndex);
      void vscode.window.showInformationMessage(`Popped stash@{${index}}`);

      // refresh() never rejects — surface refresh failure as a warning
      // toast (the pop itself succeeded). See showCreateDialog for the
      // policy rationale.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Stash list refresh failed: ${refreshResult.error}`);
      }

      this._onDidRequestAction.fire({ action: 'pop', stash });

      return {
        success: true,
        action: 'pop',
        stash,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // On conflict, route to the Resolve Conflicts dialog.
      if (this._conflictResolutionService && this._looksLikeConflictError(errorMessage)) {
        const conflicts = await this._conflictResolutionService.getConflictedFiles(
          this._repository
        );
        if (conflicts.length > 0) {
          await this._conflictResolutionService.openResolveConflictsDialog(
            this._repository,
            conflicts,
            {
              operation: 'unstash',
              target: `stash@{${index}}`,
              canAbort: true,
              canContinue: true,
            }
          );
          return { success: false, action: 'pop', stash, error: errorMessage };
        }
      }
      void vscode.window.showErrorMessage(`Failed to pop stash: ${sanitizeGitError(errorMessage)}`);
      return { success: false, action: 'pop', stash, error: errorMessage };
    }
  }

  /**
   * Create a new branch rooted at the stash and apply it there.
   *
   * Prompts the user for a branch name, validates it against the standard
   * branch-name regex used elsewhere in the codebase, then delegates to
   * {@link IGitService.stashBranch}. Conflicts during apply are routed to
   * the Resolve Conflicts dialog (same pattern as `applyStash`/`popStash`).
   *
   * @param index - The stash index to branch from
   */
  async branchFromStash(index: number): Promise<IStashActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }
    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    const branchName = await vscode.window.showInputBox({
      title: `Create branch from stash@{${index}}`,
      prompt: 'Enter new branch name',
      placeHolder: 'feature/my-stashed-work',
      validateInput: (v) => {
        if (!v || !v.trim()) {
          return 'Branch name cannot be empty';
        }
        if (!/^[\w\-./]+$/.test(v)) {
          return 'Branch name contains invalid characters';
        }
        return undefined;
      },
    });
    if (!branchName) {
      return { success: false };
    }

    try {
      await this._gitService.stashBranch(this._repository, index, branchName);
      void vscode.window.showInformationMessage(
        `Created branch '${branchName}' from stash@{${index}} and applied it`
      );
      // The stash is dropped by `git stash branch` on success; refresh.
      // refresh() never rejects — surface failure as a warning toast.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Stash list refresh failed: ${refreshResult.error}`);
      }

      this._onDidRequestAction.fire({ action: 'branch', stash });
      return { success: true, action: 'branch', stash };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Conflicts during apply → Resolve Conflicts dialog.
      if (this._conflictResolutionService && this._looksLikeConflictError(errorMessage)) {
        const conflicts = await this._conflictResolutionService.getConflictedFiles(
          this._repository
        );
        if (conflicts.length > 0) {
          await this._conflictResolutionService.openResolveConflictsDialog(
            this._repository,
            conflicts,
            {
              operation: 'unstash',
              target: `stash@{${index}} → ${branchName}`,
              canAbort: true,
              canContinue: true,
            }
          );
          return { success: false, action: 'branch', stash, error: errorMessage };
        }
      }
      void vscode.window.showErrorMessage(
        `Failed to create branch from stash: ${sanitizeGitError(errorMessage)}`
      );
      return { success: false, action: 'branch', stash, error: errorMessage };
    }
  }

  /**
   * Rename a stash by prompting for a new message and delegating to
   * {@link IGitService.stashRename} (git stash store plumbing).
   *
   * After a successful rename, the stash list is refreshed. Note that the
   * renamed entry moves to `stash@{0}` as a side effect of the underlying
   * plumbing — this matches how `git stash` itself orders entries by
   * recency-of-operation.
   *
   * @param index - The stash index to rename
   */
  async renameStash(index: number): Promise<IStashActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }
    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    const newMessage = await vscode.window.showInputBox({
      title: `Rename stash@{${index}}`,
      prompt: 'Enter new stash message',
      value: stash.message ?? '',
      placeHolder: 'WIP: updated description',
      validateInput: (v) => {
        if (typeof v !== 'string' || v.trim().length === 0) {
          return 'Message cannot be empty';
        }
        return undefined;
      },
    });
    if (newMessage === undefined) {
      return { success: false };
    }

    try {
      await this._gitService.stashRename(this._repository, index, newMessage);
      void vscode.window.showInformationMessage(`Renamed stash@{${index}}`);
      // refresh() never rejects — surface failure as a warning toast.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Stash list refresh failed: ${refreshResult.error}`);
      }
      this._onDidRequestAction.fire({ action: 'rename', stash });
      return { success: true, action: 'rename', stash };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to rename stash: ${sanitizeGitError(errorMessage)}`
      );
      return { success: false, action: 'rename', stash, error: errorMessage };
    }
  }

  /**
   * Drop a stash after confirmation.
   *
   * @param index - The stash index to drop
   * @returns Promise resolving to the action result
   */
  async dropStash(index: number): Promise<IStashActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    // Show confirmation dialog
    // sanitize-exempt: user-input: stash.message is the user-typed stash label captured via showInputBox, not git stderr
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to drop stash@{${index}}?\n"${stash.message || 'No message'}"`,
      { modal: true },
      'Drop'
    );

    if (confirm !== 'Drop') {
      return { success: false, action: 'drop', stash };
    }

    try {
      await this._gitService.stashDrop(this._repository, index);
      void vscode.window.showInformationMessage(`Dropped stash@{${index}}`);

      // refresh() never rejects — surface failure as a warning toast.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Stash list refresh failed: ${refreshResult.error}`);
      }

      this._onDidRequestAction.fire({ action: 'drop', stash });

      return {
        success: true,
        action: 'drop',
        stash,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to drop stash: ${sanitizeGitError(errorMessage)}`
      );
      return { success: false, action: 'drop', stash, error: errorMessage };
    }
  }

  /**
   * View a stash's contents as diff.
   *
   * @param index - The stash index to view
   * @returns Promise resolving to the stash diffs
   */
  async viewStash(index: number): Promise<IDiff[]> {
    if (!this._repository) {
      void vscode.window.showErrorMessage('No repository available');
      return [];
    }

    const stash = this._findStashByIndex(index);
    if (!stash) {
      void vscode.window.showErrorMessage(`Stash not found: stash@{${index}}`);
      return [];
    }

    try {
      const diffs = await this._gitService.stashShow(this._repository, index);

      // Show the diff in a quick pick for file selection
      if (diffs.length === 0) {
        void vscode.window.showInformationMessage('Stash contains no changes');
        return diffs;
      }

      await this._showStashDiffPicker(stash, diffs);

      this._onDidRequestAction.fire({ action: 'view', stash });

      return diffs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to view stash: ${sanitizeGitError(errorMessage)}`
      );
      return [];
    }
  }

  /**
   * Show a picker for stash diff files.
   */
  private async _showStashDiffPicker(stash: IStash, diffs: IDiff[]): Promise<void> {
    const items: vscode.QuickPickItem[] = diffs.map((diff) => ({
      label: `$(file) ${this._getFileName(diff.path)}`,
      description: this._getFileDir(diff.path),
      detail: `${diff.hunks.length} hunk(s), ${this._getStatusLabel(diff.status)}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Stash@{${stash.index}}: ${stash.message || 'No message'}`,
      placeHolder: 'Select a file to view diff',
    });

    if (selected) {
      // Find the corresponding diff
      const selectedDiff = diffs.find(
        (d) => `$(file) ${this._getFileName(d.path)}` === selected.label
      );

      if (selectedDiff) {
        // Show the diff content in an output channel or document
        await this._showDiffContent(stash, selectedDiff);
      }
    }
  }

  /**
   * Show diff content in a virtual document.
   */
  private async _showDiffContent(stash: IStash, diff: IDiff): Promise<void> {
    const content = renderDiffAsText(
      [`Stash@{${stash.index}}: ${stash.message || 'No message'}`],
      diff
    );

    // Show in a new untitled document
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'diff',
    });

    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Show context menu for a stash.
   *
   * @param index - The stash index to show menu for
   * @returns Promise resolving to the action result
   */
  async showContextMenu(index: number): Promise<IStashActionResult> {
    const stash = this._findStashByIndex(index);
    if (!stash) {
      return { success: false, error: `Stash not found: stash@{${index}}` };
    }

    // Menu order matches IntelliJ: Apply, Pop, Drop, View, Rename…,
    // Create Branch from Stash…. Labels that open a prompt use Unicode `…`.
    const actionItems: IStashQuickPickItem[] = [
      {
        label: '$(arrow-down) Apply',
        description: 'Apply stash contents to working directory',
        action: 'apply',
        stash,
        isAction: true,
      },
      {
        label: '$(arrow-down) Pop',
        description: 'Apply and remove stash from list',
        action: 'pop',
        stash,
        isAction: true,
      },
      {
        label: '$(trash) Drop',
        description: 'Delete stash (requires confirmation)',
        action: 'drop',
        stash,
        isAction: true,
      },
      {
        label: '$(eye) View',
        description: 'View stash contents as diff',
        action: 'view',
        stash,
        isAction: true,
      },
      {
        label: '$(edit) Rename…',
        description: 'Rename this stash entry',
        action: 'rename',
        stash,
        isAction: true,
      },
      {
        label: '$(git-branch) Create Branch from Stash…',
        description: 'Create a new branch rooted at the stashed state',
        action: 'branch',
        stash,
        isAction: true,
      },
    ];

    const selected = await vscode.window.showQuickPick(actionItems, {
      title: `Stash@{${index}}: ${stash.message || 'No message'}`,
      placeHolder: 'Select an action',
    });

    if (!selected || !selected.action) {
      return { success: false };
    }

    return this._handleAction(selected.action, index);
  }

  /**
   * Ask whether to reinstate the index when applying/popping a stash —
   * IntelliJ's unstash "Reinstate index" checkbox. The default option restores
   * the staged/unstaged split (`--index`); the alternative applies working-tree
   * changes only. Returns `undefined` when the user cancels.
   */
  private async _promptReinstateIndex(action: 'apply' | 'pop'): Promise<boolean | undefined> {
    interface IReinstateItem extends vscode.QuickPickItem {
      reinstate: boolean;
    }
    const items: IReinstateItem[] = [
      {
        label: '$(check) Reinstate index',
        description: 'Restore the staged/unstaged split (git stash --index)',
        reinstate: true,
      },
      {
        label: '$(circle-slash) Working tree only',
        description: 'Apply changes as unstaged (omit --index)',
        reinstate: false,
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: action === 'pop' ? 'Pop Stash' : 'Apply Stash',
      placeHolder: 'Reinstate the staged index?',
    });

    return selected?.reinstate;
  }

  /**
   * Handle a stash action.
   */
  private async _handleAction(
    action: StashContextAction,
    index: number
  ): Promise<IStashActionResult> {
    switch (action) {
      case 'apply': {
        const reinstateIndex = await this._promptReinstateIndex('apply');
        if (reinstateIndex === undefined) {
          return { success: false };
        }
        return this.applyStash(index, reinstateIndex);
      }
      case 'pop': {
        const reinstateIndex = await this._promptReinstateIndex('pop');
        if (reinstateIndex === undefined) {
          return { success: false };
        }
        return this.popStash(index, reinstateIndex);
      }
      case 'drop':
        return this.dropStash(index);
      case 'view':
        await this.viewStash(index);
        return { success: true, action: 'view' };
      case 'branch':
        return this.branchFromStash(index);
      case 'rename':
        return this.renameStash(index);
      default:
        return { success: false, error: 'Unknown action' };
    }
  }

  /**
   * Show the stash list as a quick pick.
   */
  private async _showStashList(): Promise<void> {
    if (!this._repository) {
      void vscode.window.showErrorMessage('No repository available');
      return;
    }

    // Refresh stash list. refresh() returns `{ error? }` (never rejects),
    // so we read the outcome from the promise directly. Per ADR-006, the
    // return value is the canonical error channel for QuickPick views.
    const refreshResult = await this.refresh();
    if (refreshResult.error) {
      void vscode.window.showErrorMessage(`Failed to load stashes: ${refreshResult.error}`);
      return;
    }

    // Build quick pick items
    const items = this._buildStashQuickPickItems();

    if (items.length === 0) {
      // Show option to create a stash
      const createOption = await vscode.window.showInformationMessage(
        'No stashes found. Would you like to create one?',
        'Create Stash'
      );

      if (createOption === 'Create Stash') {
        await this.showCreateDialog(this._repository);
      }
      return;
    }

    // Show quick pick
    const quickPick = vscode.window.createQuickPick<IStashQuickPickItem>();
    quickPick.title = 'Git Stashes';
    quickPick.placeholder = 'Select a stash to manage...';
    quickPick.items = items;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();

      if (!selected) {
        return;
      }

      if (selected.isAction && selected.action === 'apply' && selected.stash) {
        // Direct action from the list
        await this._handleAction('apply', selected.stash.index);
      } else if (selected.stash) {
        // Show context menu for the selected stash
        await this.showContextMenu(selected.stash.index);
      }
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
    });

    quickPick.show();
  }

  /**
   * Build quick pick items from stashes.
   */
  private _buildStashQuickPickItems(): IStashQuickPickItem[] {
    const items: IStashQuickPickItem[] = [];

    // Add "Create Stash" action at the top
    items.push({
      label: '$(add) Create New Stash...',
      description: 'Stash current changes',
      isAction: true,
    });

    // Separator
    if (this._state.stashes.length > 0) {
      items.push({
        label: '',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });

      items.push({
        label: 'Stashes',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });
    }

    // Add stash items
    for (const item of this._state.stashes) {
      const stash = item.stash;
      const relativeTime = this._getRelativeTime(stash.date);
      const branchInfo = stash.branch ? ` on ${stash.branch}` : '';

      items.push({
        label: `$(archive) stash@{${stash.index}}`,
        description: stash.message || 'No message',
        detail: `${relativeTime}${branchInfo}`,
        stash,
      });
    }

    return items;
  }

  /**
   * Find a stash by its index.
   */
  private _findStashByIndex(index: number): IStash | undefined {
    const item = this._state.stashes.find((s) => s.stash.index === index);
    return item?.stash;
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
   * Get status label for a file status.
   */
  private _getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      modified: 'Modified',
      added: 'Added',
      deleted: 'Deleted',
      renamed: 'Renamed',
      copied: 'Copied',
      untracked: 'Untracked',
      ignored: 'Ignored',
      conflicted: 'Conflicted',
    };
    return labels[status] || status;
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
 * Create a new StashView instance.
 *
 * @param gitService - The Git service to use
 * @returns A new StashView instance
 */
export function createStashView(
  gitService: IGitService,
  conflictResolutionService?: IConflictResolutionService
): StashView {
  return new StashView(gitService, conflictResolutionService);
}
