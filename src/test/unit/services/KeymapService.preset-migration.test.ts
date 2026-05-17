/**
 * Tests for the keymapPreset migration.
 *
 * Two surfaces under test:
 *   1. `resolveKeymap` (free function) — pure decision function that
 *      promotes the new `keymapPreset` enum and falls back to the
 *      deprecated `useIntelliJKeymap` boolean.
 *   2. The KeymapService constructor + onDidChangeConfiguration
 *      listener — must use the same resolver consistently so toggle
 *      behavior is symmetric.
 */
import * as assert from 'assert';
import { KeymapService, resolveKeymap, validatePreset } from '../../../services/KeymapService';
import { ConfigurationService } from '../../../services/ConfigurationService';
import { KeymapPreset } from '../../../services/interfaces/IKeymapService';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

describe('KeymapService — keymapPreset migration', () => {
  describe('resolveKeymap (pure decision — policy A: preset wins when set)', () => {
    // Policy A (Wave 135 R4 / M3): when `keymapPreset` is set at any
    // scope (i.e. not `undefined`), it is authoritative. Legacy
    // `useIntelliJKeymap` is read ONLY when preset is the schema
    // default (undefined). This matches the deprecation narrative —
    // an explicit user choice on the new knob must not be silently
    // overridden by a stale legacy boolean.
    //
    // The resolver matrix (8 cells):
    //
    //                preset=undef   preset='default'  preset='intellij'
    //   legacy=undef    'default'      'default'         'intellij'
    //   legacy=false    'default'      'default'         'intellij'
    //   legacy=true     'intellij'     'default'         'intellij'

    it("returns 'intellij' when preset='intellij' and legacy=undefined", () => {
      assert.strictEqual(resolveKeymap('intellij', undefined), 'intellij');
    });

    it("returns 'intellij' when preset='intellij' and legacy=false", () => {
      assert.strictEqual(resolveKeymap('intellij', false), 'intellij');
    });

    it("returns 'intellij' when preset='intellij' and legacy=true", () => {
      // Both knobs select intellij — trivially intellij.
      assert.strictEqual(resolveKeymap('intellij', true), 'intellij');
    });

    it("returns 'default' when preset='default' (explicit user opt-out, even if legacy=true)", () => {
      // Wave 135 R4 / M3 policy-A regression spec: a user who
      // explicitly types `keymapPreset: 'default'` while leaving a
      // stale `useIntelliJKeymap: true` MUST get 'default'. The
      // legacy fallback is read ONLY when preset is undefined.
      assert.strictEqual(resolveKeymap('default', true), 'default');
    });

    it("returns 'default' when preset='default' and legacy=false (M2 fill — explicit opt-out)", () => {
      assert.strictEqual(resolveKeymap('default', false), 'default');
    });

    it("returns 'default' when preset='default' and legacy=undefined (M2 fill — explicit choice)", () => {
      assert.strictEqual(resolveKeymap('default', undefined), 'default');
    });

    it("returns 'intellij' when preset=undefined and legacy=true (legacy fallback)", () => {
      assert.strictEqual(resolveKeymap(undefined, true), 'intellij');
    });

    it("returns 'default' when preset=undefined and legacy=false", () => {
      assert.strictEqual(resolveKeymap(undefined, false), 'default');
    });

    it("returns 'default' when both knobs are undefined (schema default)", () => {
      assert.strictEqual(resolveKeymap(undefined, undefined), 'default');
    });
  });

  describe('validatePreset (enum guard)', () => {
    it("returns 'default' for the literal 'default'", () => {
      assert.strictEqual(validatePreset('default'), 'default');
    });

    it("returns 'intellij' for the literal 'intellij'", () => {
      assert.strictEqual(validatePreset('intellij'), 'intellij');
    });

    it("returns undefined for a typo'd preset like 'vim'", () => {
      // Schema enum is a UI hint only; runtime can see anything.
      // Typo'd presets normalise to undefined so the legacy fallback
      // engages instead of passing the typo through to
      // getKeymapDefinitionForPreset (which silently selects default).
      assert.strictEqual(validatePreset('vim'), undefined);
    });

    it('returns undefined for non-string inputs (null, number, object)', () => {
      assert.strictEqual(validatePreset(null), undefined);
      assert.strictEqual(validatePreset(42), undefined);
      assert.strictEqual(validatePreset({}), undefined);
    });

    it('returns undefined for undefined input (passthrough)', () => {
      assert.strictEqual(validatePreset(undefined), undefined);
    });
  });

  describe('constructor — picks the right keymap from configuration', () => {
    let configService: ConfigurationService;
    let keymapService: KeymapService;

    beforeEach(() => {
      resetMockConfiguration();
    });

    afterEach(() => {
      keymapService?.dispose();
      configService?.dispose();
    });

    it("reports 'intellij' for keymapPreset='intellij' (new knob, primary)", () => {
      setMockConfigValue('intellig', 'keymapPreset', 'intellij');
      // legacy stays at its default (false)
      configService = new ConfigurationService();
      keymapService = new KeymapService(configService);
      assert.strictEqual(keymapService.getCurrentKeymap(), 'intellij');
    });

    it("reports 'intellij' for legacy useIntelliJKeymap=true with preset undefined (backward-compat fallback)", () => {
      // Policy A: clear preset so the legacy boolean drives selection.
      setMockConfigValue('intellig', 'keymapPreset', undefined);
      setMockConfigValue('intellig', 'useIntelliJKeymap', true);
      configService = new ConfigurationService();
      keymapService = new KeymapService(configService);
      assert.strictEqual(keymapService.getCurrentKeymap(), 'intellij');
    });

    it("reports 'default' when keymapPreset='default' AND useIntelliJKeymap=true (policy A — preset wins)", () => {
      // Wave 135 R4 / M3 policy A regression spec: an explicit
      // `keymapPreset: 'default'` choice MUST NOT be overridden by a
      // stale legacy boolean. The runtime migration in extension.ts
      // does not touch this case (because preset is set), so the
      // resolver alone needs to honour the user's choice.
      setMockConfigValue('intellig', 'keymapPreset', 'default');
      setMockConfigValue('intellig', 'useIntelliJKeymap', true);
      configService = new ConfigurationService();
      keymapService = new KeymapService(configService);
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });

    it("reports 'default' when both knobs are at defaults", () => {
      configService = new ConfigurationService();
      keymapService = new KeymapService(configService);
      assert.strictEqual(keymapService.getCurrentKeymap(), 'default');
    });
  });

  describe('onDidChangeConfiguration listener — uses the same resolver', () => {
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

    it("fires onDidChangeKeymap when keymapPreset flips from 'default' to 'intellij'", async () => {
      let observedKeymap: KeymapPreset | undefined;
      keymapService.onDidChangeKeymap((k) => {
        observedKeymap = k;
      });
      // Drive the change through ConfigurationService.update so the
      // mock's onDidChangeConfiguration event fires.
      await configService.update('keymapPreset', 'intellij');
      // ConfigurationService dispatches synchronously inside update().
      assert.strictEqual(keymapService.getCurrentKeymap(), 'intellij');
      assert.strictEqual(observedKeymap, 'intellij');
    });
  });
});
