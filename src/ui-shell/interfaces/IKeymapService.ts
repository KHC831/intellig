import * as vscode from 'vscode';

/**
 * Keymap preset types
 */
export type KeymapPreset = 'default' | 'intellij';

/**
 * Keybinding definition for a command
 */
export interface IKeybinding {
  /** The command identifier */
  command: string;
  /** The key combination (e.g., "ctrl+k") */
  key: string;
  /** The key combination for Mac (e.g., "cmd+k") */
  mac?: string;
  /** Optional when clause for the keybinding */
  when?: string;
}

/**
 * Keymap definition containing all keybindings for a preset
 */
export interface IKeymap {
  /** The preset name */
  name: KeymapPreset;
  /** Display name for the keymap */
  displayName: string;
  /** All keybindings in this keymap */
  keybindings: IKeybinding[];
}

/**
 * Keymap Service interface for managing keyboard shortcut presets.
 * Supports switching between default and IntelliJ-style keymaps.
 */
export interface IKeymapService {
  /**
   * Get the currently active keymap preset
   */
  getCurrentKeymap(): KeymapPreset;

  /**
   * Get the full keymap definition for the current preset
   */
  getKeymapDefinition(): IKeymap;

  /**
   * Get the keymap definition for a specific preset
   * @param preset - The keymap preset to retrieve
   */
  getKeymapDefinitionForPreset(preset: KeymapPreset): IKeymap;

  /**
   * Get all available keymap presets
   */
  getAvailablePresets(): KeymapPreset[];

  /**
   * Get the keybinding for a specific command in the current keymap
   * @param command - The command identifier
   */
  getKeybindingForCommand(command: string): IKeybinding | undefined;

  /**
   * Check if IntelliJ keymap is currently active
   */
  isIntelliJKeymapActive(): boolean;

  /**
   * Event fired when the keymap changes
   */
  onDidChangeKeymap: vscode.Event<KeymapPreset>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
