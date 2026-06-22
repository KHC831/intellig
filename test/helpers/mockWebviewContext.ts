/**
 * Shared mock `vscode.ExtensionContext` for webview client-script tests that
 * construct a `BaseWebviewPanel` subclass. Mirrors the minimal context shape
 * the existing dialog unit tests use, in one place so the per-dialog webview
 * tests stay focused on the script under test.
 */

import * as vscode from 'vscode';

/** In-memory `vscode.Memento` so dialogs that read/write persisted prefs work. */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...store.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as vscode.Memento;
}

export function makeExtensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: makeMemento(),
    globalState: makeMemento(),
    extensionPath: '/tmp/ext',
    globalStoragePath: '/tmp/global',
    logPath: '/tmp/log',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3,
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Read the full HTML a `BaseWebviewPanel` subclass rendered into its panel.
 * `_render()` (called in the subclass constructor) assigns `webview.html`.
 */
export function panelHtml(dialog: unknown): string {
  return (dialog as { _panel: { webview: { html: string } } })._panel.webview.html;
}
