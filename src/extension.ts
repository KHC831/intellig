import * as vscode from 'vscode';
import {
  getExtensionServices,
  resetExtensionServices,
  ExtensionServices,
  GitToolWindowProvider,
  CommitDialog,
  BranchPopup,
  MergeView,
  RebaseEditor,
  createRebaseEditor,
  RebaseDialog,
  showRebaseDialog,
  InlineBlameProvider,
  GutterBlameProvider,
  StatusBarService,
  NotificationService,
  KeymapService,
  StashView,
  ShelfView,
  BranchComparisonView,
  RebaseProgressView,
  PullDialog,
  createPullDialog,
  PushDialog,
  showPushDialog,
  MergeDialog,
  showMergeDialog,
  NewBranchDialog,
  showNewBranchDialog,
  CommitToolWindow,
} from './services';
import type { IRepository, IPushPreselect, IRebaseDialogPreselect } from './services';
import { CommitContextMenuCommands } from './commits';
import { isValidRefNameFormat } from './branches/branchNameValidator';
import { getOutputChannel, initOutputChannel } from './utils/outputChannel';
import { getLogger, initLogger } from './utils/logger';
import { runKeymapMigrationSafe } from './utils/keymapMigration';
import { safeFireAndForget } from './utils/safeFireAndForget';
import { sanitizeGitError, formatActionFailureToast } from './git-core/gitError';
import { ICommandContext } from './commands/registration/CommandContext';
import { IViewRegistrationContext } from './registration/ViewRegistrationContext';
import {
  registerViews,
  registerGitContentProvider,
  setupEventListeners,
} from './registration/registerViews';
import { GitScmProvider } from './scm/GitScmProvider';
// Re-export the relocated pure wiring functions + their structural test
// interfaces so the by-name `from '../../../extension'` import path used by
// loadAllPanelData / repoSelectionWiring / rebasePausedWarning /
// contentProvider tests keeps resolving (RULE E2).
export {
  loadAllPanelDataCore,
  wireRepositorySelection,
  resolveCommitRepoByRoot,
  resolveRepoForCommitDiff,
  resolveLogHeadAnchor,
  wireRebasePausedWarning,
  provideGitShowContent,
  type ILoadAllPanelDataProvider,
  type ILoadAllPanelDataDeps,
  type IRepoSelectionToolWindowProvider,
  type IRepoSelectionBranchTreeProvider,
  type RepositoryScopeSelection,
  type IRebaseWarningGitService,
  type IRebaseWarningToastSurface,
  type IRebaseWarningCommandRunner,
} from './registration/wiring';
import { registerChangelistCommands } from './commands/registration/changelistCommands';
import { registerExplorerCommands } from './commands/registration/explorerCommands';
import { registerRebaseConflictCommands } from './commands/registration/rebaseConflictCommands';
import { registerBlameEditorCommands } from './commands/registration/blameEditorCommands';
import { registerStashShelfCommands } from './commands/registration/stashShelfCommands';
import { registerBranchCommands } from './commands/registration/branchCommands';
import { registerCommitMenuCommands } from './commands/registration/commitMenuCommands';
import { registerCommitRepoCoreCommands } from './commands/registration/commitRepoCoreCommands';
// Re-export the relocated pull-dialog outcome handler (RULE E2 —
// branchContextMenu.fixes.test.ts imports it by name).
export { handlePullDialogOutcome } from './commands/registration/commitRepoCoreCommands';
// Re-export the relocated explorer helpers so the by-name test-seam import
// path `from '../../../extension'` is preserved (RULE E2).
export {
  resolveExplorerFileUri,
  buildIntelligGitUri,
  buildCompareWithRepoVersionLeftUri,
  buildCompareWithRepoVersionTitle,
} from './commands/registration/explorerCommands';
// Re-export the relocated local-changes helper (RULE E2).
export { resolveLocalChangesOpenFileTarget } from './commands/registration/blameEditorCommands';
// Re-export the relocated New Tag flow seams (RULE E2 — newTag.test.ts).
export {
  runNewTagFlow,
  validateTagName,
  validateCommitRef,
  type INewTagFlowDeps,
} from './commands/registration/commitHelpers';

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
 * Global reference to the Commit Tool Window.
 * Registered even when the feature flag is off so programmatic callers can
 * still obtain the instance; user-visible mounting is controlled by the
 * `when` clause on the view contribution in package.json.
 */
