/**
 * Make a change to a graph setting show at once. An identical reload is
 * skipped (the log-state fingerprint covers the data, not the settings), so
 * without this a toggled setting waited for the next history change.
 */

import * as vscode from 'vscode';
import type { ConfigKey } from '../../../config/configKeys';

/** Settings the graph reads while drawing: a change repaints what is loaded. */
const DRAWN: readonly ConfigKey[] = ['log.showLongEdges', 'log.showGpgColumn', 'log.showRootNames'];

/** Settings a load reads from git: a change loads again. */
const LOADED: readonly ConfigKey[] = ['log.highlightCherryPicked'];

export function watchGraphSettings(on: { repaint(): void; reload(): void }): vscode.Disposable {
  const affects = (event: vscode.ConfigurationChangeEvent, keys: readonly ConfigKey[]): boolean =>
    keys.some((key) => event.affectsConfiguration(`intellig.${key}`));
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (affects(event, DRAWN)) {
      on.repaint();
    }
    if (affects(event, LOADED)) {
      on.reload();
    }
  });
}
