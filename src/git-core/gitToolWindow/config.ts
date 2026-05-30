/**
 * Configuration helpers for the Git Tool Window.
 *
 * T1-05 Phase 1 ships the tabbed layout behind a feature flag so the refactor
 * can land without regressing the Log-only UI most users see today. The flag
 * defaults to `false` (REVIEW.md §7, locked decision).
 */

import * as vscode from 'vscode';

export const TABBED_CONFIG_KEY = 'useTabbedGitToolWindow';
export const TABBED_CONFIG_FULL_KEY = `intellig.${TABBED_CONFIG_KEY}`;

/**
 * Return true when the user has opted in to the tabbed Git tool window.
 *
 * The VS Code mock in `src/test/mocks/vscode.ts` backs this with its own
 * configuration store so unit tests can toggle the flag via
 * `setMockConfigValue('intellig', 'useTabbedGitToolWindow', true)`.
 */
export function isTabbedGitToolWindowEnabled(): boolean {
  try {
    const config = vscode.workspace.getConfiguration('intellig');
    return Boolean(config.get<boolean>(TABBED_CONFIG_KEY, false));
  } catch {
    return false;
  }
}
