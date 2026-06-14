import type * as vscode from 'vscode';
import type {
  ExtensionServices,
  GitToolWindowProvider,
  CommitToolWindow,
  StashView,
  ShelfView,
  MergeView,
  StatusBarService,
  NotificationService,
  KeymapService,
  GutterBlameProvider,
  BranchComparisonView,
  RebaseProgressView,
  PullDialog,
  PushDialog,
  IPushPreselect,
  MergeDialog,
  NewBranchDialog,
  IRepository,
} from '../services';
import type { CommitContextMenuCommands } from '../commits';

/**
 * Read/WRITE bridge to extension.ts's module-level singletons, the
 * view-registration analog of {@link ICommandContext} (RULE E1). Owns NO
 * state; every get/set forwards to the live module `let` in extension.ts so
 * lazy-init write-back (e.g. `ctx.gitToolWindowProvider = new
 * GitToolWindowProvider(...)`) mutates the single owner that the exported
 * `getServices()` / `getGitToolWindowProvider()` / `deactivate()` also
 * observe. The relocated `registerViews` / `registerGitContentProvider` /
 * `setupEventListeners` reach state exclusively through this context and
 * NEVER declare their own singleton `let`.
 */
export interface IViewRegistrationContext {
  /** The live ExtensionContext (extensionUri / workspaceState / subscriptions). */
  readonly context: vscode.ExtensionContext;

  /** = `extensionServices` (read; set only in activate). */
  readonly services: ExtensionServices | undefined;

  // read/WRITE accessors for every singleton the view registration
  // constructs. Setter writes THROUGH to the module let so the single owner
  // is preserved (deactivate() disposes the same instances).
  get gitToolWindowProvider(): GitToolWindowProvider | undefined;
  set gitToolWindowProvider(v: GitToolWindowProvider | undefined);
  get commitToolWindow(): CommitToolWindow | undefined;
  set commitToolWindow(v: CommitToolWindow | undefined);
  get stashView(): StashView | undefined;
  set stashView(v: StashView | undefined);
  get shelfView(): ShelfView | undefined;
  set shelfView(v: ShelfView | undefined);
  get mergeView(): MergeView | undefined;
  set mergeView(v: MergeView | undefined);
  get statusBarService(): StatusBarService | undefined;
  set statusBarService(v: StatusBarService | undefined);
  get notificationService(): NotificationService | undefined;
  set notificationService(v: NotificationService | undefined);
  get keymapService(): KeymapService | undefined;
  set keymapService(v: KeymapService | undefined);
  get gutterBlameProvider(): GutterBlameProvider | undefined;
  set gutterBlameProvider(v: GutterBlameProvider | undefined);
  get branchComparisonView(): BranchComparisonView | undefined;
  set branchComparisonView(v: BranchComparisonView | undefined);
  get rebaseProgressView(): RebaseProgressView | undefined;
  set rebaseProgressView(v: RebaseProgressView | undefined);
  get commitContextMenuCommands(): CommitContextMenuCommands | undefined;
  set commitContextMenuCommands(v: CommitContextMenuCommands | undefined);

  // cross-module dialog-opener helpers passed into the branch context menu
  // commands. They forward to the module-private openers in extension.ts
  // (which read extensionContext + lazily assign pullDialog) — unchanged
  // behavior.
  getPullDialog(): PullDialog | undefined;
  openPushDialog(preselect?: IPushPreselect): PushDialog | undefined;
  openMergeDialog(preselect: { repo: IRepository; sourceBranch: string }): MergeDialog | undefined;
  openNewBranchDialog(preselect: {
    repo: IRepository;
    startPoint?: string;
    defaultName?: string;
  }): NewBranchDialog | undefined;
}
