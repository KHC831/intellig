import * as vscode from 'vscode';
import {
  getExtensionServices,
  resetExtensionServices,
  ExtensionServices,
  GitToolWindowProvider,
  GIT_TOOL_WINDOW_VIEW_ID,
  ConsoleService,
  CommitDialog,
  BranchPopup,
  MergeView,
  createMergeView,
  RebaseEditor,
  createRebaseEditor,
  InlineBlameProvider,
  createInlineBlameProvider,
  GutterBlameProvider,
  createGutterBlameProvider,
  StatusBarService,
  createStatusBarService,
  NotificationService,
  createNotificationService,
  KeymapService,
  StashView,
  createStashView,
  ShelfView,
  createShelfView,
  BranchComparisonView,
  createBranchComparisonView,
  RebaseProgressView,
  createRebaseProgressView,
} from './services';
import { IGitService, IRepository } from './services/interfaces/IGitService';

/**
 * Global reference to the extension services container.
 * This is set during activation and cleared during deactivation.
 */
let extensionServices: ExtensionServices | undefined;

/**
 * Global reference to the Git Tool Window Provider.
 */
let gitToolWindowProvider: GitToolWindowProvider | undefined;

/**
 * Global reference to the Commit Dialog.
 */
let commitDialog: CommitDialog | undefined;

/**
 * Global reference to the Branch Popup.
 */
let branchPopup: BranchPopup | undefined;

/**
 * Global reference to the Merge View.
 */
let mergeView: MergeView | undefined;

/**
 * Global reference to the Rebase Editor.
 */
let rebaseEditor: RebaseEditor | undefined;

/**
 * Global reference to the Inline Blame Provider.
 */
let inlineBlameProvider: InlineBlameProvider | undefined;

/**
 * Global reference to the Gutter Blame Provider.
 */
let gutterBlameProvider: GutterBlameProvider | undefined;

/**
 * Global reference to the Status Bar Service.
 */
let statusBarService: StatusBarService | undefined;

/**
 * Global reference to the Notification Service.
 */
let notificationService: NotificationService | undefined;

/**
 * Global reference to the Keymap Service.
 */
let keymapService: KeymapService | undefined;

/**
 * Global reference to the Stash View.
 */
let stashView: StashView | undefined;

/**
 * Global reference to the Shelf View.
 */
let shelfView: ShelfView | undefined;

/**
 * Global reference to the Branch Comparison View.
 */
let branchComparisonView: BranchComparisonView | undefined;

/**
 * Global reference to the Rebase Progress View.
 */
let rebaseProgressView: RebaseProgressView | undefined;

/**
 * This method is called when the extension is activated.
 * The extension is activated based on the activation events defined in package.json.
 *
 * @param context - The VS Code extension context providing subscriptions,
 *                  storage paths, and other extension-specific utilities.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('IntelliG extension is activating...');

  try {
    // Get or create the extension services container
    extensionServices = getExtensionServices();

    // Initialize all services
    await extensionServices.initialize(context);

    // Register commands
    registerCommands(context);

    // Register views and providers
    registerViews(context);

    // Set up event listeners
    setupEventListeners(context);

    console.log('IntelliG extension is now active');
  } catch (error) {
    console.error('Failed to activate IntelliG extension:', error);
    void vscode.window.showErrorMessage(
      `Failed to activate IntelliG extension: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    throw error;
  }
}

/**
 * This method is called when the extension is deactivated.
 * Clean up any resources and dispose of services.
 */
export function deactivate(): void {
  console.log('IntelliG extension is deactivating...');

  try {
    // Dispose the Merge View
    if (mergeView) {
      mergeView.dispose();
      mergeView = undefined;
    }

    // Dispose the Rebase Editor
    if (rebaseEditor) {
      rebaseEditor.dispose();
      rebaseEditor = undefined;
    }

    // Dispose the Rebase Progress View
    if (rebaseProgressView) {
      rebaseProgressView.dispose();
      rebaseProgressView = undefined;
    }

    // Dispose the Inline Blame Provider
    if (inlineBlameProvider) {
      inlineBlameProvider.dispose();
      inlineBlameProvider = undefined;
    }

    // Dispose the Gutter Blame Provider
    if (gutterBlameProvider) {
      gutterBlameProvider.dispose();
      gutterBlameProvider = undefined;
    }

    // Dispose the Commit Dialog
    if (commitDialog) {
      commitDialog.dispose();
      commitDialog = undefined;
    }

    // Dispose the Branch Popup
    if (branchPopup) {
      branchPopup.dispose();
      branchPopup = undefined;
    }

    // Dispose the Stash View
    if (stashView) {
      stashView.dispose();
      stashView = undefined;
    }

    // Dispose the Shelf View
    if (shelfView) {
      shelfView.dispose();
      shelfView = undefined;
    }

    // Dispose the Branch Comparison View
    if (branchComparisonView) {
      branchComparisonView.dispose();
      branchComparisonView = undefined;
    }

    // Dispose the Status Bar Service
    if (statusBarService) {
      statusBarService.dispose();
      statusBarService = undefined;
    }

    // Dispose the Notification Service
    if (notificationService) {
      notificationService.dispose();
      notificationService = undefined;
    }

    // Dispose the Keymap Service
    if (keymapService) {
      keymapService.dispose();
      keymapService = undefined;
    }

    // Dispose the Git Tool Window Provider
    if (gitToolWindowProvider) {
      gitToolWindowProvider.dispose();
      gitToolWindowProvider = undefined;
    }

    // Reset the extension services (this will dispose all services)
    resetExtensionServices();
    extensionServices = undefined;

    console.log('IntelliG extension is now deactivated');
  } catch (error) {
    console.error('Error during extension deactivation:', error);
  }
}

/**
 * Register all extension commands.
 *
 * @param context - The VS Code extension context
 */