let commitToolWindow: CommitToolWindow | undefined;

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
 * Global reference to the Pull Dialog. Lazily constructed on first use
 * so we don't instantiate it before extension services are ready.
 */
let pullDialog: PullDialog | undefined;

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
 * Global reference to the Commit Context Menu Commands instance.
 * Used by top-level `intellig.commit.*` command handlers to delegate into
 * the existing `_handleAction` dispatcher for reuse (copyHash,
 * checkoutRevision, revert, cherryPick, createPatch).
 */
let commitContextMenuCommands: CommitContextMenuCommands | undefined;

/**
 * Global reference to the extension context. Held so non-command call paths
 * (e.g. `openPushDialog` invoked from the branch context menu) can construct
 * webviews that require `context.extensionUri` for `localResourceRoots`.
 */
let extensionContext: vscode.ExtensionContext | undefined;

/**
 * This method is called when the extension is activated.
 * The extension is activated based on the activation events defined in package.json.
 *
 * @param context - The VS Code extension context providing subscriptions,
 *                  storage paths, and other extension-specific utilities.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    // Hold a reference to the extension context for non-command call paths
    // that need it later (e.g. the Push dialog constructed from branch menu).
    extensionContext = context;

    // Initialize the shared IntelliG OutputChannel early so any init/watcher
    // rejection routed through safeFireAndForget lands somewhere the user
    // can see. Registered with context.subscriptions so it disposes on
    // deactivate alongside the rest of the extension's resources.
    initOutputChannel(context);

    // Initialize the structured Logger before service construction so
    // services calling `getLogger().child({ component: 'X' })` in their
    // constructors (via `ExtensionServices.initialize` below) emit through
    // the registered sinks rather than the no-op pre-init path.
    initLogger(context);

    getLogger().info('extension activating');

    // one-time migration from the deprecated
    // `intellig.useIntelliJKeymap` boolean to `intellig.keymapPreset`.
    // Runs before service init so KeymapService picks up the migrated
    // value on its first read. Idempotent — once the legacy boolean
    // is cleared, this is a no-op on subsequent activations.
    //
    // Migration is non-essential. KeymapService's
    // `resolveKeymap` legacy fallback covers the keymap surface
    // even if migration fails (read-only settings.json, sync
    // conflict, transient policy error). The safe wrapper
    // `runKeymapMigrationSafe` (path A) routes
    // failures to OutputChannel and returns; activation continues.
    //
    // Perf note: the seam re-acquires
    // `vscode.workspace.getConfiguration('intellig')` per inspect /
    // update call. Cheap (microseconds) and pins fresh-state
    // semantics so a re-inspect immediately after update reads the
    // post-update value.
    await runKeymapMigrationSafe(
      {
        inspect: <T>(key: string) => vscode.workspace.getConfiguration('intellig').inspect<T>(key),
        update: (key, value, target) =>
          Promise.resolve(vscode.workspace.getConfiguration('intellig').update(key, value, target)),
      },
      (message) => vscode.window.showInformationMessage(message),
      getOutputChannel(),
      sanitizeGitError
    );

    // Get or create the extension services container
    extensionServices = getExtensionServices();

    // Initialize all services
    await extensionServices.initialize(context);

    // Register commands
    registerCommands(context);

    // Shared read/WRITE bridge to the module-level singletons (RULE E1). The
    // view-registration functions reach state through this context; get/set
    // accessors forward to the module `let`s so lazy-init write-back mutates
    // the single owner `getServices()`/`deactivate()` observe.
    const viewCtx = createViewRegistrationContext(context);

    // Register views and providers
    registerViews(viewCtx);

    // Register git content provider for showing file content at specific revisions
    registerGitContentProvider(viewCtx);

    // Set up event listeners
    setupEventListeners(viewCtx);

    // Native VS Code SCM integration ("IntelliG Git") — surfaces each
    // repository's working tree as Staged Changes / Changes resource groups,
    // the analog of IntelliJ's Local Changes. Registered in subscriptions so
    // VS Code disposes its SourceControls on deactivation.
    const gitScmProvider = new GitScmProvider(extensionServices.gitService);
    context.subscriptions.push(gitScmProvider);
    safeFireAndForget(
      gitScmProvider.initialize(),
      'extension.activate: GitScmProvider initial wiring'
    );

    // Start the auto-fetch scheduler.
    // Registering in context.subscriptions lets VS Code dispose it on
    // extension deactivation, so no manual cleanup is needed.
    const autoFetchService = extensionServices.autoFetchService;
    context.subscriptions.push(autoFetchService);
    autoFetchService.start();

    getLogger().info('extension activated');
  } catch (error) {
    getLogger().error('failed to activate', error instanceof Error ? error : undefined);
    // Drop the (now disposed / half-built) singleton so a retry or a later
    // getServices() builds a fresh container instead of reusing a poisoned one.
    resetExtensionServices();
    extensionServices = undefined;
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to activate IntelliG extension', error)
    );
    throw error;
  }
}

/**
 * This method is called when the extension is deactivated.
 * Clean up any resources and dispose of services.
 */
