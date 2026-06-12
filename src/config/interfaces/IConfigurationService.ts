import * as vscode from 'vscode';

import type { LogThreshold } from '../../utils/logger';

/**
 * Git Tool Window tab types
 */
export type GitToolWindowTab = 'local-changes' | 'log' | 'console';

/**
 * Blame annotation style options
 */
export type BlameAnnotationStyle = 'inline' | 'gutter' | 'both';

/**
 * Keymap preset name. `default` = VS Code-style; `intellij` =
 * IntelliJ IDEA-style. Drives both the in-process KeymapService
 * label and the package.json keybinding `when` clauses.
 */
export type KeymapPresetName = 'default' | 'intellij';

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
  /**
   * @deprecated since 0.1.0. Use `keymapPreset` instead. Read by
   * KeymapService for backward-compat fallback only; will be
   * removed in the same release that drops the schema entry.
   */
  useIntelliJKeymap: boolean;
  /**
   * Successor to `useIntelliJKeymap`. Drives the in-process
   * keymap label AND the package.json keybinding `when` clauses
   * (`config.intellig.keymapPreset == 'intellij'`).
   */
  keymapPreset: KeymapPresetName;

  // Colors
  modifiedFileColor: string;
  addedFileColor: string;
  deletedFileColor: string;
  ignoredFileColor: string;
  conflictFileColor: string;

  // Logging settings (typed projection of `intellig.log.*`)
  /**
   * Minimum severity admitted to the IntelliG logger; records at
   * lower levels are dropped before allocation. Backed by the
   * `intellig.log.level` schema entry. Mirrors the Logger's own
   * `LogLevelResolver` state (which reads `vscode.workspace`
   * directly to avoid the bootstrap circular).
   */
  logLevel: LogThreshold;
  /**
   * When `true`, IntelliG log records are also mirrored to the
   * developer console (visible only in the Extension Development
   * Host). Backed by the `intellig.log.console` schema entry.
   */
  logConsole: boolean;
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
   * Get a specific configuration value. Resolves with workspace >
   * user > schema-default precedence, matching VS Code's effective
   * value. For migrations that need to distinguish "user set
   * explicitly" from "schema default returned," use {@link inspect}.
   */
  get<K extends keyof IExtensionConfiguration>(key: K): IExtensionConfiguration[K];

  /**
   * Inspect a configuration value across scopes. Previously two
   * production sites bypassed this service to call
   * `vscode.workspace.getConfiguration().inspect()` directly because
   * the typed `get()` substitutes schema default and the user-set vs
   * default distinction was lost.
   *
   * Each field is undefined if the user has not explicitly written
   * at that scope. The schema default lives in `defaultValue`. To
   * detect "user explicitly chose value X at any scope," check
   * `workspaceValue ?? globalValue !== undefined` and ignore
   * `defaultValue`.
   */
  inspect<K extends keyof IExtensionConfiguration>(
    key: K
  ):
    | {
        globalValue?: IExtensionConfiguration[K];
        workspaceValue?: IExtensionConfiguration[K];
        defaultValue?: IExtensionConfiguration[K];
      }
    | undefined;

  /**
   * Update a configuration value
   */
  update<K extends keyof IExtensionConfiguration>(
    key: K,
    value: IExtensionConfiguration[K] | undefined,
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
