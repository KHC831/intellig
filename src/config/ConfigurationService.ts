import * as vscode from 'vscode';
import { IConfigurationService, IExtensionConfiguration } from './interfaces/IConfigurationService';
import {
  readConfig,
  inspectConfig,
  updateConfig,
  type ConfigKey,
  type ConfigValues,
} from './configKeys';
import { getLogger, type Logger } from '../utils/logger';

/**
 * Configuration namespace for the extension settings
 */
const CONFIGURATION_SECTION = 'intellig';

/**
 * Map each snapshot field to its `intellig.*` setting name. All but the two
 * `log.*` fields share their name with the setting; the switch is the sole
 * translation point (and a compile-time guard — a new IExtensionConfiguration
 * field that is not a ConfigKey fails the `default` branch).
 */
function settingNameOf(key: keyof IExtensionConfiguration): ConfigKey {
  switch (key) {
    case 'logLevel':
      return 'log.level';
    case 'logConsole':
      return 'log.console';
    default:
      return key;
  }
}

/**
 * Configuration Service implementation.
 * Manages extension settings with support for workspace-specific overrides.
 */
export class ConfigurationService implements IConfigurationService {
  private _onDidChangeConfiguration: vscode.EventEmitter<IExtensionConfiguration>;
  private _disposables: vscode.Disposable[] = [];
  private _cachedConfiguration: IExtensionConfiguration | undefined;
  /**
   * Component-bound Logger used to emit a debug-level record naming
   * the changed `intellig.*` keys on every configuration change.
   * Only key names are logged — never values — because user-set
   * values may contain sensitive content (commit-message templates,
   * file colours, etc.).
   */
  private readonly _logger: Logger;

  /**
   * Event fired when configuration changes
   */
  readonly onDidChangeConfiguration: vscode.Event<IExtensionConfiguration>;

  constructor() {
    this._onDidChangeConfiguration = new vscode.EventEmitter<IExtensionConfiguration>();
    this.onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    this._logger = getLogger().child({ component: 'ConfigurationService' });

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
   * Typed delegate to `inspectConfig` from the config seam. Lets migrations and
   * services distinguish "user wrote at user scope" / "user wrote at workspace
   * scope" / "schema default" without bypassing this service.
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
    const inspected = inspectConfig(settingNameOf(key));
    if (!inspected) {
      return undefined;
    }
    return {
      globalValue: inspected.globalValue as IExtensionConfiguration[K],
      workspaceValue: inspected.workspaceValue as IExtensionConfiguration[K],
      defaultValue: inspected.defaultValue as IExtensionConfiguration[K],
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
    await updateConfig(settingNameOf(key), value as ConfigValues[ConfigKey], target);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeConfiguration.dispose();
    this._disposables.forEach((d) => {
      d.dispose();
    });
    this._disposables = [];
    this._cachedConfiguration = undefined;
  }

  /**
   * Load configuration from VS Code settings via the typed config seam.
   * Workspace-specific settings automatically override user settings through
   * VS Code's configuration API; unset keys resolve to the schema default.
   *
   * @returns The loaded configuration
   */
  private loadConfiguration(): IExtensionConfiguration {
    return {
      // Pull settings
      pullRebase: readConfig('pullRebase'),
      autoFetchEnabled: readConfig('autoFetchEnabled'),
      autoFetchInterval: readConfig('autoFetchInterval'),

      // UI settings
      blameAnnotationStyle: readConfig('blameAnnotationStyle'),

      // Keyboard shortcuts
      keymapPreset: readConfig('keymapPreset'),

      // Logging settings. The Logger's own `LogLevelResolver` reads these
      // settings directly (via the same seam) to avoid a bootstrap circular —
      // the Logger must be ready before `ConfigurationService` is constructed.
      // This typed projection exists so other services that consume
      // `IConfigurationService` see the same schema as everything else and so
      // the change-event diff in `handleConfigurationChange` can name the
      // changed log keys.
      logLevel: readConfig('log.level'),
      logConsole: readConfig('log.console'),
    };
  }

  /**
   * Handle configuration change events.
   * Invalidates the cache and fires the change event.
   *
   * Emit one debug-level Logger record naming the
   * `intellig.*` keys whose effective values changed in this
   * snapshot. Values are deliberately omitted —
   * settings such as `commitAuthor` may contain user content
   * and are not safe to log unconditionally. Computing the diff here
   * (rather than re-deriving it from `e.affectsConfiguration` per
   * key) ensures the record reflects the *effective* change at the
   * typed-projection layer, not just the raw section-affects flag.
   */
  private handleConfigurationChange(): void {
    const oldConfig = this._cachedConfiguration;
    this._cachedConfiguration = this.loadConfiguration();

    // Diff old vs new typed snapshots to compute the changed keys. We iterate
    // the freshly-built snapshot's keys so the set is fixed and exhaustive even
    // when `oldConfig` is undefined (first-time path).
    const snapshotKeys = Object.keys(
      this._cachedConfiguration
    ) as (keyof IExtensionConfiguration)[];
    const changedKeys: (keyof IExtensionConfiguration)[] = [];
    if (oldConfig === undefined) {
      // No prior snapshot — treat every key as "changed" so the log
      // record still names the surface that just became observable.
      for (const k of snapshotKeys) {
        changedKeys.push(k);
      }
    } else {
      for (const k of snapshotKeys) {
        if (oldConfig[k] !== this._cachedConfiguration[k]) {
          changedKeys.push(k);
        }
      }
    }

    // Only fire event if configuration actually changed
    if (!this.configurationEquals(oldConfig, this._cachedConfiguration)) {
      // Emit a debug record with ONLY the changed key names — never
      // the values.
      this._logger.debug('intellig configuration changed', { keys: changedKeys });
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

    const keys = Object.keys(b) as (keyof IExtensionConfiguration)[];
    return keys.every((key) => a[key] === b[key]);
  }
}

/**
 * Get the default configuration values (schema defaults, read once from the
 * registered settings schema). Useful for testing and resetting to defaults.
 *
 * @returns The default configuration
 */
export function getDefaultConfiguration(): IExtensionConfiguration {
  const schemaDefault = <K extends ConfigKey>(key: K): ConfigValues[K] =>
    inspectConfig(key)?.defaultValue as ConfigValues[K];
  return {
    pullRebase: schemaDefault('pullRebase'),
    autoFetchEnabled: schemaDefault('autoFetchEnabled'),
    autoFetchInterval: schemaDefault('autoFetchInterval'),
    blameAnnotationStyle: schemaDefault('blameAnnotationStyle'),
    keymapPreset: schemaDefault('keymapPreset'),
    logLevel: schemaDefault('log.level'),
    logConsole: schemaDefault('log.console'),
  };
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
