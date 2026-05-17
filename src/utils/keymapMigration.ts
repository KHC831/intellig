// File-location note (Wave 135 R4 / tech-lead-R4 L-R4-1):
// This is the FIRST runtime config-migration in the extension. It
// lives under `src/utils/` because there is currently no
// `src/services/migrations/` dir and YAGNI says don't create one
// for a single file. If a SECOND migration lands, relocate this
// file and the new one to `src/services/migrations/<name>.ts`.

import * as vscode from 'vscode';

/**
 * One-time migration from the deprecated `intellig.useIntelliJKeymap`
 * boolean to the new `intellig.keymapPreset` enum (Wave 135 R3 / C1).
 *
 * The H1 path-A migration in Wave 135 R2 changed every keybinding's
 * `when` clause from `config.intellig.useIntelliJKeymap` to
 * `config.intellig.keymapPreset == 'intellij'`, but did not migrate
 * existing user settings. An installed user with
 * `useIntelliJKeymap: true` would silently lose every IntelliJ
 * binding after upgrade.
 *
 * Wave 135 R5 / H1: this function produces a SPLIT decision so
 * mixed-scope cases are handled correctly:
 *   - "Both writes" — preset write + legacy clear (typical case).
 *   - "Legacy-clear-only" — user already has a preset somewhere AND
 *     legacy somewhere; clear the legacy, leave the preset alone.
 *   - "No-op" — no legacy anywhere.
 *
 * Wave 135 R6 / L3: the legacy clear can target MULTIPLE scopes
 * simultaneously when the user has set the deprecated boolean at
 * both Global and Workspace. Pre-R6 only one scope was cleared per
 * activation; the other persisted with deprecation chrome until
 * the next activation. The new contract clears every scope at
 * once.
 *
 * @param notifier - injected `vscode.window.showInformationMessage`
 *                   so unit tests can assert the message without
 *                   touching the real notification surface.
 */
export interface IKeymapMigrationConfigSeam {
  /**
   * Returns the inspect() result for `intellig.<key>`. Mirrors
   * `vscode.workspace.getConfiguration('intellig').inspect(key)`.
   */
  inspect: <T>(
    key: string
  ) => { globalValue?: T; workspaceValue?: T; defaultValue?: T } | undefined;
  /**
   * Equivalent of
   * `vscode.workspace.getConfiguration('intellig').update(...)`.
   */
  update: (key: string, value: unknown, target: vscode.ConfigurationTarget) => Promise<void>;
}

export type InfoNotifier = (message: string) => void | Thenable<unknown>;

/**
 * Migration scope dispatch (Wave 135 R4 / H1; Wave 135 R5 / H1
 * extension to mixed-scope cases). The pure decision function
 * reports the source scope so the runner can mirror its writes
 * there. A user who set the legacy at workspace scope (e.g.
 * `.vscode/settings.json` checked into a repo) MUST get the new
 * preset written to workspace — writing to global would silently
 * leave the workspace boolean in place forever and surface
 * permanent deprecation chrome.
 */
export type MigrationScope = 'Global' | 'Workspace';

/**
 * Wave 135 R5 / H1 split-decision return shape +
 * Wave 135 R6 / L3 multi-scope legacy clear.
 *
 * Each of the two writes is independently gated:
 *   - `shouldWritePreset` + `presetScope` — write `keymapPreset:
 *     'intellij'` at `presetScope` (single scope).
 *   - `shouldClearLegacy` + `legacyClearScopes` — clear
 *     `useIntelliJKeymap` at every scope in `legacyClearScopes`.
 *
 * The mixed-scope hole the R5 review caught was: workspace legacy
 * + global preset-already-set. Pre-R5 this returned
 * `shouldMigrate=false` and never cleared the workspace legacy. The
 * fix is "if legacy is set anywhere, clear it from there — even if
 * we won't write the preset because the user already chose one."
 *
 * The further hole R6 caught was: legacy at BOTH scopes. The R5
 * fix cleared only one — eventually consistent over multiple
 * activations but observably leaky in between. The R6 fix walks
 * every scope where the legacy is truthy and clears each.
 */
export interface IKeymapMigrationDecision {
  shouldWritePreset: boolean;
  presetScope?: MigrationScope;
  shouldClearLegacy: boolean;
  /**
   * Scopes from which to clear the legacy boolean. Empty array
   * when `shouldClearLegacy` is false. May contain one or two
   * entries depending on which scopes the user explicitly set
   * the deprecated boolean at.
   */
  legacyClearScopes: ReadonlyArray<MigrationScope>;
  message?: string;
}

/**
 * Pure decision function — easy to test without VS Code state.
 */
