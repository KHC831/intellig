import type * as vscode from 'vscode';
import type {
  ExtensionServices,
  GitToolWindowProvider,
  CommitDialog,
  CommitToolWindow,
  BranchPopup,
  MergeView,
  RebaseEditor,
  InlineBlameProvider,
  GutterBlameProvider,
  StashView,
  ShelfView,
  BranchComparisonView,
  PullDialog,
  PushDialog,
  IPushPreselect,
  MergeDialog,
  RebaseDialog,
  IRebaseDialogPreselect,
  NewBranchDialog,
  IRepository,
} from '../../services';
import type { CommitContextMenuCommands } from '../../commits';

/**
 * Read/WRITE bridge to extension.ts's module-level singletons. Owns NO state;
 * every property get/set forwards to the live module `let` in extension.ts so
 * lazy-init write-back (e.g. `ctx.commitDialog = new CommitDialog(...)`)
 * mutates the single owner that the exported `getServices()` / `deactivate()`
 * also observe (RULE E1 — the read/write analog of GitService's read-through
 * RULE G1). Command modules NEVER declare their own singleton `let`.
 */
export interface ICommandContext {
  /** The live ExtensionContext (extensionUri / workspaceState / subscriptions). */
  readonly context: vscode.ExtensionContext;

  /** = `extensionServices` (read; set only in activate). */
  readonly services: ExtensionServices | undefined;

  /** = `gitToolWindowProvider` (read; set in registerViews, deferred). */
  readonly gitToolWindowProvider: GitToolWindowProvider | undefined;

  /** = `commitContextMenuCommands` (read; set in registerViews, deferred). */
  readonly commitContextMenuCommands: CommitContextMenuCommands | undefined;

  /** = `commitToolWindow` (read-only; set in registerViews, deferred). */
  readonly commitToolWindow: CommitToolWindow | undefined;

  // read/WRITE accessors for every lazily-initialized singleton a handler
  // assigns inside registerCommands. Setter writes THROUGH to the module let.
  get commitDialog(): CommitDialog | undefined;
  set commitDialog(v: CommitDialog | undefined);
  get branchPopup(): BranchPopup | undefined;
  set branchPopup(v: BranchPopup | undefined);
  get stashView(): StashView | undefined;
  set stashView(v: StashView | undefined);
  get shelfView(): ShelfView | undefined;
  set shelfView(v: ShelfView | undefined);
  get inlineBlameProvider(): InlineBlameProvider | undefined;
  set inlineBlameProvider(v: InlineBlameProvider | undefined);
  get gutterBlameProvider(): GutterBlameProvider | undefined;
  set gutterBlameProvider(v: GutterBlameProvider | undefined);
  get branchComparisonView(): BranchComparisonView | undefined;
  set branchComparisonView(v: BranchComparisonView | undefined);
  get mergeView(): MergeView | undefined;
  set mergeView(v: MergeView | undefined);
  get rebaseEditor(): RebaseEditor | undefined;
  set rebaseEditor(v: RebaseEditor | undefined);

  // cross-module dialog-opener helpers used inside handlers. These forward to
  // the module-private openers in extension.ts (which read extensionContext +
  // lazily assign pullDialog) — unchanged behavior.
  getPullDialog(): PullDialog | undefined;
  openPushDialog(preselect?: IPushPreselect): PushDialog | undefined;
  openMergeDialog(preselect: { repo: IRepository; sourceBranch: string }): MergeDialog | undefined;
  openRebaseDialog(preselect: IRebaseDialogPreselect): Promise<RebaseDialog | undefined>;
  openNewBranchDialog(preselect: {
    repo: IRepository;
    startPoint?: string;
    defaultName?: string;
  }): NewBranchDialog | undefined;
}
