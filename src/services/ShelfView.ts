/**
 * Shelf View implementation.
 * Provides shelf management UI with list display, context menu actions, and shelve dialog.
 * Uses VS Code's QuickPick API for a native-feeling experience.
 */

import * as vscode from 'vscode';
import { IRepository, IDiff, IFileStatus } from './interfaces/IGitService';
import {
  IShelfService,
  IShelfItem,
  IShelveSelection,
  IUnshelveOptions,
} from './interfaces/IShelfService';
import {
  IShelfView,
  IShelfViewState,
  IShelveDialogResult,
  IShelfActionResult,
  ShelfContextAction,
} from './interfaces/IShelfView';
import { IConflictResolutionService } from './interfaces/IConflictResolutionService';
import { atomicWriteFile } from '../utils/atomicWrite';
import { sanitizeGitError } from '../utils/gitError';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/**
 * Quick pick item for shelf list
 */
interface IShelfQuickPickItem extends vscode.QuickPickItem {
  shelfItem?: IShelfItem;
  action?: ShelfContextAction;
  isAction?: boolean;
  isSeparator?: boolean;
}

/**
 * Quick pick item for file selection in shelve dialog
 */
interface IFileQuickPickItem extends vscode.QuickPickItem {
  filePath: string;
  fileStatus: IFileStatus;
}

/**
 * Shelf View class.
 * Provides shelf management functionality including list display, context menu actions,
 * and shelve dialog.
 *
 * - 8.1: Save selected changes to IDE-managed shelf storage
 * - 8.2: Allow selecting specific files, changelists, or hunks to shelve
 * - 8.3: Display all shelved changesets with names and timestamps
 * - 8.4: Restore shelved changes to working directory
 * - 8.5: Offer options to remove from shelf or keep a copy
 * - 8.6: Display shelved content as diff
 */
export class ShelfView implements IShelfView {
  private _shelfService: IShelfService;
  private _repository: IRepository | undefined;
  private _state: IShelfViewState;
  private _disposables: vscode.Disposable[] = [];
  private _getStatus: ((repo: IRepository) => Promise<IFileStatus[]>) | undefined;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  /**
   * T2-10: filter toggle. When `false` (default), entries with
   * `unshelvedAt != undefined` are elided from the list. When `true`,
   * they appear with an "(already unshelved)" description and expose the
   * Restore action.
   */
  private _showAlreadyUnshelved: boolean = false;

  // Event emitters
  private readonly _onDidChangeShelfItems = new vscode.EventEmitter<IShelfItem[]>();
  private readonly _onDidSelectShelfItem = new vscode.EventEmitter<IShelfItem | undefined>();
  private readonly _onDidRequestAction = new vscode.EventEmitter<{
    action: ShelfContextAction;
    shelfItem: IShelfItem;
  }>();

  // Public events
  public readonly onDidChangeShelfItems = this._onDidChangeShelfItems.event;
  public readonly onDidSelectShelfItem = this._onDidSelectShelfItem.event;
  public readonly onDidRequestAction = this._onDidRequestAction.event;

  constructor(
    shelfService: IShelfService,
    getStatus?: (repo: IRepository) => Promise<IFileStatus[]>,
    conflictResolutionService?: IConflictResolutionService
  ) {
    this._shelfService = shelfService;
    this._getStatus = getStatus;
    this._conflictResolutionService = conflictResolutionService;
    this._state = this._createInitialState();

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeShelfItems,
      this._onDidSelectShelfItem,
      this._onDidRequestAction
    );

