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
  InlineBlameProvider,
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
  createBranchTreeProvider,
  PullDialog,
  createPullDialog,
  showApplyPatchDialog,
  PushDialog,
  showPushDialog,
  MergeDialog,
  showMergeDialog,
  NewBranchDialog,
  showNewBranchDialog,
  CommitToolWindow,
  createCommitToolWindow,
  isCommitToolWindowEnabled,
  COMMIT_TOOL_WINDOW_VIEW_ID,
  PatchWriteFailed,
} from './services';
import type {
  IBranch,
  IGitService,
  IGitServiceCli,
  IRepository,
  ITag,
  PullDialogOutcome,
} from './services';
import { findCommitByQuery } from './git-core/gitToolWindow/jumpToHash';
import { createCommandTitleProvider } from './commits/CommandTitleProvider';
import {
  createBranchContextMenuCommands,
  createCommitContextMenuCommands,
  CommitContextMenuCommands,
} from './commits';
import type { LogContextAction } from './ui-shell/GitToolWindowProvider';
import { getOutputChannel, initOutputChannel } from './utils/outputChannel';
import { getLogger, initLogger, registerLoggedCommand } from './utils/logger';
import { runKeymapMigrationSafe } from './utils/keymapMigration';
import { resolveRepo } from './utils/resolveRepo';
import { isTabbedGitToolWindowEnabled } from './git-core/gitToolWindow/config';
import { parseRemoteUrl } from './utils/remoteUrl';
import { commitUrl } from './utils/hostingLinks';
import { sanitizeGitError, formatActionFailureToast } from './git-core/gitError';
import { ICommandContext } from './commands/registration/CommandContext';
import { registerChangelistCommands } from './commands/registration/changelistCommands';
import { registerExplorerCommands } from './commands/registration/explorerCommands';
import { registerRebaseConflictCommands } from './commands/registration/rebaseConflictCommands';
import { registerBlameEditorCommands } from './commands/registration/blameEditorCommands';
import { registerStashShelfCommands } from './commands/registration/stashShelfCommands';
// Re-export the relocated explorer helpers so the by-name test-seam import
// path `from '../../../extension'` is preserved (RULE E2).
export {
  resolveExplorerFileUri,
  buildCompareWithRepoVersionLeftUri,
  buildCompareWithRepoVersionTitle,
} from './commands/registration/explorerCommands';
// Re-export the relocated local-changes helper (RULE E2).
export { resolveLocalChangesOpenFileTarget } from './commands/registration/blameEditorCommands';

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
 * Minimal provider surface that {@link loadAllPanelDataCore} drives. Declared
 * structurally so unit tests can pass a lightweight stub that records the
 * `setHasRepository` argument without standing up a full
 * `GitToolWindowProvider`.
 */
export interface ILoadAllPanelDataProvider {
  setAvailableRepositories(repos: IRepository[]): void;
  setHasRepository(hasRepository: boolean): void;
}

/**
 * Dependencies for {@link loadAllPanelDataCore}, injected so the
 * `activate`-scoped `loadAllPanelData` closure stays a thin delegation and the
 * bounded-loading guarantee can be unit-tested at the fix's call site.
 */
export interface ILoadAllPanelDataDeps {
  discoverAllRepositories: () => Promise<IRepository[]>;
  provider: ILoadAllPanelDataProvider | undefined;
  loadLogCommits: () => Promise<void>;
}

/**
 * Core of the Git tool window's "load all panel data" flow, extracted from the
 * `activate`-scoped `loadAllPanelData` closure so the no-repository wiring is
 * directly testable.
 *
 * The load-bearing line for Requirement 3 is
 * `provider.setHasRepository(repositories.length > 0)`: repository detection has
 * completed by the time `discoverAllRepositories` resolves, so reporting the
 * outcome to the provider always resolves the transient Loading_State. When
 * repositories exist, `updateLogState` (reached via `loadLogCommits`) later
 * flips `_hasRepository=true` and renders the graph; when there are none, this
 * call is the only signal that leaves Loading and lands the view in
 * No_Repository_State, so the tool window never stays stuck on the spinner.
 *
 * @internal — exported only for
 * `src/test/unit/extension/loadAllPanelData.test.ts`. Do not call from
 * production code outside the `loadAllPanelData` closure without review.
 */
export async function loadAllPanelDataCore(deps: ILoadAllPanelDataDeps): Promise<void> {
  const repositories = await deps.discoverAllRepositories();

  // Pass all discovered repositories to the provider for the repository selector.
  if (deps.provider) {
    deps.provider.setAvailableRepositories(repositories);
    // Repository detection has now completed. Resolve the loading state with the
    // detection outcome so the tool window never stays stuck on the spinner.
    deps.provider.setHasRepository(repositories.length > 0);
  }

  await deps.loadLogCommits();
}

/**
 * Minimal surfaces of the providers that {@link wireRepositorySelection}
 * needs. Declared structurally so unit tests can pass lightweight stubs and
 * record both wiring effects (graph reload + branch tree refresh) without
 * standing up the full extension host.
 */
export interface IRepoSelectionToolWindowProvider {
  onDidSelectRepository: vscode.Event<IRepository>;
}
export interface IRepoSelectionBranchTreeProvider {
  setRepository(repo: IRepository): void;
}

/**
 * Wire the Git tool window's repository selector to BOTH downstream views:
 *   - the Log/Graph (Git) view via `loadLogCommitsForRepo`
 *   - the Branches tree view via `branchTreeProvider.setRepository`
 *
 * Extracted from the `activate`-scoped wiring so the dual-update behavior is
 * unit-testable. Without this, the dropdown could update one view while the
 * other silently desyncs — the original bug.
 *
 * Returns the disposables so the caller can register them with
 * `context.subscriptions.push(...)`.
 *
 * @internal — exported for `src/test/unit/extension/repoSelectionWiring.test.ts`.
 */
export function wireRepositorySelection(deps: {
  toolWindowProvider: IRepoSelectionToolWindowProvider;
  branchTreeProvider: IRepoSelectionBranchTreeProvider;
  loadLogCommitsForRepo: (repo: IRepository) => Promise<void>;
}): vscode.Disposable[] {
  const graphListener = deps.toolWindowProvider.onDidSelectRepository(async (repo) => {
    await deps.loadLogCommitsForRepo(repo);
  });
  const branchTreeListener = deps.toolWindowProvider.onDidSelectRepository((repo) => {
    deps.branchTreeProvider.setRepository(repo);
  });
  return [graphListener, branchTreeListener];
}

/**
 * Minimal git-service surface that {@link wireRebasePausedWarning} consumes.
 * Declared structurally so unit tests can pass a lightweight stub without
 * standing up the full `GitService`. Only the two members the wiring
 * actually touches are listed.
 */
export interface IRebaseWarningGitService {
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;
}

/**
 * Toast surface the rebase-paused warning routes through. Split out from
 * `vscode.window` so the unit test can capture invocations without
 * monkey-patching the real namespace.
 */
export interface IRebaseWarningToastSurface {
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

/**
 * Command-execution surface for the warning's actionable items. Same
 * dependency-injection rationale as {@link IRebaseWarningToastSurface}.
 */
export interface IRebaseWarningCommandRunner {
  executeCommand(command: string): Thenable<unknown>;
}

/**
 * Surface a warning toast when ANY open repository has
 * `inProgress.kind === 'rebasing'`, gated on a per-repo warned-set so the
 * same paused rebase isn't re-announced on every `onDidChangeRepository`
 * event.
 *
 * The warning offers three actionable buttons that map to the registered
 * `intellig.rebase.continue` / `intellig.rebase.abort` / `intellig.rebase.skip`
 * commands. Without this surface, a user who reloaded VS Code mid-rebase (or
 * inherited a paused rebase from a CLI session) had to know to re-trigger
 * "Rebase Current onto This" from the BRANCHES menu before any UI signal
 * appeared. See `KNOWN-ISSUES.md` "Rebase recovery" entry for the original
 * deferral rationale.
 *
 * Returns disposables so the caller can register them with
 * `context.subscriptions.push(...)`. The helper itself manages the
 * warned-set; callers don't need to clean it up.
 *
 * @internal — exported for
 *   `src/test/unit/extension/rebasePausedWarning.test.ts`.
 */
export function wireRebasePausedWarning(deps: {
  gitService: IRebaseWarningGitService;
  window: IRebaseWarningToastSurface;
  commands: IRebaseWarningCommandRunner;
}): vscode.Disposable[] {
  const warned = new Set<string>();

  const fireForRepo = async (repo: IRepository): Promise<void> => {
    const rootPath = repo.rootUri.fsPath;
    const inProgressKind = repo.inProgress?.kind;

    // Reset the warned-set entry whenever the rebase clears so a future
    // rebase will re-warn. The clear can happen after the user runs
    // continue/abort/skip, or when an external tool ends the rebase.
    if (inProgressKind !== 'rebasing') {
      warned.delete(rootPath);
      return;
    }

    if (warned.has(rootPath)) {
      return;
    }
    warned.add(rootPath);

    const choice = await deps.window.showWarningMessage(
      `A rebase is paused in '${rootPath.split('/').pop() ?? rootPath}'. ` +
        `Resolve any conflicts and continue, or abort to restore the pre-rebase state.`,
      'Continue',
      'Abort',
      'Skip Commit'
    );
    if (choice === 'Continue') {
      await deps.commands.executeCommand('intellig.rebase.continue');
    } else if (choice === 'Abort') {
      await deps.commands.executeCommand('intellig.rebase.abort');
    } else if (choice === 'Skip Commit') {
      await deps.commands.executeCommand('intellig.rebase.skip');
    }
    // Other choices (Esc / dismissed): leave the warned-set entry in
    // place. The user explicitly dismissed; don't re-warn until the
    // rebase state changes.
  };

  // Initial scan: any repo already in `rebasing` state at activation
  // gets a warning. Fire-and-forget so activation isn't blocked by a
  // slow toast pipeline.
  for (const repo of deps.gitService.getRepositories()) {
    void fireForRepo(repo);
  }

  // Per-repo listener: re-evaluates the warned-set whenever a repo's
  // state transitions in or out of `rebasing`.
  const changeListener = deps.gitService.onDidChangeRepository((repo) => {
    void fireForRepo(repo);
  });

  return [changeListener];
}

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

    // Register views and providers
    registerViews(context);

    // Register git content provider for showing file content at specific revisions
    registerGitContentProvider(context);

    // Set up event listeners
    setupEventListeners(context);

    // Start the auto-fetch scheduler.
    // Registering in context.subscriptions lets VS Code dispose it on
    // extension deactivation, so no manual cleanup is needed.
    const autoFetchService = extensionServices.autoFetchService;
    context.subscriptions.push(autoFetchService);
    autoFetchService.start();

