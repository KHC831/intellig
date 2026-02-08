/**
 * CommandTitleProvider implementation.
 * Dynamically updates command titles based on the selected branch and current HEAD branch.
 *
 * Requirements: 5.1, 5.2, 5.3
 */

import * as vscode from 'vscode';
import { IGitService } from '../services/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from '../services/BranchTreeProvider';

/**
 * Command title template definitions.
 * Each entry maps a command ID to a label template containing placeholders:
 * - `{branch}` is replaced with the right-clicked (selected) branch name
 * - `{current}` is replaced with the current HEAD branch name
 */
const DYNAMIC_TITLE_COMMANDS: ReadonlyArray<{ commandId: string; template: string }> = [
  { commandId: 'intellig.branch.newBranchFrom', template: "New Branch from '{branch}'" },
  { commandId: 'intellig.branch.compareWithCurrent', template: "Compare with '{current}'" },
  {
    commandId: 'intellig.branch.rebaseCurrentOnto',
    template: "Rebase '{current}' onto '{branch}'",
  },
  {
    commandId: 'intellig.branch.mergeIntoCurrent',
    template: "Merge '{branch}' into '{current}'",
  },
  {
    commandId: 'intellig.branch.checkoutAndRebase',
    template: "Checkout and Rebase onto '{current}'",
  },
  {
    commandId: 'intellig.remoteBranch.pullUsingRebase',
    template: "Pull into '{current}' Using Rebase",
  },
  {
    commandId: 'intellig.remoteBranch.pullUsingMerge',
    template: "Pull into '{current}' Using Merge",
  },
];

/**
 * Resolve a label template by substituting placeholders with actual branch names.
 *
 * This is a pure function exported for independent testing.
 *
 * @param template - The label template containing `{branch}` and/or `{current}` placeholders
 * @param branchName - The name of the right-clicked (selected) branch
 * @param currentBranchName - The name of the current HEAD branch (or "HEAD" for detached state)
 * @returns The resolved label with placeholders replaced by actual branch names
 */
export function resolveLabel(
  template: string,
  branchName: string,
  currentBranchName: string
): string {
  return template.replace(/\{branch\}/g, branchName).replace(/\{current\}/g, currentBranchName);
}

/**
 * CommandTitleProvider class.
 * Listens for tree view selection changes and re-registers commands with
 * dynamic titles that include the selected branch name and current branch name.
 */
export class CommandTitleProvider {
  private _gitService: IGitService;
  private _branchTreeProvider: BranchTreeProvider;
  private _titleDisposables: vscode.Disposable[] = [];
  private _selectionDisposable: vscode.Disposable | undefined;

  constructor(gitService: IGitService, branchTreeProvider: BranchTreeProvider) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
  }

  /**
   * Get the git service instance.
   * Exposed for use by future command handlers that need direct git operations.
   */
  get gitService(): IGitService {
    return this._gitService;
  }

  /**
   * Register tree view selection listener and initialize dynamic titles.
   *
   * @param context - The VS Code extension context
   * @param treeView - The branch tree view to listen for selection changes
   */
  register(
    context: vscode.ExtensionContext,
    treeView: vscode.TreeView<BranchTreeItem>
  ): void {
    this._selectionDisposable = treeView.onDidChangeSelection((event) => {
      const selectedItem =
        event.selection.length > 0 ? event.selection[0] : undefined;
      this._updateTitles(selectedItem);
    });

    context.subscriptions.push(this._selectionDisposable);
  }

  /**
   * Update all dynamic command titles based on the selected branch.
   * Disposes previous command registrations before re-registering with new titles.
   *
   * @param selectedItem - The currently selected branch tree item, or undefined if none
   */
  _updateTitles(selectedItem: BranchTreeItem | undefined): void {
    // Dispose previous title command registrations
    for (const disposable of this._titleDisposables) {
      disposable.dispose();
    }
    this._titleDisposables = [];

    if (!selectedItem || !selectedItem.branch) {
      return;
    }

    const branchName = selectedItem.branch.name;
    const currentBranchName = this._getCurrentBranchName();

    for (const { commandId, template } of DYNAMIC_TITLE_COMMANDS) {
      const title = resolveLabel(template, branchName, currentBranchName);

      // Set a context variable so that the title can be resolved by VS Code
      const contextKey = `${commandId}.title`;
      const disposable = vscode.commands.registerCommand(
        `${commandId}.title`,
        () => title
      );

      // Use setContext to make the dynamic title available to VS Code menus
      void vscode.commands.executeCommand('setContext', contextKey, title);

      this._titleDisposables.push(disposable);
    }
  }

  /**
   * Get the current branch name from the repository HEAD.
   * Falls back to "HEAD" for detached HEAD state.
   *
   * @returns The current branch name, or "HEAD" if in detached state
   */
  _getCurrentBranchName(): string {
    const repo = this._branchTreeProvider.getRepository();
    if (!repo || !repo.head?.name) {
      return 'HEAD';
    }

    return repo.head.name.replace(/^refs\/heads\//, '');
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    for (const disposable of this._titleDisposables) {
      disposable.dispose();
    }
    this._titleDisposables = [];

    if (this._selectionDisposable) {
      this._selectionDisposable.dispose();
      this._selectionDisposable = undefined;
    }
  }
}

/**
 * Create a new CommandTitleProvider instance.
 *
 * @param gitService - The Git service to use
 * @param branchTreeProvider - The branch tree provider
 * @returns A new CommandTitleProvider instance
 */
export function createCommandTitleProvider(
  gitService: IGitService,
  branchTreeProvider: BranchTreeProvider
): CommandTitleProvider {
  return new CommandTitleProvider(gitService, branchTreeProvider);
}