function registerCommands(context: vscode.ExtensionContext): void {
  // Open Git Tool Window command
  const openGitToolWindowCommand = vscode.commands.registerCommand(
    'intellig.openGitToolWindow',
    () => {
      // Focus the Git Tool Window view
      void vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
    }
  );

  // Commit command
  const commitCommand = vscode.commands.registerCommand('intellig.commit', async () => {
    // Get the Git service and find a repository
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    const repositories = gitService.getRepositories();

    if (repositories.length === 0) {
      // Try to discover repositories
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repo = await gitService.getRepository(workspaceFolders[0].uri);
        if (!repo) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return;
        }
        // Show commit dialog
        if (!commitDialog) {
          commitDialog = new CommitDialog(context.extensionUri, gitService);
        }
        await commitDialog.show(repo);
      } else {
        void vscode.window.showErrorMessage('No workspace folder open');
      }
      return;
    }

    // Use the first repository (or could show a picker if multiple)
    const repo = repositories[0];

    // Show commit dialog
    if (!commitDialog) {
      commitDialog = new CommitDialog(context.extensionUri, gitService);
    }
    await commitDialog.show(repo);
  });

  // Push command
  const pushCommand = vscode.commands.registerCommand('intellig.push', () => {
    // TODO: Implement in task 12.3
    void vscode.window.showInformationMessage('Push - Coming Soon');
  });

  // Pull command
  const pullCommand = vscode.commands.registerCommand('intellig.pull', () => {
    // TODO: Implement in task 12.3
    void vscode.window.showInformationMessage('Pull - Coming Soon');
  });

  // Fetch command
  const fetchCommand = vscode.commands.registerCommand('intellig.fetch', () => {
    // TODO: Implement in task 12.3
    void vscode.window.showInformationMessage('Fetch - Coming Soon');
  });

  // Branch popup command
  const branchPopupCommand = vscode.commands.registerCommand(
    'intellig.showBranchPopup',
    async () => {
      // Get the Git service
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;

      // Create branch popup if not exists
      if (!branchPopup) {
        branchPopup = new BranchPopup(gitService);
      }

      // Show the branch popup
      await branchPopup.show();
    }
  );

  // Stash changes command
  // Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
  const stashCommand = vscode.commands.registerCommand('intellig.stash', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    const repositories = gitService.getRepositories();

    if (repositories.length === 0) {
      // Try to discover repositories
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repo = await gitService.getRepository(workspaceFolders[0].uri);
        if (!repo) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return;
        }
        // Create stash view if not exists and show it
        if (!stashView) {
          stashView = createStashView(gitService);
        }
        await stashView.showCreateDialog(repo);
      } else {
        void vscode.window.showErrorMessage('No workspace folder open');
      }
      return;
    }

    const repo = repositories[0];

    // Create stash view if not exists and show create dialog
    if (!stashView) {
      stashView = createStashView(gitService);
    }
    await stashView.showCreateDialog(repo);
  });

  // Show stash list command
  const showStashListCommand = vscode.commands.registerCommand(
    'intellig.showStashList',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Create stash view if not exists and show it
      if (!stashView) {
        stashView = createStashView(gitService);
      }
      await stashView.show(repo);
    }
  );

  // Shelve changes command
  // Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
  const shelveCommand = vscode.commands.registerCommand('intellig.shelve', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    const repositories = gitService.getRepositories();

    if (repositories.length === 0) {
      // Try to discover repositories
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repo = await gitService.getRepository(workspaceFolders[0].uri);
        if (!repo) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return;
        }
        // Create shelf view if not exists and show shelve dialog
        if (!shelfView) {
          shelfView = createShelfView(extensionServices.shelfService, (r) =>
            gitService.getStatus(r)
          );
        }
        await shelfView.showShelveDialog(repo);
      } else {
        void vscode.window.showErrorMessage('No workspace folder open');
      }
      return;
    }

    const repo = repositories[0];

    // Create shelf view if not exists and show shelve dialog
    if (!shelfView) {
      shelfView = createShelfView(extensionServices.shelfService, (r) => gitService.getStatus(r));
    }
    await shelfView.showShelveDialog(repo);
  });

  // Show shelf list command
  const showShelfListCommand = vscode.commands.registerCommand(
    'intellig.showShelfList',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Create shelf view if not exists and show it
      if (!shelfView) {
        shelfView = createShelfView(extensionServices.shelfService, (r) => gitService.getStatus(r));
      }
      await shelfView.show(repo);
    }
  );

  // Toggle blame annotations command
  // Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7 (Blame)
  const toggleBlameCommand = vscode.commands.registerCommand('intellig.toggleBlame', () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Toggle inline blame
    if (!inlineBlameProvider) {
      inlineBlameProvider = createInlineBlameProvider(
        extensionServices.blameService,
        extensionServices.gitService
      );
    }

    const enabled = inlineBlameProvider.toggle();
    void vscode.window.showInformationMessage(
      `Inline blame annotations ${enabled ? 'enabled' : 'disabled'}`
    );
  });

  // Toggle gutter blame annotations command
  const toggleGutterBlameCommand = vscode.commands.registerCommand(
    'intellig.toggleGutterBlame',
    () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      // Toggle gutter blame
      if (!gutterBlameProvider) {
        gutterBlameProvider = createGutterBlameProvider(
          extensionServices.blameService,
          extensionServices.gitService
        );
      }

      const enabled = gutterBlameProvider.toggle();
      void vscode.window.showInformationMessage(
        `Gutter blame annotations ${enabled ? 'enabled' : 'disabled'}`
      );
    }
  );

  // Compare with branch command
  // Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
  const compareWithBranchCommand = vscode.commands.registerCommand(
    'intellig.compareWithBranch',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Create branch comparison view if not exists and show it
      if (!branchComparisonView) {
        branchComparisonView = createBranchComparisonView(gitService);
      }
      await branchComparisonView.show(repo);
    }
  );

  // Compare with remote command
  // Requirement: 15.5
  const compareWithRemoteCommand = vscode.commands.registerCommand(
    'intellig.compareWithRemote',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Create branch comparison view if not exists and compare with remote
      if (!branchComparisonView) {
        branchComparisonView = createBranchComparisonView(gitService);
      }
      await branchComparisonView.compareWithRemote(repo);
    }
  );

  // Refresh command - refreshes all Git views
  const refreshCommand = vscode.commands.registerCommand('intellig.refresh', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Refresh the Git Tool Window
    if (gitToolWindowProvider) {
      // In the 3-panel layout, always refresh all panels
      gitToolWindowProvider.refresh();
    }

    void vscode.window.showInformationMessage('Git views refreshed');
  });

  // Stage selected files command
  const stageSelectedCommand = vscode.commands.registerCommand(
    'intellig.stageSelected',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get the active editor's file or selected files from explorer
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        try {
          await gitService.stage(repo, [filePath]);
          void vscode.window.showInformationMessage(`Staged: ${filePath}`);
          // Refresh views
          if (gitToolWindowProvider) {
            gitToolWindowProvider.refresh();
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Failed to stage file: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      } else {
        void vscode.window.showInformationMessage('No file selected to stage');
      }
    }
  );

  // Unstage selected files command
  const unstageSelectedCommand = vscode.commands.registerCommand(
    'intellig.unstageSelected',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get the active editor's file or selected files from explorer
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        try {
          await gitService.unstage(repo, [filePath]);
          void vscode.window.showInformationMessage(`Unstaged: ${filePath}`);
          // Refresh views
          if (gitToolWindowProvider) {
            gitToolWindowProvider.refresh();
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Failed to unstage file: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      } else {
        void vscode.window.showInformationMessage('No file selected to unstage');
      }
    }
  );

  // Merge View commands
  // Requirements: 10.2, 10.3, 10.4, 10.7, 17.9
  const openMergeViewCommand = vscode.commands.registerCommand(
    'intellig.merge.openMergeView',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      // Get the file to open in merge view
      let filePath: string;
      if (fileUri) {
        filePath = fileUri.fsPath;
      } else {
        // If no file provided, show a picker for conflicted files
        const gitService = extensionServices.gitService;
        const repositories = gitService.getRepositories();
        if (repositories.length === 0) {
          void vscode.window.showErrorMessage('No Git repository found');
          return;
        }

        const repo = repositories[0];
        const status = await gitService.getStatus(repo);
        const conflictedFiles = status.filter(
          (f) => f.indexStatus === 'U' || f.workTreeStatus === 'U'
        );

        if (conflictedFiles.length === 0) {
          void vscode.window.showInformationMessage('No conflicted files found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          conflictedFiles.map((f) => ({
            label: f.path,
            description: 'Conflicted',
          })),
          { placeHolder: 'Select a conflicted file to resolve' }
        );

        if (!selected) {
          return;
        }
        filePath = selected.label;
      }

      // Create merge view if not exists
      if (!mergeView) {
        mergeView = createMergeView(context.extensionUri, extensionServices.gitService);
      }

      try {
        await mergeView.show(filePath);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to open merge view: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  const acceptCurrentCommand = vscode.commands.registerCommand(
    'intellig.merge.acceptCurrent',
    () => {
      if (mergeView) {
        mergeView.acceptCurrent();
      }
    }
  );

  const acceptIncomingCommand = vscode.commands.registerCommand(
    'intellig.merge.acceptIncoming',
    () => {
      if (mergeView) {
        mergeView.acceptIncoming();
      }
    }
  );

  const acceptBothCommand = vscode.commands.registerCommand('intellig.merge.acceptBoth', () => {
    if (mergeView) {
      mergeView.acceptBoth();
    }
  });

  const acceptAllCurrentCommand = vscode.commands.registerCommand(
    'intellig.merge.acceptAllCurrent',
    () => {
      if (mergeView) {
        mergeView.acceptAllCurrent();
      }
    }
  );

  const acceptAllIncomingCommand = vscode.commands.registerCommand(
    'intellig.merge.acceptAllIncoming',
    () => {
      if (mergeView) {
        mergeView.acceptAllIncoming();
      }
    }
  );

  const nextConflictCommand = vscode.commands.registerCommand(
    'intellig.merge.nextConflict',
    () => {
      if (mergeView) {
        mergeView.nextConflict();
      }
    }
  );

  const previousConflictCommand = vscode.commands.registerCommand(
    'intellig.merge.previousConflict',
    () => {
      if (mergeView) {
        mergeView.previousConflict();
      }
    }
  );

  const markResolvedCommand = vscode.commands.registerCommand(
    'intellig.merge.markResolved',
    async () => {
      if (mergeView) {
        await mergeView.markResolved();
      }
    }
  );

  // Conflict Resolution commands
  // Requirements: 10.1, 10.5, 10.6, 10.8
  const markFileResolvedCommand = vscode.commands.registerCommand(
    'intellig.conflict.markResolved',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path
      let filePath: string;
      if (fileUri) {
        const repoRoot = repo.rootUri.fsPath;
        filePath = fileUri.fsPath.replace(repoRoot + '/', '').replace(repoRoot + '\\', '');
      } else {
        // Show picker for conflicted files
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length === 0) {
          void vscode.window.showInformationMessage('No conflicted files found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          conflicts.map((c) => ({ label: c.path })),
          { placeHolder: 'Select a file to mark as resolved' }
        );

        if (!selected) {
          return;
        }
        filePath = selected.label;
      }

      const result = await conflictService.markResolved(repo, filePath);
      if (result.success) {
        void vscode.window.showInformationMessage(`Marked ${filePath} as resolved`);
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to mark file as resolved');
      }
    }
  );

  const acceptAllCurrentFilesCommand = vscode.commands.registerCommand(
    'intellig.conflict.acceptAllCurrent',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];
      const conflicts = await conflictService.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage('No conflicted files found');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Accept current (ours) version for ${conflicts.length} conflicted file(s)?`,
        { modal: true },
        'Accept All Current'
      );

      if (confirm !== 'Accept All Current') {
        return;
      }

      const result = await conflictService.acceptAllCurrent(repo);
      if (result.success) {
        void vscode.window.showInformationMessage(
          'Accepted current version for all conflicted files'
        );
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to accept current version');
      }
    }
  );

  const acceptAllIncomingFilesCommand = vscode.commands.registerCommand(
    'intellig.conflict.acceptAllIncoming',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];
      const conflicts = await conflictService.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage('No conflicted files found');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Accept incoming (theirs) version for ${conflicts.length} conflicted file(s)?`,
        { modal: true },
        'Accept All Incoming'
      );

      if (confirm !== 'Accept All Incoming') {
        return;
      }

      const result = await conflictService.acceptAllIncoming(repo);
      if (result.success) {
        void vscode.window.showInformationMessage(
          'Accepted incoming version for all conflicted files'
        );
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to accept incoming version');
      }
    }
  );

  const completeMergeCommand = vscode.commands.registerCommand(
    'intellig.conflict.completeMerge',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Check if we can complete
      const canComplete = await conflictService.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot complete merge: ${conflicts.length} unresolved conflict(s) remain`
          );
          return;
        }
      }

      const result = await conflictService.completeMerge(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Merge completed successfully');
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to complete merge');
      }
    }
  );

  const completeRebaseCommand = vscode.commands.registerCommand(
    'intellig.conflict.completeRebase',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Check if we can complete
      const canComplete = await conflictService.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot continue rebase: ${conflicts.length} unresolved conflict(s) remain`
          );
          return;
        }
      }

      const result = await conflictService.completeRebase(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Rebase continued successfully');
      } else if (result.remainingConflicts && result.remainingConflicts.length > 0) {
        void vscode.window.showWarningMessage(
          `Rebase paused: ${result.remainingConflicts.length} more conflict(s) to resolve`
        );
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to continue rebase');
      }
    }
  );

  const abortMergeCommand = vscode.commands.registerCommand(
    'intellig.conflict.abortMerge',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to abort the merge? All changes will be lost.',
        { modal: true },
        'Abort Merge'
      );

      if (confirm !== 'Abort Merge') {
        return;
      }

      const result = await conflictService.abortMerge(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Merge aborted');
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to abort merge');
      }
    }
  );

  const abortRebaseCommand = vscode.commands.registerCommand(
    'intellig.conflict.abortRebase',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = extensionServices.conflictResolutionService;
      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to abort the rebase? All changes will be lost.',
        { modal: true },
        'Abort Rebase'
      );

      if (confirm !== 'Abort Rebase') {
        return;
      }

      const result = await conflictService.abortRebase(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Rebase aborted');
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to abort rebase');
      }
    }
  );

  // Interactive Rebase command
  // Requirements: 6.1, 6.2, 6.3
  const interactiveRebaseCommand = vscode.commands.registerCommand(
    'intellig.rebase.interactive',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const rebaseService = extensionServices.rebaseService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        // Try to discover repositories
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const repo = await gitService.getRepository(workspaceFolders[0].uri);
          if (!repo) {
            void vscode.window.showErrorMessage('No Git repository found in workspace');
            return;
          }
        } else {
          void vscode.window.showErrorMessage('No workspace folder open');
          return;
        }
      }

      const repo =
        repositories[0] ||
        (await gitService.getRepository(vscode.workspace.workspaceFolders![0].uri));
      if (!repo) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      // Get branches for the user to select the target
      const branches = await gitService.getBranches(repo);
      const branchItems = branches
        .filter((b) => !b.isHead)
        .map((b) => ({
          label: b.name,
          description: b.type === 'remote' ? 'Remote' : 'Local',
          detail: b.commit.substring(0, 7),
        }));

      // Also add recent commits as options
      const commits = await gitService.getLog(repo, { maxCount: 20 });
      const commitItems = commits.map((c) => ({
        label: c.shortHash,
        description: c.message.substring(0, 50),
        detail: `${c.author.name} - ${c.authorDate.toLocaleDateString()}`,
      }));

      const allItems = [
        { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
        ...branchItems,
        { label: 'Recent Commits', kind: vscode.QuickPickItemKind.Separator },
        ...commitItems,
      ];

      const selected = await vscode.window.showQuickPick(allItems as vscode.QuickPickItem[], {
        placeHolder: 'Select a branch or commit to rebase onto',
        title: 'Interactive Rebase',
      });

      if (!selected || selected.kind === vscode.QuickPickItemKind.Separator) {
        return;
      }

      // Create rebase editor if not exists
      if (!rebaseEditor) {
        rebaseEditor = createRebaseEditor(context.extensionUri, rebaseService);
      }

      try {
        await rebaseEditor.show(repo, { onto: selected.label });
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to start interactive rebase: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // File Explorer Context Menu Commands
  // Requirements: 2.7, 17.6

  // Show History command for file explorer
  const explorerShowHistoryCommand = vscode.commands.registerCommand(
    'intellig.explorer.showHistory',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      try {
        const history = await gitService.getFileHistory(repo, filePath);
        if (history.length === 0) {
          void vscode.window.showInformationMessage(`No history found for ${filePath}`);
          return;
        }

        // Show history in a quick pick
        const items = history.map((commit) => ({
          label: commit.shortHash,
          description: commit.message.substring(0, 60),
          detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
          commit,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `History for ${filePath}`,
          title: 'File History',
        });

        if (selected) {
          // Show the diff for the selected commit
          const diff = await gitService.getCommitDiff(repo, selected.commit.hash);
          const fileDiff = diff.find((d) => d.path === filePath || d.oldPath === filePath);
          if (fileDiff) {
            // Open diff view
            void vscode.window.showInformationMessage(
              `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
            );
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to get file history: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Compare with Branch command for file explorer
  const explorerCompareWithBranchCommand = vscode.commands.registerCommand(
    'intellig.explorer.compareWithBranch',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path from URI or active editor
      let filePath: string;
      let fileUriToUse: vscode.Uri;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
        fileUriToUse = fileUri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        fileUriToUse = activeEditor.document.uri;
      }

      try {
        // Get branches for selection
        const branches = await gitService.getBranches(repo);
        const branchItems = branches.map((b) => ({
          label: b.name,
          description: b.type === 'remote' ? 'Remote' : b.isHead ? 'Current' : 'Local',
        }));

        const selected = await vscode.window.showQuickPick(branchItems, {
          placeHolder: 'Select a branch to compare with',
          title: `Compare ${filePath} with Branch`,
        });

        if (!selected) {
          return;
        }

        // Use VS Code's built-in diff command to compare
        const branchUri = vscode.Uri.parse(`git:${filePath}?ref=${selected.label}`);
        await vscode.commands.executeCommand(
          'vscode.diff',
          branchUri,
          fileUriToUse,
          `${filePath} (${selected.label} ↔ Working Tree)`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to compare with branch: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Revert command for file explorer
  const explorerRevertCommand = vscode.commands.registerCommand(
    'intellig.explorer.revert',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      // Confirm revert
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert changes to ${filePath}? This cannot be undone.`,
        { modal: true },
        'Revert'
      );

      if (confirm !== 'Revert') {
        return;
      }

      try {
        await gitService.revertFile(repo, filePath);
        void vscode.window.showInformationMessage(`Reverted: ${filePath}`);
        // Refresh views
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to revert file: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Stage command for file explorer
  const explorerStageCommand = vscode.commands.registerCommand(
    'intellig.explorer.stage',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      try {
        await gitService.stage(repo, [filePath]);
        void vscode.window.showInformationMessage(`Staged: ${filePath}`);
        // Refresh views
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to stage file: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Unstage command for file explorer
  const explorerUnstageCommand = vscode.commands.registerCommand(
    'intellig.explorer.unstage',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      try {
        await gitService.unstage(repo, [filePath]);
        void vscode.window.showInformationMessage(`Unstaged: ${filePath}`);
        // Refresh views
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to unstage file: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Show Diff command for file explorer
  const explorerShowDiffCommand = vscode.commands.registerCommand(
    'intellig.explorer.showDiff',
    async (fileUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = extensionServices.gitService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      // Get file path from URI or active editor
      let filePath: string;
      let fileUriToUse: vscode.Uri;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
        fileUriToUse = fileUri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        fileUriToUse = activeEditor.document.uri;
      }

      try {
        // Use VS Code's built-in Git diff command
        const gitUri = vscode.Uri.parse(`git:${filePath}?ref=HEAD`);
        await vscode.commands.executeCommand(
          'vscode.diff',
          gitUri,
          fileUriToUse,
          `${filePath} (HEAD ↔ Working Tree)`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to show diff: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Editor Context Menu Commands
  // Requirements: 9.5 (Blame)

  // Toggle Blame Annotations command for editor context menu
  const editorToggleBlameCommand = vscode.commands.registerCommand(
    'intellig.editor.toggleBlame',
    () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      // Create inline blame provider if not exists
      if (!inlineBlameProvider) {
        inlineBlameProvider = createInlineBlameProvider(
          extensionServices.blameService,
          extensionServices.gitService
        );
      }

      const enabled = inlineBlameProvider.toggle();
      void vscode.window.showInformationMessage(
        `Blame annotations ${enabled ? 'enabled' : 'disabled'}`
      );
    }
  );

  // Show Line History command for editor context menu
  const editorShowLineHistoryCommand = vscode.commands.registerCommand(
    'intellig.editor.showLineHistory',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = extensionServices.gitService;
      const blameService = extensionServices.blameService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed

      try {
        // Get blame info for the current line
        const blameLine = await blameService.getBlameForLine(repo, filePath, line);

        if (blameLine.commit.startsWith('0000000')) {
          void vscode.window.showInformationMessage('This line has not been committed yet');
          return;
        }

        // Get the file history and filter to commits that modified this line
        const history = await gitService.getFileHistory(repo, filePath);

        // Show history in a quick pick
        const items = history.map((commit) => ({
          label: commit.shortHash,
          description: commit.message.substring(0, 60),
          detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
          commit,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `History for line ${line} in ${filePath}`,
          title: 'Line History',
        });

        if (selected) {
          void vscode.window.showInformationMessage(
            `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to get line history: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Copy Commit Hash command for editor context menu
  const editorCopyCommitHashCommand = vscode.commands.registerCommand(
    'intellig.editor.copyCommitHash',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = extensionServices.gitService;
      const blameService = extensionServices.blameService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed

      try {
        // Get blame info for the current line
        const blameLine = await blameService.getBlameForLine(repo, filePath, line);

        if (blameLine.commit.startsWith('0000000')) {
          void vscode.window.showInformationMessage('This line has not been committed yet');
          return;
        }

        // Copy the commit hash to clipboard
        await vscode.env.clipboard.writeText(blameLine.commit);
        void vscode.window.showInformationMessage(
          `Copied commit hash: ${blameLine.commit.substring(0, 7)}`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to copy commit hash: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Show Commit command for editor context menu
  const editorShowCommitCommand = vscode.commands.registerCommand(
    'intellig.editor.showCommit',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = extensionServices.gitService;
      const blameService = extensionServices.blameService;
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      const repo = repositories[0];
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed

      try {
        // Get blame info for the current line
        const blameLine = await blameService.getBlameForLine(repo, filePath, line);

        if (blameLine.commit.startsWith('0000000')) {
          void vscode.window.showInformationMessage('This line has not been committed yet');
          return;
        }

        // Get full commit details
        const commit = await gitService.getCommit(repo, blameLine.commit);

        // Get the diff for this commit
        const diffs = await gitService.getCommitDiff(repo, commit.hash);

        // Show commit details in a quick pick with options
        const items = [
          {
            label: '$(git-commit) View Commit Details',
            description: `${commit.shortHash} - ${commit.message.substring(0, 40)}`,
            action: 'details',
          },
          {
            label: '$(files) View Changed Files',
            description: `${diffs.length} file(s) changed`,
            action: 'files',
          },
          {
            label: '$(clippy) Copy Commit Hash',
            description: commit.hash,
            action: 'copy',
          },
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Commit ${commit.shortHash}: ${commit.message.substring(0, 50)}`,
          title: 'Show Commit',
        });

        if (selected) {
          switch (selected.action) {
            case 'details': {
              // Show full commit details in an information message
              const dateStr = commit.authorDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              void vscode.window.showInformationMessage(
                `Commit: ${commit.shortHash}\nAuthor: ${commit.author.name}\nDate: ${dateStr}\n\n${commit.message}`,
                { modal: true }
              );
              break;
            }
            case 'files': {
              // Show changed files in a quick pick
              const fileItems = diffs.map((d) => ({
                label: d.path,
                description: d.status,
              }));
              await vscode.window.showQuickPick(fileItems, {
                placeHolder: `Files changed in ${commit.shortHash}`,
                title: 'Changed Files',
              });
              break;
            }
            case 'copy':
              await vscode.env.clipboard.writeText(commit.hash);
              void vscode.window.showInformationMessage(`Copied commit hash: ${commit.shortHash}`);
              break;
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to show commit: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  );

  // Register all commands with the extension context
  context.subscriptions.push(
    openGitToolWindowCommand,
    commitCommand,
    pushCommand,
    pullCommand,
    fetchCommand,
    branchPopupCommand,
    stashCommand,
    showStashListCommand,
    shelveCommand,
    showShelfListCommand,
    toggleBlameCommand,
    toggleGutterBlameCommand,
    compareWithBranchCommand,
    compareWithRemoteCommand,
    refreshCommand,
    stageSelectedCommand,
    unstageSelectedCommand,
    openMergeViewCommand,
    acceptCurrentCommand,
    acceptIncomingCommand,
    acceptBothCommand,
    acceptAllCurrentCommand,
    acceptAllIncomingCommand,
    nextConflictCommand,
    previousConflictCommand,
    markResolvedCommand,
    markFileResolvedCommand,
    acceptAllCurrentFilesCommand,
    acceptAllIncomingFilesCommand,
    completeMergeCommand,
    completeRebaseCommand,
    abortMergeCommand,
    abortRebaseCommand,
    interactiveRebaseCommand,
    // File Explorer Context Menu Commands
    explorerShowHistoryCommand,
    explorerCompareWithBranchCommand,
    explorerRevertCommand,
    explorerStageCommand,
    explorerUnstageCommand,
    explorerShowDiffCommand,
    // Editor Context Menu Commands
    editorToggleBlameCommand,
    editorShowLineHistoryCommand,
    editorCopyCommitHashCommand,
    editorShowCommitCommand
  );
}

/**
 * Register views and view providers.
 *
 * @param context - The VS Code extension context
 */
function registerViews(context: vscode.ExtensionContext): void {
  // Create and register the Git Tool Window Provider (single webview, 3-panel layout)
  // Requirement 6.3: Register only the single webview view for the 3-panel layout
  gitToolWindowProvider = new GitToolWindowProvider(context.extensionUri, context.workspaceState);

  // Connect the Console Service to the Git Tool Window Provider
  // This enables real-time Git command output display (Requirement 1.4)
  if (extensionServices) {
    const consoleService = extensionServices.consoleService;
    if (consoleService instanceof ConsoleService) {
      consoleService.connectToToolWindow(gitToolWindowProvider);
    }
  }

  const gitToolWindowRegistration = vscode.window.registerWebviewViewProvider(
    GIT_TOOL_WINDOW_VIEW_ID,
    gitToolWindowProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }
  );

  context.subscriptions.push(gitToolWindowRegistration);

  // Wire up Log tab data loading
  // When the Log tab becomes active, fetch commits and display the graph
  if (extensionServices) {
    const gitService = extensionServices.gitService;

    // Helper to load branch data into the Branch Panel
    const loadBranchData = async (): Promise<void> => {
      let repositories = gitService.getRepositories();
      // If no repositories discovered yet, try to discover from workspace folders
      if (repositories.length === 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const repo = await gitService.getRepository(workspaceFolders[0].uri);
          if (repo) {
            repositories = [repo];
          }
        }
      }
      if (repositories.length === 0) {
        if (gitToolWindowProvider) {
          gitToolWindowProvider.setNoRepository();
        }
        return;
      }
      const repo = repositories[0];
      try {
        const branches = await gitService.getBranches(repo);
        const head = repo.head;

        // Build IBranchPanelData
        const localBranches = branches.filter(b => b.type === 'local');
        const remoteBranches = branches.filter(b => b.type === 'remote');

        // Group remote branches by remote name
        const remoteGroups = new Map<string, typeof remoteBranches>();
        for (const branch of remoteBranches) {
          const parts = branch.name.split('/');
          const remoteName = parts[0] || 'origin';
          const existing = remoteGroups.get(remoteName) || [];
          existing.push(branch);
          remoteGroups.set(remoteName, existing);
        }

        const branchPanelData = {
          head: {
            name: head?.name?.replace('refs/heads/', '') || head?.commit?.substring(0, 7) || 'HEAD',
            isDetached: !head?.name,
            commitHash: head?.commit,
          },
          local: localBranches,
          remote: Array.from(remoteGroups.entries()).map(([remoteName, branchList]) => ({
            remoteName,
            branches: branchList,
          })),
        };

        if (gitToolWindowProvider) {
          gitToolWindowProvider.updateBranches(branchPanelData);
        }
      } catch (error) {
        console.error('Failed to load branch data:', error);
      }
    };

    // Helper to load commits into the log view
    const loadLogCommits = async (filter?: { author?: string; since?: Date; until?: Date; path?: string; searchText?: string }): Promise<void> => {
      let repositories = gitService.getRepositories();
      // If no repositories discovered yet, try to discover from workspace folders
      if (repositories.length === 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const repo = await gitService.getRepository(workspaceFolders[0].uri);
          if (repo) {
            repositories = [repo];
          }
        }
      }
      if (repositories.length === 0) {
        return;
      }
      const repo = repositories[0];
      try {
        const commits = await gitService.getLog(repo, {
          maxCount: 500,
          all: true,
          author: filter?.author,
          since: filter?.since,
          until: filter?.until,
          path: filter?.path,
          grep: filter?.searchText,
        });

        // Build branch map: commit hash -> branch names
        const branchMap = new Map<string, string[]>();
        try {
          const branches = await gitService.getBranches(repo);
          for (const branch of branches) {
            if (branch.commit) {
              const existing = branchMap.get(branch.commit) || [];
              existing.push(branch.name);
              branchMap.set(branch.commit, existing);
            }
          }
        } catch {
          // Branches are optional for graph rendering
        }

        // Build tag map: commit hash -> tag names
        const tagMap = new Map<string, string[]>();
        try {
          const tags = await gitService.getTags(repo);
          for (const tag of tags) {
            if (tag.commit) {
              const existing = tagMap.get(tag.commit) || [];
              existing.push(tag.name);
              tagMap.set(tag.commit, existing);
            }
          }
        } catch {
          // Tags are optional for graph rendering
        }

        if (gitToolWindowProvider) {
          gitToolWindowProvider.updateLogState(commits, branchMap, tagMap);
        }
      } catch (error) {
        console.error('Failed to load git log:', error);
      }
    };

    // Helper to load all panel data (branches + commits)
    const loadAllPanelData = async (): Promise<void> => {
      await loadBranchData();
      await loadLogCommits();
    };

    // Wire up onDidRequestInitialData to load all data when webview first opens
    // Requirement 5.3: Load branch data, commit history on first open
    const initialDataListener = gitToolWindowProvider.onDidRequestInitialData(() => {
      void loadAllPanelData();
    });
    context.subscriptions.push(initialDataListener);

    // Wire up onDidRequestRefresh to reload all data when repository changes
    // Requirement 5.2: Refresh all panels when the git repository changes
    const refreshListener = gitToolWindowProvider.onDidRequestRefresh(() => {
      void loadAllPanelData();
    });
    context.subscriptions.push(refreshListener);

    // Load commits when log filter changes
    const filterChangeListener = gitToolWindowProvider.onDidRequestLogFilter((filter) => {
      void loadLogCommits(filter ? {
        author: filter.author,
        since: filter.since,
        until: filter.until,
        path: filter.path,
        searchText: filter.searchText,
      } : undefined);
    });
    context.subscriptions.push(filterChangeListener);

    // In the 3-panel layout, load all data immediately
    void loadAllPanelData();
  }

  // Register branch context menu commands and other services
  // Requirements: 5.1, 5.2, 5.7, 5.8, 17.6
  if (extensionServices) {
    const gitService = extensionServices.gitService;

    // Note: BranchTreeProvider registration removed (Requirement 6.2).
    // Branch display is now handled within the webview's Branch Panel.
    // Branch context menu actions are now wired via webview messages
    // from GitToolWindowProvider.onDidRequestBranchContextAction.
    // Requirements: 2.7 (local branch context menu), 2.8 (remote branch context menu)
    if (gitToolWindowProvider) {
      const branchContextActionListener = gitToolWindowProvider.onDidRequestBranchContextAction(
        async (event) => {
          await handleBranchContextAction(gitService, event);
          // Refresh the tool window after any branch action
          if (gitToolWindowProvider) {
            gitToolWindowProvider.refresh();
          }
        }
      );
      context.subscriptions.push(branchContextActionListener);
    }

    // Initialize Status Bar Service
    // Requirements: 4.1, 17.8 - Display current branch name in status bar
    statusBarService = createStatusBarService(gitService);
    context.subscriptions.push(statusBarService);

    // Initialize Notification Service
    // Requirement: 17.8 - Display progress and status notifications
    notificationService = createNotificationService();
    context.subscriptions.push(notificationService);

    // Initialize Keymap Service
    // Requirement: 17.11 - IntelliJ-style keyboard shortcuts
    keymapService = new KeymapService(extensionServices.configurationService);
    context.subscriptions.push(keymapService);

    // Initialize Stash View
    // Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
    stashView = createStashView(gitService);
    context.subscriptions.push(stashView);

    // Initialize Shelf View
    // Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
    shelfView = createShelfView(extensionServices.shelfService, (repo) =>
      gitService.getStatus(repo)
    );
    context.subscriptions.push(shelfView);

    // Initialize Branch Comparison View
    // Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
    branchComparisonView = createBranchComparisonView(gitService);
    context.subscriptions.push(branchComparisonView);

    // Initialize Gutter Blame Provider
    // Requirements: 9.2, 9.5, 9.7 (Blame)
    gutterBlameProvider = createGutterBlameProvider(extensionServices.blameService, gitService);
    context.subscriptions.push(gutterBlameProvider);

    // Initialize Rebase Progress View
    // Requirements: 6.7, 6.8, 6.9
    rebaseProgressView = createRebaseProgressView(
      context.extensionUri,
      extensionServices.rebaseService
    );
    context.subscriptions.push(rebaseProgressView);
  }
}

/**
 * Set up event listeners for workspace and Git changes.
 *
 * @param context - The VS Code extension context
 */
function setupEventListeners(context: vscode.ExtensionContext): void {
  // Listen for workspace folder changes
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    // TODO: Handle workspace folder changes
    console.log(
      'Workspace folders changed:',
      event.added.length,
      'added,',
      event.removed.length,
      'removed'
    );
  });

  // Listen for configuration changes
  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('intellig')) {
      // TODO: Handle configuration changes in task 1.3
      console.log('IntelliG configuration changed');
    }
  });

  // Listen for active editor changes (for blame annotations)
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      // TODO: Update blame annotations in task 27.1
    }
  });

  // Register all listeners with the extension context
  context.subscriptions.push(workspaceFoldersListener, configurationListener, activeEditorListener);
}

/**
 * Handle branch context menu actions from the webview.
 * Delegates to the appropriate GitService method based on the action.
 *
 * This replaces the old tree view context menu command registrations,
 * reusing the same logic patterns from BranchContextMenuCommands.
 *
 * Requirements: 2.7 (local branch context menu), 2.8 (remote branch context menu)
 *
 * @param gitService - The Git service to use for branch operations
 * @param event - The branch context action event from the webview
 */
async function handleBranchContextAction(
  gitService: IGitService,
  event: { branchName: string; branchType: 'local' | 'remote'; action: string }
): Promise<void> {
  const repositories = gitService.getRepositories();
  if (repositories.length === 0) {
    void vscode.window.showErrorMessage('No Git repository found');
    return;
  }
  const repo = repositories[0];

  try {
    switch (event.action) {
      // === Local branch actions (Requirement 2.7) ===
      case 'checkout':
        await handleCheckout(gitService, repo, event.branchName);
        break;

      case 'newBranch':
        await handleNewBranch(gitService, repo, event.branchName);
        break;

      case 'merge':
        await handleMerge(gitService, repo, event.branchName);
        break;

      case 'rebase':
        await handleRebase(gitService, repo, event.branchName);
        break;

      case 'compare':
        await handleCompare(gitService, repo, event.branchName);
        break;

      case 'rename':
        await handleRename(gitService, repo, event.branchName);
        break;

      case 'delete':
        await handleDelete(gitService, repo, event.branchName);
        break;

      // === Remote branch actions (Requirement 2.8) ===
      case 'checkoutAsLocal':
        await handleCheckoutAsLocal(gitService, repo, event.branchName);
        break;

      case 'pull':
        await handlePull(gitService, repo, event.branchName);
        break;

      case 'deleteRemote':
        await handleDeleteRemote(gitService, repo, event.branchName);
        break;

      default:
        console.warn(`Unknown branch context menu action: ${event.action}`);
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Branch action failed: ${errorMessage}`);
  }
}

/**
 * Handle checkout action for a local branch.
 * Requirement 2.7: Checkout option in local branch context menu.
 */
async function handleCheckout(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  try {
    await gitService.checkout(repo, branchName);
    void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (
      errorMessage.includes('would be overwritten') ||
      errorMessage.includes('Please commit your changes or stash them')
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Cannot switch to '${branchName}': local changes would be overwritten.`,
        'Stash & Switch',
        'Force Checkout',
        'Cancel'
      );
      if (choice === 'Stash & Switch') {
        await gitService.stash(repo, `Auto-stash before checkout ${branchName}`);
        await gitService.checkout(repo, branchName);
        void vscode.window.showInformationMessage(
          `Stashed changes and switched to '${branchName}'`
        );
      } else if (choice === 'Force Checkout') {
        await gitService.checkout(repo, branchName, { force: true });
        void vscode.window.showInformationMessage(`Force switched to '${branchName}'`);
      }
    } else {
      void vscode.window.showErrorMessage(`Failed to checkout branch: ${errorMessage}`);
    }
  }
}

/**
 * Handle new branch creation from a given start point.
 * Requirements: 2.7, 2.8: New Branch option in context menus.
 */
async function handleNewBranch(
  gitService: IGitService,
  repo: IRepository,
  startPoint: string
): Promise<void> {
  const branchName = await vscode.window.showInputBox({
    prompt: `Enter new branch name (from ${startPoint})`,
    placeHolder: 'feature/my-new-branch',
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return 'Branch name cannot be empty';
      }
      if (!/^[\w\-./]+$/.test(value)) {
        return 'Branch name contains invalid characters';
      }
      return undefined;
    },
  });

  if (!branchName) {
    return;
  }

  await gitService.createBranch(repo, branchName, startPoint);
  await gitService.checkout(repo, branchName);
  void vscode.window.showInformationMessage(
    `Created and switched to branch '${branchName}' from '${startPoint}'`
  );
}

/**
 * Handle merge into current branch.
 * Requirements: 2.7, 2.8: Merge into Current option in context menus.
 */
async function handleMerge(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const result = await gitService.mergeBranch(repo, branchName);

  if (result.success) {
    void vscode.window.showInformationMessage(`Merged '${branchName}' successfully`);
  } else if (result.conflicts && result.conflicts.length > 0) {
    void vscode.window.showWarningMessage(
      `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
    );
  }
}

/**
 * Handle rebase current onto the specified branch.
 * Requirement 2.7: Rebase Current onto This option in local branch context menu.
 */
async function handleRebase(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const result = await gitService.rebaseBranch(repo, branchName);

  if (result.success) {
    void vscode.window.showInformationMessage(`Rebased onto '${branchName}' successfully`);
  } else if (result.conflicts && result.conflicts.length > 0) {
    void vscode.window.showWarningMessage(
      `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
    );
  }
}

/**
 * Handle compare with current branch.
 * Requirement 2.7: Compare with Current option in local branch context menu.
 */
async function handleCompare(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const currentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';
  const comparison = await gitService.compareBranches(repo, currentBranch, branchName);

  const message =
    `Comparing ${currentBranch} with ${branchName}:\n` +
    `• ${comparison.aheadCount} commit(s) ahead\n` +
    `• ${comparison.behindCount} commit(s) behind\n` +
    `• ${comparison.changedFiles.length} file(s) changed`;

  void vscode.window.showInformationMessage(message);
}

/**
 * Handle rename of a local branch.
 * Requirement 2.7: Rename option in local branch context menu.
 */
async function handleRename(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const newName = await vscode.window.showInputBox({
    prompt: `Rename branch '${branchName}' to:`,
    value: branchName,
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return 'Branch name cannot be empty';
      }
      if (value === branchName) {
        return 'New name must be different';
      }
      if (!/^[\w\-./]+$/.test(value)) {
        return 'Branch name contains invalid characters';
      }
      return undefined;
    },
  });

  if (!newName) {
    return;
  }

  await gitService.renameBranch(repo, branchName, newName);
  void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);
}