    // Listen to shelf service changes
    this._disposables.push(
      this._shelfService.onDidChangeShelf((items) => {
        this._updateStateFromItems(items);
        this._onDidChangeShelfItems.fire(items);
      })
    );
  }

  /**
   * Create the initial state for the shelf view.
   */
  private _createInitialState(): IShelfViewState {
    return {
      shelfItems: [],
      selectedId: undefined,
      loading: false,
      error: undefined,
    };
  }

  /**
   * Update state from shelf items.
   *
   * T2-10: filters out Already-Unshelved entries when the toggle is off.
   * The underlying storage still holds those entries — the filter is
   * purely a view-level concern.
   */
  private _updateStateFromItems(items: IShelfItem[]): void {
    const filtered = this._showAlreadyUnshelved
      ? items
      : items.filter((i) => i.unshelvedAt === undefined);
    this._state.shelfItems = filtered.map((shelfItem) => ({
      shelfItem,
      selected: shelfItem.id === this._state.selectedId,
    }));
  }

  /**
   * Show the shelf list view.
   *
   * @param repository - The repository to show shelf items for
   */
  async show(repository: IRepository): Promise<void> {
    this._repository = repository;
    await this._showShelfList();
  }

  /**
   * Hide the shelf view.
   */
  hide(): void {
    // QuickPick handles its own hiding
  }

  /**
   * Refresh the shelf list.
   */
  refresh(): Promise<void> {
    if (!this._repository) {
      return Promise.resolve();
    }

    this._state.loading = true;
    this._state.error = undefined;

    try {
      const items = this._shelfService.getShelfItems(this._repository);
      this._updateStateFromItems(items);
      this._onDidChangeShelfItems.fire(items);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this._state.error = errorMessage;
    } finally {
      this._state.loading = false;
    }

    return Promise.resolve();
  }

  /**
   * Get the current state of the shelf view.
   */
  getState(): IShelfViewState {
    return {
      ...this._state,
      shelfItems: [...this._state.shelfItems],
    };
  }

  /**
   * Select a shelf item in the list.
   *
   * @param id - The shelf item ID to select
   */
  selectShelfItem(id: string): void {
    // Deselect all
    this._state.shelfItems.forEach((item) => {
      item.selected = false;
    });

    // Select the specified shelf item
    const item = this._state.shelfItems.find((s) => s.shelfItem.id === id);
    if (item) {
      item.selected = true;
      this._state.selectedId = id;
      this._onDidSelectShelfItem.fire(item.shelfItem);
    } else {
      this._state.selectedId = undefined;
      this._onDidSelectShelfItem.fire(undefined);
    }
  }

  /**
   * Show the shelve dialog for creating a new shelf item.
   *
   * @param repository - The repository to shelve changes from
   * @returns Promise resolving to the dialog result
   */
  async showShelveDialog(repository: IRepository): Promise<IShelveDialogResult> {
    this._repository = repository;

    // Step 1: Get changed files
    const changedFiles = await this._getChangedFiles(repository);

    if (changedFiles.length === 0) {
      void vscode.window.showInformationMessage('No changes to shelve');
      return { shelved: false };
    }

    // Step 2: Show file selection dialog
    const selectedFiles = await this._showFileSelectionDialog(changedFiles);

    if (!selectedFiles || selectedFiles.length === 0) {
      return { shelved: false };
    }

    // Step 3: Get shelf name
    const name = await vscode.window.showInputBox({
      prompt: 'Enter a name for the shelved changes',
      placeHolder: 'My shelved changes',
      title: 'Shelve Changes',
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Name is required';
        }
        return undefined;
      },
    });

    // User cancelled
    if (name === undefined) {
      return { shelved: false };
    }

    // Step 4: Create the shelf item
    const selection: IShelveSelection = {
      files: selectedFiles,
    };

    try {
      const shelfItem = await this._shelfService.shelve(repository, name.trim(), selection);
      void vscode.window.showInformationMessage(`Shelved changes: "${name}"`);

      // Refresh the shelf list. Bucket B: refresh() internalises
      // its own errors (see _state.error), so safeFireAndForget here is
      // defence-in-depth for any future direct-throw paths.
      safeFireAndForget(this.refresh(), 'ShelfView.showShelveDialog: refresh after shelve');

      return {
        shelved: true,
        name: name.trim(),
        selection,
        shelfItem,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to shelve changes: ${errorMessage}`);
      return { shelved: false };
    }
  }

  /**
   * Get changed files from the repository.
   */
  private async _getChangedFiles(repository: IRepository): Promise<IFileStatus[]> {
    if (this._getStatus) {
      try {
        return await this._getStatus(repository);
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Show file selection dialog.
   */
  private async _showFileSelectionDialog(files: IFileStatus[]): Promise<string[] | undefined> {
    const items: IFileQuickPickItem[] = files
      .filter((file) => this._isModifiedFile(file))
      .map((file) => ({
        label: `$(file) ${this._getFileName(file.path)}`,
        description: this._getFileDir(file.path),
        detail: this._getStatusLabel(file),
        picked: true,
        filePath: file.path,
        fileStatus: file,
      }));

    if (items.length === 0) {
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Files to Shelve',
      placeHolder: 'Select files to include in the shelf',
      canPickMany: true,
    });

    if (!selected || selected.length === 0) {
      return undefined;
    }

    return selected.map((item) => item.filePath);
  }

  /**
   * Check if a file is modified (not untracked or ignored).
   */
  private _isModifiedFile(file: IFileStatus): boolean {
    // Include modified, added, deleted files
    return (
      file.indexStatus !== ' ' ||
      (file.workTreeStatus !== ' ' && file.workTreeStatus !== '?' && file.workTreeStatus !== '!')
    );
  }

  /**
   * Unshelve changes back to working directory.
   *
   * @param id - The shelf item ID to unshelve
   * @param options - Unshelve options
   * @returns Promise resolving to the action result
   */
  async unshelve(id: string, options?: IUnshelveOptions): Promise<IShelfActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }

    // If no options provided, ask user about removal preference
    let unshelveOptions = options;
    if (!unshelveOptions) {
      unshelveOptions = await this._showUnshelveOptionsDialog();
      if (!unshelveOptions) {
        return { success: false };
      }
    }

    try {
      const result = await this._shelfService.unshelve(this._repository, id, unshelveOptions);

      if (result.success) {
        void vscode.window.showInformationMessage(`Unshelved: "${shelfItem.name}"`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog. Falls back to toast
        // when conflictResolutionService isn't wired.
        if (this._conflictResolutionService) {
          await this._conflictResolutionService.openResolveConflictsDialog(
            this._repository,
            result.conflicts.map((p) => ({ path: p, resolved: false })),
            {
              operation: 'unshelve',
              target: shelfItem.name,
              canAbort: true,
              canContinue: true,
            }
          );
        } else {
          void vscode.window.showWarningMessage(
            `Unshelved with conflicts in ${result.conflicts.length} file(s): ${result.conflicts.join(', ')}`
          );
        }
      }

      // Refresh the shelf list. Bucket B: log-and-suppress is OK
      // here — refresh() already catches internally, and if a future direct
      // throw bubbles up we surface it through console.error rather than
      // letting it disappear.
      safeFireAndForget(this.refresh(), 'ShelfView.unshelve: refresh after success');

      this._onDidRequestAction.fire({ action: 'unshelve', shelfItem });

      return {
        success: result.success,
        action: 'unshelve',
        shelfItem,
        conflicts: result.conflicts,
      };
    } catch (error) {
      // Sanitize both the toast and the structured result — raw git
      // stderr can embed credentials in remote URLs, and the structured
      // error flows into downstream consumers (logs, telemetry,
      // webviews) that shouldn't receive unsanitised text either.
      const raw = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeGitError(raw);
      void vscode.window.showErrorMessage(`Failed to unshelve: ${sanitized}`);
      return { success: false, action: 'unshelve', shelfItem, error: sanitized };
    }
  }

  /**
   * Show unshelve options dialog.
   */
  private async _showUnshelveOptionsDialog(): Promise<IUnshelveOptions | undefined> {
    const options: vscode.QuickPickItem[] = [
      {
        label: '$(trash) Remove from Shelf',
        description: 'Unshelve and remove the shelf item',
        picked: true,
      },
      {
        label: '$(copy) Keep a Copy',
        description: 'Unshelve but keep the shelf item',
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      title: 'Unshelve Options',
      placeHolder: 'Choose what to do with the shelf item after unshelving',
    });

    if (!selected) {
      return undefined;
    }

    return {
      removeFromShelf: selected.label.includes('Remove'),
    };
  }

  /**
   * View a shelf item's contents as diff.
   *
   * @param id - The shelf item ID to view
   * @returns Promise resolving to the shelf diffs
   */
  async viewShelfItem(id: string): Promise<IDiff[]> {
    if (!this._repository) {
      void vscode.window.showErrorMessage('No repository available');
      return [];
    }

    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      void vscode.window.showErrorMessage(`Shelf item not found: ${id}`);
      return [];
    }

    try {
      const diffs = await this._shelfService.getShelfDiff(this._repository, id);

      // Show the diff in a quick pick for file selection
      if (diffs.length === 0) {
        void vscode.window.showInformationMessage('Shelf item contains no changes');
        return diffs;
      }

      await this._showShelfDiffPicker(shelfItem, diffs);

      this._onDidRequestAction.fire({ action: 'view', shelfItem });

      return diffs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to view shelf item: ${errorMessage}`);
      return [];
    }
  }

  /**
   * Show a picker for shelf diff files.
   */
  private async _showShelfDiffPicker(shelfItem: IShelfItem, diffs: IDiff[]): Promise<void> {
    const items: vscode.QuickPickItem[] = diffs.map((diff) => ({
      label: `$(file) ${this._getFileName(diff.path)}`,
      description: this._getFileDir(diff.path),
      detail: `${diff.hunks.length} hunk(s), ${this._getDiffStatusLabel(diff.status)}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Shelf: ${shelfItem.name}`,
      placeHolder: 'Select a file to view diff',
    });

    if (selected) {
      // Find the corresponding diff
      const selectedDiff = diffs.find(
        (d) => `$(file) ${this._getFileName(d.path)}` === selected.label
      );

      if (selectedDiff) {
        // Show the diff content in a virtual document
        await this._showDiffContent(shelfItem, selectedDiff);
      }
    }
  }

  /**
   * Show diff content in a virtual document.
   */
  private async _showDiffContent(shelfItem: IShelfItem, diff: IDiff): Promise<void> {
    // Create diff content
    let content = `Shelf: ${shelfItem.name}\n`;
    content += `Created: ${this._formatTimestamp(shelfItem.timestamp)}\n`;
    content += `File: ${diff.path}\n`;
    content += `Status: ${diff.status}\n`;
    content += '─'.repeat(60) + '\n\n';

    for (const hunk of diff.hunks) {
      content += `${hunk.header}\n`;
      for (const line of hunk.lines) {
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
        content += `${prefix}${line.content}\n`;
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
   * Delete a shelf item after confirmation.
   *
   * @param id - The shelf item ID to delete
   * @returns Promise resolving to the action result
   */
  async deleteShelfItem(id: string): Promise<IShelfActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }

    // Show confirmation dialog
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the shelf item "${shelfItem.name}"?\nThis action cannot be undone.`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return { success: false, action: 'delete', shelfItem };
    }

    try {
      this._shelfService.deleteShelfItem(this._repository, id);
      void vscode.window.showInformationMessage(`Deleted shelf item: "${shelfItem.name}"`);

      // Refresh the shelf list. Bucket B: state-sync only, internal
      // errors already caught by refresh(); direct throws go to console.
      safeFireAndForget(this.refresh(), 'ShelfView.deleteShelfItem: refresh after delete');

      this._onDidRequestAction.fire({ action: 'delete', shelfItem });

      return {
        success: true,
        action: 'delete',
        shelfItem,
      };
    } catch (error) {
      // Sanitize both the toast and the structured result — raw git
      // stderr can embed credentials in remote URLs, and the structured
      // error flows into downstream consumers (logs, telemetry,
      // webviews) that shouldn't receive unsanitised text either.
      const raw = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeGitError(raw);
      void vscode.window.showErrorMessage(`Failed to delete shelf item: ${sanitized}`);
      return { success: false, action: 'delete', shelfItem, error: sanitized };
    }
  }

  /**
   * Show context menu for a shelf item.
   *
   * @param id - The shelf item ID to show menu for
   * @returns Promise resolving to the action result
   */
  async showContextMenu(id: string): Promise<IShelfActionResult> {
    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }

    // T2-10: build the action list reactively. Restore is only meaningful
    // for Already-Unshelved entries; everything else is always available.
    const isAlreadyUnshelved = shelfItem.unshelvedAt !== undefined;
    const actionItems: IShelfQuickPickItem[] = [];

    if (isAlreadyUnshelved) {
      actionItems.push({
        label: '$(history) Restore',
        description: 'Reactivate this already-unshelved entry',
        action: 'restore',
        shelfItem,
        isAction: true,
      });
    }

    actionItems.push(
      {
        label: '$(arrow-down) Unshelve Changes…',
        description: 'Restore shelved changes to working directory (with options prompt)',
        action: 'unshelve',
        shelfItem,
        isAction: true,
      },
      {
        label: '$(run-all) Unshelve Silently',
        description: 'Restore and drop without prompting (Ctrl+Alt+U)',
        action: 'unshelveSilent',
        shelfItem,
        isAction: true,
      },
      {
        label: '$(eye) Show Diff',
        description: 'View shelved changes as diff',
        action: 'view',
        shelfItem,
        isAction: true,
      },
      {
        label: '$(edit) Rename…',
        description: 'Rename this shelf entry',
        action: 'rename',
        shelfItem,
        isAction: true,
      },
      {
        label: '$(desktop-download) Create Patch from Shelf…',
        description: 'Export the shelf entry as a .patch file',
        action: 'createPatch',
        shelfItem,
        isAction: true,
      },
      {
        label: '$(trash) Delete',
        description: 'Delete shelf item (requires confirmation)',
        action: 'delete',
        shelfItem,
        isAction: true,
      }
    );

    const selected = await vscode.window.showQuickPick(actionItems, {
      title: `Shelf: ${shelfItem.name}${isAlreadyUnshelved ? ' (already unshelved)' : ''}`,
      placeHolder: 'Select an action',
    });

    if (!selected || !selected.action) {
      return { success: false };
    }

    return this._handleAction(selected.action, id);
  }

  /**
   * Handle a shelf action.
   */
  private async _handleAction(action: ShelfContextAction, id: string): Promise<IShelfActionResult> {
    switch (action) {
      case 'unshelve':
        return this.unshelve(id);
      case 'unshelveSilent':
        return this.unshelveSilent(id);
      case 'delete':
        return this.deleteShelfItem(id);
      case 'view':
        await this.viewShelfItem(id);
        return { success: true, action: 'view' };
      case 'rename':
        return this.renameShelfItem(id);
      case 'restore':
        return this.restoreShelfItem(id);
      case 'createPatch':
        return this.createPatchFromShelf(id);
      default:
        return { success: false, error: 'Unknown action' };
    }
  }

  // ===========================================================================
  // T2-10 public additions. Each delegates to ShelfService and fires the
  // existing onDidRequestAction event so downstream listeners can react.
  // ===========================================================================

  /**
   * Unshelve the entry silently — no options dialog, default drop-after.
   * Still routes conflicts through the Resolve Conflicts dialog (T1-08).
   */
  async unshelveSilent(id: string): Promise<IShelfActionResult> {
    const removeAppliedFiles = vscode.workspace
      .getConfiguration('intellig.shelve')
      .get<boolean>('removeAppliedFiles', false);
    return this.unshelve(id, {
      removeFromShelf: true,
      removeAppliedFiles,
    });
  }

  /**
   * Prompt the user for a new name and rename the entry.
   */
  async renameShelfItem(id: string): Promise<IShelfActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }
    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }
    const newName = await vscode.window.showInputBox({
      title: `Rename Shelf "${shelfItem.name}"`,
      value: shelfItem.name,
      prompt: 'Enter a new name for this shelf entry',
      validateInput: (value) => {
        if (!value.trim()) {
          return 'Shelf name cannot be empty';
        }
        return undefined;
      },
    });
    if (newName === undefined || newName.trim() === shelfItem.name) {
      return { success: false };
    }
    try {
      this._shelfService.renameShelf(this._repository, id, newName.trim());
      void vscode.window.showInformationMessage(`Renamed shelf to "${newName.trim()}"`);
      this._onDidRequestAction.fire({ action: 'rename', shelfItem });
      return { success: true, action: 'rename', shelfItem };
    } catch (error) {
      // Sanitize both the toast and the structured result — raw git
      // stderr can embed credentials in remote URLs, and the structured
      // error flows into downstream consumers (logs, telemetry,
      // webviews) that shouldn't receive unsanitised text either.
      const raw = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeGitError(raw);
      void vscode.window.showErrorMessage(`Failed to rename shelf: ${sanitized}`);
      return { success: false, action: 'rename', shelfItem, error: sanitized };
    }
  }

  /**
   * Reactivate an Already-Unshelved entry by clearing its `unshelvedAt`.
   */
  restoreShelfItem(id: string): IShelfActionResult {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }
    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }
    this._shelfService.restoreShelf(this._repository, id);
    void vscode.window.showInformationMessage(`Restored shelf: "${shelfItem.name}"`);
    this._onDidRequestAction.fire({ action: 'restore', shelfItem });
    return { success: true, action: 'restore', shelfItem };
  }

  /**
   * Export the entry as a `.patch` file on disk. Writes concatenated diffs
   * from each of the entry's files; the resulting file is importable via
   * PatchService.applyPatch or the Import Patches flow.
   */
  async createPatchFromShelf(id: string): Promise<IShelfActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }
    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }

    const defaultName = `${shelfItem.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.patch`;
    const defaultUri = vscode.Uri.joinPath(this._repository.rootUri, defaultName);
    const target = await vscode.window.showSaveDialog({
      title: `Export Shelf: ${shelfItem.name}`,
      defaultUri,
      filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
      saveLabel: 'Save Patch',
    });
    if (!target) {
      return { success: false };
    }

    // Route through atomicWriteFile so a partial write (EBUSY on a
    // Windows-locked file, ENOSPC on a full disk, process kill mid-flight)
    // never leaves a truncated `.patch` file at the user-picked path —
    // `git apply`/`git am` would silently fail downstream on that junk.
    // Sibling-tmp + rename keeps the target either at its previous content
    // or at the new content, never a partial intermediate.
    try {
      const content = shelfItem.files.map((f) => f.diff).join('\n');
      await atomicWriteFile(target.fsPath, content);
      void vscode.window.showInformationMessage(`Patch written to ${target.fsPath}`);
      this._onDidRequestAction.fire({ action: 'createPatch', shelfItem });
      return { success: true, action: 'createPatch', shelfItem };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to write patch: ${sanitizeGitError(raw)}`);
      // Sanitize the raw error before embedding in
      // the structured result. Downstream consumers (logs, telemetry,
      // webviews) otherwise leak credentials via the string form.
      return {
        success: false,
        action: 'createPatch',
        shelfItem,
        error: sanitizeGitError(raw),
      };
    }
  }

  /**
   * Import `.patch`/`.diff` files as new shelf entries. One entry per file.
   */
  async importPatches(): Promise<IShelfActionResult[]> {
    if (!this._repository) {
      void vscode.window.showErrorMessage('No repository available');
      return [];
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Import Patches',
      filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
    });
    if (!uris || uris.length === 0) {
      return [];
    }
    const results: IShelfActionResult[] = [];
    for (const uri of uris) {
      try {
        const item = await this._shelfService.importPatch(this._repository, {
          patchPath: uri.fsPath,
        });
        results.push({ success: true, shelfItem: item });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({ success: false, error: errorMessage });
      }
    }
    const okCount = results.filter((r) => r.success).length;
    if (okCount > 0) {
      void vscode.window.showInformationMessage(
        `Imported ${okCount} patch${okCount === 1 ? '' : 'es'} as shelf ${
          okCount === 1 ? 'entry' : 'entries'
        }.`
      );
    }
    const failed = results.length - okCount;
    if (failed > 0) {
      void vscode.window.showWarningMessage(
        `${failed} patch file${failed === 1 ? '' : 's'} could not be imported.`
      );
    }
    await this.refresh();
    return results;
  }

  /**
   * Toggle whether Already-Unshelved entries are visible in the tree.
   */
  setShowAlreadyUnshelved(show: boolean): void {
    if (this._showAlreadyUnshelved === show) {
      return;
    }
    this._showAlreadyUnshelved = show;
    // Bucket B: synchronous toggle → async refresh; stays sync so
    // callers (e.g. command palette handlers) don't need to await. Rejections
    // land in console.error rather than floating off into space.
    safeFireAndForget(this.refresh(), 'ShelfView.setShowAlreadyUnshelved: refresh after toggle');
  }

  /**
   * Current visibility of Already-Unshelved entries.
   */
  getShowAlreadyUnshelved(): boolean {
    return this._showAlreadyUnshelved;
  }

  /**
   * Show the shelf list as a quick pick.
   */
  private async _showShelfList(): Promise<void> {
    if (!this._repository) {
      void vscode.window.showErrorMessage('No repository available');
      return;
    }

    // Refresh shelf list. Bucket B: refresh() executes its
    // try/catch body synchronously before awaiting anything (the only
    // async work is Promise.resolve()), so `_state.error` is set by the
    // time we read it two lines below. Preserve that ordering with
    // safeFireAndForget rather than switching to await.
    safeFireAndForget(this.refresh(), 'ShelfView._showShelfList: refresh on open');

    if (this._state.error) {
      void vscode.window.showErrorMessage(`Failed to load shelf items: ${this._state.error}`);
      return;
    }

    // Build quick pick items
    const items = this._buildShelfQuickPickItems();

    if (items.length === 0) {
      // Show option to create a shelf item
      const createOption = await vscode.window.showInformationMessage(
        'No shelved changes found. Would you like to shelve some changes?',
        'Shelve Changes'
      );

      if (createOption === 'Shelve Changes') {
        await this.showShelveDialog(this._repository);
      }
      return;
    }

    // Show quick pick
    const quickPick = vscode.window.createQuickPick<IShelfQuickPickItem>();
    quickPick.title = 'Shelved Changes';
    quickPick.placeholder = 'Select a shelf item to manage...';
    quickPick.items = items;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();

      if (!selected) {
        return;
      }

      if (selected.isAction && selected.label.includes('Shelve New')) {
        // Create new shelf item
        await this.showShelveDialog(this._repository!);
      } else if (selected.isAction && selected.label.includes('Import Patches')) {
        // T2-10: Import `.patch`/`.diff` files as shelf entries.
        await this.importPatches();
        await this._showShelfList();
      } else if (selected.isAction && selected.label.includes('Already Unshelved')) {
        // T2-10: toggle Already-Unshelved filter and re-show.
        this.setShowAlreadyUnshelved(!this._showAlreadyUnshelved);
        await this._showShelfList();
      } else if (selected.shelfItem) {
        // Show context menu for the selected shelf item
        await this.showContextMenu(selected.shelfItem.id);
      }
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
    });

    quickPick.show();
  }

  /**
   * Build quick pick items from shelf items.
   */
  private _buildShelfQuickPickItems(): IShelfQuickPickItem[] {
    const items: IShelfQuickPickItem[] = [];

    // Add "Shelve Changes" action at the top
    items.push({
      label: '$(add) Shelve New Changes…',
      description: 'Shelve current changes',
      isAction: true,
    });

    // T2-10: root-level Import Patches and filter toggle.
    items.push({
      label: '$(cloud-download) Import Patches…',
      description: 'Import .patch / .diff files as new shelf entries',
      isAction: true,
    });
    items.push({
      label: this._showAlreadyUnshelved
        ? '$(eye-closed) Hide Already Unshelved'
        : '$(eye) Show Already Unshelved',
      description: this._showAlreadyUnshelved
        ? 'Hide entries that have been successfully applied'
        : 'Include entries that have already been unshelved',
      isAction: true,
    });

    // Separator
    if (this._state.shelfItems.length > 0) {
      items.push({
        label: '',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });

      items.push({
        label: 'Shelved Changes',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });
    }

    // Add shelf items
    for (const item of this._state.shelfItems) {
      const shelfItem = item.shelfItem;
      const relativeTime = this._getRelativeTime(shelfItem.timestamp);
      const fileCount = shelfItem.files.length;

      items.push({
        label: `$(archive) ${shelfItem.name}`,
        description: `${fileCount} file${fileCount !== 1 ? 's' : ''}`,
        detail: relativeTime,
        shelfItem,
      });
    }

    return items;
  }

  /**
   * Find a shelf item by its ID.
   */
  private _findShelfItemById(id: string): IShelfItem | undefined {
    const item = this._state.shelfItems.find((s) => s.shelfItem.id === id);
    return item?.shelfItem;
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
   * Format timestamp for display.
   */
  private _formatTimestamp(date: Date): string {
    return date.toLocaleString();
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
  private _getStatusLabel(file: IFileStatus): string {
    const statusMap: Record<string, string> = {
      M: 'Modified',
      A: 'Added',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      U: 'Unmerged',
      '?': 'Untracked',
      '!': 'Ignored',
    };

    const indexStatus = statusMap[file.indexStatus] || '';
    const workTreeStatus = statusMap[file.workTreeStatus] || '';

    if (indexStatus && workTreeStatus) {
      return `${indexStatus} (staged), ${workTreeStatus} (unstaged)`;
    } else if (indexStatus) {
      return `${indexStatus} (staged)`;
    } else if (workTreeStatus) {
      return workTreeStatus;
    }

    return 'Unknown';
  }

  /**
   * Get status label for a diff status.
   */
  private _getDiffStatusLabel(status: string): string {
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
 * Create a new ShelfView instance.
 *
 * @param shelfService - The shelf service to use
 * @param getStatus - Optional function to get file status from repository
 * @returns A new ShelfView instance
 */
export function createShelfView(
  shelfService: IShelfService,
  getStatus?: (repo: IRepository) => Promise<IFileStatus[]>,
  conflictResolutionService?: IConflictResolutionService
): ShelfView {
  return new ShelfView(shelfService, getStatus, conflictResolutionService);
}
