/**
 * `git reset` mode, split out vscode-free so the Reset dialog's webview entry
 * can import it through resetDialog.protocol without pulling in IGitService
 * (which imports vscode). IGitService re-exports it as the canonical name.
 */
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';
