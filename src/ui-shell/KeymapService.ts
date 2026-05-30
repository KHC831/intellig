import * as vscode from 'vscode';
import { IKeymapService, KeymapPreset, IKeymap, IKeybinding } from './interfaces/IKeymapService';
import { IConfigurationService } from '../config/interfaces/IConfigurationService';

/**
 * Default keymap keybindings
 * These are the standard keybindings registered in package.json
 */
const DEFAULT_KEYBINDINGS: IKeybinding[] = [
  {
    command: 'intellig.commit',
    key: 'ctrl+k',
    mac: 'cmd+k',
    when: '!inDebugMode && !terminalFocus',
  },
  {
    command: 'intellig.push',
    key: 'ctrl+shift+k',
    mac: 'cmd+shift+k',
    when: '!inDebugMode && !terminalFocus',
  },
  {
    command: 'intellig.pull',
    key: 'ctrl+t',
    mac: 'cmd+t',
    when: '!inDebugMode && !terminalFocus',
  },
  {
    command: 'intellig.openGitToolWindow',
    key: 'alt+9',
    mac: 'cmd+9',
    when: '!inDebugMode',
  },
  {
    command: 'intellig.showBranchPopup',
    key: 'ctrl+shift+`',
    mac: 'cmd+shift+`',
    when: '!inDebugMode',
  },
  {
    command: 'intellig.refresh',
    key: 'ctrl+shift+r',
    mac: 'cmd+shift+r',
    when: '!inDebugMode && !terminalFocus',
  },
  {
    command: 'intellig.stageSelected',
    key: 'ctrl+alt+a',
    mac: 'cmd+alt+a',
    when: '!inDebugMode && !terminalFocus',
  },
  {
    command: 'intellig.unstageSelected',
    key: 'ctrl+alt+z',
    mac: 'cmd+alt+z',
    when: '!inDebugMode && !terminalFocus',
  },
];

/**
 * IntelliJ IDEA keymap keybindings
 * These match IntelliJ IDEA's default Git keybindings
 *
 * IntelliJ Default Git Keybindings:
 * - Commit: Ctrl+K
 * - Push: Ctrl+Shift+K
 * - Update Project (Pull): Ctrl+T
 * - VCS Operations Popup: Alt+` (backtick)
 * - Annotate (Blame): Ctrl+Alt+Shift+A
 * - Show History: Ctrl+H
 * - Compare with Branch: Ctrl+D
 * - Rollback (Revert): Ctrl+Alt+Z
 */
const INTELLIJ_KEYBINDINGS: IKeybinding[] = [
  // Same as default - Commit: Ctrl+K
  {
    command: 'intellig.commit',
    key: 'ctrl+k',
    mac: 'cmd+k',
    when: '!inDebugMode && !terminalFocus',
  },
  // Same as default - Push: Ctrl+Shift+K
  {
    command: 'intellig.push',
    key: 'ctrl+shift+k',
    mac: 'cmd+shift+k',
    when: '!inDebugMode && !terminalFocus',
  },
  // Same as default - Update Project (Pull): Ctrl+T
  {
    command: 'intellig.pull',
    key: 'ctrl+t',
    mac: 'cmd+t',
    when: '!inDebugMode && !terminalFocus',
  },
  // VCS Operations Popup: Alt+` (backtick)
  {
    command: 'intellig.showBranchPopup',
    key: 'alt+`',
    mac: 'alt+`',
    when: '!inDebugMode',
  },
  // Annotate (Blame): Ctrl+Alt+Shift+A
  {
    command: 'intellig.toggleBlame',
    key: 'ctrl+alt+shift+a',
    mac: 'cmd+alt+shift+a',
    when: 'editorTextFocus',
  },
  // Show History: Ctrl+H
  {
    command: 'intellig.showHistory',
    key: 'ctrl+h',
    mac: 'cmd+h',
    when: '!inDebugMode',
  },
  // Compare with Branch: Ctrl+D
  {
    command: 'intellig.branch.compareWithCurrent',
    key: 'ctrl+d',
    mac: 'cmd+d',
    when: '!inDebugMode && !terminalFocus',
  },
  // Rollback (Revert): Ctrl+Alt+Z
  {
    command: 'intellig.revertFile',
    key: 'ctrl+alt+z',
    mac: 'cmd+alt+z',
    when: '!inDebugMode && !terminalFocus',
  },
  // Git Tool Window: Alt+9 (same as default)
  {
    command: 'intellig.openGitToolWindow',
    key: 'alt+9',
    mac: 'cmd+9',
    when: '!inDebugMode',
  },
  // Refresh: Ctrl+Shift+R (same as default)
  {
    command: 'intellig.refresh',
    key: 'ctrl+shift+r',
    mac: 'cmd+shift+r',
    when: '!inDebugMode && !terminalFocus',
  },
  // Stage Selected: Ctrl+Alt+A (same as default)
  {
    command: 'intellig.stageSelected',
    key: 'ctrl+alt+a',
    mac: 'cmd+alt+a',
    when: '!inDebugMode && !terminalFocus',
  },
];