    getLogger().info('extension activated');
  } catch (error) {
    getLogger().error('failed to activate', error instanceof Error ? error : undefined);
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
    openNewBranchDialog: (p) => _openNewBranchDialog(p),
  };

  // Open Git Tool Window command
  const openGitToolWindowCommand = registerLoggedCommand('intellig.openGitToolWindow', () => {
    // Focus the Git Tool Window view
    void vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
  });

  // Commit command
  const commitCommand = registerLoggedCommand('intellig.commit', async () => {
    // Get the Git service and find a repository
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // When the Commit Tool Window flag is on, reveal the view instead of
    // opening the modal CommitDialog.
    if (isCommitToolWindowEnabled() && commitToolWindow) {
      await commitToolWindow.show();
      return;
    }

    const gitService = extensionServices.gitService;

    // Multi-root repo targeting. Prefer the active editor's repo, fall
    // back to QuickPick in multi-root workspaces.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Commit — Choose Repository',
      pickerPlaceholder: 'Select a repository to commit to',
      silent: true,
    });

    if (!repo) {
      // Last-ditch: try to discover a repo from the first workspace folder so
      // invocations in a brand-new workspace (no repos cached yet) still work.
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        repo = await gitService.getRepository(workspaceFolders[0].uri);
      }
      if (!repo) {
        void vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
      }
    }

    // Show commit dialog
    if (!commitDialog) {
      commitDialog = new CommitDialog(context.extensionUri, gitService, context.workspaceState);
    }
    await commitDialog.show(repo);
  });

  // Focus the Commit tool window (Alt+0).
  const showCommitToolWindowCommand = registerLoggedCommand(
    'intellig.showCommitToolWindow',
    async () => {
      if (commitToolWindow) {
        await commitToolWindow.show();
      } else {
        await vscode.commands.executeCommand(`${COMMIT_TOOL_WINDOW_VIEW_ID}.focus`);
      }
    }
  );

  // Changelist commands. These back the context menu in the Commit tool
  // window's Local Changes tab. Extracted to
  // `commands/registration/changelistCommands.ts`; handler bodies are
  // verbatim with the `extensionServices`→`ctx.services` /
  // `commitToolWindow`→`ctx.commitToolWindow` swaps.
  const changelistDisposables = registerChangelistCommands(ctx);

  context.subscriptions.push(showCommitToolWindowCommand, ...changelistDisposables);

  // Push command — Push dialog (webview table w/ per-row targets,
  // force-with-lease default, protected-branch guard, multi-repo submit).
  const pushCommand = registerLoggedCommand('intellig.push', () => {
    _openPushDialog();
  });

  // Push All Tags — a standalone palette command that runs
  // `git push --tags` on the active repo. Lives alongside the main Push
  // dialog (which also surfaces the tag push radio) so IntelliJ users get
  // a one-click entry point.
  const pushAllTagsCommand = registerLoggedCommand('intellig.pushAllTags', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = extensionServices.gitService;
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Push All Tags — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }
    // Pick the default remote to display in the toast. `getRemotes()` is
    // async; fall back to `'origin'` if the user's config doesn't list
    // any remote (edge case — the push will still fail informatively).
    let remoteName = 'origin';
    try {
      const remotes = await gitService.getRemotes(repo);
      if (remotes.length > 0) {
        remoteName = remotes[0].name;
      }
    } catch {
      // Non-fatal — the push below surfaces the real error.
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing all tags to ${remoteName}…`,
          cancellable: false,
        },
        () => gitService.push(repo, { tags: true })
      );
      void vscode.window.showInformationMessage(`Pushed all tags to ${remoteName}`);
      // Push --tags updated remote tracking refs
      // for tags; reload + refresh so the panel reflects fresh tag-on-
      // remote state. This site previously had neither call.
      await gitService.reloadRepository(repo);
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push tags: ${sanitizeGitError(message)}`);
    }
  });

  // Pull command — Pull dialog (2-step QuickPick: source then flags). Branch
  // on the dialog's outcome. The dialog handles its own pulled/conflict/error
  // toasts internally (see `runPullDialog`); we only add a debug log on
  // cancellation so a dismissed dialog is observable in the IntelliG
  // OutputChannel (no toast — cancel is a normal user action).
  const pullCommand = registerLoggedCommand('intellig.pull', async () => {
    const dialog = _getPullDialog();
    if (!dialog) {
      return;
    }
    const outcome = await dialog.show();
    handlePullDialogOutcome(outcome);
  });

  // Fetch command. Fetches all remotes for the selected repository,
  // with a QuickPick when there are multiple repositories in the workspace.
  const fetchCommand = registerLoggedCommand('intellig.fetch', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;

    // Unified multi-root resolver; preferActive lets the resolver seed
    // from the file the user is currently editing.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Fetch — Choose Repository',
      pickerPlaceholder: 'Select a repository to fetch',
    });
    if (!repo) {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Fetching from all remotes…',
          cancellable: false,
        },
        () => gitService.fetch(repo, { all: true, prune: true })
      );

      // Reset auto-fetch backoff so the next scheduled tick isn't right on top
      // of this manual one.
      if (extensionServices.hasService('autoFetchService')) {
        extensionServices.autoFetchService.resetBackoff();
      }

      // follow-up: fetch advances remote-tracking refs so the
      // ahead/behind counts on the branch tree go stale until the watcher's
      // 250ms debounce. Reload-then-refresh closes the visible window the
      // same way the other mutation sites do.
      await gitService.reloadRepository(repo);
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }

      const remoteCount = repo.remotes.length || 1;
      const refCount = result.updatedRefs.length;
      const message =
        refCount > 0
          ? `Fetched ${remoteCount} remote(s); ${refCount} ref(s) updated`
          : `Fetched ${remoteCount} remote(s); already up to date`;
      void vscode.window.showInformationMessage(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Fetch failed: ${sanitizeGitError(msg)}`);
    }
  });

  // Branch popup command
  const branchPopupCommand = registerLoggedCommand('intellig.showBranchPopup', async () => {
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

    // Seed the popup with the repo the user is most likely targeting.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Branches — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }
    await branchPopup.show(repo);
  });

  // Stash + shelf commands. Extracted to
  // `commands/registration/stashShelfCommands.ts`; handler bodies verbatim
  // with ctx token swaps (extensionServices->ctx.services, stashView/shelfView
  // read+write via ctx). The module-private _pickStashForAction +
  // _getShelfContext helpers moved with their handlers.
  const stashShelfDisposables = registerStashShelfCommands(ctx);

  // Blame (inline + gutter) + editor-context-menu commands +
  // intellig.localChanges.openFile. Extracted to
  // `commands/registration/blameEditorCommands.ts`; handler bodies verbatim
  // with ctx token swaps (extensionServices->ctx.services, inlineBlameProvider
  // /gutterBlameProvider read+write via ctx). The pure helper
  // resolveLocalChangesOpenFileTarget moved with the module and is re-exported
  // from extension.ts below (RULE E2).
  const blameEditorDisposables = registerBlameEditorCommands(ctx);

  // Compare with branch command
  const compareWithBranchCommand = registerLoggedCommand('intellig.compareWithBranch', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Create branch comparison view if not exists and show it
    if (!branchComparisonView) {
      branchComparisonView = createBranchComparisonView(gitService);
    }
    await branchComparisonView.show(repo);
  });

  // Compare with remote command
  const compareWithRemoteCommand = registerLoggedCommand('intellig.compareWithRemote', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Create branch comparison view if not exists and compare with remote
    if (!branchComparisonView) {
      branchComparisonView = createBranchComparisonView(gitService);
    }
    await branchComparisonView.compareWithRemote(repo);
  });

  // Refresh command - refreshes all Git views
  const refreshCommand = registerLoggedCommand('intellig.refresh', () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Refresh the Git Tool Window
    if (gitToolWindowProvider) {
      // In the 2-panel layout, always refresh all panels
      gitToolWindowProvider.refresh();
    }

    void vscode.window.showInformationMessage('Git views refreshed');
  });

  // Focus a specific tab in the Git tool window. Declared in package.json;
  // bound here so the StatusBarService incoming badge (and future callers)
  // can jump straight to a tab.
  const focusTabCommand = registerLoggedCommand(
    'intellig.toolWindow.focusTab',
    async (tab: string) => {
      if (!gitToolWindowProvider) {
        // Provider not yet ready — fall back to opening the tool window so
        // the user still gets a reasonable response.
        await vscode.commands.executeCommand('intellig.openGitToolWindow');
        return;
      }
      const validTabs = ['log', 'console', 'incoming', 'updateInfo', 'history'] as const;
      type TabId = (typeof validTabs)[number];
      if (!validTabs.includes(tab as TabId)) {
        return;
      }
      await gitToolWindowProvider.focusTab(tab as TabId);
    }
  );

  // Jump to a commit hash / branch / tag within the currently-loaded
  // log. Accepts user input via an InputBox, resolves via `findCommitByQuery`
  // (pure helper, operates only on already-loaded commits per spec), then
  // delegates to `GitToolWindowProvider.scrollToCommit` which posts the
  // webview message + re-renders with the scroll target.
  const jumpToHashCommand = registerLoggedCommand('intellig.toolWindow.jumpToHash', async () => {
    if (!extensionServices || !gitToolWindowProvider) {
      void vscode.window.showErrorMessage('Git tool window not ready');
      return;
    }

    const query = await vscode.window.showInputBox({
      title: 'Jump to Commit',
      prompt: 'Enter a commit SHA, branch name, or tag name',
      placeHolder: 'e.g., abc1234 or main or v1.0.0',
    });
    if (!query) {
      return;
    }

    const state = gitToolWindowProvider.getExtendedLogState();
    const loadedCommits = state.commitNodes.map((n) => n.commit);

    // Branches and tags for name-based matching. We fall back to empty
    // arrays on error so the command degrades to pure SHA matching rather
    // than failing outright.
    const gitService = extensionServices.gitService;
    // prefer the tool-window's selected repo when set, otherwise
    // fall back to the active-editor's repo in multi-root workspaces.
    const repo =
      gitToolWindowProvider.getSelectedRepository() ??
      (await resolveRepo(gitService, { preferActive: true, silent: true }));
    let branches: IBranch[] = [];
    let tags: ITag[] = [];
    if (repo) {
      try {
        branches = await gitService.getBranches(repo);
      } catch {
        /* ignore — fall through to SHA-only matching */
      }
      try {
        tags = await gitService.getTags(repo);
      } catch {
        /* ignore */
      }
    }

    const match = findCommitByQuery(query, loadedCommits, branches, tags);
    if (!match) {
      // sanitize-exempt: user-input: query.trim() is the user-typed search string echoed back, not git stderr
      void vscode.window.showWarningMessage(`No commit found matching '${query.trim()}'`);
      return;
    }

    await vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
    const scrolled = gitToolWindowProvider.scrollToCommit(match);
    if (!scrolled) {
      // Shouldn't happen given findCommitByQuery matched against the same
      // loaded set, but surface a warning just in case (e.g. state drifted
      // between the two calls).
      void vscode.window.showWarningMessage(
        `Commit ${match.substring(0, 7)} is not currently loaded in the graph`
      );
    }
  });

  // Stage selected files command
  const stageSelectedCommand = registerLoggedCommand('intellig.stageSelected', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    // prefer the active-editor's repo (that's the file being
    // staged) in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

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
          formatActionFailureToast('Failed to stage file', error)
        );
      }
    } else {
      void vscode.window.showInformationMessage('No file selected to stage');
    }
  });

  // Unstage selected files command
  const unstageSelectedCommand = registerLoggedCommand('intellig.unstageSelected', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;
    // prefer the active-editor's repo (that's the file being
    // unstaged) in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

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
          formatActionFailureToast('Failed to unstage file', error)
        );
      }
    } else {
      void vscode.window.showInformationMessage('No file selected to unstage');
    }
  });

  // Merge editor, conflict resolution, and rebase recovery commands.
  // Extracted to `commands/registration/rebaseConflictCommands.ts`; handler
  // bodies are verbatim with the ctx token swaps (extensionServices->
  // ctx.services, mergeView->ctx.mergeView [read+write], rebaseEditor->
  // ctx.rebaseEditor [read+write], gitToolWindowProvider->ctx.gitToolWindowProvider,
  // context.extensionUri->ctx.context.extensionUri).
  const rebaseConflictDisposables = registerRebaseConflictCommands(ctx);

  // NOTE: `intellig.toolWindow.jumpToHash` is the real implementation (see
  // `jumpToHashCommand` above). A duplicate stub registration previously
  // lived here and crashed activation (VS Code throws on duplicate
  // registerCommand). The duplicate has since been removed.

  // Apply Patch… — opens the ApplyPatchDialog for the active repo. When
  // invoked with a URI (e.g. from an explorer context menu on a .patch
  // file), pre-seeds the dialog with that path.
  const applyPatchCommand = registerLoggedCommand(
    'intellig.patch.apply',
    async (initialUri?: vscode.Uri) => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = extensionServices.gitService;
      // Resolve with active-editor preference.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
        pickerTitle: 'Apply Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      showApplyPatchDialog(context, {
        repo,
        patchService: extensionServices.patchService,
        conflictResolutionService: extensionServices.conflictResolutionService,
        initialPatchPath: initialUri?.fsPath,
      });
    }
  );

  // Create Patch from Local Changes… — prompts for target (file /
  // clipboard) and writes the current diff.
  const createPatchFromLocalCommand = registerLoggedCommand(
    'intellig.patch.createFromLocal',
    async () => {
      if (!extensionServices) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = extensionServices.gitService;
      // Resolve with active-editor preference.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
        pickerTitle: 'Create Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }

      const target = await vscode.window.showQuickPick(
        [
          { label: '$(file) Save to file…', id: 'file' as const },
          { label: '$(clippy) Copy to clipboard', id: 'clipboard' as const },
        ],
        { placeHolder: 'Where should the patch be written?' }
      );
      if (!target) {
        return;
      }

      try {
        if (target.id === 'clipboard') {
          const patch = await extensionServices.patchService.createPatchFromLocalChanges(repo, {
            toClipboard: true,
          });
          if (!patch || patch.trim().length === 0) {
            void vscode.window.showInformationMessage('No local changes to diff.');
            return;
          }
          void vscode.window.showInformationMessage('Patch copied to clipboard.');
          return;
        }

        const defaultUri = vscode.Uri.joinPath(repo.rootUri, 'changes.patch');
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
          saveLabel: 'Save Patch',
        });
        if (!uri) {
          return;
        }
        const patch = await extensionServices.patchService.createPatchFromLocalChanges(repo, {
          outputPath: uri.fsPath,
        });
        if (!patch || patch.trim().length === 0) {
          void vscode.window.showInformationMessage('No local changes to diff.');
          return;
        }
        void vscode.window.showInformationMessage(`Patch created: ${uri.fsPath}`);
      } catch (error) {
        // PatchWriteFailed means the service has already surfaced a
        // sanitised toast — we must not re-toast or the user sees two
        // error banners for one failure.
        if (error instanceof PatchWriteFailed) {
          return;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to create patch: ${sanitizeGitError(errMsg)}`);
      }
    }
  );

  // Show History command (command palette / keybinding)
  const showHistoryCommand = registerLoggedCommand('intellig.showHistory', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;

    // Resolve via the active editor's file path when available so multi-root
    // invocations don't silently pick the wrong repo.
    const activeEditor = vscode.window.activeTextEditor;
    const hintRepoPath =
      activeEditor && activeEditor.document.uri.scheme === 'file'
        ? activeEditor.document.uri.fsPath
        : undefined;
    const repo = await resolveRepo(gitService, {
      hintRepoPath,
      preferActive: true,
      pickerTitle: 'Show History — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }

    const filePath = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri)
      : undefined;

    // When the tabbed Git tool window is enabled and we have a file path,
    // route to the embedded History tab instead of the legacy QuickPick.
    // Repo-level history (filePath === undefined) still uses the QuickPick
    // because the tab only supports per-file scope.
    if (filePath && isTabbedGitToolWindowEnabled() && gitToolWindowProvider) {
      await vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
      await gitToolWindowProvider.loadFileHistory(filePath);
      return;
    }

    try {
      const history = filePath
        ? await gitService.getFileHistory(repo, filePath)
        : await gitService.getLog(repo, { maxCount: 50 });

      if (history.length === 0) {
        void vscode.window.showInformationMessage(
          filePath ? `No history found for ${filePath}` : 'No commit history found'
        );
        return;
      }

      const items = history.map((commit) => ({
        label: commit.shortHash,
        description: commit.message.substring(0, 60),
        detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
        commit,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: filePath ? `History for ${filePath}` : 'Repository History',
        title: 'Show History',
      });

      if (selected) {
        // sanitize-exempt: non-error-data: selected.commit.message is the user-authored commit subject from `git log`, not git stderr; cannot embed credentials git emits in error paths
        void vscode.window.showInformationMessage(
          `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to get history', error));
    }
  });

  // Revert File command (command palette / keybinding)
  const revertFileCommand = registerLoggedCommand('intellig.revertFile', async () => {
    if (!extensionServices) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = extensionServices.gitService;

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      void vscode.window.showErrorMessage('No file selected to revert');
      return;
    }

    // The revert must land in the repo that owns the active file.
    const hintRepoPath =
      activeEditor.document.uri.scheme === 'file' ? activeEditor.document.uri.fsPath : undefined;
    const repo = await resolveRepo(gitService, {
      hintRepoPath,
      pickerTitle: 'Revert File — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }

    const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);

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
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to revert file', error));
    }
  });

  // File Explorer Context Menu Commands. Extracted to
  // `commands/registration/explorerCommands.ts`; handler bodies are verbatim
  // with the `extensionServices`->`ctx.services` /
  // `gitToolWindowProvider`->`ctx.gitToolWindowProvider` swaps. The pure
  // helpers resolveExplorerFileUri / buildCompareWithRepoVersion* moved with
  // the module and are re-exported from extension.ts below (RULE E2).
  const explorerDisposables = registerExplorerCommands(ctx);

  // New Tag — command-palette entry, defaults to HEAD.
  const newTagCommand = registerLoggedCommand('intellig.tag.new', async () => {
    await _runNewTagFlow(undefined);
  });

  // New Tag — invoked from the log commit context menu with a commit arg.
  const commitNewTagCommand = registerLoggedCommand(
    'intellig.commit.newTag',
    async (commitArg?: unknown) => {
      const ref = _extractCommitHash(commitArg);
      await _runNewTagFlow(ref);
    }
  );

  // ─── Log commit right-click menu parity ─────────────────────────────────
  //
  // These commands provide the palette- and menu-level surface for the
  // log-commit context menu. Where an existing handler lives in
  // `CommitContextMenuCommands._handleAction`, we delegate; otherwise
  // we implement a thin flow directly below.

  // Delegate to an existing CommitContextMenuCommands action.
  async function _delegateLogAction(action: LogContextAction, commitArg: unknown): Promise<void> {
    const hash = _extractCommitHash(commitArg);
    if (!hash) {
      void vscode.window.showErrorMessage(
        'No commit selected for this action. Right-click a commit in the log to use it.'
      );
      return;
    }
    if (!commitContextMenuCommands) {
      void vscode.window.showErrorMessage('Commit context menu handlers are not available yet.');
      return;
    }
    await commitContextMenuCommands._handleAction(action, [hash]);
  }

  const commitCopyHashCommand = registerLoggedCommand(
    'intellig.commit.copyHash',
    (commitArg?: unknown) => _delegateLogAction('copyHash', commitArg)
  );

  const commitCheckoutRevisionCommand = registerLoggedCommand(
    'intellig.commit.checkoutRevision',
    (commitArg?: unknown) => _delegateLogAction('checkoutRevision', commitArg)
  );

  const commitRevertCommand = registerLoggedCommand(
    'intellig.commit.revert',
    (commitArg?: unknown) => _delegateLogAction('revert', commitArg)
  );

  const commitCherryPickCommand = registerLoggedCommand(
    'intellig.commit.cherryPick',
    (commitArg?: unknown) => _delegateLogAction('cherryPick', commitArg)
  );

  const commitCreatePatchCommand = registerLoggedCommand(
    'intellig.commit.createPatch',
    (commitArg?: unknown) => _delegateLogAction('createPatch', commitArg)
  );

  const commitResetToHereCommand = registerLoggedCommand(
    'intellig.commit.resetToHere',
    (commitArg?: unknown) => _delegateLogAction('resetToHere', commitArg)
  );

  // Drop Selected Changes — rewrites the HEAD commit to remove user-selected
  // files. Refuses on pushed or non-HEAD commits. Single destructive-op
  // confirm modal. Invoked via the palette or the log-commit context menu
  // entry declared in package.json.
  const commitDropSelectedChangesCommand = registerLoggedCommand(
    'intellig.commit.dropSelectedChanges',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage(
          'No commit selected. Right-click a commit in the log to use Drop Selected Changes.'
        );
        return;
      }
      if (!commitContextMenuCommands) {
        void vscode.window.showErrorMessage('Commit context menu handlers are not available yet.');
        return;
      }
      await commitContextMenuCommands.dropSelectedChangesFromCommit(hash);
    }
  );

  // ─── New-from-commit commands ───────────────────────────────────────────

  // New Branch from this commit.
  // Route through the New Branch Dialog webview so the user gets the
  // tracking / overwrite / checkout fields rather than a bare input box.
  const commitNewBranchCommand = registerLoggedCommand(
    'intellig.commit.newBranch',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      const repo = await _pickRepositoryForCommit();
      if (!repo || !extensionServices) {
        return;
      }
      _openNewBranchDialog({ repo, startPoint: hash });
    }
  );

  // Show diff of this commit vs its first parent.
  const commitShowDiffCommand = registerLoggedCommand(
    'intellig.commit.showDiff',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      const repo = await _pickRepositoryForCommit();
      if (!hash || !repo || !extensionServices) {
        if (!hash) {
          void vscode.window.showErrorMessage('No commit selected.');
        }
        return;
      }
      try {
        const gitService = extensionServices.gitService;
        const commit = await gitService.getCommit(repo, hash);
        const parent = commit.parents.length > 0 ? commit.parents[0] : `${hash}~1`;
        await _openCommitFileDiff(repo, hash, parent, gitService);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to show diff: ${sanitizeGitError(msg)}`);
      }
    }
  );

  // Compare this commit with HEAD (whole-commit diff).
  const commitCompareWithHeadCommand = registerLoggedCommand(
    'intellig.commit.compareWithHead',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      const repo = await _pickRepositoryForCommit();
      if (!hash || !repo || !extensionServices) {
        if (!hash) {
          void vscode.window.showErrorMessage('No commit selected.');
        }
        return;
      }
      await _openRefPairDiffPicker(repo, hash, 'HEAD', extensionServices.gitService);
    }
  );

  // Compare this commit with a user-chosen ref (branch/tag/recent commit).
  const commitCompareWithCommand = registerLoggedCommand(
    'intellig.commit.compareWith',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      const repo = await _pickRepositoryForCommit();
      if (!hash || !repo || !extensionServices) {
        if (!hash) {
          void vscode.window.showErrorMessage('No commit selected.');
        }
        return;
      }
      const gitService = extensionServices.gitService;
      const target = await _pickRefForComparison(repo, gitService);
      if (!target) {
        return;
      }
      await _openRefPairDiffPicker(repo, hash, target, gitService);
    }
  );

  // Show a file from this commit in a read-only editor.
  const commitShowFileInRevisionCommand = registerLoggedCommand(
    'intellig.commit.showFileInRevision',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      const repo = await _pickRepositoryForCommit();
      if (!hash || !repo || !extensionServices) {
        if (!hash) {
          void vscode.window.showErrorMessage('No commit selected.');
        }
        return;
      }
      try {
        const gitService = extensionServices.gitService;
        const diffs = await gitService.getCommitDiff(repo, hash);
        if (diffs.length === 0) {
          void vscode.window.showInformationMessage('No files changed in this commit.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          diffs.map((d) => ({ label: d.path, description: d.status })),
          {
            title: `Files in ${hash.substring(0, 8)}`,
            placeHolder: 'Select a file to open at this revision',
          }
        );
        if (!picked) {
          return;
        }
        const uri = vscode.Uri.parse(`intellig-git:${picked.label}?${encodeURIComponent(hash)}`);
        await vscode.commands.executeCommand('vscode.open', uri);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to open file at revision: ${sanitizeGitError(msg)}`
        );
      }
    }
  );

  // File history starting at this commit — delegates to `intellig.showHistory`
  // with the commit hash as the starting ref arg.
  const commitFileHistoryFromHereCommand = registerLoggedCommand(
    'intellig.commit.fileHistoryFromHere',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      await vscode.commands.executeCommand(
        'intellig.showHistory',
        hash ? { startRef: hash } : undefined
      );
    }
  );

  // Interactively rebase starting at this commit — delegates to the existing
  // interactive-rebase command, pre-selecting the commit as the onto target.
  const rebaseInteractiveFromHereCommand = registerLoggedCommand(
    'intellig.rebase.interactiveFromHere',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      await vscode.commands.executeCommand(
        'intellig.rebase.interactive',
        hash ? { onto: hash } : undefined
      );
    }
  );

  // Open this commit on the configured hosting provider (GitHub / GitLab /
  // Bitbucket, auto-detected from the repo's origin remote URL).
  const commitOpenOnHostCommand = registerLoggedCommand(
    'intellig.commit.openOnHost',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage(
          'No commit selected. Right-click a commit in the log first.'
        );
        return;
      }
      await _openCommitOnHost(hash);
    }
  );

  // ─── Cherry-Pick variants ──────────────────────────────────────────────

  // Cherry-Pick Without Commit: applies the commit to the index + worktree
  // with `--no-commit` so the user can inspect / amend before committing.
  const commitCherryPickWithoutCommitCommand = registerLoggedCommand(
    'intellig.commit.cherryPickWithoutCommit',
    async (commitArg?: unknown) => {
      await _runCherryPickVariant(commitArg, { noCommit: true });
    }
  );

  // Apply Selected Changes…: QuickPick commit's files, apply only the
  // selected subset to the index + worktree (cherry-pick-n + revert of
  // non-selected files). Unicode ellipsis on the palette label because
  // the dialog prompts.
  const commitApplySelectedChangesCommand = registerLoggedCommand(
    'intellig.commit.applySelectedChanges',
    async (commitArg?: unknown) => {
      const hash = _extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await _pickRepositoryForCommit();
      if (!repo || !extensionServices) {
        return;
      }
      const gitService = extensionServices.gitService;
      const files = await _pickCommitFiles(gitService, repo, hash, 'Apply Selected Changes');
      if (!files || files.length === 0) {
        return;
      }
      await _runCherryPickVariant(commitArg, { noCommit: true, files });
    }
  );

  // Apply Files to Branch…: QuickPick commit's files, QuickPick a target
  // branch, stash if dirty, switch, cherry-pick-n with file subset onto the
  // target branch, then switch back. User can then commit on the target
  // branch or discard via reset.
  const commitApplyFilesToBranchCommand = registerLoggedCommand(
    'intellig.commit.applyFilesToBranch',
    async (commitArg?: unknown) => {
      await _runApplyFilesToBranchFlow(commitArg);
    }
  );

  // Register all commands with the extension context
  context.subscriptions.push(
    openGitToolWindowCommand,
    commitCommand,
    pushCommand,
    pushAllTagsCommand,
    pullCommand,
    fetchCommand,
    newTagCommand,
    commitNewTagCommand,
    branchPopupCommand,
    // Stash + shelf commands
    ...stashShelfDisposables,
    // Blame (inline/gutter) + editor context menu + localChanges.openFile
    ...blameEditorDisposables,
    compareWithBranchCommand,
    compareWithRemoteCommand,
    refreshCommand,
    focusTabCommand,
    jumpToHashCommand,
    stageSelectedCommand,
    unstageSelectedCommand,
    // Merge editor / conflict resolution / rebase recovery commands
    ...rebaseConflictDisposables,
    applyPatchCommand,
    createPatchFromLocalCommand,
    showHistoryCommand,
    revertFileCommand,
    // File Explorer Context Menu Commands (+ explorer/editor menu parity)
    ...explorerDisposables,
    // Log commit menu parity
    commitCopyHashCommand,
    commitCheckoutRevisionCommand,
    commitRevertCommand,
    commitCherryPickCommand,
    commitCherryPickWithoutCommitCommand,
    commitApplySelectedChangesCommand,
    commitApplyFilesToBranchCommand,
    commitCreatePatchCommand,
    commitResetToHereCommand,
    commitNewBranchCommand,
    commitShowDiffCommand,
    commitCompareWithHeadCommand,
    commitCompareWithCommand,
    commitShowFileInRevisionCommand,
    commitFileHistoryFromHereCommand,
    rebaseInteractiveFromHereCommand,
    commitOpenOnHostCommand,
    // Selective revert + drop
    commitDropSelectedChangesCommand
  );
}

/**
 * Register views and view providers.
 *
 * @param context - The VS Code extension context
 */
function registerViews(context: vscode.ExtensionContext): void {
  // Hoisted so the second `if (extensionServices)` block — which creates
  // the BranchTreeProvider — can pass this helper into
  // `wireRepositorySelection(...)` and refresh both the Log/Graph view and
  // the Branches tree view from a single `onDidSelectRepository` event.
  // Bound to the block-local `loadLogCommitsForRepo` inside the first
  // `if (extensionServices)` block where its closure dependencies
  // (gitService, gitToolWindowProvider) are in scope.
  let hoistedLoadLogCommitsForRepo: ((repo: IRepository) => Promise<void>) | undefined;

  // Create and register the Git Tool Window Provider (single webview, 2-panel layout)
  gitToolWindowProvider = new GitToolWindowProvider(context.extensionUri, context.workspaceState);

  // Connect the Console Service to the Git Tool Window Provider
  // This enables real-time Git command output display
  if (extensionServices) {
    const consoleService = extensionServices.consoleService;
    if (consoleService instanceof ConsoleService) {
      consoleService.connectToToolWindow(gitToolWindowProvider);
    }

    // Wire the History tab to the GitService now that the service registry
    // is up. Safe to call multiple times (last-writer-wins).
    gitToolWindowProvider.attachGitService(extensionServices.gitService);
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

  // Register the Commit tool window. The view contribution in package.json
  // is gated by `config.intellig.useCommitToolWindow`, so when the flag is
  // off the view slot is hidden and users see zero change.
  if (extensionServices) {
    commitToolWindow = createCommitToolWindow(
      context.extensionUri,
      extensionServices.gitService,
      extensionServices.changelistService,
      extensionServices.shelfService,
      context.workspaceState
    );

    // Bind shelf/stash row controllers so the combined Shelf tab can
    // dispatch context-menu actions. ShelfView / StashView already hold the
    // QuickPick + error-handling UX; the controllers are thin adapters.
    const gs = extensionServices.gitService;
    const cs = extensionServices.conflictResolutionService;
    const shelfSvc = extensionServices.shelfService;

    // Ensure the ShelfView / StashView singletons exist — both are built
    // lazily elsewhere in this file. Re-using them keeps the Shelf tab
    // consistent with the palette commands (same UX, same confirm flow).
    if (!shelfView) {
      shelfView = createShelfView(shelfSvc, (r) => gs.getStatus(r), cs);
    }
    if (!stashView) {
      stashView = createStashView(gs, cs);
    }
    const shelfViewRef = shelfView;
    const stashViewRef = stashView;

    // When the user first opens the Commit tool window, neither view has
    // had `.show()` called, so their internal `_repository` is `undefined`.
    // Controller methods assert `_repository` — delegate to an async helper
    // that binds it on first use from the active repo.
    const bindShelfRepo = async (): Promise<IRepository | undefined> => {
      const repos = gs.getRepositories();
      const repo = repos[0];
      if (!repo) {
        return undefined;
      }
      // StashView/ShelfView expose a private _repository; they're safe to
      // seed through their `show()` entry points, but we don't want the
      // QuickPick side effect. Instead set the field directly via the
      // existing public `refresh(repo)` pattern — both views accept repo
      // via `show()` as the only path, so we fall back to `show()` for the
      // initial binding (it's a no-op beyond storing the repo).
      (shelfViewRef as unknown as { _repository: IRepository })._repository = repo;
      (stashViewRef as unknown as { _repository: IRepository })._repository = repo;
      // refresh() returns { error? }; a bind-time refresh failure is
      // usually a transient FS race and won't block the caller from
      // running the subsequent unshelve/view/delete — but we mirror it
      // into the shared OutputChannel so a persistent breakage is
      // debuggable from `Output → IntelliG` in a shipped user's host.
      const refreshResult = await shelfViewRef.refresh();
      if (refreshResult.error) {
        getOutputChannel().appendLine(
          `[${new Date().toISOString()}] [intellig] extension.bindShelfRepo: refresh failed: ${refreshResult.error}`
        );
      }
      return repo;
    };

    commitToolWindow.setShelfTabControllers(
      {
        apply: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.unshelve(id);
        },
        showDiff: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.viewShelfItem(id);
        },
        delete: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.deleteShelfItem(id);
        },
        rename: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.renameShelfItem(id);
        },
        restore: async (id): Promise<void> => {
          await bindShelfRepo();
          shelfViewRef.restoreShelfItem(id);
        },
        importPatches: async (): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.importPatches();
        },
        createPatch: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.createPatchFromShelf(id);
        },
      },
      {
        apply: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.applyStash(idx);
        },
        pop: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.popStash(idx);
        },
        drop: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.dropStash(idx);
        },
        showDiff: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.viewStash(idx);
        },
        rename: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.renameStash(idx);
        },
        branchFromStash: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.branchFromStash(idx);
        },
      }
    );

    const commitToolWindowRegistration = vscode.window.registerWebviewViewProvider(
      COMMIT_TOOL_WINDOW_VIEW_ID,
      commitToolWindow,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    );
    context.subscriptions.push(commitToolWindowRegistration);
  }

  // Wire up Log tab data loading
  // When the Log tab becomes active, fetch commits and display the graph
  if (extensionServices) {
    const gitService = extensionServices.gitService;

    // Helper to discover all repositories from all workspace folders
    const discoverAllRepositories = async (): Promise<IRepository[]> => {
      let repositories = gitService.getRepositories();
      // If no repositories discovered yet, try to discover from workspace folders
      if (repositories.length === 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            const repo = await gitService.getRepository(folder.uri);
            if (repo) {
              repositories = gitService.getRepositories();
              if (repositories.length > 0) {
                break;
              }
            }
          }
          // Re-fetch after discovery attempts
          repositories = gitService.getRepositories();
        }
      }
      return repositories;
    };

    // Helper to load commits into the log view for a specific repository.
    // Kept as a block-local `const` so type narrowing inside this block
    // continues to work. We then bind it to the hoisted
    // `hoistedLoadLogCommitsForRepo` below so the second
    // `if (extensionServices)` block can pass it into
    // `wireRepositorySelection(...)`.
    const loadLogCommitsForRepo = async (
      repo: IRepository,
      filter?: { author?: string; since?: Date; until?: Date; path?: string; searchText?: string }
    ): Promise<void> => {
      try {
        const commits = await gitService.getLog(repo, {
          maxCount: 500,
          all: true,
          // The graph algorithm needs topological order: a commit's
          // parent MUST appear later in the list (or off-window).
          // Without --topo-order, git falls back to date order; after
          // a squash/rebase/cherry-pick, fresh committerDate values
          // shuffle divergent branches between a commit and its
          // parent, which the algorithm reads as "linear" — exactly
          // the user-visible bug post-squash.
          topoOrder: true,
          author: filter?.author,
          since: filter?.since,
          until: filter?.until,
          path: filter?.path,
          grep: filter?.searchText,
        });

        // Build branch map: commit hash -> branch refs (name + type).
        // Carry `branch.type` (local/remote, derived by parseBranches from
        // the refs/heads vs refs/remotes prefix) instead of guessing from
        // the name — `feature/foo` is local even though it has a `/`.
        const branchMap = new Map<string, Array<{ name: string; type: 'local' | 'remote' }>>();
        try {
          const branches = await gitService.getBranches(repo);
          for (const branch of branches) {
            // getBranches only returns refs/heads + refs/remotes, so type is
            // always 'local' or 'remote' here; tags travel through tagMap.
            if (branch.commit && branch.type !== 'tag') {
              const existing = branchMap.get(branch.commit) || [];
              existing.push({ name: branch.name, type: branch.type });
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
          // Strip the `refs/heads/` prefix so the chip filter compares
          // against the same shape `IBranchRef.name` carries.
          const headBranchName = repo.head?.name?.replace(/^refs\/heads\//, '');
          gitToolWindowProvider.updateLogState(
            commits,
            branchMap,
            tagMap,
            repo.head?.commit,
            headBranchName
          );

          // Compute the cherry-mark map in the background and push it into
          // the provider. We don't block the log render on it — cherry marks
          // are a visual nicety, and the call is throttled by git spawn
          // overhead (typically <100ms). Gated by the
          // `intellig.log.highlightCherryPicked` flag.
          void loadCherryMarksForRepo(repo);
        }
      } catch (error) {
        getLogger()
          .child({ component: 'extension' })
          .error('failed to load git log', error instanceof Error ? error : undefined);
      }
    };

    /**
     * Compute `git log --cherry-mark` for the given repo against its
     * upstream and push the `=`-marked hashes into the Log tab's state.
     * Runs in the background; errors are swallowed so the UI stays calm.
     */
    const loadCherryMarksForRepo = async (repo: IRepository): Promise<void> => {
      if (!gitToolWindowProvider) {
        return;
      }
      const flagOn =
        vscode.workspace
          .getConfiguration('intellig.log')
          .get<boolean>('highlightCherryPicked', true) ?? true;
      if (!flagOn) {
        gitToolWindowProvider.setCherryPickedHashes(undefined);
        return;
      }
      // Resolve the upstream ref for the current branch. If the branch has
      // no upstream configured, skip silently — there's nothing meaningful
      // to diff against.
      const headUpstream = repo.head?.upstream;
      if (!headUpstream) {
        gitToolWindowProvider.setCherryPickedHashes(undefined);
        return;
      }
      const baseRef = `${headUpstream.remote}/${headUpstream.name}`;
      try {
        const gitServiceAny = gitService as IGitService & {
          getCherryMarks?: (r: IRepository, b: string) => Promise<Map<string, string>>;
        };
        if (typeof gitServiceAny.getCherryMarks !== 'function') {
          return;
        }
        const marks = await gitServiceAny.getCherryMarks(repo, baseRef);
        const equivalent = new Set<string>();
        for (const [hash, mark] of marks) {
          if (mark === '=') {
            equivalent.add(hash);
          }
        }
        gitToolWindowProvider.setCherryPickedHashes(equivalent, baseRef);
      } catch {
        // Swallow — the feature degrades cleanly when git doesn't support
        // --cherry-mark or the repo state is unusual.
      }
    };

    // Helper to load commits into the log view (uses selected or active-editor repository)
    const loadLogCommits = async (filter?: {
      author?: string;
      since?: Date;
      until?: Date;
      path?: string;
      searchText?: string;
    }): Promise<void> => {
      // Use the provider's selected repository if available
      if (gitToolWindowProvider) {
        const selectedRepo = gitToolWindowProvider.getSelectedRepository();
        if (selectedRepo) {
          await loadLogCommitsForRepo(selectedRepo, filter);
          return;
        }
      }

      // prefer the active-editor's repo in multi-root workspaces
      // on initial load when no tool-window repo selection has been made yet.
      const preferred = await resolveRepo(gitService, {
        preferActive: true,
        silent: true,
      });
      if (preferred) {
        await loadLogCommitsForRepo(preferred, filter);
        return;
      }

      // Fall back to discovering repositories (cold start — git service empty).
      const repositories = await discoverAllRepositories();
      if (repositories.length === 0) {
        return;
      }
      // ALLOWED: deterministic fallback on cold start when git service is
      // still empty AND the active-editor's repo couldn't be resolved —
      // no better signal is available. preferActive above handles the
      // populated-service multi-root case.
      const repo = repositories[0];
      await loadLogCommitsForRepo(repo, filter);
    };

    // Helper to load all panel data (commits) and update repository list
    const loadAllPanelData = async (): Promise<void> => {
      // Delegate to the exported core so the no-repository wiring (Requirement
      // 3.4) is unit-testable at the fix's call site. The core reports the
      // detection outcome to the provider via
      // `setHasRepository(repositories.length > 0)`, which always resolves the
      // transient Loading_State: repo present → leaves Loading, then the graph
      // fills via `loadLogCommits`; no repo → lands in No_Repository_State.
      await loadAllPanelDataCore({
        discoverAllRepositories,
        provider: gitToolWindowProvider,
        loadLogCommits,
      });
    };

    // Wire up onDidRequestInitialData to load all data when webview first opens
    const initialDataListener = gitToolWindowProvider.onDidRequestInitialData(() => {
      void loadAllPanelData();
    });
    context.subscriptions.push(initialDataListener);

    // Wire up onDidRequestRefresh to reload all data when repository changes
    const refreshListener = gitToolWindowProvider.onDidRequestRefresh(() => {
      void loadAllPanelData();
    });
    context.subscriptions.push(refreshListener);

    // Auto-refresh the graph when the git repository changes (new commits, branch switches, etc.)
    const repoChangeListener = gitService.onDidChangeRepository(() => {
      void loadAllPanelData();
    });
    context.subscriptions.push(repoChangeListener);

    // Load commits when log filter changes
    const filterChangeListener = gitToolWindowProvider.onDidRequestLogFilter((filter) => {
      void loadLogCommits(
        filter
          ? {
              author: filter.author,
              since: filter.since,
              until: filter.until,
              path: filter.path,
              searchText: filter.searchText,
            }
          : undefined
      );
    });
    context.subscriptions.push(filterChangeListener);

    // The repository-selector wiring (onDidSelectRepository → graph reload +
    // branch tree refresh) is registered in the second `if (extensionServices)`
    // block below, where `branchTreeProvider` is in scope. Both wirings live
    // there as a single unit so the dropdown can never update one view while
    // silently desyncing the other.

    // Wire up onDidSelectCommit to fetch changed files for the selected commit
    const commitSelectListener = gitToolWindowProvider.onDidSelectCommit(async (hash) => {
      // prefer the tool-window's selected repo (that's where the
      // commit was clicked), falling back to the active-editor's repo in
      // multi-root workspaces. The cold-start discovery path stays as a
      // last-resort fallback.
      let repo =
        gitToolWindowProvider?.getSelectedRepository() ??
        (await resolveRepo(gitService, { preferActive: true, silent: true }));
      if (!repo) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          repo = await gitService.getRepository(workspaceFolders[0].uri);
        }
      }
      if (!repo) {
        return;
      }
      try {
        const diffs = await gitService.getCommitDiff(repo, hash);
        const changedFiles = diffs.map((d) => ({
          path: d.path,
          oldPath: d.oldPath,
          status: d.status || ('modified' as const),
        }));
        if (gitToolWindowProvider) {
          gitToolWindowProvider.updateCommitDetails(hash, changedFiles);
        }
      } catch (error) {
        if (gitToolWindowProvider) {
          gitToolWindowProvider.updateCommitDetails(hash, [], error);
        }
      }
    });
    context.subscriptions.push(commitSelectListener);

    // Wire up onDidRequestCommitDiff to open diff view on file double-click
    const commitDiffListener = gitToolWindowProvider.onDidRequestCommitDiff(
      async ({ commitHash, filePath }) => {
        // prefer the tool-window's selected repo (that's where the
        // diff was requested), falling back to the active-editor's repo in
        // multi-root workspaces. The cold-start discovery path stays as a
        // last-resort fallback.
        let repo =
          gitToolWindowProvider?.getSelectedRepository() ??
          (await resolveRepo(gitService, { preferActive: true, silent: true }));
        if (!repo) {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            repo = await gitService.getRepository(workspaceFolders[0].uri);
          }
        }
        if (!repo) {
          return;
        }
        try {
          const diffs = await gitService.getCommitDiff(repo, commitHash);
          const fileDiff = diffs.find((d) => d.path === filePath || d.oldPath === filePath);
          if (fileDiff) {
            const parentRef = commitHash + '~1';
            const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${parentRef}`);
            const rightUri = vscode.Uri.parse(`intellig-git:${filePath}?${commitHash}`);
            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              rightUri,
              `${filePath} (${commitHash.substring(0, 7)})`
            );
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to open diff', error)
          );
        }
      }
    );
    context.subscriptions.push(commitDiffListener);

    // Bind the block-local helper to the hoisted reference so the second
    // `if (extensionServices)` block (which creates the BranchTreeProvider)
    // can pass it into `wireRepositorySelection(...)`.
    hoistedLoadLogCommitsForRepo = (repo: IRepository): Promise<void> =>
      loadLogCommitsForRepo(repo);

    // In the 2-panel layout, load all data immediately
    void loadAllPanelData();
  }

  // Register branch context menu commands and other services
  if (extensionServices) {
    const gitService = extensionServices.gitService;

    // Create BranchTreeProvider and tree view for context menu support
    // The tree view is used by CommandTitleProvider to listen for selection changes
    // and dynamically update command titles with branch names.
    const branchTreeProvider = createBranchTreeProvider(gitService);
    const branchTreeView = vscode.window.createTreeView('intellig.branchTree', {
      treeDataProvider: branchTreeProvider,
      showCollapseAll: true,
    });
    // Register the provider too so its EventEmitter
    // onDidChangeRepository subscription are torn down on deactivation.
    context.subscriptions.push(branchTreeView, branchTreeProvider);

    // Wire the repository selector to BOTH downstream views: the Log/Graph
    // (Git) view AND the Branches tree view. Without the branch-tree side,
    // switching repos in the dropdown updates the graph but leaves the
    // branches tree pointing at the previously-selected repo. The dual
    // wiring is centralized in `wireRepositorySelection` so the behavior
    // is unit-testable end-to-end (see repoSelectionWiring.test.ts).
    //
    // `hoistedLoadLogCommitsForRepo` is bound in the first
    // `if (extensionServices)` block above. Both blocks share this
    // top-level guard, so the helper is always defined here in production;
    // the `?? noop` fallback keeps the wiring resilient if that invariant
    // is ever broken by a future refactor.
    if (gitToolWindowProvider) {
      const noopLoadLog = (_repo: IRepository): Promise<void> => Promise.resolve();
      const loadLog = hoistedLoadLogCommitsForRepo ?? noopLoadLog;
      const repoSelectionDisposables = wireRepositorySelection({
        toolWindowProvider: gitToolWindowProvider,
        branchTreeProvider,
        loadLogCommitsForRepo: loadLog,
      });
      context.subscriptions.push(...repoSelectionDisposables);
    }

    // Link native BRANCHES tree view selection to the git graph.
    // When the user clicks a branch in the tree view, scroll the graph
    // panel to that branch's HEAD commit.
    if (gitToolWindowProvider) {
      const branchSelectionListener = branchTreeView.onDidChangeSelection((e) => {
        if (e.selection.length > 0) {
          const selectedItem = e.selection[0];
          // Only navigate for actual branch items (not category headers)
          if (selectedItem.branch) {
            gitToolWindowProvider!.navigateToBranch(selectedItem.branch.name);
          }
        }
      });
      context.subscriptions.push(branchSelectionListener);

      // `intellig.branch.focusOnGraph` inline icon command.
      // Routes the click on the branch tree's eye icon to the provider's
      // setFocusedBranch so the graph chip outlines, the scroll lands,
      // and the focused-path commits brighten while the rest dim.
      //
      // Toggle semantics: clicking the SAME
      // branch's eye icon a second time clears focus. Matches IntelliJ
      // parity (the eye icon turns into a toggle once focus is active).
      const focusOnGraphCommand = vscode.commands.registerCommand(
        'intellig.branch.focusOnGraph',
        async (item?: { branch?: { name?: string } }) => {
          const branchName = item?.branch?.name;
          if (typeof branchName !== 'string' || branchName.length === 0) {
            return;
          }
          const currentName = gitToolWindowProvider!.getFocusedBranchName();
          const nextTarget = currentName === branchName ? null : branchName;
          await gitToolWindowProvider!.setFocusedBranch(nextTarget);
        }
      );
      context.subscriptions.push(focusOnGraphCommand);
    }

    // Create and register CommandTitleProvider for dynamic label resolution
    const commandTitleProvider = createCommandTitleProvider(gitService, branchTreeProvider);
    commandTitleProvider.register(context, branchTreeView);
    context.subscriptions.push(commandTitleProvider);

    // Register branch context menu commands for the native BRANCHES tree view.
    // These are the actual VS Code command handlers invoked by the tree view context menus.
    // - conflictResolutionService: conflict-producing ops auto-open the dialog.
    // - pullDialog accessor: pullUsingRebase/pullUsingMerge route through the dialog.
    // - pushDialog opener: branch.push routes through the dialog.
    // - merge + new-branch dialog openers: branch.mergeInto and
    //   branch.newBranchFrom / tag.newBranchFrom route through their webview dialogs.
    const branchContextMenuCommands = createBranchContextMenuCommands(
      gitService,
      branchTreeProvider,
      extensionServices.conflictResolutionService,
      _getPullDialog,
      _openPushDialog,
      _openMergeDialog,
      _openNewBranchDialog
    );
    branchContextMenuCommands.register(context);

    // Register commit context menu commands for the Git Graph Panel.
    // These handle right-click actions on commit rows in the graph view.
    // Pass conflictResolutionService so cherry-pick/revert/merge route
    // through the Resolve Conflicts dialog on conflict.
    if (gitToolWindowProvider) {
      commitContextMenuCommands = createCommitContextMenuCommands(
        gitService,
        extensionServices.rebaseService,
        gitToolWindowProvider,
        (gitService as unknown as IGitServiceCli).gitCli,
        extensionServices.conflictResolutionService
      );
      commitContextMenuCommands.register(context);
    }

    // Initialize Status Bar Service
    statusBarService = createStatusBarService(gitService);
    context.subscriptions.push(statusBarService);

    // Initialize Notification Service. It owns no disposables of its
    // own — the shared `IntelliG` OutputChannel it consumes is
    // registered against `context.subscriptions` by
    // `initOutputChannel(context)` earlier in activate — so we do NOT
    // push the service itself onto the subscriptions list (it has no
    // `dispose()` to call).
    notificationService = createNotificationService();

    // Initialize Keymap Service
    keymapService = new KeymapService(extensionServices.configurationService);
    context.subscriptions.push(keymapService);

    // Eagerly create the MergeView singleton so the Resolve Conflicts dialog
    // can subscribe to `onDidResolve` from the moment the service is wired.
    // MergeView is otherwise cheap — it only opens a panel on `show()`.
    if (!mergeView) {
      mergeView = createMergeView(context.extensionUri, gitService);
    }
    const conflictService = extensionServices.conflictResolutionService;
    if (
      conflictService &&
      typeof (conflictService as { setResolveConflictsDependencies?: unknown })
        .setResolveConflictsDependencies === 'function'
    ) {
      (
        conflictService as unknown as {
          setResolveConflictsDependencies: (
            ctx: vscode.ExtensionContext,
            mv: typeof mergeView
          ) => void;
        }
      ).setResolveConflictsDependencies(context, mergeView);
    }

    // Initialize Stash View — pass conflictResolutionService so that
    // `apply`/`pop` conflicts route through the Resolve Conflicts dialog.
    stashView = createStashView(gitService, extensionServices.conflictResolutionService);
    context.subscriptions.push(stashView);

    // Initialize Shelf View — pass conflictResolutionService so that
    // unshelve conflicts route through the Resolve Conflicts dialog.
    shelfView = createShelfView(
      extensionServices.shelfService,
      (repo) => gitService.getStatus(repo),
      extensionServices.conflictResolutionService
    );
    context.subscriptions.push(shelfView);

    // Initialize Branch Comparison View
    branchComparisonView = createBranchComparisonView(gitService);
    context.subscriptions.push(branchComparisonView);

    // late-bind the branch comparison view onto the
    // commit context menu commands so the new "Compare with Branch..."
    // menu entry can route through it. The comparison view is
    // constructed AFTER `commitContextMenuCommands` in this activate()
    // sequence, so the constructor injection isn't possible without
    // reshuffling the wiring order.
    if (commitContextMenuCommands) {
      commitContextMenuCommands.setBranchComparisonView(branchComparisonView);
    }

    // Initialize Gutter Blame Provider
    gutterBlameProvider = createGutterBlameProvider(
      extensionServices.blameService,
      gitService,
      extensionServices.blameOptionsSource
    );
    context.subscriptions.push(gutterBlameProvider);

    // Initialize Rebase Progress View
    rebaseProgressView = createRebaseProgressView(
      context.extensionUri,
      extensionServices.rebaseService
    );
    context.subscriptions.push(rebaseProgressView);
  }
}

