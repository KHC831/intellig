import * as vscode from 'vscode';

/**
 * Git Tool Window tab types
 */
export type GitToolWindowTab = 'local-changes' | 'log' | 'console';

/**
 * Blame annotation style options
 */
export type BlameAnnotationStyle = 'inline' | 'gutter' | 'both';

/**
 * Extension configuration model
 */
export interface IExtensionConfiguration {
  // Commit settings
  defaultCommitSignOff: boolean;
  commitMessageTemplate: string;

  // Pull settings
  pullRebase: boolean;
  autoFetchEnabled: boolean;
  autoFetchInterval: number;

  // UI settings
  defaultToolWindowTab: GitToolWindowTab;
  blameAnnotationStyle: BlameAnnotationStyle;
  showStatusBarBranch: boolean;

  // Keyboard shortcuts
  useIntelliJKeymap: boolean;

  // Colors
  modifiedFileColor: string;
  addedFileColor: string;
  deletedFileColor: string;
  ignoredFileColor: string;
  conflictFileColor: string;
}

/**
 * Configuration Service interface for managing extension settings.
 */
export interface IConfigurationService {
  /**
   * Get the current configuration
   */
  getConfiguration(): IExtensionConfiguration;

  /**
   * Get a specific configuration value
   */
  get<K extends keyof IExtensionConfiguration>(key: K): IExtensionConfiguration[K];

  /**
   * Update a configuration value
   */
  update<K extends keyof IExtensionConfiguration>(
    key: K,
    value: IExtensionConfiguration[K],
    target?: vscode.ConfigurationTarget
  ): Promise<void>;

  /**
   * Event fired when configuration changes
   */
  onDidChangeConfiguration: vscode.Event<IExtensionConfiguration>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
