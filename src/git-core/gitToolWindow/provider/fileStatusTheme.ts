/**
 * File-status colour tables for the Git tool window.
 *
 * Two parallel maps over the same `FileStatus` union: the VS Code theme
 * variable a status resolves through, and the IntelliJ-parity hex used as its
 * fallback when a theme leaves that token undefined (ADR-010). Kept together
 * so the two can never drift apart in coverage.
 */

import { FileStatus } from '../../interfaces/IGitService';

/**
 * IntelliJ-style file status colors
 */
export const INTELLIJ_FILE_STATUS_COLORS: Record<FileStatus, string> = {
  modified: '#6897BB', // Blue for modified files
  added: '#629755', // Green for added files
  deleted: '#6C6C6C', // Gray for deleted files
  renamed: '#6897BB', // Blue for renamed (similar to modified)
  copied: '#629755', // Green for copied (similar to added)
  untracked: '#CC7832', // Orange/brown for untracked files
  ignored: '#848504', // Dark yellow for ignored files
  conflicted: '#FF0000', // Red for conflicted files
};

/**
 * VS Code theme-variable mapping for file statuses. Each
 * status maps to its semantically-correct `gitDecoration-*` token,
 * which themes (especially high-contrast) use to render their own
 * file-status colors. {@link GitToolWindowProvider._getFileStatusColor}
 * wraps this in a `var(...)` expression with
 * {@link INTELLIJ_FILE_STATUS_COLORS} as the fallback.
 *
 * `copied` aliases to `addedResourceForeground` per VS Code's own
 * convention (their built-in git extension applies the same alias).
 *
 * Pinned by `fileStatusTheme-1..8` in detailsPanel.test.ts.
 */
export const FILE_STATUS_THEME_VARS: Record<FileStatus, string> = {
  modified: '--vscode-gitDecoration-modifiedResourceForeground',
  added: '--vscode-gitDecoration-addedResourceForeground',
  deleted: '--vscode-gitDecoration-deletedResourceForeground',
  renamed: '--vscode-gitDecoration-renamedResourceForeground',
  copied: '--vscode-gitDecoration-addedResourceForeground',
  untracked: '--vscode-gitDecoration-untrackedResourceForeground',
  ignored: '--vscode-gitDecoration-ignoredResourceForeground',
  conflicted: '--vscode-gitDecoration-conflictingResourceForeground',
};
