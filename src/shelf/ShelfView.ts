/**
 * Shelf View implementation.
 * Provides shelf management UI with list display, context menu actions, and shelve dialog.
 * Uses VS Code's QuickPick API for a native-feeling experience.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IRepository, IDiff, IFileStatus } from '../git-core/interfaces/IGitService';
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
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { IChangelistService } from '../changelists/interfaces/IChangelistService';
import { atomicWriteFile } from '../utils/atomicWrite';
import { sanitizeGitError } from '../git-core/gitError';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import { getOutputChannel } from '../utils/outputChannel';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { renderDiffAsText } from './diffText';

/**
 * URI scheme for the read-only virtual document that holds the reconstructed
 * *shelved* version of a file. The shelved content forms the left-hand side of
 * the shelf "Compare with Local" diff; the right-hand side is the live
 * working-tree file. The shelf entry id travels in the URI query and the
 * repo-relative file path in the URI path so the content provider can
 * regenerate the content on demand.
 */
const SHELF_DIFF_SCHEME = 'intellig-shelf';

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
 * - Save selected changes to IDE-managed shelf storage
 * - Allow selecting specific files, changelists, or hunks to shelve
 * - Display all shelved changesets with names and timestamps
 * - Restore shelved changes to working directory
 * - Offer options to remove from shelf or keep a copy
 * - Display shelved content as diff
 */
export class ShelfView implements IShelfView {
  private _shelfService: IShelfService;
  private _repository: IRepository | undefined;
  private _state: IShelfViewState;
  private _disposables: vscode.Disposable[] = [];
  private _getStatus: ((repo: IRepository) => Promise<IFileStatus[]>) | undefined;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  /**
   * Optional changelist mechanism backing the unshelve target-changelist
   * picker. Only the read (`getChangelists`) and create (`createChangelist`)
   * methods are used, so the dependency is narrowed to that pair. When unwired
   * the picker is skipped entirely and unshelve uses today's behavior (active
   * changelist). Mirrors IntelliJ's unshelve dialog, which lets the user pick
   * the target LocalChangeList.
   */
  private _changelistService:
    | Pick<IChangelistService, 'getChangelists' | 'createChangelist'>
    | undefined;
  /**
   * Filter toggle. When `false` (default), entries with `unshelvedAt !=
   * undefined` are elided from the list. When `true`, they appear with an
   * "(already unshelved)" description and expose the Restore action.
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
    conflictResolutionService?: IConflictResolutionService,
    changelistService?: Pick<IChangelistService, 'getChangelists' | 'createChangelist'>
  ) {
    this._shelfService = shelfService;
    this._getStatus = getStatus;
    this._conflictResolutionService = conflictResolutionService;
    this._changelistService = changelistService;
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

    // Serve the reconstructed shelved file content under the `intellig-shelf`
    // scheme so it can be the left-hand side of a `vscode.diff` against the
    // live working-tree file. Mirrors the central `intellig-git` provider that
    // backs the commit "Compare with Local" flow.
    this._disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SHELF_DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => this._provideShelvedContent(uri),
      })
    );
  }

  /**
   * Content provider callback for the `intellig-shelf` scheme. Returns the
   * reconstructed shelved version of the file encoded in `uri` (shelf id in the
   * query, repo-relative path in the path). Degrades to empty content on any
   * failure so the diff editor still opens rather than surfacing a provider
   * error.
   */
  private async _provideShelvedContent(uri: vscode.Uri): Promise<string> {
    if (!this._repository) {
      return '';
    }
    const filePath = uri.path.replace(/^\/+/, '');
    const shelfId = uri.query;
    try {
      return await this._shelfService.getShelvedFileContent(this._repository, shelfId, filePath);
    } catch {
      return '';
    }
  }

  /**
   * Create the initial state for the shelf view.
   */
  private _createInitialState(): IShelfViewState {
    return {
      shelfItems: [],
      selectedId: undefined,
      loading: false,
    };
  }

