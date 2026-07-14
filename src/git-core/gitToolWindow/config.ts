/**
 * Configuration helpers for the Git Tool Window.
 *
 * The tabbed layout is the default Git tool-window presentation, matching
 * IntelliJ's git4idea tool window (registered as tabbed content). The flag
 * defaults to `true`; users can opt out to restore the single Log panel.
 */

import { readConfig } from '../../config/configKeys';

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
    return Boolean(readConfig('useTabbedGitToolWindow'));
  } catch {
    return true;
  }
}
