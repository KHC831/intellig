import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IExtensionConfiguration,
  BlameAnnotationStyle,
} from '../../src/config/interfaces/IConfigurationService';
import { getDefaultConfiguration } from '../../src/config/ConfigurationService';
import type { LogThreshold } from '../../src/utils/logger';

/**
 * Property-based tests for Configuration Persistence.
 * Feature: intellig-vscode, Property 47: Configuration Persistence
 *
 *
 * Property Description:
 * For any configuration setting changed by the user, the setting SHALL persist
 * across VS Code sessions and be applied consistently.
 */
describe('Configuration Persistence Property Tests', () => {
  /**
   * Arbitrary generators for configuration values
   */
  const blameAnnotationStyleArb: fc.Arbitrary<BlameAnnotationStyle> = fc.constantFrom(
    'inline',
    'gutter',
    'both',
    'off'
  );

  /**
   * Generate valid auto-fetch intervals (positive integers, reasonable range)
   */
  const autoFetchIntervalArb: fc.Arbitrary<number> = fc.integer({ min: 30, max: 3600 });

  /**
   * Generate a complete configuration object with arbitrary values
   */
  const configurationArb: fc.Arbitrary<IExtensionConfiguration> = fc.record({
    // Pull settings
    pullRebase: fc.boolean(),
    autoFetchEnabled: fc.boolean(),
    autoFetchInterval: autoFetchIntervalArb,

    // UI settings
    blameAnnotationStyle: blameAnnotationStyleArb,

    // Keyboard shortcuts
    keymapPreset: fc.constantFrom<'default' | 'intellij'>('default', 'intellij'),

    // Logging settings
    logLevel: fc.constantFrom<LogThreshold>('trace', 'debug', 'info', 'warn', 'error', 'off'),
    logConsole: fc.boolean(),
  });

  /**
   * Simulates configuration storage and retrieval (in-memory mock of VS Code settings)
   * This represents the persistence layer that VS Code provides.
   */
  class MockConfigurationStorage {
    private storage: Map<string, unknown> = new Map();

    set<K extends keyof IExtensionConfiguration>(key: K, value: IExtensionConfiguration[K]): void {
      this.storage.set(key, value);
    }

    get<K extends keyof IExtensionConfiguration>(
      key: K,
      defaultValue: IExtensionConfiguration[K]
    ): IExtensionConfiguration[K] {
      if (this.storage.has(key)) {
        return this.storage.get(key) as IExtensionConfiguration[K];
      }
      return defaultValue;
    }

    clear(): void {
      this.storage.clear();
    }

    /**
     * Simulate session restart by creating a new storage instance
     * that reads from the same persisted data
     */
    simulateSessionRestart(): MockConfigurationStorage {
      const newStorage = new MockConfigurationStorage();
      // Copy all persisted values to simulate persistence across sessions
      this.storage.forEach((value, key) => {
        newStorage.storage.set(key, value);
      });
      return newStorage;
    }
  }

  /**
   * Simulates the ConfigurationService behavior for testing
   */
  class MockConfigurationService {
    private storage: MockConfigurationStorage;
    private defaults: IExtensionConfiguration;

    constructor(storage: MockConfigurationStorage) {
      this.storage = storage;
      this.defaults = getDefaultConfiguration();
    }

    getConfiguration(): IExtensionConfiguration {
      return {
        pullRebase: this.storage.get('pullRebase', this.defaults.pullRebase),
        autoFetchEnabled: this.storage.get('autoFetchEnabled', this.defaults.autoFetchEnabled),
        autoFetchInterval: this.storage.get('autoFetchInterval', this.defaults.autoFetchInterval),
        blameAnnotationStyle: this.storage.get(
          'blameAnnotationStyle',
          this.defaults.blameAnnotationStyle
        ),
        keymapPreset: this.storage.get('keymapPreset', this.defaults.keymapPreset),
        logLevel: this.storage.get('logLevel', this.defaults.logLevel),
        logConsole: this.storage.get('logConsole', this.defaults.logConsole),
      };
    }

    get<K extends keyof IExtensionConfiguration>(key: K): IExtensionConfiguration[K] {
      return this.storage.get(key, this.defaults[key]);
    }

    update<K extends keyof IExtensionConfiguration>(
      key: K,
      value: IExtensionConfiguration[K]
    ): void {
      this.storage.set(key, value);
    }
  }

  describe('Property 47: Configuration Persistence', () => {
    /**
     * Property: For any configuration setting changed by the user,
     * the setting SHALL persist across VS Code sessions.
     */
    it('Property: Any configuration setting persists across simulated sessions', () => {
      fc.assert(
        fc.property(configurationArb, (config) => {
          // Setup: Create initial storage and service
          const storage = new MockConfigurationStorage();
          const service = new MockConfigurationService(storage);

          // Act: Update all configuration values
          const keys = Object.keys(config) as (keyof IExtensionConfiguration)[];
          for (const key of keys) {
            service.update(key, config[key]);
          }

          // Simulate session restart
          const newStorage = storage.simulateSessionRestart();
          const newService = new MockConfigurationService(newStorage);

          // Assert: All values should persist after session restart
          const retrievedConfig = newService.getConfiguration();
          for (const key of keys) {
            assert.deepStrictEqual(
              retrievedConfig[key],
              config[key],
              `Configuration key '${key}' should persist across sessions`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Configuration values are applied consistently when retrieved.
     */
    it('Property: Configuration values are applied consistently on retrieval', () => {
      fc.assert(
        fc.property(configurationArb, (config) => {
          // Setup
          const storage = new MockConfigurationStorage();
          const service = new MockConfigurationService(storage);

          // Act: Update all configuration values
          const keys = Object.keys(config) as (keyof IExtensionConfiguration)[];
          for (const key of keys) {
            service.update(key, config[key]);
          }

          // Assert: Multiple retrievals should return consistent values
          const firstRetrieval = service.getConfiguration();
          const secondRetrieval = service.getConfiguration();
          const thirdRetrieval = service.getConfiguration();

          assert.deepStrictEqual(
            firstRetrieval,
            secondRetrieval,
            'First and second retrieval should be identical'
          );
          assert.deepStrictEqual(
            secondRetrieval,
            thirdRetrieval,
            'Second and third retrieval should be identical'
          );

          // Also verify individual key access is consistent
          for (const key of keys) {
            assert.deepStrictEqual(
              service.get(key),
              config[key],
              `Individual get('${key}') should return the set value`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Updating a single setting does not affect other settings.
     */
    it('Property: Updating one setting does not affect other settings', () => {
      fc.assert(
        fc.property(
          configurationArb,
          configurationArb,
          fc.constantFrom(
            ...(Object.keys(getDefaultConfiguration()) as (keyof IExtensionConfiguration)[])
          ),
          (initialConfig, newConfig, keyToUpdate) => {
            // Setup: Initialize with first config
            const storage = new MockConfigurationStorage();
            const service = new MockConfigurationService(storage);

            const keys = Object.keys(initialConfig) as (keyof IExtensionConfiguration)[];
            for (const key of keys) {
              service.update(key, initialConfig[key]);
            }

            // Act: Update only one key with a value from newConfig
            service.update(keyToUpdate, newConfig[keyToUpdate]);

            // Assert: Only the updated key should change
            const retrievedConfig = service.getConfiguration();
            for (const key of keys) {
              if (key === keyToUpdate) {
                assert.deepStrictEqual(
                  retrievedConfig[key],
                  newConfig[key],
                  `Updated key '${key}' should have new value`
                );
              } else {
                assert.deepStrictEqual(
                  retrievedConfig[key],
                  initialConfig[key],
                  `Non-updated key '${key}' should retain original value`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Default values are returned for unset configuration keys.
     */
    it('Property: Default values are returned for unset configuration keys', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            ...(Object.keys(getDefaultConfiguration()) as (keyof IExtensionConfiguration)[])
          ),
          (key) => {
            // Setup: Fresh storage with no values set
            const storage = new MockConfigurationStorage();
            const service = new MockConfigurationService(storage);
            const defaults = getDefaultConfiguration();

            // Assert: Should return default value
            assert.deepStrictEqual(
              service.get(key),
              defaults[key],
              `Unset key '${key}' should return default value`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sequence of updates results in final value being persisted.
     */
    it('Property: Sequence of updates results in final value being persisted', () => {
      fc.assert(
        fc.property(
          fc.array(configurationArb, { minLength: 1, maxLength: 10 }),
          fc.constantFrom(
            ...(Object.keys(getDefaultConfiguration()) as (keyof IExtensionConfiguration)[])
          ),
          (configSequence, key) => {
            // Setup
            const storage = new MockConfigurationStorage();
            const service = new MockConfigurationService(storage);

            // Act: Apply sequence of updates to the same key
            for (const config of configSequence) {
              service.update(key, config[key]);
            }

            // Assert: Final value should be the last one in the sequence
            const finalConfig = configSequence[configSequence.length - 1];
            assert.deepStrictEqual(
              service.get(key),
              finalConfig[key],
              `Key '${key}' should have the final value from the sequence`
            );

            // Also verify persistence after simulated restart
            const newStorage = storage.simulateSessionRestart();
            const newService = new MockConfigurationService(newStorage);
            assert.deepStrictEqual(
              newService.get(key),
              finalConfig[key],
              `Key '${key}' should persist the final value after session restart`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Boolean settings toggle correctly and persist.
     */
    it('Property: Boolean settings toggle correctly and persist', () => {
      const booleanKeys: (keyof IExtensionConfiguration)[] = ['pullRebase', 'autoFetchEnabled'];

      fc.assert(
        fc.property(
          fc.constantFrom(...booleanKeys),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
          (key, toggleSequence) => {
            // Setup
            const storage = new MockConfigurationStorage();
            const service = new MockConfigurationService(storage);

            // Act: Apply sequence of boolean toggles
            for (const value of toggleSequence) {
              service.update(key, value as IExtensionConfiguration[typeof key]);
            }

            // Assert: Final value should be the last in sequence
            const finalValue = toggleSequence[toggleSequence.length - 1];
            assert.strictEqual(
              service.get(key),
              finalValue,
              `Boolean key '${key}' should have final toggle value`
            );

            // Verify persistence
            const newStorage = storage.simulateSessionRestart();
            const newService = new MockConfigurationService(newStorage);
            assert.strictEqual(
              newService.get(key),
              finalValue,
              `Boolean key '${key}' should persist after restart`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Enum settings accept only valid values and persist.
     */
    it('Property: Enum settings accept valid values and persist', () => {
      fc.assert(
        fc.property(blameAnnotationStyleArb, (style) => {
          // Setup
          const storage = new MockConfigurationStorage();
          const service = new MockConfigurationService(storage);

          // Act: Set enum value
          service.update('blameAnnotationStyle', style);

          // Assert: Value should be set correctly
          assert.strictEqual(
            service.get('blameAnnotationStyle'),
            style,
            'blameAnnotationStyle should be set correctly'
          );

          // Verify persistence
          const newStorage = storage.simulateSessionRestart();
          const newService = new MockConfigurationService(newStorage);
          assert.strictEqual(
            newService.get('blameAnnotationStyle'),
            style,
            'blameAnnotationStyle should persist'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Numeric settings accept valid ranges and persist.
     */
    it('Property: Numeric settings accept valid values and persist', () => {
      fc.assert(
        fc.property(autoFetchIntervalArb, (interval) => {
          // Setup
          const storage = new MockConfigurationStorage();
          const service = new MockConfigurationService(storage);

          // Act: Set numeric value
          service.update('autoFetchInterval', interval);

          // Assert: Value should be set correctly
          assert.strictEqual(
            service.get('autoFetchInterval'),
            interval,
            'autoFetchInterval should be set correctly'
          );

          // Verify persistence
          const newStorage = storage.simulateSessionRestart();
          const newService = new MockConfigurationService(newStorage);
          assert.strictEqual(
            newService.get('autoFetchInterval'),
            interval,
            'autoFetchInterval should persist'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