/**
 * Default keymap definition
 */
const DEFAULT_KEYMAP: IKeymap = {
  name: 'default',
  displayName: 'Default',
  keybindings: DEFAULT_KEYBINDINGS,
};

/**
 * IntelliJ keymap definition
 */
const INTELLIJ_KEYMAP: IKeymap = {
  name: 'intellij',
  displayName: 'IntelliJ IDEA',
  keybindings: INTELLIJ_KEYBINDINGS,
};

/**
 * All available keymaps
 */
const KEYMAPS: Map<KeymapPreset, IKeymap> = new Map([
  ['default', DEFAULT_KEYMAP],
  ['intellij', INTELLIJ_KEYMAP],
]);

/**
 * Validate that `raw` is one of the known `KeymapPreset` enum values.
 *
 * The settings.json schema's `enum` is a UI hint only — at runtime, a
 * user can type any string. A typo'd preset (e.g. `'vim'`) is
 * normalised to `undefined` so the resolver falls through to the
 * legacy boolean rather than passing the typo through to
 * `getKeymapDefinitionForPreset`, which silently selects 'default' for
 * unknown names.
 *
 * @internal — exposed for unit tests asserting typo handling.
 */
export function validatePreset(raw: unknown): KeymapPreset | undefined {
  return raw === 'default' || raw === 'intellij' ? raw : undefined;
}

/**
 * @internal
 *
 * Read the user's keymap preset from configuration, distinguishing
 * user-set values from schema defaults. EXPORTED ONLY for unit tests
 * (`KeymapService.preset-migration.test.ts`,
 * `KeymapService.freeFunctions.test.ts`) and internal use within
 * `KeymapService` itself. Do NOT import from outside this module —
 * keymap reads should go through `KeymapService`'s public API
 * (`getCurrentKeymap()`, `getKeymapDefinition()`, etc.).
 *
 * The typed `IConfigurationService.get()` merges schema defaults in, so
 * a user who has not set keymapPreset gets `'default'` from the typed
 * config — and policy A would then suppress the legacy fallback.
 * `inspect()` exposes the per-scope writes directly. Validates the
 * inspect()'d value against the known enum: typo'd presets like
 * `'vim'` fall through to `undefined` so the legacy fallback engages
 * safely.
 *
 * Workspace value wins over global if both exist; matches VS Code's
 * effective-value semantics.
 */
export function readUserSetPreset(
  configurationService: IConfigurationService
): KeymapPreset | undefined {
  const inspected = configurationService.inspect('keymapPreset');
  if (!inspected) {
    return undefined;
  }
  const raw: unknown = inspected.workspaceValue ?? inspected.globalValue;
  return validatePreset(raw);
}

/**
 * Resolve the active keymap from the two configuration knobs.
 *
 * Policy A ("preset wins when set"):
 *   - When `preset` is set at any scope (`'default'` or `'intellij'`),
 *     it is authoritative. The legacy `useIntelliJKeymap` boolean is
 *     NOT consulted.
 *   - The legacy fallback applies ONLY when `preset` is the schema
 *     default (`undefined`). Backward-compat for users who never knew
 *     about the new knob.
 *
 * Why policy A: a user who explicitly types `keymapPreset: 'default'`
 * while leaving a stale `useIntelliJKeymap: true` (e.g., from a
 * workspace they inherited) MUST get the default keymap — silently
 * overriding their explicit choice with the legacy is a UX correctness
 * bug. The deprecation narrative is "preset is authoritative; legacy
 * is read-only fallback for users who didn't migrate yet."
 *
 * @internal — exposed for unit tests asserting the 8-cell resolver
 * matrix.
 */
