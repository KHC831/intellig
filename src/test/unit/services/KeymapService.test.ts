import * as assert from 'assert';
import {
  KeymapService,
  getDefaultKeymap,
  getIntelliJKeymap,
  getAllKeymaps,
} from '../../../ui-shell/KeymapService';
import { ConfigurationService } from '../../../config/ConfigurationService';
import { KeymapPreset, IKeybinding } from '../../../ui-shell/interfaces/IKeymapService';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

describe('KeymapService', () => {
  let configService: ConfigurationService;
  let keymapService: KeymapService;

  beforeEach(() => {
    resetMockConfiguration();
    configService = new ConfigurationService();
    keymapService = new KeymapService(configService);
  });

  afterEach(() => {
    keymapService.dispose();
    configService.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(keymapService);
    });

    it('should have onDidChangeKeymap event', () => {
      assert.ok(keymapService.onDidChangeKeymap);
    });

    it('should initialize with default keymap when useIntelliJKeymap is false', () => {
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });

    it('should initialize with intellij keymap when useIntelliJKeymap is true (legacy fallback)', () => {
      // Set up configuration before creating service. Wave 135 R4 / M3
      // policy A: legacy boolean only takes effect when keymapPreset is
      // undefined (schema default never explicitly set). The mock
      // initialiser persists 'default' as an explicit value, so clear
      // it to exercise the legacy-fallback path.
      setMockConfigValue('intellig', 'keymapPreset', undefined);
      setMockConfigValue('intellig', 'useIntelliJKeymap', true);
      const newConfigService = new ConfigurationService();
      const newKeymapService = new KeymapService(newConfigService);

      assert.strictEqual(newKeymapService.getCurrentKeymap(), 'intellij');

      newKeymapService.dispose();
      newConfigService.dispose();
    });
  });

  describe('getCurrentKeymap', () => {
    it('should return "default" when useIntelliJKeymap is false', () => {
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });

    it('should return "intellij" when useIntelliJKeymap is true (legacy fallback)', () => {
      // See policy-A note above; clearing keymapPreset enables the
      // legacy fallback path.
      setMockConfigValue('intellig', 'keymapPreset', undefined);
      setMockConfigValue('intellig', 'useIntelliJKeymap', true);
      const newConfigService = new ConfigurationService();
      const newKeymapService = new KeymapService(newConfigService);

      assert.strictEqual(newKeymapService.getCurrentKeymap(), 'intellij');

      newKeymapService.dispose();
      newConfigService.dispose();
    });
  });

  describe('getKeymapDefinition', () => {
    it('should return a keymap definition object', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.ok(keymap);
      assert.strictEqual(typeof keymap, 'object');
    });

    it('should return keymap with name property', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.ok(keymap.name);
      assert.ok(['default', 'intellij'].includes(keymap.name));
    });

    it('should return keymap with displayName property', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.ok(keymap.displayName);
      assert.strictEqual(typeof keymap.displayName, 'string');
    });

    it('should return keymap with keybindings array', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.ok(Array.isArray(keymap.keybindings));
      assert.ok(keymap.keybindings.length > 0);
    });

    it('should return default keymap when useIntelliJKeymap is false', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.strictEqual(keymap.name, 'default');
      assert.strictEqual(keymap.displayName, 'Default');
    });
  });

  describe('getKeymapDefinitionForPreset', () => {
    it('should return default keymap for "default" preset', () => {
      const keymap = keymapService.getKeymapDefinitionForPreset('default');
      assert.strictEqual(keymap.name, 'default');
      assert.strictEqual(keymap.displayName, 'Default');
    });

    it('should return intellij keymap for "intellij" preset', () => {
      const keymap = keymapService.getKeymapDefinitionForPreset('intellij');
      assert.strictEqual(keymap.name, 'intellij');
      assert.strictEqual(keymap.displayName, 'IntelliJ IDEA');
    });

    it('should return default keymap for unknown preset', () => {
      const keymap = keymapService.getKeymapDefinitionForPreset('unknown' as KeymapPreset);
      assert.strictEqual(keymap.name, 'default');
    });
  });

  describe('getAvailablePresets', () => {
    it('should return an array of presets', () => {
      const presets = keymapService.getAvailablePresets();
      assert.ok(Array.isArray(presets));
    });

    it('should include "default" preset', () => {
      const presets = keymapService.getAvailablePresets();
      assert.ok(presets.includes('default'));
    });

    it('should include "intellij" preset', () => {
      const presets = keymapService.getAvailablePresets();
      assert.ok(presets.includes('intellij'));
    });

    it('should return exactly 2 presets', () => {
      const presets = keymapService.getAvailablePresets();
      assert.strictEqual(presets.length, 2);
    });
  });

  describe('getKeybindingForCommand', () => {
    it('should return keybinding for existing command', () => {
      const keybinding = keymapService.getKeybindingForCommand('intellig.commit');
      assert.ok(keybinding);
      assert.strictEqual(keybinding.command, 'intellig.commit');
    });

    it('should return undefined for non-existing command', () => {
      const keybinding = keymapService.getKeybindingForCommand('non-existing-command');
      assert.strictEqual(keybinding, undefined);
    });

    it('should return keybinding with key property', () => {
      const keybinding = keymapService.getKeybindingForCommand('intellig.commit');
      assert.ok(keybinding);
      assert.ok(keybinding.key);
      assert.strictEqual(typeof keybinding.key, 'string');
    });

    it('should return keybinding with mac property for commit command', () => {
      const keybinding = keymapService.getKeybindingForCommand('intellig.commit');
      assert.ok(keybinding);
      assert.ok(keybinding.mac);
      assert.strictEqual(typeof keybinding.mac, 'string');
    });
  });

  describe('isIntelliJKeymapActive', () => {
    it('should return false when default keymap is active', () => {
      assert.strictEqual(keymapService.isIntelliJKeymapActive(), false);
    });

    it('should return true when intellij keymap is active (legacy fallback)', () => {
      // Wave 135 R4 / M3 policy A: clear keymapPreset to exercise
      // the legacy-fallback path; otherwise the mock's explicit
      // 'default' wins over the legacy boolean.
      setMockConfigValue('intellig', 'keymapPreset', undefined);
      setMockConfigValue('intellig', 'useIntelliJKeymap', true);
      const newConfigService = new ConfigurationService();
      const newKeymapService = new KeymapService(newConfigService);

      assert.strictEqual(newKeymapService.isIntelliJKeymapActive(), true);

      newKeymapService.dispose();
      newConfigService.dispose();
    });
  });

  describe('onDidChangeKeymap', () => {
    it('should be an event', () => {
      assert.ok(keymapService.onDidChangeKeymap);
      assert.strictEqual(typeof keymapService.onDidChangeKeymap, 'function');
    });

    it('should allow subscribing to keymap changes', () => {
      const disposable = keymapService.onDidChangeKeymap(() => {
        // Event handler
      });

      assert.ok(disposable);
      assert.strictEqual(typeof disposable.dispose, 'function');

      disposable.dispose();
    });
  });

  describe('dispose', () => {
    it('should dispose without error', () => {
      assert.doesNotThrow(() => {
        keymapService.dispose();
      });
    });

    it('should be idempotent', () => {
      assert.doesNotThrow(() => {
        keymapService.dispose();
        keymapService.dispose();
      });
    });
  });
});

