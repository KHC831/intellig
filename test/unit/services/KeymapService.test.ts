import * as assert from 'assert';
import {
  KeymapService,
  getDefaultKeymap,
  getIntelliJKeymap,
  getAllKeymaps,
} from '../../../src/ui-shell/KeymapService';
import { ConfigurationService } from '../../../src/config/ConfigurationService';
import { KeymapPreset, IKeybinding } from '../../../src/ui-shell/interfaces/IKeymapService';
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

    it('should initialize with the default keymap when no preset is set', () => {
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });

    it("should initialize with the intellij keymap when keymapPreset='intellij'", () => {
      setMockConfigValue('intellig', 'keymapPreset', 'intellij');
      const newConfigService = new ConfigurationService();
      const newKeymapService = new KeymapService(newConfigService);

      assert.strictEqual(newKeymapService.getCurrentKeymap(), 'intellij');

      newKeymapService.dispose();
      newConfigService.dispose();
    });
  });

  describe('getCurrentKeymap', () => {
    it('should return "default" when no preset is set', () => {
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });

    it('should return "intellij" when keymapPreset=\'intellij\'', () => {
      setMockConfigValue('intellig', 'keymapPreset', 'intellij');
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

    it('should return keymap with an (empty) keybindings array — default preset binds nothing', () => {
      const keymap = keymapService.getKeymapDefinition();
      assert.ok(Array.isArray(keymap.keybindings));
      assert.strictEqual(keymap.keybindings.length, 0);
    });

    it('should return default keymap when no preset is set', () => {
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
    it('returns undefined under the default preset (no IntelliG chords bind)', () => {
      const keybinding = keymapService.getKeybindingForCommand('intellig.commit');
      assert.strictEqual(keybinding, undefined);
    });

    it('should return undefined for non-existing command', () => {
      const keybinding = keymapService.getKeybindingForCommand('non-existing-command');
      assert.strictEqual(keybinding, undefined);
    });

    it('resolves commit with key + mac from the intellij preset definition', () => {
      const keymap = keymapService.getKeymapDefinitionForPreset('intellij');
      const keybinding = keymap.keybindings.find((kb) => kb.command === 'intellig.commit');
      assert.ok(keybinding);
      assert.strictEqual(keybinding.key, 'ctrl+k');
      assert.strictEqual(keybinding.mac, 'cmd+k');
    });
  });

  describe('isIntelliJKeymapActive', () => {
    it('should return false when default keymap is active', () => {
      assert.strictEqual(keymapService.isIntelliJKeymapActive(), false);
    });

    it("should return true when keymapPreset='intellij'", () => {
      setMockConfigValue('intellig', 'keymapPreset', 'intellij');
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

  it('binds NO chords — the default preset promises stock VS Code keybindings', () => {
    const keymap = getDefaultKeymap();
    assert.deepStrictEqual(
      keymap.keybindings,
      [],
      'every IntelliG chord is gated behind the intellij preset'
    );
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
      (kb: IKeybinding) => kb.command === 'intellig.vcsOperationsPopup'
    );
    assert.ok(vcsPopupBinding);
    assert.strictEqual(vcsPopupBinding.key, 'alt+`');
  });

  it('should include Commit and Push keybinding with Ctrl+Alt+K', () => {
    const keymap = getIntelliJKeymap();
    const binding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.commitAndPush'
    );
    assert.ok(binding);
    assert.strictEqual(binding.key, 'ctrl+alt+k');
    assert.strictEqual(binding.mac, 'cmd+alt+k');
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

  it('should bind Ctrl+D to the active-file diff (Diff.ShowDiff class)', () => {
    const keymap = getIntelliJKeymap();
    const compareBinding = keymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.explorer.compareWithRepoVersion'
    );
    assert.ok(compareBinding);
    assert.strictEqual(compareBinding.key, 'ctrl+d');
    assert.ok(
      !keymap.keybindings.some(
        (kb: IKeybinding) => kb.command === 'intellig.branch.compareWithCurrent'
      ),
      'the tree-item compare must not be keyboard-bound (no arg from a keybinding)'
    );
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
  it('carries the core git chords the default preset deliberately omits', () => {
    const intellijKeymap = getIntelliJKeymap();
    const byCommand = new Map(
      intellijKeymap.keybindings.map((kb: IKeybinding) => [kb.command, kb])
    );
    assert.strictEqual(byCommand.get('intellig.commit')?.key, 'ctrl+k');
    assert.strictEqual(byCommand.get('intellig.push')?.key, 'ctrl+shift+k');
    assert.strictEqual(byCommand.get('intellig.updateProject')?.key, 'ctrl+t');
    assert.strictEqual(getDefaultKeymap().keybindings.length, 0);
  });

  it('should keep the branch popup (Ctrl+Shift+`) distinct from the VCS Operations Popup (Alt+`)', () => {
    const intellijKeymap = getIntelliJKeymap();

    // The branch popup keeps its dedicated Ctrl+Shift+` binding in both
    // presets; Alt+` belongs to the (distinct) VCS Operations Popup.
    const branchPopup = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.showBranchPopup'
    );
    const vcsPopup = intellijKeymap.keybindings.find(
      (kb: IKeybinding) => kb.command === 'intellig.vcsOperationsPopup'
    );

    assert.ok(branchPopup);
    assert.ok(vcsPopup);
    assert.strictEqual(branchPopup.key, 'ctrl+shift+`');
    assert.strictEqual(vcsPopup.key, 'alt+`');
    assert.notStrictEqual(branchPopup.key, vcsPopup.key);
  });
});
