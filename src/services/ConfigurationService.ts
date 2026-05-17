/* eslint-disable @typescript-eslint/no-unsafe-return */
import * as vscode from 'vscode';
import {
  IConfigurationService,
  IExtensionConfiguration,
  GitToolWindowTab,
  BlameAnnotationStyle,
  KeymapPresetName,
} from './interfaces/IConfigurationService';

/**
 * Configuration namespace for the extension settings
 */
const CONFIGURATION_SECTION = 'intellig';

/**
 * Default configuration values
 */
const DEFAULT_CONFIGURATION: IExtensionConfiguration = {
  // Commit settings
  defaultCommitSignOff: false,
  commitMessageTemplate: '',

  // Pull settings
  pullRebase: false,
  autoFetchEnabled: true,
  autoFetchInterval: 180,

  // UI settings
  defaultToolWindowTab: 'local-changes',
  blameAnnotationStyle: 'inline',
  showStatusBarBranch: true,

  // Keyboard shortcuts
  useIntelliJKeymap: false,
  keymapPreset: 'default',

  // Colors
  modifiedFileColor: '#6897BB',
  addedFileColor: '#629755',
  deletedFileColor: '#6C6C6C',
  ignoredFileColor: '#848504',
  conflictFileColor: '#FF0000',
};

/**
 * Mapping from configuration keys to VS Code setting names
 */
const CONFIG_KEY_MAP: Record<keyof IExtensionConfiguration, string> = {
  defaultCommitSignOff: 'defaultCommitSignOff',
  commitMessageTemplate: 'commitMessageTemplate',
  pullRebase: 'pullRebase',
  autoFetchEnabled: 'autoFetchEnabled',
  autoFetchInterval: 'autoFetchInterval',
  defaultToolWindowTab: 'defaultToolWindowTab',
  blameAnnotationStyle: 'blameAnnotationStyle',
  showStatusBarBranch: 'showStatusBarBranch',
  useIntelliJKeymap: 'useIntelliJKeymap',
  keymapPreset: 'keymapPreset',
  modifiedFileColor: 'modifiedFileColor',
  addedFileColor: 'addedFileColor',
  deletedFileColor: 'deletedFileColor',
  ignoredFileColor: 'ignoredFileColor',
  conflictFileColor: 'conflictFileColor',
};

/**
 * Configuration Service implementation.
 * Manages extension settings with support for workspace-specific overrides.
 */
export class ConfigurationService implements IConfigurationService {
  private _onDidChangeConfiguration: vscode.EventEmitter<IExtensionConfiguration>;
  private _disposables: vscode.Disposable[] = [];
  private _cachedConfiguration: IExtensionConfiguration | undefined;

  /**
   * Event fired when configuration changes
   */
  readonly onDidChangeConfiguration: vscode.Event<IExtensionConfiguration>;