export function resolveKeymap(
  preset: KeymapPreset | undefined,
  legacyOptIn: boolean | undefined
): KeymapPreset {
  if (preset !== undefined) {
    return preset;
  }
  return legacyOptIn === true ? 'intellij' : 'default';
}

/**
 * Keymap Service implementation.
 * Manages keyboard shortcut presets and provides keymap switching functionality.
 */
export class KeymapService implements IKeymapService {
  private _onDidChangeKeymap: vscode.EventEmitter<KeymapPreset>;
  private _disposables: vscode.Disposable[] = [];
  private _currentKeymap: KeymapPreset;

  /**
   * Event fired when the keymap changes
   */
  readonly onDidChangeKeymap: vscode.Event<KeymapPreset>;

  /**
   * Creates a new KeymapService instance
   * @param configurationService - The configuration service to read keymap settings from
   */
  constructor(private readonly configurationService: IConfigurationService) {
    this._onDidChangeKeymap = new vscode.EventEmitter<KeymapPreset>();
    this.onDidChangeKeymap = this._onDidChangeKeymap.event;

    // Initialize current keymap. Read `keymapPreset` via the typed
    // `inspect()` (see `readUserSetPreset`) so we can distinguish
    // "user explicitly set a value at any scope" from "no user value,
    // schema default returned". Under policy A, the legacy
    // `useIntelliJKeymap` fallback fires ONLY when no preset is set at
    // any scope — which the typed `get()` cannot express because it
    // merges in the schema default.
    this._currentKeymap = resolveKeymap(
      readUserSetPreset(this.configurationService),
      this.configurationService.get('useIntelliJKeymap')
    );

    // Listen for configuration changes. Re-inspect on every change so
    // the resolver sees fresh inspect() state, not the merged snapshot
    // in the change event.
    this._disposables.push(
      this.configurationService.onDidChangeConfiguration((config) => {
        const newKeymap = resolveKeymap(
          readUserSetPreset(this.configurationService),
          config.useIntelliJKeymap
        );
        if (newKeymap !== this._currentKeymap) {
          this._currentKeymap = newKeymap;
          this._onDidChangeKeymap.fire(this._currentKeymap);
        }
      })
    );
  }

  /**
   * Get the currently active keymap preset
   */
  getCurrentKeymap(): KeymapPreset {
    return this._currentKeymap;
  }

  /**
   * Get the full keymap definition for the current preset
   */
  getKeymapDefinition(): IKeymap {
    return this.getKeymapDefinitionForPreset(this._currentKeymap);
  }

  /**
   * Get the keymap definition for a specific preset
   * @param preset - The keymap preset to retrieve
   */
  getKeymapDefinitionForPreset(preset: KeymapPreset): IKeymap {
    const keymap = KEYMAPS.get(preset);
    if (!keymap) {
      // Fallback to default if preset not found
      return DEFAULT_KEYMAP;
    }
    return keymap;
  }

  /**
   * Get all available keymap presets
   */
  getAvailablePresets(): KeymapPreset[] {
    return Array.from(KEYMAPS.keys());
  }

  /**
   * Get the keybinding for a specific command in the current keymap
   * @param command - The command identifier
   */
  getKeybindingForCommand(command: string): IKeybinding | undefined {
    const keymap = this.getKeymapDefinition();
    return keymap.keybindings.find((kb) => kb.command === command);
  }

  /**
   * Check if IntelliJ keymap is currently active
   */
  isIntelliJKeymapActive(): boolean {
    return this._currentKeymap === 'intellij';
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeKeymap.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Get the default keymap definition
 * Useful for testing and reference
 */
export function getDefaultKeymap(): IKeymap {
  return {
    name: DEFAULT_KEYMAP.name,
    displayName: DEFAULT_KEYMAP.displayName,
    keybindings: [...DEFAULT_KEYMAP.keybindings],
  };
}

/**
 * Get the IntelliJ keymap definition
 * Useful for testing and reference
 */
export function getIntelliJKeymap(): IKeymap {
  return {
    name: INTELLIJ_KEYMAP.name,
    displayName: INTELLIJ_KEYMAP.displayName,
    keybindings: [...INTELLIJ_KEYMAP.keybindings],
  };
}

/**
 * Get all available keymaps
 * Useful for testing and reference
 */
export function getAllKeymaps(): IKeymap[] {
  return Array.from(KEYMAPS.values()).map((km: IKeymap) => ({
    name: km.name,
    displayName: km.displayName,
    keybindings: [...km.keybindings],
  }));
}