  /**
   * Update state from shelf items.
   *
   * Filters out Already-Unshelved entries when the toggle is off. The
   * underlying storage still holds those entries — the filter is purely a
   * view-level concern.
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
   * Bind the view to a repository with no UI side effect (see
   * {@link IShelfView.setRepository}). Subsequent `refresh`/action calls target
   * this repo.
   */
  setRepository(repository: IRepository): void {
    this._repository = repository;
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
   *
   * Resolves to `{ error?: string }`. On success `error` is undefined; on
   * failure `error` holds a human-readable (sanitised) message suitable for
   * a toast or OutputChannel entry. Never rejects — every caller (sync or
   * async) handles the outcome by reading the returned object, which makes
   * failure propagation explicit at every call site.
   *
   * No sideband on `_state` — `getState()` carries no `error` field. The
   * returned object is the sole canonical channel; callers handle the
   * failure where they observe it rather than reading latent state on a
   * later open.
   */
  refresh(): Promise<{ error?: string }> {
    if (!this._repository) {
      return Promise.resolve({});
    }

    this._state.loading = true;

    try {
      const items = this._shelfService.getShelfItems(this._repository);
      this._updateStateFromItems(items);
      this._onDidChangeShelfItems.fire(items);
      return Promise.resolve({});
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Unknown error';
      const sanitized = sanitizeGitError(raw);
      return Promise.resolve({ error: sanitized });
    } finally {
      this._state.loading = false;
    }
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

    // Get changed files
    const changedFiles = await this._getChangedFiles(repository);

    if (changedFiles.length === 0) {
      void vscode.window.showInformationMessage('No changes to shelve');
      return { shelved: false };
    }

    // Show file selection dialog
    const selectedFiles = await this._showFileSelectionDialog(changedFiles);

    if (!selectedFiles || selectedFiles.length === 0) {
      return { shelved: false };
    }

    // Get shelf name
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

    // Create the shelf item
    const selection: IShelveSelection = {
      files: selectedFiles,
    };

    try {
      const shelfItem = await this._shelfService.shelve(repository, name.trim(), selection);
      if (shelfItem.partialCleanupFailures && shelfItem.partialCleanupFailures.length > 0) {
        const count = shelfItem.partialCleanupFailures.length;
        const paths = shelfItem.partialCleanupFailures.join(', ');
        void vscode.window.showWarningMessage(
          `Shelved changes: "${name}", but ${count} file(s) could not be removed from your working tree and are still present: ${paths}`
        );
      } else {
        void vscode.window.showInformationMessage(`Shelved changes: "${name}"`);
      }

      // refresh() never rejects — it returns `{ error? }` so we surface
      // a post-shelve refresh failure as a toast instead of letting it
      // stay latent until the next shelf-list open. The shelve itself
      // succeeded, so we still return `shelved: true`; the toast just
      // tells the user their view may be stale.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Shelf list refresh failed: ${refreshResult.error}`);
      }

      return {
        shelved: true,
        name: name.trim(),
        selection,
        shelfItem,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to shelve changes: ${sanitizeGitError(errorMessage)}`
      );
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

    // If no options provided, ask user about removal preference and, when a
    // changelist mechanism is wired, the target changelist for applied files.
    let unshelveOptions = options;
    if (!unshelveOptions) {
      unshelveOptions = await this._showUnshelveOptionsDialog();
      if (!unshelveOptions) {
        return { success: false };
      }

      if (this._changelistService) {
        const target = await this._pickTargetChangelist(this._repository);
        if (!target) {
          // User dismissed the changelist picker — cancel the whole unshelve.
          return { success: false };
        }
        if (target.targetChangelist) {
          unshelveOptions = { ...unshelveOptions, targetChangelist: target.targetChangelist };
        }
      }
    }

    try {
      const result = await this._shelfService.unshelve(this._repository, id, unshelveOptions);

      if (result.success) {
        void vscode.window.showInformationMessage(`Unshelved: "${shelfItem.name}"`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open the Resolve Conflicts dialog. Falls back to toast when
        // conflictResolutionService isn't wired.
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

      // refresh() never rejects — await it so a refresh failure becomes a
      // visible warning immediately. The unshelve itself already produced
      // its own toast above, so a failed refresh is a secondary signal.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Shelf list refresh failed: ${refreshResult.error}`);
      }

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
   * Prompt for the changelist the unshelved files should land in. Lists the
   * repo's existing changelists (active one marked) plus a "New changelist…"
   * entry. Mirrors IntelliJ's unshelve dialog target-changelist chooser.
   *
   * Returns:
   *  - `{}` when the active changelist is chosen (or there is nothing to
   *    choose) → no explicit target, files stay in the active list (default).
   *  - `{ targetChangelist: id }` when a specific / newly-created list is
   *    chosen.
   *  - `undefined` when the user dismisses the picker → caller cancels.
   */
  private async _pickTargetChangelist(
    repo: IRepository
  ): Promise<{ targetChangelist?: string } | undefined> {
    if (!this._changelistService) {
      return {};
    }

    const changelists = this._changelistService.getChangelists(repo);
    const active = changelists.find((cl) => cl.isActive);

    const NEW_LABEL = '$(add) New changelist…';
    interface IChangelistPick extends vscode.QuickPickItem {
      changelistId?: string;
      isNew?: boolean;
    }

    const picks: IChangelistPick[] = changelists.map((cl) => ({
      label: `$(list-unordered) ${cl.name}`,
      description: cl.isActive ? 'active' : cl.isDefault ? 'default' : undefined,
      changelistId: cl.id,
    }));
    picks.push({ label: NEW_LABEL, isNew: true });

    const chosen = await vscode.window.showQuickPick(picks, {
      title: 'Unshelve Into Changelist',
      placeHolder: 'Choose the changelist for the unshelved files',
    });

    if (!chosen) {
      return undefined;
    }

    if (chosen.isNew) {
      const name = await vscode.window.showInputBox({
        title: 'New Changelist',
        prompt: 'Name for the new changelist',
        validateInput: (value) => (value.trim().length === 0 ? 'Name is required' : undefined),
      });
      if (name === undefined) {
        return undefined;
      }
      try {
        const created = this._changelistService.createChangelist(repo, name.trim());
        return { targetChangelist: created.id };
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `Failed to create changelist: ${sanitizeGitError(raw)}`
        );
        return undefined;
      }
    }

    // Choosing the active changelist means "no explicit target" so the service
    // leaves the files where unshelve already puts them — today's behavior.
    if (chosen.changelistId && chosen.changelistId !== active?.id) {
      return { targetChangelist: chosen.changelistId };
    }
    return {};
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
      void vscode.window.showErrorMessage(
        `Failed to view shelf item: ${sanitizeGitError(errorMessage)}`
      );
      return [];
    }
  }

  /**
   * Show a picker for shelf diff files.
   */
  private async _showShelfDiffPicker(shelfItem: IShelfItem, diffs: IDiff[]): Promise<void> {
    // Carry the diff on each item so the selection resolves by identity. A
    // label-based `find` keyed on the basename opens the wrong file when two
    // paths share a basename (src/a/config.ts vs src/b/config.ts).
    const items: (vscode.QuickPickItem & { diff: IDiff })[] = diffs.map((diff) => ({
      label: `$(file) ${this._getFileName(diff.path)}`,
      description: this._getFileDir(diff.path),
      detail: `${diff.hunks.length} hunk(s), ${this._getDiffStatusLabel(diff.status)}`,
      diff,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Shelf: ${shelfItem.name}`,
      placeHolder: 'Select a file to view diff',
    });

    if (selected) {
      // Real shelved-vs-working-tree comparison (IntelliJ's shelf
      // "Compare with Local").
      await this._showShelvedVsLocalDiff(shelfItem, selected.diff);
    }
  }

  /**
   * Open a side-by-side diff between the *shelved* version of a file (left,
   * reconstructed by applying the entry's patch onto its base) and the current
   * working-tree file (right). Mirrors IntelliJ's
   * `DiffShelvedChangesWithLocalActionProvider` /
   * `DiffShelvedChangesActionProvider.createDiffRequestUsingBase`, which diffs
   * the shelved content against the live local file so the user sees how the
   * shelved change relates to what's on disk now.
   *
   * When the file has no working-tree counterpart (shelved as a deletion, or
   * never created locally) there is nothing to compare against, so fall back to
   * the static patch-text view.
   */
  private async _showShelvedVsLocalDiff(shelfItem: IShelfItem, diff: IDiff): Promise<void> {
    if (!this._repository) {
      return;
    }

    const fileName = this._getFileName(diff.path);
    const absPath = path.join(this._repository.rootUri.fsPath, diff.path);

    if (!fs.existsSync(absPath)) {
      // No local file to diff against — show the shelved patch text instead.
      await this._showDiffContent(shelfItem, diff);
      return;
    }

    const leftUri = vscode.Uri.from({
      scheme: SHELF_DIFF_SCHEME,
      path: `/${diff.path}`,
      query: shelfItem.id,
    });
    const rightUri = vscode.Uri.file(absPath);
    const title = `${fileName} (Shelved ↔ Local)`;

    await openRevisionDiff({ leftUri, rightUri, title }, 'Failed to open shelf diff');
  }

  /**
   * Show diff content in a virtual document. Fallback for files with no
   * working-tree counterpart to compare against.
   */
  private async _showDiffContent(shelfItem: IShelfItem, diff: IDiff): Promise<void> {
    const content = renderDiffAsText(
      [`Shelf: ${shelfItem.name}`, `Created: ${this._formatTimestamp(shelfItem.timestamp)}`],
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

    // Show confirmation dialog. Deletion moves the entry to the recycle bin
    // ("Recently Deleted"), so it is recoverable rather than destructive.
    const confirm = await vscode.window.showWarningMessage(
      `Move the shelf item "${shelfItem.name}" to Recently Deleted?\nYou can restore it later from the recycle bin.`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return { success: false, action: 'delete', shelfItem };
    }

    try {
      this._shelfService.deleteShelfItem(this._repository, id);

      // Offer a one-click Undo that restores the entry from the recycle bin.
      void vscode.window
        .showInformationMessage(`Moved shelf item to Recently Deleted: "${shelfItem.name}"`, 'Undo')
        .then((choice) => {
          if (choice === 'Undo' && this._repository) {
            try {
              this._shelfService.restoreFromRecycleBin(this._repository, id);
              void this.refresh();
              // eslint-disable-next-line no-restricted-syntax -- no logger in scope; the recycle-bin entry already being purged is the expected "nothing to undo" outcome.
            } catch {
              /* entry already purged — nothing to undo */
            }
          }
        });

      // refresh() never rejects — await it so a refresh failure produces a
      // visible warning rather than latent state. The delete itself
      // already produced a success toast above.
      const refreshResult = await this.refresh();
      if (refreshResult.error) {
        void vscode.window.showWarningMessage(`Shelf list refresh failed: ${refreshResult.error}`);
      }

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

    // Build the action list reactively. Restore is only meaningful for
    // Already-Unshelved entries; everything else is always available.
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
        label: '$(list-selection) Unshelve Files…',
        description: 'Apply only a selected subset of files, keeping the rest shelved',
        action: 'unshelveFiles',
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
   * Show the recycle bin ("Recently Deleted"). Lists the entries deleted via
   * {@link deleteShelfItem}, then offers Restore or Delete Permanently for the
   * chosen entry. Mirrors IntelliJ's "Recently Deleted" shelf node
   * (ShelvedChangesViewManager) backed by `getDeletedLists`.
   */
  async showRecycleBin(): Promise<IShelfActionResult> {
    if (!this._repository) {
      return { success: false, error: 'No repository available' };
    }

    const recycled = this._shelfService.getRecycledShelfItems(this._repository);
    if (recycled.length === 0) {
      void vscode.window.showInformationMessage('Recently Deleted is empty.');
      return { success: true };
    }

    const entryPicks: Array<vscode.QuickPickItem & { shelfItem: IShelfItem }> = recycled.map(
      (item) => ({
        label: `$(trash) ${item.name}`,
        description: `${item.files.length} file${item.files.length !== 1 ? 's' : ''}`,
        detail: item.deletedAt ? `deleted ${this._getRelativeTime(item.deletedAt)}` : undefined,
        shelfItem: item,
      })
    );

    const chosen = await vscode.window.showQuickPick(entryPicks, {
      title: 'Recently Deleted Shelves',
      placeHolder: 'Select a deleted shelf to restore or remove permanently',
    });
    if (!chosen) {
      return { success: false };
    }
    const shelfItem = chosen.shelfItem;

    const RESTORE = '$(history) Restore';
    const PURGE = '$(trashcan) Delete Permanently';
    const action = await vscode.window.showQuickPick(
      [
        { label: RESTORE, description: 'Move this entry back to the active shelf list' },
        { label: PURGE, description: 'Remove this entry for good (cannot be undone)' },
      ],
      {
        title: `Recently Deleted: ${shelfItem.name}`,
        placeHolder: 'Select an action',
      }
    );
    if (!action) {
      return { success: false };
    }

    try {
      if (action.label === RESTORE) {
        this._shelfService.restoreFromRecycleBin(this._repository, shelfItem.id);
        void vscode.window.showInformationMessage(`Restored shelf: "${shelfItem.name}"`);
        this._onDidRequestAction.fire({ action: 'restore', shelfItem });
        await this.refresh();
        return { success: true, action: 'restore', shelfItem };
      }

      // Permanent deletion is the one irreversible path — confirm it.
      const confirm = await vscode.window.showWarningMessage(
        `Permanently delete the shelf item "${shelfItem.name}"?\nThis action cannot be undone.`,
        { modal: true },
        'Delete Permanently'
      );
      if (confirm !== 'Delete Permanently') {
        return { success: false, action: 'delete', shelfItem };
      }
      this._shelfService.deleteShelfItemPermanently(this._repository, shelfItem.id);
      void vscode.window.showInformationMessage(`Permanently deleted shelf: "${shelfItem.name}"`);
      this._onDidRequestAction.fire({ action: 'delete', shelfItem });
      await this.refresh();
      return { success: true, action: 'delete', shelfItem };
    } catch (error) {
      // Sanitize — see deleteShelfItem for the credential-leak rationale.
      const raw = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeGitError(raw);
      void vscode.window.showErrorMessage(`Recycle bin action failed: ${sanitized}`);
      return { success: false, shelfItem, error: sanitized };
    }
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
      case 'unshelveFiles':
        return this.unshelveFiles(id);
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
  // Public additions. Each delegates to ShelfService and fires the existing
  // onDidRequestAction event so downstream listeners can react.
  // ===========================================================================

  /**
   * Unshelve the entry silently — no options dialog, default drop-after.
   * Still routes conflicts through the Resolve Conflicts dialog.
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
   * Per-file (partial) unshelve. Prompts a multi-select of the entry's files
   * and applies only the chosen subset, leaving the rest shelved. Mirrors
   * IntelliJ's per-`ShelvedChange` unshelve (UnshelveSilentlyAction acting on
   * a subset of the entry's changes).
   */
  async unshelveFiles(id: string): Promise<IShelfActionResult> {
    const shelfItem = this._findShelfItemById(id);
    if (!shelfItem) {
      return { success: false, error: `Shelf item not found: ${id}` };
    }

    const fileItems: vscode.QuickPickItem[] = shelfItem.files.map((file) => ({
      label: file.path,
      picked: true,
    }));

    const picked = await vscode.window.showQuickPick(fileItems, {
      title: `Unshelve files from: ${shelfItem.name}`,
      placeHolder: 'Select the files to unshelve (unselected files stay shelved)',
      canPickMany: true,
    });

    if (!picked || picked.length === 0) {
      return { success: false };
    }

    return this.unshelve(id, {
      files: picked.map((item) => item.label),
      removeFromShelf: true,
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
      // A text `.patch` can't carry binary file bytes (their `diff` is empty),
      // so a binary entry would otherwise be dropped silently behind a success
      // toast — data loss disguised as success. Export the text files and, when
      // any binaries are excluded, say so explicitly in a warning that names
      // them, rather than the plain success toast.
      const binaryFiles = shelfItem.files.filter((f) => f.isBinary);
      const textFiles = shelfItem.files.filter((f) => !f.isBinary);
      const content = textFiles.map((f) => f.diff).join('\n');
      await atomicWriteFile(target.fsPath, content);
      if (binaryFiles.length > 0) {
        const shown = binaryFiles
          .slice(0, 3)
          .map((f) => f.path)
          .join(', ');
        const more = binaryFiles.length > 3 ? `, and ${binaryFiles.length - 3} more` : '';
        void vscode.window.showWarningMessage(
          `Patch written to ${target.fsPath}, but ${binaryFiles.length} binary file(s) could ` +
            `not be represented in a text patch and were excluded: ${shown}${more}.`
        );
      } else {
        void vscode.window.showInformationMessage(`Patch written to ${target.fsPath}`);
      }
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
        // Sanitize the embedded error — importPatch may surface `git
        // apply` stderr which can contain credentialed URLs from a
        // patch header, or absolute `/Users/<name>` paths on macOS.
        // Downstream consumers (toasts, logs, result payloads) must not
        // leak either. Mirrors the sanitization pattern applied
        // to unshelve / delete / rename above.
        const raw = error instanceof Error ? error.message : String(error);
        const sanitized = sanitizeGitError(raw);
        // Route the per-file failure into the shared
        // OutputChannel so the aggregate toast ("N patch file(s) could
        // not be imported") has an actionable companion in
        // `Output → IntelliG`. The toast itself is informative-only;
        // users who want detail open the channel. Filename + sanitized
        // error on a single line keeps the log greppable without
        // leaking credentials or home paths.
        getOutputChannel().appendLine(
          `[${new Date().toISOString()}] [intellig] ShelfView.importPatches: ${uri.fsPath}: ${sanitized}`
        );
        results.push({ success: false, error: sanitized });
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
    // refresh() returns { error? } — surface any refresh failure as a
    // warning so a stale shelf list is visible to the user rather than
    // latent. Doesn't affect the import-specific success/failure counts
    // already reported above.
    const refreshResult = await this.refresh();
    if (refreshResult.error) {
      void vscode.window.showWarningMessage(`Shelf list refresh failed: ${refreshResult.error}`);
    }
    return results;
  }

  /**
   * Toggle whether Already-Unshelved entries are visible in the tree.
   *
   * Synchronous caller surface (command-palette handler, QuickPick
   * accept). `refresh()` is async and returns `{ error? }` by contract
   * (never rejects), so a silent-refresh error surfaces only on the
   * inner `.then(...)` — we feed that into the shared OutputChannel.
   *
   * The outer `safeFireAndForget` intentionally does NOT pass
   * `{ outputChannel }` even though the historic pattern did. Because
   * the inner handler already appends the sanitized refresh error, the
   * outer option was a dead path in the common case (refresh doesn't
   * reject) and a duplicate log in the impossible case (refresh reject
   * + inner handler throw). A silent-refresh failure on a view toggle
   * isn't worth a toast — the user didn't ask for a side-effect — but
   * it MUST be debuggable, and the inner-path log buys that; the outer
   * `console.error` default catches the only remaining signal worth
   * capturing (an unexpected throw inside the inner handler itself).
   */
  setShowAlreadyUnshelved(show: boolean): void {
    if (this._showAlreadyUnshelved === show) {
      return;
    }
    this._showAlreadyUnshelved = show;
    safeFireAndForget(
      this.refresh().then((r) => {
        if (r.error) {
          getOutputChannel().appendLine(
            `[${new Date().toISOString()}] [intellig] ShelfView.setShowAlreadyUnshelved: refresh failed: ${r.error}`
          );
        }
      }),
      'ShelfView.setShowAlreadyUnshelved: refresh after toggle'
    );
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

    // refresh() returns `{ error? }` so we read the outcome from the
    // promise directly. A refresh-on-open failure blocks the list view
    // entirely, so we surface it as an error toast (the user asked to
    // see the shelf; the quiet-log policy for passive toggles doesn't
    // apply here).
    const refreshResult = await this.refresh();
    if (refreshResult.error) {
      void vscode.window.showErrorMessage(`Failed to load shelf items: ${refreshResult.error}`);
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
        // Import `.patch`/`.diff` files as shelf entries.
        await this.importPatches();
        await this._showShelfList();
      } else if (selected.isAction && selected.label.includes('Already Unshelved')) {
        // Toggle Already-Unshelved filter and re-show.
        this.setShowAlreadyUnshelved(!this._showAlreadyUnshelved);
        await this._showShelfList();
      } else if (selected.isAction && selected.label.includes('Recently Deleted')) {
        // Open the recycle bin, then re-show the list to reflect any restore.
        await this.showRecycleBin();
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

    // Root-level Import Patches and filter toggle.
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

    // Surface the recycle bin only when it holds something, so the list stays
    // uncluttered when nothing has been deleted.
    const recycledCount = this._repository
      ? this._shelfService.getRecycledShelfItems(this._repository).length
      : 0;
    if (recycledCount > 0) {
      items.push({
        label: `$(trash) Recently Deleted (${recycledCount})…`,
        description: 'Restore or permanently remove deleted shelves',
        isAction: true,
      });
    }

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
  conflictResolutionService?: IConflictResolutionService,
  changelistService?: Pick<IChangelistService, 'getChangelists' | 'createChangelist'>
): ShelfView {
  return new ShelfView(shelfService, getStatus, conflictResolutionService, changelistService);
}