export function decideKeymapMigration(args: {
  legacyGlobalValue: boolean | undefined;
  legacyWorkspaceValue: boolean | undefined;
  presetGlobalValue: string | undefined;
  presetWorkspaceValue: string | undefined;
}): IKeymapMigrationDecision {
  const { legacyGlobalValue, legacyWorkspaceValue, presetGlobalValue, presetWorkspaceValue } = args;

  // Detect scope-specific legacy presence (truthy at that scope).
  // VS Code returns `false` if the user explicitly opted OUT, but
  // we only migrate `true`.
  const legacyAtWorkspace = legacyWorkspaceValue === true;
  const legacyAtGlobal = legacyGlobalValue === true;

  // Wave 135 R6 / L3: collect every scope where the legacy is
  // truthy. Order matters for the test stability: workspace first
  // (matches VS Code's effective-value precedence), global second.
  const legacyClearScopes: MigrationScope[] = [];
  if (legacyAtWorkspace) {
    legacyClearScopes.push('Workspace');
  }
  if (legacyAtGlobal) {
    legacyClearScopes.push('Global');
  }

  // No legacy anywhere — nothing to migrate.
  if (legacyClearScopes.length === 0) {
    return {
      shouldWritePreset: false,
      shouldClearLegacy: false,
      legacyClearScopes: [],
    };
  }

  // The preset write (when applicable) targets the legacy's
  // most-specific scope: workspace beats global, mirroring VS
  // Code's effective-value precedence.
  const presetScope: MigrationScope = legacyAtWorkspace ? 'Workspace' : 'Global';

  // Legacy IS somewhere. Always clear it from every source scope —
  // even when we won't write the preset (user already chose one).
  const presetSetSomewhere = presetGlobalValue !== undefined || presetWorkspaceValue !== undefined;

  if (presetSetSomewhere) {
    // Legacy-clear-only path (Wave 135 R5 / H1 — the case the R4
    // fix missed). Quieter notification — user already has a preset.
    return {
      shouldWritePreset: false,
      shouldClearLegacy: true,
      legacyClearScopes,
      message:
        'IntelliG cleared your deprecated `useIntelliJKeymap` setting. ' +
        'Your existing `keymapPreset` value is unchanged.',
    };
  }

  // Both writes path: preset goes to the legacy's most-specific
  // scope (so workspace legacy migrates to workspace preset,
  // keeping team-shared semantics).
  return {
    shouldWritePreset: true,
    presetScope,
    shouldClearLegacy: true,
    legacyClearScopes,
    message:
      'IntelliG migrated your `useIntelliJKeymap: true` setting to ' +
      '`keymapPreset: "intellij"`. The old setting is now deprecated.',
  };
}

function scopeToTarget(scope: MigrationScope): vscode.ConfigurationTarget {
  return scope === 'Workspace'
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/**
 * Run the migration against the supplied configuration seam.
 * Resolves once any settings updates have been awaited so the
 * caller can guarantee KeymapService observes the new shape.
 *
 * Wave 135 R4 / M1: this function does NOT catch update failures.
 * Migration is non-essential (KeymapService legacy fallback covers
 * the keymap surface), so the caller wraps the await in try/catch
 * — see `runKeymapMigrationSafe` (Wave 135 R5 / M3) for the
 * pre-baked safe wrapper. Keeping the rejection visible at this
 * seam lets unit tests assert the failure shape directly.
 */
export async function runKeymapMigration(
  config: IKeymapMigrationConfigSeam,
  notifier: InfoNotifier
): Promise<void> {
  const legacyInspect = config.inspect<boolean>('useIntelliJKeymap');
  const presetInspect = config.inspect<string>('keymapPreset');

  const decision = decideKeymapMigration({
    legacyGlobalValue: legacyInspect?.globalValue,
    legacyWorkspaceValue: legacyInspect?.workspaceValue,
    presetGlobalValue: presetInspect?.globalValue,
    presetWorkspaceValue: presetInspect?.workspaceValue,
  });

  if (!decision.shouldWritePreset && !decision.shouldClearLegacy) {
    return;
  }

  if (decision.shouldWritePreset && decision.presetScope) {
    await config.update('keymapPreset', 'intellij', scopeToTarget(decision.presetScope));
  }

  if (decision.shouldClearLegacy) {
    // Wave 135 R6 / L3: clear from every scope where the legacy
    // was set. Sequential awaits keep the order deterministic for
    // the per-scope event listeners.
    for (const scope of decision.legacyClearScopes) {
      await config.update('useIntelliJKeymap', undefined, scopeToTarget(scope));
    }
  }

  if (decision.message) {
    void notifier(decision.message);
  }
}

/**
 * Wave 135 R5 / M3 path-A: pre-baked "safe" runner that wraps
 * `runKeymapMigration` in try/catch and routes failures to a
 * caller-supplied logger. Used by `extension.ts` to keep
 * activation untouched by migration failure modes.
 *
 * Wave 135 R6 / L2: returns `Promise<void>`. Production
 * (extension.ts) doesn't read the old boolean return; tests assert
 * via the logger spy's appendLine call list. Dropping the
 * `Promise<boolean>` return removes a dead API surface that was
 * test-only.
 */
export interface IKeymapMigrationLogger {
  appendLine: (line: string) => void;
}

export async function runKeymapMigrationSafe(
  config: IKeymapMigrationConfigSeam,
  notifier: InfoNotifier,
  logger: IKeymapMigrationLogger,
  sanitize: (s: string) => string
): Promise<void> {
  try {
    await runKeymapMigration(config, notifier);
  } catch (err) {
    logger.appendLine(`[keymapMigration] migration skipped due to error: ${sanitize(String(err))}`);
  }
}