describe('getDefaultKeymap', () => {
  it('should return default keymap definition', () => {
    const keymap = getDefaultKeymap();
    assert.ok(keymap);
    assert.strictEqual(keymap.name, 'default');
    assert.strictEqual(keymap.displayName, 'Default');
  });

  it('should return keymap with keybindings', () => {
    const keymap = getDefaultKeymap();
    assert.ok(Array.isArray(keymap.keybindings));
    assert.ok(keymap.keybindings.length > 0);
  });

  it('should include commit keybinding', () => {
    const keymap = getDefaultKeymap();
    const commitBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.commit'
    );
    assert.ok(commitBinding);
    assert.strictEqual(commitBinding.key, 'ctrl+k');
    assert.strictEqual(commitBinding.mac, 'cmd+k');
  });

  it('should include push keybinding', () => {
    const keymap = getDefaultKeymap();
    const pushBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.push'
    );
    assert.ok(pushBinding);
    assert.strictEqual(pushBinding.key, 'ctrl+shift+k');
    assert.strictEqual(pushBinding.mac, 'cmd+shift+k');
  });

  it('should include pull keybinding', () => {
    const keymap = getDefaultKeymap();
    const pullBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.pull'
    );
    assert.ok(pullBinding);
    assert.strictEqual(pullBinding.key, 'ctrl+t');
    assert.strictEqual(pullBinding.mac, 'cmd+t');
  });

  it('should return a copy (not the same reference)', () => {
    const keymap1 = getDefaultKeymap();
    const keymap2 = getDefaultKeymap();
    assert.notStrictEqual(keymap1, keymap2);
    assert.notStrictEqual(keymap1.keybindings, keymap2.keybindings);
  });
});