  constructor() {
    this._onDidChangeConfiguration = new vscode.EventEmitter<IExtensionConfiguration>();
    this.onDidChangeConfiguration = this._onDidChangeConfiguration.event;

    // Register configuration change listener
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIGURATION_SECTION)) {
          this.handleConfigurationChange();
        }
      })
    );

    // Initialize cached configuration
    this._cachedConfiguration = this.loadConfiguration();
  }

  /**
   * Get the current configuration.
   * Returns a snapshot of all configuration values.
   *
   * @returns The current extension configuration
   */
  getConfiguration(): IExtensionConfiguration {
    if (!this._cachedConfiguration) {
      this._cachedConfiguration = this.loadConfiguration();
    }
    return { ...this._cachedConfiguration };
  }

  /**
   * Get a specific configuration value.
   * Provides type-safe access to individual settings.
   *
   * @param key - The configuration key to retrieve
   * @returns The configuration value
   */
  get<K extends keyof IExtensionConfiguration>(key: K): IExtensionConfiguration[K] {
    const config = this.getConfiguration();
    return config[key];
  }

  /**
   * Wave 135 R5 / M1: typed delegate to
   * `vscode.workspace.getConfiguration('intellig').inspect<T>(key)`.
   * Lets migrations and services distinguish "user wrote at user
   * scope" / "user wrote at workspace scope" / "schema default"
   * without bypassing this service.
   */
  inspect<K extends keyof IExtensionConfiguration>(
    key: K
  ):
    | {
        globalValue?: IExtensionConfiguration[K];
        workspaceValue?: IExtensionConfiguration[K];
        defaultValue?: IExtensionConfiguration[K];
      }
    | undefined {
    const settingName = CONFIG_KEY_MAP[key];
    const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const inspected = config.inspect<IExtensionConfiguration[K]>(settingName);
    if (!inspected) {
      return undefined;
    }
    return {
      globalValue: inspected.globalValue,
      workspaceValue: inspected.workspaceValue,
      defaultValue: inspected.defaultValue,
    };
  }

  /**
   * Update a configuration value.
   * Supports targeting user settings, workspace settings, or workspace folder settings.
   *
   * @param key - The configuration key to update
   * @param value - The new value
   * @param target - The configuration target (defaults to Global/User settings)
   */
  async update<K extends keyof IExtensionConfiguration>(
    key: K,
    value: IExtensionConfiguration[K] | undefined,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    const settingName = CONFIG_KEY_MAP[key];
    const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);

    await config.update(settingName, value, target);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeConfiguration.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
    this._cachedConfiguration = undefined;
  }

  /**
   * Load configuration from VS Code settings.
   * Workspace-specific settings automatically override user settings
   * through VS Code's configuration API.
   *
   * @returns The loaded configuration
   */
  private loadConfiguration(): IExtensionConfiguration {
    const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);

    return {
      // Commit settings
      defaultCommitSignOff: this.getConfigValue(
        config,
        'defaultCommitSignOff',
        DEFAULT_CONFIGURATION.defaultCommitSignOff
      ),
      commitMessageTemplate: this.getConfigValue(
        config,
        'commitMessageTemplate',
        DEFAULT_CONFIGURATION.commitMessageTemplate
      ),

      // Pull settings
      pullRebase: this.getConfigValue(config, 'pullRebase', DEFAULT_CONFIGURATION.pullRebase),
      autoFetchEnabled: this.getConfigValue(
        config,
        'autoFetchEnabled',
        DEFAULT_CONFIGURATION.autoFetchEnabled
      ),
      autoFetchInterval: this.getConfigValue(
        config,
        'autoFetchInterval',
        DEFAULT_CONFIGURATION.autoFetchInterval
      ),

      // UI settings
      defaultToolWindowTab: this.getConfigValue<GitToolWindowTab>(
        config,
        'defaultToolWindowTab',
        DEFAULT_CONFIGURATION.defaultToolWindowTab
      ),
      blameAnnotationStyle: this.getConfigValue<BlameAnnotationStyle>(
        config,
        'blameAnnotationStyle',
        DEFAULT_CONFIGURATION.blameAnnotationStyle
      ),
      showStatusBarBranch: this.getConfigValue(
        config,
        'showStatusBarBranch',
        DEFAULT_CONFIGURATION.showStatusBarBranch
      ),

      // Keyboard shortcuts
      useIntelliJKeymap: this.getConfigValue(
        config,
        'useIntelliJKeymap',
        DEFAULT_CONFIGURATION.useIntelliJKeymap
      ),
      keymapPreset: this.getConfigValue<KeymapPresetName>(
        config,
        'keymapPreset',
        DEFAULT_CONFIGURATION.keymapPreset
      ),

      // Colors
      modifiedFileColor: this.getConfigValue(
        config,
        'modifiedFileColor',
        DEFAULT_CONFIGURATION.modifiedFileColor
      ),
      addedFileColor: this.getConfigValue(
        config,
        'addedFileColor',
        DEFAULT_CONFIGURATION.addedFileColor
      ),
      deletedFileColor: this.getConfigValue(
        config,
        'deletedFileColor',
        DEFAULT_CONFIGURATION.deletedFileColor
      ),
      ignoredFileColor: this.getConfigValue(
        config,
        'ignoredFileColor',
        DEFAULT_CONFIGURATION.ignoredFileColor
      ),
      conflictFileColor: this.getConfigValue(
        config,
        'conflictFileColor',
        DEFAULT_CONFIGURATION.conflictFileColor
      ),
    };
  }

  /**
   * Get a configuration value with type safety and default fallback.
   *
   * @param config - The VS Code configuration object
   * @param key - The setting key
   * @param defaultValue - The default value if not set
   * @returns The configuration value
   */
  private getConfigValue<T>(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultValue: T
  ): T {
    const value = config.get<T>(key);
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Handle configuration change events.
   * Invalidates the cache and fires the change event.
   */
  private handleConfigurationChange(): void {
    const oldConfig = this._cachedConfiguration;
    this._cachedConfiguration = this.loadConfiguration();

    // Only fire event if configuration actually changed
    if (!this.configurationEquals(oldConfig, this._cachedConfiguration)) {
      this._onDidChangeConfiguration.fire(this._cachedConfiguration);
    }
  }

  /**
   * Compare two configuration objects for equality.
   *
   * @param a - First configuration
   * @param b - Second configuration
   * @returns True if configurations are equal
   */
  private configurationEquals(
    a: IExtensionConfiguration | undefined,
    b: IExtensionConfiguration | undefined
  ): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }

    const keys = Object.keys(DEFAULT_CONFIGURATION) as (keyof IExtensionConfiguration)[];
    return keys.every((key) => a[key] === b[key]);
  }
}

/**
 * Get the default configuration values.
 * Useful for testing and resetting to defaults.
 *
 * @returns The default configuration
 */
export function getDefaultConfiguration(): IExtensionConfiguration {
  return { ...DEFAULT_CONFIGURATION };
}

/**
 * Get the configuration section name.
 * Useful for testing and external access.
 *
 * @returns The configuration section name
 */
export function getConfigurationSection(): string {
  return CONFIGURATION_SECTION;
}
