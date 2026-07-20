import * as vscode from 'vscode';
import { IKeymapService, KeymapPreset, IKeymap, IKeybinding } from './interfaces/IKeymapService';
import { IConfigurationService } from '../config/interfaces/IConfigurationService';

/**
 * Default keymap keybindings: NONE. The `default` preset promises stock
 * VS Code keybindings, so every IntelliG chord in package.json is gated
 * behind `keymapPreset == 'intellij'`. (The log view's in-panel ctrl+f find
 * is view-scoped wiring, not a keymap-surface binding, so it is not listed.)
 */
const DEFAULT_KEYBINDINGS: IKeybinding[] = [];

/**
 * IntelliJ IDEA keymap keybindings — reference mirror of the IntelliJ-preset
 * bindings declared in `package.json` (`contributes.keybindings` entries
 * gated by `config.intellig.keymapPreset == 'intellij'`). package.json is the
 * SOURCE OF TRUTH for what actually binds; this list is the display /
 * reference copy surfaced by the keymap command. The two are pinned together
 * by `KeymapService.packageCoherence.test.ts` (Phase 0c de-drift) so a new or
 * changed IntelliJ-preset binding in package.json can't silently diverge here.
 *
 * Gestures with a verified reference default ($default.xml / VcsActions.xml /
 * dvcs + git backend XMLs; mac from `Mac OS X 10.5+.xml`):
 * - Commit: Ctrl+K (CheckinProject) · Commit and Push: Ctrl+Alt+K
 * - Push: Ctrl+Shift+K (Vcs.Push) · Update Project: Ctrl+T (Vcs.UpdateProject)
 * - VCS Operations Popup: Alt+` win/linux, Ctrl+V mac (Vcs.QuickListPopupAction)
 * - Shelve Silently: Ctrl+Shift+H · Unshelve Silently: Ctrl+Alt+U
 * - Add/Stage: Ctrl+Alt+A (ChangesView.AddUnversioned)
 * - Rollback (Revert): Ctrl+Alt+Z (ChangesView.Revert)
 * - Unshelve dialog: Ctrl+Shift+U · Jump to Source: F4 (EditSource)
 * - Move to Another Changelist: Alt+Shift+M (ChangesView.Move)
 * - Tool windows: Alt+9 / meta 9, Alt+0 / meta 0
 * - Show Diff (active file): Ctrl+D (Diff.ShowDiff class)
 *
 * IntelliG conveniences WITHOUT a reference default (the reference keymap
 * binds nothing for these actions; do not present them as IntelliJ defaults):
 * - Annotate (Blame): Ctrl+Alt+Shift+A
 * - Branch popup: Ctrl+Shift+` · Refresh: Ctrl+Shift+R
 * - Unstage: Ctrl+Alt+Shift+Z (deliberate move off the Rollback chord)
 */
