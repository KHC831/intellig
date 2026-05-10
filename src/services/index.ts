/**
 * Services module for the IntelliG VS Code extension.
 */

// Export all interfaces
export * from './interfaces';

// Export the services container
export {
  ExtensionServices,
  IExtensionServices,
  getExtensionServices,
  resetExtensionServices,
} from './ExtensionServices';

// Export service implementations
export {
  ConfigurationService,
  getDefaultConfiguration,
  getConfigurationSection,
} from './ConfigurationService';

export { GitService, createGitService } from './GitService';

export { RebaseService, createRebaseService } from './RebaseService';

export { ShelfService, createShelfService } from './ShelfService';

export { ChangelistService, createChangelistService } from './ChangelistService';

export { BlameService, createBlameService } from './BlameService';

export { BlameOptionsSource } from './BlameOptionsSource';
export type { IBlameOptionsSnapshot } from './BlameOptionsSource';

export { GitToolWindowProvider, GIT_TOOL_WINDOW_VIEW_ID } from './GitToolWindowProvider';

export { ConsoleService, createConsoleService } from './ConsoleService';

export { CommitDialog, createCommitDialog, performCommit } from './CommitDialog';
export type {
  ICommitDialogOptions,
  ICommitDialogResult,
  IPerformCommitOptions,
  IPerformCommitResult,
} from './CommitDialog';

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
} from './CommitToolWindow';
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
} from './CommitToolWindow';

export { BranchPopup, createBranchPopup } from './BranchPopup';
export type { BranchAction, IBranchPopupResult } from './BranchPopup';

export {
  BranchTreeProvider,
  BranchTreeItem,
  createBranchTreeProvider,
  CONTEXT_VALUES,
} from './BranchTreeProvider';
export type { BranchTreeItemType } from './BranchTreeProvider';

export { MergeView, createMergeView } from './MergeView';

export {
  ConflictResolutionService,
  createConflictResolutionService,
} from './ConflictResolutionService';

export { ResolveConflictsDialog, createResolveConflictsDialog } from './ResolveConflictsDialog';
export type { ConflictFileStatus } from './ResolveConflictsDialog';

export { RebaseEditor, createRebaseEditor } from './RebaseEditor';
export type { IRebaseEditorOptions, IRebaseEditorResult } from './RebaseEditor';

export { RebaseProgressView, createRebaseProgressView } from './RebaseProgressView';

export { InlineBlameProvider, createInlineBlameProvider } from './InlineBlameProvider';

export { GutterBlameProvider, createGutterBlameProvider } from './GutterBlameProvider';

export { StatusBarService, createStatusBarService } from './StatusBarService';

export { NotificationService, createNotificationService } from './NotificationService';

export { KeymapService, getDefaultKeymap, getIntelliJKeymap, getAllKeymaps } from './KeymapService';

export { StashView, createStashView } from './StashView';

export { ShelfView, createShelfView } from './ShelfView';

export { BranchComparisonView, createBranchComparisonView } from './BranchComparisonView';

export { AutoFetchService, createAutoFetchService } from './AutoFetchService';

export { PullDialog, createPullDialog } from './PullDialog';
export type {
  IPullSourceChoice,
  IRunPullDialogDeps,
  PullDialogOutcome,
  PullFlagKey,
} from './PullDialog';

export { PatchService, createPatchService } from './PatchService';

export { ApplyPatchDialog, showApplyPatchDialog } from './ApplyPatchDialog';
export type { IApplyPatchDialogOptions } from './ApplyPatchDialog';

export { PushDialog, showPushDialog } from './PushDialog';
export type {
  IPushDialogOptions,
  IPushOverflowState,
  IPushRow,
  IPushRowError,
  IPushRowResult,
  IRunPushRowDeps,
  PushAction,
  PushErrorKind,
} from './PushDialog';

export { MergeDialog, showMergeDialog, resolveMergeMutex } from './MergeDialog';
export type { IMergeDialogOptions, IMergeFlagState, MergeStrategyFlag } from './MergeDialog';

export {
  NewBranchDialog,
  showNewBranchDialog,
  validateNewBranchName,
  looksRemoteStartPoint,
} from './NewBranchDialog';
export type { INewBranchDialogOptions } from './NewBranchDialog';
