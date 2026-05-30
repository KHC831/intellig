/**
 * Service interfaces for the IntelliG VS Code extension.
 * These interfaces define the contracts for all core services.
 */

// Git Service
export * from '../../git-core/interfaces/IGitService';

// Changelist Service
export * from '../../changelists/interfaces/IChangelistService';

// Shelf Service
export * from '../../shelf/interfaces/IShelfService';

// Rebase Service
export * from '../../git-core/interfaces/IRebaseService';

// Blame Service
export * from '../../blame/interfaces/IBlameService';

// Configuration Service
export * from '../../config/interfaces/IConfigurationService';

// Git Tool Window Provider
export * from '../../git-core/interfaces/IGitToolWindowProvider';

// Console Service
export * from '../../ui-shell/interfaces/IConsoleService';

// Merge View
export * from '../../conflicts/interfaces/IMergeView';

// Conflict Resolution Service
export * from '../../conflicts/interfaces/IConflictResolutionService';

// Rebase Editor
export * from '../../rebase/interfaces/IRebaseEditor';

// Stash View
export * from '../../shelf/interfaces/IStashView';

// Shelf View
export * from '../../shelf/interfaces/IShelfView';

// Inline Blame Provider
export * from '../../blame/interfaces/IInlineBlameProvider';

// Gutter Blame Provider
export * from '../../blame/interfaces/IGutterBlameProvider';

// Branch Comparison View
export * from '../../branches/interfaces/IBranchComparisonView';

// Status Bar Service
export * from '../../ui-shell/interfaces/IStatusBarService';

// Notification Service
export * from '../../ui-shell/interfaces/INotificationService';

// Keymap Service
export * from '../../ui-shell/interfaces/IKeymapService';

// Auto-Fetch Service
export * from '../../sync/interfaces/IAutoFetchService';

// Patch Service
export * from '../../patches/interfaces/IPatchService';
