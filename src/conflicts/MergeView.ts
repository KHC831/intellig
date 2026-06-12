import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IMergeView,
  IMergeState,
  IConflictRegion,
  ConflictResolution,
} from './interfaces/IMergeView';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { atomicWriteFile } from '../utils/atomicWrite';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Three-Way Merge View implementation
 * Provides a three-pane merge editor for conflict resolution
 */
export class MergeView implements IMergeView {
  private _panel: vscode.WebviewPanel | undefined;
  private _mergeState: IMergeState | undefined;
  private _currentConflictIndex: number = 0;
  private _repository: IRepository | undefined;
  private _disposables: vscode.Disposable[] = [];

  private _onDidResolve: vscode.EventEmitter<string>;
  readonly onDidResolve: vscode.Event<string>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _gitService: IGitService
  ) {
    this._onDidResolve = new vscode.EventEmitter<string>();
    this.onDidResolve = this._onDidResolve.event;
  }

  /**
   * Show the merge view for a conflicted file.
   *
   * `file` may be either an absolute path or a path relative to a repository
   * root. The Resolve Conflicts dialog and the conflicted-file picker both
   * source their paths from `git status --porcelain`, which emits
   * repo-relative paths (e.g. `src/foo/bar.ts`). Passing such a path straight
   * to `vscode.Uri.file()` would anchor it at the filesystem root
   * (`/src/foo/bar.ts`), so `getRepository` finds no owning repo and we throw
   * "No repository found". To support both shapes we first try the path
   * verbatim, and — when that misses and the path is relative — resolve it
   * against each discovered repository root before giving up.
   */
  async show(file: string): Promise<void> {
    // Find the repository for this file. Try the path as given first (covers
    // the absolute-path callers).
    this._repository = await this._gitService.getRepository(vscode.Uri.file(file));

    // Relative path (the common case from `git status --porcelain`): resolve
    // it against the known repository roots and retry the lookup.
    const searchedRoots: string[] = [];
    if (!this._repository && !path.isAbsolute(file)) {
      for (const repo of this._gitService.getRepositories()) {
        searchedRoots.push(repo.rootUri.fsPath);
        const candidate = path.join(repo.rootUri.fsPath, file);
        if (fs.existsSync(candidate)) {
          this._repository = await this._gitService.getRepository(vscode.Uri.file(candidate));
          if (this._repository) {
            break;
          }
        }
      }
    }

    if (!this._repository) {
      // Clearer than the bare "No repository found": name the path we tried
      // and the roots we searched so the failure is debuggable from the toast
      // / log alone.
      const rootList =
        searchedRoots.length > 0 ? searchedRoots.join(', ') : '(no repositories discovered)';
      throw new Error(
        `No repository found for file "${file}". Searched repository roots: ${rootList}`
      );
    }

    // Parse the conflict markers and get the three versions
    await this._loadMergeState(file);

    if (!this._mergeState) {
      throw new Error(`Failed to load merge state for file: ${file}`);
    }

    // Create or reveal the webview panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'intellig.mergeView',
        `Merge: ${path.basename(file)}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this._extensionUri],
        }
      );

      // Handle panel disposal
      this._panel.onDidDispose(
        () => {
          this._panel = undefined;
        },
        null,
        this._disposables
      );

      // Handle messages from the webview
      this._panel.webview.onDidReceiveMessage(
        (message: { type: string; conflictId?: number; resolution?: ConflictResolution }) =>
          this._handleWebviewMessage(message),
        null,
        this._disposables
      );
    }

    // Update the webview content
    this._updateWebviewContent();
    this._currentConflictIndex = 0;
  }

  /**
   * Hide the merge view
   */
  hide(): void {
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
    this._mergeState = undefined;
    this._currentConflictIndex = 0;
  }

  /**
   * Accept the current (local) version for a conflict
   */
  acceptCurrent(conflictId?: number): void {
    this._resolveConflict(conflictId, 'current');
  }

  /**
   * Accept the incoming (remote) version for a conflict
   */
  acceptIncoming(conflictId?: number): void {
    this._resolveConflict(conflictId, 'incoming');
  }

  /**
   * Accept both versions for a conflict
   */
  acceptBoth(conflictId?: number): void {
    this._resolveConflict(conflictId, 'both');
  }

  /**
   * Accept current version for all conflicts
   */
  acceptAllCurrent(): void {
    if (!this._mergeState) {
      return;
    }

    for (const conflict of this._mergeState.conflicts) {
      if (!conflict.resolved) {
        this._resolveConflict(conflict.id, 'current');
      }
    }
  }

  /**
   * Accept incoming version for all conflicts
   */
  acceptAllIncoming(): void {
    if (!this._mergeState) {
      return;
    }

    for (const conflict of this._mergeState.conflicts) {
      if (!conflict.resolved) {
        this._resolveConflict(conflict.id, 'incoming');
      }
    }
  }

  /**
   * Auto-resolve every conflict where the right (incoming) side
   * didn't meaningfully change relative to the base by taking the left
   * (current) side. Returns the number of conflicts auto-resolved.
   *
   * A conflict is "non-conflicting from left" when:
   *   - diff3 markers are present and `incomingContent === baseContent`, OR
   *   - no base was recorded and `incomingContent` is empty while
   *     `currentContent` is not (i.e. left-only addition).
   * True both-sided conflicts stay unresolved.
   */
  applyAllNonConflictingFromLeft(): number {
    if (!this._mergeState) {
      return 0;
    }
    const ids = identifyNonConflictingConflicts(this._mergeState.conflicts, 'left');
    let resolved = 0;
    for (const id of ids) {
      const conflict = this._mergeState.conflicts.find((c) => c.id === id);
      if (conflict && !conflict.resolved) {
        this._resolveConflict(id, 'current');
        resolved++;
      }
    }
    return resolved;
  }

  /**
   * Symmetric to {@link applyAllNonConflictingFromLeft}.
   */
  applyAllNonConflictingFromRight(): number {
    if (!this._mergeState) {
      return 0;
    }
    const ids = identifyNonConflictingConflicts(this._mergeState.conflicts, 'right');
    let resolved = 0;
    for (const id of ids) {
      const conflict = this._mergeState.conflicts.find((c) => c.id === id);
      if (conflict && !conflict.resolved) {
        this._resolveConflict(id, 'incoming');
        resolved++;
      }
    }
    return resolved;
  }

  /**
   * Navigate to the next conflict
   */
  nextConflict(): void {
    if (!this._mergeState || this._mergeState.conflicts.length === 0) {
      return;
    }

    this._currentConflictIndex =
      (this._currentConflictIndex + 1) % this._mergeState.conflicts.length;
    this._highlightCurrentConflict();
  }

  /**
   * Navigate to the previous conflict
   */
  previousConflict(): void {
    if (!this._mergeState || this._mergeState.conflicts.length === 0) {
      return;
    }

    this._currentConflictIndex =
      (this._currentConflictIndex - 1 + this._mergeState.conflicts.length) %
      this._mergeState.conflicts.length;
    this._highlightCurrentConflict();
  }

  /**
   * Mark the file as resolved.
   *
   * Route the working-tree write through `atomicWriteFile` (async variant
   * of the atomic write helper). The file being overwritten is about to be
   * `git add`-ed and committed — a partial write here would ship a
   * truncated blob into the commit, and any concurrent reader (git hook,
   * second VS Code window, external linter) could observe a half-written
   * file mid-flight. The sibling-temp + rename pattern keeps the target
   * path at either the old complete content or the new complete content,
   * never a half-written intermediate. `vscode.workspace.fs.writeFile`
   * offers no such guarantee (checked against the vscode.d.ts contract
   * and the reference implementation for `file:` URIs — see
   * `src/utils/atomicWrite.ts` module JSDoc).
   *
   * Error handling is internalised here rather than at each callsite. The
   * webview message dispatcher invokes this fire-and-forget
   * (`void this.markResolved()`), and once the write went through atomic
   * rename, real filesystem errors (EBUSY on a locked file,
   * ENOSPC on a full disk, EPERM on a read-only tree) surface reliably
   * from `renameSync` where the previous `vscode.workspace.fs.writeFile`
   * silently swallowed many failures. If we re-throw here, the
   * dispatcher discards the rejection and the user sees the pane close
   * with no feedback while `git add` runs against stale content. Instead
   * we catch, surface a sanitised toast (paths/credentials may appear in
   * fs errnos), and keep the pane visible so the user can retry or
   * dismiss with context intact. `_onDidResolve` does NOT fire on the
   * error path so downstream consumers don't treat the file as resolved.
   */
  async markResolved(): Promise<void> {
    if (!this._mergeState || !this._repository) {
      return;
    }

    // Write the resolved content to the file via the atomic helper.
    const resolvedContent = this._generateResolvedContent();
    const targetPath = path.join(this._repository.rootUri.fsPath, this._mergeState.file);

    try {
      await atomicWriteFile(targetPath, resolvedContent);

      // Stage the file to mark it as resolved
      await this._gitService.stage(this._repository, [this._mergeState.file]);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to mark resolved: ${sanitizeGitError(raw)}`);
      // Leave the pane visible so the user can retry; do NOT fire the
      // resolve event since the file was not successfully committed.
      return;
    }

    // Fire the resolve event
    this._onDidResolve.fire(this._mergeState.file);

    // Close the merge view
    this.hide();
  }

  /**
   * Get the current merge state
   */
  getMergeState(): IMergeState | undefined {
    return this._mergeState;
  }

  /**
   * Check if all conflicts are resolved
   */
  allConflictsResolved(): boolean {
    if (!this._mergeState) {
      return false;
    }
    return this._mergeState.conflicts.every((c) => c.resolved);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidResolve.dispose();
    if (this._panel) {
      this._panel.dispose();
    }
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }

  /**
   * Load the merge state from a conflicted file
   */
  private async _loadMergeState(file: string): Promise<void> {
    if (!this._repository) {
      return;
    }

    const filePath = path.isAbsolute(file)
      ? file
      : path.join(this._repository.rootUri.fsPath, file);
    const fileUri = vscode.Uri.file(filePath);

    // Read the current file content with conflict markers
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(fileContent).toString('utf-8');

    // Get the base, current, and incoming versions using git show
    const relativePath = path.relative(this._repository.rootUri.fsPath, filePath);

    // Parse conflict markers from the file
    const conflicts = this._parseConflictMarkers(content);

    // Get the three versions
    const base = await this._getVersionContent(relativePath, ':1'); // Base version
    const current = await this._getVersionContent(relativePath, ':2'); // Current (ours)
    const incoming = await this._getVersionContent(relativePath, ':3'); // Incoming (theirs)

    this._mergeState = {
      file: relativePath,
      base,
      current,
      incoming,
      conflicts,
      resolvedConflicts: new Set(),
    };
  }

  /**
   * Get content of a specific version from git
   */
  private async _getVersionContent(file: string, ref: string): Promise<string> {
    if (!this._repository) {
      return '';
    }

    try {
      const gitCli = (
        this._gitService as unknown as {
          gitCli: {
            exec: (
              args: string[],
              options: { cwd: string }
            ) => Promise<{ exitCode: number; stdout: string }>;
          };
        }
      ).gitCli;
      const result = await gitCli.exec(['show', `${ref}:${file}`], {
        cwd: this._repository.rootUri.fsPath,
      });
      return result.exitCode === 0 ? result.stdout : '';
    } catch {
      return '';
    }
  }

  /**
   * Parse conflict markers from file content
   * Conflict markers format:
   * <<<<<<< HEAD (or branch name)
   * current content
   * ||||||| merged common ancestors (optional, for diff3 style)
   * base content
   * =======
   * incoming content
   * >>>>>>> branch-name
   */
  private _parseConflictMarkers(content: string): IConflictRegion[] {
    const conflicts: IConflictRegion[] = [];
    const lines = content.split('\n');

    let conflictId = 0;
    let inConflict = false;
    let currentStart = -1;
    let baseStart = -1;
    let incomingStart = -1;
    let currentContent: string[] = [];
    let baseContent: string[] = [];
    let incomingContent: string[] = [];
    let section: 'current' | 'base' | 'incoming' = 'current';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('<<<<<<<')) {
        inConflict = true;
        currentStart = i;
        section = 'current';
        currentContent = [];
        baseContent = [];
        incomingContent = [];
      } else if (line.startsWith('|||||||') && inConflict) {
        // diff3 style - base content follows
        section = 'base';
        baseStart = i;
      } else if (line.startsWith('=======') && inConflict) {
        section = 'incoming';
        incomingStart = i;
      } else if (line.startsWith('>>>>>>>') && inConflict) {
        // End of conflict
        const conflict: IConflictRegion = {
          id: conflictId++,
          baseRange: new vscode.Range(
            baseStart >= 0 ? baseStart : currentStart,
            0,
            baseStart >= 0 ? incomingStart : currentStart,
            0
          ),
          currentRange: new vscode.Range(currentStart, 0, incomingStart, 0),
          incomingRange: new vscode.Range(incomingStart, 0, i, 0),
          resolved: false,
          baseContent: baseContent.join('\n'),
          currentContent: currentContent.join('\n'),
          incomingContent: incomingContent.join('\n'),
        };
        conflicts.push(conflict);
        inConflict = false;
        currentStart = -1;
        baseStart = -1;
        incomingStart = -1;
      } else if (inConflict) {
        switch (section) {
          case 'current':
            currentContent.push(line);
            break;
          case 'base':
            baseContent.push(line);
            break;
          case 'incoming':
            incomingContent.push(line);
            break;
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve a conflict with the specified resolution
   */
  private _resolveConflict(conflictId: number | undefined, resolution: ConflictResolution): void {
    if (!this._mergeState) {
      return;
    }

    const id = conflictId ?? this._mergeState.conflicts[this._currentConflictIndex]?.id;
    if (id === undefined) {
      return;
    }

    const conflict = this._mergeState.conflicts.find((c) => c.id === id);
    if (!conflict) {
      return;
    }

    conflict.resolved = true;
    conflict.resolution = resolution;
    this._mergeState.resolvedConflicts.add(id);

    // Update the webview
    this._updateWebviewContent();

    // Move to next unresolved conflict if available
    const nextUnresolved = this._mergeState.conflicts.findIndex(
      (c, i) => !c.resolved && i > this._currentConflictIndex
    );
    if (nextUnresolved >= 0) {
      this._currentConflictIndex = nextUnresolved;
    }
  }

  /**
   * Generate the resolved content by applying all resolutions
   */
  private _generateResolvedContent(): string {
    if (!this._mergeState) {
      return '';
    }

    // Start with the current file content and replace conflict regions
    // For simplicity, we'll rebuild the content based on resolutions
    const lines: string[] = [];

    // Read the original file and process it
    // This is a simplified approach - in production, we'd need to handle
    // the actual file content more carefully
    for (const conflict of this._mergeState.conflicts) {
      let resolvedContent: string;

      switch (conflict.resolution) {
        case 'current':
          resolvedContent = conflict.currentContent;
          break;
        case 'incoming':
          resolvedContent = conflict.incomingContent;
          break;
        case 'both':
          resolvedContent = conflict.currentContent + '\n' + conflict.incomingContent;
          break;
        case 'manual':
        default:
          // For manual resolution, use current as default
          resolvedContent = conflict.currentContent;
          break;
      }

      lines.push(resolvedContent);
    }

    // If there are no conflicts, return the current version
    if (lines.length === 0) {
      return this._mergeState.current;
    }

    // Rebuild the file content
    // This is a simplified implementation - a full implementation would
    // need to preserve non-conflicting content between conflicts
    return this._rebuildFileContent();
  }

  /**
   * Rebuild the file content with resolved conflicts
   */
  private _rebuildFileContent(): string {
    if (!this._mergeState || !this._repository) {
      return '';
    }

    // For now, we'll use a synchronous approach with the merge state
    // In a full implementation, we'd read the file and replace conflict markers
    const result: string[] = [];
    let conflictIndex = 0;

    // Parse the original content and replace conflicts
    const content = this._mergeState.current; // Use current as base
    const lines = content.split('\n');
    let inConflict = false;
    let skipUntilEnd = false;

    for (const line of lines) {
      if (line.startsWith('<<<<<<<')) {
        inConflict = true;
        skipUntilEnd = true;

        // Add the resolved content for this conflict
        const conflict = this._mergeState.conflicts[conflictIndex];
        if (conflict) {
          let resolvedContent: string;
          switch (conflict.resolution) {
            case 'current':
              resolvedContent = conflict.currentContent;
              break;
            case 'incoming':
              resolvedContent = conflict.incomingContent;
              break;
            case 'both':
              resolvedContent = conflict.currentContent + '\n' + conflict.incomingContent;
              break;
            default:
              resolvedContent = conflict.currentContent;
          }
          if (resolvedContent) {
            result.push(resolvedContent);
          }
          conflictIndex++;
        }
      } else if (line.startsWith('>>>>>>>') && inConflict) {
        inConflict = false;
        skipUntilEnd = false;
      } else if (!skipUntilEnd) {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Highlight the current conflict in the webview
   */
  private _highlightCurrentConflict(): void {
    if (!this._panel || !this._mergeState) {
      return;
    }

    void this._panel.webview.postMessage({
      type: 'highlightConflict',
      conflictId: this._mergeState.conflicts[this._currentConflictIndex]?.id,
    });
  }

  /**
   * Handle messages from the webview
   */
  private _handleWebviewMessage(message: {
    type: string;
    conflictId?: number;
    resolution?: ConflictResolution;
  }): void {
    switch (message.type) {
      case 'acceptCurrent':
        this.acceptCurrent(message.conflictId);
        break;
      case 'acceptIncoming':
        this.acceptIncoming(message.conflictId);
        break;
      case 'acceptBoth':
        this.acceptBoth(message.conflictId);
        break;
      case 'acceptAllCurrent':
        this.acceptAllCurrent();
        break;
      case 'acceptAllIncoming':
        this.acceptAllIncoming();
        break;
      case 'applyAllNonConflictingFromLeft':
        this.applyAllNonConflictingFromLeft();
        break;
      case 'applyAllNonConflictingFromRight':
        this.applyAllNonConflictingFromRight();
        break;
      case 'nextConflict':
        this.nextConflict();
        break;
      case 'previousConflict':
        this.previousConflict();
        break;
      case 'markResolved':
        void this.markResolved();
        break;
    }
  }

  /**
   * Update the webview content
   */
  private _updateWebviewContent(): void {
    if (!this._panel || !this._mergeState) {
      return;
    }

    this._panel.webview.html = this._getWebviewContent();
  }

  /**
   * Generate the webview HTML content
   * Creates a three-pane merge editor with IntelliJ-style layout
   */
  private _getWebviewContent(): string {
    if (!this._mergeState) {
      return '';
    }

    const conflicts = this._mergeState.conflicts;
    const allResolved = this.allConflictsResolved();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Merge View</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .toolbar {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      background-color: var(--vscode-titleBar-activeBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      gap: 8px;
    }

    .toolbar-title {
      font-weight: bold;
      flex: 1;
    }

    .toolbar-button {
      padding: 4px 12px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
    }

    .toolbar-button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .toolbar-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .toolbar-button.primary {
      background-color: var(--vscode-button-background);
    }

    .toolbar-button.secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .conflict-nav {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 16px;
    }

    .conflict-count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .merge-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }

    .pane:last-child {
      border-right: none;
    }

    .pane-header {
      padding: 8px 12px;
      background-color: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: bold;
      font-size: 12px;
      text-transform: uppercase;
    }

    .pane-header.current {
      color: #4fc3f7;
    }

    .pane-header.base {
      color: #ffb74d;
    }

    .pane-header.incoming {
      color: #81c784;
    }

    .pane-content {
      flex: 1;
      overflow: auto;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .conflict-section {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .conflict-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background-color: var(--vscode-editor-lineHighlightBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .conflict-title {
      font-weight: bold;
      font-size: 12px;
    }

    .conflict-actions {
      display: flex;
      gap: 4px;
    }

    .conflict-action {
      padding: 2px 8px;
      font-size: 11px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .conflict-action:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .conflict-content {
      padding: 8px 12px;
      background-color: var(--vscode-editor-background);
    }

    .conflict-content.current {
      background-color: rgba(79, 195, 247, 0.1);
      border-left: 3px solid #4fc3f7;
    }

    .conflict-content.base {
      background-color: rgba(255, 183, 77, 0.1);
      border-left: 3px solid #ffb74d;
    }

    .conflict-content.incoming {
      background-color: rgba(129, 199, 132, 0.1);
      border-left: 3px solid #81c784;
    }

    .conflict-content.resolved {
      opacity: 0.6;
    }

    .resolved-badge {
      display: inline-block;
      padding: 2px 6px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      font-size: 10px;
      margin-left: 8px;
    }

    .highlight {
      box-shadow: 0 0 0 2px var(--vscode-focusBorder);
    }

    .keyboard-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    kbd {
      padding: 2px 4px;
      background-color: var(--vscode-keybindingLabel-background);
      border: 1px solid var(--vscode-keybindingLabel-border);
      border-radius: 3px;
      font-family: monospace;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-title">Merge: ${this._escapeHtml(this._mergeState.file)}</span>
    <div class="conflict-nav">
      <button class="toolbar-button secondary" onclick="previousConflict()" title="Previous Conflict (Alt+Up)">
        ◀ Prev
      </button>
      <span class="conflict-count">${conflicts.filter((c) => c.resolved).length}/${conflicts.length} resolved</span>
      <button class="toolbar-button secondary" onclick="nextConflict()" title="Next Conflict (Alt+Down)">
        Next ▶
      </button>
    </div>
    <button class="toolbar-button secondary" onclick="acceptAllCurrent()">Accept All Current</button>
    <button class="toolbar-button secondary" onclick="acceptAllIncoming()">Accept All Incoming</button>
    <button class="toolbar-button secondary" onclick="applyNonConflictingLeft()" title="Auto-resolve conflicts where only the left side changed">← Apply non-conflicting from Left</button>
    <button class="toolbar-button secondary" onclick="applyNonConflictingRight()" title="Auto-resolve conflicts where only the right side changed">→ Apply non-conflicting from Right</button>
    <button class="toolbar-button primary" onclick="markResolved()" ${allResolved ? '' : 'disabled'}>
      Mark as Resolved
    </button>
    <span class="keyboard-hint">
      <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> Navigate | <kbd>Alt</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> Accept
    </span>
  </div>

  <div class="merge-container">
    ${this._generatePanesHtml()}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function acceptCurrent(conflictId) {
      vscode.postMessage({ type: 'acceptCurrent', conflictId });
    }

    function acceptIncoming(conflictId) {
      vscode.postMessage({ type: 'acceptIncoming', conflictId });
    }

    function acceptBoth(conflictId) {
      vscode.postMessage({ type: 'acceptBoth', conflictId });
    }

    function acceptAllCurrent() {
      vscode.postMessage({ type: 'acceptAllCurrent' });
    }

    function acceptAllIncoming() {
      vscode.postMessage({ type: 'acceptAllIncoming' });
    }

    function applyNonConflictingLeft() {
      vscode.postMessage({ type: 'applyAllNonConflictingFromLeft' });
    }

    function applyNonConflictingRight() {
      vscode.postMessage({ type: 'applyAllNonConflictingFromRight' });
    }

    function nextConflict() {
      vscode.postMessage({ type: 'nextConflict' });
    }

    function previousConflict() {
      vscode.postMessage({ type: 'previousConflict' });
    }

    function markResolved() {
      vscode.postMessage({ type: 'markResolved' });
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.altKey) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault();
            previousConflict();
            break;
          case 'ArrowDown':
            e.preventDefault();
            nextConflict();
            break;
          case '1':
            e.preventDefault();
            acceptCurrent();
            break;
          case '2':
            e.preventDefault();
            acceptBoth();
            break;
          case '3':
            e.preventDefault();
            acceptIncoming();
            break;
        }
      }
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'highlightConflict') {
        // Remove existing highlights
        document.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
        // Add highlight to the specified conflict
        const conflictEl = document.querySelector(\`[data-conflict-id="\${message.conflictId}"]\`);
        if (conflictEl) {
          conflictEl.classList.add('highlight');
          conflictEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
  </script>
</body>
</html>`;
  }

  /**
   * Generate the three panes HTML
   */
  private _generatePanesHtml(): string {
    if (!this._mergeState) {
      return '';
    }

    const conflicts = this._mergeState.conflicts;

    // Generate conflict sections for each pane
    const currentConflicts = conflicts
      .map(
        (c) => `
      <div class="conflict-section" data-conflict-id="${c.id}">
        <div class="conflict-header">
          <span class="conflict-title">
            Conflict #${c.id + 1}
            ${c.resolved ? `<span class="resolved-badge">${c.resolution}</span>` : ''}
          </span>
          <div class="conflict-actions">
            <button class="conflict-action" onclick="acceptCurrent(${c.id})" ${c.resolved ? 'disabled' : ''}>
              Accept
            </button>
          </div>
        </div>
        <div class="conflict-content current ${c.resolved ? 'resolved' : ''}">
          <pre>${this._escapeHtml(c.currentContent) || '(empty)'}</pre>
        </div>
      </div>
    `
      )
      .join('');

    const baseConflicts = conflicts
      .map(
        (c) => `
      <div class="conflict-section" data-conflict-id="${c.id}">
        <div class="conflict-header">
          <span class="conflict-title">
            Conflict #${c.id + 1}
            ${c.resolved ? `<span class="resolved-badge">${c.resolution}</span>` : ''}
          </span>
          <div class="conflict-actions">
            <button class="conflict-action" onclick="acceptBoth(${c.id})" ${c.resolved ? 'disabled' : ''}>
              Accept Both
            </button>
          </div>
        </div>
        <div class="conflict-content base ${c.resolved ? 'resolved' : ''}">
          <pre>${this._escapeHtml(c.baseContent) || '(no common ancestor)'}</pre>
        </div>
      </div>
    `
      )
      .join('');

    const incomingConflicts = conflicts
      .map(
        (c) => `
      <div class="conflict-section" data-conflict-id="${c.id}">
        <div class="conflict-header">
          <span class="conflict-title">
            Conflict #${c.id + 1}
            ${c.resolved ? `<span class="resolved-badge">${c.resolution}</span>` : ''}
          </span>
          <div class="conflict-actions">
            <button class="conflict-action" onclick="acceptIncoming(${c.id})" ${c.resolved ? 'disabled' : ''}>
              Accept
            </button>
          </div>
        </div>
        <div class="conflict-content incoming ${c.resolved ? 'resolved' : ''}">
          <pre>${this._escapeHtml(c.incomingContent) || '(empty)'}</pre>
        </div>
      </div>
    `
      )
      .join('');

    return `
      <div class="pane">
        <div class="pane-header current">Current (Ours)</div>
        <div class="pane-content">
          ${currentConflicts || '<p>No conflicts</p>'}
        </div>
      </div>
      <div class="pane">
        <div class="pane-header base">Base (Common Ancestor)</div>
        <div class="pane-content">
          ${baseConflicts || '<p>No conflicts</p>'}
        </div>
      </div>
      <div class="pane">
        <div class="pane-header incoming">Incoming (Theirs)</div>
        <div class="pane-content">
          ${incomingConflicts || '<p>No conflicts</p>'}
        </div>
      </div>
    `;
  }

  /**
   * Escape HTML special characters
   */
  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

/**
 * Create a new MergeView instance
 */
export function createMergeView(extensionUri: vscode.Uri, gitService: IGitService): MergeView {
  return new MergeView(extensionUri, gitService);
}

/** Side of a conflict marker — left = current (ours), right = incoming (theirs). */
export type NonConflictingSide = 'left' | 'right';

/**
 * Identify conflict-region ids that can be auto-resolved by taking the given
 * side. A region is "non-conflicting from left" when the right-side content
 * didn't meaningfully change:
 *
 *  - diff3 markers (base is known): `incomingContent === baseContent` means
 *    only the left side changed — safe to take left.
 *  - diff2 markers (no base): `incomingContent` is empty while
 *    `currentContent` is non-empty → left-only addition — safe to take left.
 *
 * The `'right'` side is symmetric. True both-sided conflicts are left out.
 *
 * Pure so tests can exercise it without instantiating a webview.
 */
export function identifyNonConflictingConflicts(
  conflicts: ReadonlyArray<{
    id: number;
    resolved: boolean;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
  }>,
  side: NonConflictingSide
): number[] {
  const out: number[] = [];
  for (const c of conflicts) {
    if (c.resolved) {
      continue;
    }
    if (side === 'left') {
      // Prefer diff3 check when base is known (non-empty).
      if (c.baseContent.length > 0 && c.incomingContent === c.baseContent) {
        out.push(c.id);
        continue;
      }
      // Fall-back: diff2 style where the right side is empty but the left
      // has content — only the left added lines.
      if (
        c.baseContent.length === 0 &&
        c.incomingContent.length === 0 &&
        c.currentContent.length > 0
      ) {
        out.push(c.id);
      }
    } else {
      if (c.baseContent.length > 0 && c.currentContent === c.baseContent) {
        out.push(c.id);
        continue;
      }
      if (
        c.baseContent.length === 0 &&
        c.currentContent.length === 0 &&
        c.incomingContent.length > 0
      ) {
        out.push(c.id);
      }
    }
  }
  return out;
}

/**
 * Convenience: parse raw file contents with conflict markers and return the
 * ids of conflicts resolvable from the given side. Used by tests that
 * exercise the whole pipeline in one call.
 *
 * Note: this is a light parser used only for testing. It mirrors the
 * private parser in {@link MergeView} for diff2 + diff3 marker shapes but
 * ignores VS Code-specific {@link vscode.Range} plumbing.
 */
export function identifyNonConflictingHunks(
  markerText: string,
  side: NonConflictingSide
): number[] {
  const lines = markerText.split('\n');
  interface IHunk {
    id: number;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
    resolved: boolean;
  }
  const hunks: IHunk[] = [];
  let inConflict = false;
  let section: 'current' | 'base' | 'incoming' = 'current';
  let currentBuf: string[] = [];
  let baseBuf: string[] = [];
  let incomingBuf: string[] = [];
  let nextId = 0;
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      section = 'current';
      currentBuf = [];
      baseBuf = [];
      incomingBuf = [];
    } else if (line.startsWith('|||||||') && inConflict) {
      section = 'base';
    } else if (line.startsWith('=======') && inConflict) {
      section = 'incoming';
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      hunks.push({
        id: nextId++,
        baseContent: baseBuf.join('\n'),
        currentContent: currentBuf.join('\n'),
        incomingContent: incomingBuf.join('\n'),
        resolved: false,
      });
      inConflict = false;
    } else if (inConflict) {
      if (section === 'current') {
        currentBuf.push(line);
      } else if (section === 'base') {
        baseBuf.push(line);
      } else {
        incomingBuf.push(line);
      }
    }
  }
  return identifyNonConflictingConflicts(hunks, side);
}
