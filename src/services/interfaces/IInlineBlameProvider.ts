import * as vscode from 'vscode';

/**
 * Inline Blame Provider interface.
 * Provides inline blame annotations at the end of the current line,
 * showing commit information for the line where the cursor is positioned.
 *
 * - 9.1: Display blame annotations for file (inline at end of current line)
 * - 9.3: Show commit message on hover
 * - 9.4: Show tooltip with full commit details
 * - 17.12: Use IntelliJ-style gutter annotations with age-based color gradients
 */
export interface IInlineBlameProvider {
  /**
   * Enable inline blame annotations.
   * When enabled, the provider will show blame info at the end of the current line.
   */
  enable(): void;

  /**
   * Disable inline blame annotations.
   * Removes all inline blame decorations from editors.
   */
  disable(): void;

  /**
   * Toggle inline blame annotations on/off.
   * @returns The new enabled state
   */
  toggle(): boolean;

  /**
   * Check if inline blame is currently enabled.
   * @returns True if inline blame is enabled
   */
  isEnabled(): boolean;

  /**
   * Refresh the inline blame decoration for the current editor.
   * Call this when the cursor position changes or the file content changes.
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
