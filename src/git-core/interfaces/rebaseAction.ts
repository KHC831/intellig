/**
 * Interactive-rebase per-commit action, split out vscode-free so the Rebase
 * editor's webview entry can import it through rebaseEditor.protocol without
 * pulling in IRebaseService (which imports vscode). IRebaseService re-exports it
 * as the canonical name.
 */
export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