/**
 * Handle delete of a local branch.
 * Requirement 2.7: Delete option in local branch context menu.
 */
async function handleDelete(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete the branch '${branchName}'?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  await gitService.deleteBranch(repo, branchName);
  void vscode.window.showInformationMessage(`Deleted branch '${branchName}'`);
}

/**
 * Handle checkout as local for a remote branch.
 * Requirement 2.8: Checkout as Local option in remote branch context menu.
 */
async function handleCheckoutAsLocal(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
  const parts = branchName.split('/');
  const remoteName = parts[0];
  const localBranchName = parts.slice(1).join('/');

  try {
    // Check if local branch already exists
    const branches = await gitService.getBranches(repo);
    const localExists = branches.some((b) => b.type === 'local' && b.name === localBranchName);

    if (localExists) {
      await gitService.checkout(repo, localBranchName);
    } else {
      await gitService.checkout(repo, localBranchName, {
        createBranch: true,
        track: `${remoteName}/${localBranchName}`,
      });
    }

    void vscode.window.showInformationMessage(`Switched to branch '${localBranchName}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (
      errorMessage.includes('would be overwritten') ||
      errorMessage.includes('Please commit your changes or stash them')
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Cannot switch to '${localBranchName}': local changes would be overwritten.`,
        'Stash & Switch',
        'Force Checkout',
        'Cancel'
      );
      if (choice === 'Stash & Switch') {
        await gitService.stash(repo, `Auto-stash before checkout ${localBranchName}`);
        const branches = await gitService.getBranches(repo);
        const localExists = branches.some(
          (b) => b.type === 'local' && b.name === localBranchName
        );
        if (localExists) {
          await gitService.checkout(repo, localBranchName);
        } else {
          await gitService.checkout(repo, localBranchName, {
            createBranch: true,
            track: `${remoteName}/${localBranchName}`,
          });
        }
        void vscode.window.showInformationMessage(
          `Stashed changes and switched to '${localBranchName}'`
        );
      } else if (choice === 'Force Checkout') {
        const branches = await gitService.getBranches(repo);
        const localExists = branches.some(
          (b) => b.type === 'local' && b.name === localBranchName
        );
        if (localExists) {
          await gitService.checkout(repo, localBranchName, { force: true });
        } else {
          await gitService.checkout(repo, localBranchName, {
            createBranch: true,
            force: true,
            track: `${remoteName}/${localBranchName}`,
          });
        }
        void vscode.window.showInformationMessage(
          `Force switched to '${localBranchName}'`
        );
      }
    } else {
      void vscode.window.showErrorMessage(`Failed to checkout branch: ${errorMessage}`);
    }
  }
}