/**
 * Resolve the content of an `intellig-git:` URI by running `git show <ref>:<path>`.
 *
 * Exported so it is unit-testable. The production entry point
 * `registerGitContentProvider` wires this to the module-level `extensionServices`
 * and to the real `vscode.workspace.workspaceFolders` fallback; tests call this
 * directly with a `GitService` whose `_gitCli` has been swapped for a mock.
 *
 * Query-shape contract (ADR pending): producers MUST emit
 * `intellig-git:${path}?${encodeURIComponent(ref)}`. This function
 * `decodeURIComponent`s the query exactly once so refs containing `/`
 * (`origin/main` → `origin%2Fmain` on the wire) round-trip back to `git show`.
 *
 * @internal — exported only for `src/test/unit/extension/contentProvider.test.ts`.
 * Do not call from production code or new tests outside that file without review.
 */
export async function provideGitShowContent(
  uri: vscode.Uri,
  gitService: IGitService,
  workspaceFolders?: readonly { uri: vscode.Uri }[]
): Promise<string> {
  const filePath = uri.path;
  // The query string is the URL-encoded git ref (commit hash, hash~1, or
  // branch ref such as `origin/main`). Producers across the codebase call
  // `encodeURIComponent(ref)` when building `intellig-git:` URIs; decoding
  // here ensures refs containing `/` (e.g. `origin/main` → `origin%2Fmain`)
  // round-trip correctly to `git show`. Without this, `git show
  // origin%2Fmain:path` fails to resolve the revision.
  //
  // A malformed percent-encoding (e.g. `%GG`) throws a raw `URIError` from
  // the platform `decodeURIComponent`. Wrap it in a friendly error that
  // identifies the contract violation so upstream error handlers and logs
  // point at the URI rather than at an opaque "URI malformed" message.
  let ref: string;
  try {
    ref = decodeURIComponent(uri.query);
  } catch (err) {
    throw new Error(`Malformed ref in intellig-git URI: ${uri.query}`, { cause: err });
  }

  if (!ref) {
    throw new Error('No git ref specified in URI query');
  }

  // honor the URI's filePath as a repo hint so diff provider
  // reaches for the correct repo in multi-root workspaces. Falls back
  // to the active-editor's repo, then to workspace-folder discovery.
  let repo = await resolveRepo(gitService, {
    hintRepoPath: filePath,
    preferActive: true,
    silent: true,
  });
  if (!repo) {
    const folders = workspaceFolders ?? vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      repo = await gitService.getRepository(folders[0].uri);
    }
  }
  if (!repo) {
    throw new Error('No Git repository found');
  }
  try {
    // `gitCli` is exposed via the `@internal` {@link IGitServiceCli} escape
    // hatch — the frozen {@link IGitService} composite deliberately doesn't
    // wrap raw `git show <ref>:<path>`. An eventual role-interface
    // decomposition (see backlog) would fold this into a proper method.
    const result = await (gitService as unknown as IGitServiceCli).gitCli.exec(
      ['show', `${ref}:${filePath}`],
      {
        cwd: repo.rootUri.fsPath,
      }
    );
    if (result.exitCode !== 0) {
      // File might not exist at this revision (e.g., newly added file)
      return '';
    }
    return result.stdout;
  } catch {
    // File doesn't exist at this revision
    return '';
  }
}