const INTELLIJ_KEYBINDINGS: IKeybinding[] = [
  // Commit: Ctrl+K on every platform (CheckinProject is control K on $default
  // and the macOS keymap does not override it; cmd+k is a VS Code chord prefix).
  {
    command: 'intellig.commit',
    key: 'ctrl+k',
    mac: 'ctrl+k',
    when: '!inDebugMode && !terminalFocus && !textInputFocus',
  },
  // Push: Ctrl+Shift+K on every platform (Vcs.Push, no macOS override).
  {
    command: 'intellig.push',
    key: 'ctrl+shift+k',
    mac: 'ctrl+shift+k',
    when: '!inDebugMode && !terminalFocus && !textInputFocus',
  },
  // Update Project: Ctrl+T on every platform (Vcs.UpdateProject, no macOS override).
  {
    command: 'intellig.updateProject',
    key: 'ctrl+t',
    mac: 'ctrl+t',
    when: '!inDebugMode && !terminalFocus && !textInputFocus',
  },
  // Commit and Push: Ctrl+Alt+K — IntelliJ-gated in package.json.
  {
    command: 'intellig.commitAndPush',
    key: 'ctrl+alt+k',
    mac: 'cmd+alt+k',
    when: '!inDebugMode && !terminalFocus',
  },
  // VCS Operations Popup: Alt+` (backtick). Distinct from the branch popup
  // (Ctrl+Shift+`) — the popup is a quick-list of common VCS actions.
  {
    command: 'intellig.vcsOperationsPopup',
    key: 'alt+`',
    mac: 'ctrl+v',
    when: '!inDebugMode && !terminalFocus',
  },
  // Branch popup: Ctrl+Shift+` — same as default. Listed here so the IntelliJ
  // reference mirror is complete and stays distinct from the VCS Operations
  // Popup above.
  {
    command: 'intellig.showBranchPopup',
    key: 'ctrl+shift+`',
    mac: 'cmd+shift+`',
    when: '!inDebugMode && !terminalFocus',
  },
  // Annotate (Blame): Ctrl+Alt+Shift+A — IntelliG convenience; the
  // reference Annotate action has no default shortcut.
  {
    command: 'intellig.toggleBlame',
    key: 'ctrl+alt+shift+a',
    mac: 'cmd+alt+shift+a',
    when: 'editorTextFocus',
  },
  // Show Diff for the active file: Ctrl+D (reference Diff.ShowDiff class —
  // the old branch.compareWithCurrent target was a tree-item command a
  // keybinding can never supply an argument to).
  {
    command: 'intellig.explorer.compareWithRepoVersion',
    key: 'ctrl+d',
    mac: 'ctrl+d',
    when: '!inDebugMode && !terminalFocus && !textInputFocus',
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
    when: '!inDebugMode && !terminalFocus',
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
  // Show Shelf (Unshelve…): Ctrl+Shift+U — IntelliJ-gated in package.json.
  {
    command: 'intellig.showShelfList',
    key: 'ctrl+shift+u',
    mac: 'cmd+shift+u',
    when: '!inDebugMode && !terminalFocus',
  },
  // Open File from Local Changes: F4 — IntelliJ's "Jump to Source".
  {
    command: 'intellig.localChanges.openFile',
    key: 'f4',
    when: '!inDebugMode && !terminalFocus',
  },
  // Move Files to Another Changelist: Alt+Shift+M, and Cmd+Shift+M on macOS —
  // the one action in this set the macOS keymap explicitly overrides.
  {
    command: 'intellig.changelist.moveFilesTo',
    key: 'alt+shift+m',
    mac: 'cmd+shift+m',
    when: '!inDebugMode && !terminalFocus',
  },
  // Jump to Commit: Ctrl+F, scoped to the log view.
  {
    command: 'intellig.toolWindow.jumpToHash',
    key: 'ctrl+f',
    mac: 'cmd+f',
    when: "(focusedView == 'intellig.toolWindow' || activeWebviewPanelId == 'intellig.gitLogPanel') && intellig.toolWindow.activeTab == 'log'",
  },
  // Focus the log text filter: Ctrl+L on every platform (Vcs.Log.FocusTextFilter).
  {
    command: 'intellig.toolWindow.focusTextFilter',
    key: 'ctrl+l',
    mac: 'ctrl+l',
    when: "(focusedView == 'intellig.toolWindow' || activeWebviewPanelId == 'intellig.gitLogPanel') && intellig.toolWindow.activeTab == 'log'",
  },
  // Shelve Silently: Ctrl+Shift+H (ChangesView.ShelveSilently).
  {
    command: 'intellig.shelve.silent',
    key: 'ctrl+shift+h',
    mac: 'cmd+shift+h',
    when: '!inDebugMode && !terminalFocus',
  },
  // Unshelve Silently: Ctrl+Alt+U (ChangesView.UnshelveSilently).
  {
    command: 'intellig.unshelve.silent',
    key: 'ctrl+alt+u',
    mac: 'cmd+alt+u',
    when: '!inDebugMode && !terminalFocus',
  },
  // Commit Tool Window: Alt+0 / meta 0 (ActivateCommitToolWindow).
  {
    command: 'intellig.showCommitToolWindow',
    key: 'alt+0',
    mac: 'cmd+0',
    when: '!inDebugMode && !terminalFocus',
  },
  // Unstage: Ctrl+Alt+Shift+Z — deliberate move off the Rollback chord.
  {
    command: 'intellig.unstageSelected',
    key: 'ctrl+alt+shift+z',
    mac: 'cmd+alt+shift+z',
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
 * Resolve the active keymap from `keymapPreset`. A user-set preset (at any
 * scope) is authoritative; when none is set the keymap is `'default'`.
 *
 * @internal — exposed for unit tests.
 */
export function resolveKeymap(preset: KeymapPreset | undefined): KeymapPreset {
  return preset ?? 'default';
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
    // `inspect()` (see `readUserSetPreset`) so a user-set value at any
    // scope is distinguished from the merged-in schema default.
    this._currentKeymap = resolveKeymap(readUserSetPreset(this.configurationService));

    // Listen for configuration changes. Re-inspect on every change so
    // the resolver sees fresh inspect() state, not the merged snapshot
    // in the change event.
    this._disposables.push(
      this.configurationService.onDidChangeConfiguration(() => {
        const newKeymap = resolveKeymap(readUserSetPreset(this.configurationService));
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
