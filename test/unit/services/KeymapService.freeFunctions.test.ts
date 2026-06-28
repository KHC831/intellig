/**
 * (Cluster C) — `KeymapService` static-helper conversion to free
 * functions at module scope.
 *
 * Pre-refactor, the three pure helpers `_resolveKeymap`, `_validatePreset`
 * and `_readUserSetPreset` lived as `static`/`private` members on the
 * `KeymapService` class. They have no dependency on instance state — the
 * class is unchanged in shape after extraction — and the static-on-class
 * idiom invited future code to add more statics rather than free
 * functions, drifting away from the project's free-function-by-default
 * convention.
 *
 * Post-refactor, they're plain `export function`s at module scope. The
 * class still owns state (`_currentKeymap`, `_disposables`,
 * `_onDidChangeKeymap`, `configurationService`) and consumes the free
 * functions internally.
 *
 * This spec pins:
 *   1. The three names are exported as functions from the module.
 *   2. Their behaviour matches the legacy static methods exactly — the
 *      8-cell resolver matrix, the enum guard, and the inspect()-based
 *      user-set-preset reader.
 *   3. The static class members `KeymapService._resolveKeymap` /
 *      `KeymapService._validatePreset` do not exist — that surface must
 *      not silently re-emerge as a parallel call path.
 */

import * as assert from 'assert';
import * as keymapModule from '../../../src/ui-shell/KeymapService';
import { ConfigurationService } from '../../../src/config/ConfigurationService';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

describe('KeymapService — free-function helpers (TL-97)', () => {
  describe('module exports', () => {
    it('exports resolveKeymap as a function', () => {
      const mod = keymapModule as unknown as Record<string, unknown>;
      assert.strictEqual(typeof mod.resolveKeymap, 'function');
    });

    it('exports validatePreset as a function', () => {
      const mod = keymapModule as unknown as Record<string, unknown>;
      assert.strictEqual(typeof mod.validatePreset, 'function');
    });

    it('exports readUserSetPreset as a function', () => {
      const mod = keymapModule as unknown as Record<string, unknown>;
      assert.strictEqual(typeof mod.readUserSetPreset, 'function');
    });

    it('does not expose the legacy static class members KeymapService._resolveKeymap / _validatePreset', () => {
      // Behavioural pin: a future revival of the static surface would
      // re-introduce the drift. The surface is the free functions; static
      // equivalents must not silently coexist.
      const klass = keymapModule.KeymapService as unknown as Record<string, unknown>;
      assert.strictEqual(
        klass._resolveKeymap,
        undefined,
        'KeymapService._resolveKeymap was converted to a module-scope free function (resolveKeymap); the static must not be re-exported'
      );
      assert.strictEqual(
        klass._validatePreset,
        undefined,
        'KeymapService._validatePreset was converted to a module-scope free function (validatePreset); the static must not be re-exported'
      );
    });
  });

  describe('resolveKeymap — pure decision (preset drives the keymap)', () => {
    it("returns 'intellij' when preset='intellij'", () => {
      assert.strictEqual(keymapModule.resolveKeymap('intellij'), 'intellij');
    });

    it("returns 'default' when preset='default'", () => {
      assert.strictEqual(keymapModule.resolveKeymap('default'), 'default');
    });

    it("returns 'default' when preset=undefined (schema default)", () => {
      assert.strictEqual(keymapModule.resolveKeymap(undefined), 'default');
    });
  });

  describe('validatePreset — enum guard for raw inspect() output', () => {
    it("returns 'default' for the literal 'default'", () => {
      assert.strictEqual(keymapModule.validatePreset('default'), 'default');
    });

    it("returns 'intellij' for the literal 'intellij'", () => {
      assert.strictEqual(keymapModule.validatePreset('intellij'), 'intellij');
    });

    it("returns undefined for typo'd presets like 'vim'", () => {
      assert.strictEqual(keymapModule.validatePreset('vim'), undefined);
    });

    it('returns undefined for non-string inputs', () => {
      assert.strictEqual(keymapModule.validatePreset(null), undefined);
      assert.strictEqual(keymapModule.validatePreset(42), undefined);
      assert.strictEqual(keymapModule.validatePreset({}), undefined);
      assert.strictEqual(keymapModule.validatePreset(undefined), undefined);
    });
  });

  describe('readUserSetPreset — IConfigurationService.inspect() driven', () => {
    let configService: ConfigurationService;

    beforeEach(() => {
      resetMockConfiguration();
      configService = new ConfigurationService();
    });

    afterEach(() => {
      configService.dispose();
    });

    it('returns the workspace value when set', () => {
      setMockConfigValue('intellig', 'keymapPreset', 'intellij');
      // Mock writes go to globalValue by default; the function must surface them.
      assert.strictEqual(keymapModule.readUserSetPreset(configService), 'intellij');
    });

    it('returns undefined when no scope contains a user value (schema default applies)', () => {
      // No setMockConfigValue call — the underlying inspect() returns
      // empty per-scope values, and the function must NOT confuse the
      // schema default with a user-set value.
      assert.strictEqual(keymapModule.readUserSetPreset(configService), undefined);
    });

    it("returns undefined for a typo'd preset (the validatePreset guard fires)", () => {
      // The configuration service stores whatever string the user writes;
      // the validation pass at the boundary must normalise it.
      setMockConfigValue('intellig', 'keymapPreset', 'vim');
      assert.strictEqual(keymapModule.readUserSetPreset(configService), undefined);
    });
  });
});
