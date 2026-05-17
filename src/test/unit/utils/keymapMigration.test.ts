/**
 * Wave 135 R3 / C1 + R4 / H1 + R5 / H1: tests for the keymap-preset
 * runtime migration.
 *
 * Wave 135 R5 / H1 split the decision into independent
 * `shouldWritePreset` / `shouldClearLegacy` flags so mixed-scope
 * cases (workspace legacy + global preset) are handled correctly.
 * Pre-R5 the migration short-circuited on "preset already set
 * somewhere" and the workspace legacy was never cleared, leaving
 * deprecation chrome in `.vscode/settings.json` permanently.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  decideKeymapMigration,
  runKeymapMigration,
  runKeymapMigrationSafe,
  IKeymapMigrationConfigSeam,
  IKeymapMigrationLogger,
} from '../../../utils/keymapMigration';

describe('keymapMigration — runtime migration (Wave 135 R3 + R4 + R5)', () => {
  describe('decideKeymapMigration (pure)', () => {
    // ---- "no legacy anywhere" → no-op ----

    it('no-op when legacy is absent at every scope', () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: undefined,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: undefined,
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, false);
      assert.strictEqual(r.message, undefined);
    });

    it('no-op when legacy is explicitly false', () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: false,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: undefined,
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, false);
    });

    it('no-op when only preset is set (no legacy to clear)', () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: undefined,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: 'intellij',
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, false);
    });

    // ---- "both writes" → write preset + clear legacy at SAME scope ----

    it('global both-writes: legacyGlobal=true with no preset → write preset Global, clear legacy Global', () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: true,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: undefined,
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, true);
      assert.strictEqual(r.presetScope, 'Global');
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(r.legacyClearScopes, ['Global']);
      assert.ok(r.message?.includes('migrated'));
    });

    it('workspace both-writes: legacyWorkspace=true with no preset → BOTH writes target Workspace (Wave 135 R4 / H1)', () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: undefined,
        legacyWorkspaceValue: true,
        presetGlobalValue: undefined,
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, true);
      assert.strictEqual(r.presetScope, 'Workspace');
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(r.legacyClearScopes, ['Workspace']);
    });

    it('both-scope-legacy: clears BOTH scopes; preset goes to workspace (Wave 135 R6 / L3)', () => {
      // Wave 135 R6 / L3 regression spec: pre-R6 only the workspace
      // legacy was cleared; the global one persisted with deprecation
      // chrome. The new contract clears every scope where the legacy
      // was set, so a single activation completely purges the
      // deprecated boolean.
      const r = decideKeymapMigration({
        legacyGlobalValue: true,
        legacyWorkspaceValue: true,
        presetGlobalValue: undefined,
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, true);
      // Preset write still goes to a single scope (workspace beats
      // global per VS Code's effective-value semantics — that's
      // about reads).
      assert.strictEqual(r.presetScope, 'Workspace');
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(
        [...r.legacyClearScopes].sort(),
        ['Global', 'Workspace'],
        'both scopes must be cleared so deprecation chrome is fully purged'
      );
    });

    // ---- Wave 135 R5 / H1 mixed-scope cases (THE HOLE) ----

    it("mixed-scope: workspace legacy + global preset='default' → CLEAR workspace legacy, do NOT write preset", () => {
      // The R5 H1 regression spec. Pre-R5 this returned no-op; the
      // workspace boolean was permanently leaked.
      const r = decideKeymapMigration({
        legacyGlobalValue: undefined,
        legacyWorkspaceValue: true,
        presetGlobalValue: 'default',
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(
        r.shouldWritePreset,
        false,
        'preset is already set globally; do not overwrite it'
      );
      assert.strictEqual(r.shouldClearLegacy, true, 'workspace legacy must still be cleared');
      assert.deepStrictEqual(r.legacyClearScopes, ['Workspace']);
      assert.ok(r.message?.includes('cleared'));
    });

    it("mixed-scope: workspace legacy + workspace preset='default' → clear workspace legacy", () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: undefined,
        legacyWorkspaceValue: true,
        presetGlobalValue: undefined,
        presetWorkspaceValue: 'default',
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(r.legacyClearScopes, ['Workspace']);
    });

    it("mixed-scope: global legacy + global preset='default' → clear global legacy", () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: true,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: 'default',
        presetWorkspaceValue: undefined,
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(r.legacyClearScopes, ['Global']);
    });

    it("mixed-scope: global legacy + workspace preset='intellij' → clear global legacy", () => {
      const r = decideKeymapMigration({
        legacyGlobalValue: true,
        legacyWorkspaceValue: undefined,
        presetGlobalValue: undefined,
        presetWorkspaceValue: 'intellij',
      });
      assert.strictEqual(r.shouldWritePreset, false);
      assert.strictEqual(r.shouldClearLegacy, true);
      assert.deepStrictEqual(r.legacyClearScopes, ['Global']);
    });
  });

  describe('runKeymapMigration (with stub seam)', () => {
    function makeSeam(initial: {
      legacyGlobal?: boolean;
      legacyWorkspace?: boolean;
      presetGlobal?: string;
      presetWorkspace?: string;
    }): {
      seam: IKeymapMigrationConfigSeam;
      updates: Array<[string, unknown, vscode.ConfigurationTarget]>;
    } {
      const updates: Array<[string, unknown, vscode.ConfigurationTarget]> = [];
      const state: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {
        useIntelliJKeymap: {
          globalValue: initial.legacyGlobal,
          workspaceValue: initial.legacyWorkspace,
        },
        keymapPreset: {
          globalValue: initial.presetGlobal,
          workspaceValue: initial.presetWorkspace,
        },
      };
      const seam: IKeymapMigrationConfigSeam = {
        inspect: <T>(key: string) =>
          (state[key] ?? {}) as {
            globalValue?: T;
            workspaceValue?: T;
          },
        update: (key, value, target) => {
          updates.push([key, value, target]);
          if (target === vscode.ConfigurationTarget.Global) {
            state[key] = { ...state[key], globalValue: value };
          } else {
            state[key] = { ...state[key], workspaceValue: value };
          }
          return Promise.resolve();
        },
      };
      return { seam, updates };
    }

    it('global both-writes: writes preset Global + clears legacy Global; notifies', async () => {
      const { seam, updates } = makeSeam({ legacyGlobal: true });
      let notifiedMessage: string | undefined;
      await runKeymapMigration(seam, (m) => {
        notifiedMessage = m;
      });
      assert.strictEqual(updates.length, 2);
      assert.deepStrictEqual(updates[0], [
        'keymapPreset',
        'intellij',
        vscode.ConfigurationTarget.Global,
      ]);
      assert.deepStrictEqual(updates[1], [
        'useIntelliJKeymap',
        undefined,
        vscode.ConfigurationTarget.Global,
      ]);
      assert.ok(notifiedMessage?.includes('migrated'));
    });

    it('workspace both-writes: BOTH writes target Workspace (Wave 135 R4 / H1)', async () => {
      const { seam, updates } = makeSeam({ legacyWorkspace: true });
      await runKeymapMigration(seam, () => {});
      assert.strictEqual(updates.length, 2);
      assert.deepStrictEqual(updates[0], [
        'keymapPreset',
        'intellij',
        vscode.ConfigurationTarget.Workspace,
      ]);
      assert.deepStrictEqual(updates[1], [
        'useIntelliJKeymap',
        undefined,
        vscode.ConfigurationTarget.Workspace,
      ]);
    });

    it('Wave 135 R5 / H1: workspace legacy + global preset → ONLY clears workspace legacy', async () => {
      const { seam, updates } = makeSeam({
        legacyWorkspace: true,
        presetGlobal: 'default',
      });
      let notifiedMessage: string | undefined;
      await runKeymapMigration(seam, (m) => {
        notifiedMessage = m;
      });
      assert.strictEqual(
        updates.length,
        1,
        'only the legacy clear should happen; preset is already user-set'
      );
      assert.deepStrictEqual(updates[0], [
        'useIntelliJKeymap',
        undefined,
        vscode.ConfigurationTarget.Workspace,
      ]);
      assert.ok(notifiedMessage?.includes('cleared'));
    });

    it('idempotent: second activation after migration is a no-op', async () => {
      const { seam, updates } = makeSeam({ legacyGlobal: true });
      await runKeymapMigration(seam, () => {});
      const updatesAfterFirst = updates.length;
      await runKeymapMigration(seam, () => {});
      assert.strictEqual(updates.length, updatesAfterFirst);
    });

    it('no-op when legacy not set anywhere → no updates, no notification', async () => {
      const { seam, updates } = makeSeam({});
      let notifierCalls = 0;
      await runKeymapMigration(seam, () => {
        notifierCalls++;
      });
      assert.strictEqual(updates.length, 0);
      assert.strictEqual(notifierCalls, 0);
    });

    it('Wave 135 R4 / M1: rejection from seam.update propagates to caller', async () => {
      const seam: IKeymapMigrationConfigSeam = {
        inspect: <T>(key: string) => {
          if (key === 'useIntelliJKeymap') {
            return { globalValue: true as unknown as T };
          }
          return {};
        },
        update: () => Promise.reject(new Error('settings.json read-only')),
      };
      let notified = 0;
      await assert.rejects(
        runKeymapMigration(seam, () => {
          notified++;
        }),
        /settings\.json read-only/
      );
      assert.strictEqual(notified, 0);
    });
  });

  describe('runKeymapMigrationSafe (Wave 135 R5 / M3)', () => {
    function makeRejectingSeam(): IKeymapMigrationConfigSeam {
      return {
        inspect: <T>(key: string) => {
          if (key === 'useIntelliJKeymap') {
            return { globalValue: true as unknown as T };
          }
          return {};
        },
        update: () => Promise.reject(new Error('/Users/alice/.vscode/settings.json: EACCES')),
      };
    }

    function makeLogger(): IKeymapMigrationLogger & { lines: string[] } {
      const lines: string[] = [];
      return {
        lines,
        appendLine: (line: string) => {
          lines.push(line);
        },
      };
    }

    it('routes failure to logger when seam.update rejects', async () => {
      // Wave 135 R6 / L2: assert via the logger spy's appendLine
      // call list, not via a return value (the function is now
      // Promise<void>).
      const seam = makeRejectingSeam();
      const logger = makeLogger();
      let notified = 0;
      await runKeymapMigrationSafe(
        seam,
        () => {
          notified++;
        },
        logger,
        (s) => s.replace(/\/Users\/[^/]+/g, '/Users/<user>')
      );
      assert.strictEqual(logger.lines.length, 1);
      assert.match(logger.lines[0], /\[keymapMigration\] migration skipped due to error:/);
      assert.match(logger.lines[0], /\/Users\/<user>/, 'sanitize callback ran on the error string');
      assert.strictEqual(notified, 0, 'notifier not called on failure');
    });

    it('logs nothing on success', async () => {
      const seam: IKeymapMigrationConfigSeam = {
        inspect: () => ({}),
        update: () => Promise.resolve(),
      };
      const logger = makeLogger();
      await runKeymapMigrationSafe(
        seam,
        () => {},
        logger,
        (s) => s
      );
      assert.strictEqual(logger.lines.length, 0);
    });

    it('logs nothing when no migration is needed (no-op path)', async () => {
      const seam: IKeymapMigrationConfigSeam = {
        inspect: () => ({}),
        update: () => {
          throw new Error('update should not have been called for a no-op');
        },
      };
      const logger = makeLogger();
      await runKeymapMigrationSafe(
        seam,
        () => {},
        logger,
        (s) => s
      );
      assert.strictEqual(logger.lines.length, 0);
    });
  });
});