/**
 * Register a TextDocumentContentProvider for the 'intellig-git' URI scheme.
 * This allows opening file content at specific git revisions using URIs like:
 *   intellig-git:path/to/file.ts?ref=<commitHash>
 *
 * Used by the commit diff feature to show file content at parent and current commits.
 */
function registerGitContentProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri: vscode.Uri): Promise<string> => {
      if (!extensionServices) {
        throw new Error('Extension services not initialized');
      }
      return provideGitShowContent(uri, extensionServices.gitService);
    },
  };

  const registration = vscode.workspace.registerTextDocumentContentProvider(
    'intellig-git',
    provider
  );
  context.subscriptions.push(registration);
}

/**
 * Set up event listeners for workspace and Git changes.
 *
 * @param context - The VS Code extension context
 */
function setupEventListeners(context: vscode.ExtensionContext): void {
  // Surface a warning toast for any repository that's already in a paused-
  // rebase state at activation, plus on every subsequent
  // `onDidChangeRepository` transition into `rebasing`. Without this, users
  // who reloaded VS Code mid-rebase saw no signal until they re-triggered a
  // rebase command. See `wireRebasePausedWarning` for the implementation
  // contract.
  if (extensionServices) {
    const rebaseWarningDisposables = wireRebasePausedWarning({
      gitService: extensionServices.gitService,
      window: vscode.window,
      commands: vscode.commands,
    });
    context.subscriptions.push(...rebaseWarningDisposables);
  }

  // Listen for workspace folder changes and update the repository list
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
    getLogger().child({ component: 'extension' }).info('workspace folders changed', {
      added: event.added.length,
      removed: event.removed.length,
    });

    // Update the repository list when workspace folders change
    if (extensionServices && gitToolWindowProvider) {
      const gitService = extensionServices.gitService;

      // Discover repositories from all current workspace folders
      for (const folder of event.added) {
        await gitService.getRepository(folder.uri);
      }

      const repositories = gitService.getRepositories();
      gitToolWindowProvider.setAvailableRepositories(repositories);
    }
  });

  // Listen for configuration changes
  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('intellig')) {
      getLogger().child({ component: 'extension' }).debug('intellig configuration changed');
    }
  });

  // Listen for active editor changes (for blame annotations)
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      // Placeholder: blame annotations refresh on editor change is not yet wired.
    }
  });

  // Register all listeners with the extension context
  context.subscriptions.push(workspaceFoldersListener, configurationListener, activeEditorListener);
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

