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

export { GitToolWindowProvider, GIT_TOOL_WINDOW_VIEW_ID } from './GitToolWindowProvider';

export { ConsoleService, createConsoleService } from './ConsoleService';

export { CommitDialog, createCommitDialog } from './CommitDialog';
export type { ICommitDialogOptions, ICommitDialogResult } from './CommitDialog';

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