describe('getIntelliJKeymap', () => {
  it('should return intellij keymap definition', () => {
    const keymap = getIntelliJKeymap();
    assert.ok(keymap);
    assert.strictEqual(keymap.name, 'intellij');
    assert.strictEqual(keymap.displayName, 'IntelliJ IDEA');
  });

  it('should return keymap with keybindings', () => {
    const keymap = getIntelliJKeymap();
    assert.ok(Array.isArray(keymap.keybindings));
    assert.ok(keymap.keybindings.length > 0);
  });

  it('should include VCS Operations Popup keybinding with Alt+`', () => {
    const keymap = getIntelliJKeymap();
    const vcsPopupBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.showBranchPopup'
    );
    assert.ok(vcsPopupBinding);
    assert.strictEqual(vcsPopupBinding.key, 'alt+`');
  });

  it('should include Annotate (Blame) keybinding with Ctrl+Alt+Shift+A', () => {
    const keymap = getIntelliJKeymap();
    const blameBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.toggleBlame'
    );
    assert.ok(blameBinding);
    assert.strictEqual(blameBinding.key, 'ctrl+alt+shift+a');
  });

  it('should include Show History keybinding with Ctrl+H', () => {
    const keymap = getIntelliJKeymap();
    const historyBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.showHistory'
    );
    assert.ok(historyBinding);
    assert.strictEqual(historyBinding.key, 'ctrl+h');
  });

  it('should include Compare with Branch keybinding with Ctrl+D', () => {
    const keymap = getIntelliJKeymap();
    const compareBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.branch.compareWithCurrent'
    );
    assert.ok(compareBinding);
    assert.strictEqual(compareBinding.key, 'ctrl+d');
  });

  it('should include Rollback (Revert) keybinding with Ctrl+Alt+Z', () => {
    const keymap = getIntelliJKeymap();
    const revertBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.revertFile'
    );
    assert.ok(revertBinding);
    assert.strictEqual(revertBinding.key, 'ctrl+alt+z');
  });

  it('should return a copy (not the same reference)', () => {
    const keymap1 = getIntelliJKeymap();
    const keymap2 = getIntelliJKeymap();
    assert.notStrictEqual(keymap1, keymap2);
    assert.notStrictEqual(keymap1.keybindings, keymap2.keybindings);
  });
});

describe('getAllKeymaps', () => {
  it('should return an array of keymaps', () => {
    const keymaps = getAllKeymaps();
    assert.ok(Array.isArray(keymaps));
  });

  it('should return exactly 2 keymaps', () => {
    const keymaps = getAllKeymaps();
    assert.strictEqual(keymaps.length, 2);
  });

  it('should include default keymap', () => {
    const keymaps = getAllKeymaps();
    const defaultKeymap = keymaps.find((km) => km.name === 'default');
    assert.ok(defaultKeymap);
  });

  it('should include intellij keymap', () => {
    const keymaps = getAllKeymaps();
    const intellijKeymap = keymaps.find((km) => km.name === 'intellij');
    assert.ok(intellijKeymap);
  });

  it('should return copies (not the same references)', () => {
    const keymaps1 = getAllKeymaps();
    const keymaps2 = getAllKeymaps();
    assert.notStrictEqual(keymaps1, keymaps2);
    assert.notStrictEqual(keymaps1[0], keymaps2[0]);
  });
});

describe('IntelliJ Keymap Keybindings', () => {
  it('should have same commit keybinding as default (Ctrl+K)', () => {
    const defaultKeymap = getDefaultKeymap();
    const intellijKeymap = getIntelliJKeymap();

    const defaultCommit = defaultKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.commit'
    );
    const intellijCommit = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.commit'
    );

    assert.ok(defaultCommit);
    assert.ok(intellijCommit);
    assert.strictEqual(defaultCommit.key, intellijCommit.key);
  });

  it('should have same push keybinding as default (Ctrl+Shift+K)', () => {
    const defaultKeymap = getDefaultKeymap();
    const intellijKeymap = getIntelliJKeymap();

    const defaultPush = defaultKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.push'
    );
    const intellijPush = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.push'
    );

    assert.ok(defaultPush);
    assert.ok(intellijPush);
    assert.strictEqual(defaultPush.key, intellijPush.key);
  });

  it('should have same pull keybinding as default (Ctrl+T)', () => {
    const defaultKeymap = getDefaultKeymap();
    const intellijKeymap = getIntelliJKeymap();

    const defaultPull = defaultKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.pull'
    );
    const intellijPull = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.pull'
    );

    assert.ok(defaultPull);
    assert.ok(intellijPull);
    assert.strictEqual(defaultPull.key, intellijPull.key);
  });

  it('should have different branch popup keybinding (Alt+` vs Ctrl+Shift+`)', () => {
    const defaultKeymap = getDefaultKeymap();
    const intellijKeymap = getIntelliJKeymap();

    const defaultPopup = defaultKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.showBranchPopup'
    );
    const intellijPopup = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.showBranchPopup'
    );

    assert.ok(defaultPopup);
    assert.ok(intellijPopup);
    assert.strictEqual(defaultPopup.key, 'ctrl+shift+`');
    assert.strictEqual(intellijPopup.key, 'alt+`');
  });
});