/**
 * Handle the outcome of the generic `intellig.pull` PullDialog.
 *
 * The dialog (`runPullDialog`) shows its own toasts for the `pulled`,
 * `conflict`, and `error` outcomes, so this helper deliberately does NOT
 * re-toast for those — doing so would double-handle. For `cancelled`, the
 * dialog shows nothing (Esc / dismissing is a normal user action), so we
 * emit a single debug-level structured log record naming the step the user
 * cancelled at. That keeps a dismissed dialog observable in the IntelliG
 * OutputChannel without surfacing a toast.
 *
 * Extracted as a pure, exported function so the outcome-branching is unit
 * testable without driving the registered command through the extension
 * host. Do not call from production code outside the `intellig.pull`
 * registration without review.
 *
 * @param outcome the result returned by `PullDialog.show()`
 */
export function handlePullDialogOutcome(outcome: PullDialogOutcome): void {
  if (outcome.status === 'cancelled') {
    getLogger()
      .child({ component: 'extension' })
      .debug('pull dialog cancelled', { step: outcome.step });
    return;
  }
  // pulled / conflict / error: the dialog already surfaced the appropriate
  // toast internally (see `runPullDialog`). Nothing more to do here.
}

// ─── Push dialog ─────────────────────────────────────────────────────────────