export function deactivate(): void {
  getLogger().info('extension deactivating');

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

    // Dispose the Commit Tool Window.
    if (commitToolWindow) {
      commitToolWindow.dispose();
      commitToolWindow = undefined;
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

    // Release the Notification Service reference. It owns no
    // disposables of its own — the shared OutputChannel it consumes is
    // registered against `context.subscriptions` by
    // `initOutputChannel(context)`, so deactivation of the context
    // handles the underlying tear-down. Nulling the reference here
    // just lets a subsequent `activate` construct a fresh instance.
    if (notificationService) {
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
    extensionContext = undefined;

    getLogger().info('extension deactivated');
  } catch (error) {
    getLogger().error('error during deactivation', error instanceof Error ? error : undefined);
  }
}

/**
 * Register all extension commands.
 *
 * @param context - The VS Code extension context
 */
/**
 * Test seam: register every IntelliG command against a context without
 * running the full `activate()` sequence (which needs a live view /
 * watcher / service graph). Used by the command-handler transparency
 * behavioral harness to capture each `registerLoggedCommand` callback and
 * drive its degraded-mode guard path. NOT part of the public API; the
 * leading `__` + `ForTest` suffix marks it per the repo's TestSurface
 * convention (see docs/testing.md).
 */
export function __registerCommandsForTest(context: vscode.ExtensionContext): void {
  registerCommands(context);
}

function registerCommands(context: vscode.ExtensionContext): void {
  // Shared read/WRITE bridge to the module-level singletons (RULE E1). Command
  // handlers extracted into `commands/registration/*` reach state through this
  // context; get/set accessors forward to the module `let`s so lazy-init
  // write-back mutates the single owner `getServices()`/`deactivate()` observe.
  const ctx: ICommandContext = {
    context,
    get services() {
      return extensionServices;
    },
    get gitToolWindowProvider() {
      return gitToolWindowProvider;
    },
    get commitContextMenuCommands() {
      return commitContextMenuCommands;
    },
    get commitToolWindow() {
      return commitToolWindow;
    },
    get commitDialog() {
      return commitDialog;
    },
    set commitDialog(v) {
      commitDialog = v;
    },
    get branchPopup() {
      return branchPopup;
    },
    set branchPopup(v) {
      branchPopup = v;
    },
    get stashView() {
      return stashView;
    },
    set stashView(v) {
      stashView = v;
    },
    get shelfView() {
      return shelfView;
    },
    set shelfView(v) {
      shelfView = v;
    },
    get inlineBlameProvider() {
      return inlineBlameProvider;
    },
    set inlineBlameProvider(v) {
      inlineBlameProvider = v;
    },
    get gutterBlameProvider() {
      return gutterBlameProvider;
    },
    set gutterBlameProvider(v) {
      gutterBlameProvider = v;
    },
    get branchComparisonView() {
      return branchComparisonView;
    },
    set branchComparisonView(v) {
      branchComparisonView = v;
    },
    get mergeView() {
      return mergeView;
    },
    set mergeView(v) {
      mergeView = v;
    },
    get rebaseEditor() {
      return rebaseEditor;
    },
    set rebaseEditor(v) {
      rebaseEditor = v;
    },
    getPullDialog: () => _getPullDialog(),
    openPushDialog: (p) => _openPushDialog(p),
    openMergeDialog: (p) => _openMergeDialog(p),
    openRebaseDialog: (p) => _openRebaseDialog(p),
    openNewBranchDialog: (p) => _openNewBranchDialog(p),
  };

  // registerCommands is a thin orchestrator: it builds the shared
  // ICommandContext above, then collects each domain module's disposables and
  // does a SINGLE trailing context.subscriptions.push (RULE E4). Every handler
  // body lives in commands/registration/*; this file owns only the state the
  // handlers reach through ctx. Disposables are collected in domain-grouped
  // order (NOT the original per-const creation/registration order — e.g. the
  // core handlers were in the original second push block but list first here);
  // this is behavior-neutral — no test observes subscription order or count,
  // and VS Code's command-unregister teardown is order-independent.
  const coreDisposables = registerCommitRepoCoreCommands(ctx);
  const changelistDisposables = registerChangelistCommands(ctx);
  const branchDisposables = registerBranchCommands(ctx);
  const stashShelfDisposables = registerStashShelfCommands(ctx);
  const blameEditorDisposables = registerBlameEditorCommands(ctx);
  const rebaseConflictDisposables = registerRebaseConflictCommands(ctx);
  const explorerDisposables = registerExplorerCommands(ctx);
  const commitMenuDisposables = registerCommitMenuCommands(ctx);

  context.subscriptions.push(
    ...coreDisposables,
    ...changelistDisposables,
    ...branchDisposables,
    ...stashShelfDisposables,
    ...blameEditorDisposables,
    ...rebaseConflictDisposables,
    ...explorerDisposables,
    ...commitMenuDisposables
  );
}

/**
 * Build the shared read/WRITE bridge to the module-level singletons (RULE
 * E1), the view-registration analog of the `ICommandContext` built in
 * `registerCommands`. The relocated view-registration functions reach state
 * through this context; get/set accessors forward to the module `let`s so
 * lazy-init write-back mutates the single owner `getServices()` /
 * `getGitToolWindowProvider()` / `deactivate()` observe.
 */
function createViewRegistrationContext(context: vscode.ExtensionContext): IViewRegistrationContext {
  const ctx: IViewRegistrationContext = {
    context,
    get services() {
      return extensionServices;
    },
    get gitToolWindowProvider() {
      return gitToolWindowProvider;
    },
    set gitToolWindowProvider(v) {
      gitToolWindowProvider = v;
    },
    get commitToolWindow() {
      return commitToolWindow;
    },
    set commitToolWindow(v) {
      commitToolWindow = v;
    },
    get stashView() {
      return stashView;
    },
    set stashView(v) {
      stashView = v;
    },
    get shelfView() {
      return shelfView;
    },
    set shelfView(v) {
      shelfView = v;
    },
    get mergeView() {
      return mergeView;
    },
    set mergeView(v) {
      mergeView = v;
    },
    get statusBarService() {
      return statusBarService;
    },
    set statusBarService(v) {
      statusBarService = v;
    },
    get notificationService() {
      return notificationService;
    },
    set notificationService(v) {
      notificationService = v;
    },
    get keymapService() {
      return keymapService;
    },
    set keymapService(v) {
      keymapService = v;
    },
    get gutterBlameProvider() {
      return gutterBlameProvider;
    },
    set gutterBlameProvider(v) {
      gutterBlameProvider = v;
    },
    get branchComparisonView() {
      return branchComparisonView;
    },
    set branchComparisonView(v) {
      branchComparisonView = v;
    },
    get rebaseProgressView() {
      return rebaseProgressView;
    },
    set rebaseProgressView(v) {
      rebaseProgressView = v;
    },
    get commitContextMenuCommands() {
      return commitContextMenuCommands;
    },
    set commitContextMenuCommands(v) {
      commitContextMenuCommands = v;
    },
    getPullDialog: () => _getPullDialog(),
    openPushDialog: (p) => _openPushDialog(p),
    openMergeDialog: (p) => _openMergeDialog(p),
    openRebaseDialog: (p) => _openRebaseDialog(p),
    openNewBranchDialog: (p) => _openNewBranchDialog(p),
  };
  return ctx;
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

/**
 * Lazily instantiate the Pull Dialog, reusing the singleton after the
 * first call. Returns `undefined` when extension services are unavailable
 * (e.g. before activation has completed).
 */
function _getPullDialog(): PullDialog | undefined {
  if (pullDialog) {
    return pullDialog;
  }
  if (!extensionServices) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  pullDialog = createPullDialog(
    extensionServices.gitService,
    extensionServices.conflictResolutionService
  );
  return pullDialog;
}

/**
 * Expose the Pull Dialog for cross-module callers (e.g. branch context menu
 * entries that want to pre-fill source + preset).
 */
export function getPullDialog(): PullDialog | undefined {
  return _getPullDialog();
}

// `handlePullDialogOutcome` was relocated verbatim to
// `commands/registration/commitRepoCoreCommands.ts` (with its consuming
// `intellig.pull` handler) and is re-exported near the top of this file so
// the by-name `from '../../../extension'` import in
// `branchContextMenu.fixes.test.ts` is preserved (RULE E2).

// ─── Push dialog ─────────────────────────────────────────────────────────────

/**
 * Open a fresh Push dialog. Unlike Pull, Push is constructed per-invocation
 * because the row table is a snapshot of the current repo state (branches,
 * commits-since badges) — reusing a singleton would render stale data.
 *
 * @param preselect - Optional single-repo/branch pre-selection. When omitted,
 *   all workspace repos are shown with the active-editor repo pre-selected.
 */
export function _openPushDialog(preselect?: IPushPreselect): PushDialog | undefined {
  if (!extensionServices || !extensionContext) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  const gitService = extensionServices.gitService;
  const repos = gitService.getRepositories();
  if (repos.length === 0) {
    void vscode.window.showErrorMessage('No Git repository found in workspace');
    return undefined;
  }
  const protectedBranches = vscode.workspace
    .getConfiguration('intellig')
    .get<string[]>('protectedBranches', []);

  return showPushDialog(extensionContext, {
    repos,
    preselect,
    gitService,
    protectedBranches,
    pullDialogAccessor: _getPullDialog,
    onPushComplete: () => {
      // Reload before refresh so the panel sees
      // post-push remote-tracking refs (ahead/behind reset to 0). Push
      // can target any of `repos`; reload them all so the next refresh
      // reads fresh state regardless of which row the user actioned.
      void (async (): Promise<void> => {
        await Promise.all(repos.map((r) => gitService.reloadRepository(r)));
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      })();
    },
  });
}

/** Cross-module entry point — used by branch context menu, etc. */
export function openPushDialog(preselect?: IPushPreselect): PushDialog | undefined {
  return _openPushDialog(preselect);
}

// ─── Merge Dialog ────────────────────────────────────────────────────────────

/**
 * Open a fresh Merge Dialog for `sourceBranch` into the current branch of
 * `repo`. One dialog instance per invocation — the read-only summary
 * reflects current state at open time.
 */
export function _openMergeDialog(preselect: {
  repo: IRepository;
  sourceBranch: string;
}): MergeDialog | undefined {
  if (!extensionServices || !extensionContext) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  const gitService = extensionServices.gitService;
  return showMergeDialog(extensionContext, {
    repo: preselect.repo,
    sourceBranch: preselect.sourceBranch,
    gitService,
    conflictResolutionService: extensionServices.conflictResolutionService,
    onMergeComplete: () => {
      // Reload before refresh so the panel sees
      // fresh `repo.head.commit` after the merge advances HEAD. Mirrors
      // the IIFE pattern at `CommitContextMenuCommands.ts:1122`
      // (onResetComplete) — dialog callbacks are sync so we sequence
      // reload → refresh inside a void IIFE; watcher debounce is the
      // safety net.
      void (async (): Promise<void> => {
        await gitService.reloadRepository(preselect.repo);
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      })();
    },
  });
}

/** Cross-module entry point for callers that need the opener. */
export function openMergeDialog(preselect: {
  repo: IRepository;
  sourceBranch: string;
}): MergeDialog | undefined {
  return _openMergeDialog(preselect);
}

/**
 * Open the unified Rebase Dialog. Resolves the branch list for the Onto
 * dropdown (excluding the current branch — you cannot rebase onto HEAD) and
 * the editor factory, then constructs one dialog instance. Async because the
 * branch list is fetched at open time so the dropdown reflects current refs.
 */
export async function _openRebaseDialog(
  preselect: IRebaseDialogPreselect
): Promise<RebaseDialog | undefined> {
  if (!extensionServices || !extensionContext) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  const gitService = extensionServices.gitService;
  const rebaseService = extensionServices.rebaseService;
  const branches = await gitService.getBranches(preselect.repo);
  const branchChoices = branches.filter((b) => !b.isHead).map((b) => b.name);

  // Default onto = the explicit preselect, else the first available branch.
  const onto = preselect.onto ?? branchChoices[0];
  if (!onto) {
    void vscode.window.showErrorMessage('No other branch or ref to rebase onto.');
    return undefined;
  }

  return showRebaseDialog(extensionContext, {
    repo: preselect.repo,
    onto,
    branchChoices,
    interactiveDefault: preselect.interactiveDefault,
    gitService,
    createRebaseEditor: () => {
      // Reuse the module singleton so deactivate() disposes the same editor.
      if (!rebaseEditor) {
        // Pass a thunk for the progress view so a paused/in-progress rebase
        // reveals the live Rebase Progress panel (the panel is created during
        // activation; the thunk resolves it at paused-time, tolerating a
        // recreated panel across a deactivate/reactivate cycle).
        rebaseEditor = createRebaseEditor(
          extensionContext!.extensionUri,
          rebaseService,
          () => rebaseProgressView
        );
      }
      return rebaseEditor;
    },
    conflictResolutionService: extensionServices.conflictResolutionService,
    onComplete: () => {
      // Reload before refresh so the panel sees fresh `repo.head.commit`
      // after the rebase moves HEAD (mirrors the merge opener).
      void (async (): Promise<void> => {
        await gitService.reloadRepository(preselect.repo);
        if (gitToolWindowProvider) {
          gitToolWindowProvider.refresh();
        }
      })();
    },
  });
}

/** Cross-module entry point for callers that need the rebase opener. */
export function openRebaseDialog(
  preselect: IRebaseDialogPreselect
): Promise<RebaseDialog | undefined> {
  return _openRebaseDialog(preselect);
}

// ─── New Branch Dialog ───────────────────────────────────────────────────────

/**
 * Open a fresh New Branch Dialog. `startPoint` defaults to HEAD when
 * omitted; when present it shows in the read-only "Start point" row.
 */
export function _openNewBranchDialog(preselect: {
  repo: IRepository;
  startPoint?: string;
  defaultName?: string;
}): NewBranchDialog | undefined {
  if (!extensionServices || !extensionContext) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  return showNewBranchDialog(extensionContext, {
    repo: preselect.repo,
    gitService: extensionServices.gitService,
    startPoint: preselect.startPoint,
    defaultName: preselect.defaultName,
    onBranchCreated: () => {
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
    },
  });
}

/** Cross-module entry point for callers that need the opener. */
export function openNewBranchDialog(preselect: {
  repo: IRepository;
  startPoint?: string;
  defaultName?: string;
}): NewBranchDialog | undefined {
  return _openNewBranchDialog(preselect);
}

/**
 * Validate a branch name. Delegates to the shared `isValidRefNameFormat`
 * (same validator the New Branch dialog uses) so behaviour is consistent
 * across all "New Branch…" entry points.
 *
 * Exported so unit tests can exercise it directly.
 *
 * @param value - Candidate branch name
 * @returns An error string when invalid, or `undefined` when valid.
 */
export function validateBranchName(value: string): string | undefined {
  if (!value || !value.trim()) {
    return 'Branch name cannot be empty';
  }
  // Delegate to the single check-ref-format validator (branchNameValidator),
  // which — unlike the prior inline `[\w\-./]+` regex — also rejects `..`, `//`,
  // a trailing `/`/`.`/`.lock`, `./`/`/.`, leading `-`/`.`/`/`, `@{`, and
  // control/special chars. One source of truth across every "New Branch…" entry.
  if (!isValidRefNameFormat(value)) {
    return 'Branch name contains invalid characters';
  }
  return undefined;
}

// `resolveLocalChangesOpenFileTarget` was relocated verbatim to
// `commands/registration/blameEditorCommands.ts` (with its consuming
// `intellig.localChanges.openFile` handler) and is re-exported near the top
// of this file so the by-name `from '../../../extension'` import path used by
// `localChangesOpenFile.test.ts` is preserved (RULE E2).

// `resolveExplorerFileUri`, `buildCompareWithRepoVersionLeftUri`, and
// `buildCompareWithRepoVersionTitle` were relocated verbatim to
// `commands/registration/explorerCommands.ts` (with their consuming explorer
// handlers) and are re-exported here so the by-name `from '../../../extension'`
// import path used by `explorerEditorMenu.test.ts` is preserved (RULE E2).