/**
 * Handle pull into current branch from a remote branch.
 * Requirement 2.8: Pull into Current option in remote branch context menu.
 */
async function handlePull(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  // Parse remote name from branch name
  const parts = branchName.split('/');
  const remoteName = parts[0];
  const remoteBranchName = parts.slice(1).join('/');

  await gitService.pull(repo, {
    remote: remoteName,
    branch: remoteBranchName,
  });

  void vscode.window.showInformationMessage(`Pulled '${branchName}' into current branch`);
}

/**
 * Handle delete of a remote branch.
 * Requirement 2.8: Delete Remote option in remote branch context menu.
 */
async function handleDeleteRemote(
  gitService: IGitService,
  repo: IRepository,
  branchName: string
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete the remote branch '${branchName}'? This cannot be undone.`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  // Parse remote name from branch name
  const parts = branchName.split('/');
  const remoteName = parts[0];
  const remoteBranchName = parts.slice(1).join('/');

  await gitService.push(repo, {
    remote: remoteName,
    branch: `:${remoteBranchName}`,
  });

  void vscode.window.showInformationMessage(`Deleted remote branch '${branchName}'`);
}

/**
 * Get the extension services container.
 * This can be used by other modules to access services.
 *
 * @returns The extension services container, or undefined if not activated
 */
export function getServices(): ExtensionServices | undefined {
  return extensionServices;
}

/**
 * Get the Git Tool Window Provider.
 * This can be used by other modules to interact with the Git Tool Window.
 *
 * @returns The Git Tool Window Provider, or undefined if not activated
 */
export function getGitToolWindowProvider(): GitToolWindowProvider | undefined {
  return gitToolWindowProvider;
}