/**
 * Open a fresh Push dialog. Unlike Pull, Push is constructed per-invocation
 * because the row table is a snapshot of the current repo state (branches,
 * commits-since badges) — reusing a singleton would render stale data.
 *
 * @param preselect - Optional single-repo/branch pre-selection. When omitted,
 *   all workspace repos are shown with the active-editor repo pre-selected.
 */
export function _openPushDialog(preselect?: {
  repo: IRepository;
  branch?: string;
}): PushDialog | undefined {
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
export function openPushDialog(preselect?: {
  repo: IRepository;
  branch?: string;
}): PushDialog | undefined {
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

// ─── New Tag flow ────────────────────────────────────────────────────────────

/**
 * Validate a git tag name using a subset of git-check-ref-format rules.
 * Returns an error message when invalid, `undefined` when valid.
 */
export function validateTagName(name: string): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Tag name cannot be empty';
  }
  if (/\s/.test(name)) {
    return 'Tag name cannot contain whitespace';
  }
  if (/[~^:?*[\\]/.test(name)) {
    return 'Tag name cannot contain any of ~ ^ : ? * [ \\';
  }
  if (name.includes('..')) {
    return 'Tag name cannot contain consecutive dots';
  }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) {
    return 'Tag name cannot start with -, ., or /';
  }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'Tag name cannot end with ., /, or .lock';
  }
  // Control characters
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return 'Tag name cannot contain control characters';
    }
  }
  return undefined;
}

