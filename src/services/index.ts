/**
 * Services module for the IntelliG VS Code extension.
 */

// Export all interfaces

export * from './interfaces';
export type { BranchAction, IBranchPopupResult } from '../branches/BranchPopup';
export type { BranchTreeItemType } from '../branches/BranchTreeProvider';
export type {
  CommitToolWindowTab,
  ChangelistAction,
  FileAction,
  ShelfTabFilter,
  IShelfTabEntry,
  IShelfTabShelfController,
  IShelfTabStashController,
  ShelfTabShelfAction,
  ShelfTabStashAction,
  ICommitToolWebviewMessage,
  IRenderInput,
} from '../commits/CommitToolWindow';
export type { ConflictFileStatus } from '../conflicts/ResolveConflictsDialog';
export type { IApplyPatchDialogOptions } from '../patches/ApplyPatchDialog';
export type { IBlameOptionsSnapshot } from '../blame/BlameOptionsSource';
export type {
  ICommitDialogOptions,
  ICommitDialogResult,
  IPerformCommitOptions,
  IPerformCommitResult,
} from '../commits/CommitDialog';
export type {
  IMergeDialogOptions,
  IMergeFlagState,
  MergeStrategyFlag,
} from '../conflicts/MergeDialog';
export type { INewBranchDialogOptions } from '../branches/NewBranchDialog';
export type {
  IPullSourceChoice,
  IRunPullDialogDeps,
  PullDialogOutcome,
  PullFlagKey,
} from '../sync/PullDialog';
export type {
  IPushDialogOptions,
  IPushPreselect,
  IPushOverflowState,
  IPushRow,
  IPushRowError,
  IPushRowResult,
  IRunPushRowDeps,
  PushAction,
  PushErrorKind,
} from '../sync/PushDialog';
export type { IRebaseEditorOptions, IRebaseEditorResult } from '../rebase/RebaseEditor';
export { ApplyPatchDialog, showApplyPatchDialog } from '../patches/ApplyPatchDialog';
export { AutoFetchService, createAutoFetchService } from '../sync/AutoFetchService';
export { BlameOptionsSource } from '../blame/BlameOptionsSource';
export { BlameService, createBlameService } from '../blame/BlameService';
export { BranchComparisonView, createBranchComparisonView } from '../branches/BranchComparisonView';
export { BranchPopup, createBranchPopup } from '../branches/BranchPopup';
export {
  BranchTreeProvider,
  BranchTreeItem,
  createBranchTreeProvider,
  CONTEXT_VALUES,
} from '../branches/BranchTreeProvider';
export { ChangelistService, createChangelistService } from '../changelists/ChangelistService';
export { CommitDialog, createCommitDialog, performCommit } from '../commits/CommitDialog';
export {
  CommitToolWindow,
  createCommitToolWindow,
  isCommitToolWindowEnabled,
  COMMIT_TOOL_WINDOW_VIEW_ID,
  COMMIT_TOOL_WINDOW_CONFIG_KEY,
  ACTIVE_TAB_STATE_KEY as COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY,
  RECENT_MESSAGES_STATE_KEY as COMMIT_TOOL_WINDOW_RECENT_MESSAGES_STATE_KEY,
  RECENT_MESSAGES_MAX as COMMIT_TOOL_WINDOW_RECENT_MESSAGES_MAX,
  SHELF_TAB_FILTER_STATE_KEY as COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY,
  updateRecentMessagesLru,
  sortChangelistsForDisplay,
  fileContextMenuLabels,
  changelistContextMenuLabels,
  gearMenuItems,
  renderCommitToolWindowHtml,
  buildCommitToolWindowBodyParts,
  buildShelfTabEntries,
  isShelfTabFilter,
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
  renderShelfTabPanel,
} from '../commits/CommitToolWindow';
export {
  ConfigurationService,
  getDefaultConfiguration,
  getConfigurationSection,
} from '../config/ConfigurationService';
export {
  ConflictResolutionService,
  createConflictResolutionService,
} from '../conflicts/ConflictResolutionService';
export { ConsoleService, createConsoleService } from '../ui-shell/ConsoleService';
export {
  ExtensionServices,
  IExtensionServices,
  getExtensionServices,
  resetExtensionServices,
} from './ExtensionServices';
export { GitService, createGitService } from '../git-core/GitService';
export { GitToolWindowProvider, GIT_TOOL_WINDOW_VIEW_ID } from '../ui-shell/GitToolWindowProvider';
export { GutterBlameProvider, createGutterBlameProvider } from '../blame/GutterBlameProvider';
export { InlineBlameProvider, createInlineBlameProvider } from '../blame/InlineBlameProvider';
export {
  KeymapService,
  getDefaultKeymap,
  getIntelliJKeymap,
  getAllKeymaps,
} from '../ui-shell/KeymapService';
export { MergeDialog, showMergeDialog, resolveMergeMutex } from '../conflicts/MergeDialog';
export { MergeView, createMergeView } from '../conflicts/MergeView';
export {
  NewBranchDialog,
  showNewBranchDialog,
  validateNewBranchName,
  looksRemoteStartPoint,
} from '../branches/NewBranchDialog';
export { NotificationService, createNotificationService } from '../ui-shell/NotificationService';
export { PatchService, createPatchService, PatchWriteFailed } from '../patches/PatchService';
export { PullDialog, createPullDialog } from '../sync/PullDialog';
export { PushDialog, showPushDialog } from '../sync/PushDialog';
export { RebaseEditor, createRebaseEditor } from '../rebase/RebaseEditor';
export { RebaseProgressView, createRebaseProgressView } from '../rebase/RebaseProgressView';
export { RebaseService, createRebaseService } from '../git-core/RebaseService';
export {
  ResolveConflictsDialog,
  createResolveConflictsDialog,
} from '../conflicts/ResolveConflictsDialog';
export { ShelfService, createShelfService } from '../shelf/ShelfService';
export { ShelfView, createShelfView } from '../shelf/ShelfView';
export { StashView, createStashView } from '../shelf/StashView';
export { StatusBarService, createStatusBarService } from '../ui-shell/StatusBarService';
