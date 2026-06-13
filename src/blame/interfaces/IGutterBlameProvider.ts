import * as vscode from 'vscode';

/**
 * Gutter Blame Provider interface.
 * Provides blame annotations in the editor gutter for all visible lines,
 * showing commit information with age-based color gradients.
 *
 * - Display blame information in the editor gutter for all visible lines
 * - Click actions to view commit or copy hash
 * - Use distinct colors to differentiate commits by age
 */
export interface IGutterBlameProvider {
  /**
   * Enable gutter blame annotations.
   * When enabled, the provider will show blame info in the gutter for all visible lines.
   */
  enable(): void;

  /**
   * Disable gutter blame annotations.
   * Removes all gutter blame decorations from editors.
   */
  disable(): void;

  /**
   * Toggle gutter blame annotations on/off.
   * @returns The new enabled state
   */
  toggle(): boolean;

  /**
   * Check if gutter blame is currently enabled.
   * @returns True if gutter blame is enabled
   */
  isEnabled(): boolean;

  /**
   * Refresh the gutter blame decorations for the current editor.
   * Call this when the file content changes or when scrolling.
   */
  refresh(): Promise<void>;

  /**
   * Event fired when the enabled state changes.
   */
  onDidChangeEnabled: vscode.Event<boolean>;

  /**
   * Dispose of resources.
   */
  dispose(): void;
}