/**
 * Extract a commit hash from a context-menu argument. Accepts strings,
 * objects with `{ hash }`, or undefined.
 */
function _extractCommitHash(arg: unknown): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  if (typeof arg === 'object' && arg !== null) {
    const obj = arg as { hash?: unknown; commit?: unknown };
    if (typeof obj.hash === 'string') {
      return obj.hash;
    }
    if (typeof obj.commit === 'string') {
      return obj.commit;
    }
  }
  return undefined;
}

/**
 * Pick a repository for the New Tag flow. Returns `undefined` if the user
 * cancels or no repository is available.
 */
async function _pickRepositoryForTag(): Promise<IRepository | undefined> {
  if (!extensionServices) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  // Delegate to the unified resolver so `intellig.defaultRepo` and the
  // active-editor heuristic apply here too.
  return resolveRepo(extensionServices.gitService, {
    preferActive: true,
    pickerTitle: 'Create Tag — Choose Repository',
    pickerPlaceholder: 'Select a repository',
  });
}

/**
 * Dependencies for the New Tag flow. Kept as a discrete object so tests can
 * exercise the flow without needing full extension activation.
 */
export interface INewTagFlowDeps {
  /** The repository to tag against. */
  repo: IRepository;
  /** Git service used to create the tag. */
  gitService: IGitService;
  /**
   * Prompt helper compatible with `vscode.window.showInputBox`. Returning
   * `undefined` means the user cancelled.
   */
  showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  /** Info-toast helper (`vscode.window.showInformationMessage` shape). */
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  /** Error-toast helper (`vscode.window.showErrorMessage` shape). */
  showErrorMessage: (message: string) => Thenable<string | undefined>;
  /** Optional refresh hook invoked on success. */
  onTagCreated?: () => void;
}

/**
 * Pure (dependency-injected) implementation of the New Tag flow. Prompts
 * for a tag name, then an optional annotation message, then creates the
 * tag against `targetRef` (or HEAD when `targetRef` is undefined).
 *
 * Exported so unit tests can exercise the flow without activating the
 * extension.
 */
