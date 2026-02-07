import * as assert from 'assert';
import {
  ConfigurationService,
  getDefaultConfiguration,
  getConfigurationSection,
} from '../../../services/ConfigurationService';
import { IExtensionConfiguration } from '../../../services/interfaces/IConfigurationService';

describe('ConfigurationService', () => {
  let service: ConfigurationService;

  beforeEach(() => {
    service = new ConfigurationService();
  });

  afterEach(() => {
    service.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(service);
    });

    it('should have onDidChangeConfiguration event', () => {
      assert.ok(service.onDidChangeConfiguration);
    });
  });

  describe('getConfiguration', () => {
    it('should return a configuration object', () => {
      const config = service.getConfiguration();
      assert.ok(config);
      assert.strictEqual(typeof config, 'object');
    });

    it('should return all expected configuration keys', () => {
      const config = service.getConfiguration();
      const expectedKeys: (keyof IExtensionConfiguration)[] = [
        'defaultCommitSignOff',
        'commitMessageTemplate',
        'pullRebase',
        'autoFetchEnabled',
        'autoFetchInterval',
        'defaultToolWindowTab',
        'blameAnnotationStyle',
        'showStatusBarBranch',
        'useIntelliJKeymap',
        'modifiedFileColor',
        'addedFileColor',
        'deletedFileColor',
        'ignoredFileColor',
        'conflictFileColor',
      ];

      for (const key of expectedKeys) {
        assert.ok(key in config, `Missing key: ${key}`);
      }
    });

    it('should return a copy of the configuration (not the same reference)', () => {
      const config1 = service.getConfiguration();
      const config2 = service.getConfiguration();
      assert.notStrictEqual(config1, config2);
    });
  });

  describe('get', () => {
    it('should return boolean values for boolean settings', () => {
      const defaultCommitSignOff = service.get('defaultCommitSignOff');
      assert.strictEqual(typeof defaultCommitSignOff, 'boolean');

      const pullRebase = service.get('pullRebase');
      assert.strictEqual(typeof pullRebase, 'boolean');

      const autoFetchEnabled = service.get('autoFetchEnabled');
      assert.strictEqual(typeof autoFetchEnabled, 'boolean');

      const showStatusBarBranch = service.get('showStatusBarBranch');
      assert.strictEqual(typeof showStatusBarBranch, 'boolean');

      const useIntelliJKeymap = service.get('useIntelliJKeymap');
      assert.strictEqual(typeof useIntelliJKeymap, 'boolean');
    });

    it('should return string values for string settings', () => {
      const commitMessageTemplate = service.get('commitMessageTemplate');
      assert.strictEqual(typeof commitMessageTemplate, 'string');

      const modifiedFileColor = service.get('modifiedFileColor');
      assert.strictEqual(typeof modifiedFileColor, 'string');

      const addedFileColor = service.get('addedFileColor');
      assert.strictEqual(typeof addedFileColor, 'string');

      const deletedFileColor = service.get('deletedFileColor');
      assert.strictEqual(typeof deletedFileColor, 'string');

      const ignoredFileColor = service.get('ignoredFileColor');
      assert.strictEqual(typeof ignoredFileColor, 'string');

      const conflictFileColor = service.get('conflictFileColor');
      assert.strictEqual(typeof conflictFileColor, 'string');
    });

    it('should return number values for number settings', () => {
      const autoFetchInterval = service.get('autoFetchInterval');
      assert.strictEqual(typeof autoFetchInterval, 'number');
    });

    it('should return valid enum values for enum settings', () => {
      const defaultToolWindowTab = service.get('defaultToolWindowTab');
      assert.ok(
        ['local-changes', 'log', 'console'].includes(defaultToolWindowTab),
        `Invalid defaultToolWindowTab: ${defaultToolWindowTab}`
      );

      const blameAnnotationStyle = service.get('blameAnnotationStyle');
      assert.ok(
        ['inline', 'gutter', 'both'].includes(blameAnnotationStyle),
        `Invalid blameAnnotationStyle: ${blameAnnotationStyle}`
      );
    });
  });

  describe('update', () => {
    it('should be a function', () => {
      assert.strictEqual(typeof service.update, 'function');
    });

    it('should return a promise', () => {
      // Note: This test may fail in a non-VS Code environment
      // because vscode.workspace.getConfiguration is not available
      // In a real VS Code test environment, this would work
      const result = service.update('defaultCommitSignOff', true);
      assert.ok(result instanceof Promise);
    });
  });

  describe('dispose', () => {
    it('should dispose without error', () => {
      assert.doesNotThrow(() => {
        service.dispose();
      });
    });

    it('should be idempotent', () => {
      assert.doesNotThrow(() => {
        service.dispose();
        service.dispose();
      });
    });
  });

  describe('onDidChangeConfiguration', () => {
    it('should be an event', () => {
      assert.ok(service.onDidChangeConfiguration);
      assert.strictEqual(typeof service.onDidChangeConfiguration, 'function');
    });

    it('should allow subscribing to configuration changes', () => {
      const disposable = service.onDidChangeConfiguration(() => {
        // Event handler - would be called when configuration changes
      });

      assert.ok(disposable);
      assert.strictEqual(typeof disposable.dispose, 'function');

      // Clean up
      disposable.dispose();
    });
  });
});

describe('getDefaultConfiguration', () => {
  it('should return default configuration values', () => {
    const defaults = getDefaultConfiguration();
    assert.ok(defaults);
    assert.strictEqual(typeof defaults, 'object');
  });

  it('should return expected default values', () => {
    const defaults = getDefaultConfiguration();

    // Commit settings
    assert.strictEqual(defaults.defaultCommitSignOff, false);
    assert.strictEqual(defaults.commitMessageTemplate, '');

    // Pull settings
    assert.strictEqual(defaults.pullRebase, false);
    assert.strictEqual(defaults.autoFetchEnabled, true);
    assert.strictEqual(defaults.autoFetchInterval, 180);

    // UI settings
    assert.strictEqual(defaults.defaultToolWindowTab, 'local-changes');
    assert.strictEqual(defaults.blameAnnotationStyle, 'inline');
    assert.strictEqual(defaults.showStatusBarBranch, true);

    // Keyboard shortcuts
    assert.strictEqual(defaults.useIntelliJKeymap, false);

    // Colors (IntelliJ-style)
    assert.strictEqual(defaults.modifiedFileColor, '#6897BB');
    assert.strictEqual(defaults.addedFileColor, '#629755');
    assert.strictEqual(defaults.deletedFileColor, '#6C6C6C');
    assert.strictEqual(defaults.ignoredFileColor, '#848504');
    assert.strictEqual(defaults.conflictFileColor, '#FF0000');
  });

  it('should return a copy (not the same reference)', () => {
    const defaults1 = getDefaultConfiguration();
    const defaults2 = getDefaultConfiguration();
    assert.notStrictEqual(defaults1, defaults2);
  });
});

describe('getConfigurationSection', () => {
  it('should return the configuration section name', () => {
    const section = getConfigurationSection();
    assert.strictEqual(section, 'intellij-git');
  });
});