export async function runNewTagFlow(
  deps: INewTagFlowDeps,
  targetRef: string | undefined
): Promise<void> {
  const name = await deps.showInputBox({
    title: 'Create Tag',
    prompt: 'Tag name',
    placeHolder: 'e.g., v1.0.0',
    validateInput: (value: string) => validateTagName(value),
  });
  if (!name) {
    return;
  }

  const message = await deps.showInputBox({
    title: 'Create Tag',
    prompt: 'Optional annotation message (leave empty for a lightweight tag)',
    placeHolder: 'e.g., Release 1.0',
  });
  if (message === undefined) {
    // User pressed Escape on the message prompt.
    return;
  }

  try {
    const normalizedMessage = message.trim().length > 0 ? message : undefined;
    await deps.gitService.createTag(deps.repo, name, normalizedMessage, targetRef);
    void deps.showInformationMessage(`Created tag: ${name}`);
    if (deps.onTagCreated) {
      deps.onTagCreated();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void deps.showErrorMessage(`Failed to create tag: ${sanitizeGitError(msg)}`);
  }
}

/**
 * Extension-level wrapper: picks a repository, wires the real VS Code window
 * helpers, then delegates to `runNewTagFlow`.
 */
async function _runNewTagFlow(targetRef: string | undefined): Promise<void> {
  const repo = await _pickRepositoryForTag();
  if (!repo || !extensionServices) {
    return;
  }
  await runNewTagFlow(
    {
      repo,
      gitService: extensionServices.gitService,
      showInputBox: (options) => vscode.window.showInputBox(options),
      showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
      showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
      onTagCreated: () => {
        // createTag added a ref that drives the
        // tag tree + log-graph tag chip; reload before refresh so the
        // panel reads the post-mutation tag set.
        void (async (): Promise<void> => {
          await extensionServices!.gitService.reloadRepository(repo);
          if (gitToolWindowProvider) {
            gitToolWindowProvider.refresh();
          }
        })();
      },
    },
    targetRef
  );
}

// ─── Log-commit menu helpers ─────────────────────────────────────────────────

// ─── Cherry-Pick variant helpers ─────────────────────────────────────────────

/**
 * Pick a subset of files touched by `hash` via a multi-select QuickPick.
 * Returns `undefined` when the user cancels. Returns an empty array when
 * the user submits without picking anything; callers should treat that as
 * cancel (short-circuit to "apply nothing").
 */
async function _pickCommitFiles(
  gitService: IGitService,
  repo: IRepository,
  hash: string,
  title: string
): Promise<string[] | undefined> {
  const diffs = await gitService.getCommitDiff(repo, hash);
  if (diffs.length === 0) {
    void vscode.window.showInformationMessage('No files changed in this commit.');
    return undefined;
  }
  const items = diffs.map((d) => ({
    label: d.path,
    description: d.status,
    picked: true, // IntelliJ pre-selects all files; users deselect to narrow.
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${title} — ${hash.substring(0, 8)}`,
    placeHolder: 'Select files to apply (Enter to confirm, Esc to cancel)',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return picked.map((p) => p.label);
}

/**
 * Shared variant runner for Cherry-Pick Without Commit + Apply Selected
 * Changes. Picks a repo, extracts the hash, invokes
 * {@link IGitService.cherryPick} with the variant options, and routes
 * conflicts through the Resolve Conflicts dialog when available.
 */
async function _runCherryPickVariant(
  commitArg: unknown,
  options: { noCommit?: boolean; files?: string[] }
): Promise<void> {
  const hash = _extractCommitHash(commitArg);
  if (!hash) {
    void vscode.window.showErrorMessage('No commit selected.');
    return;
  }
  const repo = await _pickRepositoryForCommit();
  if (!repo || !extensionServices) {
    return;
  }
  const gitService = extensionServices.gitService;
  const conflictService = extensionServices.conflictResolutionService;
  const shortHash = hash.substring(0, 8);

  try {
    const result = await gitService.cherryPick(repo, [hash], options);
    if (result.success) {
      const verb = options.files
        ? 'Applied selected changes from'
        : options.noCommit
          ? 'Cherry-picked (without commit)'
          : 'Cherry-picked';
      void vscode.window.showInformationMessage(`${verb} ${shortHash}`);
      // top-level cherry-pick advanced HEAD;
      // reload before refresh so panel sees fresh state.
      await gitService.reloadRepository(repo);
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
      return;
    }
    if (result.conflicts && result.conflicts.length > 0 && conflictService) {
      await conflictService.openResolveConflictsDialog(
        repo,
        result.conflicts.map((p) => ({ path: p, resolved: false })),
        {
          operation: 'cherryPick',
          target: shortHash,
          canAbort: true,
          canContinue: true,
        }
      );
      // Partial cherry-pick may have advanced HEAD
      // before the conflict; reload before refresh.
      await gitService.reloadRepository(repo);
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
      return;
    }
    // Defensive: no conflicts, no success — surface a generic error.
    // sanitize-exempt: sha-prefix: shortHash is a 7-char SHA fragment, bounded charset cannot embed credentials
    void vscode.window.showWarningMessage(`Cherry-pick of ${shortHash} completed with warnings.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Cherry-pick failed: ${sanitizeGitError(msg)}`);
  }
}

/**
 * Apply Files to Branch flow: prompts for file subset + target branch,
 * stashes any dirty state on the current branch, checks out the target,
 * cherry-picks (with file subset, no-commit) onto it, then returns to the
 * original branch if a stash was taken. The user decides on the target
 * branch whether to commit the staged changes.
 *
 * Data-loss safeguard: if the working tree is dirty and stash fails, we
 * refuse to switch branches.
 */
async function _runApplyFilesToBranchFlow(commitArg: unknown): Promise<void> {
  const hash = _extractCommitHash(commitArg);
  if (!hash) {
    void vscode.window.showErrorMessage('No commit selected.');
    return;
  }
  const repo = await _pickRepositoryForCommit();
  if (!repo || !extensionServices) {
    return;
  }
  const gitService = extensionServices.gitService;
  const shortHash = hash.substring(0, 8);

  // Pick the target branch.
  const branches = await gitService.getBranches(repo);
  const localBranches = branches.filter((b) => b.type === 'local');
  const currentBranchName = repo.head?.name?.replace(/^refs\/heads\//, '');
  const otherBranches = localBranches.filter((b) => b.name !== currentBranchName);
  if (otherBranches.length === 0) {
    void vscode.window.showErrorMessage(
      'Apply Files to Branch needs at least one other local branch.'
    );
    return;
  }
  const branchPick = await vscode.window.showQuickPick(
    otherBranches.map((b) => ({ label: b.name, description: b.commit?.substring(0, 8) })),
    {
      title: `Apply Files to Branch — ${shortHash}`,
      placeHolder: 'Pick a target branch',
    }
  );
  if (!branchPick) {
    return;
  }
  const targetBranch = branchPick.label;

  // Pick the file subset.
  const files = await _pickCommitFiles(gitService, repo, hash, 'Apply Files to Branch');
  if (!files || files.length === 0) {
    return;
  }

  // Stash dirty state (best-effort), switch, cherry-pick, restore.
  let stashed = false;
  try {
    const status = await gitService.getStatus(repo);
    if (status.length > 0) {
      await gitService.stash(repo, `Auto-stash before applying files to ${targetBranch}`);
      stashed = true;
    }
  } catch (stashError) {
    const msg = stashError instanceof Error ? stashError.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Refusing to switch branch — failed to stash dirty state: ${sanitizeGitError(msg)}`
    );
    return;
  }

  try {
    await gitService.checkout(repo, targetBranch);
    const result = await gitService.cherryPick(repo, [hash], {
      noCommit: true,
      files,
    });
    if (result.success) {
      void vscode.window.showInformationMessage(
        `Applied ${files.length} file(s) from ${shortHash} onto '${targetBranch}'. ` +
          `Review and commit on that branch, or reset to discard.`
      );
    } else if (result.conflicts && result.conflicts.length > 0) {
      const conflictService = extensionServices.conflictResolutionService;
      if (conflictService) {
        await conflictService.openResolveConflictsDialog(
          repo,
          result.conflicts.map((p) => ({ path: p, resolved: false })),
          {
            operation: 'cherryPick',
            target: `${shortHash} → ${targetBranch}`,
            canAbort: true,
            canContinue: true,
          }
        );
      } else {
        void vscode.window.showWarningMessage(
          `Conflicts in ${result.conflicts.length} file(s) on '${targetBranch}'. Resolve and commit manually.`
        );
      }
      // Leave the user on the target branch so they can resolve.
      // Checkout + cherry-pick advanced HEAD onto
      // target branch; reload before refresh so the user sees the
      // post-checkout panel state with the unresolved conflicts.
      await gitService.reloadRepository(repo);
      if (gitToolWindowProvider) {
        gitToolWindowProvider.refresh();
      }
      return;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Apply Files to Branch failed: ${sanitizeGitError(msg)}`);
  } finally {
    // Always return to the original branch unless we're on the target with
    // unresolved conflicts (already returned above). Pop the stash after
    // the switch-back so the user sees their original state.
    if (currentBranchName) {
      try {
        await gitService.checkout(repo, currentBranchName);
      } catch (backError) {
        const msg = backError instanceof Error ? backError.message : 'Unknown error';
        void vscode.window.showWarningMessage(
          `Could not return to '${currentBranchName}': ${sanitizeGitError(msg)}. ` +
            `You may be on '${targetBranch}' now.`
        );
      }
    }
    if (stashed) {
      try {
        await gitService.stashPop(repo, 0);
      } catch (popError) {
        const msg = popError instanceof Error ? popError.message : 'Unknown error';
        void vscode.window.showWarningMessage(
          `Could not pop auto-stash: ${sanitizeGitError(msg)}. Run 'git stash pop' manually.`
        );
      }
    }
    // Finally block runs after multi-step pipeline
    // (stash → checkout → cherry-pick → checkout-back → stashPop); reload
    // before refresh so the panel reflects the final restored state on
    // the original branch.
    await gitService.reloadRepository(repo);
    if (gitToolWindowProvider) {
      gitToolWindowProvider.refresh();
    }
  }
}

/**
 * Validate a branch name. Matches the validator used in
 * `BranchContextMenuCommands._handleNewBranchFrom` (same regex) so behaviour
 * is consistent across all "New Branch…" entry points.
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
  // Security: reject leading `-` (git parses `-foo` as a CLI flag) and
  // leading `.` (invalid per git-check-ref-format).
  if (!/^(?![-.])[\w\-./]+$/.test(value)) {
    return 'Branch name contains invalid characters';
  }
  return undefined;
}

/**
 * Internal alias used by the `validateInput` callback shape. Retained for
 * any legacy callers that still use `showInputBox`; current entry points
 * route through the New Branch Dialog webview.
 */
export function _validateBranchName(value: string): string | undefined {
  return validateBranchName(value);
}

/**
 * Resolve a single repository to operate on for a commit-context action.
 * Single-repo workspaces are auto-selected; multi-repo shows a QuickPick.
 */
async function _pickRepositoryForCommit(): Promise<IRepository | undefined> {
  if (!extensionServices) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  const gitService = extensionServices.gitService;
  const repos = gitService.getRepositories();
  if (repos.length === 0) {
    void vscode.window.showErrorMessage('No Git repository found in workspace');
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const items = repos.map((r) => ({
    label: r.rootUri.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? r.rootUri.fsPath,
    description: r.rootUri.fsPath,
    repo: r,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Choose Repository',
    placeHolder: 'Select a repository',
  });
  return picked?.repo;
}

/**
 * Open the given commit on its hosting provider's web UI.
 *
 * Resolves the repo's `origin` remote, parses the URL, and builds the
 * provider-specific commit URL. If the provider isn't recognised or the
 * repo has no origin, we surface an explanatory error toast instead of
 * silently doing nothing.
 */
async function _openCommitOnHost(hash: string): Promise<void> {
  const repo = await _pickRepositoryForCommit();
  if (!repo || !extensionServices) {
    return;
  }

  try {
    const remotes = await extensionServices.gitService.getRemotes(repo);
    if (!remotes || remotes.length === 0) {
      void vscode.window.showInformationMessage(
        'Open on Host: no remotes configured for this repository.'
      );
      return;
    }
    // Prefer `origin`; fall back to first remote with a fetch URL.
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = origin.fetchUrl ?? origin.pushUrl;
    const parsed = parseRemoteUrl(url);
    if (!parsed) {
      void vscode.window.showErrorMessage(
        `Open on Host: could not parse remote URL "${url ?? '(none)'}".`
      );
      return;
    }
    const link = commitUrl(parsed, hash);
    if (!link) {
      void vscode.window.showErrorMessage(
        `Open on Host: provider "${parsed.host}" is not supported yet.`
      );
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(link));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Open on Host failed: ${sanitizeGitError(msg)}`);
  }
}

/**
 * Open a diff picker for a single commit vs. a reference point. For each
 * changed file in the commit, the user can open a side-by-side diff using
 * the `intellig-git:` content-provider scheme.
 */
async function _openCommitFileDiff(
  repo: IRepository,
  commitHash: string,
  parentRef: string,
  gitService: IGitService
): Promise<void> {
  const diffs = await gitService.getCommitDiff(repo, commitHash);
  if (diffs.length === 0) {
    void vscode.window.showInformationMessage('No changes in this commit.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    diffs.map((d) => ({ label: d.path, description: d.status })),
    {
      title: `Changed files in ${commitHash.substring(0, 8)}`,
      placeHolder: 'Select a file to diff',
    }
  );
  if (!picked) {
    return;
  }
  const filePath = picked.label;
  const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(parentRef)}`);
  const rightUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(commitHash)}`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `${filePath} (${parentRef.substring(0, 8)} ↔ ${commitHash.substring(0, 8)})`
  );
}

/**
 * Given a commit hash and a comparison target (branch name / commit / 'HEAD'),
 * list files that differ between the two and open a diff for the chosen file.
 *
 * Used by `compareWithHead` and `compareWith`. Simple implementation: we
 * get the diff of `commitHash` vs its parent and the diff of `target` vs
 * its parent, then merge file lists. Not a proper 3-way diff.
 */
async function _openRefPairDiffPicker(
  repo: IRepository,
  commitHash: string,
  target: string,
  gitService: IGitService
): Promise<void> {
  try {
    // Use getCommitDiff for the commit as the file list. For a true
    // symmetric compare, a future enhancement can run `git diff a..b`.
    const diffs = await gitService.getCommitDiff(repo, commitHash);
    if (diffs.length === 0) {
      void vscode.window.showInformationMessage('No files to compare for this commit.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      diffs.map((d) => ({ label: d.path, description: d.status })),
      {
        title: `Compare ${commitHash.substring(0, 8)} ↔ ${target.substring(0, 8)}`,
        placeHolder: 'Select a file to diff',
      }
    );
    if (!picked) {
      return;
    }
    const filePath = picked.label;
    const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(target)}`);
    const rightUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(commitHash)}`);
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `${filePath} (${target} ↔ ${commitHash.substring(0, 8)})`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to compare: ${sanitizeGitError(msg)}`);
  }
}

/**
 * Prompt the user to pick a ref (branch or recent commit) for a pairwise
 * comparison. Returns the selected ref name, or `undefined` on cancel.
 */
async function _pickRefForComparison(
  repo: IRepository,
  gitService: IGitService
): Promise<string | undefined> {
  const [branches, commits] = await Promise.all([
    gitService.getBranches(repo),
    gitService.getLog(repo, { maxCount: 20 }),
  ]);
  const branchItems = branches.map((b) => ({
    label: b.name,
    description: b.type === 'remote' ? 'remote' : 'local',
    detail: b.commit.substring(0, 8),
  }));
  const commitItems = commits.map((c) => ({
    label: c.shortHash,
    description: c.message.split('\n')[0].substring(0, 60),
    detail: `${c.author.name} — ${c.authorDate.toLocaleDateString()}`,
  }));
  const items: vscode.QuickPickItem[] = [
    { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
    ...branchItems,
    { label: 'Recent Commits', kind: vscode.QuickPickItemKind.Separator },
    ...commitItems,
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Compare with…',
    placeHolder: 'Choose a branch or commit',
  });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) {
    return undefined;
  }
  return picked.label;
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
